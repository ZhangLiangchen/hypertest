import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { HypertestError, abortReason, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { SandboxRunner, SandboxSession, ToolContext, ToolOutcome, ToolSpec, WorkspaceManager } from '../contracts.ts';
import { spawnSession } from '../whitebox/process.ts';

/**
 * ACP agents (technology-selection §Tool Runtime "ACP Agent"): an external coding agent (Claude Code, Codex, Gemini CLI, …
 * anything speaking the Agent Client Protocol: JSON-RPC 2.0 over newline-delimited stdio) driven by Hypertest as its
 * CLIENT. `acp.<agent>.prompt` starts the agent process — by default INSIDE the calling agent's workspace sandbox (the
 * same isolation as shell.exec: confined cwd, scrubbed environment, network namespace, jail) — opens one session on the
 * workspace and sends the prompt. The agent reaches files only through the client methods Hypertest serves, confined to
 * that workspace: `fs/read_text_file`, and `fs/write_text_file` only for a writable workspace (an isolated worktree);
 * a terminal is not offered, and every `session/request_permission` is answered with a rejection (the external agent's
 * own tools are never authorized by Hypertest). The call is a `write_workspace` effect on the workspace (capability,
 * policy permit, freshness as for fs.write); its transcript (messages, tool calls, refused permissions, files read and
 * written) is `acp-transcript` evidence and the resulting workspace diff `git-diff` evidence.
 */

export const ACP_PROTOCOL_VERSION = 1;
const MAX_PROMPT_CHARS = 64 * 1024;
const MAX_TRANSCRIPT_CHARS = 256 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** (review) Longest protocol line accepted from an agent (a line never ends otherwise: memory would grow without bound). */
export const MAX_ACP_LINE_CHARS = 16 * 1024 * 1024;

export interface AcpAgentConfig {
  /** Agent id (tool id segment: `acp.<id>.prompt`). */
  id: string;
  command: string;
  args?: string[];
  /** Variables passed to the agent (resolved by the composition from `*Env` names; never logged). */
  env?: Record<string, string>;
  /**
   * Where the agent process runs: `workspace` (default) — in the calling agent's workspace sandbox; `host` — a plain host
   * process with a scrubbed environment (explicit operator opt-out, e.g. an agent that needs its model provider's network).
   */
  sandbox?: 'workspace' | 'host';
  /** Wall-clock bound of one prompt (default 15 min). */
  timeoutMs?: number;
  /** Set by the composition when the agent cannot run as configured (a missing `*Env` variable): calls fail unavailable. */
  unavailableReason?: string;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

interface RpcHandlers {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
}

/** Minimal JSON-RPC 2.0 peer over newline-delimited JSON streams. */
class JsonRpcPeer {
  readonly #out: NodeJS.WritableStream;
  readonly #pending = new Map<number, Pending>();
  readonly #handlers: RpcHandlers;
  #next = 1;
  #buf = '';
  #closed: Error | undefined;

  constructor(out: NodeJS.WritableStream, input: NodeJS.ReadableStream, handlers: RpcHandlers) {
    this.#out = out;
    this.#handlers = handlers;
    input.on('data', (c: Buffer) => this.#onData(c.toString('utf8')));
    input.on('end', () => this.close(new HypertestError('unavailable', 'the agent closed its output')));
  }

  #write(msg: Record<string, unknown>): void {
    if (this.#closed) return;
    this.#out.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  close(reason: Error): void {
    if (this.#closed) return;
    this.#closed = reason;
    for (const p of this.#pending.values()) p.reject(reason);
    this.#pending.clear();
  }

  #onData(chunk: string): void {
    if (this.#closed) return;
    this.#buf += chunk;
    for (;;) {
      const nl = this.#buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (line === '') continue;
      let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue; // not a protocol line (agents may log to stdout by mistake): ignored
      }
      if (msg.method !== undefined && msg.id !== undefined) {
        const id = msg.id;
        this.#handlers.request(msg.method, msg.params).then(
          (result) => this.#write({ id, result: result ?? null }),
          (e: unknown) => this.#write({ id, error: { code: (e as { rpcCode?: number }).rpcCode ?? -32000, message: (e as Error).message } }),
        );
      } else if (msg.method !== undefined) {
        this.#handlers.notify(msg.method, msg.params);
      } else if (typeof msg.id === 'number') {
        const p = this.#pending.get(msg.id);
        if (!p) continue;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new HypertestError('unavailable', `agent error ${msg.error.code}: ${msg.error.message}`), { rpcCode: msg.error.code }));
        else p.resolve(msg.result);
      }
    }
    // (review) bounded: an agent that never ends its line is a protocol failure, not a reason to buffer forever
    if (this.#buf.length > MAX_ACP_LINE_CHARS) {
      this.#buf = '';
      this.close(new HypertestError('unavailable', `the agent sent a protocol line longer than ${MAX_ACP_LINE_CHARS} characters`));
    }
  }
}

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { rpcCode: code });
}

/** A workspace path the agent named (absolute, inside the workspace root), confined by the WorkspaceManager. */
async function confined(workspaces: WorkspaceManager, ctx: ToolContext, path: unknown): Promise<{ abs: string; rel: string }> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw rpcError(-32602, 'path must be an absolute path inside the session cwd');
  const rel = relative(ctx.workspace.root, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw rpcError(-32001, `path ${path} is outside the workspace`);
  try {
    return { abs: await workspaces.resolvePath(ctx.workspace, rel.split(sep).join('/')), rel: rel.split(sep).join('/') };
  } catch (e) {
    throw rpcError(-32001, `path ${path} refused: ${(e as Error).message}`);
  }
}

const PROMPT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_CHARS, description: 'The task for the external coding agent (it works on your workspace).' },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 3_600_000 },
  },
};

/** The `acp.<agent>.prompt` tools of the configured ACP agents. */
export function acpTools(agents: readonly AcpAgentConfig[], options: { sandbox: SandboxRunner; workspaces: WorkspaceManager }): ToolSpec[] {
  const ids = new Set<string>();
  return agents.map((agent) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(agent.id)) throw new HypertestError('invalid_argument', `ACP agent id ${JSON.stringify(agent.id)} must match [A-Za-z0-9][A-Za-z0-9_-]{0,23}`);
    if (ids.has(agent.id)) throw new HypertestError('invalid_argument', `duplicate ACP agent ${agent.id}`);
    ids.add(agent.id);
    if (typeof agent.command !== 'string' || agent.command === '') throw new HypertestError('invalid_argument', `ACP agent ${agent.id} needs a command`);
    const spec: ToolSpec<{ prompt: string; timeoutMs?: number }> = {
      id: `acp.${agent.id}.prompt`,
      title: `ACP agent ${agent.id}`,
      description:
        `Ask the external coding agent "${agent.id}" (Agent Client Protocol) to work on YOUR workspace: it reads files and — in an isolated worktree — writes them through Hypertest (confined to the workspace; no terminal; its own tool permissions are refused). Returns its answer, the files it wrote and the diff (acp-transcript + git-diff evidence). Verify its changes yourself (test.run) before relying on them.`,
      inputSchema: PROMPT_SCHEMA,
      effect: 'write_workspace',
      riskClass: 'medium',
      resources: (_input, ctx) => [ctx.workspace.resourcePrefix],
      evidenceTypes: ['acp-transcript', 'git-diff'],
      timeoutMs: agent.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      execute: (input, ctx) => runAcpPrompt(agent, input, ctx, options),
    };
    return spec as ToolSpec;
  });
}

async function runAcpPrompt(agent: AcpAgentConfig, input: { prompt: string; timeoutMs?: number }, ctx: ToolContext, options: { sandbox: SandboxRunner; workspaces: WorkspaceManager }): Promise<ToolOutcome> {
  if (agent.unavailableReason !== undefined) return { status: 'failed', error: { code: 'unavailable', message: `ACP agent ${agent.id} is unavailable: ${agent.unavailableReason}` } };
  const ws = ctx.workspace;
  const timeoutMs = input.timeoutMs ?? agent.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = [agent.command, ...(agent.args ?? [])];
  let session: SandboxSession;
  try {
    if ((agent.sandbox ?? 'workspace') === 'workspace') {
      if (!options.sandbox.session) return { status: 'failed', error: { code: 'unsupported', message: `the ${options.sandbox.kind ?? 'configured'} sandbox cannot host an interactive ACP agent; configure sandbox: host for agent ${agent.id} explicitly` } };
      session = await options.sandbox.session(ws, command, { cwd: '.', ...(agent.env ? { env: agent.env } : {}), signal: ctx.signal, timeoutMs: timeoutMs + 5000 });
    } else {
      session = spawnSession({
        argv: command, cwd: ws.root, signal: ctx.signal, timeoutMs: timeoutMs + 5000,
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: ws.tempDir ?? ws.root, LANG: process.env['LANG'] ?? 'C.UTF-8', HYPERTEST_ACP_CLIENT: '1', ...(agent.env ?? {}) },
      });
    }
  } catch (e) {
    if (ctx.signal.aborted) throw abortReason(ctx.signal);
    return { status: 'failed', error: { code: e instanceof HypertestError ? e.code : 'unavailable', message: `ACP agent ${agent.id} could not be started: ${(e as Error).message}` } };
  }
  let stderr = '';
  session.stderr.on('data', (c: Buffer) => {
    if (stderr.length < 16_384) stderr += c.toString('utf8');
  });
  const transcript = { messages: '', thoughts: '', toolCalls: [] as Array<{ toolCallId: string; title?: string; kind?: string; status?: string }>, plan: [] as JsonValue[], permissionsRefused: [] as Array<{ title?: string; kind?: string }>, filesRead: [] as string[], filesWritten: [] as Array<{ path: string; sha256: string; bytes: number }>, refused: [] as string[] };
  let sessionId: string | undefined;
  const peer = new JsonRpcPeer(session.stdin, session.stdout, {
    async request(method, params) {
      const p = (params ?? {}) as Record<string, unknown>;
      if (sessionId !== undefined && p['sessionId'] !== undefined && p['sessionId'] !== sessionId) throw rpcError(-32602, 'unknown session');
      switch (method) {
        case 'fs/read_text_file': {
          let target: { abs: string; rel: string };
          try {
            target = await confined(options.workspaces, ctx, p['path']);
          } catch (e) {
            transcript.refused.push(`read ${String(p['path'])}: ${(e as Error).message}`);
            throw e;
          }
          const text = await readFile(target.abs, 'utf8').catch((e: unknown) => {
            throw rpcError(-32002, `cannot read ${target.rel}: ${(e as Error).message}`);
          });
          transcript.filesRead.push(target.rel);
          const line = typeof p['line'] === 'number' && p['line'] >= 1 ? p['line'] : 1;
          const limit = typeof p['limit'] === 'number' && p['limit'] >= 0 ? p['limit'] : undefined;
          const lines = text.split('\n');
          const content = line === 1 && limit === undefined ? text : lines.slice(line - 1, limit === undefined ? undefined : line - 1 + limit).join('\n');
          return { content };
        }
        case 'fs/write_text_file': {
          if (ws.readOnly) {
            transcript.refused.push(`write ${String(p['path'])}: the workspace is read-only`);
            throw rpcError(-32003, `workspace ${ws.workspaceId} is read-only: writes need an isolated worktree`);
          }
          let target: { abs: string; rel: string };
          try {
            target = await confined(options.workspaces, ctx, p['path']);
          } catch (e) {
            transcript.refused.push(`write ${String(p['path'])}: ${(e as Error).message}`);
            throw e;
          }
          if (typeof p['content'] !== 'string') throw rpcError(-32602, 'content must be a string');
          const bytes = Buffer.byteLength(p['content']);
          if (bytes > MAX_FILE_BYTES) throw rpcError(-32004, `file of ${bytes} bytes exceeds ${MAX_FILE_BYTES}`);
          await mkdir(dirname(target.abs), { recursive: true });
          await writeFile(target.abs, p['content']);
          transcript.filesWritten.push({ path: target.rel, sha256: createHash('sha256').update(p['content']).digest('hex'), bytes });
          return null;
        }
        case 'session/request_permission': {
          // the external agent's own tools (terminal, network, …) are never authorized by Hypertest
          const tc = (p['toolCall'] ?? {}) as { title?: string; kind?: string };
          transcript.permissionsRefused.push({ ...(tc.title !== undefined ? { title: String(tc.title) } : {}), ...(tc.kind !== undefined ? { kind: String(tc.kind) } : {}) });
          const opts = Array.isArray(p['options']) ? (p['options'] as Array<{ optionId?: string; kind?: string }>) : [];
          const reject = opts.find((o) => o.kind === 'reject_once') ?? opts.find((o) => o.kind === 'reject_always');
          return reject?.optionId !== undefined ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
        }
        default:
          // terminals and anything else are not offered (clientCapabilities.terminal = false)
          throw rpcError(-32601, `method ${method} is not offered by the Hypertest ACP client`);
      }
    },
    notify(method, params) {
      if (method !== 'session/update') return;
      const u = ((params ?? {}) as { update?: Record<string, unknown> }).update ?? {};
      const kind = u['sessionUpdate'];
      const text = (c: unknown) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: string }).text ?? '') : '');
      if (kind === 'agent_message_chunk' && transcript.messages.length < MAX_TRANSCRIPT_CHARS) transcript.messages += text(u['content']);
      else if (kind === 'agent_thought_chunk' && transcript.thoughts.length < MAX_TRANSCRIPT_CHARS) transcript.thoughts += text(u['content']);
      else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const id = String(u['toolCallId'] ?? '');
        const prior = transcript.toolCalls.find((t) => t.toolCallId === id);
        const entry = prior ?? { toolCallId: id };
        if (u['title'] !== undefined) entry.title = String(u['title']);
        if (u['kind'] !== undefined) entry.kind = String(u['kind']);
        if (u['status'] !== undefined) entry.status = String(u['status']);
        if (!prior && transcript.toolCalls.length < 500) transcript.toolCalls.push(entry);
      } else if (kind === 'plan' && Array.isArray(u['entries'])) transcript.plan = JSON.parse(JSON.stringify(u['entries'])) as JsonValue[];
    },
  });
  session.exited.then(() => peer.close(new HypertestError('unavailable', `ACP agent ${agent.id} exited${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`)), () => undefined);

  let stopReason: string | undefined;
  let failure: { code: string; message: string } | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new HypertestError('timeout', `ACP agent ${agent.id} did not finish within ${timeoutMs} ms`)), timeoutMs);
    t.unref();
    void session.exited.then(() => clearTimeout(t));
  });
  deadline.catch(() => undefined);
  try {
    const init = (await Promise.race([peer.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: !ws.readOnly }, terminal: false } }), deadline])) as { protocolVersion?: number };
    if (typeof init?.protocolVersion !== 'number') throw new HypertestError('unavailable', 'the agent did not negotiate a protocol version');
    const created = (await Promise.race([peer.request('session/new', { cwd: ws.root, mcpServers: [] }), deadline])) as { sessionId?: string };
    if (typeof created?.sessionId !== 'string') throw new HypertestError('unavailable', 'the agent returned no session id');
    sessionId = created.sessionId;
    const answer = (await Promise.race([peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input.prompt }] }), deadline])) as { stopReason?: string };
    stopReason = typeof answer?.stopReason === 'string' ? answer.stopReason : 'unknown';
  } catch (e) {
    if (ctx.signal.aborted) {
      if (sessionId !== undefined) peer.notify('session/cancel', { sessionId });
      await session.kill();
      throw abortReason(ctx.signal);
    }
    if (sessionId !== undefined) peer.notify('session/cancel', { sessionId });
    failure = { code: e instanceof HypertestError ? e.code : 'unavailable', message: (e as Error).message };
  } finally {
    peer.close(new HypertestError('cancelled', 'session finished'));
    await session.kill();
  }
  // what the agent left in the workspace: the diff against the workspace's base (isolated worktrees)
  let diff = '';
  try {
    diff = ws.readOnly ? '' : await options.workspaces.diff(ws);
  } catch {
    diff = '';
  }
  const record = {
    agent: agent.id,
    sandbox: agent.sandbox ?? 'workspace',
    stopReason: stopReason ?? null,
    failure: failure ?? null,
    message: transcript.messages.slice(0, MAX_TRANSCRIPT_CHARS),
    toolCalls: transcript.toolCalls,
    plan: transcript.plan,
    permissionsRefused: transcript.permissionsRefused,
    filesRead: [...new Set(transcript.filesRead)],
    filesWritten: transcript.filesWritten,
    refused: transcript.refused,
  };
  const scrub = (t: string) => (ctx.secrets ? ctx.secrets.redact(t) : t);
  const evidence = await ctx.recordEvidence({
    evidenceType: 'acp-transcript',
    data: scrub(JSON.stringify({ ...record, thoughts: transcript.thoughts, stderr })),
    mimeType: 'application/json',
    summary: `ACP ${agent.id}: ${stopReason ?? failure?.code ?? 'no answer'}; ${transcript.filesWritten.length} file(s) written, ${transcript.permissionsRefused.length} permission(s) refused`.slice(0, 500),
    structured: JSON.parse(scrub(JSON.stringify(record))) as JsonValue,
    provenance: { target: `acp:${agent.id}`, command },
  });
  const refs = [evidence.evidenceId];
  if (diff !== '') {
    const d = await ctx.recordEvidence({ evidenceType: 'git-diff', data: diff, mimeType: 'text/x-diff', summary: `diff after ACP agent ${agent.id}: ${transcript.filesWritten.map((f) => f.path).join(', ')}`.slice(0, 500), parentEvidenceIds: [evidence.evidenceId] });
    refs.push(d.evidenceId);
  }
  const structured = { stopReason: stopReason ?? null, message: scrub(transcript.messages.slice(0, 8192)), filesWritten: transcript.filesWritten.map((f) => f.path), permissionsRefused: transcript.permissionsRefused.length, refused: transcript.refused, evidenceId: evidence.evidenceId };
  if (failure) return { status: failure.code === 'timeout' ? 'timeout' : 'failed', structured: structured as unknown as JsonValue, error: failure, evidenceRefs: refs };
  return { status: 'success', structured: structured as unknown as JsonValue, text: `${structured.message}\n[ACP ${agent.id}: ${stopReason}; wrote ${structured.filesWritten.join(', ') || 'nothing'}; evidence ${refs.join(', ')}]`, evidenceRefs: refs };
}
