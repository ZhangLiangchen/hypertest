/**
 * Hypertest message IR ⇄ pi-ai message types (package-private: pi types never leave @hypertest/runtime-pi).
 *
 * The projection is LOSSLESS for every IR message: everything pi can express natively is mapped natively (system/user
 * messages, text, thinking, tool calls with object arguments, tool results, base64 images); the few IR facts pi has no
 * slot for ride along in a `hypertest` extension field on the pi object (pi ignores unknown fields):
 *   - image parts: `artifactUri`, and "no inline data" (pi's ImageContent requires `data`);
 *   - assistant messages: image parts (pi assistant content has no images), opaque reasoning (a Hypertest continuation
 *     blob, deliberately NOT put into pi's provider-specific `thinkingSignature`), an empty reasoning object and an
 *     explicit empty `toolCalls` array;
 *   - tool calls: non-object arguments (pi requires an object) and `rawArguments` (unparsable provider JSON);
 *   - tool results: an explicit `isError: false` (pi's flag is a required boolean).
 * Pi-native messages without the extension convert with the natural mapping (a pi system message that only declares
 * tools is pi bookkeeping and has no IR form).
 */
import { jsonClone, type JsonValue } from '@hypertest/core';
import type { AssistantMessage, ChatMessage, ContentPart, OpaqueReasoning, ToolCall, ToolResultMessage } from '@hypertest/domain';
import { mapPiUsage, type ModelUsage } from '@hypertest/model';
import type {
  AssistantMessage as PiAssistantMessage, ImageContent as PiImageContent, JsonObject as PiJsonObject, Message as PiMessage, StopReason as PiStopReason,
  SystemMessage as PiSystemMessage, TextContent as PiTextContent, ToolCall as PiToolCall, ToolResultMessage as PiToolResultMessage, Usage as PiUsage,
} from '@earendil-works/pi-ai';

/** pi `api` / `provider` of assistant messages produced through the Hypertest host (never a pi-ai provider). */
export const HOST_API = 'hypertest-host';
export const HOST_PROVIDER = 'hypertest';
/** pi `model` of assistant messages rebuilt from the portable transcript (the route that produced them is not pi's concern). */
export const TRANSCRIPT_MODEL = 'hypertest-transcript';

type IrImage = Extract<ContentPart, { type: 'image' }>;

interface ImageExt {
  artifactUri?: string;
  noData?: true;
}
interface ToolCallExt {
  arguments?: JsonValue;
  rawArguments?: string;
}
interface AssistantExt {
  images?: Array<{ at: number; part: IrImage }>;
  opaque?: OpaqueReasoning;
  /** The IR carried a reasoning object with neither text nor opaque data. */
  reasoning?: true;
  /** The IR carried an explicit empty `toolCalls` array. */
  emptyToolCalls?: true;
}
interface ToolResultExt {
  isError?: false;
}

type PiImageX = PiImageContent & { hypertest?: ImageExt };
type PiToolCallX = PiToolCall & { hypertest?: ToolCallExt };
type PiAssistantX = PiAssistantMessage & { hypertest?: AssistantExt };
type PiToolResultX = PiToolResultMessage & { hypertest?: ToolResultExt };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extOf(v: unknown): Record<string, unknown> | undefined {
  const ext = isPlainObject(v) ? v['hypertest'] : undefined;
  return isPlainObject(ext) ? ext : undefined;
}

// ----------------------------------------------------------------------------- usage

/** IR usage → pi usage (the IR's inputTokens include cached input; pi's `input` excludes cache reads). */
export function toPiUsage(u: ModelUsage | undefined): PiUsage {
  const cacheRead = Math.max(0, u?.cachedInputTokens ?? 0);
  const input = Math.max(0, (u?.inputTokens ?? 0) - cacheRead);
  const output = Math.max(0, u?.outputTokens ?? 0);
  const usage: PiUsage = { input, output, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u?.costUsd ?? 0 } };
  if (u?.reasoningTokens !== undefined) usage.reasoning = u.reasoningTokens;
  return usage;
}

/** pi usage → IR usage (the model package's mapping; zero usage is zeros, not undefined). */
export function fromPiUsage(u: PiUsage | undefined): ModelUsage {
  return mapPiUsage(u) ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

// ----------------------------------------------------------------------------- parts

function toPiImage(p: IrImage): PiImageContent {
  const image: PiImageX = { type: 'image', data: p.dataBase64 ?? '', mimeType: p.mimeType };
  const ext: ImageExt = {};
  if (p.artifactUri !== undefined) ext.artifactUri = p.artifactUri;
  if (p.dataBase64 === undefined) ext.noData = true;
  if (Object.keys(ext).length > 0) image.hypertest = ext;
  return image;
}

function fromPiImage(p: PiImageContent): IrImage {
  const ext = extOf(p);
  const out: IrImage = { type: 'image', mimeType: p.mimeType };
  if (ext?.['noData'] !== true) out.dataBase64 = p.data;
  if (typeof ext?.['artifactUri'] === 'string') out.artifactUri = ext['artifactUri'];
  return out;
}

function toPiPart(p: ContentPart): PiTextContent | PiImageContent {
  return p.type === 'text' ? { type: 'text', text: p.text } : toPiImage(p);
}

function fromPiPart(p: PiTextContent | PiImageContent): ContentPart {
  return p.type === 'text' ? { type: 'text', text: p.text } : fromPiImage(p);
}

// ----------------------------------------------------------------------------- tool calls

export function toPiToolCall(c: ToolCall): PiToolCall {
  const objectArgs = isPlainObject(c.arguments);
  const call: PiToolCallX = { type: 'toolCall', id: c.id, name: c.name, arguments: objectArgs ? (jsonClone(c.arguments) as PiJsonObject) : {} };
  const ext: ToolCallExt = {};
  if (!objectArgs) ext.arguments = c.arguments === undefined ? null : jsonClone(c.arguments);
  if (c.rawArguments !== undefined) ext.rawArguments = c.rawArguments;
  if (Object.keys(ext).length > 0) call.hypertest = ext;
  return call;
}

export function fromPiToolCall(c: PiToolCall): ToolCall {
  const ext = extOf(c);
  const call: ToolCall = { id: c.id, name: c.name, arguments: ext && Object.hasOwn(ext, 'arguments') ? (ext['arguments'] as JsonValue) : ((c.arguments ?? {}) as JsonValue) };
  if (typeof ext?.['rawArguments'] === 'string') call.rawArguments = ext['rawArguments'];
  return call;
}

// ----------------------------------------------------------------------------- assistant

export interface PiAssistantOptions {
  timestamp: number;
  /** pi `model` field (default: TRANSCRIPT_MODEL; the live response uses the route id). */
  model?: string;
  usage?: ModelUsage;
  /** Default: `toolUse` when the message calls tools, else `stop`. */
  stopReason?: PiStopReason;
}

export function toPiAssistant(m: AssistantMessage, options: PiAssistantOptions): PiAssistantMessage {
  const content: PiAssistantMessage['content'] = [];
  const ext: AssistantExt = {};
  if (m.reasoning !== undefined) {
    if (m.reasoning.text !== undefined) content.push({ type: 'thinking', thinking: m.reasoning.text });
    if (m.reasoning.opaque !== undefined) ext.opaque = jsonClone(m.reasoning.opaque);
    if (m.reasoning.text === undefined && m.reasoning.opaque === undefined) ext.reasoning = true;
  }
  (m.content ?? []).forEach((p, at) => {
    if (p.type === 'text') content.push({ type: 'text', text: p.text });
    else (ext.images ??= []).push({ at, part: jsonClone(p) });
  });
  if (m.toolCalls !== undefined) {
    if (m.toolCalls.length === 0) ext.emptyToolCalls = true;
    for (const c of m.toolCalls) content.push(toPiToolCall(c));
  }
  const message: PiAssistantX = {
    role: 'assistant',
    content,
    api: HOST_API,
    provider: HOST_PROVIDER,
    model: options.model ?? TRANSCRIPT_MODEL,
    usage: toPiUsage(options.usage),
    stopReason: options.stopReason ?? ((m.toolCalls?.length ?? 0) > 0 ? 'toolUse' : 'stop'),
    timestamp: options.timestamp,
  };
  if (Object.keys(ext).length > 0) message.hypertest = ext;
  return message;
}

export function fromPiAssistant(m: PiAssistantMessage): AssistantMessage {
  const ext = extOf(m);
  const content: ContentPart[] = [];
  const thinking: string[] = [];
  const calls: ToolCall[] = [];
  for (const block of m.content ?? []) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text });
    else if (block.type === 'thinking') thinking.push(block.thinking);
    else if (block.type === 'toolCall') calls.push(fromPiToolCall(block));
  }
  const images = (Array.isArray(ext?.['images']) ? (ext['images'] as unknown[]) : []).filter(
    (x): x is { at: number; part: IrImage } => isPlainObject(x) && Number.isSafeInteger(x['at']) && isPlainObject(x['part']) && x['part']['type'] === 'image',
  );
  for (const { at, part } of [...images].sort((a, b) => a.at - b.at)) content.splice(at, 0, jsonClone(part));
  const out: AssistantMessage = { role: 'assistant', content };
  if (calls.length > 0 || ext?.['emptyToolCalls'] === true) out.toolCalls = calls;
  const opaque = isPlainObject(ext?.['opaque']) ? (jsonClone(ext['opaque']) as unknown as OpaqueReasoning) : undefined;
  if (thinking.length > 0 || opaque !== undefined || ext?.['reasoning'] === true) {
    const reasoning: NonNullable<AssistantMessage['reasoning']> = {};
    if (thinking.length > 0) reasoning.text = thinking.join('\n');
    if (opaque !== undefined) reasoning.opaque = opaque;
    out.reasoning = reasoning;
  }
  return out;
}

// ----------------------------------------------------------------------------- tool results

export function toPiToolResult(m: ToolResultMessage, timestamp: number): PiToolResultMessage {
  const result: PiToolResultX = { role: 'toolResult', toolCallId: m.toolCallId, toolName: m.toolName, content: [{ type: 'text', text: m.content }], isError: m.isError === true, timestamp };
  if (m.isError === false) result.hypertest = { isError: false };
  return result;
}

/** pi tool results may carry images; the IR tool result is text, so an image becomes a `[image <mime>]` marker. */
export function fromPiToolResult(m: PiToolResultMessage): ToolResultMessage {
  const content = (m.content ?? []).map((p) => (p.type === 'text' ? p.text : `[image ${p.mimeType}]`)).join('');
  const out: ToolResultMessage = { role: 'tool', toolCallId: m.toolCallId, toolName: m.toolName, content };
  if (m.isError === true) out.isError = true;
  else if (extOf(m)?.['isError'] === false) out.isError = false;
  return out;
}

// ----------------------------------------------------------------------------- messages

/** One IR message as a pi message. `timestamp` stamps pi's required field (the IR has none). */
export function toPiMessage(m: ChatMessage, timestamp: number): PiMessage {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content, timestamp };
    case 'user':
      return { role: 'user', content: typeof m.content === 'string' ? m.content : m.content.map(toPiPart), timestamp };
    case 'assistant':
      return toPiAssistant(m, { timestamp });
    case 'tool':
      return toPiToolResult(m, timestamp);
  }
}

export function toPiMessages(messages: readonly ChatMessage[], timestamp: number): PiMessage[] {
  return messages.map((m) => toPiMessage(m, timestamp));
}

/** True for a pi system message that only declares/removes tools (pi bookkeeping, no IR form). */
function isToolDeclarationOnly(m: PiSystemMessage): boolean {
  const text = typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join('');
  const declares = (m.toolsAdded?.length ?? 0) > 0 || (m.toolsRemoved?.length ?? 0) > 0;
  return declares && text.length === 0 && (m.sections === undefined || Object.keys(m.sections).length === 0);
}

/** One pi message as IR; undefined for a pi tool-declaration-only system message. Sections render after the content. */
export function fromPiMessage(m: PiMessage): ChatMessage | undefined {
  switch (m.role) {
    case 'system': {
      if (isToolDeclarationOnly(m)) return undefined;
      const text = typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join('');
      const sections = Object.values(m.sections ?? {}).filter((s): s is string => typeof s === 'string');
      return { role: 'system', content: sections.length > 0 ? [text, ...sections].filter((s) => s.length > 0).join('\n\n') : text };
    }
    case 'user':
      return { role: 'user', content: typeof m.content === 'string' ? m.content : m.content.map(fromPiPart) };
    case 'assistant':
      return fromPiAssistant(m);
    case 'toolResult':
      return fromPiToolResult(m);
  }
}

export function fromPiMessages(messages: readonly PiMessage[]): ChatMessage[] {
  return messages.map(fromPiMessage).filter((m): m is ChatMessage => m !== undefined);
}
