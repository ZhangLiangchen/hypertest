import { HypertestError, throwIfAborted } from '@hypertest/core';
import { estimateTokens, textOf, type ChatMessage, type ToolResultMessage } from '@hypertest/domain';
import type { Compaction, Summarizer, TranscriptEntry, WorkingContextManager, WorkingContextOptions, WorkingView } from './contracts.ts';
import { extractEvidenceIds, extractRecordIds, searchableText, truncateToTokens } from './util.ts';

export const SUMMARY_PREFIX = 'Summary of earlier work';

export const CONDENSE_INSTRUCTIONS = [
  'Summarize the earlier part of this testing-agent session so the agent can continue without it.',
  'Preserve, explicitly and verbatim where they are identifiers:',
  '- the goals and objectives being pursued;',
  '- decisions taken and their rationale;',
  '- every tool call made (tool name, key arguments) and its outcome (success/failure, key result);',
  '- errors and failures encountered;',
  '- every evidence id (ev_…) and every record / work item id (rec_…, wi_…) mentioned;',
  '- open questions and next steps.',
  'Do not invent facts, results or identifiers. The previous summary, when present, must be carried forward.',
].join('\n');

interface Indexed {
  turn: number;
  message: ChatMessage;
  index: number;
}

/** Transcript sorted by turn; the original order is kept inside a turn. */
function ordered(transcript: readonly TranscriptEntry[]): Indexed[] {
  return transcript
    .map((e, index) => ({ turn: e.turn, message: e.message, index }))
    .sort((a, b) => a.turn - b.turn || a.index - b.index);
}

/** Map toolCallId → turn of the assistant message that issued it. */
function callTurns(entries: readonly Indexed[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) if (e.message.role === 'assistant') for (const c of e.message.toolCalls ?? []) m.set(c.id, e.turn);
  return m;
}

/**
 * Moves a turn cut earlier until no assistant tool call at turn ≤ cut has a result at turn > cut (no orphaned
 * tool results and no call separated from its results). Returns −1 when no clean cut exists.
 */
export function cleanCut(entries: readonly Indexed[], cut: number): number {
  const calls = callTurns(entries);
  let c = cut;
  for (;;) {
    let next = c;
    for (const e of entries) {
      if (e.turn <= c || e.message.role !== 'tool') continue;
      const t = calls.get(e.message.toolCallId);
      if (t !== undefined && t <= c) next = Math.min(next, t - 1);
    }
    if (next === c) return c;
    c = next;
    if (c < 0) return -1;
  }
}

/** Index into `entries` where the kept (verbatim) part starts for a cut; moved earlier to avoid orphans. */
function keepStart(entries: readonly Indexed[], upToTurn: number): number {
  let start = entries.findIndex((e) => e.turn > upToTurn);
  if (start < 0) return entries.length;
  const callIndex = new Map<string, number>();
  entries.forEach((e, i) => {
    if (e.message.role === 'assistant') for (const c of e.message.toolCalls ?? []) callIndex.set(c.id, i);
  });
  for (;;) {
    let next = start;
    for (let i = start; i < entries.length; i++) {
      const m = entries[i]!.message;
      if (m.role !== 'tool') continue;
      const ci = callIndex.get(m.toolCallId);
      if (ci !== undefined && ci < next) next = ci;
    }
    if (next === start) return start;
    start = next;
  }
}

function summaryMessage(c: Compaction): ChatMessage {
  const refs = c.evidenceRefs.length > 0 ? c.evidenceRefs.join(', ') : 'none';
  return { role: 'user', content: `${SUMMARY_PREFIX} (turns 0..${c.upToTurn}): ${c.summary}\nEvidence referenced: ${refs}` };
}

function boundToolResult(m: ChatMessage, maxTokens: number): ChatMessage {
  if (m.role !== 'tool' || maxTokens <= 0) return m;
  const marker = `\n…[truncated in the working view: ${m.content.length} chars total; the full result is kept in the session transcript (L0)]`;
  const r = truncateToTokens(m.content, maxTokens, marker);
  return r.truncated ? { ...m, content: r.text } : m;
}

function validateOptions(o: Required<WorkingContextOptions>): void {
  if (!Number.isInteger(o.keepRecentTurns) || o.keepRecentTurns < 0) throw new HypertestError('invalid_argument', 'keepRecentTurns must be an integer ≥ 0');
  if (!(o.softRatio > 0 && o.softRatio <= o.hardRatio && o.hardRatio <= 1)) throw new HypertestError('invalid_argument', 'ratios must satisfy 0 < softRatio ≤ hardRatio ≤ 1');
  if (!(o.summaryRatio > 0 && o.summaryRatio < 1)) throw new HypertestError('invalid_argument', 'summaryRatio must be in (0, 1)');
}

/**
 * L2 working context. The view is a projection: L0 / SessionStore keep every message, compactions only change
 * what the model sees, so condensation is reversible.
 */
export function createWorkingContextManager(options: WorkingContextOptions = {}): WorkingContextManager {
  const o: Required<WorkingContextOptions> = {
    keepRecentTurns: options.keepRecentTurns ?? 4,
    softRatio: options.softRatio ?? 0.7,
    hardRatio: options.hardRatio ?? 0.95,
    summaryRatio: options.summaryRatio ?? 0.2,
    maxToolResultTokens: options.maxToolResultTokens ?? 8000,
  };
  validateOptions(o);

  function view(input: { transcript: TranscriptEntry[]; compactions: Compaction[]; budgetTokens: number }): WorkingView {
    if (!Number.isFinite(input.budgetTokens) || input.budgetTokens <= 0) throw new HypertestError('invalid_argument', 'budgetTokens must be a positive number');
    const entries = ordered(input.transcript ?? []);
    const last = (input.compactions ?? []).at(-1);
    let messages: ChatMessage[];
    if (last) {
      const start = keepStart(entries, last.upToTurn);
      messages = [summaryMessage(last), ...entries.slice(start).map((e) => e.message)];
    } else {
      messages = entries.map((e) => e.message);
    }
    messages = messages.map((m) => boundToolResult(m, o.maxToolResultTokens));
    const tokens = estimateTokens(messages);
    const ratio = tokens / input.budgetTokens;
    return { messages, tokens, pressure: ratio >= o.hardRatio ? 'hard' : ratio >= o.softRatio ? 'soft' : 'none' };
  }

  return {
    view,
    async condense(input) {
      if (input.level !== 'soft' && input.level !== 'hard') throw new HypertestError('invalid_argument', 'level must be soft or hard');
      if (!Number.isFinite(input.budgetTokens) || input.budgetTokens <= 0) throw new HypertestError('invalid_argument', 'budgetTokens must be a positive number');
      throwIfAborted(input.signal);
      const entries = ordered(input.transcript ?? []);
      const prev = (input.compactions ?? []).at(-1);
      const prevUpTo = prev?.upToTurn ?? -1;
      const maxTurn = entries.length > 0 ? entries[entries.length - 1]!.turn : -1;
      const summaryMaxTokens = Math.max(64, Math.floor(input.budgetTokens * o.summaryRatio));

      let upTo = cleanCut(entries, maxTurn - o.keepRecentTurns);
      if (input.level === 'hard') {
        // Hard is mandatory: keep fewer recent turns until the condensed view fits under the soft threshold.
        const target = Math.floor(input.budgetTokens * o.softRatio);
        const overhead = summaryMaxTokens + 64;
        let chosen = upTo;
        for (let c = Math.max(upTo, prevUpTo); c <= maxTurn; c++) {
          const clean = cleanCut(entries, c);
          if (clean !== c) continue;
          chosen = c;
          const kept = entries.filter((e) => e.turn > c).map((e) => boundToolResult(e.message, o.maxToolResultTokens));
          if (estimateTokens(kept) + overhead <= target) break;
        }
        upTo = chosen;
      }
      if (upTo < prevUpTo || (upTo === prevUpTo && (input.level === 'soft' || !prev)) || upTo < 0) {
        throw new HypertestError('precondition_failed', `nothing to condense (${input.level}): the clean cut ${upTo} does not advance past turn ${prevUpTo}`, {
          details: { level: input.level, cut: upTo, previousUpToTurn: prevUpTo, maxTurn },
        });
      }

      const range = entries.filter((e) => e.turn > prevUpTo && e.turn <= upTo).map((e) => e.message);
      const msgs: ChatMessage[] = [];
      if (prev) msgs.push(summaryMessage(prev));
      msgs.push(...range);

      // Ids come from the full messages; the summarizer sees oversized tool results bounded (I9).
      const texts = msgs.map(searchableText).join('\n');
      const evidenceRefs = [...new Set([...(prev?.evidenceRefs ?? []), ...extractEvidenceIds(texts)])];
      const recordRefs = extractRecordIds(texts);

      const raw = await input.summarizer.summarize({
        messages: msgs.map((m) => boundToolResult(m, o.maxToolResultTokens)),
        instructions: CONDENSE_INSTRUCTIONS,
        maxTokens: summaryMaxTokens,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (typeof raw !== 'string') throw new HypertestError('provider_error', 'summarizer returned a non-string summary');
      let summary = truncateToTokens(raw.trim(), summaryMaxTokens).text;
      // The summary MUST mention every evidence (and record) id of the condensed range: re-append dropped ones.
      const missingEvidence = evidenceRefs.filter((id) => !extractEvidenceIds(summary).includes(id));
      if (missingEvidence.length > 0) summary += `\nEvidence ids (preserved): ${missingEvidence.join(', ')}`;
      const missingRecords = recordRefs.filter((id) => !extractRecordIds(summary).includes(id));
      if (missingRecords.length > 0) summary += `\nRecord ids (preserved): ${missingRecords.join(', ')}`;

      return {
        compactionId: input.ids.next('cmp'),
        level: input.level,
        upToTurn: upTo,
        summary,
        evidenceRefs,
        createdAt: input.now,
      };
    },
  };
}

function firstSentence(text: string, max = 200): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const m = /^(.+?[.!?])(?:\s|$)/.exec(t);
  const s = m ? m[1]! : t;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function firstLine(text: string, max = 160): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function argsDigest(args: unknown, max = 120): string {
  let s: string;
  try {
    s = JSON.stringify(args ?? null);
  } catch {
    s = String(args);
  }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Extractive fallback summarizer (no model): per step the assistant intent (first sentence), each tool call
 * with its status and first result line, errors, and every evidence / record id; bounded by maxTokens.
 */
export const deterministicSummarizer: Summarizer = {
  async summarize({ messages, maxTokens, signal }) {
    throwIfAborted(signal);
    const lines: string[] = [];
    const errors: string[] = [];
    let step = 0;
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        const text = textOf(m);
        if (text.startsWith(SUMMARY_PREFIX) || text.startsWith('Previous summary')) lines.push(`Earlier: ${text.replace(/\s+/g, ' ').trim()}`);
        else lines.push(`User: ${firstSentence(text)}`);
        continue;
      }
      if (m.role === 'assistant') {
        step++;
        const intent = firstSentence(textOf(m));
        lines.push(`Step ${step}: ${intent || '(no text)'}`);
        for (const c of m.toolCalls ?? []) lines.push(`  call ${c.name} ${argsDigest(c.arguments)}`);
        continue;
      }
      const status = m.isError ? 'error' : 'ok';
      const first = firstLine(m.content);
      lines.push(`  result ${m.toolName} [${status}]: ${first}`);
      if (m.isError) errors.push(`${m.toolName}: ${first}`);
    }
    const all = messages.map(searchableText).join('\n');
    const ev = extractEvidenceIds(all);
    const recs = extractRecordIds(all);
    // Strictly bounded; budget priority: ids, then errors, then the step log (condense() re-appends any id
    // that did not fit).
    let room = Math.max(0, maxTokens);
    const take = (text: string, marker: string): string => {
      if (!text || room <= 0) return '';
      const cost = (t: string) => Math.ceil((t.length + 1) / 4); // + joining newline
      const r = cost(text) <= room ? text : truncateToTokens(text, Math.max(0, room - 1), marker).text;
      room -= cost(r);
      return r;
    };
    const idsText = take([`Evidence: ${ev.length > 0 ? ev.join(', ') : 'none'}`, ...(recs.length > 0 ? [`Records: ${recs.join(', ')}`] : [])].join('\n'), ' …');
    const errorsText = take(errors.length > 0 ? `Errors: ${errors.join(' | ')}` : '', ' …');
    const body = take(lines.join('\n'), '\n…[earlier steps truncated]');
    return [body, errorsText, idsText].filter(Boolean).join('\n');
  },
};

/** Minimal structural view of an ArtifactStore (from @hypertest/evidence) needed for offloading. */
export interface OffloadArtifactStore {
  put(data: Uint8Array | string, options: { mimeType: string }): Promise<{ uri: string; sha256: string; size: number; mimeType: string }>;
}

/**
 * I9: a tool result larger than `thresholdBytes` (default 16 KiB) is written to the artifact store and replaced
 * by a bounded digest (head preview + artifact uri + sha256 + size). Smaller results are returned unchanged.
 */
export async function offloadToolResult(
  artifacts: OffloadArtifactStore,
  message: ToolResultMessage,
  options: { thresholdBytes?: number; previewBytes?: number; mimeType?: string } = {},
): Promise<{ message: ToolResultMessage; artifact?: { uri: string; sha256: string; size: number; mimeType: string } }> {
  const threshold = options.thresholdBytes ?? 16 * 1024;
  const previewBytes = options.previewBytes ?? 2 * 1024;
  const size = Buffer.byteLength(message.content, 'utf8');
  if (size <= threshold) return { message };
  const artifact = await artifacts.put(message.content, { mimeType: options.mimeType ?? 'text/plain' });
  let preview = Buffer.from(message.content, 'utf8').subarray(0, previewBytes).toString('utf8');
  if (preview.endsWith('�')) preview = preview.slice(0, -1);
  const content = `${preview}\n…[output offloaded: ${size} bytes, artifact ${artifact.uri} sha256:${artifact.sha256}]`;
  return { message: { ...message, content }, artifact };
}
