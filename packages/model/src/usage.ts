import { estimateTokens, type AssistantMessage, type ChatMessage, type ToolDefinition } from '@hypertest/domain';
import type { ModelCapabilityProfile, ModelUsage } from './contracts.ts';

/**
 * USD cost of a call from per-million-token prices. An undeclared price is UNKNOWN (A[2]: never $0) and, like non-finite
 * inputs, yields NaN (callers fail closed: a cost-limited request is never routed to it, usage carries no cost).
 */
export function estimateCostUsd(profile: Pick<ModelCapabilityProfile, 'costPerMillionInputUsd' | 'costPerMillionOutputUsd'>, inputTokens: number, outputTokens: number): number {
  const inPrice = profile.costPerMillionInputUsd;
  const outPrice = profile.costPerMillionOutputUsd;
  if (typeof inPrice !== 'number' || typeof outPrice !== 'number') return Number.NaN;
  return (Math.max(0, inputTokens) * inPrice + Math.max(0, outputTokens) * outPrice) / 1_000_000;
}

/** Whether a route declares both prices (finite, ≥ 0): its cost is known. */
export function costKnown(profile: Pick<ModelCapabilityProfile, 'costPerMillionInputUsd' | 'costPerMillionOutputUsd'>): boolean {
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return ok(profile.costPerMillionInputUsd) && ok(profile.costPerMillionOutputUsd);
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
