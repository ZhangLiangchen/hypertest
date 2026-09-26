import { HypertestError, abortReason, noopLogger, sha256Hex, type JsonSchema, type JsonValue, type Logger } from '@hypertest/core';
import type { RiskClass, ToolEffect } from '@hypertest/domain';
import type { ToolContext, ToolOutcome, ToolSpec } from '../contracts.ts';
import { errorMessage } from './common.ts';

/**
 * MCP bridge: connects to MCP servers over stdio (@modelcontextprotocol/sdk Client + StdioClientTransport)
 * and exposes their tools as ToolSpecs `mcp.<server>.<tool>`, so every MCP call passes the Hypertest
 * pipeline (capability, policy, events, offload). Effect/risk are declared per server by the operator
 * (default external/medium), never by the server itself.
 */

export interface McpServerConfig {
  /** Server name (tool id segment). */
  name: string;
  command: string;
  args?: string[];
  /** Extra environment (merged over the SDK's safe default: HOME, LOGNAME, PATH, SHELL, TERM, USER). */
  env?: Record<string, string>;
  cwd?: string;
  effect?: ToolEffect;
  riskClass?: RiskClass;
  /** Only these MCP tool names are exposed (default: all). */
  allowTools?: string[];
  /** Environment class the server acts on (policy input; e.g. `sandbox`). */
  environmentClass?: string;
  /** Per-call timeout (default 60 s). */
  timeoutMs?: number;
}

export interface McpToolBridgeOptions {
  servers: McpServerConfig[];
  logger?: Logger;
  clientName?: string;
}

interface McpClientLike {
  onclose?: () => void;
  connect(transport: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<void>;
  listTools(params?: { cursor?: string }, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }>; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ content?: unknown; isError?: boolean; structuredContent?: unknown }>;
  close(): Promise<void>;
}

interface Connected {
  config: McpServerConfig;
  client: McpClientLike;
}

const SEGMENT_MAX = 24;

/** A tool-id segment from an arbitrary MCP name: `[A-Za-z0-9_-]`, no `__`, bounded, collision-resistant. */
export function sanitizeMcpSegment(raw: string, max = SEGMENT_MAX): string {
  let s = raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[^A-Za-z0-9]+/, '').replace(/[_-]+$/, '');
  if (s === '') s = 'x';
  if (s.length > max || s !== raw) {
    if (s.length > max - 7) s = s.slice(0, max - 7).replace(/[_-]+$/, '');
    // a short hash keeps distinct raw names distinct after sanitizing
    if (s !== raw) s = `${s}-${sha256Hex(raw).slice(0, 6)}`;
  }
  return s;
}

/** `mcp.<server>.<tool>` (valid ToolRegistry id, ≤ 64 chars as a model-visible name). */
export function mcpToolId(server: string, tool: string): string {
  return `mcp.${sanitizeMcpSegment(server)}.${sanitizeMcpSegment(tool, 32)}`;
}

/** MCP input schemas are draft-07-ish JSON Schema objects; drop `$schema` so the 2020-12 validator accepts them. */
export function normalizeMcpSchema(schema: unknown): JsonSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object' };
  const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
  if (rest['type'] === undefined) rest['type'] = 'object';
  return rest;
}

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (c?.['type'] === 'text' && typeof c['text'] === 'string') parts.push(c['text']);
    else if (c?.['type'] === 'image' || c?.['type'] === 'audio') parts.push(`[${String(c['type'])} ${String(c['mimeType'] ?? '')}, ${typeof c['data'] === 'string' ? Math.floor((c['data'].length * 3) / 4) : 0} bytes]`);
    else if (c?.['type'] === 'resource' || c?.['type'] === 'resource_link') {
      const r = (c['resource'] ?? c) as Record<string, unknown>;
      parts.push(typeof r['text'] === 'string' ? r['text'] : `[resource ${String(r['uri'] ?? '')}]`);
    }
  }
  return parts.join('\n');
}

/** Resolves with `p`, or rejects as soon as `signal` aborts (the shared work behind `p` keeps going). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Connections are per server: a server that cannot start only makes ITS tools unavailable, a tool call
 * spawns only its own server, and a server whose process exits is dropped and reconnected on next use.
 * A connection attempt is shared by concurrent callers and bounded by the server timeout, never by one
 * caller's abort signal (a cancelled call must not fail the others waiting on the same connect).
 */
export class McpToolBridge {
  readonly #o: McpToolBridgeOptions;
  readonly #logger: Logger;
  readonly #connected = new Map<string, Connected>();
  readonly #connecting = new Map<string, Promise<Connected>>();
  #closed = 0;

  constructor(options: McpToolBridgeOptions) {
    if (!options || !Array.isArray(options.servers)) throw new HypertestError('invalid_argument', 'McpToolBridge requires servers');
    const names = new Set<string>();
    for (const s of options.servers) {
      if (!s || typeof s.name !== 'string' || s.name === '' || typeof s.command !== 'string' || s.command === '') throw new HypertestError('invalid_argument', 'every MCP server needs a name and a command');
      const seg = sanitizeMcpSegment(s.name);
      if (names.has(seg)) throw new HypertestError('invalid_argument', `duplicate MCP server name ${s.name}`);
      names.add(seg);
    }
    this.#o = options;
    this.#logger = options.logger ?? noopLogger;
  }

  get connectedServers(): string[] {
    return [...this.#connected.keys()];
  }

  /**
   * Spawns and initializes every configured server (idempotent; concurrent calls share one attempt per
   * server). Rejects with the first server that cannot be started; the others stay connected and usable.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    const results = await Promise.allSettled(this.#o.servers.map((c) => raceAbort(this.#connectOne(c), signal)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  #connectOne(config: McpServerConfig): Promise<Connected> {
    const live = this.#connected.get(config.name);
    if (live) return Promise.resolve(live);
    let pending = this.#connecting.get(config.name);
    if (!pending) {
      pending = this.#open(config).finally(() => this.#connecting.delete(config.name));
      this.#connecting.set(config.name, pending);
    }
    return pending;
  }

  async #open(config: McpServerConfig): Promise<Connected> {
    const epoch = this.#closed;
    const [{ Client }, { StdioClientTransport }] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js')]);
    const params: ConstructorParameters<typeof StdioClientTransport>[0] = { command: config.command, args: config.args ?? [], stderr: 'pipe' };
    if (config.env) params.env = config.env;
    if (config.cwd) params.cwd = config.cwd;
    const transport = new StdioClientTransport(params);
    // drain stderr (an unread pipe would eventually block the server) into debug logs
    transport.stderr?.on('data', (chunk: Buffer) => this.#logger.debug('MCP server stderr', { server: config.name, text: chunk.toString('utf8').slice(0, 2000) }));
    const client = new Client({ name: this.#o.clientName ?? 'hypertest', version: '0.3.0' }, { capabilities: {} }) as unknown as McpClientLike;
    try {
      await client.connect(transport, { timeout: config.timeoutMs ?? 30_000 });
    } catch (e) {
      await transport.close().catch(() => undefined);
      throw new HypertestError('unavailable', `MCP server ${config.name} could not be started: ${errorMessage(e)}`, { cause: e });
    }
    const conn: Connected = { config, client };
    if (epoch !== this.#closed) {
      // close() ran while this server was starting: do not leak its process
      await client.close().catch(() => undefined);
      throw new HypertestError('unavailable', `MCP bridge was closed while ${config.name} was starting`);
    }
    // the server process exited or the pipe broke: forget it so the next call reconnects
    const onclose = client.onclose;
    client.onclose = () => {
      if (this.#connected.get(config.name) === conn) {
        this.#connected.delete(config.name);
        this.#logger.warn('MCP server connection closed', { server: config.name });
      }
      onclose?.();
    };
    this.#connected.set(config.name, conn);
    this.#logger.info('MCP server connected', { server: config.name });
    return conn;
  }

  /** Lists the (allowed) tools of every configured server as ToolSpecs (all servers must start). */
  async listTools(signal?: AbortSignal): Promise<ToolSpec[]> {
    await this.connect(signal);
    const specs: ToolSpec[] = [];
    for (const { config, client } of this.#o.servers.map((c) => this.#connected.get(c.name)).filter((c): c is Connected => c !== undefined)) {
      const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { ...(signal ? { signal } : {}), timeout: config.timeoutMs ?? 60_000 });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      for (const t of tools) {
        if (config.allowTools && !config.allowTools.includes(t.name)) continue;
        specs.push(this.#spec(config, t.name, t.description, normalizeMcpSchema(t.inputSchema)));
      }
    }
    return specs;
  }

  /**
   * ToolSpecs for the `allowTools` of each server WITHOUT connecting (open object input schema; the MCP
   * server validates the arguments). The bridge connects on first use. Servers without allowTools
   * cannot be listed synchronously and are rejected.
   */
  lazyTools(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const config of this.#o.servers) {
      if (!config.allowTools || config.allowTools.length === 0) {
        throw new HypertestError('invalid_argument', `MCP server ${config.name}: declare allowTools to register its tools synchronously, or use McpToolBridge.connect() + listTools()`);
      }
      for (const name of config.allowTools) specs.push(this.#spec(config, name, undefined, { type: 'object' }));
    }
    return specs;
  }

  #spec(config: McpServerConfig, toolName: string, description: string | undefined, inputSchema: JsonSchema): ToolSpec<Record<string, unknown>> {
    const id = mcpToolId(config.name, toolName);
    const resource = `mcp/${sanitizeMcpSegment(config.name)}/${sanitizeMcpSegment(toolName, 32)}`;
    return {
      id,
      title: `${config.name}: ${toolName}`,
      description: (description && description.trim() !== '' ? description : `MCP tool ${toolName} of server ${config.name}`).slice(0, 2000),
      inputSchema,
      effect: config.effect ?? 'external',
      riskClass: config.riskClass ?? 'medium',
      resources: () => [resource],
      ...(config.environmentClass !== undefined ? { environmentClass: () => config.environmentClass } : {}),
      timeoutMs: config.timeoutMs ?? 60_000,
      execute: (input, ctx) => this.#call(config, toolName, input, ctx),
    };
  }

  async #call(config: McpServerConfig, toolName: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    let conn: Connected;
    try {
      conn = await raceAbort(this.#connectOne(config), ctx.signal);
    } catch (e) {
      if (ctx.signal.aborted) throw abortReason(ctx.signal);
      return { status: 'failed', error: { code: 'unavailable', message: errorMessage(e) } };
    }
    let result: Awaited<ReturnType<McpClientLike['callTool']>>;
    try {
      result = await conn.client.callTool({ name: toolName, arguments: input ?? {} }, undefined, { signal: ctx.signal, timeout: config.timeoutMs ?? 60_000 });
    } catch (e) {
      if (ctx.signal.aborted) throw abortReason(ctx.signal);
      const msg = errorMessage(e);
      return { status: /timed out|timeout/i.test(msg) ? 'timeout' : 'failed', error: { code: /timed out|timeout/i.test(msg) ? 'timeout' : 'mcp_error', message: `MCP ${config.name}.${toolName}: ${msg}` } };
    }
    const text = renderContent(result.content);
    const outcome: ToolOutcome = { status: result.isError === true ? 'failed' : 'success', text };
    if (result.structuredContent !== undefined && result.structuredContent !== null) outcome.structured = JSON.parse(JSON.stringify(result.structuredContent)) as JsonValue;
    if (result.isError === true) outcome.error = { code: 'mcp_tool_error', message: text.slice(0, 2000) || `MCP tool ${toolName} reported an error` };
    return outcome;
  }

  /** Closes every client (terminating the server processes), including servers still starting. */
  async close(): Promise<void> {
    this.#closed++;
    const starting = [...this.#connecting.values()];
    const all = [...this.#connected.values()];
    this.#connected.clear();
    await Promise.all(all.map(({ client }) => client.close().catch(() => undefined)));
    await Promise.allSettled(starting);
  }
}
