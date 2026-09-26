// Black-box tools and side-effect adapters (owned by the tools-blackbox implementer).
import type { SideEffectAdapter } from '@hypertest/operation';
import type { EnvironmentRegistry, ToolSpec } from '../contracts.ts';
import { browserTools, closeBrowserManagers } from './browser.ts';
import { DockerEnvAdapter, EnvControlAdapter, KubectlEnvAdapter, ProcessEnvAdapter } from './env-adapters.ts';
import { envDeployTool, envInjectFaultTool, envRestartTool } from './env-tools.ts';
import { httpRequestTool } from './http.ts';
import { HttpLoadAdapter, HttpLoadStopAdapter, loadObserveTool, loadStartTool, loadStopTool } from './load.ts';
import { McpToolBridge, type McpServerConfig } from './mcp.ts';
import { metricsQueryTool, metricsScrapeTool } from './metrics.ts';

/** MCP bridges created lazily by blackboxTools() (closed by closeBlackboxResources()). */
const lazyBridges = new Set<McpToolBridge>();

export interface BlackboxToolOptions {
  /** State directory shared with builtinSideEffectAdapters (load job dirs, evidence markers). */
  stateDir: string;
  /** Hosts http.request / metrics.* / browser.navigate may reach besides the addressed environment. */
  httpAllowlist?: string[];
  /** Include browser.* tools (Playwright + local Chromium). Default false. */
  enableBrowser?: boolean;
  chromiumPath?: string;
  /**
   * MCP servers whose `allowTools` are registered as lazily-connecting `mcp.<server>.<tool>` specs.
   * For full discovery (input schemas, all tools) use `new McpToolBridge({servers}).listTools()`.
   */
  mcpServers?: McpServerConfig[];
}

/**
 * Every black-box tool spec: http.request, metrics.query, metrics.scrape, load.start/observe/stop,
 * env.restart/inject_fault/deploy (+ browser.* when enabled, + lazy MCP tools when configured).
 * `stateDir` is optional at runtime (builtinTools() of the white-box half passes BuiltinToolOptions):
 * without it load.observe dedupes evidence in-process only.
 */
export function blackboxTools(options: BlackboxToolOptions): ToolSpec[] {
  const o: Partial<BlackboxToolOptions> = options ?? {};
  const allow = o.httpAllowlist !== undefined ? { httpAllowlist: o.httpAllowlist } : {};
  const load = typeof o.stateDir === 'string' && o.stateDir !== '' ? { stateDir: o.stateDir } : {};
  const specs: ToolSpec[] = [
    httpRequestTool(allow),
    metricsQueryTool(allow),
    metricsScrapeTool(allow),
    loadStartTool(allow),
    loadObserveTool(load),
    loadStopTool(load),
    envRestartTool(),
    envInjectFaultTool(),
    envDeployTool(),
  ] as ToolSpec[];
  if (o.enableBrowser === true) specs.push(...browserTools({ ...allow, ...(o.chromiumPath !== undefined ? { chromiumPath: o.chromiumPath } : {}) }));
  if (o.mcpServers && o.mcpServers.length > 0) {
    const bridge = new McpToolBridge({ servers: o.mcpServers });
    specs.push(...bridge.lazyTools());
    lazyBridges.add(bridge);
  }
  return specs;
}

/**
 * Releases process-wide black-box resources: MCP server processes of the lazy bridges created by
 * blackboxTools() and the browsers of the managers browserTools() owns. Call on shutdown (and in tests).
 */
export async function closeBlackboxResources(): Promise<void> {
  const bridges = [...lazyBridges];
  lazyBridges.clear();
  await Promise.all(bridges.map((b) => b.close()));
  await closeBrowserManagers();
}

/**
 * The built-in SideEffectAdapters: `load.http` (load generator), `load.http.stop`, `env.control` (the
 * router the env.* tools bind to) and its backends `env.process`, `env.docker`, `env.kubectl` (also
 * registered on their own for direct use).
 */
export function builtinSideEffectAdapters(options: { stateDir: string; environments: EnvironmentRegistry; kubectl?: string; docker?: string }): SideEffectAdapter[] {
  const processEnv = new ProcessEnvAdapter({ environments: options.environments });
  const docker = new DockerEnvAdapter({ environments: options.environments, ...(options.docker !== undefined ? { docker: options.docker } : {}) });
  const kubectl = new KubectlEnvAdapter({ environments: options.environments, ...(options.kubectl !== undefined ? { kubectl: options.kubectl } : {}) });
  return [
    new HttpLoadAdapter({ stateDir: options.stateDir, environments: options.environments }),
    new HttpLoadStopAdapter({ stateDir: options.stateDir, environments: options.environments }),
    new EnvControlAdapter({ environments: options.environments, backends: { process: processEnv, docker, kubectl } }),
    processEnv,
    docker,
    kubectl,
  ] as SideEffectAdapter[];
}

export { createEnvironmentRegistry } from '../whitebox/environments.ts';
export {
  ENV_ID_SCHEMA, OPERATION_ID_SCHEMA, CONTROL_PATH_PREFIX, checkEgress, checkHost, controlEndpointReason, environmentClassForUrl, hostMatches, isLoopbackHost, joinUrl, publicControlTarget, redactHeaders,
  redactJsonSecrets, redactUrl, splitControlTarget, type HostCheckInput,
} from './common.ts';
export { httpRequestTool, HTTP_REQUEST_INPUT_SCHEMA, NON_IDEMPOTENT_METHODS, EVIDENCE_BODY_LIMIT, type HttpRequestInput, type HttpRequestResult } from './http.ts';
export {
  parsePrometheusText, parsePromValue, histogramQuantile, histogramBuckets, histogramStats, summarizeMetrics, parsePrometheusApiResponse,
  type PromSample, type PromFamily, type PromMetricType, type PromParseResult, type PromParseError, type HistogramBucket, type HistogramStats, type MetricsSummary, type PromQueryResult, type PromSeries,
} from './prometheus.ts';
export { metricsQueryTool, metricsScrapeTool, type MetricsQueryInput, type MetricsScrapeInput } from './metrics.ts';
export {
  HttpLoadAdapter, HttpLoadStopAdapter, loadStartTool, loadObserveTool, loadStopTool, observeLoadJob, stopLoadJob, loadJobDir, resolveLoadTarget,
  LOAD_ADAPTER_ID, LOAD_STOP_ADAPTER_ID, LOADGEN_WORKER_PATH,
  type HttpLoadAdapterOptions, type LoadStartInput, type LoadJobSpec, type LoadJobState, type LoadJobStatus, type LoadJobObservation, type LoadStopObservation, type LoadToolOptions,
} from './load.ts';
export {
  startProcessSupervisor, normalizeFault, SUPERVISOR_CONTROL_PREFIX, OPERATION_HEADER, CONTROL_TOKEN_HEADER, PROCESS_SUPERVISOR_CLI_PATH,
  type ProcessSupervisor, type ProcessSupervisorOptions, type SupervisorOperation, type SupervisorFault, type SupervisorFaultKind,
} from './process-supervisor.ts';
export {
  ProcessEnvAdapter, DockerEnvAdapter, KubectlEnvAdapter, EnvControlAdapter, OPERATION_ANNOTATION, BUILD_REF_ANNOTATION, ENV_OPERATION_TYPES,
  type EnvInput, type EnvRestartInput, type EnvDeployInput, type EnvFaultInput, type EnvOperationType, type ProcessEnvAdapterOptions, type DockerEnvAdapterOptions, type KubectlEnvAdapterOptions,
  type EnvControlAdapterOptions, type ProcessEnvObservation, type DockerEnvObservation, type KubectlEnvObservation,
} from './env-adapters.ts';
export { envRestartTool, envInjectFaultTool, envDeployTool, ENV_CONTROL_ADAPTER_ID } from './env-tools.ts';
export {
  browserTools, BrowserSessionManager, defaultBrowserManager, closeBrowserManagers, chromiumExecutablePath, DEFAULT_CHROMIUM_PATH,
  type BrowserToolOptions, type BrowserManagerOptions, type BrowserNavigateInput, type BrowserEgressGuard, type BlockedRequest,
} from './browser.ts';
export { McpToolBridge, mcpToolId, sanitizeMcpSegment, normalizeMcpSchema, type McpServerConfig, type McpToolBridgeOptions } from './mcp.ts';
