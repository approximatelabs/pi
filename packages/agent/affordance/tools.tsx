// pi's built-in tools, as Affordance tools: the same names and arguments pi's interface draws, run
// through the machine's shell (so they work the same on this machine, over SSH or in a container).
// A failure throws, which the model reads as the tool's error.
import { fileTools } from "@affordance/tools/files.tsx";
import { displayDiff } from "./diff.tsx";

// One shell word.
function quote(text) {
  return "'" + String(text).split("'").join("'\\''") + "'";
}

export function builtinTools(machine, options) {
  const signal = options && options.signal;
  const shell = async (cmd, timeout_s) => await machine.call(
    timeout_s === undefined ? {cmd} : {cmd, timeout_s}, {signal: signal ? signal() : undefined});
  const files = fileTools(machine, options);

  /** Execute a bash command in the working directory. Returns stdout and stderr together. Optionally give a timeout in seconds. */
  async function bash({command, timeout}: {command: string; timeout?: number}) {
    const limit = timeout && timeout > 0 ? timeout : 120;
    const got = await shell(command, limit);
    const output = String(got.output);
    if (got.timed_out) throw new Error((output ? output + "\n\n" : "") + `Command timed out after ${limit} seconds`);
    if (got.exit) throw new Error((output ? output + "\n\n" : "") + `Command exited with code ${got.exit}`);
    return output || "(no output)";
  }

  /** Read the contents of a text file. For a large file, read a range of lines with offset (first line, from 1) and limit. */
  async function read({path, offset, limit}: {path: string; offset?: number; limit?: number}) {
    return await files.read({path, offset, limit});
  }

  /** Write content to a file, creating it and its parent directories, or replacing it if it exists. */
  async function write({path, content}: {path: string; content: string}) {
    await files.write({path, content});
    return `Successfully wrote ${content.length} characters to ${path}`;
  }

  /** Edit a file by exact text replacement. Each edits[].oldText must match exactly once in the file; all edits are applied together, or none. */
  async function edit({path, edits}: {path: string; edits: {oldText: string; newText: string}[]}) {
    if (!edits || !edits.length) throw new Error("edits is empty");
    const before = await files.read({path});
    let text = before;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      if (!e.oldText) throw new Error(`edits[${i}].oldText is empty`);
      const count = text.split(e.oldText).length - 1;
      if (count === 0) throw new Error(`edits[${i}].oldText was not found in ${path}`);
      if (count > 1) throw new Error(`edits[${i}].oldText matches ${count} places in ${path}: include more of the surrounding text`);
      text = text.split(e.oldText).join(e.newText);
    }
    await files.write({path, content: text});
    // The model reads the confirmation; pi's interface draws the diff beside it.
    return {result: `Successfully replaced ${edits.length} block(s) in ${path}.`, ...displayDiff(before, text)};
  }

  /** Search file contents for a pattern (a regular expression, or literal text with literal). Returns matching lines with file and line number. */
  async function grep({pattern, path, glob, ignoreCase, literal, context, limit}:
      {pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number}) {
    const flags = ["-rn", "-I", "--exclude-dir=.git", "--exclude-dir=node_modules"];
    if (ignoreCase) flags.push("-i");
    flags.push(literal ? "-F" : "-E");
    if (context) flags.push(`-C${Math.floor(context)}`);
    if (glob) flags.push("--include=" + quote(glob));
    const max = limit && limit > 0 ? Math.floor(limit) : 100;
    const got = await shell(`grep ${flags.join(" ")} -e ${quote(pattern)} -- ${quote(path || ".")} | head -n ${max}`);
    if (got.exit > 1) throw new Error(String(got.output).trim() || `grep failed (exit ${got.exit})`);
    return String(got.output) || "No matches found";
  }

  /** Find files by name pattern (a glob such as *.ts). Returns matching paths. */
  async function find({pattern, path, limit}: {pattern: string; path?: string; limit?: number}) {
    const max = limit && limit > 0 ? Math.floor(limit) : 1000;
    const got = await shell(`find ${quote(path || ".")} -name .git -prune -o -name node_modules -prune -o -name ${quote(pattern)} -print | head -n ${max}`);
    if (got.exit) throw new Error(String(got.output).trim() || `find failed (exit ${got.exit})`);
    return String(got.output) || "No files found matching pattern";
  }

  /** List the entries of a directory, directories marked with a trailing slash. */
  async function ls({path, limit}: {path?: string; limit?: number}) {
    const max = limit && limit > 0 ? Math.floor(limit) : 500;
    const got = await shell(`ls -1Ap -- ${quote(path || ".")} | head -n ${max}`);
    if (got.exit) throw new Error(String(got.output).trim() || `ls failed (exit ${got.exit})`);
    return String(got.output) || "(empty directory)";
  }

  return {bash, read, write, edit, grep, find, ls};
}
