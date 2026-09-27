import type { HypertestConfig, HypertestOverrides } from '@hypertest/app';
import type { EvalArm, EvalSuite, EvalTask, LlmJudge, ReleaseGateOptions, ReleaseGateReport, SuiteOptions, SuiteResult, TrialFixture } from '@hypertest/eval';

/**
 * @hypertest/cli — `hypertest` command line.
 *
 *   hypertest init [--dir .]                       write hypertest.config.yaml (+ .gitignore entries)
 *   hypertest run "<goal>" [--repo <path>] [--commit <sha>] [--base <sha>] [--url <sutUrl>] [--config f] [--detach]
 *   hypertest status [<runId>]                     run status / list
 *   hypertest resume                               resume incomplete runs (after crash)
 *   hypertest report <runId> [--json]
 *   hypertest events <runId> [--follow]
 *   hypertest evidence verify <runId>
 *   hypertest approvals [--run <id>] | hypertest approve <approvalId> [--deny] --by <name> --reason "<text>"
 *   hypertest oracle decide <proposalId> [--reject] --by <name> --reason "<text>"
 *   hypertest eval run <suite> [--trials n] [--arms a,b]
 *   hypertest worker                               Temporal worker (durable.kind=temporal, workerMode=external)
 *   hypertest serve [--port 7420]                  HTTP API
 *   hypertest doctor                               check config, providers, infra, BUGate binding
 *
 * Implementations to export from src/index.ts:
 *   main(argv: string[], io?: { stdout; stderr; env; cwd }): Promise<number>   (exit code; never process.exit)
 *
 * (additive, v0.3 implementation)
 *   - `main(argv, io?: Partial<CliIo>)`: every CliIo member is optional (defaults: process streams, process.env,
 *     process.cwd(), SIGINT/SIGTERM for long-running commands, `import('@hypertest/eval')`).
 *   - Exit codes (EXIT_CODES): 0 ok, 1 failure, 2 usage error; `run` is verdict-aware: pass ⇒ 0, fail ⇒ 3,
 *     conditional ⇒ 4, inconclusive ⇒ 5 (a run that ends without a verdict — failed/cancelled — ⇒ 1); an interrupted
 *     foreground command (SIGINT/SIGTERM or `io.signal`) ⇒ 130.
 *   - Global options: `--config <file>`, `--scripted-brains <module>`, `--log-level <level>`, `--json`, `--help`,
 *     `--version`. Extra commands: `cancel <runId> --reason`, `version`, `help [command]`.
 *   - `--json` is accepted by: run, status, resume, report, events, evidence verify, approvals, approve, oracle decide,
 *     cancel, eval run, doctor, serve, init.
 *
 * (additive, review)
 *   - A command that executes no agent turn (read/decide commands, `run --detach`, `resume --detach`) never hosts a
 *     Temporal worker: its configuration is used with `durable.workerMode: external` (`clientOnlyConfig`).
 *   - `status <runId>`: `decision` is the run's FINAL decision (`run.decisionId`) only; `--json` adds `interimDecision`
 *     (a non-final gate decision of the feedback loop while the run continues), never shown as the verdict.
 *   - `run --json` interrupted: stdout carries `{ runId, status: null, verdict: null, interrupted: true, runtimeManifestId,
 *     exitCode: 130 }`.
 *   - `approve` / `oracle decide` refuse (`permission_denied`) when `$HYPERTEST_SANDBOX` is set (`SANDBOX_ENV`).
 *   - `serve` validates the token and host before opening the store and listens before resuming runs.
 *   - `init` writes the configuration atomically (temp file + exclusive link, or rename with --force).
 *   - New exports: `clientOnlyConfig`, `SANDBOX_ENV`, `MIN_API_TOKEN_LENGTH`, `writeConfigAtomically`.
 *
 * (additive, runtime release management)
 * (additive, eval platform completion)
 *   - `hypertest eval gate --baseline <suite-result.json> --candidate <suite-result.json> [--baseline-arm a] [--candidate-arm b]
 *     [--alpha p] [--report f] [--json]`: the eval release gate (exit 0 pass / 1 fail; malformed inputs are usage errors).
 *   - `eval run --out <file>` persists the SuiteResult JSON (whatever the display format; before: the displayed report);
 *     `--report <file>` writes the displayed report; `--judge scripted` appends the independent LLM judge to every task.
 *   - EvalModuleLike: `evaluateReleaseGate?`, `renderReleaseGateReport?`, `scriptedJudge?`. New export `withJudge`.
 *
 *   - `hypertest runtime list | show | register | record-suite | promote | rollback | migrate` (runtimeCommand): the runtime
 *     release registry of the store; decisions take `--by <name>` (`human:<name>`, or `ci:<pipeline>`) and are refused
 *     (`permission_denied`) under `$HYPERTEST_SANDBOX`. New exports `releaseActor`, `parseAllowances`, `parseCanary`,
 *     `suiteFromEval`.
 */

/** A text sink (process.stdout/stderr or a test collector). */
export interface CliOutput {
  write(chunk: string): unknown;
}

/** (additive) The CLI's environment; `main` never reads process state that is not reachable through it. */
export interface CliIo {
  stdout: CliOutput;
  stderr: CliOutput;
  /** Environment for `${VAR}` interpolation, `*Env` indirections, HYPERTEST_CONFIG and HYPERTEST_LOG_LEVEL. */
  env: Record<string, string | undefined>;
  /** Directory relative paths (config, --repo, --dir, --scripted-brains) resolve against. */
  cwd: string;
  /**
   * (additive) Stops long-running commands (`run` while waiting, `resume`, `events --follow`, `serve`, `worker`, `eval run`).
   * Default: the process's SIGINT/SIGTERM, installed only while such a command runs.
   */
  signal?: AbortSignal;
  /** (additive) Loader of the eval platform (default `import('@hypertest/eval')`); tests inject a stub. */
  loadEval?: () => Promise<EvalModuleLike>;
}

/** Brains for `scripted` providers keyed by provider id (the createHypertest override). */
export type ScriptedBrainMap = NonNullable<HypertestOverrides['scriptedBrains']>;
/** One scripted brain. */
export type ScriptedBrainFn = ScriptedBrainMap[string];

/** (additive) What a factory export of a `--scripted-brains` module receives. */
export interface ScriptedBrainsContext {
  command: string;
  config: HypertestConfig;
  env: Record<string, string | undefined>;
  cwd: string;
}

export type ScriptedBrainsFactory = (ctx: ScriptedBrainsContext) => ScriptedBrainMap | Promise<ScriptedBrainMap>;

/**
 * (additive) The shape of a `--scripted-brains <module>` (an ES module, `.ts` allowed on Node ≥ 22.18): `brains` (or the
 * default export) is a map provider id → ScriptedBrain, or a factory returning one; `evalBrains` optionally gives the
 * brains of the CLI's `config` eval arm per task (else the static map is used for every task).
 */
export interface ScriptedBrainsModule {
  brains?: ScriptedBrainMap | ScriptedBrainsFactory;
  default?: ScriptedBrainMap | ScriptedBrainsFactory;
  evalBrains?: (task: EvalTask, fixture: TrialFixture) => ScriptedBrainMap;
}

/**
 * (additive) What `eval run` needs from @hypertest/eval, resolved by duck typing (the eval platform may evolve):
 * `runSuite` (required), `renderSuiteReport` (optional; markdown), suites by id (`suites[id]` — an EvalSuite or a
 * factory — else the `<camelCaseId>Suite()` factory named in the eval contract, e.g. `pocAWhiteboxSuite`), and arms
 * (`arms` — a map or an array —, `builtinArms()`/`defaultArms()`, or `ARMS`).
 */
export interface EvalModuleLike {
  runSuite?: (suite: EvalSuite, options: SuiteOptions) => Promise<SuiteResult>;
  renderSuiteReport?: (result: SuiteResult) => string;
  suites?: Record<string, EvalSuite | (() => EvalSuite)>;
  arms?: Record<string, EvalArm> | EvalArm[];
  builtinArms?: () => EvalArm[] | Record<string, EvalArm>;
  defaultArms?: () => EvalArm[] | Record<string, EvalArm>;
  ARMS?: Record<string, EvalArm> | EvalArm[];
  /** (additive) `eval gate`: the eval release gate over two SuiteResults (and its markdown report). */
  evaluateReleaseGate?: (baseline: SuiteResult, candidate: SuiteResult, options?: ReleaseGateOptions) => ReleaseGateReport;
  renderReleaseGateReport?: (report: ReleaseGateReport) => string;
  /** (additive) `eval run --judge scripted`: the calibrated scripted LLM judge. */
  scriptedJudge?: () => LlmJudge;
  [name: string]: unknown;
}

/** (additive) One `hypertest doctor` check: the app's diagnose checks plus the CLI's host checks (`info` = informational). */
export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'error' | 'info';
  detail: string;
}

/** (additive) `hypertest doctor --json`. */
export interface DoctorReport {
  ok: boolean;
  configPath?: string;
  checks: DoctorCheck[];
}
