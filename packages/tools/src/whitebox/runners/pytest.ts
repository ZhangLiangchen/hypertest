import { join } from 'node:path';
import { isHypertestError, throwIfAborted } from '@hypertest/core';
import type { CoverageMap, SandboxRunner, TestCaseResult, TestRunnerAdapter, TestRunnerOptions, WorkspaceHandle } from '../../contracts.ts';
import { parseCoverageJson } from '../coverage.ts';
import { confineExisting } from '../paths.ts';
import { anyFile, assertSafeSelector, buildResult, fileExists, processHarnessError, readIfExists, removeQuietly, reportPath, tail } from './common.ts';
import { parseJunitCases } from './node.ts';

const PY_ENV = { PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0', PYTHONUNBUFFERED: '1' };

/** pytest nodeid (`tests/test_x.py::TestC::test_y[p]`) → junit classname/name (`tests.test_x.TestC` / `test_y[p]`). */
export function nodeIdToJunit(nodeid: string): { classname: string; name: string } | undefined {
  const parts = nodeid.split('::');
  if (parts.length < 2) return undefined;
  const name = parts[parts.length - 1]!;
  const mod = parts[0]!.replace(/\.py$/, '').split('/').filter(Boolean).join('.');
  return { classname: [mod, ...parts.slice(1, -1)].join('.'), name };
}

/**
 * Marks non-strict XPASS cases: pytest's junit renders them as plain passes, so the `-rxX` short summary
 * (`XPASS tests/test_x.py::test_y - reason`) is authoritative for them.
 */
export function applyPytestSummary(cases: TestCaseResult[], stdout: string): void {
  for (const m of stdout.matchAll(/^XPASS(?:\(strict\))?\s+(\S+)/gm)) {
    const j = nodeIdToJunit(m[1]!);
    if (!j) continue;
    for (const c of cases) if (c.name === j.name && c.id === `${j.classname}::${j.name}` && c.status === 'passed') c.status = 'xpass';
  }
}

async function probe(sandbox: SandboxRunner, ws: WorkspaceHandle, argv: string[], signal: AbortSignal): Promise<boolean> {
  try {
    const r = await sandbox.run(ws, argv, { timeoutMs: 30_000, signal, env: PY_ENV });
    return r.exitCode === 0;
  } catch (e) {
    // a cancelled run is a cancellation, not "pytest is not available"
    throwIfAborted(signal);
    if (isHypertestError(e, 'precondition_failed') || isHypertestError(e, 'permission_denied')) throw e;
    return false;
  }
}

/**
 * pytest: `<python3 -m pytest | pytest> --junitxml=<f> -q -rxX -p no:cacheprovider`. The command is
 * resolved once per runner (python3 -m pytest, else a `pytest` executable) unless `options.command` is set.
 * Selector: a nodeid / path (`tests/test_x.py::test_y`) or a `-k` expression. xfail from
 * `<skipped type="pytest.xfail">`, xpass from the `-rxX` summary (non-strict) or `[XPASS(strict)]`
 * failures. Exit code 5 (no tests collected), 2/3/4 and collection errors are harness errors.
 * Coverage via pytest-cov (`--cov --cov-report=json:<f>`).
 */
export function pytestRunner(options: TestRunnerOptions = {}): TestRunnerAdapter {
  let resolved: string[] | undefined = options.command;
  return {
    framework: 'pytest',
    async detect(ws) {
      for (const f of ['pytest.ini', 'conftest.py']) if (await fileExists(join(ws.root, f))) return true;
      for (const [f, marker] of [['pyproject.toml', '[tool.pytest'], ['setup.cfg', '[tool:pytest]'], ['tox.ini', '[pytest]']] as const) {
        const text = await readIfExists(join(ws.root, f));
        if (text?.includes(marker)) return true;
      }
      return anyFile(ws.root, (_rel, name) => /^test_.*\.py$|_test\.py$/.test(name));
    },
    async run(ws, request, sandbox) {
      if (!resolved) {
        if (await probe(sandbox, ws, ['python3', '-m', 'pytest', '--version'], request.signal)) resolved = ['python3', '-m', 'pytest'];
        else if (await probe(sandbox, ws, ['pytest', '--version'], request.signal)) resolved = ['pytest'];
      }
      if (!resolved) {
        const result = buildResult({ framework: 'pytest', command: ['python3', '-m', 'pytest'], exitCode: null, cases: [], durationMs: 0, harnessError: 'pytest is not available (neither `python3 -m pytest` nor `pytest`)' });
        return { result, stdout: '', stderr: '' };
      }
      const junit = await reportPath(ws, 'pytest-junit.xml');
      const cov = request.coverage ? await reportPath(ws, 'pytest-coverage.json') : undefined;
      const argv = [...resolved, `--junitxml=${junit}`, '-q', '-rxX', '-p', 'no:cacheprovider', '-o', 'junit_family=xunit2'];
      if (cov) argv.push('--cov', `--cov-report=json:${cov}`);
      assertSafeSelector(request.selector);
      const selector = request.selector?.trim();
      if (selector) {
        const pathPart = selector.split('::')[0]!;
        const isNode = selector.includes('::') || /\.py$/.test(pathPart) || pathPart.includes('/');
        if (isNode) {
          await confineExisting(ws.root, pathPart);
          argv.push(selector);
        } else argv.push('-k', selector);
      }
      const proc = await sandbox.run(ws, argv, { timeoutMs: request.timeoutMs, signal: request.signal, env: { ...PY_ENV, ...(options.env ?? {}), ...(request.env ?? {}) } });
      try {
        const xml = await readIfExists(junit);
        const cases = xml ? parseJunitCases(xml, { framework: 'pytest' }) : [];
        applyPytestSummary(cases, proc.stdout);
        let harnessError = processHarnessError(proc, 'pytest');
        if (harnessError === undefined) {
          const collection = cases.filter((c) => c.status === 'error' && /collection failure/i.test(c.message ?? ''));
          if (proc.exitCode === 5) harnessError = 'pytest collected no tests (exit 5)';
          else if (collection.length > 0) harnessError = `pytest collection errors: ${collection.map((c) => c.name).join(', ')}`;
          else if (proc.exitCode === 2 || proc.exitCode === 3 || proc.exitCode === 4) harnessError = `pytest exited ${proc.exitCode} (${proc.exitCode === 2 ? 'interrupted' : proc.exitCode === 3 ? 'internal error' : 'usage error'}): ${tail(proc.stderr || proc.stdout, 1000)}`;
          else if (!xml) harnessError = `pytest produced no junit report (exit ${proc.exitCode}): ${tail(proc.stderr || proc.stdout, 1000)}`;
          else if (proc.exitCode !== 0 && cases.every((c) => c.status !== 'failed' && c.status !== 'xpass' && c.status !== 'error')) {
            harnessError = `pytest exited ${proc.exitCode} without a failing test: ${tail(proc.stderr || proc.stdout, 1000)}`;
          }
        }
        let coverage: CoverageMap | undefined;
        if (cov) {
          const text = await readIfExists(cov);
          if (text) coverage = parseCoverageJson(text);
        }
        const result = buildResult({ framework: 'pytest', command: argv, exitCode: proc.exitCode, cases, durationMs: proc.durationMs, harnessError });
        const out: Awaited<ReturnType<TestRunnerAdapter['run']>> = { result, stdout: proc.stdout, stderr: proc.stderr };
        if (xml) out.rawReport = { data: xml, mimeType: 'application/xml' };
        if (coverage) out.coverage = coverage;
        return out;
      } finally {
        await removeQuietly(junit);
        if (cov) await removeQuietly(cov);
      }
    },
  };
}
