import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, fromJsonColumn, HypertestError, sha256Hex, toIso, type JsonValue, type Logger, type SqlParam } from '@hypertest/core';
import type { Freshness, ReadSetEntry } from '@hypertest/domain';
import type { ContextDeps, Observation, ObservationLog, ObservationSource, ObservedEntry } from './contracts.ts';
import { fileResolver } from './resolvers.ts';
import { stripSymbolAnnotation } from './retrieval/code-port.ts';
import { validateReadSetEntry } from './snapshots.ts';
import { FINDING_WITHDRAWN_STATUSES, findingWithdrawalVersion, isRecord, requireText, resolveLimit } from './util.ts';

export { FINDING_WITHDRAWN_STATUSES, findingWithdrawalVersion } from './util.ts';

/**
 * `observedVersion` of an entry recording that the resource did NOT exist when observed (e.g. a file the agent's own
 * patch deleted). The FreshnessGuard treats a still-missing resource as fresh for such an entry and a resource that
 * appeared meanwhile as changed. Never collides with a real version (sha256 hex, record ids, `gen:digest`, `owner:token`).
 */
export const ABSENT_VERSION = 'absent';

/** Default window of an instant metric query / scrape (a range query uses its own window, at least this long). */
export const DEFAULT_METRIC_WINDOW_MS = 60_000;

/** Tools whose successful result records a WRITE observation of the records they posted. */
const RECORD_WRITERS: ReadonlySet<string> = new Set([
  'blackboard.post_finding', 'blackboard.post_hypothesis', 'blackboard.report_coverage_gap', 'blackboard.post_risk', 'blackboard.post_review', 'blackboard.post_note',
  'blackboard.post_strategy', 'blackboard.post_decision',
]);

/**
 * (B[0]) `observedVersion` prefix of an observation whose content could NOT be verified against the current resource (e.g.
 * search hits whose lines no longer match the file, a diff of the working tree): it never equals a real version, so a
 * mutating action naming the resource is refused until the agent re-reads it (fail closed) — never pinned as current.
 */
export const UNVERIFIED_VERSION_PREFIX = 'unverified:';


/** (B[1]) Resource id of a run's plan (`plan` entries: version = the latest accepted plan revision, '0' before any). */
export function planResourceId(runId: string): string {
  return `run/${runId}/plan`;
}

const EXACT: Freshness = { kind: 'exact_version' };

// ------------------------------------------------------------------------------------------------ SQL log

interface ObservationRow {
  seq: unknown;
  run_id: string;
  agent_id: string;
  work_item_id: string | null;
  snapshot_id: string | null;
  tool_id: string;
  invocation_id: string;
  kind: 'read' | 'write';
  resource_type: string;
  resource_id: string;
  observed_version: string;
  observed_at: unknown;
  freshness: unknown;
}

function rowToObservation(r: ObservationRow): Observation {
  const o: Observation = {
    seq: Number(r.seq),
    runId: r.run_id,
    agentId: r.agent_id,
    toolId: r.tool_id,
    invocationId: r.invocation_id,
    kind: r.kind,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    observedVersion: r.observed_version,
    observedAt: toIso(r.observed_at),
    freshness: fromJsonColumn<Freshness>(r.freshness),
  };
  if (r.work_item_id !== null) o.workItemId = r.work_item_id;
  if (r.snapshot_id !== null) o.snapshotId = r.snapshot_id;
  return o;
}

/** The read-set entry of an observation (what a snapshot pins). */
export function observationEntry(o: ReadSetEntry): ReadSetEntry {
  return { resourceType: o.resourceType, resourceId: o.resourceId, observedVersion: o.observedVersion, observedAt: o.observedAt, freshness: o.freshness };
}

/**
 * The SQL ObservationLog (`ht_context_observations`, migration context/003-observations): append-only (UPDATE, DELETE
 * and TRUNCATE are refused by triggers), durable across worker restarts — a resumed or re-claimed agent keeps what it
 * observed.
 */
export function createObservationLog(deps: ContextDeps): ObservationLog {
  const { db } = deps;
  return {
    async record(source, entries) {
      requireText(source?.runId, 'source.runId');
      requireText(source.agentId, 'source.agentId');
      requireText(source.toolId, 'source.toolId');
      requireText(source.invocationId, 'source.invocationId');
      if (!Array.isArray(entries)) throw new HypertestError('invalid_argument', 'entries must be an array');
      entries.forEach((e, i) => {
        validateReadSetEntry(e, `entries[${i}]`);
        if (e.kind !== 'read' && e.kind !== 'write') throw new HypertestError('invalid_argument', `entries[${i}].kind must be read or write`);
      });
      if (entries.length === 0) return;
      const params: SqlParam[] = [];
      const values: string[] = [];
      for (const e of entries) {
        const row: SqlParam[] = [source.runId, source.agentId, source.workItemId ?? null, source.snapshotId ?? null, source.toolId, source.invocationId, e.kind, e.resourceType, e.resourceId, e.observedVersion, e.observedAt, JSON.stringify(e.freshness)];
        const placeholders = row.map((_, i) => `$${params.length + i + 1}${i === row.length - 1 ? '::jsonb' : ''}`);
        params.push(...row);
        values.push(`(${placeholders.join(', ')})`);
      }
      await db.query(
        `INSERT INTO ht_context_observations (run_id, agent_id, work_item_id, snapshot_id, tool_id, invocation_id, kind, resource_type, resource_id, observed_version, observed_at, freshness)
         VALUES ${values.join(', ')}`,
        params,
      );
    },

    async latest(scope) {
      requireText(scope?.runId, 'scope.runId');
      requireText(scope.agentId, 'scope.agentId');
      const limit = scope.limit === undefined ? undefined : resolveLimit(scope.limit, 1, 'scope.limit');
      const params: SqlParam[] = [scope.runId, scope.agentId];
      let where = 'run_id = $1 AND agent_id = $2';
      if (scope.snapshotId !== undefined) {
        requireText(scope.snapshotId, 'scope.snapshotId');
        params.push(scope.snapshotId);
        where += ` AND snapshot_id = $${params.length}`;
      }
      let sql = `SELECT * FROM (
          SELECT DISTINCT ON (resource_type, resource_id) seq, run_id, agent_id, work_item_id, snapshot_id, tool_id, invocation_id, kind,
                 resource_type, resource_id, observed_version, observed_at, freshness
            FROM ht_context_observations WHERE ${where}
           ORDER BY resource_type, resource_id, seq DESC
        ) latest ORDER BY seq DESC`;
      if (limit !== undefined) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
      }
      const r = await db.query<ObservationRow>(sql, params);
      return r.rows.map(rowToObservation);
    },
  };
}

// ------------------------------------------------------------------------------------------------ tool results → entries

/** Structural view of a tool execution request (satisfied by @hypertest/tools ToolExecutionRequest). */
export interface ObservedToolCall {
  toolId: string;
  input?: unknown;
  runId: string;
  workItemId?: string;
  agentId: string;
  invocationId: string;
  workspace?: { workspaceId: string; root: string; resourcePrefix: string };
  snapshot?: { snapshotId: string };
}

/** Structural view of a tool execution result (satisfied by @hypertest/tools ToolExecutionResult). */
export interface ObservedToolResult {
  status: string;
  structured?: unknown;
  evidenceRefs?: string[];
  /** (additive) What reached the model: `git.show` is observed only when it carries the whole shown content. */
  modelText?: string;
}

/** Ports the mapping may use (all optional: an observation that cannot be versioned is skipped). */
export interface ObservationPorts {
  /** ISO time of the observation (default: now). */
  now?: () => string;
  /** Current `${generation}:${buildDigest ?? ''}` of an environment (the environment resolver's version), undefined when unknown. */
  environmentVersion?: (environmentId: string) => Promise<string | undefined> | string | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Workspace-relative POSIX path of a tool path (like the tools' resource keys): no `./`, no trailing `/`. */
function normalizeRel(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    parts.push(seg);
  }
  return parts.join('/');
}

/** The file resource id the fs/git tools use: `<resourcePrefix>/<rel>` (see tools' workspaceResource). */
export function workspaceFileId(resourcePrefix: string, relPath: string): string {
  const rel = normalizeRel(relPath);
  return rel === '' ? resourcePrefix : `${resourcePrefix}/${rel}`;
}

async function fileVersion(root: string, rel: string): Promise<string> {
  const v = await fileResolver(root).currentVersion(normalizeRel(rel));
  return v ?? ABSENT_VERSION;
}

/**
 * The content a successful `git.show <rev> <path>` put in front of the model — only when ALL of it reached the model:
 * the model text is exactly the output (`structured.bytes` long; nothing truncated or offloaded, no evidence line).
 */
function shownContent(result: ObservedToolResult, structured: Record<string, unknown>): string | undefined {
  const text = result.modelText;
  const bytes = structured['bytes'];
  if (typeof text !== 'string' || typeof bytes !== 'number') return undefined;
  return Buffer.byteLength(text, 'utf8') === bytes ? text : undefined;
}

/** Seconds (unix, number or numeric string) or an RFC 3339 time → epoch ms; undefined when unparsable. */
function promTimeMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000;
  if (typeof v === 'string') {
    if (/^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v) * 1000;
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** max_age of a metric observation: the query window (range end − start), at least DEFAULT_METRIC_WINDOW_MS. */
export function metricWindowMs(input: unknown): number {
  const range = isRecord(input) && isRecord(input['range']) ? input['range'] : undefined;
  if (range) {
    const start = promTimeMs(range['start']);
    const end = promTimeMs(range['end']);
    if (start !== undefined && end !== undefined && end > start) return Math.max(DEFAULT_METRIC_WINDOW_MS, Math.round(end - start));
  }
  return DEFAULT_METRIC_WINDOW_MS;
}

/** One line an agent was shown of a workspace file (search hit, symbol hit, blame line). */
interface ShownLine {
  path: string;
  line: number;
  /** The text shown (possibly trimmed / clipped); undefined ⇒ only `name` must occur on the line. */
  text?: string;
  name?: string;
}

function shownMatches(current: string | undefined, shown: ShownLine): boolean {
  if (current === undefined) return false;
  if (shown.text !== undefined) {
    // (B[6]) a symbol-graph row shows its source line behind a `⟦write in Owner.method⟧ ` annotation
    const want = stripSymbolAnnotation(shown.text).replace(/\r$/, '').trim();
    const have = current.replace(/\r$/, '').trim();
    // tools clip long lines: what was shown must be the start of the current line
    return want.length === 0 ? have.length === 0 : have.startsWith(want.replace(/…$/, ''));
  }
  return shown.name !== undefined && current.includes(shown.name);
}

/**
 * (B[0]) Content-verified `file` pins of the lines a tool showed: per file, the sha256 of its CURRENT content when every
 * shown line still reads the same in it (the agent's knowledge is that version), else UNVERIFIED (a later action on the file
 * is refused until it is re-read: what was shown can no longer be tied to a version).
 */
async function shownFilePins(ws: NonNullable<ObservedToolCall['workspace']>, shown: ShownLine[], invocationId: string, add: (resourceId: string, version: string) => void, onMismatch: 'unverified' | 'skip' = 'unverified'): Promise<void> {
  const byPath = new Map<string, ShownLine[]>();
  for (const l of shown) {
    if (typeof l.path !== 'string' || l.path.length === 0 || !Number.isSafeInteger(l.line) || l.line < 1) continue;
    const rel = normalizeRel(l.path);
    if (rel === '' || rel.split('/').includes('..')) continue;
    byPath.set(rel, [...(byPath.get(rel) ?? []), l]);
  }
  for (const [rel, lines] of byPath) {
    let content: string | undefined;
    try {
      content = await readFile(join(ws.root, rel), 'utf8');
    } catch {
      content = undefined;
    }
    const current = content?.split('\n');
    const ok = content !== undefined && lines.every((l) => shownMatches(current![l.line - 1], l));
    if (ok) add(workspaceFileId(ws.resourcePrefix, rel), sha256Hex(content!));
    else if (onMismatch === 'unverified') add(workspaceFileId(ws.resourcePrefix, rel), `${UNVERIFIED_VERSION_PREFIX}${invocationId}`);
  }
}

/**
 * (B[2]) Content-verified `file` read entries of workspace lines shown to an agent outside a tool call (e.g. retrieval hits
 * in its assembled prompt): the sha256 of each file's current content when every shown line still reads the same, else an
 * UNVERIFIED version (a later action on the file is refused until it is re-read).
 */
export async function shownLineEntries(
  workspace: { root: string; resourcePrefix: string },
  lines: Array<{ path: string; line: number; text?: string; name?: string }>,
  source: string,
  now: string,
  onMismatch: 'unverified' | 'skip' = 'unverified',
): Promise<ObservedEntry[]> {
  const out: ObservedEntry[] = [];
  await shownFilePins({ workspaceId: '', root: workspace.root, resourcePrefix: workspace.resourcePrefix }, lines, source, (resourceId, observedVersion) => {
    out.push({ kind: 'read', resourceType: 'file', resourceId, observedVersion, observedAt: now, freshness: { kind: 'exact_version' } });
  }, onMismatch);
  return out;
}

function asList(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => isRecord(x)) : [];
}

/** Resource key of a black-box target, as the tools name it: `env/<id>` or `url/<host>`. */
function targetKey(input: Record<string, unknown>): string | undefined {
  const env = str(input['environmentId']);
  if (env) return `env/${env}`;
  const url = str(input['prometheusUrl']) ?? str(input['url']);
  if (!url) return undefined;
  try {
    return `url/${new URL(url).host.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

/**
 * What a successful tool call let the agent observe, as read-set entries (tool results → read set):
 *  - `fs.read` → `file` `<workspace>/<path>` at the sha256 the tool read (exact_version);
 *  - `git.show` with a path → `file` at its working-tree sha256 ONLY when the content shown (at `rev`) is exactly the
 *    current file (the whole output reached the model and hashes to it): the agent saw a committed version, so anything
 *    else claims nothing — a `git.show` never launders another agent's uncommitted change into the agent's knowledge;
 *  - `fs.write` → own WRITE of the written sha256; `fs.apply_patch` (applied) → own WRITE of every patched file;
 *  - `blackboard.read` → `finding` (findings) / `record` (other types) lineage at the record id read;
 *    `blackboard.post_*` → own WRITE of the posted record (the new head of its lineage);
 *  - `metrics.query` / `metrics.scrape` → `metric_window` `<env/<id>|url/<host>>/metrics` (ONE window per target: the
 *    agent's latest metric data of it) with max_age = the query window (range) or DEFAULT_METRIC_WINDOW_MS
 *    (instant/scrape): an action on that target is refused once that data is older than its window, and any fresh
 *    metric observation of the target refreshes it (a per-query key could never be refreshed once expired — the next
 *    window is another range — and would block every action on the target for good);
 *  - any call addressing `environmentId` → `environment` at its current generation/build (env.* tools: own WRITE, only
 *    while the environment is still at the generation the action's verified result names).
 * Anything else (and every non-success) observes nothing.
 */
export async function observationsOf(call: ObservedToolCall, result: ObservedToolResult, ports: ObservationPorts = {}): Promise<ObservedEntry[]> {
  if (!call || !result || result.status !== 'success') return [];
  const at = ports.now ? ports.now() : new Date().toISOString();
  const out: ObservedEntry[] = [];
  const add = (kind: ObservedEntry['kind'], resourceType: string, resourceId: string, observedVersion: string, freshness: Freshness = EXACT) => {
    out.push({ kind, resourceType, resourceId, observedVersion, observedAt: at, freshness });
  };
  const input = isRecord(call.input) ? call.input : {};
  const s = isRecord(result.structured) ? result.structured : {};
  const ws = call.workspace;
  switch (call.toolId) {
    case 'fs.read': {
      const path = str(s['path']) ?? str(input['path']);
      const sha = str(s['sha256']);
      if (ws && path !== undefined && sha) add('read', 'file', workspaceFileId(ws.resourcePrefix, path), sha);
      break;
    }
    case 'git.show': {
      const path = str(s['path']) ?? str(input['path']);
      const shown = shownContent(result, s);
      if (!ws || path === undefined || shown === undefined) break;
      const current = await fileResolver(ws.root).currentVersion(normalizeRel(path));
      if (current !== undefined && current === sha256Hex(shown)) add('read', 'file', workspaceFileId(ws.resourcePrefix, path), current);
      break;
    }
    case 'fs.write': {
      const path = str(s['path']) ?? str(input['path']);
      const sha = str(s['sha256']) ?? (typeof input['content'] === 'string' ? sha256Hex(input['content']) : undefined);
      if (ws && path !== undefined && sha) add('write', 'file', workspaceFileId(ws.resourcePrefix, path), sha);
      break;
    }
    case 'fs.apply_patch': {
      if (s['applied'] !== true || !ws) break;
      const files = Array.isArray(s['files']) ? s['files'].filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
      for (const f of files) add('write', 'file', workspaceFileId(ws.resourcePrefix, f), await fileVersion(ws.root, f));
      break;
    }
    case 'blackboard.read': {
      const records = Array.isArray(s['records']) ? s['records'] : [];
      for (const r of records) {
        if (!isRecord(r)) continue;
        const lineage = str(r['lineageId']);
        const recordId = str(r['recordId']);
        if (!lineage || !recordId) continue;
        add('read', r['recordType'] === 'finding' ? 'finding' : 'record', lineage, recordId);
        // (B[2]) a finding read in full also refreshes its withdrawal state (an agent told a finding was withdrawn
        // acknowledges it by reading it: its `finding_withdrawal` pin then names the current state)
        if (r['recordType'] === 'finding') {
          const withdrawal = findingWithdrawalVersion(isRecord(r['payload']) && !('withheld' in r['payload']) ? { payload: r['payload'] } : undefined);
          if (withdrawal !== undefined) add('read', 'finding_withdrawal', lineage, withdrawal);
        }
      }
      break;
    }
    case 'fs.search': {
      // (B[0]) the lines a search showed pin their files (content-verified)
      if (!ws) break;
      const shown = asList(s['matches']).map((m) => ({ path: String(m['path'] ?? ''), line: Number(m['line']), text: typeof m['text'] === 'string' ? m['text'] : '' }));
      await shownFilePins(ws, shown, call.invocationId, (id, v) => add('read', 'file', id, v));
      break;
    }
    case 'code.symbols':
    case 'code.references': {
      // (B[0]) retrieval hits pin their files (content-verified: the shown snippet / definition name is still on that line); a hit
      // from an index that lags the working tree (it no longer matches the file) pins nothing — it never overrides what the agent
      // knows of the file (e.g. its own write)
      if (!ws) break;
      const rows = [...asList(s['symbols']), ...asList(s['references'])];
      const shown: ShownLine[] = rows.map((r) => {
        const text = typeof r['snippet'] === 'string' ? r['snippet'] : typeof r['text'] === 'string' ? r['text'] : undefined;
        const l: ShownLine = { path: String(r['path'] ?? ''), line: Number(r['line']) };
        if (text !== undefined) l.text = text;
        else if (typeof r['name'] === 'string') l.name = r['name'];
        return l;
      });
      await shownFilePins(ws, shown, call.invocationId, (id, v) => add('read', 'file', id, v), 'skip');
      break;
    }
    case 'git.blame': {
      // (B[0]) blamed lines pin the file when every shown line is the current one (a blame at another revision whose lines
      // differ from the working tree claims nothing about the current file)
      const path = str(s['path']);
      if (!ws || path === undefined) break;
      const lines = asList(s['lines']).map((l) => ({ path, line: Number(l['line']), text: typeof l['content'] === 'string' ? l['content'] : '' }));
      if (lines.length === 0) break;
      const pins: Array<[string, string]> = [];
      await shownFilePins(ws, lines, call.invocationId, (id, v) => pins.push([id, v]));
      for (const [id, v] of pins) if (!v.startsWith(UNVERIFIED_VERSION_PREFIX) || str(input['rev']) === undefined) add('read', 'file', id, v);
      break;
    }
    case 'git.diff': {
      // (B[0]) a working-tree diff shows the CURRENT changes of its files (computed by the call): each file is pinned at its
      // current sha256 (a file gone since is ABSENT); a diff between revisions or of the index shows history only
      if (!ws || str(input['base']) !== undefined || input['staged'] === true) break;
      const files = Array.isArray(s['files']) ? s['files'].filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
      for (const f of files) add('read', 'file', workspaceFileId(ws.resourcePrefix, f), await fileVersion(ws.root, f));
      break;
    }
    case 'evidence.get':
    case 'evidence.query': {
      // (B[0]) evidence is append-only: what was read is pinned as immutable (recorded, never stale)
      const ids = call.toolId === 'evidence.get' ? [str(s['evidenceId'])] : asList(s['evidence']).map((e) => str(e['evidenceId']));
      for (const id of ids) if (id) add('read', 'evidence', id, id, { kind: 'immutable' });
      break;
    }
    case 'plan.read': {
      // (B[1]) the latest accepted plan the agent read (a CAS for plan.propose_revision); an older revision claims nothing
      const plan = isRecord(s['plan']) ? s['plan'] : undefined;
      const revisions = asList(s['revisions']);
      const latestAccepted = revisions.filter((r) => r['status'] === 'accepted').map((r) => Number(r['revision'])).filter(Number.isSafeInteger).sort((a, b) => b - a)[0];
      if (input['revision'] === undefined) add('read', 'plan', planResourceId(call.runId), String(latestAccepted ?? 0));
      else if (plan && latestAccepted !== undefined && Number(plan['revision']) === latestAccepted) add('read', 'plan', planResourceId(call.runId), String(latestAccepted));
      break;
    }
    case 'plan.propose_revision': {
      // own WRITE: the plan revision this agent's proposal made the latest accepted one
      if (s['accepted'] === true && typeof s['revision'] === 'number') add('write', 'plan', planResourceId(call.runId), String(s['revision']));
      break;
    }
    case 'experiment.define': {
      // own WRITE: the experiment revision this agent's definition recorded (a later mutating call of the turn is not stale by it)
      const id = str(s['experimentId']);
      if (id && typeof s['revision'] === 'number') add('write', 'experiment', id, String(s['revision']));
      break;
    }
    case 'oracle.get': {
      // the revision the run works with (the default read) is pinned; an explicitly requested OTHER revision is history and
      // claims nothing (`oracle` is always re-checked: pinning an old revision would block every later action for good)
      const o = isRecord(s['oracle']) ? s['oracle'] : undefined;
      const id = str(o?.['oracleId']);
      if (id && typeof o?.['revision'] === 'number' && (input['revision'] === undefined || s['pinnedByRun'] === true)) add('read', 'oracle', id, String(o['revision']));
      break;
    }
    case 'oracle.list': {
      for (const o of [...asList(s['pinned']), ...asList(s['otherApproved'])]) {
        const id = str(o['oracleId']);
        if (id && typeof o['revision'] === 'number') add('read', 'oracle', id, String(o['revision']));
      }
      break;
    }
    case 'metrics.query':
    case 'metrics.scrape': {
      const target = targetKey(input);
      if (!target) break;
      const version = str(s['evidenceId']) ?? result.evidenceRefs?.[0] ?? createHash('sha256').update(canonicalJson((result.structured ?? null) as JsonValue)).digest('hex');
      add('read', 'metric_window', `${target}/metrics`, version, { kind: 'max_age', milliseconds: metricWindowMs(input) });
      break;
    }
    default:
      if (RECORD_WRITERS.has(call.toolId)) {
        const lineage = str(s['lineageId']);
        const recordId = str(s['recordId']);
        if (lineage && recordId) add('write', call.toolId === 'blackboard.post_finding' ? 'finding' : 'record', lineage, recordId);
        // the finding this agent posted: its own (current) withdrawal state
        if (lineage && recordId && call.toolId === 'blackboard.post_finding') {
          const status = str(input['status']) ?? 'open';
          add('write', 'finding_withdrawal', lineage, FINDING_WITHDRAWN_STATUSES.includes(status) ? `withdrawn:${status}` : 'active');
        }
      }
  }
  const envId = str(input['environmentId']);
  if (envId && ports.environmentVersion) {
    const version = await ports.environmentVersion(envId);
    if (version !== undefined) {
      if (call.toolId.startsWith('env.')) {
        // own WRITE of the generation this action produced (its verified result names it): a later deploy by another agent,
        // landing between the action and this observation, is never recorded as the agent's own knowledge
        const produced = typeof s['generation'] === 'number' ? s['generation'] : undefined;
        const currentGeneration = version.includes(':') ? version.slice(0, version.indexOf(':')) : version;
        if (produced === undefined || currentGeneration === String(produced)) add('write', 'environment', envId, version);
      } else add('read', 'environment', envId, version);
    }
  }
  return out;
}

export interface ObserveToolRuntimeOptions extends ObservationPorts {
  log: ObservationLog;
  logger: Logger;
}

/**
 * Read-only tools whose whole purpose is to show the agent a versioned resource (observationsOf maps their result to
 * `read` entries). When their observation cannot be recorded, their output is withheld: the agent must not act on content
 * its read set does not pin (another agent's later change of it could not be caught — fail closed).
 */
const OBSERVING_READ_TOOLS: ReadonlySet<string> = new Set([
  'fs.read', 'git.show', 'blackboard.read', 'metrics.query', 'metrics.scrape',
  // (B[0]) every read whose result is pinned
  'fs.search', 'code.symbols', 'code.references', 'git.blame', 'git.diff', 'evidence.get', 'evidence.query', 'plan.read', 'oracle.get', 'oracle.list',
]);

/** The result of a read whose observation could not be recorded: `failed`/`unavailable`, the output withheld. */
function withheld<R>(result: R, toolId: string, error: string): R {
  const r = { ...(result as Record<string, unknown>) };
  const message = `${toolId} ran, but what it showed could not be recorded in your read set (${error}); its output is withheld because a later change of it could not be detected`;
  delete r['structured'];
  r['status'] = 'failed';
  r['error'] = { code: 'unavailable', message };
  r['artifactRefs'] = [];
  r['modelText'] = `[failed] unavailable: ${message}. Retry the call.`;
  return r as R;
}

/**
 * Wraps a ToolRuntime-shaped object so that every execution feeds the ObservationLog BEFORE its result is returned (the
 * next call of the same turn is validated against it): the per-turn observation collector of the read set. A recording
 * (or mapping) failure is logged and, for the read-only observing tools (fs.read, git.show, blackboard.read,
 * metrics.query/scrape), fails closed: the output is withheld (`failed` / `unavailable`) — an unpinned read would let a
 * later mutation go unchecked. The result of any other tool — an effect that already happened — is returned unchanged
 * (hiding it would invite a duplicate); its missing observation only makes later checks stricter.
 */
export function observeToolRuntime<T extends { execute(request: never): Promise<unknown> }>(runtime: T, options: ObserveToolRuntimeOptions): T {
  const { log, logger } = options;
  const execute = async (request: Parameters<T['execute']>[0]): Promise<Awaited<ReturnType<T['execute']>>> => {
    const result = (await runtime.execute(request)) as Awaited<ReturnType<T['execute']>>;
    const call = request as unknown as ObservedToolCall;
    try {
      const entries = await observationsOf(call, result as unknown as ObservedToolResult, options);
      if (entries.length > 0) {
        const source: ObservationSource = { runId: call.runId, agentId: call.agentId, toolId: call.toolId, invocationId: call.invocationId };
        if (call.workItemId) source.workItemId = call.workItemId;
        if (call.snapshot?.snapshotId) source.snapshotId = call.snapshot.snapshotId;
        await log.record(source, entries);
      }
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      if (OBSERVING_READ_TOOLS.has(call?.toolId) && (result as unknown as ObservedToolResult)?.status === 'success') {
        logger.error('tool observations could not be recorded; read withheld (fail closed)', { toolId: call.toolId, invocationId: call.invocationId, error });
        return withheld(result, call.toolId, error);
      }
      logger.warn('tool observations could not be recorded; they are not pinned in the read set', { toolId: call?.toolId, invocationId: call?.invocationId, error });
    }
    return result;
  };
  return { ...runtime, execute } as T;
}
