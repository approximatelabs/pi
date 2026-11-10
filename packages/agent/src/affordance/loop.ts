// pi's agent loop, run by Affordance.
//
// The loop that calls the model and runs tools is an Affordance app (../../affordance/app.tsx),
// one `affordance host` process a session. This file is the adapter: it sends pi's prompts to
// that app and turns what the app reports back into the same `AgentEvent`s pi's own loop emits,
// so the agent class, the session layer and the interface above it are unchanged.
//
// The app's journal is the agent's state. pi's transcript is kept in step with it: when pi changes
// the conversation under the agent (a branch, a tree jump, a compaction), the app's conversation is
// replaced with pi's (`reset`); otherwise only what is new is sent.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	getCurrentSystemPrompt,
	type ImageContent,
	type Message,
	type TextContent,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type AgentEventSink, runToolCall } from "../agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, AgentToolResult } from "../types.ts";
import { type Binding, Host, type HostEvent } from "./host.ts";

/** pi's built-in tools the app implements itself (affordance/tools.tsx); any other tool is run by pi. */
const BUILTIN = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);

interface Session {
	host: Host;
	dir: string;
	/** One fingerprint a message the app's conversation holds, in order. */
	mirror: string[];
}

const sessions = new Map<string, Session>();

function stateDir(sessionId: string | undefined): string {
	if (!sessionId) return mkdtempSync(join(tmpdir(), "pi-affordance-"));
	const base = process.env.PI_AFFORDANCE_STATE ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "affordance");
	return join(base, sessionId);
}

/** A content list as chat parts, or as its text when it is only text. */
function parts(content: string | (TextContent | ImageContent)[]): unknown {
	if (typeof content === "string") return content;
	if (content.every((part) => part.type === "text")) return content.map((part) => (part as TextContent).text).join("");
	return content.map((part) =>
		part.type === "image"
			? { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
			: { type: "text", text: part.text },
	);
}

/** pi's messages as the chat messages the app takes; system messages are read apart. */
function chatMessages(messages: Message[]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const message of messages) {
		if (message.role === "user") {
			out.push({ role: "user", content: parts(message.content) });
		} else if (message.role === "assistant") {
			const text = message.content.filter((block) => block.type === "text").map((block) => block.text);
			const thinking = message.content.filter((block) => block.type === "thinking").map((block) => block.thinking);
			const calls = message.content.filter((block) => block.type === "toolCall");
			if (!text.join("") && !calls.length) continue;
			out.push({
				role: "assistant",
				content: text.join(""),
				reasoning: thinking.join("\n\n"),
				tool_calls: calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
			});
		} else if (message.role === "toolResult") {
			out.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				name: message.toolName,
				content: parts(message.content),
				error: message.isError,
			});
		}
	}
	return out;
}

const fingerprint = (message: Record<string, unknown>) =>
	createHash("sha256")
		.update(JSON.stringify([message.role, message.content, message.tool_calls ?? null, message.tool_call_id ?? null]))
		.digest("hex")
		.slice(0, 16);

function binding(config: AgentLoopConfig, key: string | undefined): Binding {
	const model = config.model;
	return {
		url: model.baseUrl,
		model: model.id,
		context: model.contextWindow,
		maxNew: Math.min(model.maxTokens, Math.max(1024, Math.floor(model.contextWindow / 4))),
		key,
	};
}

async function sessionFor(config: AgentLoopConfig): Promise<Session> {
	const key = config.apiKey ?? (await config.getApiKey?.(config.model.provider));
	const wanted = binding(config, key);
	const id = config.sessionId ?? "";
	let session = sessions.get(id);
	// Another model: the same journal continues under the new binding.
	if (session && JSON.stringify(session.host.binding) !== JSON.stringify(wanted)) {
		await session.host.stop();
		session = undefined;
	}
	if (session?.host.exited) session = undefined;
	if (!session) {
		const dir = sessions.get(id)?.dir ?? stateDir(config.sessionId);
		let mirror: string[] = [];
		try {
			if (existsSync(join(dir, "root", "agent.json"))) mirror = JSON.parse(readFileSync(join(dir, "mirror.json"), "utf8"));
		} catch {
			mirror = [];
		}
		const host = new Host(wanted, dir, process.cwd());
		for (let event = await host.next(); event.type !== "ready"; event = await host.next()) {
			if (event.type === "exit") throw new Error(event.error ?? "affordance exited");
		}
		session = { host, dir, mirror };
		sessions.set(id, session);
	}
	return session;
}

function emptyAssistant(config: AgentLoopConfig): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** What pi sends along with a message: its system prompt and tools. */
function setup(llm: Message[], tools: AgentTool<any>[]): Record<string, unknown> {
	return {
		system: getCurrentSystemPrompt(llm),
		builtin: tools.filter((tool) => BUILTIN.has(tool.name)).map((tool) => tool.name),
		bridged: tools
			.filter((tool) => !BUILTIN.has(tool.name))
			.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
	};
}

/**
 * Run the loop: bring the app's conversation in step with `context`, send `prompts` (none: answer
 * what is unanswered), and emit pi's events until the agent is idle.
 */
export async function runAffordanceLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [];
	const tools = context.tools ?? [];
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const message of prompts) {
		newMessages.push(message);
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}

	const session = await sessionFor(config);
	const { host } = session;
	const before = await config.convertToLlm(context.messages);
	const expected = chatMessages(before);
	const marks = expected.map(fingerprint);
	const inStep = marks.length === session.mirror.length && marks.every((mark, i) => mark === session.mirror[i]);
	if (!inStep) {
		host.event("reset", { messages: expected });
		session.mirror = marks;
	}
	const configuration = setup([...before, ...(await config.convertToLlm(prompts))], tools);
	const say = (message: AgentMessage, llm: Message[]) => {
		for (const chat of chatMessages(llm)) {
			if (chat.role !== "user") continue;
			host.event("user", { content: chat.content, ...configuration });
			session.mirror.push(fingerprint(chat));
		}
		void message;
	};
	const sent = await config.convertToLlm(prompts);
	if (sent.some((message) => message.role === "user")) {
		for (const message of prompts) say(message, await config.convertToLlm([message]));
	} else {
		// Nothing new to say: answer what is unanswered (a retry, a continued session).
		host.event("setup", configuration);
		host.event("continue");
	}

	host.hold(true);
	const onAbort = () => host.event("abort");
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	// The assistant message being streamed, and the tools of the turn that are running.
	let assistant: AssistantMessage | undefined;
	let started = false;
	let open: "thinking" | "text" | undefined;
	let usage: Record<string, any> | undefined;
	let lastAssistant: AssistantMessage | undefined;
	const running = new Map<string, { name: string; args: any; started: number; output: string; outcome?: AgentToolResult<any>; isError?: boolean }>();
	const toolResults: ToolResultMessage[] = [];

	const begin = async () => {
		if (!assistant) assistant = emptyAssistant(config);
		if (!started) {
			started = true;
			await emit({ type: "message_start", message: assistant });
		}
		return assistant;
	};
	const closeBlock = async () => {
		if (!assistant || !open) return;
		const index = assistant.content.length - 1;
		const block = assistant.content[index];
		if (block.type === "thinking") {
			await emit({ type: "message_update", message: assistant, assistantMessageEvent: { type: "thinking_end", contentIndex: index, content: block.thinking, partial: assistant } });
		} else if (block.type === "text") {
			await emit({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_end", contentIndex: index, content: block.text, partial: assistant } });
		}
		open = undefined;
	};
	const append = async (text: string, reasoning: boolean) => {
		const message = await begin();
		const kind = reasoning ? "thinking" : "text";
		if (open !== kind) {
			await closeBlock();
			open = kind;
			message.content.push(reasoning ? { type: "thinking", thinking: "" } : { type: "text", text: "" });
			const index = message.content.length - 1;
			await emit({
				type: "message_update",
				message,
				assistantMessageEvent: reasoning
					? { type: "thinking_start", contentIndex: index, partial: message }
					: { type: "text_start", contentIndex: index, partial: message },
			});
		}
		const index = message.content.length - 1;
		const block = message.content[index];
		if (block.type === "thinking") {
			block.thinking += text;
			await emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: index, delta: text, partial: message } });
		} else if (block.type === "text") {
			block.text += text;
			await emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: text, partial: message } });
		}
	};
	const finishAssistant = async (reply: Record<string, any>, failure?: string) => {
		const message = await begin();
		if (!message.content.length) {
			if (reply.reasoning) await append(reply.reasoning, true);
			if (reply.text) await append(reply.text, false);
		}
		await closeBlock();
		for (const call of reply.calls ?? []) {
			message.content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.args ?? {} });
			const index = message.content.length - 1;
			const toolCall = message.content[index];
			if (toolCall.type !== "toolCall") continue;
			await emit({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_start", contentIndex: index, partial: message } });
			await emit({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_end", contentIndex: index, toolCall, partial: message } });
		}
		if (usage) {
			const reported = usage.model_meta?.usage ?? {};
			const cached = reported.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
			const input = reported.prompt_tokens ?? usage.prompt_tokens ?? 0;
			message.usage.cacheRead = cached;
			message.usage.input = Math.max(0, input - cached);
			message.usage.output = reported.completion_tokens ?? usage.tokens ?? 0;
			message.usage.totalTokens = input + message.usage.output;
			usage = undefined;
		}
		if (failure !== undefined) {
			message.stopReason = "error";
			message.errorMessage = failure;
		} else if (reply.aborted) {
			message.stopReason = "aborted";
			message.errorMessage = "Request was aborted";
		} else {
			message.stopReason = (reply.calls ?? []).length ? "toolUse" : reply.cut_off ? "length" : "stop";
		}
		await emit({ type: "message_end", message });
		newMessages.push(message);
		const chat = chatMessages([message]);
		if (chat.length) session.mirror.push(fingerprint(chat[0]));
		lastAssistant = message;
		assistant = undefined;
		started = false;
		return message;
	};
	const endTurn = async () => {
		if (!lastAssistant) return;
		await emit({ type: "turn_end", message: lastAssistant, toolResults: toolResults.splice(0) });
		lastAssistant = undefined;
	};

	try {
		for (;;) {
			const event: HostEvent = await host.next();
			if (event.type === "exit") throw new Error(event.error ?? "affordance exited");
			if (event.type === "delta" && event.text) {
				await append(event.text, event.reasoning === true);
			} else if (event.type === "trace" && event.record?.t === "generate" && event.record.tag !== "fold") {
				usage = event.record;
			} else if (event.type === "output" && event.text) {
				// A command's output as it runs: it belongs to the one command running, if there is one.
				const commands = [...running].filter(([, call]) => call.name === "bash" && !call.outcome);
				if (commands.length === 1) {
					const [id, call] = commands[0];
					call.output += event.text;
					await emit({
						type: "tool_execution_update",
						toolCallId: id,
						toolName: call.name,
						args: call.args,
						partialResult: { content: [{ type: "text", text: call.output }], details: undefined },
					});
				}
			} else if (event.type === "question" && event.ask?.kind === "tool" && typeof event.request === "number") {
				// A tool pi runs (an extension's, MCP): through pi's own steps and hooks, the result back to the app.
				const name = String(event.ask.name);
				const pending = [...running].find(([, call]) => call.name === name && !call.outcome && call.started === 0);
				const id = pending?.[0] ?? `call_${event.request}`;
				if (pending) pending[1].started = performance.now();
				const outcome = await runToolCall(
					{ type: "toolCall", id, name, arguments: event.ask.args ?? {} },
					{
						tools,
						assistantMessage: lastAssistant ?? emptyAssistant(config),
						context,
						signal,
						beforeToolCall: config.beforeToolCall,
						afterToolCall: config.afterToolCall,
						onUpdate: (partialResult) => emit({ type: "tool_execution_update", toolCallId: id, toolName: name, args: event.ask?.args, partialResult }),
					},
				);
				if (pending) {
					pending[1].outcome = outcome.result;
					pending[1].isError = outcome.isError;
				}
				const text = outcome.result.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
				host.answer(event.request, { text, error: outcome.isError, content: outcome.result.content.every((part) => part.type === "text") ? undefined : parts(outcome.result.content) });
			} else if (event.type === "ui" && event.value) {
				const value = event.value;
				if (value.reply) {
					await finishAssistant(value.reply);
					for (const call of value.reply.calls ?? []) {
						running.set(call.id, { name: call.name, args: call.args ?? {}, started: BUILTIN.has(call.name) ? performance.now() : 0, output: "" });
						await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args ?? {} });
					}
					if (!(value.reply.calls ?? []).length) await endTurn();
				}
				if (Array.isArray(value.results)) {
					for (const result of value.results) {
						const call = running.get(result.id);
						running.delete(result.id);
						const outcome: AgentToolResult<any> = call?.outcome ?? {
							content: [{ type: "text", text: String(result.result ?? "") }],
							details: result.details,
						};
						const isError = call?.isError ?? !!result.error;
						await emit({
							type: "tool_execution_end",
							toolCallId: result.id,
							toolName: result.name,
							result: outcome,
							isError,
							durationMs: call?.started ? Math.round(performance.now() - call.started) : undefined,
						});
						const message: ToolResultMessage = {
							role: "toolResult",
							toolCallId: result.id,
							toolName: result.name,
							content: outcome.content,
							details: outcome.details,
							isError,
							timestamp: Date.now(),
						};
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
						newMessages.push(message);
						toolResults.push(message);
						const chat = chatMessages([message]);
						if (chat.length) session.mirror.push(fingerprint(chat[0]));
					}
					await endTurn();
					// What the user typed while the tools ran goes in before the model is asked again.
					for (const message of (await config.getSteeringMessages?.()) ?? []) {
						newMessages.push(message);
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
						say(message, await config.convertToLlm([message]));
					}
					await emit({ type: "turn_start" });
				}
				if (typeof value.error === "string") {
					await finishAssistant({}, value.error);
					await endTurn();
				}
				if (value.state === "idle") {
					await endTurn();
					const followUps = (await config.getFollowUpMessages?.()) ?? [];
					if (!followUps.length || signal?.aborted) break;
					await emit({ type: "turn_start" });
					for (const message of followUps) {
						newMessages.push(message);
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
						say(message, await config.convertToLlm([message]));
					}
				}
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		host.hold(false);
		try {
			writeFileSync(join(session.dir, "mirror.json"), JSON.stringify(session.mirror));
		} catch {
			// The next run re-seeds the conversation from pi's transcript.
		}
	}
	await emit({ type: "agent_end", messages: newMessages });
	return newMessages;
}
