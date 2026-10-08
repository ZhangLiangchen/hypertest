import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HypertestError, jsonLogger, type Logger } from '@hypertest/core';
import {
  blackboxTools, closeBlackboxResources, createEnvironmentRegistry, createSecretBroker, delegableTool, startRemoteToolWorker, urlTargetEnvironments, type BrokeredCredentialConfig,
  type RemoteToolWorker,
} from '@hypertest/tools';
import { resolveConfigPaths, validateConfig } from './config.ts';
import { resolveEnvironments } from './environments.ts';
import { mcpServerConfigs } from './tool-config.ts';
import type { HypertestConfig } from './contracts.ts';

/**
 * (row 246) `hypertest tool-worker`: a remote tool worker composed from a Hypertest configuration — its environments (and
 * allowlisted URL targets), brokered credentials, http allowlist, browser and MCP servers — executing exactly the
 * requested black-box tools (no side-effect binding) for callers that hold the shared secret (`secretEnv`). The worker
 * keeps no ledger and no evidence: it returns the outcome and evidence of each call to the deployment that governs it.
 */
export interface ToolWorkerOptions {
  workerId: string;
  /** Tool ids to execute (each must be a delegable black-box tool of the configuration). */
  tools: string[];
  /** The NAME of the variable holding the shared secret (≥ 16 characters). */
  secretEnv: string;
  host?: string;
  port?: number;
  env?: Record<string, string | undefined>;
  logger?: Logger;
}

export interface StartedToolWorker extends RemoteToolWorker {
  tools: string[];
}

export async function startToolWorker(input: HypertestConfig, options: ToolWorkerOptions): Promise<StartedToolWorker> {
  const errors = validateConfig(input);
  if (errors.length > 0) throw new HypertestError('invalid_argument', `invalid configuration:\n  - ${errors.join('\n  - ')}`, { details: { errors } });
  const config = resolveConfigPaths(input, process.cwd());
  const env = options.env ?? process.env;
  const logger = options.logger ?? jsonLogger({ level: config.observability?.logLevel ?? 'info', fields: { component: 'hypertest-tool-worker' } });
  const secret = env[options.secretEnv];
  if (!secret) throw new HypertestError('precondition_failed', `the shared secret variable ${options.secretEnv} is not set`);
  if (secret.length < 16) throw new HypertestError('invalid_argument', `the shared secret in ${options.secretEnv} must be at least 16 characters`);
  if (options.tools.length === 0) throw new HypertestError('invalid_argument', 'name at least one tool to execute (--tools)');
  const operator = resolveEnvironments(config.environments ?? [], env, logger);
  const environments = createEnvironmentRegistry([...operator, ...urlTargetEnvironments(config.tools?.httpAllowlist, operator, config.tools?.urlEnvironmentClass !== undefined ? { remoteClass: config.tools.urlEnvironmentClass } : {})]);
  const secrets = createSecretBroker({
    credentials: (config.environments ?? []).flatMap((e) => (e.credentials ?? []).map((c) => ({ ...c, environmentId: e.environmentId }) as BrokeredCredentialConfig)),
    env,
    logger,
  });
  const stateDir = await mkdtemp(join(tmpdir(), 'ht-tool-worker-'));
  const all = blackboxTools({
    stateDir,
    ...(config.tools?.httpAllowlist ? { httpAllowlist: [...config.tools.httpAllowlist] } : {}),
    ...(config.tools?.enableBrowser ? { enableBrowser: true } : {}),
    mcpServers: mcpServerConfigs(config, env, logger),
  });
  const byId = new Map(all.map((t) => [t.id, t]));
  const chosen = options.tools.map((id) => {
    const t = byId.get(id);
    if (!t) throw new HypertestError('invalid_argument', `tool ${id} is not a black-box tool of this configuration (known: ${[...byId.keys()].filter((k) => delegableTool(byId.get(k)!)).join(', ')})`);
    if (!delegableTool(t)) throw new HypertestError('invalid_argument', `tool ${id} has a side-effect binding and cannot run on a remote worker`);
    return t;
  });
  let worker: RemoteToolWorker;
  try {
    worker = await startRemoteToolWorker({ workerId: options.workerId, tools: chosen, secret, environments, secrets, logger, ...(options.host ? { host: options.host } : {}), ...(options.port !== undefined ? { port: options.port } : {}) });
  } catch (e) {
    await rm(stateDir, { recursive: true, force: true });
    throw e;
  }
  return {
    url: worker.url,
    workerId: worker.workerId,
    tools: chosen.map((t) => t.id),
    get executed() {
      return worker.executed;
    },
    async close() {
      await worker.close();
      await closeBlackboxResources();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
