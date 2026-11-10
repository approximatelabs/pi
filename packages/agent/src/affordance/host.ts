// One running `affordance host`: the agent core of one session. Commands go to its stdin and
// events come from its stdout, one JSON object a line. The app it runs is ../../affordance/app.tsx;
// its journal, in the session's directory, is the agent's state: stopping the process and starting
// it again with the same directory continues the session.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The agent app: beside `src/` in a checkout, beside `dist/` in a build. */
function deployment(): string {
	const override = process.env.PI_AFFORDANCE_APP;
	if (override) return override;
	for (const dir of [join(here, "../../affordance"), join(here, "../affordance")]) {
		if (existsSync(join(dir, "affordance.yaml"))) return dir;
	}
	throw new Error("pi-affordance: the agent app (affordance/affordance.yaml) is missing from this installation");
}

export interface HostEvent {
	type: string;
	agent?: string;
	task?: number;
	text?: string;
	reasoning?: boolean;
	request?: number;
	ask?: Record<string, any>;
	value?: Record<string, any> | null;
	record?: Record<string, any>;
	message?: string;
	error?: string;
}

export interface Binding {
	/** The model server's address. */
	url: string;
	/** The model's name on the server. */
	model: string;
	/** Its context length, in tokens. */
	context: number;
	/** The most tokens a reply may have. */
	maxNew: number;
	/** The key, if the server takes one: passed in the child's environment, never on its command line. */
	key?: string;
}

export class Host {
	private readonly child: ChildProcess;
	private readonly queue: HostEvent[] = [];
	private waiting?: (event: HostEvent) => void;
	private stderr = "";
	exited?: string;
	readonly binding: Binding;

	/** `dir`: the session's journal directory; `cwd`: where the agent's commands run. */
	constructor(binding: Binding, dir: string, cwd: string) {
		this.binding = binding;
		const bin = process.env.PI_AFFORDANCE_BIN ?? "affordance";
		mkdirSync(dir, { recursive: true });
		const args = ["host", deployment(), "--dir", dir];
		if (existsSync(join(dir, "root", "agent.json"))) args.push("--resume");
		args.push(
			"--set",
			`model.url=${binding.url}`,
			"--set",
			`model.model=${binding.model}`,
			"--set",
			`model.context=${binding.context}`,
			"--set",
			`root.max_new=${binding.maxNew}`,
		);
		const env = { ...process.env };
		if (binding.key) {
			env.PI_AFFORDANCE_MODEL_KEY = binding.key;
			args.push("--set", "model.key_env=PI_AFFORDANCE_MODEL_KEY");
		}
		this.child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.child.on("error", (error) =>
			this.end(
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? `the affordance command was not found (${bin}): install it, or set PI_AFFORDANCE_BIN`
					: `affordance: ${error.message}`,
			),
		);
		this.child.on("close", (code) => {
			const tail = this.stderr.trim().split("\n").slice(-3).join(" | ");
			this.end(`affordance exited (${code})${tail ? `: ${tail}` : ""}`);
		});
		this.child.stdin?.on("error", () => {});
		this.child.stderr?.setEncoding("utf8");
		this.child.stderr?.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-8000);
		});
		this.child.stdout?.setEncoding("utf8");
		let buffered = "";
		this.child.stdout?.on("data", (chunk: string) => {
			buffered += chunk;
			for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
				const line = buffered.slice(0, nl);
				buffered = buffered.slice(nl + 1);
				if (!line.trim()) continue;
				try {
					this.push(JSON.parse(line) as HostEvent);
				} catch {
					// Not a protocol line: ignored.
				}
			}
		});
		process.once("exit", () => this.close());
	}

	private push(event: HostEvent): void {
		const waiting = this.waiting;
		if (waiting) {
			this.waiting = undefined;
			waiting(event);
		} else {
			this.queue.push(event);
		}
	}

	private end(message: string): void {
		if (this.exited) return;
		this.exited = message;
		this.push({ type: "exit", error: message });
	}

	/**
	 * Whether the child keeps pi alive. It does while a run is waiting on it; between runs it does
	 * not, so pi can exit (the child's stdin then closes and it shuts down).
	 */
	hold(held: boolean): void {
		const streams = [this.child.stdin, this.child.stdout, this.child.stderr] as unknown as Array<{ ref?: () => void; unref?: () => void } | null>;
		if (held) {
			this.child.ref();
			for (const stream of streams) stream?.ref?.();
		} else {
			this.child.unref();
			for (const stream of streams) stream?.unref?.();
		}
	}

	/** The next event. After the process has ended, every call answers `exit`. */
	next(): Promise<HostEvent> {
		const event = this.queue.shift();
		if (event) return Promise.resolve(event);
		if (this.exited) return Promise.resolve({ type: "exit", error: this.exited });
		return new Promise((resolve) => {
			this.waiting = resolve;
		});
	}

	send(command: unknown): void {
		if (!this.exited) this.child.stdin?.write(`${JSON.stringify(command)}\n`);
	}

	/** An event to the agent app (`useEvent(name)` there). */
	event(name: string, payload: unknown = {}): void {
		this.send({ type: "event", name, payload });
	}

	/** Answer a question the app asked on its `ui` machine. */
	answer(request: number, value: unknown): void {
		this.send({ type: "answer", request, value });
	}

	/** Stop the process; the journal keeps the session. */
	close(): void {
		if (this.exited) return;
		this.send({ type: "shutdown" });
		this.child.stdin?.end();
	}

	/** Stop and wait for the process to end (before starting another on the same directory). */
	async stop(): Promise<void> {
		this.close();
		while (!this.exited) await this.next();
	}
}
