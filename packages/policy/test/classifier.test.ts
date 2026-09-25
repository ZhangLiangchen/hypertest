import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { createGitRepo } from '@hypertest/testkit';
import { categoryDecision, classifyTestChange, parseUnifiedDiff, type TestChangeCategory } from '../src/index.ts';

/** Builds one git-format file diff; hunk counts are computed from the body lines (' ', '-', '+'). */
function fd(path: string, body: string[], opts: { start?: number; context?: string; status?: 'added' | 'deleted'; oldPath?: string } = {}): string {
  const start = opts.start ?? 1;
  const oldCount = body.filter((l) => l[0] === ' ' || l[0] === '-').length;
  const newCount = body.filter((l) => l[0] === ' ' || l[0] === '+').length;
  const oldPath = opts.oldPath ?? path;
  const head = [`diff --git a/${oldPath} b/${path}`];
  if (opts.status === 'added') head.push('new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`);
  else if (opts.status === 'deleted') head.push('deleted file mode 100644', 'index 1111111..0000000', `--- a/${oldPath}`, '+++ /dev/null');
  else head.push('index 1111111..2222222 100644', `--- a/${oldPath}`, `+++ b/${path}`);
  const oldStart = opts.status === 'added' ? 0 : start;
  const newStart = opts.status === 'deleted' ? 0 : start;
  head.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${opts.context ? ` ${opts.context}` : ''}`);
  return [...head, ...body].join('\n') + '\n';
}

function expectCategories(diff: string, categories: TestChangeCategory[], decision: string, options = {}) {
  const r = classifyTestChange(diff, options);
  assert.deepEqual(r.categories, categories, JSON.stringify(r.findings, null, 1));
  assert.equal(r.decision, decision);
  return r;
}

// ============================================================================ JS / TS

test('js: changed expected value in an assertion ⇒ assertion (approval_required)', () => {
  const r = expectCategories(fd('src/cart.test.ts', ["   it('computes total', () => {", '-    expect(cart.total()).toBe(5);', '+    expect(cart.total()).toBe(6);', '   });'], { start: 10 }), ['assertion'], 'approval_required');
  assert.equal(r.findings[0]!.line, 11);
  assert.equal(r.findings[0]!.file, 'src/cart.test.ts');
});

test('js: assertion removed ⇒ assertion', () => {
  expectCategories(fd('src/cart.test.ts', ["   it('computes total', () => {", '     cart.add(item);', '-    expect(cart.total()).toBe(5);', '   });']), ['assertion'], 'approval_required');
});

test('js: assertion commented out ⇒ assertion', () => {
  expectCategories(fd('src/cart.test.ts', ['-    expect(cart.total()).toBe(5);', '+    // expect(cart.total()).toBe(5);']), ['assertion'], 'approval_required');
});

test('js: assertion weakened to a broader matcher ⇒ assertion', () => {
  expectCategories(fd('api/orders.spec.ts', ['-    expect(res.status).toBe(201);', '+    expect([201, 500]).toContain(res.status);']), ['assertion'], 'approval_required');
});

test('js: numeric threshold in a comparison assertion ⇒ threshold', () => {
  const r = expectCategories(fd('perf/latency.test.ts', ['-    expect(p95).toBeLessThan(200);', '+    expect(p95).toBeLessThan(500);']), ['threshold'], 'approval_required');
  assert.match(r.findings[0]!.detail, /toBeLessThan\(200\).*toBeLessThan\(500\)/);
});

test('js: threshold constant in test code ⇒ threshold', () => {
  expectCategories(fd('perf/latency.test.ts', ['-const MAX_LATENCY_MS = 200;', '+const MAX_LATENCY_MS = 500;']), ['threshold'], 'approval_required');
});

test('js: skip markers ⇒ test_skipped (forbidden)', () => {
  for (const [from, to] of [
    ["  it('pays', async () => {", "  it.skip('pays', async () => {"],
    ["  it('pays', async () => {", "  xit('pays', async () => {"],
    ["  describe('payments', () => {", "  describe.skip('payments', () => {"],
    ["  it('pays', async () => {", "  it.only('pays', async () => {"],
    ["  test('pays', async () => {", "  test('pays', { skip: 'flaky on CI' }, async () => {"],
    ["  it('pays', async () => {", "  it.todo('pays', async () => {"],
  ] as const) {
    const r = expectCategories(fd('src/pay.test.ts', [`-${from}`, `+${to}`, '     await pay();']), ['test_skipped'], 'forbidden');
    assert.match(r.findings[0]!.detail, /skip\/focus marker added/);
  }
});

test('js: pagination options named skip are not skip markers', () => {
  expectCategories(fd('src/repo.test.ts', ['-    const rows = await repo.find({ take: 5 });', '+    const rows = await repo.find({ skip: 10, take: 5 });']), ['test_implementation'], 'conditional');
});

test('js: t.skip() inside a node:test test ⇒ test_skipped', () => {
  expectCategories(fd('test/pay.test.ts', ["   test('pays', async (t) => {", "+    t.skip('broken');", '     await pay();']), ['test_skipped'], 'forbidden');
});

test('js: a deleted test case ⇒ test_deleted', () => {
  const r = expectCategories(
    fd('src/pay.test.ts', ["   it('pays', async () => {", '     expect(await pay()).toBe(true);', '   });', "-  it('refunds', async () => {", '-    expect(await refund()).toBe(true);', '-  });']),
    ['assertion', 'test_deleted'],
    'forbidden',
  );
  assert.ok(r.findings.some((f) => f.category === 'test_deleted' && f.detail === 'test removed: refunds'));
});

test('js: renaming a test title counts as deleting the old test (conservative)', () => {
  expectCategories(fd('src/pay.test.ts', ["-  it('refunds', async () => {", "+  it('refunds the order', async () => {", '     await refund();']), ['test_deleted'], 'forbidden');
});

test('js: a test moved to another file is not a deletion', () => {
  const diff =
    fd('src/pay.test.ts', ["   it('pays', () => {});", "-  it('refunds', () => {", '-    refund();', '-  });']) +
    fd('src/refund.test.ts', ["+it('refunds', () => {", '+  refund();', '+});'], { status: 'added' });
  const r = classifyTestChange(diff);
  assert.equal(r.categories.includes('test_deleted'), false, JSON.stringify(r.findings));
  assert.equal(r.decision, 'conditional');
});

test('js: whole test file deleted ⇒ test_deleted', () => {
  const r = expectCategories(fd('src/pay.test.ts', ["-import { pay } from './pay';", "-it('pays', () => {", '-  expect(pay()).toBe(true);', '-});'], { status: 'deleted' }), ['test_deleted'], 'forbidden');
  assert.equal(r.findings[0]!.detail, 'test file deleted (pays)');
});

test('js: test file split into two files (all tests re-added) ⇒ not a deletion', () => {
  const diff =
    fd('src/all.test.ts', ["-it('a', () => {});", "-it('b', () => {});"], { status: 'deleted' }) +
    fd('src/a.test.ts', ["+it('a', () => {});"], { status: 'added' }) +
    fd('src/b.test.ts', ["+it('b', () => {});"], { status: 'added' });
  expectCategories(diff, ['test_implementation'], 'conditional');
});

test('test file renamed out of the test patterns ⇒ test_deleted', () => {
  const diff = 'diff --git a/tests/test_pay.py b/attic/pay_old.py\nsimilarity index 100%\nrename from tests/test_pay.py\nrename to attic/pay_old.py\n';
  const r = expectCategories(diff, ['product_code', 'test_deleted'], 'forbidden');
  assert.ok(r.findings.some((f) => f.file === 'tests/test_pay.py' && f.category === 'test_deleted' && /moved out of the test patterns/.test(f.detail)));
  // a rename that keeps the test patterns (even an odd suffix) is still a test file
  expectCategories('diff --git a/src/pay.test.ts b/src/pay.test.ts.bak\nsimilarity index 100%\nrename from src/pay.test.ts\nrename to src/pay.test.ts.bak\n', ['test_implementation'], 'conditional');
});

test('js: swallowed exceptions ⇒ exception_swallowed', () => {
  for (const body of [
    ['   try {', '     await pay();', '-  } finally {', '+  } catch (e) {}'],
    ['-    await pay();', '+    await pay().catch(() => {});'],
    ['   try {', '     await pay();', '+  } catch (err) {', '+  }'],
    ['   try {', '     await pay();', '+  } catch {', '+    // ignore', '+  }'],
  ]) {
    const r = classifyTestChange(fd('src/pay.test.ts', body));
    assert.ok(r.categories.includes('exception_swallowed'), JSON.stringify({ body, r }));
    assert.equal(r.decision, 'forbidden');
  }
});

test('js: structural locator change ⇒ locator (auto_allowed)', () => {
  expectCategories(
    fd('e2e/login.spec.ts', ["   await page.goto('/login');", "-  await page.locator('#user').fill('alice');", "+  await page.locator('[data-testid=\"username\"]').fill('alice');"]),
    ['locator'],
    'auto_allowed',
  );
  expectCategories(fd('e2e/login.spec.ts', ["-  await page.click('#submit');", "+  await page.click('button[type=submit]');"]), ['locator'], 'auto_allowed');
  expectCategories(fd('e2e/login.spec.ts', ["-  cy.get('.btn-primary').click();", "+  cy.get('[data-cy=submit]').click();"]), ['locator'], 'auto_allowed');
});

test('js: structural selector inside an assertion ⇒ locator; asserted text inside an assertion ⇒ assertion', () => {
  expectCategories(fd('e2e/cart.spec.ts', ["-  await expect(page.getByTestId('total')).toBeVisible();", "+  await expect(page.getByTestId('order-total')).toBeVisible();"]), ['locator'], 'auto_allowed');
  expectCategories(fd('e2e/cart.spec.ts', ["-  await expect(page.getByText('Total: 5')).toBeVisible();", "+  await expect(page.getByText('Total: 6')).toBeVisible();"]), ['assertion'], 'approval_required');
  expectCategories(fd('e2e/cart.spec.ts', ["-  await expect(page.locator('#total')).toHaveText('5');", "+  await expect(page.locator('#total')).toHaveText('6');"]), ['assertion'], 'approval_required');
});

test('js: text locator in an action ⇒ locator', () => {
  expectCategories(fd('e2e/cart.spec.ts', ["-  await page.getByRole('button', { name: 'Checkout' }).click();", "+  await page.getByRole('button', { name: 'Proceed to checkout' }).click();"]), ['locator'], 'auto_allowed');
});

test('js: beforeEach / env changes ⇒ environment_setup (auto_allowed)', () => {
  expectCategories(fd('src/db.test.ts', ['   beforeEach(async () => {', "-    await db.connect('postgres://localhost/test');", "+    await db.connect('postgres://127.0.0.1:5433/test');", '   });']), ['environment_setup'], 'auto_allowed');
  expectCategories(fd('src/db.test.ts', ['-    await db.migrate();', '+    await db.migrate({ seed: true });'], { context: 'beforeAll(async () => {' }), ['environment_setup'], 'auto_allowed');
  expectCategories(fd('src/db.test.ts', ["-process.env.API_URL = 'http://localhost:3000';", "+process.env.API_URL = 'http://127.0.0.1:3000';"]), ['environment_setup'], 'auto_allowed');
});

test('js: timeouts ⇒ timeout (conditional)', () => {
  expectCategories(fd('src/slow.test.ts', ['-jest.setTimeout(5000);', '+jest.setTimeout(30000);']), ['timeout'], 'conditional');
  expectCategories(fd('src/slow.test.ts', ["-  it('syncs', async () => { await sync(); }, 5000);", "+  it('syncs', async () => { await sync(); }, 20000);"]), ['timeout'], 'conditional');
  expectCategories(fd('e2e/slow.spec.ts', ['-  await page.waitForTimeout(100);', '+  await page.waitForTimeout(1000);']), ['timeout'], 'conditional');
});

test('js: strings mentioning timeouts do not count as timeout changes', () => {
  expectCategories(fd('src/slow.test.ts', ["-  log('waiting for timeout');", "+  log('waiting until timeout');"]), ['test_implementation'], 'conditional');
});

test('js: retries and helper changes ⇒ test_implementation (conditional)', () => {
  const r = expectCategories(fd('src/flaky.test.ts', ['+jest.retryTimes(3);', ' ', " describe('x', () => {"]), ['test_implementation'], 'conditional');
  assert.match(r.findings[0]!.detail, /retry policy/);
  expectCategories(fd('src/cart.test.ts', ['-function makeCart() { return new Cart(); }', '+function makeCart() { return new Cart({ currency: "EUR" }); }']), ['test_implementation'], 'conditional');
});

test('js: an added assertion is a test implementation change', () => {
  expectCategories(fd('src/cart.test.ts', ['     expect(cart.total()).toBe(5);', '+    expect(cart.items()).toHaveLength(1);']), ['test_implementation'], 'conditional');
});

test('js: comment- or whitespace-only change ⇒ test_implementation (formatting)', () => {
  const r = expectCategories(fd('src/cart.test.ts', ['+// covers the discount path', '     expect(cart.total()).toBe(5);']), ['test_implementation'], 'conditional');
  assert.equal(r.findings[0]!.detail, 'no test-semantic change (formatting, comments or code moved elsewhere)');
  expectCategories(fd('src/cart.test.ts', ['-    expect(cart.total()).toBe(5);', '+    expect( cart.total() ).toBe(5);']), ['test_implementation'], 'conditional');
});

test('js: new test file ⇒ test_implementation; new test file with a skip ⇒ forbidden', () => {
  expectCategories(fd('src/new.test.ts', ["+import { f } from './f';", "+it('f works', () => {", '+  expect(f()).toBe(1);', '+});'], { status: 'added' }), ['test_implementation'], 'conditional');
  expectCategories(fd('src/new.test.ts', ["+it.skip('f works', () => {", '+  expect(f()).toBe(1);', '+});'], { status: 'added' }), ['test_implementation', 'test_skipped'], 'forbidden');
});

test('js/ts config: exclusions ⇒ test_skipped; timeouts ⇒ timeout', () => {
  expectCategories(fd('jest.config.js', ['   testEnvironment: "node",', "+  testPathIgnorePatterns: ['payments'],"]), ['test_skipped'], 'forbidden');
  expectCategories(fd('vitest.config.ts', ['-    testTimeout: 5000,', '+    testTimeout: 60000,']), ['timeout'], 'conditional');
  expectCategories(fd('playwright.config.ts', ["-  reporter: 'list',", "+  reporter: 'html',"]), ['environment_setup'], 'auto_allowed');
});

test('fixtures, expected data and snapshots', () => {
  expectCategories(fd('test/fixtures/users.json', ['-  { "name": "alice" }', '+  { "name": "alice", "tier": "gold" }']), ['fixture'], 'conditional');
  expectCategories(fd('tests/expected/order_response.json', ['-  "total": 5', '+  "total": 6']), ['assertion'], 'approval_required');
  expectCategories(fd('src/__snapshots__/cart.test.ts.snap', ['-exports[`cart 1`] = `5`;', '+exports[`cart 1`] = `6`;']), ['assertion'], 'approval_required');
  const bin = 'diff --git a/tests/fixtures/logo.png b/tests/fixtures/logo.png\nindex 1..2 100644\nBinary files a/tests/fixtures/logo.png and b/tests/fixtures/logo.png differ\n';
  expectCategories(bin, ['fixture'], 'conditional');
});

// ============================================================================ product code

test('product code ⇒ forbidden, or approval_required with productFixAuthorized', () => {
  const diff = fd('src/cart.ts', ['-  return items.reduce((a, b) => a + b.price, 0);', '+  return items.reduce((a, b) => a + b.price * b.qty, 0);']);
  expectCategories(diff, ['product_code'], 'forbidden');
  expectCategories(diff, ['product_code'], 'approval_required', { productFixAuthorized: true });
});

test('custom test path patterns replace the defaults', () => {
  const diff = fd('checks/cart_check.ts', ['-  expect(total).toBe(5);', '+  expect(total).toBe(6);']);
  expectCategories(diff, ['product_code'], 'forbidden');
  expectCategories(diff, ['assertion'], 'approval_required', { testPathPatterns: ['checks/**'] });
});

test('mixed diff: most restrictive decision wins and categories are reported in stable order', () => {
  const diff =
    fd('e2e/login.spec.ts', ["-  await page.locator('#user').fill('a');", "+  await page.locator('#username').fill('a');"]) +
    fd('src/cart.test.ts', ['-    expect(total).toBe(5);', '+    expect(total).toBe(6);']) +
    fd('test/fixtures/cart.json', ['-{"qty": 1}', '+{"qty": 2}']);
  const r = expectCategories(diff, ['locator', 'fixture', 'assertion'], 'approval_required');
  assert.deepEqual(r.findings.map((f) => f.file), ['e2e/login.spec.ts', 'src/cart.test.ts', 'test/fixtures/cart.json']);
});

// ============================================================================ Python

test('py: assertion value change ⇒ assertion; comparison threshold ⇒ threshold', () => {
  expectCategories(fd('tests/test_cart.py', ['-    assert cart.total() == 5', '+    assert cart.total() == 6'], { context: 'def test_total(cart):' }), ['assertion'], 'approval_required');
  expectCategories(fd('tests/test_api.py', ['-    assert r.elapsed_ms < 200', '+    assert r.elapsed_ms < 500']), ['threshold'], 'approval_required');
  expectCategories(fd('tests/test_math.py', ['-    assert area(2) == pytest.approx(12.566, rel=1e-3)', '+    assert area(2) == pytest.approx(12.566, rel=1e-1)']), ['threshold'], 'approval_required');
  expectCategories(fd('tests/test_cart.py', ['-        self.assertEqual(cart.total(), 5)', '+        self.assertEqual(cart.total(), 6)']), ['assertion'], 'approval_required');
});

test('py: assertion removed ⇒ assertion', () => {
  expectCategories(fd('tests/test_cart.py', [' def test_total(cart):', '     cart.add(item)', '-    assert cart.total() == 5']), ['assertion'], 'approval_required');
});

test('py: skip / xfail markers ⇒ test_skipped', () => {
  expectCategories(fd('tests/test_api.py', ['+@pytest.mark.skip(reason="flaky")', ' def test_latency(client):']), ['test_skipped'], 'forbidden');
  expectCategories(fd('tests/test_api.py', ['+@pytest.mark.xfail(strict=False)', ' def test_latency(client):']), ['test_skipped'], 'forbidden');
  expectCategories(fd('tests/test_api.py', [' def test_latency(client):', '+    pytest.skip("env not ready")', '     r = client.get("/x")']), ['test_skipped'], 'forbidden');
  expectCategories(fd('tests/test_api.py', ['+    @unittest.skip("later")', '     def test_latency(self):']), ['test_skipped'], 'forbidden');
});

test('py: except/pass ⇒ exception_swallowed', () => {
  expectCategories(fd('tests/test_api.py', ['+    try:', '         check(client)', '+    except Exception:', '+        pass']), ['test_implementation', 'exception_swallowed'], 'forbidden');
  const r = classifyTestChange(fd('tests/test_api.py', ['+    with contextlib.suppress(AssertionError):', '         check(client)']));
  assert.ok(r.categories.includes('exception_swallowed'));
});

test('py: deleted test function ⇒ test_deleted', () => {
  const r = expectCategories(fd('tests/test_api.py', ['-def test_refund(client):', '-    r = client.post("/refund")', '-    assert r.status_code == 200']), ['assertion', 'test_deleted'], 'forbidden');
  assert.ok(r.findings.some((f) => f.detail === 'test removed: test_refund'));
});

test('py: fixtures (conftest.py, @pytest.fixture region) ⇒ fixture', () => {
  expectCategories(fd('tests/conftest.py', ['     return User(', '-        name="alice")', '+        name="alice", tier="gold")'], { context: 'def user():' }), ['fixture'], 'conditional');
  expectCategories(fd('tests/test_orders.py', [' @pytest.fixture', ' def order():', '-    return Order(qty=1)', '+    return Order(qty=2)', ' ', ' def test_total(order):']), ['fixture'], 'conditional');
});

test('py: conftest collect_ignore ⇒ test_skipped; pytest.ini --deselect ⇒ test_skipped', () => {
  expectCategories(fd('tests/conftest.py', ['+collect_ignore = ["test_payments.py"]']), ['test_skipped'], 'forbidden');
  expectCategories(fd('pytest.ini', [' [pytest]', '-addopts = -q', '+addopts = -q --deselect tests/test_api.py::test_latency']), ['test_skipped'], 'forbidden');
});

test('py: setUp / monkeypatch.setenv ⇒ environment_setup; sleep ⇒ timeout', () => {
  expectCategories(fd('tests/test_db.py', ['     def setUp(self):', '-        self.db = connect("sqlite://")', '+        self.db = connect("sqlite:///tmp/t.db")', ' ', '     def test_x(self):']), ['environment_setup'], 'auto_allowed');
  expectCategories(fd('tests/test_db.py', ['-    monkeypatch.setenv("REGION", "eu")', '+    monkeypatch.setenv("REGION", "us")']), ['environment_setup'], 'auto_allowed');
  expectCategories(fd('tests/test_db.py', ['-    time.sleep(1)', '+    time.sleep(5)']), ['timeout'], 'conditional');
});

// ============================================================================ Go

test('go: guard-style assertion change (if got != want { t.Errorf }) ⇒ assertion', () => {
  expectCategories(fd('pkg/cart/cart_test.go', ['-\tif got := Total(items); got != 5 {', '+\tif got := Total(items); got != 6 {', ' \t\tt.Errorf("Total() = %d", got)', ' \t}']), ['assertion'], 'approval_required');
});

test('go: expected value (want) and testify assertions ⇒ assertion / threshold', () => {
  expectCategories(fd('pkg/cart/cart_test.go', ['-\twant := 200', '+\twant := 500']), ['assertion'], 'approval_required');
  expectCategories(fd('pkg/cart/cart_test.go', ['-\t\t{name: "basic", in: 2, want: 4},', '+\t\t{name: "basic", in: 2, want: 5},']), ['assertion'], 'approval_required');
  expectCategories(fd('pkg/api/api_test.go', ['-\trequire.Equal(t, 200, code)', '+\trequire.Equal(t, 201, code)']), ['assertion'], 'approval_required');
  expectCategories(fd('pkg/api/api_test.go', ['-\tassert.InDelta(t, 0.5, ratio, 0.01)', '+\tassert.InDelta(t, 0.5, ratio, 0.1)']), ['threshold'], 'approval_required');
});

test('go: t.Skip and build-ignore tags ⇒ test_skipped', () => {
  expectCategories(fd('pkg/api/api_test.go', [' func TestLatency(t *testing.T) {', '+\tt.Skip("flaky")', ' \tr := get("/x")']), ['test_skipped'], 'forbidden');
  expectCategories(fd('pkg/api/api_test.go', ['+//go:build ignore', ' ', ' package api']), ['test_skipped'], 'forbidden');
});

test('go: deleted test function / subtest ⇒ test_deleted', () => {
  expectCategories(fd('pkg/api/api_test.go', ['-func TestRefund(t *testing.T) {', '-\trefund()', '-}']), ['test_deleted'], 'forbidden');
  const r = expectCategories(fd('pkg/api/api_test.go', ['-\tt.Run("negative amount", func(t *testing.T) {', '-\t\trefund(-1)', '-\t})']), ['test_deleted'], 'forbidden');
  assert.equal(r.findings[0]!.detail, 'test removed: negative amount');
});

test('go: recover() / _ = err ⇒ exception_swallowed', () => {
  expectCategories(fd('pkg/api/api_test.go', [' func TestPanics(t *testing.T) {', '+\tdefer func() { recover() }()']), ['exception_swallowed'], 'forbidden');
  expectCategories(fd('pkg/api/api_test.go', ['-\tif err != nil {', '-\t\tt.Fatal(err)', '-\t}', '+\t_ = err']), ['assertion', 'exception_swallowed'], 'forbidden');
});

test('go: context timeout ⇒ timeout; TestMain ⇒ environment_setup; golden files ⇒ assertion', () => {
  expectCategories(fd('pkg/api/api_test.go', ['-\tctx, cancel := context.WithTimeout(ctx, time.Second)', '+\tctx, cancel := context.WithTimeout(ctx, 5*time.Second)']), ['timeout'], 'conditional');
  expectCategories(fd('pkg/api/main_test.go', [' func TestMain(m *testing.M) {', '-\tsetupDB("a")', '+\tsetupDB("b")', ' \tos.Exit(m.Run())']), ['environment_setup'], 'auto_allowed');
  expectCategories(fd('pkg/api/testdata/list.golden', ['-[1,2]', '+[1,2,3]']), ['assertion'], 'approval_required');
});

// ============================================================================ parser & edge cases

test('empty diff ⇒ auto_allowed with no findings; garbage ⇒ unknown (approval_required)', () => {
  assert.deepEqual(classifyTestChange(''), { decision: 'auto_allowed', categories: [], findings: [] });
  expectCategories('this is not a diff\n', ['unknown'], 'approval_required');
});

test('decision table', () => {
  assert.equal(categoryDecision('locator'), 'auto_allowed');
  assert.equal(categoryDecision('environment_setup'), 'auto_allowed');
  assert.equal(categoryDecision('fixture'), 'conditional');
  assert.equal(categoryDecision('test_implementation'), 'conditional');
  assert.equal(categoryDecision('timeout'), 'conditional');
  assert.equal(categoryDecision('assertion'), 'approval_required');
  assert.equal(categoryDecision('threshold'), 'approval_required');
  assert.equal(categoryDecision('test_deleted'), 'forbidden');
  assert.equal(categoryDecision('test_skipped'), 'forbidden');
  assert.equal(categoryDecision('exception_swallowed'), 'forbidden');
  assert.equal(categoryDecision('product_code'), 'forbidden');
  assert.equal(categoryDecision('product_code', true), 'approval_required');
});

test('parser: hunk bodies are consumed by count (content lines that look like headers are not headers)', () => {
  const diff = fd('src/a.test.ts', ['--- a/not-a-header', '+++ b/not-a-header', ' ctx']);
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0]!.hunks[0]!.lines.map((l) => l.kind), ['del', 'add', 'ctx']);
  assert.equal(files[0]!.hunks[0]!.lines[0]!.text, '-- a/not-a-header');
});

test('parser + classifier on a real multi-file git diff (rename, delete, add, modify)', async () => {
  const repo = await createGitRepo(
    {
      'src/cart.ts': 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n',
      'src/cart.test.ts': "import { total } from './cart';\nit('sums', () => {\n  expect(total([1, 2])).toBe(3);\n});\n",
      'tests/test_legacy.py': 'def test_legacy():\n    assert legacy() == 1\n',
      'e2e/old_name.spec.ts': "test('login', async ({ page }) => {\n  await page.locator('#user').fill('a');\n  await page.goto('/');\n  await page.goto('/home');\n});\n",
    },
    [
      {
        message: 'change',
        files: {
          'src/cart.test.ts': "import { total } from './cart';\nit('sums', () => {\n  expect(total([1, 2])).toBe(4);\n});\n",
          'tests/test_legacy.py': null,
          'e2e/old_name.spec.ts': null,
          'e2e/new_name.spec.ts': "test('login', async ({ page }) => {\n  await page.locator('#username').fill('a');\n  await page.goto('/');\n  await page.goto('/home');\n});\n",
          'tests/fixtures/data.json': '{"a": 1}\n',
        },
      },
    ],
  );
  try {
    const diff = execFileSync('git', ['diff', '-M', `${repo.commits[0]}..${repo.commits[1]}`], { cwd: repo.path, encoding: 'utf8' });
    const files = parseUnifiedDiff(diff);
    const byPath = new Map(files.map((f) => [f.newPath ?? f.oldPath, f]));
    assert.equal(byPath.get('e2e/new_name.spec.ts')!.status, 'renamed');
    assert.equal(byPath.get('e2e/new_name.spec.ts')!.oldPath, 'e2e/old_name.spec.ts');
    assert.equal(byPath.get('tests/test_legacy.py')!.status, 'deleted');
    assert.equal(byPath.get('tests/fixtures/data.json')!.status, 'added');
    assert.equal(byPath.get('src/cart.test.ts')!.status, 'modified');
    const r = classifyTestChange(diff);
    assert.deepEqual(r.categories, ['locator', 'fixture', 'assertion', 'test_deleted']);
    assert.equal(r.decision, 'forbidden');
    assert.ok(r.findings.some((f) => f.file === 'tests/test_legacy.py' && f.category === 'test_deleted'));
    assert.ok(r.findings.some((f) => f.file === 'e2e/new_name.spec.ts' && f.category === 'locator'));
  } finally {
    await repo.cleanup();
  }
});

// ============================================================================ I8 evasion attempts

test('I8: wrapping an existing assertion in a dead branch ⇒ assertion (approval_required)', () => {
  const r = expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '-    expect(pay()).toBe(true);', '+    if (false) {', '+      expect(pay()).toBe(true);', '+    }', '   });']), ['assertion'], 'approval_required');
  assert.match(r.findings[0]!.detail, /wrapped in new control flow/);
});

test('I8: an early return before existing assertions ⇒ assertion', () => {
  expectCategories(fd('pkg/pay_test.go', [' func TestPay(t *testing.T) {', '+\treturn', ' \tif !pay() {', ' \t\tt.Fatal("no")', ' \t}']), ['assertion'], 'approval_required');
  expectCategories(fd('tests/test_pay.py', [' def test_pay():', '+    return', '     assert pay()']), ['assertion'], 'approval_required');
});

test('I8: commenting out a whole test ⇒ test_deleted + assertion (forbidden)', () => {
  expectCategories(fd('src/pay.test.ts', ["-it('pays', () => {", '-  expect(pay()).toBe(true);', '-});', "+// it('pays', () => {", '+//   expect(pay()).toBe(true);', '+// });']), ['assertion', 'test_deleted'], 'forbidden');
});

test('I8: re-indenting a Python assertion changes control flow ⇒ assertion', () => {
  const r = expectCategories(fd('tests/test_a.py', [' def test_a():', '     if flag:', '-    assert x == 1', '+        assert x == 1']), ['assertion'], 'approval_required');
  assert.match(r.findings[0]!.detail, /re-indented/);
});

test('I8: expect.assertions count lowered ⇒ assertion', () => {
  expectCategories(fd('src/a.test.ts', ['-  expect.assertions(2);', '+  expect.assertions(1);']), ['assertion'], 'approval_required');
});

test('new tests may use conditional assertions (no pre-existing assertion is weakened)', () => {
  expectCategories(fd('src/new.test.ts', ["+it('handles both', () => {", '+  if (mode === 1) {', '+    expect(f()).toBe(1);', '+  }', '+});'], { status: 'added' }), ['test_implementation'], 'conditional');
});

test('a test (with assertions) moved to another file is not an assertion change', () => {
  const diff =
    fd('src/a.test.ts', ["   it('x', () => {});", "-it('pays', () => {", '-  expect(pay()).toBe(true);', '-});']) +
    fd('src/b.test.ts', ["+it('pays', () => {", '+  expect(pay()).toBe(true);', '+});'], { status: 'added' });
  expectCategories(diff, ['test_implementation'], 'conditional');
});

test('I8: re-emitting a test definition while dropping one of its assertions is still an assertion removal', () => {
  const r = expectCategories(
    fd('src/pay.test.ts', ["-it('pays', () => {", '-  expect(pay()).toBe(true);', '-  expect(refund()).toBe(true);', '-});', "+it('pays', () => {", '+  expect(pay()).toBe(true);', '+});']),
    ['assertion'],
    'approval_required',
  );
  assert.equal(r.findings[0]!.detail, 'assertion removed: expect(refund()).toBe(true);');
});

// ============================================================================ I8 evasions found in adversarial review

test('I8 evasion: moving an assertion into a new block comment / docstring / template literal ⇒ assertion', () => {
  const r = expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '-    expect(pay()).toBe(true);', '+    /*', '+    expect(pay()).toBe(true);', '+    */', '   });']), ['assertion'], 'approval_required');
  assert.equal(r.findings[0]!.detail, 'assertion removed: expect(pay()).toBe(true);');
  expectCategories(fd('tests/test_pay.py', [' def test_pay():', '-    assert pay()', '+    """', '+    assert pay()', '+    """']), ['test_implementation', 'assertion'], 'approval_required');
  expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '+    const s = `', '     expect(pay()).toBe(true);', '+    `;', '   });']), ['test_implementation', 'assertion'], 'approval_required');
});

test('I8 evasion: a new block comment around unchanged (context) assertions ⇒ assertion disabled', () => {
  const r = expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '+    /*', '     expect(pay()).toBe(true);', '+    */', '   });']), ['assertion'], 'approval_required');
  assert.equal(r.findings[0]!.detail, 'assertion disabled by a new block comment/string: expect(pay()).toBe(true);');
  assert.equal(r.findings[0]!.line, 3);
  expectCategories(fd('tests/test_pay.py', [' def test_pay():', '+    """', '     assert pay()', '+    """']), ['test_implementation', 'assertion'], 'approval_required');
  expectCategories(fd('pkg/pay_test.go', [' func TestPay(t *testing.T) {', '+\t/*', ' \tif !pay() {', ' \t\tt.Fatal("no")', ' \t}', '+\t*/']), ['assertion'], 'approval_required');
});

test('I8 evasion: a whole test disabled by a new block comment ⇒ test_deleted (forbidden)', () => {
  const r = expectCategories(fd('src/pay.test.ts', ['+/*', " it('pays', () => {", '   expect(pay()).toBe(true);', ' });', '+*/']), ['assertion', 'test_deleted'], 'forbidden');
  assert.ok(r.findings.some((f) => f.category === 'test_deleted' && f.detail === 'test disabled by a new block comment/string: pays' && f.line === 2));
});

test('I8 evasion: wrapping existing assertions in an uncalled function, closure or deferred callback ⇒ assertion', () => {
  for (const [open, close] of [['    function unused() {', '    }'], ['    const later = () => {', '    };'], ['    setTimeout(() => {', '    }, 0);'], ['    Promise.resolve().then(() => {', '    });']] as const) {
    const r = expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", `+${open}`, '     expect(pay()).toBe(true);', `+${close}`, '   });']), open.includes('setTimeout') ? ['test_implementation', 'assertion'] : ['assertion'], 'approval_required');
    assert.match(r.findings.find((f) => f.category === 'assertion')!.detail, /^existing assertion wrapped in new control flow/, open);
  }
  // indentation cannot hide the wrapped assertion (brace scoping, not indentation)
  expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '+    function unused() {', '    expect(pay()).toBe(true);', '+    }', '   });']), ['assertion'], 'approval_required');
  expectCategories(fd('pkg/pay_test.go', [' func TestPay(t *testing.T) {', '+\t_ = func() {', ' \tif !pay() {', ' \t\tt.Fatal("no")', ' \t}', '+\t}']), ['assertion'], 'approval_required');
});

test('I8 evasion: brace-less dead branch and padding beyond a fixed window ⇒ assertion', () => {
  expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '+    if (false)', '     expect(pay()).toBe(true);', '   });']), ['assertion'], 'approval_required');
  const padding = Array.from({ length: 12 }, (_, i) => `+      const v${i} = ${i};`);
  expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '+    if (false) {', ...padding, '     expect(pay()).toBe(true);', '+    }', '   });']), ['test_implementation', 'assertion'], 'approval_required');
});

test('I8 evasion: a conditional early exit before existing assertions ⇒ assertion (was auto_allowed)', () => {
  const r = expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '+    if (process.env.CI) return;', '     expect(pay()).toBe(true);', '   });']), ['assertion'], 'approval_required');
  assert.match(r.findings[0]!.detail, /^existing assertion bypassed by a new early exit: if \(process\.env\.CI\) return;/);
  // an exit inside a new block escapes it
  expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '+    if (flaky) {', '+      return;', '+    }', '     expect(pay()).toBe(true);', '   });']), ['test_implementation', 'assertion'], 'approval_required');
  // python: the rest of the enclosing function is dead
  expectCategories(fd('tests/test_pay.py', [' def test_pay():', '     if flaky:', '+        return', '     assert pay()']), ['assertion'], 'approval_required');
  // moving an existing early return up is not "moved code"
  expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '+    return;', '     expect(pay()).toBe(true);', '-    return;', '   });']), ['assertion'], 'approval_required');
});

test('no false positives: legitimate exits, helpers, suites, docs and strings stay conditional', () => {
  const conditional = (diff: string) => expectCategories(diff, ['test_implementation'], 'conditional');
  conditional(fd('src/pay.test.ts', ["   const ids = items.map((i) => {", '+    if (!i) return null;', '     return i.id;', '   });', '   expect(ids).toEqual([1]);']));
  conditional(fd('src/pay.test.ts', ['   if (a) {', '+    return;', '   } else {', '     expect(pay()).toBe(true);', '   }']));
  conditional(fd('src/pay.test.ts', ["   it('pays', () => {", '     expect(pay()).toBe(true);', '+    return undefined;', '   });', " it('b', () => {", '   expect(b()).toBe(1);']));
  conditional(fd('e2e/pay.spec.ts', ["+test.describe('payments', () => {", " test('pays', async () => {", '   expect(await pay()).toBe(true);', ' });', '+});']));
  conditional(fd('src/pay.test.ts', ['+function makeCart() {', '+  return new Cart();', '+}', '+', " it('pays', () => {", '   expect(pay()).toBe(true);', ' });']));
  conditional(fd('src/pay.test.ts', ['+/**', '+ * Payment tests.', '+ */', " it('pays', () => {", '   expect(pay()).toBe(true);', ' });']));
  conditional(fd('tests/test_pay.py', [' def test_pay():', '+    """Pays an order.', '+', '+    Covers the happy path.', '+    """', '     assert pay()']));
  conditional(fd('tests/test_pay.py', [' def helper():', '+    x = 1', '+    return x', ' ', ' def test_pay():', '     assert pay()']));
  conditional(fd('pkg/pay_test.go', ['+func helper(t *testing.T) int {', '+\treturn 1', '+}', '+', ' func TestPay(t *testing.T) {', ' \tif !pay() {', ' \t\tt.Fatal("no")', ' \t}']));
  conditional(fd('src/pay.test.ts', ["   it('pays', () => {", '+    if (mode) {', '+      expect(extra()).toBe(1);', '+    }', '     expect(pay()).toBe(true);', '   });']));
  conditional(fd('src/pay.test.ts', ["   it('pays', () => {", "+    const files = glob('src/**/*.ts');", '+    const re = /a\\/*b/;', '+    const s = `a ${b} c`;', '     expect(pay()).toBe(true);', '   });']));
  // exits inside a function literal on the same line, and a switch-case break, do not end the test early
  conditional(fd('src/pay.test.ts', ["   it('pays', async () => {", '+    const body = await fetch(u).then((r) => { return r.json(); });', '     expect(body.ok).toBe(true);', '   });']));
  conditional(fd('src/pay.test.ts', ["   it('pays', () => {", '+    const f = function () { return 1; };', '     expect(f()).toBe(1);', '   });']));
  conditional(fd('src/pay.test.ts', ['   switch (mode) {', '     case 1:', '+      setup1();', '+      break;', '     case 2:', '       expect(two()).toBe(2);', '   }']));
  // ...but a block-bodied conditional exit on one line does
  expectCategories(fd('src/pay.test.ts', ["   it('pays', () => {", '+    if (flaky) { return; }', '     expect(pay()).toBe(true);', '   });']), ['assertion'], 'approval_required');
});

test('I8 evasion: outcome-inverting and chained skip modifiers ⇒ test_skipped', () => {
  for (const [from, to] of [
    ["  it('pays', () => {", "  it.fails('pays', () => {"],
    ["  test('pays', () => {", "  test.failing('pays', () => {"],
    ["  it.concurrent('pays', () => {", "  it.concurrent.skip('pays', () => {"],
    ["  test.describe('pays', () => {", "  test.describe.skip('pays', () => {"],
    ["  it('pays', () => {", "  it.skipIf(process.env.CI)('pays', () => {"],
  ] as const) {
    expectCategories(fd('src/pay.test.ts', [`-${from}`, `+${to}`, '     expect(pay()).toBe(true);']), ['test_skipped'], 'forbidden');
  }
});

test('I8 evasion: pytest collection hooks and runner test-selection changes need approval (or are forbidden)', () => {
  expectCategories(fd('tests/conftest.py', ['+def pytest_ignore_collect(collection_path, config):', '+    return True']), ['fixture', 'test_skipped'], 'forbidden');
  const r = expectCategories(fd('tests/conftest.py', ['+def pytest_collection_modifyitems(config, items):', '+    items[:] = []']), ['fixture', 'unknown'], 'approval_required');
  assert.ok(r.findings.some((f) => f.category === 'unknown' && /collection hook/.test(f.detail)));
  // editing the body of an existing hook (hunk function context) is also a collection change
  expectCategories(fd('tests/conftest.py', ['-    items.sort(key=order)', '+    items[:] = [i for i in items if "pay" not in i.name]'], { context: 'def pytest_collection_modifyitems(config, items):' }), ['fixture', 'unknown'], 'approval_required');
  expectCategories(fd('jest.config.js', ["-  testMatch: ['**/*.test.ts'],", "+  testMatch: ['**/smoke.test.ts'],"]), ['environment_setup', 'unknown'], 'approval_required');
  expectCategories(fd('pytest.ini', [' [pytest]', '-testpaths = tests', '+testpaths = tests/smoke']), ['unknown'], 'approval_required');
});

test('I8 evasion: malformed hunks (content outside the declared counts) are never auto-classified', () => {
  const trailing = ['diff --git a/src/pay.test.ts b/src/pay.test.ts', '--- a/src/pay.test.ts', '+++ b/src/pay.test.ts', '@@ -1,1 +1,1 @@', '-const a = 1;', '+const a = 2;', '-    expect(pay()).toBe(true);'].join('\n') + '\n';
  const r = expectCategories(trailing, ['test_implementation', 'unknown'], 'approval_required');
  assert.ok(r.findings.some((f) => f.detail === 'malformed diff: content line outside any hunk: -    expect(pay()).toBe(true);'));
  const files = parseUnifiedDiff(trailing);
  assert.deepEqual(files[0]!.issues, ['content line outside any hunk: -    expect(pay()).toBe(true);']);
  const truncated = ['diff --git a/src/pay.test.ts b/src/pay.test.ts', '--- a/src/pay.test.ts', '+++ b/src/pay.test.ts', '@@ -1,5 +1,5 @@', '-const a = 1;', '+const a = 2;'].join('\n') + '\n';
  expectCategories(truncated, ['test_implementation', 'unknown'], 'approval_required');
  assert.match(parseUnifiedDiff(truncated)[0]!.issues![0]!, /^hunk @@ -1 \+1 @@ is truncated/);
  // well-formed diffs carry no issues
  assert.equal(parseUnifiedDiff(fd('src/a.test.ts', ['-a', '+b']))[0]!.issues, undefined);
});
