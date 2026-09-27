/**
 * The DeepSeek Harness kernel a DshEngine drives (package-private). One cordis root per engine with exactly the services
 * the DSH agent loop needs — `agents` (dsh-agent), `sessions` (dsh-session, in memory), `llm` (dsh-llm), `systemPrompt`,
 * `tools` (dsh-tools) and `agentLoop` (dsh-agent-loop, the only concrete loop) — and nothing that owns a Hypertest concern:
 * no provider adapter (the only route, `hypertest`, is the host ModelInvoker), no tool plugin (tools are the host
 * dispatcher's, registered per agent), no persistence (the portable SessionStore is the truth), no retry, compaction,
 * permission or sandbox plugin (routing, context and policy are the host's).
 *
 * Every Hypertest turn gets its own DSH agent (a fresh session seeded with the transcript projection), created through the
 * public factory (`ctx.agents.create`) and disposed when the turn ends; its model steps are served by `StepHandler`s keyed
 * by the DSH session id the loop stamps on each request (`GenerateOptions.sessionId`).
 */
import { Context, type Message as CordisLogMessage } from '@deepseek-ai/cordis';
import AgentRegistry, { type AgentHandle, type AgentSetup } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { HypertestError, type Logger } from '@hypertest/core';
import { HOST_MODEL, HOST_PROVIDER } from './convert.ts';

/** Serves the model requests of one DSH agent (one Hypertest turn). */
export type StepHandler = (options: GenerateOptions) => AsyncIterable<StreamChunk>;

/** The `hypertest` provider route: DSH's model requests are answered by the Hypertest turn that owns the session. */
class HostModelAdapter extends LlmAdapter {
  readonly #handlers: ReadonlyMap<string, StepHandler>;

  constructor(handlers: ReadonlyMap<string, StepHandler>) {
    super();
    this.#handlers = handlers;
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Hypertest host ModelInvoker' };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const handler = options.sessionId === undefined ? undefined : this.#handlers.get(options.sessionId);
    if (!handler) throw new Error(`no Hypertest turn serves DSH session ${String(options.sessionId)}`);
    yield* handler(options);
  }
}

function logText(message: CordisLogMessage): string {
  return message.args.map((a: unknown) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' ');
}

export interface DshKernelOptions {
  /** DSH's bounded rolling pool of parallel-safe calls per step (the ABI's PARALLEL_TOOL_CONCURRENCY). */
  maxParallelToolCalls: number;
  /** Receives DSH's (cordis) log records: errors/warnings as warnings, the rest at debug level. */
  logger: Logger;
}

export class DshKernel {
  readonly #root: Context;
  readonly #handlers: Map<string, StepHandler>;

  private constructor(root: Context, handlers: Map<string, StepHandler>) {
    this.#root = root;
    this.#handlers = handlers;
  }

  /** Boots the kernel; a plugin that fails to load rejects (the partially booted root is disposed). */
  static async boot(options: DshKernelOptions): Promise<DshKernel> {
    const root = new Context();
    root.logger.exporter({
      colors: false,
      levels: { default: 3 },
      export: (message: CordisLogMessage) => {
        const fields = { dsh: message.name, level: message.type };
        if (message.type === 'error' || message.type === 'warn') options.logger.warn(`dsh: ${logText(message)}`, fields);
        else options.logger.debug(`dsh: ${logText(message)}`, fields);
      },
    });
    try {
      await root.plugin(AgentRegistry);
      await root.plugin(SessionStore);
      await root.plugin(LlmRuntime);
      await root.plugin(SystemPrompt);
      await root.plugin(ToolRuntime);
      await root.plugin(AgentLoop, { agents: [], maxParallelToolCalls: options.maxParallelToolCalls });
      if (!root.agents || !root.sessions || !root.llm || !root.tools || !root.systemPrompt || !root.agentLoop) {
        throw new HypertestError('internal', 'the DeepSeek Harness kernel did not provide agents, sessions, llm, tools, systemPrompt and agentLoop');
      }
      const handlers = new Map<string, StepHandler>();
      root.llm.registerAdapter([HOST_PROVIDER], new HostModelAdapter(handlers));
      return new DshKernel(root, handlers);
    } catch (e) {
      await root.fiber.dispose().catch(() => undefined);
      throw e;
    }
  }

  /**
   * Creates (and publishes) a DSH agent over a fresh session seeded with `seed`; `setup` composes its scoped world before
   * publication; `step` serves its model requests until `release`.
   */
  async createAgent(input: { sessionId: string; seed: readonly SessionEvent[]; setup: AgentSetup; step: StepHandler }): Promise<AgentHandle> {
    if (this.#handlers.has(input.sessionId)) throw new HypertestError('conflict', `DSH session ${input.sessionId} is already live`);
    this.#handlers.set(input.sessionId, input.step);
    try {
      return await this.#root.agents.create({ sessionId: SessionId(input.sessionId), seed: input.seed, agentOptions: { provider: HOST_PROVIDER, model: HOST_MODEL }, setup: input.setup });
    } catch (e) {
      this.#handlers.delete(input.sessionId);
      throw e;
    }
  }

  release(sessionId: string): void {
    this.#handlers.delete(sessionId);
  }

  /** Live DSH sessions (diagnostics; 0 between turns). */
  liveSessions(): number {
    return this.#root.sessions.list().length;
  }

  async close(): Promise<void> {
    this.#handlers.clear();
    await this.#root.fiber.dispose();
  }
}
