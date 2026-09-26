import { HypertestError } from '@hypertest/core';
import type { CoverageMap } from '../contracts.ts';
import { findAll, parseXml } from './xml.ts';

type Counts = { covered: number; total: number };
type FileCov = CoverageMap['files'][number];

/**
 * Coverage report parsers → CoverageMap. Rules shared by every parser:
 *  - files are sorted by path, paths use `/` separators;
 *  - branch data that the report does not carry stays `'unknown'` — never 0 (a report without branch
 *    measurement must not read as "0% branches" nor as "100% of 0 branches");
 *  - totals.branches is `'unknown'` unless every file has known branch counts.
 */
function finish(format: CoverageMap['format'], files: FileCov[]): CoverageMap {
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines: Counts = { covered: 0, total: 0 };
  let branches: Counts | 'unknown' = files.length === 0 ? 'unknown' : { covered: 0, total: 0 };
  for (const f of files) {
    lines.covered += f.lines.covered;
    lines.total += f.lines.total;
    if (branches !== 'unknown') {
      if (f.branches === undefined || f.branches === 'unknown') branches = 'unknown';
      else {
        branches.covered += f.branches.covered;
        branches.total += f.branches.total;
      }
    }
  }
  return { format, files, totals: { lines, branches } };
}

function normPath(p: string): string {
  return p.replaceAll('\\', '/');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * coverage.py JSON (`coverage json`): per file `summary.covered_lines / num_statements`; branches from
 * `summary.covered_branches / num_branches` when branch measurement was on (`meta.branch_coverage` or the
 * summary carries `num_branches`), else from `executed_branches` / `missing_branches` arrays, else unknown.
 */
export function parseCoverageJson(text: string): CoverageMap {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new HypertestError('invalid_argument', `coverage.py JSON is not valid JSON: ${(e as Error).message}`);
  }
  if (!isRecord(data) || !isRecord(data['files'])) throw new HypertestError('invalid_argument', 'coverage.py JSON must contain a "files" object');
  const meta = isRecord(data['meta']) ? data['meta'] : {};
  const branchMode = meta['branch_coverage'] === true;
  const files: FileCov[] = [];
  for (const [path, value] of Object.entries(data['files'])) {
    if (!isRecord(value)) continue;
    const summary = isRecord(value['summary']) ? value['summary'] : {};
    const executed = Array.isArray(value['executed_lines']) ? value['executed_lines'].length : undefined;
    const missing = Array.isArray(value['missing_lines']) ? value['missing_lines'].length : undefined;
    const coveredLines = num(summary['covered_lines']) ?? executed ?? 0;
    const totalLines = num(summary['num_statements']) ?? (executed !== undefined || missing !== undefined ? (executed ?? 0) + (missing ?? 0) : 0);
    let branches: Counts | 'unknown' = 'unknown';
    const nb = num(summary['num_branches']);
    const cb = num(summary['covered_branches']);
    if (nb !== undefined && cb !== undefined && (branchMode || 'num_branches' in summary)) {
      branches = { covered: cb, total: nb };
    } else if (Array.isArray(value['executed_branches']) || Array.isArray(value['missing_branches'])) {
      const eb = Array.isArray(value['executed_branches']) ? value['executed_branches'].length : 0;
      const mb = Array.isArray(value['missing_branches']) ? value['missing_branches'].length : 0;
      branches = { covered: eb, total: eb + mb };
    }
    files.push({ path: normPath(path), lines: { covered: coveredLines, total: totalLines }, branches });
  }
  return finish('coverage.py', files);
}

/**
 * LCOV: per `SF:` record, LF/LH (else counted from DA lines) and BRF/BRH (else counted from BRDA lines,
 * `-` = not taken); a record with neither BRF nor BRDA has unknown branches.
 */
export function parseLcov(text: string): CoverageMap {
  const files = new Map<string, FileCov>();
  let path: string | undefined;
  let lf: number | undefined;
  let lh: number | undefined;
  let brf: number | undefined;
  let brh: number | undefined;
  let da = new Map<number, number>();
  let brda: Array<{ key: string; taken: number }> = [];
  const reset = () => {
    path = undefined;
    lf = lh = brf = brh = undefined;
    da = new Map();
    brda = [];
  };
  const flush = () => {
    if (path === undefined) return;
    const daTotal = da.size;
    const daHit = [...da.values()].filter((h) => h > 0).length;
    const lines: Counts = { covered: lh ?? daHit, total: lf ?? daTotal };
    let branches: Counts | 'unknown' = 'unknown';
    if (brf !== undefined) branches = { covered: brh ?? 0, total: brf };
    else if (brda.length > 0) branches = { covered: brda.filter((b) => b.taken > 0).length, total: brda.length };
    const prev = files.get(path);
    if (prev) {
      prev.lines.covered += lines.covered;
      prev.lines.total += lines.total;
      prev.branches = prev.branches === 'unknown' || branches === 'unknown' || prev.branches === undefined ? 'unknown' : { covered: prev.branches.covered + branches.covered, total: prev.branches.total + branches.total };
    } else files.set(path, { path, lines, branches });
    reset();
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      flush();
      path = normPath(line.slice(3));
    } else if (path === undefined) {
      continue;
    } else if (line.startsWith('DA:')) {
      const [ln, hits] = line.slice(3).split(',');
      const l = Number(ln);
      const h = Number(hits);
      if (Number.isFinite(l)) da.set(l, Math.max(da.get(l) ?? 0, Number.isFinite(h) ? h : 0));
    } else if (line.startsWith('LF:')) lf = Number(line.slice(3)) || 0;
    else if (line.startsWith('LH:')) lh = Number(line.slice(3)) || 0;
    else if (line.startsWith('BRF:')) brf = Number(line.slice(4)) || 0;
    else if (line.startsWith('BRH:')) brh = Number(line.slice(4)) || 0;
    else if (line.startsWith('BRDA:')) {
      const [ln, block, branch, taken] = line.slice(5).split(',');
      brda.push({ key: `${ln},${block},${branch}`, taken: taken === '-' || taken === undefined ? 0 : Number(taken) || 0 });
    } else if (line === 'end_of_record') flush();
  }
  flush();
  return finish('lcov', [...files.values()]);
}

/**
 * Cobertura XML: per `<class filename>` the `<line number hits>` elements (merged per file, max hits per
 * line); branches from `condition-coverage="50% (1/2)"` on `branch="true"` lines. A report whose lines
 * carry no condition coverage has UNKNOWN branches even when it states `branch-rate="0"` (coverage.py
 * writes that when branch measurement is off).
 */
export function parseCobertura(text: string): CoverageMap {
  const doc = parseXml(text);
  const root = findAll(doc, 'coverage')[0];
  if (!root) throw new HypertestError('invalid_argument', 'Cobertura XML has no <coverage> element');
  const perFile = new Map<string, { lines: Map<number, number>; branches: Map<number, Counts> }>();
  for (const cls of findAll(root, 'class')) {
    const filename = cls.attrs['filename'];
    if (!filename) continue;
    const path = normPath(filename);
    let f = perFile.get(path);
    if (!f) {
      f = { lines: new Map(), branches: new Map() };
      perFile.set(path, f);
    }
    for (const ln of findAll(cls, 'line')) {
      const number = Number(ln.attrs['number']);
      if (!Number.isFinite(number)) continue;
      const hits = Number(ln.attrs['hits'] ?? 0);
      f.lines.set(number, Math.max(f.lines.get(number) ?? 0, Number.isFinite(hits) ? hits : 0));
      const cc = ln.attrs['condition-coverage'];
      if (ln.attrs['branch'] === 'true' && cc) {
        const m = /\((\d+)\s*\/\s*(\d+)\)/.exec(cc);
        if (m) {
          const covered = Number(m[1]);
          const total = Number(m[2]);
          const prev = f.branches.get(number);
          if (!prev || covered > prev.covered) f.branches.set(number, { covered, total });
        }
      }
    }
  }
  const files: FileCov[] = [];
  for (const [path, f] of perFile) {
    const total = f.lines.size;
    const covered = [...f.lines.values()].filter((h) => h > 0).length;
    let branches: Counts | 'unknown' = 'unknown';
    if (f.branches.size > 0) {
      branches = { covered: 0, total: 0 };
      for (const b of f.branches.values()) {
        branches.covered += b.covered;
        branches.total += b.total;
      }
    }
    files.push({ path, lines: { covered, total }, branches });
  }
  // Branch measurement is evidently on when any line carries condition coverage: files without branch
  // points then have a known 0/0. Root-level `branch-rate`/`branches-valid` alone never make branches
  // known (`branch-rate="0"` is also what producers write when branch measurement was off).
  if (files.some((f) => f.branches !== 'unknown')) {
    for (const f of files) if (f.branches === 'unknown') f.branches = { covered: 0, total: 0 };
  }
  return finish('cobertura', files);
}

/**
 * Go coverprofile (`mode: set|count|atomic` + `file:sl.sc,el.ec numStmts count`): statement-weighted —
 * lines.total = Σ numStmts, lines.covered = Σ numStmts of blocks with count > 0. Duplicate blocks (the same
 * block reported by several test binaries with -coverpkg) are merged (max count). Branches: unknown.
 */
export function parseGoCoverProfile(text: string): CoverageMap {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0 || !lines[0]!.startsWith('mode:')) throw new HypertestError('invalid_argument', 'Go cover profile must start with "mode:"');
  const blocks = new Map<string, { file: string; stmts: number; count: number }>();
  for (const line of lines.slice(1)) {
    if (line.startsWith('mode:')) continue; // concatenated profiles
    const m = /^(.+):(\d+)\.(\d+),(\d+)\.(\d+)\s+(\d+)\s+(\d+)$/.exec(line);
    if (!m) continue;
    const file = normPath(m[1]!);
    const key = `${file}:${m[2]}.${m[3]},${m[4]}.${m[5]}`;
    const stmts = Number(m[6]);
    const count = Number(m[7]);
    const prev = blocks.get(key);
    if (prev) prev.count = Math.max(prev.count, count);
    else blocks.set(key, { file, stmts, count });
  }
  const perFile = new Map<string, Counts>();
  for (const b of blocks.values()) {
    const c = perFile.get(b.file) ?? { covered: 0, total: 0 };
    c.total += b.stmts;
    if (b.count > 0) c.covered += b.stmts;
    perFile.set(b.file, c);
  }
  return finish('go', [...perFile.entries()].map(([path, c]) => ({ path, lines: c, branches: 'unknown' as const })));
}

export type CoverageFormat = 'coverage.py' | 'lcov' | 'cobertura' | 'go';

/** Guesses the report format from its content. */
export function detectCoverageFormat(text: string): CoverageFormat | undefined {
  const head = text.slice(0, 4096).trimStart();
  if (head.startsWith('mode:')) return 'go';
  if (head.startsWith('{')) return 'coverage.py';
  if (head.startsWith('<') && /<coverage[\s>]/.test(text.slice(0, 65536))) return 'cobertura';
  if (/^(TN:|SF:)/m.test(head)) return 'lcov';
  return undefined;
}

export function parseCoverage(format: CoverageFormat, text: string): CoverageMap {
  switch (format) {
    case 'coverage.py':
      return parseCoverageJson(text);
    case 'lcov':
      return parseLcov(text);
    case 'cobertura':
      return parseCobertura(text);
    case 'go':
      return parseGoCoverProfile(text);
    default:
      throw new HypertestError('invalid_argument', `unknown coverage format ${String(format)}`);
  }
}
