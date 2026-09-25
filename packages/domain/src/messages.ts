import type { JsonSchema, JsonValue } from '@hypertest/core';

/**
 * Provider-neutral message IR ("normalized tool IR"). Every engine, provider adapter, context layer
 * and session store speaks this format; provider-native shapes never leak past @hypertest/model.
 */
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; dataBase64?: string; artifactUri?: string };

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonValue;
  /** Raw argument text when the provider returned unparsable JSON (reported back as a tool error). */
  rawArguments?: string;
}

/** Provider-specific continuation data; replayed only to routes with the same compatibility class. */
export interface OpaqueReasoning {
  compatibilityClass: string;
  data: JsonValue;
}

export type SystemMessage = { role: 'system'; content: string };
export type UserMessage = { role: 'user'; content: string | ContentPart[] };
export type AssistantMessage = { role: 'assistant'; content: ContentPart[]; toolCalls?: ToolCall[]; reasoning?: { text?: string; opaque?: OpaqueReasoning } };
export type ToolResultMessage = { role: 'tool'; toolCallId: string; toolName: string; content: string; isError?: boolean };
export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export function textOf(message: ChatMessage): string {
  if (message.role === 'system' || message.role === 'tool') return message.content;
  if (typeof message.content === 'string') return message.content;
  return message.content.map((p) => (p.type === 'text' ? p.text : `[image ${p.mimeType}]`)).join('');
}

/** Deterministic token estimate (≈4 chars/token + per-message overhead). Used for budgets and routing. */
export function estimateTokens(messages: readonly ChatMessage[], tools?: readonly ToolDefinition[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += textOf(m).length + 16;
    if (m.role === 'assistant' && m.toolCalls) for (const c of m.toolCalls) chars += c.name.length + JSON.stringify(c.arguments ?? null).length;
    if (m.role === 'assistant' && m.reasoning?.text) chars += m.reasoning.text.length;
  }
  for (const t of tools ?? []) chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  return Math.ceil(chars / 4);
}

/** Strips opaque reasoning that is incompatible with the target route (cross-model continuation rule). */
export function projectForRoute(messages: readonly ChatMessage[], compatibilityClass: string): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.reasoning?.opaque || m.reasoning.opaque.compatibilityClass === compatibilityClass) return m;
    const { opaque: _dropped, ...rest } = m.reasoning;
    const copy: AssistantMessage = { role: 'assistant', content: m.content };
    if (m.toolCalls) copy.toolCalls = m.toolCalls;
    if (rest.text !== undefined) copy.reasoning = { text: rest.text };
    return copy;
  });
}
