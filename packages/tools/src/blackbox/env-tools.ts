import type { JsonSchema } from '@hypertest/core';
import type { ToolSpec } from '../contracts.ts';
import { ENV_ID_SCHEMA, requireEnvironment } from './common.ts';
import type { EnvDeployInput, EnvFaultInput, EnvRestartInput } from './env-adapters.ts';

export const ENV_CONTROL_ADAPTER_ID = 'env.control';

function boundOnly(id: string): ToolSpec['execute'] {
  return async () => ({ status: 'failed', error: { code: 'precondition_failed', message: `${id} runs only through the ToolRuntime's SideEffectGateway` } });
}

function envBinding(operationType: string): NonNullable<ToolSpec['sideEffect']> {
  return {
    adapterId: ENV_CONTROL_ADAPTER_ID,
    operationType,
    target: (input) => ({ resourceKey: `env/${(input as { environmentId: string }).environmentId}`, kind: 'environment' }),
  };
}

const common = {
  resources: (input: { environmentId: string }) => [`env/${input.environmentId}`],
  environmentClass: (input: { environmentId: string }, ctx: Parameters<NonNullable<ToolSpec['environmentClass']>>[1]) => requireEnvironment(ctx.environments, input.environmentId).environmentClass,
};

/** `env.restart` (destructive/high): restart the environment's process/container/deployment; bumps its generation. */
export function envRestartTool(): ToolSpec<EnvRestartInput> {
  return {
    id: 'env.restart',
    title: 'Restart environment',
    description: 'Restart a registered environment (process supervisor, docker container or k8s deployment). Verified restarts bump the environment generation, invalidating older context snapshots. Call it directly: when the policy requires approval the call returns approval_required and the work waits for a human decision on exactly this call (do not file an approval yourself).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { environmentId: ENV_ID_SCHEMA, reason: { type: 'string', minLength: 1, maxLength: 1000 } },
      required: ['environmentId', 'reason'],
    },
    effect: 'destructive',
    riskClass: 'high',
    ...common,
    sideEffect: envBinding('env.restart'),
    timeoutMs: 180_000,
    execute: boundOnly('env.restart'),
  };
}

const FAULT_PARAMS: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ms: { type: 'number', minimum: 0, maximum: 60_000, description: 'latency: added delay per request' },
    jitterMs: { type: 'number', minimum: 0, maximum: 60_000 },
    probability: { type: 'number', minimum: 0, maximum: 1, description: 'latency: share of requests delayed (default 1)' },
    rate: { type: 'number', minimum: 0, maximum: 1, description: 'error_rate: share of requests answered with `status`' },
    status: { type: 'integer', minimum: 400, maximum: 599, description: 'error_rate: injected status (default 503)' },
    network: { type: 'string', description: 'network_disconnect (docker): the docker network to disconnect the container from' },
    delayMs: { type: 'number', minimum: 0, maximum: 60_000, description: 'netem (docker): added delay' },
    lossPct: { type: 'number', minimum: 0, maximum: 100, description: 'netem (docker): packet loss percentage' },
    interface: { type: 'string', description: 'netem (docker): interface inside the container (default eth0)' },
  },
};

/** `env.inject_fault` (destructive/high): latency or error-rate fault in front of the environment for durationMs. */
export function envInjectFaultTool(): ToolSpec<EnvFaultInput> {
  return {
    id: 'env.inject_fault',
    title: 'Inject environment fault',
    description:
      'Inject a time-boxed fault into an environment; it is reverted automatically after durationMs. Process-supervised environments: latency {ms, jitterMs?, probability?} or error_rate {rate, status?}. ' +
      'Docker environments: pause, kill, network_disconnect {network}, netem {delayMs?, jitterMs?, lossPct?, interface?}. Kubernetes (kubectl) environments: pod_delete, scale_zero, network_deny. ' +
      'Call it directly: when the policy requires approval the call returns approval_required and the work waits for a human decision on exactly this call (do not file an approval yourself).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        environmentId: ENV_ID_SCHEMA,
        kind: { type: 'string', enum: ['latency', 'error_rate', 'pause', 'kill', 'network_disconnect', 'netem', 'pod_delete', 'scale_zero', 'network_deny'] },
        params: FAULT_PARAMS,
        durationMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
      },
      required: ['environmentId', 'kind', 'params', 'durationMs'],
    },
    effect: 'destructive',
    riskClass: 'high',
    ...common,
    sideEffect: envBinding('env.inject_fault'),
    timeoutMs: 60_000,
    execute: boundOnly('env.inject_fault'),
  };
}

/** `env.deploy` (destructive/critical): deploy a build reference; verified deploys bump generation + buildDigest. */
export function envDeployTool(): ToolSpec<EnvDeployInput> {
  return {
    id: 'env.deploy',
    title: 'Deploy build to environment',
    description: 'Deploy buildRef to a registered environment (process: restart with BUILD_REF; kubectl: set every container image). Critical risk: normally requires approval. Call it directly: when the policy requires approval the call returns approval_required and the work waits for a human decision on exactly this call (do not file an approval yourself).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { environmentId: ENV_ID_SCHEMA, buildRef: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$' } },
      required: ['environmentId', 'buildRef'],
    },
    effect: 'destructive',
    riskClass: 'critical',
    ...common,
    sideEffect: envBinding('env.deploy'),
    timeoutMs: 600_000,
    execute: boundOnly('env.deploy'),
  };
}
