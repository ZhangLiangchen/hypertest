import { HypertestError } from '@hypertest/core';
import { estimateTokens, textOf, type ChatMessage } from '@hypertest/domain';

/** Throws invalid_argument unless `v` is a non-empty string. */
export function requireText(v: unknown, name: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) throw new HypertestError('invalid_argument', `${name} must be a non-empty string`);
}

/** Throws invalid_argument unless `v` is a safe integer ≥ min. */
export function requireInt(v: unknown, name: string, min = 0): asserts v is number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new HypertestError('invalid_argument', `${name} must be an integer ≥ ${min}`);
}

/**
 * A result limit: undefined ⇒ `fallback`; otherwise a finite number, floored and at least 1. NaN/±Infinity/non-numbers
 * are invalid_argument (never silently "no results", and never a raw engine error).
 */
export function resolveLimit(limit: unknown, fallback: number, name = 'limit'): number {
  if (limit === undefined) return fallback;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) throw new HypertestError('invalid_argument', `${name} must be a finite number`);
  return Math.max(1, Math.floor(limit));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Makes a JSON-like value storable in PostgreSQL jsonb exactly as it will be read back: lone UTF-16 surrogates
 * become U+FFFD (jsonb rejects them), NUL is rejected (jsonb cannot hold it), undefined members are dropped.
 */
export function storableJson<T>(value: T, path = '$'): T {
  if (typeof value === 'string') {
    if (value.includes('\u0000')) throw new HypertestError('invalid_argument', `${path} contains a NUL character`);
    return value.replace(LONE_SURROGATE, '\uFFFD') as T;
  }
  if (Array.isArray(value)) return value.map((v, i) => storableJson(v, `${path}[${i}]`)) as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      // defineProperty, not assignment: a `__proto__` key must stay an own property (assignment would drop it
      // or change the prototype, so the stored content would silently differ from the hashed one).
      Object.defineProperty(out, storableJson(k, path), { value: storableJson(v, `${path}.${k}`), enumerable: true, writable: true, configurable: true });
    }
    return out as T;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new HypertestError('invalid_argument', `${path} is not a finite number`);
  return value;
}

/** Tokens of a bare text as it would count inside a message (≈ chars/4, no per-message overhead). */
export function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Tokens of messages (domain estimator: ≈4 chars/token + per-message overhead). */
export function messageTokens(messages: readonly ChatMessage[]): number {
  return estimateTokens(messages);
}

/**
 * Truncates `text` so that textTokens(result) ≤ maxTokens, keeping the head and appending `marker`.
 * Never splits a surrogate pair. Returns the text unchanged when it already fits.
 */
export function truncateToTokens(text: string, maxTokens: number, marker = '\n…[truncated]'): { text: string; truncated: boolean } {
  if (textTokens(text) <= maxTokens) return { text, truncated: false };
  const maxChars = Math.max(0, maxTokens * 4);
  if (marker.length >= maxChars) return { text: marker.trimStart().slice(0, Math.max(0, maxChars)), truncated: true };
  let keep = maxChars - marker.length;
  let head = text.slice(0, keep);
  // Do not leave a dangling high surrogate.
  if (head.length > 0 && /[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  while (textTokens(head + marker) > maxTokens && keep > 0) {
    keep--;
    head = head.slice(0, keep);
  }
  return { text: head + marker, truncated: true };
}

const EVIDENCE_RE = /\bev_[A-Za-z0-9]+\b/g;
const RECORD_RE = /\b(?:rec|wi)_[A-Za-z0-9]+\b/g;

function uniqueMatches(text: string, re: RegExp): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[0]);
  return [...out];
}

/** Evidence ids (`ev_…`) in order of first appearance. */
export function extractEvidenceIds(text: string): string[] {
  return uniqueMatches(text, EVIDENCE_RE);
}

/** Blackboard record (`rec_…`) and work item (`wi_…`) ids in order of first appearance. */
export function extractRecordIds(text: string): string[] {
  return uniqueMatches(text, RECORD_RE);
}

/** All text of a message that may carry ids: content, tool-call names/arguments, reasoning text. */
export function searchableText(message: ChatMessage): string {
  let s = textOf(message);
  if (message.role === 'assistant') {
    for (const c of message.toolCalls ?? []) s += `\n${c.name} ${JSON.stringify(c.arguments ?? null)}${c.rawArguments ? ' ' + c.rawArguments : ''}`;
    if (message.reasoning?.text) s += `\n${message.reasoning.text}`;
  }
  if (message.role === 'tool') s += `\n${message.toolName}`;
  return s;
}

/** Lowercased alphanumeric tokens with camelCase / snake_case / kebab splitting (getUserName ≡ get_user_name). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/[^A-Za-z0-9]+/)) {
    if (!word) continue;
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(' ')
      .filter(Boolean)
      .map((p) => p.toLowerCase());
    out.push(...parts);
  }
  return out;
}

/** Stable sort helper: compares strings by UTF-16 code units. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
