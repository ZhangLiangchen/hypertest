import type { Clock, IdGenerator, Logger } from '@hypertest/core';
import type { BudgetEnvelope, GateSpec, ModelPolicy, TestRun } from '@hypertest/domain';
import type { ModelCapabilityProfile, ScriptedBrain } from '@hypertest/model';
import type { PolicyRule } from '@hypertest/policy';
import type { EnvironmentDescriptor, SandboxProfile } from '@hypertest/tools';
import type { RoleOverrides } from '@hypertest/agents';
import type { ControlPlane, RunReport, StartRunInput } from '@hypertest/control';
import type { DurableRuntime, RunOutcome } from '@hypertest/durable';

/**
 * @hypertest/app — configuration + composition root. The only place that knows every package.
 *
 * Implementations to export from src/index.ts:
 *   loadConfig(path: string): Promise<HypertestConfig>   (YAML/JSON; `${ENV}` interpolation for non-secret fields;
 *                                                         secrets only via *Env indirection, never inline)
 *   defaultConfig(overrides?: Partial<HypertestConfig>): HypertestConfig   (pglite + inprocess bus + local durable +
 *                                                         fs artifacts under .hypertest/, scripted-free, native engine)
 *   validateConfig(config): string[]
 *   createHypertest(config: HypertestConfig, overrides?: HypertestOverrides): Promise<Hypertest>
 *   startApiServer(ht: Hypertest, options: { port: number; host?: string }): Promise<{ url: string; close(): Promise<void> }>
 *       REST: POST /runs, GET /runs, GET /runs/:id, GET /runs/:id/events (SSE), GET /runs/:id/report,
 *             POST /approvals/:id, GET /runs/:id/evidence/verify
 */
export interface ProviderConfig {
  id: string;
  kind: 'openai-compatible' | 'anthropic' | 'pi-ai' | 'scripted';
  baseUrl?: string;
  /** Name of the environment variable holding the API key (keys are never stored in config). */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  /** pi-ai provider name (for kind pi-ai). */
  piProvider?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface HypertestConfig {
  version: 1;
  project: { name: string; dataDir: string };
  store: { kind: 'pglite'; dataDir?: string } | { kind: 'postgres'; url?: string; urlEnv?: string; schema?: string };
  bus: { kind: 'inprocess' } | { kind: 'nats'; servers: string | string[]; stream?: string };
  durable: { kind: 'local'; maxConcurrentTurns?: number } | { kind: 'temporal'; address: string; namespace?: string; taskQueue?: string; workerMode?: 'embedded' | 'external' };
  artifacts: { kind: 'fs'; root?: string } | { kind: 's3'; endpoint?: string; region: string; bucket: string; prefix?: string; forcePathStyle?: boolean; objectLockDays?: number; accessKeyIdEnv?: string; secretAccessKeyEnv?: string };
  models: {
    providers: ProviderConfig[];
    routes: Array<Partial<ModelCapabilityProfile> & Pick<ModelCapabilityProfile, 'routeId' | 'provider' | 'model'>>;
    defaultPolicy?: ModelPolicy;
  };
  roles?: RoleOverrides['roles'];
  budget?: Partial<BudgetEnvelope>;
  gate?: Partial<GateSpec>;
  policy?: { rules?: PolicyRule[]; opa?: { url: string; path?: string; timeoutMs?: number }; capabilitySecretEnv?: string };
  bugate?: { path?: string };
  engines?: { default: 'native' | 'pi' | (string & {}) };
  sandbox?: Partial<SandboxProfile>;
  environments?: EnvironmentDescriptor[];
  tools?: { shellAllowlist?: string[]; httpAllowlist?: string[]; enableBrowser?: boolean };
  signing?: { keyFile?: string };
  memory?: { kind: 'sql' } | { kind: 'powercontext'; baseUrl: string; apiKeyEnv?: string };
  observability?: { logLevel?: 'debug' | 'info' | 'warn' | 'error' };
}

export interface HypertestOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  /** Brains for `scripted` providers keyed by provider id (tests, PoCs, eval). */
  scriptedBrains?: Record<string, ScriptedBrain>;
  /** Extra environments/tools/adapters injected by eval fixtures. */
  environments?: EnvironmentDescriptor[];
  workerId?: string;
}

export interface Hypertest {
  readonly config: HypertestConfig;
  readonly control: ControlPlane;
  readonly durable: DurableRuntime;
  /** Starts a run and returns immediately. */
  start(input: StartRunInput): Promise<TestRun>;
  /** Starts a run and waits for its outcome. */
  run(input: StartRunInput, options?: { timeoutMs?: number }): Promise<RunOutcome>;
  resumeIncomplete(): Promise<string[]>;
  status(runId: string): Promise<TestRun | undefined>;
  report(runId: string): Promise<RunReport>;
  verifyEvidence(runId: string): Promise<{ ok: boolean; problems: string[] }>;
  approve(approvalId: string, approve: boolean, actor: { kind: 'human'; id: string }, rationale: string): Promise<void>;
  decideOracleProposal(proposalId: string, approve: boolean, actor: { kind: 'human'; id: string }, rationale: string): Promise<void>;
  close(): Promise<void>;
}
