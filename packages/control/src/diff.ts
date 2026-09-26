/**
 * In-process unified diff generation (git format) for test-change governance (I8): the diff a `fs.write` would
 * produce is classified BEFORE the write executes. The diff is exact (an LCS over the changed middle region) for
 * regions up to MAX_LCS_CELLS; larger regions are rendered as a full replacement, which can only make the
 * classification stricter, never weaker.
 */

const CONTEXT = 3;
const MAX_LCS_CELLS = 4_000_000;
const NO_NEWLINE = '\\ No newline at end of file';

/** One line; `last` marks a final line without a trailing newline (it differs from the same text with one). */
interface Line {
  text: string;
  noNewline: boolean;
}
type Op = { kind: 'ctx' | 'del' | 'add'; line: Line };

function splitLines(text: string): Line[] {
  if (text === '') return [];
  const endsWithNewline = text.endsWith('\n');
  const parts = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  return parts.map((t, i) => ({ text: t, noNewline: !endsWithNewline && i === parts.length - 1 }));
}

function same(a: Line, b: Line): boolean {
  return a.text === b.text && a.noNewline === b.noNewline;
}

function lcsOps(a: Line[], b: Line[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ kind: 'add', line }));
  if (m === 0) return a.map((line) => ({ kind: 'del', line }));
  if (n * m > MAX_LCS_CELLS) return [...a.map((line): Op => ({ kind: 'del', line })), ...b.map((line): Op => ({ kind: 'add', line }))];
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) row[j] = same(a[i]!, b[j]!) ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i]!, b[j]!)) {
      ops.push({ kind: 'ctx', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'del', line: a[i++]! });
    } else {
      ops.push({ kind: 'add', line: b[j++]! });
    }
  }
  while (i < n) ops.push({ kind: 'del', line: a[i++]! });
  while (j < m) ops.push({ kind: 'add', line: b[j++]! });
  return ops;
}

/**
 * Unified diff of one file (`a/<path>` → `b/<path>`). `oldExists: false` renders a file creation (`--- /dev/null`).
 * Returns '' when nothing changed.
 */
export function unifiedDiff(path: string, oldText: string, newText: string, options: { oldExists?: boolean } = {}): string {
  const created = options.oldExists === false;
  if (oldText === newText && !created) return '';
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // common prefix / suffix keep the LCS small
  let pre = 0;
  while (pre < a.length && pre < b.length && same(a[pre]!, b[pre]!)) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && same(a[a.length - 1 - suf]!, b[b.length - 1 - suf]!)) suf++;
  const ops: Op[] = [
    ...a.slice(0, pre).map((line): Op => ({ kind: 'ctx', line })),
    ...lcsOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map((line): Op => ({ kind: 'ctx', line })),
  ];
  const changed = ops.map((o, idx) => (o.kind !== 'ctx' ? idx : -1)).filter((x) => x >= 0);
  if (changed.length === 0 && !created) return '';
  const header = created
    ? [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`]
    : [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  const out: string[] = [...header];
  let start = 0;
  while (start < changed.length) {
    let end = start;
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! <= 2 * CONTEXT + 1) end++;
    const from = Math.max(0, changed[start]! - CONTEXT);
    const to = Math.min(ops.length - 1, changed[end]! + CONTEXT);
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < from; k++) {
      if (ops[k]!.kind !== 'add') oldLine++;
      if (ops[k]!.kind !== 'del') newLine++;
    }
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = from; k <= to; k++) {
      const o = ops[k]!;
      const mark = o.kind === 'ctx' ? ' ' : o.kind === 'del' ? '-' : '+';
      body.push(`${mark}${o.line.text}`);
      if (o.kind !== 'add') oldCount++;
      if (o.kind !== 'del') newCount++;
      if (o.line.noNewline) body.push(NO_NEWLINE);
    }
    out.push(`@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`);
    out.push(...body);
    start = end + 1;
  }
  return out.join('\n') + '\n';
}

/**
 * Splits a multi-file git diff into its file sections, keyed by the `diff --git a/X b/Y` header line. Each value is
 * the section's exact text (header included), so two diffs of the same worktree state yield equal sections.
 */
export function diffSections(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  let key: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (key !== undefined) out.set(key, (out.get(key) ?? '') + buf.join(''));
  };
  for (const line of diff.split(/(?<=\n)/)) {
    if (line.startsWith('diff --git ')) {
      flush();
      key = line.replace(/\r?\n$/, '');
      buf = [line];
    } else if (key !== undefined) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** Paths named by a `diff --git a/X b/Y` header (both sides, without the a/ b/ prefixes; best effort for quoting). */
export function sectionPaths(header: string): string[] {
  const m = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/.exec(header);
  if (!m) return [];
  return [...new Set([m[1]!, m[2]!])];
}

function swapPrefix(p: string): string {
  if (p.startsWith('a/')) return `b/${p.slice(2)}`;
  if (p.startsWith('b/')) return `a/${p.slice(2)}`;
  if (p.startsWith('"a/')) return `"b/${p.slice(3)}`;
  if (p.startsWith('"b/')) return `"a/${p.slice(3)}`;
  return p;
}

/**
 * The inverse of one git diff file section (new ⇄ old): what undoing that change looks like. Used to classify a
 * command that REMOVED a change the worktree carried (e.g. deleted a test file the run had added).
 */
export function invertSection(section: string): string {
  const out: string[] = [];
  let minus: string | undefined;
  let inHunk = false;
  for (const raw of section.split(/(?<=\n)/)) {
    const nl = raw.endsWith('\n') ? '\n' : '';
    const line = nl ? raw.slice(0, -1) : raw;
    let m: RegExpExecArray | null;
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      const hm = /^diff --git (\S+|"[^"]*") (\S+|"[^"]*")$/.exec(line);
      out.push(hm ? `diff --git ${swapPrefix(hm[2]!)} ${swapPrefix(hm[1]!)}${nl}` : raw);
    } else if ((m = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/.exec(line))) {
      inHunk = true;
      out.push(`@@ -${m[2]} +${m[1]} @@${m[3]}${nl}`);
    } else if (inHunk) {
      if (line.startsWith('+')) out.push(`-${line.slice(1)}${nl}`);
      else if (line.startsWith('-')) out.push(`+${line.slice(1)}${nl}`);
      else out.push(raw);
    } else if (line.startsWith('new file mode ')) out.push(`deleted file mode ${line.slice('new file mode '.length)}${nl}`);
    else if (line.startsWith('deleted file mode ')) out.push(`new file mode ${line.slice('deleted file mode '.length)}${nl}`);
    else if (line.startsWith('old mode ')) out.push(`new mode ${line.slice('old mode '.length)}${nl}`);
    else if (line.startsWith('new mode ')) out.push(`old mode ${line.slice('new mode '.length)}${nl}`);
    else if (line.startsWith('rename from ')) out.push(`rename to ${line.slice('rename from '.length)}${nl}`);
    else if (line.startsWith('rename to ')) out.push(`rename from ${line.slice('rename to '.length)}${nl}`);
    else if ((m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(.*)$/.exec(line))) out.push(`index ${m[2]}..${m[1]}${m[3]}${nl}`);
    else if (line.startsWith('--- ')) minus = line.slice(4);
    else if (line.startsWith('+++ ')) {
      out.push(`--- ${swapPrefix(line.slice(4))}\n`, `+++ ${swapPrefix(minus ?? '/dev/null')}${nl}`);
      minus = undefined;
    } else if ((m = /^Binary files (.+) and (.+) differ$/.exec(line))) out.push(`Binary files ${swapPrefix(m[2]!)} and ${swapPrefix(m[1]!)} differ${nl}`);
    else out.push(raw);
  }
  return out.join('');
}
