import type { PatternKind } from './contracts.ts';

/**
 * Pattern semantics (I2 relies on these being exact and conservative):
 *
 * - Tool patterns: `*` matches every tool; a pattern ending in `*` is a prefix glob (`git.*` matches
 *   `git.diff`, `oracle.approve*` matches `oracle.approve_change`); anything else is an exact id.
 * - Resource patterns: segments separated by `/`; `*` matches exactly one segment, `**` matches zero or
 *   more segments, any other segment matches literally.
 */

/** Infers the pattern kind when not given: resource when either side contains `/` or the pattern has `**`. */
function inferKind(pattern: string, value: string): PatternKind {
  return pattern.includes('/') || value.includes('/') || pattern.includes('**') ? 'resource' : 'tool';
}

export function matchesToolPattern(pattern: string, tool: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

function segments(s: string): string[] {
  return s === '' ? [] : s.split('/');
}

export function matchesResourcePattern(pattern: string, resource: string): boolean {
  const p = segments(pattern);
  const v = segments(resource);
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (v.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let r: boolean;
    if (i === p.length) r = j === v.length;
    else if (p[i] === '**') r = go(i + 1, j) || (j < v.length && go(i, j + 1));
    else if (j === v.length) r = false;
    else if (p[i] === '*') r = go(i + 1, j + 1);
    else r = p[i] === v[j] && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/** Matches a tool id or a resource key against a pattern (kind inferred when omitted). */
export function matchesPattern(pattern: string, value: string, kind?: PatternKind): boolean {
  return (kind ?? inferKind(pattern, value)) === 'tool' ? matchesToolPattern(pattern, value) : matchesResourcePattern(pattern, value);
}

/**
 * True when every tool matched by `inner` is matched by `outer` (conservative: may answer false for
 * exotic equivalences, never true when it is not so).
 */
export function toolPatternCovers(outer: string, inner: string): boolean {
  if (outer === '*') return true;
  if (outer === inner) return true;
  if (outer.endsWith('*')) {
    const prefix = outer.slice(0, -1);
    // inner exact or inner prefix glob: all its values start with inner's literal part.
    const innerLiteral = inner.endsWith('*') ? inner.slice(0, -1) : inner;
    return innerLiteral.startsWith(prefix);
  }
  return false;
}

/**
 * True when every resource matched by `inner` is matched by `outer`. Sound for literal / `*` / `**`
 * segments: `**` in outer may absorb anything (including `*`/`**` of inner), `*` in outer absorbs exactly
 * one literal or `*` segment, literals must be equal.
 */
export function resourcePatternCovers(outer: string, inner: string): boolean {
  const q = segments(outer);
  const p = segments(inner);
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (p.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let r: boolean;
    if (i === q.length) r = j === p.length;
    else if (q[i] === '**') r = go(i + 1, j) || (j < p.length && go(i, j + 1));
    else if (j === p.length) r = false;
    else if (q[i] === '*') r = p[j] !== '**' && go(i + 1, j + 1);
    else r = p[j] === q[i] && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

export function patternCovers(outer: string, inner: string, kind: PatternKind): boolean {
  return kind === 'tool' ? toolPatternCovers(outer, inner) : resourcePatternCovers(outer, inner);
}

/**
 * Conservative intersection of two pattern sets: patterns of `b` covered by some pattern of `a`, plus
 * patterns of `a` covered by some pattern of `b`. Every result pattern is covered by both sets, so the
 * result never matches a value that either set rejects. Sorted and de-duplicated (deterministic).
 */
export function intersectPatterns(a: readonly string[], b: readonly string[], kind: PatternKind): string[] {
  const out = new Set<string>();
  for (const x of b) if (a.some((y) => patternCovers(y, x, kind))) out.add(x);
  for (const x of a) if (b.some((y) => patternCovers(y, x, kind))) out.add(x);
  return [...out].sort();
}

/** File-path glob (for test path patterns): `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/';
      const slashAfter = glob[i + 2] === '/';
      if (atStart && slashAfter) {
        re += '(?:.*/)?';
        i += 3;
      } else if (atStart && i + 2 === glob.length) {
        re += '.*';
        i += 2;
      } else {
        re += '.*';
        i += 2;
      }
      continue;
    }
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map<string, RegExp>();
export function matchesGlob(glob: string, path: string): boolean {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(path);
}
