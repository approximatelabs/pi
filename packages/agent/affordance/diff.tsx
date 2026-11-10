// The diff pi's interface draws under an edit: the changed lines with their line numbers, a few
// lines of context around each change, and `...` where unchanged lines are left out. The same
// text pi's own edit tool returns as `details.diff`, made here because the edit runs here.

const CONTEXT = 4;
// Past this many changed lines the shortest diff is not searched for: everything between the
// first and last changed line is shown as replaced.
const SEARCH = 1000;

function lines(text) {
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

// The line changes from `a` to `b` as runs: {kind: "=" | "-" | "+", lines}. Within a change the
// removed lines come before the added ones.
function runs(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const out = [];
  const add = (kind, line) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.lines.push(line);
    else out.push({kind, lines: [line]});
  };
  for (let i = 0; i < head; i++) add("=", a[i]);
  // The middle, by the shortest edit script (Myers): removed and added lines, in order.
  const gone = [];
  const come = [];
  const flush = () => {
    for (const line of gone.splice(0)) add("-", line);
    for (const line of come.splice(0)) add("+", line);
  };
  for (const [kind, line] of middle(A, B)) {
    if (kind === "=") { flush(); add("=", line); }
    else if (kind === "-") gone.push(line);
    else come.push(line);
  }
  flush();
  for (let i = a.length - tail; i < a.length; i++) add("=", a[i]);
  return out;
}

function middle(A, B) {
  const N = A.length;
  const M = B.length;
  const whole = () => [...A.map(line => ["-", line]), ...B.map(line => ["+", line])];
  if (!N || !M) return whole();
  const limit = Math.min(N + M, SEARCH);
  const off = limit + 1;
  const v = [];
  for (let i = 0; i < 2 * limit + 3; i++) v.push(0);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
  }
  if (found < 0) return whole();
  const back = [];
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const seen = trace[d];
    const at = k => seen[k + d + 1];
    const k = x - y;
    const from = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(from);
    const py = px - from;
    while (x > px && y > py) { back.push(["=", A[x - 1]]); x--; y--; }
    if (x === px) back.push(["+", B[y - 1]]);
    else back.push(["-", A[x - 1]]);
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) { back.push(["=", A[x - 1]]); x--; y--; }
  return back.reverse();
}

function pad(n, width) {
  let text = String(n);
  while (text.length < width) text = " " + text;
  return text;
}

/** `{diff, firstChangedLine}` for a file's text before and after an edit. */
export function displayDiff(before, after) {
  const parts = runs(lines(before), lines(after));
  const width = String(Math.max(before.split("\n").length, after.split("\n").length)).length;
  const blank = pad("", width);
  const out = [];
  let o = 1;
  let n = 1;
  let first;
  let changed = false;
  const same = line => { out.push(` ${pad(o, width)} ${line}`); o++; n++; };
  const skip = count => { out.push(` ${blank} ...`); o += count; n += count; };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.kind !== "=") {
      if (first === undefined) first = n;
      for (const line of part.lines) {
        if (part.kind === "+") { out.push(`+${pad(n, width)} ${line}`); n++; }
        else { out.push(`-${pad(o, width)} ${line}`); o++; }
      }
      changed = true;
      continue;
    }
    const raw = part.lines;
    const next = i < parts.length - 1 && parts[i + 1].kind !== "=";
    if (changed && next) {
      if (raw.length <= CONTEXT * 2) {
        for (const line of raw) same(line);
      } else {
        for (const line of raw.slice(0, CONTEXT)) same(line);
        skip(raw.length - CONTEXT * 2);
        for (const line of raw.slice(raw.length - CONTEXT)) same(line);
      }
    } else if (changed) {
      for (const line of raw.slice(0, CONTEXT)) same(line);
      if (raw.length > CONTEXT) skip(raw.length - CONTEXT);
    } else if (next) {
      const skipped = Math.max(0, raw.length - CONTEXT);
      if (skipped > 0) skip(skipped);
      for (const line of raw.slice(skipped)) same(line);
    } else {
      o += raw.length;
      n += raw.length;
    }
    changed = false;
  }
  return {diff: out.join("\n"), firstChangedLine: first};
}
