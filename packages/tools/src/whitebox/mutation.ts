import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { HypertestError, throwIfAborted } from '@hypertest/core';
import type { Mutant, MutantStatus, MutationAnalysisResult, MutationLanguage, MutationOperator, SandboxRunner, TestRunResult, TestRunnerAdapter, WorkspaceHandle } from '../contracts.ts';
import { confineExisting } from './paths.ts';

export const MUTATION_OPERATORS: readonly MutationOperator[] = ['arithmetic', 'relational', 'logical', 'boolean', 'numeric_literal', 'return_value', 'off_by_one'];

export function languageOf(file: string): MutationLanguage | undefined {
  if (/\.(m|c)?jsx?$/.test(file)) return 'javascript';
  if (/\.(m|c)?tsx?$/.test(file)) return 'typescript';
  if (/\.py$/.test(file)) return 'python';
  if (/\.go$/.test(file)) return 'go';
  return undefined;
}

const REGEX_PRECEDING_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

/**
 * Returns `source` with comments, string/template/rune literals and (JS) regex literals blanked to spaces
 * (newlines kept), so operator scans over the result never touch non-code text and offsets stay equal.
 */
export function maskSource(source: string, language: MutationLanguage): string {
  const out = source.split('');
  const n = source.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const js = language === 'javascript' || language === 'typescript';
  const py = language === 'python';
  const go = language === 'go';
  let i = 0;
  const lastSignificant = (): { ch: string; word: string } => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(out[k]!)) k--;
    if (k < 0) return { ch: '', word: '' };
    let w = k;
    while (w >= 0 && /[\w$]/.test(out[w]!)) w--;
    return { ch: out[k]!, word: out.slice(w + 1, k + 1).join('') };
  };
  const skipQuoted = (q: string, start: number, allowNewline: boolean): number => {
    let k = start + 1;
    while (k < n) {
      const c = source[k]!;
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === q) return k + 1;
      if (c === '\n' && !allowNewline) return k;
      k++;
    }
    return n;
  };
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if ((js || go) && c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      continue;
    }
    if ((js || go) && c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      blank(i, end < 0 ? n : end + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (py && c === '#') {
      const end = source.indexOf('\n', i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      continue;
    }
    if (py && (c === '"' || c === "'") && source.startsWith(c.repeat(3), i)) {
      const end = source.indexOf(c.repeat(3), i + 3);
      const stop = end < 0 ? n : end + 3;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || (go && c === '`')) {
      const stop = go && c === '`' ? (source.indexOf('`', i + 1) < 0 ? n : source.indexOf('`', i + 1) + 1) : skipQuoted(c, i, false);
      blank(i, stop);
      i = stop;
      continue;
    }
    if (js && c === '`') {
      // template literal; ${…} expressions are blanked too (brace depth, nested quotes skipped)
      let k = i + 1;
      while (k < n) {
        const d = source[k]!;
        if (d === '\\') {
          k += 2;
          continue;
        }
        if (d === '`') {
          k++;
          break;
        }
        if (d === '$' && source[k + 1] === '{') {
          let depth = 1;
          k += 2;
          while (k < n && depth > 0) {
            const e = source[k]!;
            if (e === '"' || e === "'") k = skipQuoted(e, k, false);
            else {
              if (e === '{') depth++;
              else if (e === '}') depth--;
              k++;
            }
          }
          continue;
        }
        k++;
      }
      blank(i, k);
      i = k;
      continue;
    }
    if (js && c === '/') {
      const prev = lastSignificant();
      const regexContext = prev.ch === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev.ch) || REGEX_PRECEDING_KEYWORDS.has(prev.word);
      if (regexContext) {
        let k = i + 1;
        let inClass = false;
        while (k < n && source[k] !== '\n') {
          const d = source[k]!;
          if (d === '\\') {
            k += 2;
            continue;
          }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) {
            k++;
            break;
          }
          k++;
        }
        while (k < n && /[a-z]/i.test(source[k]!)) k++;
        blank(i, k);
        i = k;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

function importLines(source: string, language: MutationLanguage): Set<number> {
  const lines = source.split('\n');
  const skip = new Set<number>();
  let inGoImport = false;
  lines.forEach((l, idx) => {
    const line = idx + 1;
    if (language === 'go') {
      if (/^\s*import\s*\(/.test(l)) inGoImport = true;
      if (inGoImport || /^\s*import\b/.test(l)) skip.add(line);
      if (inGoImport && /\)/.test(l)) inGoImport = false;
    } else if (language === 'python') {
      if (/^\s*(import|from)\s/.test(l)) skip.add(line);
    } else if (/^\s*import\b|^\s*export\s+(\*|\{)[^;]*\bfrom\b|\brequire\s*\(/.test(l)) skip.add(line);
  });
  return skip;
}

interface Candidate {
  operator: MutationOperator;
  start: number;
  end: number;
  replacement: string;
}

function prevSig(s: string, i: number): { ch: string; idx: number } {
  let k = i - 1;
  while (k >= 0 && (s[k] === ' ' || s[k] === '\t')) k--;
  return { ch: k >= 0 ? s[k]! : '', idx: k };
}

function nextSig(s: string, i: number): { ch: string; idx: number } {
  let k = i;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
  return { ch: k < s.length ? s[k]! : '', idx: k };
}

const OPERAND_END = /[\w$)\]]/;
const OPERAND_START = /[\w$(\['"`!~.+-]/;

function numericMutations(text: string): string[] {
  const decimals = text.includes('.') ? text.split('.')[1]!.length : 0;
  const v = Number(text);
  if (!Number.isFinite(v)) return [];
  const fmt = (x: number) => (decimals > 0 ? x.toFixed(decimals) : String(x));
  const out = [fmt(v + 1)];
  if (v >= 1) out.push(fmt(v - 1));
  return out;
}

/**
 * Operator-based source mutants (deterministic, sorted by position then operator). Comments, strings,
 * template and regex literals are never mutated; import/require lines are skipped. Operators:
 * arithmetic (+↔-, *↔/), relational (<↔<=, >↔>=, ==↔!=, ===↔!==), logical (&&↔||, and↔or), boolean
 * literal flip, numeric literal ±1, return value (→ null / None / nil for syntactically simple returns),
 * off-by-one (removal of `+ 1` / `- 1`).
 */
export function generateMutants(file: string, source: string, language: MutationLanguage, options: { operators?: readonly MutationOperator[] } = {}): Mutant[] {
  const ops = new Set(options.operators ?? MUTATION_OPERATORS);
  const m = maskSource(source, language);
  const skipLines = importLines(source, language);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (off: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: off - lineStarts[lo]! + 1 };
  };
  const js = language === 'javascript' || language === 'typescript';
  const cands: Candidate[] = [];
  const add = (operator: MutationOperator, start: number, end: number, replacement: string) => {
    if (!ops.has(operator)) return;
    if (skipLines.has(lineOf(start).line)) return;
    if (source.slice(start, end) === replacement) return;
    cands.push({ operator, start, end, replacement });
  };

  // arithmetic
  for (let i = 0; i < m.length; i++) {
    const c = m[i]!;
    if (c !== '+' && c !== '-' && c !== '*' && c !== '/') continue;
    const before = m[i - 1] ?? '';
    const after = m[i + 1] ?? '';
    if (after === '=' || after === c || before === c) continue;
    if (c === '-' && after === '>') continue;
    if (c === '/' && (before === '*' || after === '*')) continue;
    const p = prevSig(m, i);
    const nx = nextSig(source, i + 1);
    if (!OPERAND_END.test(p.ch) || !OPERAND_START.test(nx.ch)) continue;
    if ((c === '+' || c === '-') && /\d[eE]$/.test(m.slice(Math.max(0, p.idx - 1), p.idx + 1))) continue;
    if (language === 'go' && (c === '*' || c === '/')) {
      const spaceBefore = before === ' ' || before === '\t';
      const spaceAfter = after === ' ' || after === '\t';
      if (spaceBefore !== spaceAfter) continue; // `x *int` is a pointer type
    }
    const rep = c === '+' ? '-' : c === '-' ? '+' : c === '*' ? '/' : '*';
    add('arithmetic', i, i + 1, rep);
  }

  // relational
  for (const mt of m.matchAll(/===|!==|==|!=|<=|>=|<|>/g)) {
    const i = mt.index!;
    const tok = mt[0];
    const before = m[i - 1] ?? '';
    const after = m[i + tok.length] ?? '';
    if ((tok === '===' || tok === '!==') && !js) continue;
    if (tok === '==' || tok === '!=') {
      if (/[=!<>]/.test(before) || after === '=') continue;
      add('relational', i, i + 2, tok === '==' ? '!=' : '==');
      continue;
    }
    if (tok === '===' || tok === '!==') {
      if (/[=!]/.test(before) || after === '=') continue;
      add('relational', i, i + 3, tok === '===' ? '!==' : '===');
      continue;
    }
    if (tok === '<=' || tok === '>=') {
      if (/[<>=!]/.test(before) || after === '=' || after === '>') continue;
      add('relational', i, i + 2, tok[0]!);
      continue;
    }
    // bare < or >: only as spaced binary operators (skips generics, arrows, shifts, channel ops)
    if (!/[ \t]/.test(before) || !/[ \t]/.test(after)) continue;
    add('relational', i, i + 1, `${tok}=`);
  }

  // logical
  if (language === 'python') {
    for (const mt of m.matchAll(/\b(and|or)\b/g)) add('logical', mt.index!, mt.index! + mt[0].length, mt[0] === 'and' ? 'or' : 'and');
  } else {
    for (const mt of m.matchAll(/&&|\|\|/g)) {
      const i = mt.index!;
      if (m[i + 2] === '=' || m[i - 1] === '&' || m[i - 1] === '|' || m[i + 2] === '&' || m[i + 2] === '|') continue;
      add('logical', i, i + 2, mt[0] === '&&' ? '||' : '&&');
    }
  }

  // boolean literals
  const [t, f] = language === 'python' ? ['True', 'False'] : ['true', 'false'];
  for (const mt of m.matchAll(new RegExp(`(?<![\\w$.])(${t}|${f})(?![\\w$])`, 'g'))) {
    add('boolean', mt.index!, mt.index! + mt[0].length, mt[0] === t ? f : t);
  }

  // numeric literals ±1
  for (const mt of m.matchAll(/(?<![\w$.])\d+(?:\.\d+)?(?![\w$.])/g)) {
    for (const rep of numericMutations(mt[0])) add('numeric_literal', mt.index!, mt.index! + mt[0].length, rep);
  }

  // return values
  const nullValue = language === 'python' ? 'None' : language === 'go' ? 'nil' : 'null';
  for (const mt of m.matchAll(/\breturn[ \t]+/g)) {
    const exprStart = mt.index! + mt[0].length;
    let exprEnd = exprStart;
    while (exprEnd < m.length && m[exprEnd] !== '\n' && m[exprEnd] !== ';' && m[exprEnd] !== '}') exprEnd++;
    const expr = source.slice(exprStart, exprEnd).trimEnd();
    if (expr === '') continue;
    const simple =
      language === 'go'
        ? /^[A-Za-z_]\w*$/.test(expr) && !['nil', 'true', 'false', 'iota'].includes(expr)
        : /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$|^\d+(\.\d+)?$|^(true|false|True|False)$|^(["'])[^"'\\\n]*\4$/.test(expr) && !['null', 'undefined', 'None', 'this'].includes(expr);
    if (!simple) continue;
    add('return_value', exprStart, exprStart + expr.length, nullValue);
  }

  // off-by-one: drop `+ 1` / `- 1`
  for (const mt of m.matchAll(/[ \t]*[+-][ \t]*1(?![\w$.])/g)) {
    const i = mt.index!;
    const opIdx = i + mt[0].search(/[+-]/);
    const p = prevSig(m, opIdx);
    if (!OPERAND_END.test(p.ch)) continue;
    if (m[opIdx + 1] === m[opIdx] || m[opIdx + 1] === '=') continue;
    add('off_by_one', i, i + mt[0].length, '');
  }

  const order = new Map(MUTATION_OPERATORS.map((o, k) => [o, k]));
  const seen = new Set<string>();
  const uniqCands = cands
    .sort((a, b) => a.start - b.start || order.get(a.operator)! - order.get(b.operator)! || a.end - b.end || (a.replacement < b.replacement ? -1 : 1))
    .filter((c) => {
      const key = `${c.start}:${c.end}:${c.replacement}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return uniqCands.map((c, k) => {
    const { line, column } = lineOf(c.start);
    return { id: `m${String(k + 1).padStart(3, '0')}-L${line}-${c.operator}`, file, line, column, operator: c.operator, start: c.start, end: c.end, original: source.slice(c.start, c.end), replacement: c.replacement };
  });
}

/** Applies one mutant; throws precondition_failed when the source no longer matches. */
export function applyMutant(source: string, mutant: Mutant): string {
  if (source.slice(mutant.start, mutant.end) !== mutant.original) throw new HypertestError('precondition_failed', `mutant ${mutant.id} does not match the source`);
  return source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
}

/** Deterministic, evenly spread subset of at most `max` mutants (all when fewer). */
export function selectMutants(mutants: readonly Mutant[], max: number): Mutant[] {
  if (mutants.length <= max) return [...mutants];
  const out: Mutant[] = [];
  for (let k = 0; k < max; k++) out.push(mutants[Math.floor((k * mutants.length) / max)]!);
  return out;
}

/** Status of a test run against a mutant: killed = tests failed (not a harness error); survived = passed. */
export function classifyMutantRun(r: TestRunResult): { status: MutantStatus; detail?: string } {
  if (r.passed) return { status: 'survived' };
  if (r.harnessError === undefined && r.totals.failed + r.totals.xpass > 0) return { status: 'killed' };
  return { status: 'error', detail: r.harnessError ?? `no failing test (total ${r.totals.total}, exit ${r.exitCode})` };
}

function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/**
 * Mirrors a `node_modules` directory into the copy without copying packages: a real directory whose entries
 * (one level deeper for `@scope` dirs) are symlinks. An entry that links INTO the workspace (npm/pnpm/yarn
 * workspace packages, e.g. `@scope/lib -> ../../packages/lib`) is re-pointed at the same path in the copy —
 * otherwise tests importing the package by name would exercise the original, unmutated code and every
 * mutant would "survive". Everything else links to the original (external dependencies are shared).
 */
async function mirrorNodeModules(src: string, dst: string, root: string, copyRoot: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const name of (await readdir(src)).sort()) {
    const s = join(src, name);
    const st = await lstat(s).catch(() => undefined);
    if (!st) continue;
    if (name.startsWith('@') && st.isDirectory()) {
      await mirrorNodeModules(s, join(dst, name), root, copyRoot);
      continue;
    }
    let target = s;
    if (st.isSymbolicLink()) {
      const real = await realpath(s).catch(() => undefined);
      if (real !== undefined && within(root, real)) target = join(copyRoot, relative(root, real));
    }
    await symlink(target, join(dst, name)).catch(() => undefined);
  }
}

/**
 * Copies the workspace into a private directory (outside the workspace; `.git` excluded, every
 * `node_modules` directory mirrored by symlinks instead of copied — see mirrorNodeModules). An ABSOLUTE
 * symlink into the workspace is re-pointed at the same path in the copy (copied verbatim it would lead
 * tests — and mutant writes — back into the original).
 */
async function copyWorkspace(ws: WorkspaceHandle, dest: string): Promise<void> {
  const root = await realpath(ws.root);
  const destReal = dest;
  const tempReal = ws.tempDir ? await realpath(ws.tempDir).catch(() => ws.tempDir!) : undefined;
  await cp(root, dest, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: async (src, dst) => {
      if (src === root) return true;
      if (src === destReal || src.startsWith(destReal + sep)) return false;
      if (tempReal && (src === tempReal || src.startsWith(tempReal + sep))) return false;
      const name = basename(src);
      if (name === '.git' && relative(root, src) === '.git') return false;
      if (name === 'node_modules') {
        const st = await lstat(src).catch(() => undefined);
        if (st?.isDirectory()) {
          await mirrorNodeModules(src, dst, root, destReal);
          return false;
        }
        if (st?.isSymbolicLink() && (await stat(src).catch(() => undefined))?.isDirectory()) {
          // a linked node_modules: link the copy to the original link (a relative target would dangle)
          await mkdir(join(dst, '..'), { recursive: true });
          await symlink(src, dst, 'dir').catch(() => undefined);
          return false;
        }
      }
      const link = await lstat(src).catch(() => undefined);
      if (link?.isSymbolicLink() && isAbsolute(await readlink(src).catch(() => ''))) {
        const real = await realpath(src).catch(() => undefined);
        if (real !== undefined && within(root, real)) {
          await mkdir(dirname(dst), { recursive: true });
          await symlink(join(destReal, relative(root, real)), dst).catch(() => undefined);
          return false;
        }
      }
      return true;
    },
  });
}

export interface MutationAnalysisInput {
  ws: WorkspaceHandle;
  file: string;
  runner: TestRunnerAdapter;
  sandbox: SandboxRunner;
  selector?: string;
  maxMutants?: number;
  operators?: readonly MutationOperator[];
  /** Total wall-clock budget for baseline + all mutants. */
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * Mutation analysis: copy the workspace once, run the selected tests on the unmodified copy (baseline must
 * pass — otherwise precondition_failed, since failures would count as fake kills), then for each selected
 * mutant (deterministic order) write it, run the tests and restore the file. killed = the tests fail (not a
 * harness error), survived = they pass, error = anything else (build failure, timeout, no cases). The
 * original workspace is never modified.
 */
export async function runMutationAnalysis(input: MutationAnalysisInput): Promise<MutationAnalysisResult> {
  const abs = await confineExisting(input.ws.root, input.file);
  const language = languageOf(input.file);
  if (!language) throw new HypertestError('invalid_argument', `unsupported source language for mutation: ${input.file}`);
  const source = await readFile(abs, 'utf8');
  const all = generateMutants(input.file, source, language, input.operators ? { operators: input.operators } : {});
  const chosen = selectMutants(all, Math.max(1, input.maxMutants ?? 20));
  const deadline = Date.now() + input.timeoutMs;

  // the copy must live outside the workspace root (fs.cp refuses to copy a directory into itself)
  const realRoot = await realpath(input.ws.root);
  const tempInsideRoot = input.ws.tempDir !== undefined && (input.ws.tempDir === realRoot || input.ws.tempDir.startsWith(realRoot + sep));
  const ownBase = input.ws.tempDir === undefined || tempInsideRoot;
  const base = ownBase ? await mkdtemp(join(tmpdir(), 'ht-mutation-')) : input.ws.tempDir!;
  await mkdir(base, { recursive: true });
  const copyRoot = join(base, `mutation-${randomUUID()}`);
  const relFile = relative(realRoot, abs);
  try {
    await copyWorkspace(input.ws, copyRoot);
    const copyWs: WorkspaceHandle = { ...input.ws, root: copyRoot, readOnly: false, kind: 'scratch' };
    // mutants are written only inside the private copy: a target reached through a link out of it (the shared
    // node_modules mirror, a link to the original) would modify the original workspace
    const copyReal = await realpath(copyRoot);
    const target = await realpath(join(copyRoot, relFile)).catch(() => undefined);
    if (target === undefined || !within(copyReal, target)) {
      throw new HypertestError('precondition_failed', `${input.file} resolves outside the private mutation copy (node_modules or a symlink); mutating it would modify the original`);
    }
    const runTests = async (timeoutMs: number) =>
      (await input.runner.run(copyWs, { ...(input.selector !== undefined ? { selector: input.selector } : {}), timeoutMs, signal: input.signal }, input.sandbox)).result;

    const baseline = await runTests(Math.max(1000, deadline - Date.now()));
    const baselineInfo: MutationAnalysisResult['baseline'] = { passed: baseline.passed, total: baseline.totals.total };
    if (baseline.harnessError !== undefined) baselineInfo.harnessError = baseline.harnessError;
    if (!baseline.passed) {
      throw new HypertestError('precondition_failed', `baseline tests do not pass on the unmutated code (${baseline.totals.passed} passed, ${baseline.totals.failed} failed, ${baseline.totals.total} total${baseline.harnessError ? `; ${baseline.harnessError}` : ''}); mutation results would be meaningless`, { details: { baseline: baselineInfo } });
    }
    const perMutant = Math.max(5000, baseline.durationMs * 3 + 2000);
    const results: MutationAnalysisResult['mutants'] = [];
    for (const mutant of chosen) {
      throwIfAborted(input.signal);
      const row = { id: mutant.id, line: mutant.line, operator: mutant.operator, original: mutant.original, replacement: mutant.replacement };
      const remaining = deadline - Date.now();
      if (remaining < 1000) {
        results.push({ ...row, status: 'error', detail: 'mutation time budget exhausted before this mutant ran' });
        continue;
      }
      await writeFile(target, applyMutant(source, mutant));
      try {
        const r = await runTests(Math.min(perMutant, remaining));
        const c = classifyMutantRun(r);
        results.push(c.detail !== undefined ? { ...row, status: c.status, detail: c.detail.slice(0, 300) } : { ...row, status: c.status });
      } finally {
        await writeFile(target, source);
      }
    }
    const killed = results.filter((r) => r.status === 'killed').length;
    const survived = results.filter((r) => r.status === 'survived').length;
    const errors = results.filter((r) => r.status === 'error').length;
    const out: MutationAnalysisResult = {
      file: input.file,
      framework: input.runner.framework,
      generated: all.length,
      total: results.length,
      killed,
      survived,
      errors,
      score: killed + survived === 0 ? 0 : killed / (killed + survived),
      baseline: baselineInfo,
      mutants: results,
    };
    if (input.selector !== undefined) out.selector = input.selector;
    return out;
  } finally {
    await rm(copyRoot, { recursive: true, force: true });
    if (ownBase) await rm(base, { recursive: true, force: true });
  }
}
