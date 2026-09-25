import { HypertestError, sleep, type JsonValue } from '@hypertest/core';
import { estimateTokens, type AssistantMessage, type ToolCall } from '@hypertest/domain';
import type { ModelCallRequest, ModelCallResponse, ModelProvider, ModelUsage, ScriptedBrain, ScriptedProviderOptions, ScriptedReply, StreamDelta } from './contracts.ts';
import { providerFault } from './errors.ts';
import { guardDelta, monoMs, withDeadline } from './transport.ts';
import { estimateOutputTokens } from './usage.ts';
import { MODEL_PACKAGE_NAME, MODEL_PACKAGE_VERSION } from './version.ts';

/**
 * Deterministic provider driven by "brains" (pure functions of the request). Used by unit tests, PoCs
 * and eval arms in CI. `callIndex` is the 0-based index of the call on this provider instance;
 * generated tool-call ids are `call_<n>` with n counting from 1 per instance.
 */
export class ScriptedProvider implements ModelProvider {
  readonly providerId: string;
  readonly adapterInfo = { package: `${MODEL_PACKAGE_NAME}#scripted`, version: MODEL_PACKAGE_VERSION };
  readonly #brain: ScriptedBrain | undefined;
  readonly #brains: Record<string, ScriptedBrain>;
  readonly #latencyMs: number;
  #calls = 0;
  #toolCallSeq = 0;
  /** Every request received, in order (for assertions). */
  readonly requests: ModelCallRequest[] = [];

  constructor(options: ScriptedProviderOptions = {}) {
    this.providerId = options.providerId ?? 'scripted';
    this.#brain = options.brain;
    this.#brains = options.brains ?? {};
    this.#latencyMs = options.latencyMs ?? 0;
  }

  get callCount(): number {
    return this.#calls;
  }

  async complete(request: ModelCallRequest, options: { onDelta?: (d: StreamDelta) => void } = {}): Promise<ModelCallResponse> {
    const started = monoMs();
    const brain = Object.hasOwn(this.#brains, request.model) ? this.#brains[request.model] : this.#brain;
    if (!brain) throw new HypertestError('not_found', `scripted provider ${this.providerId}: no brain for model ${request.model}`, { retryable: false });
    const callIndex = this.#calls++;
    this.requests.push(request);
    const run = async (signal: AbortSignal): Promise<ScriptedReply> => {
      if (this.#latencyMs > 0) await sleep(this.#latencyMs, signal);
      return brain(request, { callIndex, routeModel: request.model });
    };
    const reply = await withDeadline(
      { timeoutMs: request.timeoutMs ?? 600_000, signal: request.signal, what: `${this.providerId} ${request.model}`, normalize: (e) => (e instanceof HypertestError ? e : new HypertestError('internal', `scripted brain threw: ${e instanceof Error ? e.message : String(e)}`, { retryable: false, cause: e })) },
      run,
    );
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
      throw new HypertestError('internal', `scripted provider ${this.providerId}: brain returned ${reply === null ? 'null' : typeof reply} instead of a reply object`, { retryable: false });
    }
    if ('error' in reply) {
      throw providerFault(reply.error, reply.message ?? `scripted ${reply.error}`, { provider: this.providerId, model: request.model, callIndex });
    }
    const onDelta = guardDelta(options.onDelta);
    const message: AssistantMessage = { role: 'assistant', content: [] };
    if (reply.text) {
      message.content.push({ type: 'text', text: reply.text });
      onDelta?.({ type: 'text', text: reply.text });
    }
    if (reply.toolCalls && reply.toolCalls.length > 0) {
      message.toolCalls = reply.toolCalls.map((c): ToolCall => {
        const id = c.id ?? `call_${++this.#toolCallSeq}`;
        const args: JsonValue = c.arguments;
        onDelta?.({ type: 'tool_call_start', id, name: c.name });
        onDelta?.({ type: 'tool_call_args', id, text: JSON.stringify(args) });
        return { id, name: c.name, arguments: args };
      });
    }
    const usage: ModelUsage = {
      inputTokens: estimateTokens(request.messages, request.tools),
      outputTokens: estimateOutputTokens(message),
      cachedInputTokens: 0,
      ...definedUsage(reply.usage),
    };
    return {
      message,
      stopReason: reply.stopReason ?? (message.toolCalls?.length ? 'tool_use' : 'end_turn'),
      usage,
      providerResponseId: `${this.providerId}-${callIndex}`,
      latencyMs: Math.round(monoMs() - started),
    };
  }
}

function definedUsage(u: Partial<ModelUsage> | undefined): Partial<ModelUsage> {
  const out: Partial<ModelUsage> = {};
  if (!u) return out;
  for (const [k, v] of Object.entries(u)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
