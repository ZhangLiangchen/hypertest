import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { JsonValue } from '@hypertest/core';
import type { BuiltinToolOptions, ProcessResult, ToolContext, ToolSpec } from '../../contracts.ts';
import { goEnv } from '../runners/go.ts';
import { rootResource } from './common.ts';
import { openTsProject, projectDiagnostics } from './lsp.ts';

/**
 * (wave 3, row 248) `analysis.run` — runs the static analyzers that apply to the workspace and records their findings as
 * one `static-analysis` evidence record (structured findings: analyzer, file, line, column, severity, rule, message):
 *  - `tsc`: the TypeScript type check of the workspace project (tsconfig.json; `tsc --noEmit` semantics) — run in-process
 *    through the TypeScript compiler API (it only reads files; confined to the workspace like lsp.*);
 *  - `eslint`: the workspace's own eslint (`node_modules/.bin/eslint -f json .`) when it is installed and configured — run
 *    in the sandbox (eslint executes its configuration);
 *  - `pyflakes`: `python3 -m pyflakes .` when pyflakes is importable, else `compileall`: every Python file compiled (a
 *    syntax check that writes no bytecode) — in the sandbox;
 *  - `go_vet`: `go vet ./...` for a Go module (offline: no toolchain download, no module proxy) — in the sandbox.
 * An analyzer that does not apply is `skipped` and one that cannot run is `unavailable`, each with its reason (never
 * silently dropped). Findings are the analyzers' answer: the call succeeds with them.
 */

export type AnalyzerName = 'tsc' | 'eslint' | 'pyflakes' | 'compileall' | 'go_vet';
export const ANALYZERS: readonly AnalyzerName[] = Object.freeze(['tsc', 'eslint', 'pyflakes', 'compileall', 'go_vet']);

export interface StaticFinding {
  analyzer: AnalyzerName;
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
}

export interface AnalyzerRun {
  analyzer: AnalyzerName;
  status: 'ran' | 'skipped' | 'unavailable' | 'failed';
  command?: string;
  exitCode?: number | null;
  findings: number;
  reason?: string;
}

const PY_SKIP = "{'.git','node_modules','.venv','venv','__pycache__','dist','build'}";
/** Compiles every Python file (no bytecode written); prints one JSON line per syntax error. */
const COMPILE_SCRIPT = `
import json, os, sys
for d, dirs, files in os.walk('.'):
    dirs[:] = sorted(x for x in dirs if x not in ${PY_SKIP})
    for f in sorted(files):
        if not f.endswith('.py'): continue
        p = os.path.join(d, f)[2:]
        try:
            src = open(p, 'rb').read()
            compile(src, p, 'exec', dont_inherit=True)
        except SyntaxError as e:
            print(json.dumps({'path': p, 'line': e.lineno or 1, 'column': e.offset or 1, 'message': type(e).__name__ + ': ' + str(e.msg)}))
        except Exception as e:
            print(json.dumps({'path': p, 'line': 1, 'column': 1, 'message': type(e).__name__ + ': ' + str(e)}))
`;

function hasFiles(root: string, re: RegExp, depth = 4): boolean {
  const walk = (dir: string, d: number): boolean => {
    if (d < 0) return false;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    for (const n of names) {
      if (n === 'node_modules' || n.startsWith('.') || n === 'venv' || n === '__pycache__') continue;
      const p = join(dir, n);
      if (re.test(n)) return true;
      try {
        if (statSync(p).isDirectory() && walk(p, d - 1)) return true;
      } catch {
        // unreadable entry
      }
    }
    return false;
  };
  return walk(root, depth);
}

/** `file:line:col: message` lines (pyflakes, go vet). */
function parseColonLines(text: string, analyzer: AnalyzerName, root: string): StaticFinding[] {
  const out: StaticFinding[] = [];
  for (const line of text.split('\n')) {
    const m = /^(?:\.\/)?([^:\s][^:]*):(\d+)(?::(\d+))?:\s*(.+)$/.exec(line.trim());
    if (!m || line.startsWith('#')) continue;
    const path = m[1]!.startsWith(root) ? relative(root, m[1]!).split(sep).join('/') : m[1]!;
    out.push({ analyzer, path, line: Number(m[2]), column: Number(m[3] ?? 1), severity: analyzer === 'go_vet' ? 'error' : /undefined name|syntax/i.test(m[4]!) ? 'error' : 'warning', rule: analyzer, message: m[4]! });
  }
  return out;
}

function parseEslint(stdout: string, root: string): StaticFinding[] {
  let report: Array<{ filePath: string; messages: Array<{ ruleId: string | null; severity: number; message: string; line?: number; column?: number }> }>;
  try {
    report = JSON.parse(stdout) as typeof report;
  } catch {
    return [];
  }
  return report.flatMap((f) => f.messages.map((m) => ({
    analyzer: 'eslint' as const, path: relative(root, f.filePath).split(sep).join('/'), line: m.line ?? 1, column: m.column ?? 1, severity: m.severity >= 2 ? ('error' as const) : ('warning' as const), rule: m.ruleId ?? 'eslint', message: m.message,
  })));
}

async function inSandbox(options: BuiltinToolOptions, ctx: ToolContext, argv: string[], env: Record<string, string>, timeoutMs: number): Promise<ProcessResult> {
  return options.sandbox.run(ctx.workspace, argv, { timeoutMs, signal: ctx.signal, env, maxOutputBytes: 16 * 1024 * 1024 });
}

export function analysisRunTool(options: BuiltinToolOptions): ToolSpec<{ analyzers?: AnalyzerName[]; timeoutMs?: number; limit?: number }> {
  return {
    id: 'analysis.run',
    title: 'Static analysis',
    description:
      'Run the static analyzers that apply to the workspace — tsc (type check of tsconfig.json), eslint (the workspace\'s own, when installed and configured), pyflakes (else a Python compile check), go vet — and record their findings (file, line, severity, rule, message) as static-analysis evidence. ' +
      'Pick analyzers or let it detect them; analyzers that do not apply or cannot run are reported with the reason.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        analyzers: { type: 'array', items: { enum: [...ANALYZERS] }, minItems: 1, uniqueItems: true },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
      },
    },
    effect: 'execute',
    riskClass: 'medium',
    evidenceTypes: ['static-analysis'],
    timeoutMs: 1_800_000,
    resources: (_input, ctx) => [rootResource(ctx)],
    async execute(input, ctx) {
      const root = realpathSync(ctx.workspace.root);
      const timeoutMs = Math.min(input.timeoutMs ?? 600_000, ctx.permit.constraints?.maxDurationMs ?? Number.MAX_SAFE_INTEGER);
      const want = new Set<AnalyzerName>(input.analyzers ?? ANALYZERS);
      const runs: AnalyzerRun[] = [];
      const findings: StaticFinding[] = [];
      const hasTs = existsSync(join(root, 'tsconfig.json')) || hasFiles(root, /\.(?:[cm]?ts|tsx)$/);
      const hasPy = hasFiles(root, /\.py$/);

      if (want.has('tsc')) {
        if (!hasTs) runs.push({ analyzer: 'tsc', status: 'skipped', findings: 0, reason: 'no tsconfig.json or TypeScript files' });
        else {
          const project = await openTsProject(ctx.workspace);
          try {
            const diags = projectDiagnostics(project).filter((d) => d.category === 'error' || d.category === 'warning');
            for (const d of diags) findings.push({ analyzer: 'tsc', path: d.path, line: d.line, column: d.column, severity: d.category === 'error' ? 'error' : 'warning', rule: d.code, message: d.message });
            runs.push({ analyzer: 'tsc', status: 'ran', command: `tsc --noEmit${project.configFile ? ` -p ${project.configFile}` : ''} (in-process TypeScript ${project.ts.version})`, exitCode: diags.some((d) => d.category === 'error') ? 2 : 0, findings: diags.length });
          } finally {
            project.dispose();
          }
        }
      }

      if (want.has('eslint')) {
        const configured = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'].some((f) => existsSync(join(root, f)));
        const bin = join(root, 'node_modules', '.bin', 'eslint');
        if (!configured) runs.push({ analyzer: 'eslint', status: 'skipped', findings: 0, reason: 'no eslint configuration in the workspace' });
        else if (!existsSync(bin)) runs.push({ analyzer: 'eslint', status: 'unavailable', findings: 0, reason: 'eslint is configured but not installed in the workspace (node_modules/.bin/eslint)' });
        else {
          const argv = ['node_modules/.bin/eslint', '-f', 'json', '.'];
          const r = await inSandbox(options, ctx, argv, {}, timeoutMs);
          const f = parseEslint(r.stdout, root);
          findings.push(...f);
          // eslint: 0 clean, 1 findings, 2 crash/config error
          runs.push({ analyzer: 'eslint', status: r.exitCode === 0 || r.exitCode === 1 ? 'ran' : 'failed', command: argv.join(' '), exitCode: r.exitCode, findings: f.length, ...(r.exitCode !== 0 && r.exitCode !== 1 ? { reason: r.stderr.trim().slice(0, 500) } : {}) });
        }
      }

      const pyEnv = { PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0' };
      let pyflakesRan = false;
      if (want.has('pyflakes')) {
        if (!hasPy) runs.push({ analyzer: 'pyflakes', status: 'skipped', findings: 0, reason: 'no Python files' });
        else {
          const r = await inSandbox(options, ctx, ['python3', '-m', 'pyflakes', '.'], pyEnv, timeoutMs);
          if (/No module named pyflakes/.test(r.stderr)) runs.push({ analyzer: 'pyflakes', status: 'unavailable', command: 'python3 -m pyflakes .', exitCode: r.exitCode, findings: 0, reason: 'pyflakes is not installed for python3 (the compile check runs instead)' });
          else if (r.exitCode === 0 || r.exitCode === 1) {
            const f = parseColonLines(`${r.stdout}\n${r.stderr}`, 'pyflakes', root);
            findings.push(...f);
            pyflakesRan = true;
            runs.push({ analyzer: 'pyflakes', status: 'ran', command: 'python3 -m pyflakes .', exitCode: r.exitCode, findings: f.length });
          } else runs.push({ analyzer: 'pyflakes', status: 'failed', command: 'python3 -m pyflakes .', exitCode: r.exitCode, findings: 0, reason: (r.spawnError ?? r.stderr).trim().slice(0, 500) });
        }
      }
      if (want.has('compileall') || (want.has('pyflakes') && hasPy && !pyflakesRan)) {
        if (!hasPy) runs.push({ analyzer: 'compileall', status: 'skipped', findings: 0, reason: 'no Python files' });
        else {
          const r = await inSandbox(options, ctx, ['python3', '-c', COMPILE_SCRIPT], pyEnv, timeoutMs);
          if (r.exitCode !== 0) runs.push({ analyzer: 'compileall', status: r.spawnError ? 'unavailable' : 'failed', command: 'python3 (compile every .py, no bytecode)', exitCode: r.exitCode, findings: 0, reason: (r.spawnError ?? r.stderr).trim().slice(0, 500) });
          else {
            const f = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { path: string; line: number; column: number; message: string }).map((e) => ({ analyzer: 'compileall' as const, path: e.path, line: e.line, column: e.column, severity: 'error' as const, rule: 'syntax', message: e.message }));
            findings.push(...f);
            runs.push({ analyzer: 'compileall', status: 'ran', command: 'python3 (compile every .py, no bytecode)', exitCode: 0, findings: f.length });
          }
        }
      }

      if (want.has('go_vet')) {
        if (!existsSync(join(root, 'go.mod'))) runs.push({ analyzer: 'go_vet', status: 'skipped', findings: 0, reason: 'no go.mod' });
        else {
          const r = await inSandbox(options, ctx, ['go', 'vet', './...'], goEnv(), timeoutMs);
          const f = parseColonLines(r.stderr, 'go_vet', root).filter((x) => !x.message.startsWith('go: '));
          findings.push(...f);
          if (r.spawnError) runs.push({ analyzer: 'go_vet', status: 'unavailable', command: 'go vet ./...', exitCode: r.exitCode, findings: 0, reason: r.spawnError });
          else runs.push({ analyzer: 'go_vet', status: r.exitCode === 0 || f.length > 0 ? 'ran' : 'failed', command: 'go vet ./...', exitCode: r.exitCode, findings: f.length, ...(r.exitCode !== 0 && f.length === 0 ? { reason: r.stderr.trim().slice(0, 500) } : {}) });
        }
      }

      const limit = input.limit ?? 500;
      const errors = findings.filter((f) => f.severity === 'error').length;
      const doc = { analyzers: runs, findingCount: findings.length, errorCount: errors, findings: findings.slice(0, 5000) };
      const evidence = await ctx.recordEvidence({
        evidenceType: 'static-analysis',
        data: JSON.stringify(doc),
        mimeType: 'application/json',
        summary: `static analysis (${runs.filter((r) => r.status === 'ran').map((r) => r.analyzer).join(', ') || 'no analyzer ran'}): ${errors} error(s), ${findings.length} finding(s)`.slice(0, 500),
        structured: { ...doc, findings: findings.slice(0, 1000) } as unknown as JsonValue,
      });
      return {
        status: 'success',
        structured: { analyzers: runs as unknown as JsonValue, findingCount: findings.length, errorCount: errors, findings: findings.slice(0, limit) as unknown as JsonValue, evidenceId: evidence.evidenceId },
        text: [
          ...runs.map((r) => `${r.analyzer}: ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.status === 'ran' ? `, ${r.findings} finding(s)` : ''}`),
          ...findings.slice(0, limit).map((f) => `${f.path}:${f.line}:${f.column} ${f.severity} [${f.analyzer} ${f.rule}] ${f.message.split('\n')[0]}`),
        ].join('\n'),
        evidenceRefs: [evidence.evidenceId],
      };
    },
  };
}
