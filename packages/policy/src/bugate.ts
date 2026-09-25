import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { HypertestError, assertValid, canonicalJson, hashCanonical, isValidSchema, sha256Hex } from '@hypertest/core';
import type { PreparedProtocolContext, ProtocolContextRequest, ResolvedProtocol } from './contracts.ts';
import { EMBEDDED_PRINCIPLES, EMBEDDED_PROTOCOL_VERSION, PHASE_EMPHASIS, PHASE_FOCUS, PREPARED_PROTOCOL_CONTEXT_SCHEMA, ROLE_HINTS } from './bugate-embedded.ts';

export const DEFAULT_PROTOCOL_CONTEXT_BYTES = 6000;
const PHASES = ['analysis', 'design', 'implementation', 'execution', 'diagnosis', 'review', 'acceptance'] as const;

/** Splits a markdown document (front matter stripped) into its `## ` sections: heading → body text. */
export function extractMarkdownSections(markdown: string): Array<{ heading: string; text: string }> {
  let body = markdown.replace(/\r\n/g, '\n');
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 4);
    if (end >= 0) body = body.slice(body.indexOf('\n', end + 1) + 1);
  }
  const out: Array<{ heading: string; text: string }> = [];
  let current: { heading: string; lines: string[] } | undefined;
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      if (current) out.push({ heading: current.heading, text: current.lines.join('\n').trim() });
      current = { heading: m[1]!, lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) out.push({ heading: current.heading, text: current.lines.join('\n').trim() });
  return out;
}

async function readOptional(path: string): Promise<string | undefined> {
  return existsSync(path) ? readFile(path, 'utf8') : undefined;
}

function embeddedProtocol(): ResolvedProtocol {
  const digest = sha256Hex(
    canonicalJson({
      embedded: EMBEDDED_PROTOCOL_VERSION,
      schema: hashCanonical(PREPARED_PROTOCOL_CONTEXT_SCHEMA),
      principles: hashCanonical(EMBEDDED_PRINCIPLES),
      emphasis: hashCanonical({ PHASE_EMPHASIS, PHASE_FOCUS, ROLE_HINTS }),
    }),
  );
  return {
    binding: { protocolId: 'bugate', version: EMBEDDED_PROTOCOL_VERSION, digest, source: { kind: 'embedded' } },
    methodology: { ...EMBEDDED_PRINCIPLES },
    contextSchema: structuredClone(PREPARED_PROTOCOL_CONTEXT_SCHEMA),
  };
}

/**
 * Resolves the BUGate protocol binding. With a checkout (`<bugatePath>/protocol/v2/manifest.yaml`) the
 * manifest, its PreparedProtocolContext schema and the methodology documents (docs/qa-methodology/METHOD.md,
 * SOP.md) are read and digested; otherwise the embedded protocol is used. A present but malformed checkout
 * is an error (never silently replaced by the embedded copy).
 */
export async function resolveProtocolBinding(options: { bugatePath?: string } = {}): Promise<ResolvedProtocol> {
  if (!options.bugatePath) return embeddedProtocol();
  const root = resolve(options.bugatePath);
  const protocolDir = join(root, 'protocol', 'v2');
  const manifestPath = join(protocolDir, 'manifest.yaml');
  if (!existsSync(manifestPath)) return embeddedProtocol();

  const manifestText = await readFile(manifestPath, 'utf8');
  let manifest: unknown;
  try {
    manifest = parseYaml(manifestText);
  } catch (e) {
    throw new HypertestError('invalid_argument', `BUGate manifest ${manifestPath} is not valid YAML: ${(e as Error).message}`, { cause: e });
  }
  const m = manifest as { apiVersion?: unknown; kind?: unknown; metadata?: { id?: unknown; version?: unknown }; schemas?: { prepared_protocol_context?: unknown } } | null;
  if (!m || typeof m !== 'object') throw new HypertestError('invalid_argument', `BUGate manifest ${manifestPath} is empty`);
  if (m.apiVersion !== 'bugate.io/v2' || m.kind !== 'ProtocolManifest') {
    throw new HypertestError('invalid_argument', `BUGate manifest ${manifestPath}: expected apiVersion bugate.io/v2 kind ProtocolManifest`);
  }
  if (m.metadata?.id !== 'bugate') throw new HypertestError('invalid_argument', `BUGate manifest ${manifestPath}: metadata.id must be bugate`);
  const version = m.metadata.version;
  if (typeof version !== 'string' || version.length === 0) throw new HypertestError('invalid_argument', `BUGate manifest ${manifestPath}: metadata.version missing`);
  const schemaRel = m.schemas?.prepared_protocol_context;
  if (typeof schemaRel !== 'string' || schemaRel.length === 0) throw new HypertestError('invalid_argument', `BUGate manifest ${manifestPath}: schemas.prepared_protocol_context missing`);
  const schemaPath = resolve(protocolDir, schemaRel);
  const rel = relative(protocolDir, schemaPath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new HypertestError('invalid_argument', `BUGate schema path escapes the protocol directory: ${schemaRel}`);
  if (!existsSync(schemaPath)) throw new HypertestError('not_found', `BUGate schema ${schemaPath} not found`);
  // symlinks must not lead out of the protocol directory either
  const realRel = relative(realpathSync(protocolDir), realpathSync(schemaPath));
  if (realRel.startsWith('..') || isAbsolute(realRel)) throw new HypertestError('invalid_argument', `BUGate schema path escapes the protocol directory via a symlink: ${schemaRel}`);
  const schemaText = await readFile(schemaPath, 'utf8');
  let contextSchema: Record<string, unknown>;
  try {
    contextSchema = JSON.parse(schemaText) as Record<string, unknown>;
  } catch (e) {
    throw new HypertestError('invalid_argument', `BUGate schema ${schemaPath} is not valid JSON`, { cause: e });
  }
  if (!isValidSchema(contextSchema)) throw new HypertestError('invalid_argument', `BUGate schema ${schemaPath} is not a valid JSON schema`);

  const methodText = await readOptional(join(root, 'docs', 'qa-methodology', 'METHOD.md'));
  const sopText = await readOptional(join(root, 'docs', 'qa-methodology', 'SOP.md'));
  const digest = sha256Hex(
    canonicalJson({
      manifest: sha256Hex(manifestText),
      schema: sha256Hex(schemaText),
      method: methodText === undefined ? null : sha256Hex(methodText),
      sop: sopText === undefined ? null : sha256Hex(sopText),
    }),
  );
  const methodology: Record<string, string> = { ...EMBEDDED_PRINCIPLES };
  if (methodText !== undefined) {
    for (const s of extractMarkdownSections(methodText)) methodology[`method:${s.heading}`] = s.text;
  }
  return {
    binding: { protocolId: 'bugate', version, digest, source: { kind: 'bugate_checkout', path: root } },
    methodology,
    contextSchema,
  };
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes on a code-point boundary. */
export function cutUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Caller-supplied text rendered into the prompt context is flattened to one line, so a concern message
 * (which may quote agent-authored text) cannot inject headings or fake protocol sections.
 */
function oneLine(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function titleOf(topic: string): string {
  return topic.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Renders the per-role/phase PreparedProtocolContext (markdown), bounded to `maxBytes` UTF-8 bytes
 * (default 6000), with `render.bytes` equal to the exact byte length, validated against the protocol's
 * JSON schema (throws schema_violation).
 */
export function prepareProtocolContext(protocol: ResolvedProtocol, request: ProtocolContextRequest): PreparedProtocolContext {
  const maxBytes = request.maxBytes ?? DEFAULT_PROTOCOL_CONTEXT_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new HypertestError('invalid_argument', `maxBytes must be a positive integer (got ${String(request.maxBytes)})`);
  if (!(PHASES as readonly string[]).includes(request.phase)) throw new HypertestError('invalid_argument', `unknown phase ${String(request.phase)}`);

  const posture = request.qualityPosture ?? {};
  const concerns = request.activeConcerns ?? [];
  const b = protocol.binding;
  const sections: string[] = [];
  sections.push(
    `# BUGate protocol context\n` +
      `protocol ${b.protocolId} ${oneLine(b.version)} · digest ${b.digest.slice(0, 16)} · task ${oneLine(request.taskId)} · role ${oneLine(request.role)} · phase ${request.phase}\n`,
  );
  const hint = ROLE_HINTS[request.role];
  sections.push(`## Phase focus: ${request.phase}\n${PHASE_FOCUS[request.phase]}\n${hint ? `Role (${oneLine(request.role)}): ${hint}\n` : ''}`);
  if (concerns.length) {
    sections.push(
      `## Active concerns\n${concerns
        .map((c) => `- ${c.severity ? `[${oneLine(c.severity)}] ` : ''}${oneLine(c.code)}${c.subject ? ` (${oneLine(c.subject)})` : ''}${c.message ? `: ${oneLine(c.message)}` : ''}`)
        .join('\n')}\n`,
    );
  }
  const postureKeys = Object.keys(posture).sort();
  if (postureKeys.length) sections.push(`## Quality posture\n${postureKeys.map((k) => `- ${oneLine(k)}: ${posture[k]}`).join('\n')}\n`);
  const emphasised = PHASE_EMPHASIS[request.phase] ?? [];
  for (const topic of emphasised) {
    const text = protocol.methodology[topic];
    if (text) sections.push(`## ${titleOf(topic)}\n${text}\n`);
  }
  const others = Object.keys(EMBEDDED_PRINCIPLES).filter((t) => !emphasised.includes(t) && protocol.methodology[t]);
  if (others.length) sections.push(`## Other principles\n${others.map((t) => `- ${protocol.methodology[t]!.split('\n')[0]}`).join('\n')}\n`);
  const methodSections = Object.keys(protocol.methodology).filter((k) => k.startsWith('method:'));
  if (methodSections.length) sections.push(`## Methodology source (BUGate METHOD.md)\n${methodSections.map((k) => `- ${k.slice('method:'.length)}`).join('\n')}\n`);

  let content = '';
  let used = 0;
  const MIN_SECTION_BYTES = 32;
  for (const s of sections) {
    const piece = content === '' ? s : `\n${s}`;
    const size = Buffer.byteLength(piece, 'utf8');
    if (used + size <= maxBytes) {
      content += piece;
      used += size;
      continue;
    }
    const remaining = maxBytes - used;
    if (content === '' || remaining >= MIN_SECTION_BYTES) {
      const marker = '\n…[truncated]';
      const markerBytes = Buffer.byteLength(marker, 'utf8');
      const text = remaining > markerBytes * 2 ? cutUtf8(piece, remaining - markerBytes) + marker : cutUtf8(piece, remaining);
      content += text;
      used += Buffer.byteLength(text, 'utf8');
    }
    break;
  }

  const ctx: PreparedProtocolContext = {
    apiVersion: 'bugate.io/v2',
    kind: 'PreparedProtocolContext',
    protocol: { id: 'bugate', version: b.version, digest: b.digest },
    workspace: { task_id: request.taskId, ...(request.workspaceDigest !== undefined ? { workspace_digest: request.workspaceDigest } : {}) },
    quality_posture: { ...posture },
    active_concerns: concerns.map((c) => ({ ...c })),
    render: { media_type: 'text/markdown', bytes: Buffer.byteLength(content, 'utf8'), content },
  };
  return assertValid<PreparedProtocolContext>(protocol.contextSchema, ctx, 'PreparedProtocolContext');
}
