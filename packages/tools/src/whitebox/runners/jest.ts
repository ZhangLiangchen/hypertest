import type { CoverageMap, TestCaseResult, TestCaseStatus, TestRunnerAdapter, TestRunnerOptions } from '../../contracts.ts';
import { parseLcov } from '../coverage.ts';
import { confineExisting } from '../paths.ts';
import { assertSafeSelector, buildResult, fileExists, hasDependency, looksLikePath, processHarnessError, readIfExists, readPackageJson, removeQuietly, reportPath, splitSelector, tail } from './common.ts';
import { rebase } from './node.ts';

interface JestAssertion {
  fullName?: string;
  title?: string;
  ancestorTitles?: string[];
  status?: string;
  duration?: number | null;
  failureMessages?: string[];
}
interface JestSuite {
  name?: string;
  status?: string;
  message?: string;
  assertionResults?: JestAssertion[];
}

function mapStatus(s: string | undefined): TestCaseStatus {
  switch (s) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'skipped':
    case 'todo':
    case 'disabled':
      return 'skipped';
    default:
      return 'error';
  }
}

/**
 * Parses the Jest `--json` report (Vitest's json reporter uses the same shape). A suite that failed without
 * assertion results (syntax error, import failure) becomes an `error` case named after the file.
 */
export function parseJestJson(text: string, root: string): { cases: TestCaseResult[]; suiteErrors: string[] } {
  const data = JSON.parse(text) as { testResults?: JestSuite[] };
  const prefix = root.endsWith('/') ? root : root + '/';
  const cases: TestCaseResult[] = [];
  const suiteErrors: string[] = [];
  for (const suite of data.testResults ?? []) {
    const abs = suite.name ?? '';
    const file = abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
    const results = suite.assertionResults ?? [];
    if (suite.status === 'failed' && results.length === 0) {
      suiteErrors.push(file);
      const c: TestCaseResult = { id: file, name: file, file, status: 'error' };
      const msg = (suite.message ?? '').trim();
      if (msg) c.message = msg.slice(0, 500);
      cases.push(c);
      continue;
    }
    for (const a of results) {
      const name = a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ''].filter(Boolean).join(' ');
      const c: TestCaseResult = { id: `${file}::${name}`, name, file, status: mapStatus(a.status) };
      if (typeof a.duration === 'number') c.durationMs = a.duration;
      const fm = (a.failureMessages ?? []).join('\n').trim();
      if (fm && c.status !== 'passed') c.message = fm.split('\n')[0]!.slice(0, 500);
      cases.push(c);
    }
  }
  return { cases, suiteErrors };
}

function jestLike(framework: 'vitest' | 'jest', options: TestRunnerOptions): TestRunnerAdapter {
  return {
    framework,
    async detect(ws) {
      return hasDependency(await readPackageJson(ws.root), framework);
    },
    async run(ws, request, sandbox) {
      const report = await reportPath(ws, `${framework}.json`);
      const covDir = request.coverage ? await reportPath(ws, `${framework}-coverage`) : undefined;
      const argv = [...(options.command ?? ['npx', '--no-install', framework])];
      if (framework === 'vitest') {
        argv.push('run', '--reporter=json', `--outputFile=${report}`);
        if (covDir) argv.push('--coverage.enabled=true', '--coverage.reporter=lcov', `--coverage.reportsDirectory=${covDir}`);
      } else {
        argv.push('--json', `--outputFile=${report}`, '--ci');
        if (covDir) argv.push('--coverage', `--coverageDirectory=${covDir}`, '--coverageReporters=lcov');
      }
      assertSafeSelector(request.selector);
      const sel = splitSelector(request.selector);
      let file = sel.file;
      let pattern = sel.pattern;
      if (file === undefined && pattern !== undefined && looksLikePath(pattern)) {
        const abs = await confineExisting(ws.root, pattern).catch(() => undefined);
        if (abs && (await fileExists(abs))) {
          file = pattern;
          pattern = undefined;
        }
      }
      if (file !== undefined) {
        await confineExisting(ws.root, file);
        if (framework === 'jest') argv.push('--runTestsByPath');
        argv.push(file);
      }
      if (pattern !== undefined) argv.push('-t', pattern);
      const proc = await sandbox.run(ws, argv, { timeoutMs: request.timeoutMs, signal: request.signal, env: { CI: 'true', NODE_ENV: 'test', ...(options.env ?? {}), ...(request.env ?? {}) } });
      try {
        const text = await readIfExists(report);
        let cases: TestCaseResult[] = [];
        let harnessError = processHarnessError(proc, framework);
        if (text) {
          try {
            const parsed = parseJestJson(text, ws.root);
            cases = parsed.cases;
            if (harnessError === undefined && parsed.suiteErrors.length > 0) harnessError = `test suites failed to run: ${parsed.suiteErrors.join(', ')}`;
          } catch (e) {
            harnessError ??= `unparsable ${framework} JSON report: ${(e as Error).message}`;
          }
        } else harnessError ??= `${framework} produced no JSON report (exit ${proc.exitCode}): ${tail(proc.stderr || proc.stdout, 1000)}`;
        if (harnessError === undefined && proc.exitCode !== 0 && cases.every((c) => c.status !== 'failed')) {
          harnessError = `${framework} exited ${proc.exitCode} without a failing test: ${tail(proc.stderr || proc.stdout, 1000)}`;
        }
        let coverage: CoverageMap | undefined;
        if (covDir) {
          const lcov = await readIfExists(`${covDir}/lcov.info`);
          if (lcov) coverage = rebase(parseLcov(lcov), ws.root);
        }
        const result = buildResult({ framework, command: argv, exitCode: proc.exitCode, cases, durationMs: proc.durationMs, harnessError });
        const out: Awaited<ReturnType<TestRunnerAdapter['run']>> = { result, stdout: proc.stdout, stderr: proc.stderr };
        if (text) out.rawReport = { data: text, mimeType: 'application/json' };
        if (coverage) out.coverage = coverage;
        return out;
      } finally {
        await removeQuietly(report);
        if (covDir) await removeQuietly(covDir);
      }
    },
  };
}

/** Vitest: `npx --no-install vitest run --reporter=json --outputFile=<f>`; selector `file::pattern`, file or `-t` pattern. */
export function vitestRunner(options: TestRunnerOptions = {}): TestRunnerAdapter {
  return jestLike('vitest', options);
}

/** Jest: `npx --no-install jest --json --outputFile=<f> --ci`; selector `file::pattern`, file (--runTestsByPath) or `-t` pattern. */
export function jestRunner(options: TestRunnerOptions = {}): TestRunnerAdapter {
  return jestLike('jest', options);
}
