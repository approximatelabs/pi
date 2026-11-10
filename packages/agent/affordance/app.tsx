// pi's agent core, as an Affordance app. pi keeps its interface and its session list; this app is
// the agent: the conversation (its log, journaled), the loop that calls the model and runs tools,
// and what the model sees when the context fills. To change how the agent works, change this file
// and tools.tsx: they are the extension point, as extensions are for pi's own core.
import { ModelContext } from "@affordance/lib/model.tsx";
import { useLog } from "@affordance/lib/log.tsx";
import { useFrontend, ask } from "@affordance/lib/frontend.tsx";
import { Tool } from "@affordance/lib/tool.tsx";
import { builtinTools } from "./tools.tsx";
import { useFolding } from "./folding.tsx";

export default function Main() {
  const log = useLog();
  // What pi sends along with a message: its system prompt, which built-in tools are on, and the
  // tools it runs itself (extensions, MCP), which are offered to the model here and run by pi.
  const [setup, setSetup] = useState({system: "", builtin: [], bridged: []}, "setup");
  const configure = ({ system, builtin, bridged }) => {
    if (system !== undefined) setSetup({system, builtin: builtin || [], bridged: bridged || []});
  };
  useEvent("user", configure);
  useEvent("setup", configure);
  const folding = useFolding(log);
  const turn = useFrontend(log, {before: folding.before});
  const tools = builtinTools(harness.machine.get("home"), {signal: turn.signal});
  // A tool pi runs: the call goes to pi (the machine `ui`) and its result comes back.
  const bridge = tool => async args => {
    const answer = await ask({kind: "tool", name: tool.name, args}, null);
    if (answer === null) throw new Error("pi did not run the tool");
    if (answer.error) throw new Error(answer.text);
    return answer.content === undefined ? answer.text : {result: answer.content};
  };
  return <ModelContext strategy="unrolled" system={setup.system} log={log.records}>
    {setup.builtin.filter(name => tools[name]).map(name => <Tool key={name} fn={tools[name]}/>)}
    {setup.bridged.map(tool =>
      <aff key={tool.name} tool_name={tool.name} description={tool.description || ""}
           args_schema={tool.parameters || {type: "object", properties: {}}} onRun={bridge(tool)}>{""}</aff>)}
  </ModelContext>;
}
