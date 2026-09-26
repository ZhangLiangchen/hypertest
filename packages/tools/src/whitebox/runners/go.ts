import { homedir } from 'node:os';
import { join } from 'node:path';
import { HypertestError } from '@hypertest/core';
import type { CoverageMap, TestCaseResult, TestCaseStatus, TestRunnerAdapter, TestRunnerOptions } from '../../contracts.ts';
import { parseGoCoverProfile } from '../coverage.ts';
import { assertSafeSelector, buildResult, fileExists, processHarnessError, readIfExists, removeQuietly, reportPath, tail } from './common.ts';

interface GoEvent {
  Action?: string;
  Package?: string;
  ImportPath?: string;
  Test?: string;
  Elapsed?: number;
  Output?: string;
  FailedBuild?: string;
}

export interface GoTestParse {
  cases: TestCaseResult[];
  /** Build failures, package failures without a failing test, tests that never finished. */
  harnessProblems: string[];
  packages: string[];
}

/**
 * Parses a `go test -json` event stream (incl. subtests `TestA/sub`, go1.24 `build-output`/`build-fail`
 * events and `FailedBuild`). Case id `<package>::<Test>`. A test that started but never reached
 * pass/fail/skip (panic, timeout) is an `error` case.
 */
export function parseGoTestJson(stream: string): GoTestParse {
  const cases = new Map<string, TestCaseResult & { _out: string[] }>();
  const order: string[] = [];
  const harnessProblems: string[] = [];
  const buildOutput = new Map<string, string[]>();
  const pkgFailed = new Map<string, boolean>();
  const pkgOutput = new Map<string, string[]>();
  const packages = new Set<string>();
  for (const line of stream.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let e: GoEvent;
    try {
      e = JSON.parse(t) as GoEvent;
    } catch {
      continue;
    }
    if (e.Action === 'build-output' && e.ImportPath) {
      const list = buildOutput.get(e.ImportPath) ?? [];
      list.push(e.Output ?? '');
      buildOutput.set(e.ImportPath, list);
      continue;
    }
    if (e.Action === 'build-fail' && e.ImportPath) {
      harnessProblems.push(`build failed: ${e.ImportPath}: ${(buildOutput.get(e.ImportPath) ?? []).join('').trim().slice(0, 1000)}`);
      continue;
    }
    const pkg = e.Package ?? '';
    if (pkg) packages.add(pkg);
    if (e.Test === undefined) {
      if (e.Action === 'output') {
        const list = pkgOutput.get(pkg) ?? [];
        list.push(e.Output ?? '');
        pkgOutput.set(pkg, list);
      }
      if (e.Action === 'fail') {
        pkgFailed.set(pkg, true);
        if (e.FailedBuild && !harnessProblems.some((p) => p.includes(e.FailedBuild!))) harnessProblems.push(`build failed: ${e.FailedBuild}`);
      }
      continue;
    }
    const id = `${pkg}::${e.Test}`;
    let c = cases.get(id);
    if (!c) {
      c = { id, name: e.Test, status: 'error', _out: [] };
      cases.set(id, c);
      order.push(id);
    }
    if (e.Action === 'output' && e.Output) c._out.push(e.Output);
    const terminal: Record<string, TestCaseStatus> = { pass: 'passed', fail: 'failed', skip: 'skipped' };
    if (e.Action && e.Action in terminal) {
      c.status = terminal[e.Action]!;
      if (typeof e.Elapsed === 'number') c.durationMs = e.Elapsed * 1000;
    }
  }
  const out: TestCaseResult[] = [];
  for (const id of order) {
    const { _out, ...c } = cases.get(id)!;
    if (c.status === 'error') harnessProblems.push(`test ${id} did not finish`);
    if (c.status !== 'passed') {
      const msg = _out.filter((l) => !/^(=== (RUN|PAUSE|CONT|NAME)|--- (PASS|FAIL|SKIP))/.test(l.trim())).join('').trim();
      if (msg) c.message = msg.slice(0, 500);
    }
    out.push(c);
  }
  for (const [pkg, failed] of pkgFailed) {
    if (!failed) continue;
    const anyFailingCase = out.some((c) => c.id.startsWith(`${pkg}::`) && (c.status === 'failed' || c.status === 'error'));
    if (!anyFailingCase && !harnessProblems.some((p) => p.includes(pkg))) {
      harnessProblems.push(`package ${pkg} failed without a failing test: ${(pkgOutput.get(pkg) ?? []).join('').trim().slice(0, 1000)}`);
    }
  }
  return { cases: out, harnessProblems, packages: [...packages].sort() };
}

/** `pkg::regex` | `./pkg/...` | `regex` → go test arguments. */
export function goSelectorArgs(selector: string | undefined): { packages: string[]; run?: string } {
  const s = selector?.trim();
  if (!s) return { packages: ['./...'] };
  const i = s.indexOf('::');
  if (i >= 0) {
    const pkg = s.slice(0, i).trim() || './...';
    const run = s.slice(i + 2).trim();
    return run ? { packages: [pkg], run } : { packages: [pkg] };
  }
  if (s.startsWith('./') || s === '.') return { packages: [s] };
  return { packages: ['./...'], run: s };
}

/** Environment for go (build cache reused from the host; no toolchain download, no module proxy). */
export function goEnv(): Record<string, string> {
  const home = homedir();
  return {
    GOCACHE: process.env['GOCACHE'] ?? join(home, '.cache', 'go-build'),
    GOPATH: process.env['GOPATH'] ?? join(home, 'go'),
    GOMODCACHE: process.env['GOMODCACHE'] ?? join(process.env['GOPATH'] ?? join(home, 'go'), 'pkg', 'mod'),
    GOTOOLCHAIN: 'local',
    GOPROXY: 'off',
    GOFLAGS: '-mod=readonly',
    CGO_ENABLED: '0',
  };
}

/**
 * go test: `go test -json [-run <regex>] [-coverprofile=<f>] <packages>`. Selector `pkg::regex`, a package
 * pattern (`./x/...`) or a `-run` regex over ./... . Build failures and unfinished tests are harness errors.
 */
export function goTestRunner(options: TestRunnerOptions = {}): TestRunnerAdapter {
  return {
    framework: 'go_test',
    async detect(ws) {
      return fileExists(join(ws.root, 'go.mod'));
    },
    async run(ws, request, sandbox) {
      const cover = request.coverage ? await reportPath(ws, 'go-cover.out') : undefined;
      assertSafeSelector(request.selector);
      const sel = goSelectorArgs(request.selector);
      for (const p of sel.packages) {
        const segs = p.split('/');
        if (p.startsWith('-') || p.startsWith('/') || segs.some((s, i) => s === '..' || (s === '...' && i !== segs.length - 1))) {
          throw new HypertestError('invalid_argument', `invalid go package pattern ${JSON.stringify(p)}`);
        }
      }
      if (sel.run?.startsWith('-')) throw new HypertestError('invalid_argument', `invalid -run pattern ${JSON.stringify(sel.run)}`);
      const argv = [...(options.command ?? ['go']), 'test', '-json', '-count=1'];
      if (sel.run) argv.push('-run', sel.run);
      if (cover) argv.push(`-coverprofile=${cover}`);
      argv.push(...sel.packages);
      const proc = await sandbox.run(ws, argv, { timeoutMs: request.timeoutMs, signal: request.signal, env: { ...goEnv(), ...(options.env ?? {}), ...(request.env ?? {}) } });
      try {
        const parsed = parseGoTestJson(proc.stdout);
        let harnessError = processHarnessError(proc, 'go test');
        if (harnessError === undefined && parsed.harnessProblems.length > 0) harnessError = parsed.harnessProblems.join('; ');
        if (harnessError === undefined && parsed.packages.length === 0 && proc.exitCode !== 0) harnessError = `go test failed before running tests (exit ${proc.exitCode}): ${tail(proc.stderr || proc.stdout, 1000)}`;
        if (harnessError === undefined && proc.exitCode !== 0 && parsed.cases.every((c) => c.status !== 'failed')) harnessError = `go test exited ${proc.exitCode} without a failing test: ${tail(proc.stderr, 1000)}`;
        let coverage: CoverageMap | undefined;
        if (cover) {
          const text = await readIfExists(cover);
          if (text && text.startsWith('mode:')) coverage = parseGoCoverProfile(text);
        }
        const result = buildResult({ framework: 'go_test', command: argv, exitCode: proc.exitCode, cases: parsed.cases, durationMs: proc.durationMs, harnessError });
        const out: Awaited<ReturnType<TestRunnerAdapter['run']>> = { result, stdout: proc.stdout, stderr: proc.stderr, rawReport: { data: proc.stdout, mimeType: 'application/x-ndjson' } };
        if (coverage) out.coverage = coverage;
        return out;
      } finally {
        if (cover) await removeQuietly(cover);
      }
    },
  };
}
