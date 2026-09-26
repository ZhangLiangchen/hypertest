import { HypertestError } from '@hypertest/core';
import { estimateTokens, type ChatMessage } from '@hypertest/domain';
import type { AssemblyInput, AssemblyResult, PromptSection } from './contracts.ts';
import { textTokens, truncateToTokens } from './util.ts';

export const PROTOCOL_HEADER = '## Testing methodology protocol (BUGate)';
export const CONTEXT_HEADER = '# Context';
export const TRUNCATION_MARKER = '\n…[truncated]';

interface WorkingSection {
  section: PromptSection;
  order: number;
  content: string;
  truncated: boolean;
}

function renderSection(s: { title: string }, content: string): string {
  return `## ${s.title}\n${content}`;
}

/** Tokens a section adds to the Context message (its text plus the blank-line separator). */
function sectionCost(s: { title: string }, content: string): number {
  return textTokens(renderSection(s, content) + '\n\n');
}

function safeHead(text: string, chars: number): string {
  let head = text.slice(0, chars);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head;
}

/**
 * Longest head of `content` (+ marker) whose rendered section cost fits `maxTokens`; when not even the marker
 * fits, the content becomes just '[truncated]' (a required section keeps its header).
 */
function fitSection(s: PromptSection, content: string, maxTokens: number): { content: string; truncated: boolean } {
  if (sectionCost(s, content) <= maxTokens) return { content, truncated: false };
  let lo = -1;
  let hi = content.length;
  // Invariant: cost is monotonic in the head length; find the largest head that fits.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (sectionCost(s, safeHead(content, mid) + TRUNCATION_MARKER) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  if (lo < 0) return { content: TRUNCATION_MARKER.trimStart(), truncated: true };
  return { content: safeHead(content, lo) + TRUNCATION_MARKER, truncated: true };
}

/**
 * L1 prompt assembly.
 *
 * messages = [system, user 'Context' (sections by priority, lower first), ...transcript (verbatim)]
 *   system  = rolePrompt + BUGate protocol context + policy notes + `Context snapshot: <id>`
 * Budget: sections get budgetTokens − system − transcript − message overhead. Per-section maxTokens are applied
 * first; then non-required sections are dropped from the least important upward; if still over, required
 * sections are truncated (least important first) with a '[truncated]' marker — never dropped. Transcript
 * messages are never dropped here: when they alone exceed the budget the result is returned over budget and
 * the caller must condense (L2).
 */
export class PromptAssembler {
  assemble(input: AssemblyInput): AssemblyResult {
    if (!input || typeof input.rolePrompt !== 'string') throw new HypertestError('invalid_argument', 'rolePrompt must be a string');
    if (typeof input.snapshotId !== 'string' || input.snapshotId.length === 0) throw new HypertestError('invalid_argument', 'snapshotId must be a non-empty string');
    if (!Number.isFinite(input.budgetTokens) || input.budgetTokens <= 0) throw new HypertestError('invalid_argument', 'budgetTokens must be a positive number');
    const ids = new Set<string>();
    for (const s of input.sections ?? []) {
      if (typeof s.id !== 'string' || s.id.length === 0) throw new HypertestError('invalid_argument', 'section ids must be non-empty strings');
      if (ids.has(s.id)) throw new HypertestError('invalid_argument', `duplicate section id ${s.id}`);
      ids.add(s.id);
      if (!Number.isFinite(s.priority)) throw new HypertestError('invalid_argument', `section ${s.id} priority must be a number`);
    }

    let system = input.rolePrompt;
    if (input.protocolContext) system += `\n\n${PROTOCOL_HEADER}\n${input.protocolContext}`;
    const notes = (input.policyNotes ?? []).filter((n) => typeof n === 'string' && n.length > 0);
    if (notes.length > 0) system += `\n\n## Policy\n${notes.map((n) => `- ${n}`).join('\n')}`;
    system += `\n\nContext snapshot: ${input.snapshotId}`;
    const systemMessage: ChatMessage = { role: 'system', content: system };
    const transcript = input.transcript ?? [];

    const fixed = estimateTokens([systemMessage]) + estimateTokens(transcript) + estimateTokens([{ role: 'user', content: `${CONTEXT_HEADER}\n\n` }]);
    const available = input.budgetTokens - fixed;

    const truncated = new Set<string>();
    const dropped: string[] = [];
    let work: WorkingSection[] = (input.sections ?? []).map((section, order) => {
      let content = section.content ?? '';
      let wasTruncated = false;
      if (section.maxTokens !== undefined && section.maxTokens >= 0) {
        // maxTokens bounds the section content (the header is not counted).
        const r = truncateToTokens(content, section.maxTokens, TRUNCATION_MARKER);
        content = r.text;
        wasTruncated = r.truncated;
      }
      if (wasTruncated) truncated.add(section.id);
      return { section, order, content, truncated: wasTruncated };
    });
    // Most important first; ties keep the caller's order.
    work.sort((a, b) => a.section.priority - b.section.priority || a.order - b.order);

    const total = (ws: WorkingSection[]) => ws.reduce((n, w) => n + sectionCost(w.section, w.content), 0);

    // 1. drop non-required sections from the least important upward.
    for (let i = work.length - 1; i >= 0 && total(work) > available; i--) {
      const w = work[i]!;
      if (w.section.required) continue;
      dropped.push(w.section.id);
      truncated.delete(w.section.id);
      work = work.filter((x) => x !== w);
    }
    // 2. truncate required sections, least important first.
    for (let i = work.length - 1; i >= 0 && total(work) > available; i--) {
      const w = work[i]!;
      const others = total(work) - sectionCost(w.section, w.content);
      const r = fitSection(w.section, w.content, Math.max(0, available - others));
      if (r.truncated) {
        w.content = r.content;
        w.truncated = true;
        truncated.add(w.section.id);
      }
    }

    const messages: ChatMessage[] = [systemMessage];
    if (work.length > 0) {
      messages.push({ role: 'user', content: `${CONTEXT_HEADER}\n\n${work.map((w) => renderSection(w.section, w.content)).join('\n\n')}` });
    }
    messages.push(...transcript);
    const order = new Map((input.sections ?? []).map((s, i) => [s.id, i]));
    return {
      messages,
      tokens: estimateTokens(messages),
      droppedSections: dropped,
      truncatedSections: [...truncated].sort((a, b) => order.get(a)! - order.get(b)!),
    };
  }
}
