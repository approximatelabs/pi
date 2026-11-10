// Context folding: when the conversation nears the model's window, the older part is replaced by
// a summary the model writes, and the recent turns stay as they are. It happens by itself at the
// start of a turn once a prompt has come close to the window; pi asks for one with the event
// `fold`. The frontend hears `{folded: {summary, kept}}`.
import { ModelContext } from "@affordance/lib/model.tsx";

// How much of the window a prompt may fill before the next turn folds, and how many recent
// records are kept as they are.
const FULL = 0.8;
const KEEP = 12;

function Summarize({ records }) {
  const system = "Summarize this coding session for the assistant that will continue it. Keep: the user's goals and constraints, decisions made, files read or changed and why, commands that mattered and their outcome, and what remains to do. Be specific and brief.";
  return <ModelContext strategy="unrolled" system={system} callable={false}
                       log={[...records, {kind: "input", content: "Write the summary now."}]}>{null}</ModelContext>;
}

export function useFolding(log) {
  // A fold is due: a prompt came close to the window, or pi asked. A ref: it never renders.
  const [due, setDue] = useRef(false, "folding~due");
  const records = log.records;
  useEvent("fold", () => setDue(true));
  useEvent("layout", ({ prompt_tokens, window }) => {
    if (window && prompt_tokens > FULL * window) setDue(true);
  });
  // Run at the start of a turn (`useFrontend`'s `before`), when no model call is open.
  const before = async () => {
    if (!due()) return;
    setDue(false);
    // Cut where a turn starts, so no tool result is left without its call.
    let cut = records.length - KEEP;
    while (cut > 0 && records[cut].kind !== "input" && records[cut].kind !== "model") cut--;
    if (cut <= 1) return;
    const out = await model(<Summarize records={records.slice(0, cut)}/>, {max_new: 2000, tag: "fold"});
    if (out.aborted || !out.text) return;
    const summary = {kind: "input", content: "[Summary of the conversation so far]\n" + out.text};
    log.reset([summary, ...records.slice(cut).map(({ id, ...record }) => record)]);
    try { await harness.machine.get("ui").call({folded: {summary: out.text, kept: records.length - cut}}); } catch (e) {}
  };
  return {before};
}
