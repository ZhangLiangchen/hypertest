import type { CoverageMap, TestCaseResult, TestCaseStatus, TestRunnerAdapter, TestRunnerOptions } from '../../contracts.ts';
import { parseLcov } from '../coverage.ts';
import { confineExisting } from '../paths.ts';
import { deepText, localName, parseXml, type XmlElement } from '../xml.ts';
import { anyFile, assertSafeSelector, buildResult, fileExists, looksLikePath, processHarnessError, readIfExists, readPackageJson, removeQuietly, reportPath, splitSelector, tail } from './common.ts';

const TEST_FILE_RE = /\.test\.(m|c)?[jt]s$|-test\.(m|c)?[jt]s$|_test\.(m|c)?[jt]s$|^test-.*\.(m|c)?[jt]s$|^test\.(m|c)?js$/;
const FILE_EXT_RE = /\.(m|c)?[jt]sx?$/;

export interface JunitParseOptions {
  framework: 'node_test' | 'pytest' | (string & {});
  /** Attribute every case to this file (when the run selected a single file). */
  file?: string;
}

function durationMs(attrs: Record<string, string>): number | undefined {
  const t = Number(attrs['time']);
  return Number.isFinite(t) ? Math.round(t * 1000 * 1000) / 1000 : undefined;
}

function firstLine(s: string | undefined, max = 500): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t === '') return undefined;
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * Parses JUnit XML (node:test's junit reporter and pytest's --junitxml) into cases. Status: `<failure>` ⇒
 * failed, `<error>` ⇒ error, `<skipped type="pytest.xfail">` ⇒ xfail, other `<skipped>` ⇒ skipped, a failure
 * whose message starts with `[XPASS(strict)]` ⇒ xpass, else passed. node:test specifics: a top-level
 * pseudo-case named after a test FILE whose failure is `test failed` is a file that could not run (load
 * error / crash) ⇒ error; failureType `cancelledByParent` / `hookFailure` ⇒ error (not an assertion outcome).
 */
export function parseJunitCases(xml: string, options: JunitParseOptions): TestCaseResult[] {
  const doc = parseXml(xml);
  const cases: TestCaseResult[] = [];
  const visit = (el: XmlElement, suites: string[], depth: number) => {
    for (const c of el.children) {
      const name = localName(c.name);
      if (name === 'testsuites') visit(c, suites, depth);
      else if (name === 'testsuite') {
        const sname = c.attrs['name'];
        // pytest wraps everything in <testsuite name="pytest">; node uses suite names for describe()
        const include = options.framework === 'node_test' && sname !== undefined && sname !== '';
        visit(c, include ? [...suites, sname!] : suites, depth + 1);
      } else if (name === 'testcase') {
        // node:test reports a file that registered no test (or crashed before reporting any) as a
        // top-level pseudo-case named after the file. A PASSING pseudo-case is not a test: counting it
        // would turn "zero tests ran" into a green run (fake green). A failing one is a harness error.
        if (options.framework === 'node_test' && depth === 0 && suites.length === 0 && isFilePseudoCase(c)) {
          const failed = c.children.some((x) => localName(x.name) === 'failure' || localName(x.name) === 'error');
          if (!failed) continue;
        }
        cases.push(toCase(c, suites, depth, options));
      }
    }
  };
  visit(doc, [], 0);
  return cases;
}

function isFilePseudoCase(c: XmlElement): boolean {
  const name = c.attrs['name'] ?? '';
  return FILE_EXT_RE.test(name) && c.children.every((x) => ['failure', 'error', 'system-out', 'system-err'].includes(localName(x.name)));
}

function toCase(c: XmlElement, suites: string[], depth: number, options: JunitParseOptions): TestCaseResult {
  const rawName = c.attrs['name'] ?? 'unnamed';
  const classname = c.attrs['classname'] ?? '';
  const failure = c.children.find((x) => localName(x.name) === 'failure');
  const error = c.children.find((x) => localName(x.name) === 'error');
  const skipped = c.children.find((x) => localName(x.name) === 'skipped');
  let status: TestCaseStatus = 'passed';
  let message: string | undefined;
  if (error) {
    status = 'error';
    message = firstLine(error.attrs['message']) ?? firstLine(deepText(error));
  } else if (failure) {
    const msg = failure.attrs['message'] ?? '';
    const type = failure.attrs['type'] ?? '';
    const body = deepText(failure);
    message = firstLine(msg) ?? firstLine(body);
    status = 'failed';
    if (msg.startsWith('[XPASS(strict)]')) status = 'xpass';
    else if (options.framework === 'node_test') {
      const fileLevel = depth === 0 && suites.length === 0 && FILE_EXT_RE.test(rawName) && msg === 'test failed' && /exitCode:/.test(body);
      if (fileLevel || /cancelledByParent|hookFailure/.test(type) || /failureType: '(cancelledByParent|hookFailure)'/.test(body)) status = 'error';
    }
  } else if (skipped) {
    const type = skipped.attrs['type'] ?? '';
    status = type === 'pytest.xfail' || /^xfail/i.test(skipped.attrs['message'] ?? '') ? 'xfail' : 'skipped';
    message = firstLine(skipped.attrs['message']);
  }
  let id: string;
  let name: string;
  if (options.framework === 'pytest') {
    name = rawName;
    id = classname ? `${classname}::${rawName}` : rawName;
  } else {
    name = [...suites, rawName].join(' > ');
    id = options.file ? `${options.file}::${name}` : name;
  }
  const r: TestCaseResult = { id, name, status };
  const file = options.file ?? c.attrs['file'];
  if (file !== undefined) r.file = file;
  const d = durationMs(c.attrs);
  if (d !== undefined) r.durationMs = d;
  if (message !== undefined && status !== 'passed') r.message = message;
  return r;
}

/**
 * node:test runner: `node --test --test-reporter=junit --test-reporter-destination=<file>
 * --test-reporter=spec --test-reporter-destination=stdout [files] [--test-name-pattern=<p>]`.
 * Selector: `file::pattern`, a test file path, or a name pattern (regex). Coverage (when requested) via
 * `--experimental-test-coverage` + the lcov reporter.
 */
export function nodeTestRunner(options: TestRunnerOptions = {}): TestRunnerAdapter {
  return {
    framework: 'node_test',
    async detect(ws) {
      const pkg = await readPackageJson(ws.root);
      if (pkg?.scripts?.['test'] && /node\s+(--[\w-]+\s+)*--test\b/.test(pkg.scripts['test'])) return true;
      return anyFile(ws.root, (rel, name) => TEST_FILE_RE.test(name) || /(^|\/)test\/[^/]+\.(m|c)?js$/.test(rel));
    },
    async run(ws, request, sandbox) {
      const junit = await reportPath(ws, 'node-junit.xml');
      const lcov = request.coverage ? await reportPath(ws, 'node-lcov.info') : undefined;
      const argv = [...(options.command ?? ['node']), '--test', '--test-reporter=junit', `--test-reporter-destination=${junit}`, '--test-reporter=spec', '--test-reporter-destination=stdout'];
      if (lcov) argv.push('--experimental-test-coverage', '--test-reporter=lcov', `--test-reporter-destination=${lcov}`);
      assertSafeSelector(request.selector);
      const sel = splitSelector(request.selector);
      let file: string | undefined = sel.file;
      let pattern = sel.pattern;
      if (file === undefined && pattern !== undefined && looksLikePath(pattern)) {
        const abs = await confineExisting(ws.root, pattern).catch(() => undefined);
        if (abs && (await fileExists(abs))) {
          file = pattern;
          pattern = undefined;
        }
      }
      // options must precede the file arguments (node treats what follows a file as more files)
      if (pattern !== undefined) argv.push(`--test-name-pattern=${pattern}`);
      if (file !== undefined) {
        await confineExisting(ws.root, file); // no selector may escape the workspace
        argv.push(file);
      }
      const runOpts: Parameters<typeof sandbox.run>[2] = { timeoutMs: request.timeoutMs, signal: request.signal, env: { NODE_ENV: 'test', ...(options.env ?? {}), ...(request.env ?? {}) } };
      const proc = await sandbox.run(ws, argv, runOpts);
      try {
        const xml = await readIfExists(junit);
        const cases = xml ? parseJunitCases(xml, file !== undefined ? { framework: 'node_test', file } : { framework: 'node_test' }) : [];
        let harnessError = processHarnessError(proc, 'node --test');
        if (harnessError === undefined) {
          const loadErrors = cases.filter((c) => c.status === 'error');
          if (xml === undefined || xml.trim() === '') harnessError = `node --test produced no junit report (exit ${proc.exitCode}): ${tail(proc.stderr || proc.stdout, 1000)}`;
          else if (loadErrors.length > 0) harnessError = `test harness errors: ${loadErrors.map((c) => c.name).join(', ')}`;
          else if (proc.exitCode !== 0 && cases.every((c) => c.status !== 'failed')) harnessError = `node --test exited ${proc.exitCode} without a failing test: ${tail(proc.stderr || proc.stdout, 1000)}`;
        }
        let coverage: CoverageMap | undefined;
        if (lcov) {
          const text = await readIfExists(lcov);
          if (text) coverage = rebase(parseLcov(text), ws.root);
        }
        const result = buildResult({ framework: 'node_test', command: argv, exitCode: proc.exitCode, cases, durationMs: proc.durationMs, harnessError });
        const out: Awaited<ReturnType<TestRunnerAdapter['run']>> = { result, stdout: proc.stdout, stderr: proc.stderr };
        if (xml) out.rawReport = { data: xml, mimeType: 'application/xml' };
        if (coverage) out.coverage = coverage;
        return out;
      } finally {
        await removeQuietly(junit);
        if (lcov) await removeQuietly(lcov);
      }
    },
  };
}

/** Makes absolute coverage paths under the workspace root relative (POSIX). */
export function rebase(map: CoverageMap, root: string): CoverageMap {
  const prefix = root.endsWith('/') ? root : root + '/';
  for (const f of map.files) if (f.path.startsWith(prefix)) f.path = f.path.slice(prefix.length);
  map.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return map;
}

