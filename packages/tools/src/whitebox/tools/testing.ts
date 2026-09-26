import { readFile, stat } from 'node:fs/promises';
import { HypertestError, canonicalJson, sha256Hex, type JsonValue } from '@hypertest/core';
import type { ArtifactRef } from '@hypertest/domain';
import { DEFAULT_TEST_PATH_PATTERNS, matchesGlob } from '@hypertest/policy';
import type { BuiltinToolOptions, CoverageMap, TestRunnerAdapter, TestRunResult, ToolContext, ToolSpec, WorkspaceHandle, WorkspaceManager } from '../../contracts.ts';
import { detectCoverageFormat, parseCoverage, type CoverageFormat } from '../coverage.ts';
import { MUTATION_OPERATORS, runMutationAnalysis } from '../mutation.ts';
import { commandRunner } from '../runners/command.ts';
import { defaultTestRunners } from '../runners/index.ts';
import { rebase } from '../runners/node.ts';
import { normalizeRel } from '../paths.ts';
import { assertNotGitMetadata, pathResource, rootResource } from './common.ts';
import { DEFAULT_SHELL_ALLOWLIST, confinedArguments, shellDenial } from './shell.ts';

const FRAMEWORKS = ['auto', 'node_test', 'vitest', 'jest', 'pytest', 'go_test', 'command'] as const;
const MAX_CASES_INLINE = 500;
const SELECTOR_SCHEMA = { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[^-]' };

/** Picks the runner: explicit framework, else the first runner (in order) whose detect() matches. */
export async function selectRunner(runners: readonly TestRunnerAdapter[], ws: WorkspaceHandle, framework: string | undefined): Promise<TestRunnerAdapter> {
  if (framework !== undefined && framework !== 'auto') {
    const r = runners.find((x) => x.framework === framework);
    if (!r) throw new HypertestError('invalid_argument', `no runner for framework ${framework} (available: ${runners.map((x) => x.framework).join(', ')})`);
    return r;
  }
  for (const r of runners) if (await r.detect(ws)) return r;
  throw new HypertestError('precondition_failed', `no test framework detected in workspace ${ws.workspaceId}; pass framework explicitly`);
}

/**
 * Paths whose change can alter which test cases run or what they assert: the policy's test path patterns plus the
 * default discovery patterns of the supported runners (node:test `*-test.*`, `*_test.*`, `test-*.*`, `test.*`; spec dirs).
 */
export const TEST_FILE_PATTERNS: readonly string[] = Object.freeze([
  ...DEFAULT_TEST_PATH_PATTERNS,
  '**/*-test.*', '**/*_test.*', '**/test-*.*', '**/test.*', '**/*_spec.*', '**/spec/**', '**/__tests__/**',
]);
const MAX_DELTA_TEST_FILES = 500;

export function isTestFilePath(path: string): boolean {
  return TEST_FILE_PATTERNS.some((g) => matchesGlob(g, path));
}

/**
 * conformance-2: what was tested, relative to the workspace's base commit — recorded on every test-result (and
 * coverage) record as `workspaceDelta`, computed by the tool (never a caller claim) BEFORE the run:
 *   { status: 'computed', baseCommit?, readOnly, treeDigest, changedFiles, testFiles: [{ path, change, sha256 }], testFilesTruncated? }
 *   { status: 'unavailable', readOnly, reason }
 * `testFiles` = changed files that are test files (TEST_FILE_PATTERNS) or the file the selector names; `treeDigest` =
 * sha256 of the canonical { baseCommit, every change with its digest }. The QualityGate counts such evidence only when
 * every added/modified test file is covered by a validated TestArtifact with exactly that digest (sensitivity proven).
 */
export async function workspaceDelta(ws: WorkspaceHandle, workspaces: WorkspaceManager, selector: string | undefined): Promise<Record<string, JsonValue>> {
  if (typeof workspaces.changedFiles !== 'function') return { status: 'unavailable', readOnly: ws.readOnly, reason: 'the workspace manager cannot list changes against the base commit' };
  let changes: Awaited<ReturnType<NonNullable<WorkspaceManager['changedFiles']>>>;
  try {
    changes = await workspaces.changedFiles(ws);
  } catch (e) {
    return { status: 'unavailable', readOnly: ws.readOnly, reason: (e as Error).message.slice(0, 500) };
  }
  const selected = selector === undefined ? undefined : normalizeRel(selector.split('::')[0]!);
  const tests = changes.filter((c) => isTestFilePath(c.path) || c.path === selected);
  const delta: Record<string, JsonValue> = {
    status: 'computed',
    readOnly: ws.readOnly,
    treeDigest: sha256Hex(canonicalJson({ baseCommit: ws.baseCommit ?? null, changes: changes.map((c) => ({ path: c.path, change: c.change, sha256: c.sha256 ?? null })) })),
    changedFiles: changes.length,
    testFiles: tests.slice(0, MAX_DELTA_TEST_FILES).map((c) => ({ path: c.path, change: c.change, sha256: c.sha256 ?? null })),
  };
  if (ws.baseCommit !== undefined) delta['baseCommit'] = ws.baseCommit;
  if (tests.length > MAX_DELTA_TEST_FILES) delta['testFilesTruncated'] = true;
  return delta;
}

function deltaNote(delta: Record<string, JsonValue>): string {
  if (delta['status'] !== 'computed') return `\nWORKSPACE DELTA UNAVAILABLE (${String(delta['reason'])}): unless the workspace is read-only, this evidence does not count for the quality gate.`;
  const files = (delta['testFiles'] as Array<{ path: string; change: string }>).filter((f) => f.change !== 'deleted');
  if (files.length === 0) return '';
  return `\n${files.length} test file(s) differ from the base commit (${files.slice(0, 10).map((f) => `${f.change} ${f.path}`).join(', ')}${files.length > 10 ? ', …' : ''}): this evidence counts for the quality gate only once each of them is registered and validated as a TestArtifact with exactly this content.`;
}

function summarize(r: TestRunResult): string {
  const t = r.totals;
  const parts = [`${r.framework}: ${r.passed ? 'PASSED' : 'NOT PASSED'}`, `total ${t.total}`, `passed ${t.passed}`, `failed ${t.failed}`, `error ${t.error}`, `skipped ${t.skipped}`];
  if (t.xfail) parts.push(`xfail ${t.xfail}`);
  if (t.xpass) parts.push(`xpass ${t.xpass}`);
  let s = parts.join(', ');
  if (t.total === 0) s += '\nNO TESTS RAN — this is not a pass (fake-green guard).';
  if (r.harnessError) s += `\nHARNESS ERROR: ${r.harnessError}`;
  const bad = r.cases.filter((c) => c.status === 'failed' || c.status === 'error' || c.status === 'xpass').slice(0, 50);
  if (bad.length) s += '\n' + bad.map((c) => `- ${c.status.toUpperCase()} ${c.id}${c.message ? `: ${c.message.split('\n')[0]}` : ''}`).join('\n');
  return s;
}

async function recordTestEvidence(
  ctx: ToolContext,
  run: Awaited<ReturnType<TestRunnerAdapter['run']>>,
  testArtifactIds: string[],
  delta: Record<string, JsonValue>,
): Promise<{ evidenceRefs: string[]; testResultIds: string[]; coverageIds: string[]; artifactRefs: ArtifactRef[] }> {
  const evidenceRefs: string[] = [];
  const parents: string[] = [];
  const artifactRefs: ArtifactRef[] = [];
  const provenance = { command: run.result.command };
  if (run.stdout.length > 0) {
    const ev = await ctx.recordEvidence({ evidenceType: 'stdout', data: run.stdout, mimeType: 'text/plain', summary: `${run.result.framework} stdout`, provenance });
    evidenceRefs.push(ev.evidenceId);
    parents.push(ev.evidenceId);
  }
  if (run.stderr.length > 0) {
    const ev = await ctx.recordEvidence({ evidenceType: 'stderr', data: run.stderr, mimeType: 'text/plain', summary: `${run.result.framework} stderr`, provenance });
    evidenceRefs.push(ev.evidenceId);
    parents.push(ev.evidenceId);
  }
  let raw: Record<string, JsonValue> | undefined;
  if (run.rawReport) {
    const ref = await ctx.artifacts.put(run.rawReport.data, { mimeType: run.rawReport.mimeType });
    artifactRefs.push(ref);
    raw = { uri: ref.uri, sha256: ref.sha256, mimeType: ref.mimeType, size: ref.size };
  }
  const base = JSON.parse(JSON.stringify(run.result)) as Record<string, JsonValue>;
  if (raw) base['rawReport'] = raw;
  base['workspaceDelta'] = delta;
  // The QualityGate reads the singular `testArtifactId`: one record per linked artifact keeps its
  // eligibility check per artifact (an ineligible artifact can never ride along with an eligible one).
  const links: Array<string | undefined> = testArtifactIds.length > 0 ? testArtifactIds : [undefined];
  const testResultIds: string[] = [];
  for (const id of links) {
    const structured: Record<string, JsonValue> = { ...base };
    if (id !== undefined) structured['testArtifactId'] = id;
    if (testArtifactIds.length > 0) structured['testArtifactIds'] = testArtifactIds;
    const t = run.result.totals;
    const ev = await ctx.recordEvidence({
      evidenceType: 'test-result',
      data: JSON.stringify(structured),
      mimeType: 'application/json',
      summary: `${run.result.framework} ${run.result.passed ? 'passed' : 'NOT passed'}: ${t.passed}/${t.total} passed, ${t.failed} failed, ${t.error} errors${run.result.harnessError ? ' (harness error)' : ''}${id ? ` [test artifact ${id}]` : ''}`,
      structured,
      parentEvidenceIds: parents,
      provenance,
    });
    evidenceRefs.push(ev.evidenceId);
    testResultIds.push(ev.evidenceId);
  }
  const coverageIds: string[] = [];
  if (run.coverage) {
    const coverage = { ...(JSON.parse(JSON.stringify(run.coverage)) as Record<string, JsonValue>), workspaceDelta: delta };
    const ev = await ctx.recordEvidence({
      evidenceType: 'coverage',
      data: JSON.stringify(coverage),
      mimeType: 'application/json',
      summary: `${run.coverage.format} coverage from ${run.result.framework}: lines ${run.coverage.totals.lines.covered}/${run.coverage.totals.lines.total}, branches ${run.coverage.totals.branches === 'unknown' ? 'unknown' : `${run.coverage.totals.branches.covered}/${run.coverage.totals.branches.total}`}`,
      structured: coverage,
      parentEvidenceIds: testResultIds,
      provenance,
    });
    evidenceRefs.push(ev.evidenceId);
    coverageIds.push(ev.evidenceId);
  }
  return { evidenceRefs, testResultIds, coverageIds, artifactRefs };
}

interface TestRunInput {
  framework?: (typeof FRAMEWORKS)[number];
  selector?: string;
  coverage?: boolean;
  timeoutMs?: number;
  command?: string[];
  testArtifactId?: string;
  testArtifactIds?: string[];
}

export function testRunTool(options: BuiltinToolOptions): ToolSpec<TestRunInput> {
  const runners = options.runners ?? defaultTestRunners();
  const allowlist = options.shellAllowlist ?? DEFAULT_SHELL_ALLOWLIST;
  return {
    id: 'test.run',
    title: 'Run tests',
    description:
      'Run tests in the workspace and record a structured TestRunResult as test-result evidence (plus stdout/stderr, the raw report, and coverage when requested). framework: auto-detected (vitest, jest, node_test, pytest, go_test) or explicit; "command" runs an allowlisted command (exit-code only: it records the exit code but never counts as passed, since it proves no test case ran). selector: node "file::name-pattern" | file | name pattern; pytest nodeid or -k expression; go "pkg::-run regex" | "./pkg/..." | regex. Failing tests are a successful tool call with passed=false. Zero tests is never a pass.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        framework: { enum: [...FRAMEWORKS], default: 'auto' },
        selector: SELECTOR_SCHEMA,
        coverage: { type: 'boolean', default: false },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 3_600_000 },
        command: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', maxLength: 4096 } },
        testArtifactId: { type: 'string', minLength: 1, maxLength: 128 },
        testArtifactIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 }, maxItems: 50 },
      },
    },
    effect: 'execute',
    riskClass: 'medium',
    timeoutMs: 3_600_000,
    resources: (_input, ctx) => [rootResource(ctx)],
    async execute(input, ctx) {
      let runner: TestRunnerAdapter;
      if (input.framework === 'command') {
        if (!input.command) throw new HypertestError('invalid_argument', 'framework "command" requires command');
        const denial = shellDenial(input.command, allowlist, ctx.permit.constraints?.allowedCommands);
        if (denial) return { status: 'denied', error: { code: 'permission_denied', message: denial } };
        const argDenial = options.sandbox.kind === 'oci' ? undefined : await confinedArguments(ctx.workspace, undefined, input.command);
        if (argDenial) return { status: 'denied', error: { code: 'permission_denied', message: argDenial } };
        // no agent-controlled allowNoCases: an exit code alone must never become `passed: true` (fake green);
        // a trusted exit-code runner can still be configured through BuiltinToolOptions.runners
        runner = commandRunner({ command: input.command });
      } else {
        if (input.command) throw new HypertestError('invalid_argument', 'command is only valid with framework "command"');
        runner = await selectRunner(runners, ctx.workspace, input.framework);
      }
      const timeoutMs = Math.min(input.timeoutMs ?? 600_000, ctx.permit.constraints?.maxDurationMs ?? Number.MAX_SAFE_INTEGER);
      const request: Parameters<TestRunnerAdapter['run']>[1] = { timeoutMs, signal: ctx.signal };
      if (input.selector !== undefined) request.selector = input.selector;
      if (input.coverage) request.coverage = true;
      // the tree that is about to be tested (derived by the tool, never claimed by the caller): conformance-2
      const delta = await workspaceDelta(ctx.workspace, options.workspaces, input.selector);
      const run = await runner.run(ctx.workspace, request, options.sandbox);
      const ids = [...new Set([...(input.testArtifactId ? [input.testArtifactId] : []), ...(input.testArtifactIds ?? [])])];
      const ev = await recordTestEvidence(ctx, run, ids, delta);
      const structured = JSON.parse(JSON.stringify(run.result)) as Record<string, JsonValue>;
      if (run.result.cases.length > MAX_CASES_INLINE) {
        structured['cases'] = run.result.cases.slice(0, MAX_CASES_INLINE) as unknown as JsonValue;
        structured['casesTruncated'] = true;
      }
      if (ids.length > 0) structured['testArtifactIds'] = ids;
      structured['evidence'] = { testResult: ev.testResultIds, coverage: ev.coverageIds };
      if (run.coverage) structured['coverage'] = { format: run.coverage.format, totals: run.coverage.totals as unknown as JsonValue };
      structured['workspaceDelta'] = delta;
      return { status: 'success', structured, text: summarize(run.result) + deltaNote(delta), evidenceRefs: ev.evidenceRefs, artifactRefs: ev.artifactRefs };
    },
  };
}

// ----------------------------------------------------------------------------- coverage.collect

interface CoverageInput {
  path: string;
  format?: 'auto' | CoverageFormat;
}

function coverageText(map: CoverageMap): string {
  const pct = (c: { covered: number; total: number }) => (c.total === 0 ? 'n/a' : `${((c.covered / c.total) * 100).toFixed(1)}%`);
  const b = map.totals.branches;
  const head = `${map.format}: lines ${map.totals.lines.covered}/${map.totals.lines.total} (${pct(map.totals.lines)}), branches ${b === 'unknown' ? 'unknown (not measured)' : `${b.covered}/${b.total} (${pct(b)})`}, ${map.files.length} files`;
  const worst = [...map.files].sort((x, y) => x.lines.covered / Math.max(1, x.lines.total) - y.lines.covered / Math.max(1, y.lines.total)).slice(0, 30);
  return head + '\n' + worst.map((f) => `  ${pct(f.lines).padStart(6)} ${f.path} (${f.lines.covered}/${f.lines.total})`).join('\n');
}

export function coverageCollectTool(options: BuiltinToolOptions): ToolSpec<CoverageInput> {
  return {
    id: 'coverage.collect',
    title: 'Collect coverage',
    description: 'Parse an existing coverage report in the workspace (coverage.py JSON, LCOV, Cobertura XML, Go coverprofile; format auto-detected) into a CoverageMap recorded as coverage evidence. Unmeasured branch coverage stays "unknown".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1, maxLength: 4096 }, format: { enum: ['auto', 'coverage.py', 'lcov', 'cobertura', 'go'], default: 'auto' } },
    },
    effect: 'execute',
    riskClass: 'low',
    timeoutMs: 60_000,
    resources: (input, ctx) => [pathResource(ctx, input.path)],
    async execute(input, ctx) {
      assertNotGitMetadata(input.path, 'coverage.collect');
      const abs = await options.workspaces.resolvePath(ctx.workspace, input.path);
      const st = await stat(abs).catch(() => undefined);
      if (!st?.isFile()) throw new HypertestError('not_found', `no coverage report at ${input.path}`);
      if (st.size > 256 * 1024 * 1024) throw new HypertestError('invalid_argument', `coverage report ${input.path} is too large (${st.size} bytes)`);
      const text = await readFile(abs, 'utf8');
      const format = input.format && input.format !== 'auto' ? input.format : detectCoverageFormat(text);
      if (!format) throw new HypertestError('invalid_argument', `cannot detect the coverage format of ${input.path}; pass format`);
      const map = rebase(parseCoverage(format, text), ctx.workspace.root);
      const ev = await ctx.recordEvidence({
        evidenceType: 'coverage',
        data: JSON.stringify(map),
        mimeType: 'application/json',
        summary: `${format} coverage from ${normalizeRel(input.path)}: lines ${map.totals.lines.covered}/${map.totals.lines.total}, branches ${map.totals.branches === 'unknown' ? 'unknown' : `${map.totals.branches.covered}/${map.totals.branches.total}`}`,
        structured: map as unknown as JsonValue,
      });
      const worst = [...map.files].sort((x, y) => x.lines.covered / Math.max(1, x.lines.total) - y.lines.covered / Math.max(1, y.lines.total)).slice(0, 100);
      return {
        status: 'success',
        structured: { format, totals: map.totals as unknown as JsonValue, fileCount: map.files.length, files: worst as unknown as JsonValue, evidenceId: ev.evidenceId },
        text: coverageText(map),
        evidenceRefs: [ev.evidenceId],
      };
    },
  };
}

// ----------------------------------------------------------------------------- mutation.run

interface MutationInput {
  file: string;
  testSelector?: string;
  framework?: (typeof FRAMEWORKS)[number];
  maxMutants?: number;
  operators?: string[];
  timeoutMs?: number;
  testArtifactId?: string;
}

export function mutationRunTool(options: BuiltinToolOptions): ToolSpec<MutationInput> {
  const runners = options.runners ?? defaultTestRunners();
  return {
    id: 'mutation.run',
    title: 'Mutation analysis',
    description: `Validate test sensitivity: mutate a source file (operators: ${MUTATION_OPERATORS.join(', ')}) in a private copy of the workspace and run the selected tests against each mutant. killed = tests fail, survived = tests still pass. The baseline must pass first. Records mutation-result evidence with the score (killed / decidable mutants). The workspace itself is never modified.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: {
        file: { type: 'string', minLength: 1, maxLength: 4096 },
        testSelector: SELECTOR_SCHEMA,
        framework: { enum: FRAMEWORKS.filter((f) => f !== 'command'), default: 'auto' },
        maxMutants: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
        operators: { type: 'array', items: { enum: [...MUTATION_OPERATORS] }, minItems: 1, uniqueItems: true },
        timeoutMs: { type: 'integer', minimum: 5000, maximum: 7_200_000 },
        testArtifactId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    effect: 'execute',
    riskClass: 'medium',
    timeoutMs: 7_200_000,
    // copies and executes the whole workspace's test suite: the root is touched, not only the mutated file
    resources: (input, ctx) => [rootResource(ctx), pathResource(ctx, input.file)],
    async execute(input, ctx) {
      const runner = await selectRunner(runners, ctx.workspace, input.framework);
      const analysis = await runMutationAnalysis({
        ws: ctx.workspace,
        file: normalizeRel(input.file),
        runner,
        sandbox: options.sandbox,
        ...(input.testSelector !== undefined ? { selector: input.testSelector } : {}),
        maxMutants: input.maxMutants ?? 20,
        ...(input.operators ? { operators: input.operators as typeof MUTATION_OPERATORS[number][] } : {}),
        timeoutMs: Math.min(input.timeoutMs ?? 1_800_000, ctx.permit.constraints?.maxDurationMs ?? Number.MAX_SAFE_INTEGER),
        signal: ctx.signal,
      });
      const structured = JSON.parse(JSON.stringify(analysis)) as Record<string, JsonValue>;
      if (input.testArtifactId) structured['testArtifactId'] = input.testArtifactId;
      const ev = await ctx.recordEvidence({
        evidenceType: 'mutation-result',
        data: JSON.stringify(structured),
        mimeType: 'application/json',
        summary: `mutation ${analysis.file}: score ${(analysis.score * 100).toFixed(1)}% (${analysis.killed} killed, ${analysis.survived} survived, ${analysis.errors} errors of ${analysis.total}; ${analysis.generated} generated)`,
        structured,
      });
      const survivors = analysis.mutants.filter((m) => m.status === 'survived').slice(0, 30);
      const text =
        `mutation score ${(analysis.score * 100).toFixed(1)}%: ${analysis.killed} killed, ${analysis.survived} survived, ${analysis.errors} errors (${analysis.total} run of ${analysis.generated} generated)` +
        (survivors.length ? '\nsurvivors (tests did not notice):\n' + survivors.map((m) => `  L${m.line} ${m.operator}: ${JSON.stringify(m.original)} -> ${JSON.stringify(m.replacement)}`).join('\n') : '');
      return { status: 'success', structured, text, evidenceRefs: [ev.evidenceId] };
    },
  };
}
