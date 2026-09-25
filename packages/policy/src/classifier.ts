import type { ClassifyOptions, SelfHealDecision, TestChangeCategory, TestChangeClassification, TestChangeFinding } from './contracts.ts';
import { parseUnifiedDiff, type DiffFile, type DiffHunk, type DiffLine } from './diff.ts';
import { matchesGlob } from './patterns.ts';

/**
 * Self-heal governance (I8): classifies a unified diff of test (and product) code into self-heal
 * categories and derives the most restrictive decision. Heuristic but conservative: anything that could
 * weaken what a test checks lands in approval_required or forbidden.
 */

/** Default test path globs (JS/TS, Python, Go, plus common test/fixture directories). */
export const DEFAULT_TEST_PATH_PATTERNS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test_*.py',
  '**/*_test.py',
  '**/*_test.go',
  '**/tests/**',
  '**/__tests__/**',
  '**/conftest.py',
  '**/test/**',
  '**/fixtures/**',
  '**/testdata/**',
];

const FIXTURE_PATH_PATTERNS = ['**/fixtures/**', '**/__fixtures__/**', '**/testdata/**', '**/conftest.py', '**/test-data/**', '**/test_data/**'];
const SNAPSHOT_PATH_PATTERNS = ['**/__snapshots__/**', '**/*.snap', '**/*.golden', '**/golden/**', '**/*.approved.*'];
const TEST_CONFIG_PATTERNS = [
  '**/jest.config.*', '**/jest.setup.*', '**/vitest.config.*', '**/vitest.setup.*', '**/vitest.workspace.*', '**/playwright.config.*',
  '**/cypress.config.*', '**/karma.conf.*', '**/.mocharc*', '**/pytest.ini', '**/tox.ini', '**/.env.test', '**/.env.test.*',
  '**/docker-compose.test.*', '**/docker-compose.*.test.*', '**/compose.test.*',
];
const ENV_FILE_PATTERNS = ['**/Dockerfile*', '**/*.dockerfile', '**/docker-compose*', '**/compose.*', '**/.env*', '**/*.env'];
const EXPECTED_DATA_RE = /(?:^|[/_.-])(?:expected|golden|snapshots?|baseline|oracle)(?:[/_.-]|$)/i;

type Lang = 'js' | 'py' | 'go' | 'other' | 'data';

const CATEGORY_ORDER: readonly TestChangeCategory[] = [
  'locator', 'environment_setup', 'fixture', 'test_implementation', 'timeout', 'assertion', 'threshold', 'product_code',
  'test_deleted', 'test_skipped', 'exception_swallowed', 'unknown',
];

const DECISION_RANK: Record<SelfHealDecision, number> = { auto_allowed: 0, conditional: 1, approval_required: 2, forbidden: 3 };

/** Decision table (ClassifyOptions.productFixAuthorized turns product_code into approval_required). */
export function categoryDecision(category: TestChangeCategory, productFixAuthorized = false): SelfHealDecision {
  switch (category) {
    case 'locator':
    case 'environment_setup':
      return 'auto_allowed';
    case 'fixture':
    case 'test_implementation':
    case 'timeout':
      return 'conditional';
    case 'assertion':
    case 'threshold':
    case 'unknown':
      return 'approval_required';
    case 'product_code':
      return productFixAuthorized ? 'approval_required' : 'forbidden';
    case 'test_deleted':
    case 'test_skipped':
    case 'exception_swallowed':
      return 'forbidden';
  }
}

function langOf(path: string): Lang {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = m ? m[1]!.toLowerCase() : '';
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'js';
  if (ext === 'py') return 'py';
  if (ext === 'go') return 'go';
  if (['java', 'kt', 'kts', 'rb', 'cs', 'rs', 'php', 'swift', 'scala', 'groovy'].includes(ext)) return 'other';
  return 'data';
}

const anyGlob = (globs: readonly string[], path: string) => globs.some((g) => matchesGlob(g, path));

// ----------------------------------------------------------------------------- lexical helpers

const STRING_RE = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;
const NUMBER_RE = /(?<![\w.$])-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.])/g;

function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Whitespace-insensitive identity of a code line (Python keeps its indentation, which is semantic). */
function codeKey(s: string, lang: Lang): string {
  const body = segmentsOf(s.trim()).map((seg) => (seg.str ? seg.text : seg.text.replace(/\s+/g, ''))).join('');
  return lang === 'py' ? `${indentOf(s)}|${body}` : body;
}

const CLOSER_RE = /^\s*[)}\]]+[;,)]*\s*$/;
/** New control flow that can stop an existing assertion from running (its body is the region it guards). */
const CONTROL_RE = /^\s*(?:\}\s*)?(?:if|else|elif|for|while|switch|try|with|unless|do|catch|finally|except)\b/;
/**
 * A statement that ends the enclosing function/loop early (anywhere on the line, so `if (CI) return;` counts):
 * every later statement of the enclosing function becomes (conditionally) dead.
 */
const EXIT_RE = /\b(?:return|continue|break)\b|\bSkipNow\b|\bexit\s*\(|\bExit\s*\(/;
/**
 * Code whose body does not run where it is written: function/closure definitions and deferred callbacks.
 * Wrapping an existing assertion in one silently disables it unless something calls it.
 */
const WRAPPER_RE: Record<Lang, RegExp | undefined> = {
  js: /\bfunction\b|=>\s*\{|=>\s*$|\b(?:setTimeout|setImmediate|setInterval|queueMicrotask)\s*\(|\bprocess\s*\.\s*nextTick\s*\(|\.then\s*\(|\bclass\s+\w/,
  go: /\bfunc\b/,
  py: /^\s*(?:async\s+)?def\s+|\blambda\b|^\s*class\s+/,
  other: /\bfun\b|->\s*\{|\bRunnable\b/,
  data: undefined,
};
/** Blocks whose bodies do run where they are written (suites, hooks); never treated as wrappers. */
const SUITE_RE = /(?:^|[^.\w$])(?:test\s*\.\s*)?(?:describe|context|suite)(?:\s*\.\s*\w+)*\s*\(|\bt\s*\.\s*Run\s*\(/;
/** The end of a callback argument (`})`, `});`, `}, 100)`): an early exit inside it only leaves the callback. */
const CALLBACK_END_RE = /^\s*\}\s*[),]/;
/** A new top-level scope starts (test, suite, hook or named function declaration). */
const SCOPE_START_RE = /^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*func\s+\w|^\s*(?:async\s+)?def\s+|^\s*class\s+/;

/** Splits a line into string-literal and code segments. */
function segmentsOf(s: string): Array<{ str: boolean; text: string; start: number }> {
  const out: Array<{ str: boolean; text: string; start: number }> = [];
  let last = 0;
  for (const m of s.matchAll(STRING_RE)) {
    if (m.index! > last) out.push({ str: false, text: s.slice(last, m.index), start: last });
    out.push({ str: true, text: m[0], start: m.index! });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ str: false, text: s.slice(last), start: last });
  return out;
}

function skeleton(s: string, maskStrings: boolean, maskNumbers: boolean): string {
  return segmentsOf(s)
    .map((seg) => (seg.str ? (maskStrings ? 'S' : seg.text) : maskNumbers ? seg.text.replace(NUMBER_RE, 'N') : seg.text))
    .join('')
    .replace(/\s+/g, '');
}

/** Code with string-literal contents blanked (detectors must not fire on test titles or messages). */
function maskStrings(s: string): string {
  return segmentsOf(s).map((seg) => (seg.str ? `${seg.text[0]}${seg.text[0]}` : seg.text)).join('');
}

function stringLiterals(s: string): Array<{ text: string; start: number }> {
  return segmentsOf(s).filter((x) => x.str).map((x) => ({ text: x.text, start: x.start }));
}

function numbers(s: string): string[] {
  return segmentsOf(s).filter((x) => !x.str).flatMap((x) => x.text.match(NUMBER_RE) ?? []);
}

function isComment(text: string, lang: Lang): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (lang === 'py') return t.startsWith('#');
  if (lang === 'data') return false;
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/');
}

function stripTrailingComment(text: string, lang: Lang): string {
  // Only strips comments outside string literals.
  const segs = segmentsOf(text);
  let out = '';
  for (const seg of segs) {
    if (seg.str) {
      out += seg.text;
      continue;
    }
    const marker = lang === 'py' ? seg.text.indexOf('#') : seg.text.search(/\/\/|\/\*/);
    if (marker >= 0) {
      out += seg.text.slice(0, marker);
      return out;
    }
    out += seg.text;
  }
  return out;
}

function indentOf(text: string): number {
  const m = /^[ \t]*/.exec(text)!;
  return m[0].replace(/\t/g, '    ').length;
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/[^A-Za-z0-9_$]+/).filter(Boolean));
}

function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 && y.size === 0) return 1;
  let common = 0;
  for (const t of x) if (y.has(t)) common++;
  return common / Math.max(x.size, y.size);
}

// ----------------------------------------------------------------------------- detectors

const SKIP_RE: Record<Lang, RegExp[]> = {
  js: [
    // any modifier chain (`it.concurrent.skip`, `test.describe.skip`); `fails`/`failing` invert the outcome (fake green)
    /\b(?:it|test|describe|context|suite|specify|bench)(?:\s*\.\s*\w+)*\s*\.\s*(?:skip|todo|fixme|skipIf|runIf|fails|failing)\b/,
    /\b(?:xit|xtest|xdescribe|xcontext|xspecify|xsuite)\s*\(/,
    /\b(?:it|test|describe|context|suite|specify)(?:\s*\.\s*\w+)*\s*\.\s*only\b/,
    /\b(?:fit|fdescribe|ftest)\s*\(/,
    /\bthis\s*\.\s*skip\s*\(/,
    /\bt\s*\.\s*(?:skip|todo)\s*\(/,
    /\b(?:it|test|describe|suite)\s*\(\s*(['"`])(?:\\.|(?!\1)[^\\])*\1\s*,\s*\{[^}]*\b(?:skip|todo|only)\s*:\s*(?!false\b|undefined\b|null\b)/,
    /\bpending\s*\(\s*\)/,
  ],
  py: [
    /\bmark\s*\.\s*(?:skip|skipif|xfail)\b/,
    /\bpytest\s*\.\s*(?:skip|xfail|importorskip)\s*\(/,
    /@(?:unittest\s*\.\s*)?(?:skip|skipIf|skipUnless|expectedFailure)\b/,
    /\bself\s*\.\s*skipTest\s*\(/,
    /\braise\s+(?:unittest\s*\.\s*)?SkipTest\b/,
    /\bcollect_ignore(?:_glob)?\b/,
    // collection hooks whose only purpose is excluding tests
    /\bdef\s+pytest_ignore_collect\b|\bpytest_deselected\b|\.\s*deselect\s*\(/,
  ],
  go: [/\b[tbf]\s*\.\s*(?:Skip|SkipNow|Skipf)\s*\(/],
  other: [/@(?:Disabled|Ignore)\b/, /\b(?:skip|pending|xit)\s*\(/],
  data: [],
};
const CONFIG_SKIP_RE: RegExp[] = [
  /\b(?:testPathIgnorePatterns|modulePathIgnorePatterns|coveragePathIgnorePatterns|testIgnore|grepInvert|passWithNoTests|collect_ignore|norecursedirs|forbidOnly)\b/,
  /--deselect\b|--ignore(?:-glob)?\b|(?:^|\s)-k\s|--grep-invert\b|--passWithNoTests\b|--testPathIgnorePatterns\b|--lf\b/,
  /\bexclude\s*[:=]/,
  /\b(?:only|skip)\s*[:=]\s*(?!false\b)/,
];
const GO_BUILD_IGNORE_RE = /^\s*\/\/\s*(?:\+build|go:build)\b.*\bignore\b/;
/** Hooks that can rewrite the collected test set (legitimate uses exist, so: needs approval). */
const COLLECTION_HOOK_RE = /\bdef\s+pytest_collection_modifyitems\b|\bdef\s+pytest_collect_file\b|\bdef\s+pytest_pycollect_makeitem\b/;
/** Runner configuration keys that select which tests run; changing them can silently drop tests. */
const CONFIG_SELECTION_RE =
  /\b(?:testMatch|testRegex|testPathPattern|roots|testDir|testFiles|testNamePattern|include|spec|specPattern|projects|shard|grep|python_files|python_classes|python_functions|testpaths)\b|(?:^|\s)(?:-t|-m)\s|--(?:testNamePattern|grep|shard|project|include|spec)\b/;

const SWALLOW_SAME_LINE: Record<Lang, RegExp[]> = {
  js: [
    /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:return\s*(?:undefined|null)?\s*;?\s*)?\}/,
    /\.catch\s*\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|undefined|null|void\s+0|\{\s*return\s*;?\s*\})\s*\)/,
    /\.catch\s*\(\s*(?:noop|\(\)\s*=>\s*\{\s*\})\s*\)/,
  ],
  py: [/^\s*except\b[^:]*:\s*(?:pass|\.\.\.|continue|return(?:\s+None)?)\s*$/, /\bsuppress\s*\(/],
  go: [/\brecover\s*\(\s*\)/, /^\s*_\s*=\s*err\b/],
  other: [/\bcatch\s*\([^)]*\)\s*\{\s*\}/],
  data: [],
};
const SWALLOW_OPENER: Record<Lang, RegExp | undefined> = {
  js: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/,
  py: /^\s*except\b[^:]*:\s*$/,
  go: undefined,
  other: /\bcatch\s*\([^)]*\)\s*\{\s*$/,
  data: undefined,
};
const SWALLOW_BODY: Record<Lang, RegExp | undefined> = {
  js: /^\s*(?:\}|return\s*;?\s*\}?|return\s+(?:undefined|null)\s*;?\s*\}?)\s*$/,
  py: /^\s*(?:pass|\.\.\.|continue|return(?:\s+None)?)\s*$/,
  go: undefined,
  other: /^\s*\}\s*$/,
  data: undefined,
};

const ASSERT_RE: Record<Lang, RegExp[]> = {
  js: [
    /\bexpect\s*[.(]/,
    /\bassert\b/,
    /\.should\b|\bshould\s*\(/,
    /\.to\s*\.\s*(?:be|equal|eql|have|include|deep|match|throw|not)\b/,
    /\bt\s*\.\s*(?:is|not|deepEqual|notDeepEqual|true|false|truthy|falsy|throws|throwsAsync|notThrows|regex|snapshot|equal|notEqual|ok|same|match)\s*\(/,
    /\b(?:want|wanted|expected|expectation)(?:[A-Z_]\w*)?\s*(?:=(?!=)|:(?!:))/,
  ],
  py: [
    /^\s*assert\b/,
    /\bself\s*\.\s*(?:assert\w*|fail\w*)\s*\(/,
    /\bassert_\w+\s*\(/,
    /\bpytest\s*\.\s*(?:raises|approx|warns|fail)\s*\(/,
    /\b(?:want|wanted|expected|expectation)\w*\s*(?:=(?!=)|:(?!:))/,
  ],
  go: [
    /\bt\s*\.\s*(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/,
    /\b(?:assert|require)\s*\.\s*\w+\s*\(/,
    /\b(?:want|wanted|expected|exp)(?:[A-Z_]\w*)?\s*(?::=|=(?!=)|:(?!=))/,
  ],
  other: [/\bassert\w*\s*\(/, /\bexpect\s*\(/, /\bassertThat\s*\(/],
  data: [],
};
/** A line that makes the preceding `if` line an assertion (Go/JS/Python guard-and-fail style). */
const FAIL_CALL_RE = /\bt\s*\.\s*(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\bpytest\s*\.\s*fail\s*\(|\bassert\s*\.\s*fail\s*\(|\bthrow\s+new\s+(?:Assertion)?Error\b|\bself\s*\.\s*fail\s*\(/;
const IF_RE = /^\s*(?:\}\s*else\s+)?if\b/;

const THRESHOLD_ASSERT_RE =
  /\btoBe(?:Less|Greater)Than(?:OrEqual)?\b|\btoBeCloseTo\b|\bassert(?:Less|Greater)(?:Equal)?\b|\bassert(?:Not)?AlmostEqual\b|\b(?:Less|Greater)(?:OrEqual)?\s*\(|\bIn(?:Delta|Epsilon)\w*\b|\bWithinDuration\b|\bapprox\s*\(|\b(?:rel|abs|delta|places|tolerance|epsilon|atol|rtol)\s*=|\bis(?:Below|Above|AtMost|AtLeast)\b|\bcloseTo\b|\b(?:within|below|above|least|most|lessThan|greaterThan)\s*\(|(?<![=<>!-])(?:<=?|>=?)(?![=>])\s*-?\d|\d\s*(?:<=?|>=?)(?![=>])|\btimeout|\blatency|\bduration|\belapsed|\bp9\d\b|\bpercentile/i;
const TIMEOUT_RE =
  /timeout|deadline|\bsetTimeout\b|\bthis\s*\.\s*timeout\s*\(|@pytest\s*\.\s*mark\s*\.\s*timeout|WithTimeout|WithDeadline|time\s*\.\s*After\b|time\s*\.\s*Sleep\b|\bsleep\s*\(|\bwaitFor\w*\s*\(|\bwait_for\w*\s*\(|\bdelay\b|\bpoll(?:ing)?Interval\b/i;
const THRESHOLD_NAME_RE = /\b\w*(?:threshold|tolerance|limit|max|min|budget|slo|sla|p50|p90|p95|p99|percentile|epsilon|delta|latency|rate|ratio)\w*\b/i;
const RETRY_RE = /\bretries\b|\bretry\w*\b|\bretryTimes\s*\(|\bthis\s*\.\s*retries\s*\(|@pytest\s*\.\s*mark\s*\.\s*flaky|@flaky\b|\breruns\b/i;

const STRUCTURAL_LOCATOR_CALL_RE =
  /(?:getByTestId|get_by_test_id|locator|querySelector(?:All)?|getElementById|getElementsByClassName|\$\$?|cy\s*\.\s*get|find_elements?(?:_by_\w+)?|findElements?|By\s*\.\s*\w+|waitForSelector|select_one|page\s*\.\s*(?:click|fill|check|uncheck|hover|type|press|dblclick|focus|tap))\s*\(\s*(?:By\s*\.\s*\w+\s*,\s*)?$/;
const TEXT_LOCATOR_CALL_RE =
  /(?:getBy(?:Text|Label|Placeholder|Role|AltText|Title|DisplayValue)|findBy\w+|queryBy\w+|get_by_(?:text|label|placeholder|role|alt_text|title)|getByRole\s*\(\s*['"`][^'"`]*['"`]\s*,\s*\{\s*name\s*:)\s*\(?\s*$/;
const LOCATOR_ATTR_RE = /data-(?:testid|test-id|test|cy|qa)\b|^['"`][#.[]/;

const SETUP_OPENER_RE: Record<Lang, RegExp | undefined> = {
  js: /\b(?:beforeAll|beforeEach|afterAll|afterEach|before|after|globalSetup|globalTeardown|setup|teardown)\s*\(/,
  py: /^\s*(?:async\s+)?def\s+(?:setUp|tearDown|setUpClass|tearDownClass|asyncSetUp|asyncTearDown|setup_method|teardown_method|setup_class|teardown_class|setup_module|teardown_module|setup_function|teardown_function)\s*\(/,
  go: /^\s*func\s+(?:TestMain|setup\w*|teardown\w*|setUp\w*|tearDown\w*)\s*\(/,
  other: /@(?:Before|After|BeforeEach|AfterEach|BeforeAll|AfterAll|BeforeClass|AfterClass)\b/,
  data: undefined,
};
const ENV_TOKEN_RE = /\bprocess\s*\.\s*env\b|\bos\s*\.\s*environ\b|\bmonkeypatch\s*\.\s*(?:setenv|delenv)\b|\bt\s*\.\s*Setenv\b|\bos\s*\.\s*Setenv\b|\bdocker\b|\btestcontainers\b|GenericContainer|DockerCompose|\bdotenv\b/i;
const FIXTURE_OPENER_RE = /@pytest\s*\.\s*fixture\b|@fixture\b|\btest\s*\.\s*extend\s*[<(]/;

const TEST_DEF_RE: Record<Lang, RegExp | undefined> = {
  js: /(?<![.\w$])(?:[xf]?it|[xf]?test|specify)(?:\s*\.\s*(?:only|skip|todo|concurrent|fixme|fails|failing|sequential|(?:skipIf|runIf)\s*\([^)]*\)|each\s*(?:\([^)]*\)|`[^`]*`)))*\s*\(\s*(?:(['"`])((?:\\.|(?!\1)[^\\])*)\1)?/,
  py: /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/,
  go: /^\s*func\s+((?:Test|Benchmark|Fuzz|Example)\w*)\s*\(|\bt\s*\.\s*Run\s*\(\s*"((?:\\.|[^"\\])*)"/,
  other: /@Test\b.*?(\w+)?/,
  data: undefined,
};

function testDefName(text: string, lang: Lang): string | undefined {
  const re = TEST_DEF_RE[lang];
  if (!re) return undefined;
  const m = re.exec(text);
  if (!m) return undefined;
  if (lang === 'js') return m[2] !== undefined ? m[2] : norm(text);
  if (lang === 'go') return m[1] ?? m[2] ?? norm(text);
  return m[1] ?? norm(text);
}

const matchesAny = (res: readonly RegExp[], text: string) => res.some((r) => r.test(text));

// ----------------------------------------------------------------------------- per-file analysis

interface LineInfo {
  line: DiffLine;
  code: string;
  /** code with string contents blanked (input of all regex detectors). */
  masked: string;
  comment: boolean;
  blank: boolean;
  assertion: boolean;
  inSetup: boolean;
  inFixture: boolean;
  /** For removed lines inside a wholly removed test definition: that test's key. */
  removedTest?: string;
  /** Context line that is live code in the old version but inside a block comment/string the diff opened. */
  disabled?: boolean;
}

/**
 * Multi-line comment/string delimiter left open by a line (outside complete string literals), if any:
 * `*\/` for `/*`, a backtick for template literals/raw strings, the triple quote for Python strings.
 */
function openedDelimiter(text: string, lang: Lang): string | undefined {
  if (lang === 'data') return undefined;
  if (lang === 'py') {
    const code = text.trimStart().startsWith('#') ? '' : text;
    for (const d of ['"""', "'''"]) if ((code.split(d).length - 1) % 2 === 1) return d;
    return undefined;
  }
  let ticks = 0;
  for (const seg of segmentsOf(text)) {
    if (seg.str) continue;
    const lc = seg.text.indexOf('//');
    const scan = lc >= 0 ? seg.text.slice(0, lc) : seg.text;
    const open = scan.lastIndexOf('/*');
    // `\/*` inside a regex literal is not a comment opener
    if (open >= 0 && scan[open - 1] !== '\\' && scan.indexOf('*/', open + 2) < 0) return '*/';
    ticks += scan.split('`').length - 1;
    if (lc >= 0) break;
  }
  return (lang === 'js' || lang === 'go') && ticks % 2 === 1 ? '`' : undefined;
}

function closesDelimiter(text: string, delimiter: string): boolean {
  if (delimiter === '*/') return text.includes('*/');
  return (text.split(delimiter).length - 1) % 2 === 1;
}

/**
 * Marks the lines of the NEW version that sit inside a block comment / multi-line string opened by an added
 * line. Only regions opened by the diff are tracked: pre-existing regions (whose openers may lie outside the
 * hunk) are left as code, so a mis-detection can only make the classification stricter, never hide a change.
 */
function newRegionLines(hunk: DiffHunk, lang: Lang): Set<DiffLine> {
  const inside = new Set<DiffLine>();
  let open: string | undefined;
  for (const line of hunk.lines) {
    if (line.kind === 'del') continue;
    if (open !== undefined) {
      inside.add(line);
      if (closesDelimiter(line.text, open)) open = undefined;
      continue;
    }
    if (line.kind === 'add' && !isComment(line.text, lang)) open = openedDelimiter(line.text, lang);
    else if (line.kind === 'add' && lang !== 'py' && line.text.trimStart().startsWith('/*') && !line.text.includes('*/', line.text.indexOf('/*') + 2)) open = '*/';
  }
  return inside;
}

type BaseCategory = 'test_implementation' | 'fixture' | 'environment_setup';

class Collector {
  readonly findings: TestChangeFinding[] = [];
  readonly #seen = new Set<string>();
  add(file: string, category: TestChangeCategory, detail: string, line?: number): void {
    const key = `${file}\0${line ?? ''}\0${category}\0${detail}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    const f: TestChangeFinding = { file, category, detail };
    if (line !== undefined) f.line = line;
    this.findings.push(f);
  }
  countFor(file: string): number {
    return this.findings.filter((f) => f.file === file).length;
  }
}

function lineNo(l: DiffLine): number | undefined {
  return l.kind === 'del' ? l.oldLine : l.newLine;
}

/** Annotates hunk lines with assertion flags (incl. `if … { t.Errorf }` guards) and setup/fixture regions. */
function annotate(hunk: DiffHunk, lang: Lang): LineInfo[] {
  const opened = newRegionLines(hunk, lang);
  const infos: LineInfo[] = hunk.lines.map((line) => {
    // an added line inside a new comment/string region is not code; a context line there was disabled
    const commentedOut = line.kind === 'add' && opened.has(line);
    const comment = commentedOut || isComment(line.text, lang);
    const code = comment ? '' : stripTrailingComment(line.text, lang);
    const masked = maskStrings(code);
    const blank = line.text.trim() === '';
    const info: LineInfo = { line, code, masked, comment, blank, assertion: !comment && matchesAny(ASSERT_RE[lang], masked), inSetup: false, inFixture: false };
    if (line.kind === 'ctx' && opened.has(line) && !comment && !blank) info.disabled = true;
    return info;
  });
  // guard-style assertions, evaluated separately on the old (ctx+del) and new (ctx+add) versions
  for (const version of ['del', 'add'] as const) {
    const seq = infos.filter((x) => x.line.kind === 'ctx' || x.line.kind === version).filter((x) => !x.blank && !x.comment);
    for (let k = 0; k < seq.length - 1; k++) {
      if (IF_RE.test(seq[k]!.masked) && FAIL_CALL_RE.test(seq[k + 1]!.masked)) seq[k]!.assertion = true;
    }
  }
  // regions: an opener (or the hunk's function context) opens a region for more-indented lines
  const setupRe = SETUP_OPENER_RE[lang];
  let setup: number | undefined;
  let fixture: number | undefined;
  let pendingFixture = false;
  const ctxMasked = maskStrings(hunk.context);
  if (setupRe && setupRe.test(ctxMasked)) setup = indentOf(hunk.context);
  if (FIXTURE_OPENER_RE.test(ctxMasked)) fixture = indentOf(hunk.context);
  for (const info of infos) {
    if (info.blank || info.comment) {
      info.inSetup = setup !== undefined;
      info.inFixture = fixture !== undefined;
      continue;
    }
    const ind = indentOf(info.line.text);
    if (setup !== undefined && ind <= setup) setup = undefined;
    if (fixture !== undefined && ind <= fixture) fixture = undefined;
    if (setupRe && setupRe.test(info.masked)) setup = ind;
    if (FIXTURE_OPENER_RE.test(info.masked)) {
      if (lang === 'py') pendingFixture = true;
      else fixture = ind;
    } else if (pendingFixture && /^\s*(?:async\s+)?def\s+/.test(info.masked)) {
      fixture = ind;
      pendingFixture = false;
    }
    info.inSetup = setup !== undefined;
    info.inFixture = fixture !== undefined;
  }
  // removed-test regions: a removed test definition followed by removed, more-indented lines (and its
  // closing line at the same indentation)
  let region: { indent: number; key: string } | undefined;
  for (const info of infos) {
    if (info.line.kind !== 'del') {
      if (!info.blank) region = undefined;
      continue;
    }
    if (info.blank || info.comment) {
      if (region) info.removedTest = region.key;
      continue;
    }
    const ind = indentOf(info.line.text);
    if (region) {
      if (ind > region.indent) {
        info.removedTest = region.key;
        continue;
      }
      if (ind === region.indent && CLOSER_RE.test(info.code)) {
        info.removedTest = region.key;
        region = undefined;
        continue;
      }
      region = undefined;
    }
    const name = testDefName(info.code, lang);
    if (name !== undefined) {
      region = { indent: ind, key: `${lang}:${name}` };
      info.removedTest = region.key;
    }
  }
  return infos;
}

interface Pair {
  del?: LineInfo;
  add?: LineInfo;
}

/** Pairs removed and added lines of one change block (identical skeleton first, then similarity ≥ 0.5). */
function pairBlock(dels: LineInfo[], adds: LineInfo[]): Pair[] {
  const pairs: Pair[] = [];
  const freeAdds = new Set(adds);
  const unpairedDels: LineInfo[] = [];
  for (const d of dels) {
    const sk = skeleton(d.code, true, true);
    const match = [...freeAdds].find((a) => skeleton(a.code, true, true) === sk);
    if (match) {
      freeAdds.delete(match);
      pairs.push({ del: d, add: match });
    } else unpairedDels.push(d);
  }
  const exhaustive = unpairedDels.length * freeAdds.size <= 40_000; // bound similarity pairing on huge blocks
  for (const d of unpairedDels) {
    if (!exhaustive) {
      pairs.push({ del: d });
      continue;
    }
    let best: LineInfo | undefined;
    let bestScore = 0.5;
    for (const a of freeAdds) {
      const s = similarity(d.code, a.code);
      if (s >= bestScore) {
        best = a;
        bestScore = s;
      }
    }
    if (best) {
      freeAdds.delete(best);
      pairs.push({ del: d, add: best });
    } else pairs.push({ del: d });
  }
  for (const a of adds) if (freeAdds.has(a)) pairs.push({ add: a });
  return pairs;
}

function onlyNumbersDiffer(a: string, b: string): boolean {
  return skeleton(a, false, true) === skeleton(b, false, true) && numbers(a).join(',') !== numbers(b).join(',');
}

function onlyStringsDiffer(a: string, b: string): boolean {
  return skeleton(a, true, false) === skeleton(b, true, false) && skeleton(a, false, false) !== skeleton(b, false, false);
}

/** True when every differing string literal between a and b sits inside a locator call. */
function differingStringsAreLocators(a: string, b: string, structuralOnly: boolean): boolean {
  const la = stringLiterals(a);
  const lb = stringLiterals(b);
  if (la.length !== lb.length) return false;
  let any = false;
  for (let k = 0; k < la.length; k++) {
    if (la[k]!.text === lb[k]!.text) continue;
    any = true;
    const prefix = a.slice(0, la[k]!.start);
    const structural = STRUCTURAL_LOCATOR_CALL_RE.test(prefix) || LOCATOR_ATTR_RE.test(la[k]!.text) || LOCATOR_ATTR_RE.test(lb[k]!.text);
    const text = !structuralOnly && TEXT_LOCATOR_CALL_RE.test(prefix);
    if (!structural && !text) return false;
  }
  return any;
}

interface FileContext {
  path: string;
  lang: Lang;
  base: BaseCategory;
  config: boolean;
  out: Collector;
  removedDefs: Map<string, number>;
  addedDefs: Map<string, number>;
  /**
   * Findings on lines of removed test bodies, resolved after the diff-wide accounting: for a really
   * deleted test only its removed assertions are reported (test_deleted covers the rest); otherwise a
   * line is reported unless the identical line is re-added somewhere in the diff (moved code).
   */
  pending: PendingFinding[];
  /** Diff-wide `${lang}:${codeKey}` of every added line. */
  addedKeys: Set<string>;
  /** Test definitions on context lines disabled by a new block comment / multi-line string. */
  disabledDefs: DisabledDef[];
}

interface DisabledDef {
  path: string;
  key: string;
  name: string;
  line?: number;
}

interface PendingFinding {
  key: string;
  codeKey: string;
  assertion: boolean;
  file: string;
  category: TestChangeCategory;
  detail: string;
  line?: number;
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function classifyPair(fc: FileContext, p: Pair): void {
  const { path, lang, base, out } = fc;
  const d = p.del;
  const a = p.add;
  const at = lineNo((a ?? d)!.line);

  if (d && a && codeKey(d.code, lang) === codeKey(a.code, lang)) return; // whitespace/comment-only change of the same code
  const single = d && !a ? d : a && !d ? a : undefined;
  if (single && CLOSER_RE.test(single.code)) return; // a lone closing bracket carries no test semantics
  if (d && !a && d.removedTest !== undefined && testDefName(d.code, lang) === undefined) {
    // body line of a removed test definition: resolved after the diff-wide deletion accounting
    const ln = lineNo(d.line);
    fc.pending.push({
      key: d.removedTest,
      codeKey: `${lang}:${codeKey(d.code, lang)}`,
      assertion: d.assertion,
      file: path,
      category: d.assertion ? 'assertion' : base,
      detail: d.assertion ? `assertion removed: ${norm(d.code)}` : `test code removed: ${norm(d.code)}`,
      ...(ln !== undefined ? { line: ln } : {}),
    });
    return;
  }
  const dDef = d ? testDefName(d.code, lang) : undefined;
  const aDef = a ? testDefName(a.code, lang) : undefined;
  if (d && !a && dDef !== undefined) return; // removed definition line: handled by deletion accounting
  if (d && a && dDef !== undefined && aDef !== undefined && dDef !== aDef) return; // renamed/replaced: accounting reports the old name

  // assertions (I8): removal or modification of what a test checks
  if (d?.assertion) {
    if (a?.assertion) {
      if (onlyNumbersDiffer(d.code, a.code)) {
        if (THRESHOLD_ASSERT_RE.test(d.masked) || THRESHOLD_ASSERT_RE.test(a.masked)) out.add(path, 'threshold', `threshold changed in assertion: ${norm(d.code)} → ${norm(a.code)}`, at);
        else out.add(path, 'assertion', `expected value changed: ${norm(d.code)} → ${norm(a.code)}`, at);
        return;
      }
      if (onlyStringsDiffer(d.code, a.code) && differingStringsAreLocators(d.code, a.code, true)) {
        out.add(path, 'locator', `selector changed inside assertion: ${norm(d.code)} → ${norm(a.code)}`, at);
        return;
      }
      out.add(path, 'assertion', norm(d.code) === norm(a.code) ? `assertion re-indented (control flow changed): ${norm(a.code)}` : `assertion modified: ${norm(d.code)} → ${norm(a.code)}`, at);
      return;
    }
    out.add(path, 'assertion', `assertion ${d.disabled ? 'disabled by a new block comment/string' : 'removed'}: ${norm(d.code)}`, lineNo(d.line));
    if (a) classifyPair(fc, { add: a });
    return;
  }
  if (!d && a?.assertion) {
    out.add(path, 'test_implementation', `assertion added: ${norm(a.code)}`, at);
    return;
  }
  if (!d && a && aDef !== undefined) {
    out.add(path, 'test_implementation', `test added: ${aDef}`, at);
    return;
  }
  if (d && a?.assertion) {
    out.add(path, 'test_implementation', `assertion added in place of: ${norm(d.code)}`, at);
    return;
  }

  const dc = d?.code ?? '';
  const ac = a?.code ?? '';
  const dm = d?.masked ?? '';
  const am = a?.masked ?? '';
  // test-level timeout argument on a test definition (`it('x', fn, 5000)`)
  if (d && a && dDef !== undefined && dDef === aDef && onlyNumbersDiffer(dc, ac)) {
    out.add(path, 'timeout', `test timeout changed: ${norm(dc)} → ${norm(ac)}`, at);
    return;
  }
  if (TIMEOUT_RE.test(dm) || TIMEOUT_RE.test(am)) {
    out.add(path, 'timeout', d && a ? `timeout/wait changed: ${norm(dc)} → ${norm(ac)}` : d ? `timeout/wait removed: ${norm(dc)}` : `timeout/wait added: ${norm(ac)}`, at);
    return;
  }
  if (d && a && onlyNumbersDiffer(dc, ac) && (THRESHOLD_NAME_RE.test(dm) || THRESHOLD_NAME_RE.test(am))) {
    out.add(path, 'threshold', `threshold constant changed: ${norm(dc)} → ${norm(ac)}`, at);
    return;
  }
  if (d && a && onlyStringsDiffer(dc, ac) && differingStringsAreLocators(dc, ac, false)) {
    out.add(path, 'locator', `locator changed: ${norm(dc)} → ${norm(ac)}`, at);
    return;
  }
  const setupRe = SETUP_OPENER_RE[lang];
  const inSetup = (d?.inSetup ?? false) || (a?.inSetup ?? false) || ENV_TOKEN_RE.test(dm) || ENV_TOKEN_RE.test(am) || (setupRe?.test(dm) ?? false) || (setupRe?.test(am) ?? false);
  if (inSetup) {
    out.add(path, 'environment_setup', `environment/setup change: ${norm(ac || dc)}`, at);
    return;
  }
  if ((d?.inFixture ?? false) || (a?.inFixture ?? false) || FIXTURE_OPENER_RE.test(dm) || FIXTURE_OPENER_RE.test(am)) {
    out.add(path, 'fixture', `fixture change: ${norm(ac || dc)}`, at);
    return;
  }
  if (RETRY_RE.test(dm) || RETRY_RE.test(am)) {
    out.add(path, 'test_implementation', `retry policy changed: ${norm(ac || dc)}`, at);
    return;
  }
  const verb = d && a ? 'changed' : d ? (d.disabled ? 'disabled by a new block comment/string' : 'removed') : 'added';
  out.add(path, base, `${base === 'fixture' ? 'fixture' : base === 'environment_setup' ? 'setup' : 'test code'} ${verb}: ${norm(ac || dc)}`, at);
}

const BRACE_LANGS: ReadonlySet<Lang> = new Set<Lang>(['js', 'go', 'other']);
const FUNCTION_LITERAL_BEFORE_BRACE_RE = /=>\s*$|\bfunction\b[^{]*$|\bfunc\b[^{]*$/;

/**
 * The kind of early exit a line performs on its enclosing function (`return`, `exit`, SkipNow) or loop
 * (`break`/`continue`), ignoring exits inside a function literal opened on the same line
 * (`.then((r) => { return r.json(); })`).
 */
function lineExit(masked: string, lang: Lang): 'function' | 'loop' | undefined {
  let kind: 'function' | 'loop' | undefined;
  for (const m of masked.matchAll(new RegExp(EXIT_RE.source, 'g'))) {
    if (BRACE_LANGS.has(lang)) {
      const stack: number[] = [];
      for (let k = 0; k < m.index!; k++) {
        if (masked[k] === '{') stack.push(k);
        else if (masked[k] === '}') stack.pop();
      }
      if (stack.some((open) => FUNCTION_LITERAL_BEFORE_BRACE_RE.test(masked.slice(0, open)))) continue;
    }
    if (/^(?:break|continue)$/.test(m[0])) kind ??= 'loop';
    else return 'function';
  }
  return kind;
}

/** Net brace delta of a masked code line, applied brace by brace through `step` (return false to stop). */
function eachBrace(masked: string, step: (delta: 1 | -1) => boolean | void): void {
  for (const ch of masked) {
    if (ch !== '{' && ch !== '}') continue;
    if (step(ch === '{' ? 1 : -1) === false) return;
  }
}

/** Indices (into `seq`, the new version's code lines) of the lines guarded by the new opener at `i`. */
function guardedRegion(seq: readonly LineInfo[], i: number, lang: Lang): number[] {
  const x = seq[i]!;
  const out: number[] = [];
  if (!BRACE_LANGS.has(lang)) {
    if (!/:\s*$/.test(x.masked.trimEnd())) return out; // one-line body (`if x: pass`) guards nothing below
    const ind = indentOf(x.line.text);
    for (let j = i + 1; j < seq.length && indentOf(seq[j]!.line.text) > ind; j++) out.push(j);
    return out;
  }
  let depth = 0;
  eachBrace(x.masked, (d) => {
    depth += d;
  });
  if (depth <= 0) {
    // brace-less body: the next statement belongs to an incomplete opener, whatever its indentation
    if (/(?:\)|\belse|\bdo|=>)\s*$/.test(x.masked.trimEnd()) && i + 1 < seq.length) out.push(i + 1);
    return out;
  }
  for (let j = i + 1; j < seq.length && depth > 0; j++) {
    out.push(j);
    eachBrace(seq[j]!.masked, (d) => {
      depth += d;
    });
  }
  return out;
}

/**
 * Indices of the lines made (conditionally) dead by a new early exit at `i`: the rest of the enclosing
 * function, escaping enclosing if/loop blocks, skipping sibling branches (`else`, `catch`, `finally`), and
 * stopping at the end of a callback or at the next test/suite/function scope.
 */
function deadAfterExit(seq: readonly LineInfo[], i: number, lang: Lang, scopeStart: (y: LineInfo) => boolean, kind: 'function' | 'loop'): number[] {
  const out: number[] = [];
  const x = seq[i]!;
  if (!BRACE_LANGS.has(lang)) {
    const ind = indentOf(x.line.text);
    if (kind === 'loop') {
      // break/continue: the rest of the current block (the enclosing loop is not known reliably)
      for (let j = i + 1; j < seq.length && indentOf(seq[j]!.line.text) >= ind; j++) out.push(j);
      return out;
    }
    let floor = ind;
    let defIndent: number | undefined;
    for (let k = i - 1; k >= 0; k--) {
      const yk = indentOf(seq[k]!.line.text);
      if (yk >= floor) continue;
      if (/^\s*(?:async\s+)?def\s+|\blambda\b/.test(seq[k]!.masked)) {
        defIndent = yk;
        break;
      }
      floor = yk;
    }
    const min = defIndent !== undefined ? defIndent + 1 : floor;
    let sibling: number | undefined;
    for (let j = i + 1; j < seq.length; j++) {
      const y = seq[j]!;
      const yi = indentOf(y.line.text);
      if (yi < min) break;
      if (sibling !== undefined) {
        if (yi > sibling) continue;
        sibling = undefined;
      }
      if (yi < ind && /^\s*(?:else|elif|except|finally)\b/.test(y.masked)) {
        sibling = yi;
        continue;
      }
      out.push(j);
    }
    return out;
  }
  let depth = 0;
  eachBrace(x.masked, (d) => {
    depth = Math.max(0, depth + d);
  });
  let sibling = 0;
  for (let j = i + 1; j < seq.length; j++) {
    const y = seq[j]!;
    if (sibling > 0) {
      eachBrace(y.masked, (d) => {
        sibling += d;
      });
      continue;
    }
    if (depth <= 0 && (scopeStart(y) || /^\s*(?:case\b|default\s*:)/.test(y.masked))) break;
    let escaped = false;
    let stop = false;
    eachBrace(y.masked, (d) => {
      depth += d;
      if (depth < 0) {
        // the end of a callback, or (for break/continue) of the current block, ends the dead region
        if (CALLBACK_END_RE.test(y.masked) || kind === 'loop') {
          stop = true;
          return false;
        }
        depth = 0;
        escaped = true;
      }
      return true;
    });
    if (stop) break;
    if (escaped && depth > 0) {
      // `} else {` / `} catch (e) {`: a sibling branch is not made dead by the exit
      sibling = depth;
      depth = 0;
      continue;
    }
    out.push(j);
  }
  return out;
}

function analyzeCodeFile(fc: FileContext, file: DiffFile): void {
  const { path, lang, out } = fc;
  const removedSet = new Set<string>();
  const addedSet = new Set<string>();
  const hunks = file.hunks.map((h) => annotate(h, lang));
  for (const infos of hunks) {
    for (const x of infos) {
      if (x.blank || x.comment) continue;
      if (x.line.kind === 'del' || x.disabled) removedSet.add(codeKey(x.code, lang));
      if (x.line.kind === 'add') {
        addedSet.add(codeKey(x.code, lang));
        fc.addedKeys.add(`${lang}:${codeKey(x.code, lang)}`);
      }
    }
  }

  const handled = new Set<LineInfo>();
  for (let h = 0; h < hunks.length; h++) {
    const infos = hunks[h]!;
    const hunkContext = file.hunks[h]!.context;
    // forbidden patterns on added lines (skip markers, swallowed exceptions, build-ignore tags)
    const added = infos.filter((x) => x.line.kind === 'add');
    for (let k = 0; k < added.length; k++) {
      const x = added[k]!;
      const at = x.line.newLine;
      if (lang === 'go' && GO_BUILD_IGNORE_RE.test(x.line.text)) out.add(path, 'test_skipped', `build constraint excludes the test file: ${norm(x.line.text)}`, at);
      if (x.blank || x.comment) continue;
      if (removedSet.has(codeKey(x.code, lang))) continue; // moved, not new
      if (matchesAny(SKIP_RE[lang], x.masked) || (fc.config && matchesAny(CONFIG_SKIP_RE, x.masked))) {
        out.add(path, 'test_skipped', `skip/focus marker added: ${norm(x.code)}`, at);
        handled.add(x);
      }
      if (matchesAny(SWALLOW_SAME_LINE[lang], x.masked)) {
        out.add(path, 'exception_swallowed', `exception swallowed: ${norm(x.code)}`, at);
        handled.add(x);
      } else {
        const opener = SWALLOW_OPENER[lang];
        const body = SWALLOW_BODY[lang];
        if (opener && body && opener.test(x.masked)) {
          const next = added.slice(k + 1).find((y) => !y.blank && !y.comment);
          if (next && body.test(next.masked)) {
            out.add(path, 'exception_swallowed', `empty exception handler: ${norm(x.code)} ${norm(next.code)}`, at);
            handled.add(x);
            handled.add(next);
          }
        }
      }
    }
    // existing assertions newly guarded by control flow (dead branch, uncalled function/closure, deferred
    // callback) or placed after a new early exit are assertion changes. Regions follow braces (JS/Go) or
    // indentation (Python), so re-formatting or padding cannot move an assertion out of the scan.
    const newVersion = infos.filter((x) => (x.line.kind === 'ctx' || x.line.kind === 'add') && !x.blank && !x.comment);
    const setupRe = SETUP_OPENER_RE[lang];
    const scopeStart = (y: LineInfo) =>
      testDefName(y.code, lang) !== undefined || SUITE_RE.test(y.masked) || (setupRe?.test(y.masked) ?? false) || SCOPE_START_RE.test(y.masked);
    for (let i = 0; i < newVersion.length; i++) {
      const x = newVersion[i]!;
      if (x.line.kind !== 'add' || x.assertion) continue;
      const exitKind = lineExit(x.masked, lang);
      const exits = exitKind !== undefined;
      const wrapper = WRAPPER_RE[lang];
      const guards =
        !exits &&
        (CONTROL_RE.test(x.masked) || (wrapper?.test(x.masked) ?? false)) &&
        testDefName(x.code, lang) === undefined &&
        !SUITE_RE.test(x.masked) &&
        !(setupRe?.test(x.masked) ?? false);
      if (!exits && !guards) continue;
      // a moved opener/exit only counts for code that did not move with it
      const moved = removedSet.has(codeKey(x.code, lang));
      const region = exitKind !== undefined ? deadAfterExit(newVersion, i, lang, scopeStart, exitKind) : guardedRegion(newVersion, i, lang);
      for (const j of region) {
        const y = newVersion[j]!;
        const preexisting = y.line.kind === 'ctx' || (!moved && removedSet.has(codeKey(y.code, lang)));
        if (y.assertion && preexisting) {
          out.add(path, 'assertion', `existing assertion ${exits ? 'bypassed by a new early exit' : 'wrapped in new control flow'}: ${norm(x.code)} … ${norm(y.code)}`, x.line.newLine);
          handled.add(x);
          break;
        }
      }
    }
    // python collection hooks can rewrite the collected test set
    if (lang === 'py') {
      const hookContext = COLLECTION_HOOK_RE.test(maskStrings(hunkContext));
      for (const x of infos) {
        if (x.line.kind === 'ctx' || x.blank || x.comment) continue;
        if (COLLECTION_HOOK_RE.test(x.masked) || hookContext) {
          out.add(path, 'unknown', `test collection hook changed (can deselect tests): ${norm(x.code)}`, lineNo(x.line));
          handled.add(x);
        }
      }
    }
    // runner configuration: changes to test selection can silently drop tests
    if (fc.config) {
      for (const x of infos) {
        if (x.line.kind === 'ctx' || x.blank || x.comment || handled.has(x)) continue;
        if (CONFIG_SELECTION_RE.test(x.masked) && !(x.line.kind === 'add' ? removedSet : addedSet).has(codeKey(x.code, lang))) {
          out.add(path, 'unknown', `test selection ${x.line.kind === 'add' ? 'added/changed' : 'removed'} in runner configuration: ${norm(x.code)}`, lineNo(x.line));
        }
      }
    }
    // context lines disabled by a new block comment / multi-line string are removals
    for (const x of infos) {
      if (!x.disabled) continue;
      const name = testDefName(x.code, lang);
      if (name !== undefined) {
        bump(fc.removedDefs, `${lang}:${name}`);
        fc.disabledDefs.push({ path, key: `${lang}:${name}`, name, ...(x.line.newLine !== undefined ? { line: x.line.newLine } : {}) });
        continue;
      }
      if (addedSet.has(codeKey(x.code, lang))) continue; // re-added as live code elsewhere (moved)
      classifyPair(fc, { del: x });
    }
    // test definitions (for diff-wide deletion accounting); commented-out definitions do not count
    for (const x of infos) {
      if (x.blank || x.comment || x.line.kind === 'ctx') continue;
      const name = testDefName(x.code, lang);
      if (name === undefined) continue;
      bump(x.line.kind === 'del' ? fc.removedDefs : fc.addedDefs, `${lang}:${name}`);
    }
    // change blocks
    let k = 0;
    while (k < infos.length) {
      if (infos[k]!.line.kind === 'ctx') {
        k++;
        continue;
      }
      const block: LineInfo[] = [];
      while (k < infos.length && infos[k]!.line.kind !== 'ctx') block.push(infos[k++]!);
      const relevant = (x: LineInfo) => !x.blank && !x.comment;
      const dels = block.filter((x) => x.line.kind === 'del' && relevant(x) && !addedSet.has(codeKey(x.code, lang)));
      const adds = block.filter((x) => x.line.kind === 'add' && relevant(x) && !removedSet.has(codeKey(x.code, lang)));
      for (const p of pairBlock(dels, adds)) {
        if (p.add && handled.has(p.add) && !p.del?.assertion) continue;
        classifyPair(fc, p);
      }
    }
  }
}

function classifyDataFile(path: string, out: Collector, verb: string, base: BaseCategory): void {
  if (EXPECTED_DATA_RE.test(path)) out.add(path, 'assertion', `expected-output data ${verb}`);
  else out.add(path, base, `${base === 'fixture' ? 'fixture data' : base === 'environment_setup' ? 'test environment configuration' : 'test data'} ${verb}`);
}

export function classifyTestChange(diff: string, options: ClassifyOptions = {}): TestChangeClassification {
  const patterns = options.testPathPatterns ?? DEFAULT_TEST_PATH_PATTERNS;
  const out = new Collector();
  const files = parseUnifiedDiff(diff);
  if (files.length === 0 && diff.trim() !== '') {
    out.add('', 'unknown', 'input is not a parseable unified diff');
  }

  const isSnapshot = (p: string) => anyGlob(SNAPSHOT_PATH_PATTERNS, p);
  const isConfig = (p: string) => anyGlob(TEST_CONFIG_PATTERNS, p);
  const isTest = (p: string) => anyGlob(patterns, p) || isSnapshot(p) || isConfig(p);
  const baseOf = (p: string): BaseCategory => (anyGlob(FIXTURE_PATH_PATTERNS, p) ? 'fixture' : isConfig(p) || anyGlob(ENV_FILE_PATTERNS, p) ? 'environment_setup' : 'test_implementation');

  const removedDefs = new Map<string, number>();
  const addedDefs = new Map<string, number>();
  const pending: PendingFinding[] = [];
  const addedKeys = new Set<string>();
  const fallbacks: Array<{ path: string; category: TestChangeCategory; detail: string; line: number | undefined }> = [];
  const deletedTestFiles: Array<{ path: string; defs: string[] }> = [];
  const disabledDefs: DisabledDef[] = [];

  for (const f of files) {
    const oldTest = f.oldPath !== null && isTest(f.oldPath);
    const newTest = f.newPath !== null && isTest(f.newPath);
    const path = (f.newPath ?? f.oldPath)!;
    const firstLine = f.hunks[0]?.lines.find((l) => l.kind !== 'ctx');
    const first = firstLine ? lineNo(firstLine) : undefined;
    // a malformed section could be applied differently from how it was classified: never auto-allow it
    for (const m of f.issues ?? []) out.add(path, 'unknown', `malformed diff: ${m}`);

    // product code touched (old or new side outside the test patterns)
    if ((f.oldPath !== null && !oldTest) || (f.newPath !== null && !newTest)) {
      const productPath = f.newPath !== null && !newTest ? f.newPath : f.oldPath!;
      out.add(productPath, 'product_code', `product file ${f.status}${f.status === 'renamed' ? ` (${f.oldPath} → ${f.newPath})` : ''}`, first);
    }
    if (!oldTest && !newTest) continue;

    if (f.status === 'renamed' && oldTest && !newTest) {
      out.add(f.oldPath!, 'test_deleted', `test file moved out of the test patterns: ${f.oldPath} → ${f.newPath}`);
      continue;
    }
    const testPath = newTest ? f.newPath! : f.oldPath!;
    const lang = langOf(testPath);
    const base = baseOf(testPath);

    if (isSnapshot(testPath)) {
      out.add(testPath, 'assertion', `snapshot/golden baseline ${f.status}`, first);
      continue;
    }
    if (f.binary) {
      if (base === 'fixture') out.add(testPath, 'fixture', `binary fixture ${f.status}`);
      else out.add(testPath, 'unknown', `binary test file ${f.status}`);
      continue;
    }
    if (lang === 'data') {
      const verb = f.status === 'deleted' ? 'deleted' : f.status === 'added' ? 'added' : 'changed';
      if (isConfig(testPath)) {
        // config files: scan for exclusion/skip/timeout keys, else environment setup
        const before = out.countFor(testPath);
        for (const h of f.hunks) {
          for (const l of h.lines) {
            if (l.kind === 'ctx' || l.text.trim() === '' || /^\s*[#;]/.test(l.text)) continue;
            if (l.kind === 'add' && matchesAny(CONFIG_SKIP_RE, l.text)) out.add(testPath, 'test_skipped', `test exclusion added to configuration: ${norm(l.text)}`, l.newLine);
            else if (CONFIG_SELECTION_RE.test(l.text)) out.add(testPath, 'unknown', `test selection ${l.kind === 'add' ? 'added/changed' : 'removed'} in runner configuration: ${norm(l.text)}`, lineNo(l));
            else if (TIMEOUT_RE.test(l.text)) out.add(testPath, 'timeout', `timeout configuration ${l.kind === 'add' ? 'added/changed' : 'removed'}: ${norm(l.text)}`, lineNo(l));
          }
        }
        if (out.countFor(testPath) === before) classifyDataFile(testPath, out, verb, 'environment_setup');
      } else classifyDataFile(testPath, out, verb, base);
      continue;
    }

    const fc: FileContext = { path: testPath, lang, base, config: isConfig(testPath), out, removedDefs, addedDefs, pending, addedKeys, disabledDefs };
    const before = out.countFor(testPath);
    if (f.status === 'deleted') {
      const defs: string[] = [];
      for (const h of f.hunks) for (const l of h.lines) {
        if (l.kind !== 'del' || isComment(l.text, lang)) continue;
        const name = testDefName(stripTrailingComment(l.text, lang), lang);
        if (name !== undefined) {
          defs.push(`${lang}:${name}`);
          bump(removedDefs, `${lang}:${name}`);
        }
      }
      if (base === 'test_implementation') deletedTestFiles.push({ path: testPath, defs });
      else out.add(testPath, base, `${base === 'fixture' ? 'fixture' : 'setup'} file deleted`);
      continue;
    }
    analyzeCodeFile(fc, f);
    if (out.countFor(testPath) === before) {
      fallbacks.push({ path: testPath, category: f.status === 'renamed' ? 'test_implementation' : base, detail: f.status === 'renamed' ? `test file renamed: ${f.oldPath} → ${f.newPath}` : 'no test-semantic change (formatting, comments or code moved elsewhere)', line: first });
    }
  }

  // diff-wide test deletion accounting: a removed test definition not re-added anywhere is a deletion
  const netDeleted = new Set<string>();
  for (const [name, n] of removedDefs) if (n > (addedDefs.get(name) ?? 0)) netDeleted.add(name);
  for (const d of deletedTestFiles) {
    const lost = d.defs.filter((n) => netDeleted.has(n));
    if (d.defs.length === 0 || lost.length > 0) out.add(d.path, 'test_deleted', `test file deleted${lost.length ? ` (${lost.map((n) => n.slice(n.indexOf(':') + 1)).join(', ')})` : ''}`);
    else out.add(d.path, 'test_implementation', 'test file deleted; all its tests are re-added elsewhere in this change');
  }
  for (const f of files) {
    if (f.status === 'deleted') continue;
    const path = (f.newPath ?? f.oldPath)!;
    if (!isTest(path)) continue;
    const lang = langOf(path);
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.kind !== 'del' || isComment(l.text, lang)) continue;
      const name = testDefName(stripTrailingComment(l.text, lang), lang);
      if (name !== undefined && netDeleted.has(`${lang}:${name}`)) out.add(path, 'test_deleted', `test removed: ${name}`, l.oldLine);
    }
  }
  for (const d of disabledDefs) {
    if (netDeleted.has(d.key)) out.add(d.path, 'test_deleted', `test disabled by a new block comment/string: ${d.name}`, d.line);
  }

  for (const p of pending) {
    const keep = netDeleted.has(p.key) ? p.assertion : !addedKeys.has(p.codeKey);
    if (keep) out.add(p.file, p.category, p.detail, p.line);
  }
  // every changed test file gets at least one finding
  for (const fb of fallbacks) if (out.countFor(fb.path) === 0) out.add(fb.path, fb.category, fb.detail, fb.line);

  const findings = [...out.findings];
  const categories = CATEGORY_ORDER.filter((c) => findings.some((f) => f.category === c));
  let decision: SelfHealDecision = 'auto_allowed';
  for (const c of categories) {
    const d = categoryDecision(c, options.productFixAuthorized === true);
    if (DECISION_RANK[d] > DECISION_RANK[decision]) decision = d;
  }
  return { decision, categories, findings };
}
