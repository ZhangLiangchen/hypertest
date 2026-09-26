/**
 * pi-ai AssistantMessageEventStreams for the StreamFn shim (package-private). A Hypertest turn gets its single model
 * response from the host ModelInvoker; these helpers replay that response through pi-ai's streaming protocol
 * (`start` → per-block start/delta/end → `done`) or end the request with `error` (no generation).
 */
import { createAssistantMessageEventStream, type AssistantMessage as PiAssistantMessage, type AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { HOST_API, HOST_PROVIDER, toPiUsage } from './convert.ts';

/**
 * Streams a complete assistant message. `partial` is the shared live response-so-far (pi-ai's convention): it grows
 * block by block and each block is replaced by the final one at its `*_end`; `done` carries `message` itself.
 */
export function assistantMessageStream(message: PiAssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial: PiAssistantMessage = { ...message, content: [] };
  stream.push({ type: 'start', partial });
  for (const block of message.content) {
    const contentIndex = partial.content.length;
    if (block.type === 'text') {
      partial.content.push({ type: 'text', text: '' });
      stream.push({ type: 'text_start', contentIndex, partial });
      partial.content[contentIndex] = { type: 'text', text: block.text };
      stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial });
      partial.content[contentIndex] = block;
      stream.push({ type: 'text_end', contentIndex, content: block.text, partial });
    } else if (block.type === 'thinking') {
      partial.content.push({ type: 'thinking', thinking: '' });
      stream.push({ type: 'thinking_start', contentIndex, partial });
      partial.content[contentIndex] = { type: 'thinking', thinking: block.thinking };
      stream.push({ type: 'thinking_delta', contentIndex, delta: block.thinking, partial });
      partial.content[contentIndex] = block;
      stream.push({ type: 'thinking_end', contentIndex, content: block.thinking, partial });
    } else {
      partial.content.push({ ...block, arguments: {} });
      stream.push({ type: 'toolcall_start', contentIndex, partial });
      stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(block.arguments), partial });
      partial.content[contentIndex] = block;
      stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial });
    }
  }
  const reason = message.stopReason === 'toolUse' || message.stopReason === 'length' || message.stopReason === 'deferred' ? message.stopReason : 'stop';
  stream.push({ type: 'done', reason, message });
  return stream;
}

/** A request that produced no response (model boundary, abort, fault, or a refused second request). */
export function failedMessageStream(reason: 'error' | 'aborted', errorMessage: string, timestamp: number): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const error: PiAssistantMessage = { role: 'assistant', content: [], api: HOST_API, provider: HOST_PROVIDER, model: 'none', usage: toPiUsage(undefined), stopReason: reason, errorMessage, timestamp };
  stream.push({ type: 'error', reason, error });
  return stream;
}
