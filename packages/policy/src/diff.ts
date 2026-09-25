/**
 * Minimal unified-diff parser (git format and plain `---`/`+++` diffs). Hunk bodies are consumed by line
 * count so content lines that look like headers (`--- x` inside a hunk) are never misparsed.
 */

export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the old file (del/ctx). */
  oldLine?: number;
  /** Line number in the new file (add/ctx). */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  /** Function context git prints after the second `@@` (may be empty). */
  context: string;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
  /**
   * Structural problems (truncated hunks, `+`/`-` content outside any hunk). A lenient patch applier could
   * apply lines the parser never saw, so consumers must treat a file with issues as unclassifiable.
   */
  issues?: string[];
}

function unquote(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  }
  return p;
}

function stripPrefix(p: string): string {
  const u = unquote(p);
  if (u.startsWith('a/') || u.startsWith('b/')) return u.slice(2);
  return u;
}

/** Path from a `--- ` / `+++ ` line: `/dev/null` ⇒ null; strips `a/`/`b/` and trailing timestamps. */
function headerPath(raw: string): string | null {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trimEnd();
  if (p === '/dev/null') return null;
  return stripPrefix(p);
}

function parseGitHeader(rest: string): { oldPath: string; newPath: string } | undefined {
  if (rest.startsWith('"')) {
    const m = /^("(?:\\.|[^"\\])*")\s+("(?:\\.|[^"\\])*"|\S.*)$/.exec(rest);
    if (m) return { oldPath: stripPrefix(m[1]!), newPath: stripPrefix(m[2]!) };
  }
  // Prefer the split where both sides are equal (no rename); else the last " b/".
  const candidates: number[] = [];
  let idx = rest.indexOf(' b/');
  while (idx >= 0) {
    candidates.push(idx);
    idx = rest.indexOf(' b/', idx + 1);
  }
  for (const c of candidates) {
    const a = rest.slice(0, c);
    const b = rest.slice(c + 1);
    if (stripPrefix(a) === stripPrefix(b)) return { oldPath: stripPrefix(a), newPath: stripPrefix(b) };
  }
  const last = candidates[candidates.length - 1];
  if (last === undefined) return undefined;
  return { oldPath: stripPrefix(rest.slice(0, last)), newPath: stripPrefix(rest.slice(last + 1)) };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const files: DiffFile[] = [];
  let file: (DiffFile & { explicitStatus?: boolean }) | undefined;
  let i = 0;

  const startFile = (oldPath: string | null, newPath: string | null): DiffFile & { explicitStatus?: boolean } => {
    const f: DiffFile & { explicitStatus?: boolean } = { oldPath, newPath, status: 'modified', binary: false, hunks: [] };
    files.push(f);
    return f;
  };
  const issue = (f: DiffFile, message: string) => {
    (f.issues ??= []).push(message);
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const h = parseGitHeader(line.slice('diff --git '.length));
      file = startFile(h?.oldPath ?? null, h?.newPath ?? null);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const oldPath = headerPath(line.slice(4));
      const newPath = headerPath(lines[i + 1]!.slice(4));
      // A plain unified diff (no git header) or a second file in one: start a file unless the current
      // git section has not seen its ---/+++ yet.
      if (!file || file.hunks.length > 0 || (file as { seenHeaders?: boolean }).seenHeaders) file = startFile(oldPath, newPath);
      else {
        file.oldPath = oldPath;
        file.newPath = newPath;
      }
      (file as { seenHeaders?: boolean }).seenHeaders = true;
      i += 2;
      continue;
    }
    if (!file) {
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      file.status = 'added';
      file.explicitStatus = true;
      file.oldPath = null;
    } else if (line.startsWith('deleted file mode')) {
      file.status = 'deleted';
      file.explicitStatus = true;
      file.newPath = null;
    } else if (line.startsWith('rename from ')) {
      file.oldPath = unquote(line.slice('rename from '.length));
      file.status = 'renamed';
      file.explicitStatus = true;
    } else if (line.startsWith('rename to ')) {
      file.newPath = unquote(line.slice('rename to '.length));
      file.status = 'renamed';
      file.explicitStatus = true;
    } else if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      // treated like an added file at the new path
      if (line.startsWith('copy to ')) file.newPath = unquote(line.slice('copy to '.length));
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.binary = true;
    } else {
      const m = HUNK_RE.exec(line);
      if (m) {
        const oldStart = Number(m[1]);
        let oldCount = m[2] === undefined ? 1 : Number(m[2]);
        const newStart = Number(m[3]);
        let newCount = m[4] === undefined ? 1 : Number(m[4]);
        const hunk: DiffHunk = { oldStart, newStart, context: m[5] ?? '', lines: [] };
        file.hunks.push(hunk);
        let o = oldStart;
        let n = newStart;
        i++;
        while (i < lines.length && (oldCount > 0 || newCount > 0)) {
          const l = lines[i]!;
          const c = l[0];
          if (c === '\\') {
            i++;
            continue;
          }
          if (c === ' ' || l === '') {
            if (l === '' && i === lines.length - 1) break;
            hunk.lines.push({ kind: 'ctx', text: l.slice(1), oldLine: o++, newLine: n++ });
            oldCount--;
            newCount--;
          } else if (c === '-') {
            hunk.lines.push({ kind: 'del', text: l.slice(1), oldLine: o++ });
            oldCount--;
          } else if (c === '+') {
            hunk.lines.push({ kind: 'add', text: l.slice(1), newLine: n++ });
            newCount--;
          } else {
            break;
          }
          i++;
        }
        if (oldCount > 0 || newCount > 0) issue(file, `hunk @@ -${oldStart} +${newStart} @@ is truncated (${oldCount} old / ${newCount} new lines missing)`);
        while (lines[i]?.startsWith('\\')) i++;
        continue;
      }
      if (file.hunks.length > 0 && (line.startsWith('+') || line.startsWith('-'))) {
        issue(file, `content line outside any hunk: ${line.length > 80 ? `${line.slice(0, 80)}…` : line}`);
      }
    }
    i++;
  }

  for (const f of files as Array<DiffFile & { explicitStatus?: boolean; seenHeaders?: boolean }>) {
    if (!f.explicitStatus) {
      if (f.oldPath === null && f.newPath !== null) f.status = 'added';
      else if (f.newPath === null && f.oldPath !== null) f.status = 'deleted';
      else if (f.oldPath !== null && f.newPath !== null && f.oldPath !== f.newPath) f.status = 'renamed';
    }
    delete f.explicitStatus;
    delete f.seenHeaders;
  }
  return files.filter((f) => f.oldPath !== null || f.newPath !== null);
}
