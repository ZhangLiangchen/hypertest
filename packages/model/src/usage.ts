import { estimateTokens, type AssistantMessage, type ChatMessage, type ToolDefinition } from '@hypertest/domain';
import type { ModelCapabilityProfile, ModelUsage } from './contracts.ts';

/** USD cost of a call from per-million-token prices. Non-finite inputs yield NaN (callers fail closed). */
export function estimateCostUsd(profile: Pick<ModelCapabilityProfile, 'costPerMillionInputUsd' | 'costPerMillionOutputUsd'>, inputTokens: number, outputTokens: number): number {
  return (Math.max(0, inputTokens) * profile.costPerMillionInputUsd + Math.max(0, outputTokens) * profile.costPerMillionOutputUsd) / 1_000_000;
}

/** Deterministic output-token estimate for providers that report no usage (never report 0 for real output). */
export function estimateOutputTokens(message: AssistantMessage): number {
  let chars = 0;
  for (const p of message.content) if (p.type === 'text') chars += p.text.length;
  for (const c of message.toolCalls ?? []) chars += c.name.length + JSON.stringify(c.arguments ?? null).length;
  if (message.reasoning?.text) chars += message.reasoning.text.length;
  return Math.ceil(chars / 4);
}

/** Usage estimate for a call without provider-reported usage. */
export function estimatedUsage(messages: readonly ChatMessage[], tools: readonly ToolDefinition[] | undefined, message: AssistantMessage): ModelUsage {
  return { inputTokens: estimateTokens(messages, tools), outputTokens: estimateOutputTokens(message), cachedInputTokens: 0 };
}

export function nonNegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}
