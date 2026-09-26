import { fromJsonColumn, HypertestError, throwIfAborted, type SqlDatabase } from '@hypertest/core';
import type { Ref } from '@hypertest/domain';
import type { Embedder, RetrievalHit, RetrievalQuery, VectorDocument, VectorIndex } from '../contracts.ts';
import { cmpStr, requireText, resolveLimit, tokenize } from '../util.ts';
import { assertRelativeInside, compileGlobs } from './files.ts';

/** FNV-1a 32-bit with a seed (deterministic, fast, no crypto needed for feature hashing). */
function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic feature-hashing embedder (tests / offline): lowercase alphanumeric tokens with camelCase and
 * snake_case splitting, hashed into `dims` buckets with a sign hash, L2-normalized. No token ⇒ zero vector.
 */
export class HashEmbedder implements Embedder {
  readonly dims: number;
  readonly modelId: string;

  constructor(options: { dims?: number } = {}) {
    const dims = options.dims ?? 256;
    if (!Number.isInteger(dims) || dims < 8 || dims > 16000) throw new HypertestError('invalid_argument', 'dims must be an integer in [8, 16000]');
    this.dims = dims;
    this.modelId = `hash-v1-${dims}`;
  }

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    for (const tok of tokenize(text)) {
      const idx = fnv1a(tok, 0) % this.dims;
      const sign = fnv1a(tok, 0x9e3779b9) & 1 ? 1 : -1;
      v[idx]! += sign;
    }
    const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
    return norm === 0 ? v : v.map((x) => x / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    na += a[i]! * a[i]!;
    nb += (b[i] ?? 0) * (b[i] ?? 0);
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** The embedder must return one finite vector of `dims` numbers per text (else provider_error, never a silent 0). */
async function embedChecked(embedder: Embedder, texts: string[]): Promise<number[][]> {
  const vecs = await embedder.embed(texts);
  if (!Array.isArray(vecs) || vecs.length !== texts.length) {
    throw new HypertestError('provider_error', `embedder ${embedder.modelId} returned ${Array.isArray(vecs) ? vecs.length : 'no'} vectors for ${texts.length} texts`);
  }
  vecs.forEach((v, i) => {
    if (!Array.isArray(v) || v.length !== embedder.dims || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new HypertestError('provider_error', `embedder ${embedder.modelId} returned an invalid vector #${i} (expected ${embedder.dims} finite numbers)`);
    }
  });
  return vecs;
}

function validateDoc(d: VectorDocument, i: number): void {
  requireText(d?.id, `docs[${i}].id`);
  requireText(d.namespace, `docs[${i}].namespace`);
  if (typeof d.text !== 'string') throw new HypertestError('invalid_argument', `docs[${i}].text must be a string`);
  if (!d.ref || typeof d.ref.kind !== 'string' || typeof d.ref.id !== 'string') throw new HypertestError('invalid_argument', `docs[${i}].ref must be a Ref`);
}

/**
 * query.root scoping for documents: only documents whose path lies inside the (relative) root match; documents
 * without a path never do. Absolute and `..` roots are refused like in ExactSearch.
 */
function normalizeRoot(root: string | undefined): string | undefined {
  if (root === undefined || root === '' || root === '.') return undefined;
  assertRelativeInside(root, 'query.root');
  const r = root.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return r === '' || r === '.' ? undefined : r;
}

function rootFilter(root: string | undefined): ((path: string | undefined) => boolean) | undefined {
  const r = normalizeRoot(root);
  if (r === undefined) return undefined;
  return (path) => path !== undefined && (path === r || path.startsWith(r + '/'));
}

function snippet(text: string): string {
  const t = text.trim();
  return t.length > 240 ? t.slice(0, 239) + '…' : t;
}

function hitOf(doc: { ref: Ref; path?: string | undefined; line?: number | undefined; text: string }, score: number): RetrievalHit {
  const hit: RetrievalHit = { source: 'vector', ref: doc.ref, snippet: snippet(doc.text), score };
  if (doc.path !== undefined) hit.path = doc.path;
  if (doc.line !== undefined) hit.line = doc.line;
  return hit;
}

/** In-memory cosine index; query.kinds filters by namespace (namespace = kind). */
export class InMemoryVectorIndex implements VectorIndex {
  readonly name = 'vector';
  readonly #embedder: Embedder;
  readonly #docs = new Map<string, { doc: VectorDocument; vec: number[] }>();

  constructor(embedder: Embedder) {
    this.#embedder = embedder;
  }

  get size(): number {
    return this.#docs.size;
  }

  async upsert(docs: VectorDocument[]): Promise<void> {
    docs.forEach(validateDoc);
    const vecs = await embedChecked(this.#embedder, docs.map((d) => d.text));
    docs.forEach((d, i) => this.#docs.set(d.id, { doc: { ...d }, vec: vecs[i]! }));
  }

  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.#docs.delete(id);
  }

  async search(query: RetrievalQuery, signal?: AbortSignal): Promise<RetrievalHit[]> {
    throwIfAborted(signal);
    const limit = resolveLimit(query.limit, 10, 'query.limit');
    const globs = compileGlobs(query.pathGlobs);
    const inRoot = rootFilter(query.root);
    const [q] = await embedChecked(this.#embedder, [query.text ?? '']);
    const kinds = query.kinds && query.kinds.length > 0 ? new Set<string>(query.kinds) : undefined;
    const scored: Array<{ id: string; hit: RetrievalHit }> = [];
    for (const [id, { doc, vec }] of this.#docs) {
      if (kinds && !kinds.has(doc.namespace)) continue;
      if (globs && (doc.path === undefined || !globs(doc.path))) continue;
      if (inRoot && !inRoot(doc.path)) continue;
      const s = cosine(q!, vec);
      if (!(s > 0)) continue;
      scored.push({ id, hit: hitOf(doc, s) });
    }
    return scored
      .sort((a, b) => b.hit.score - a.hit.score || cmpStr(a.id, b.id))
      .slice(0, limit)
      .map((x) => x.hit);
  }
}

function vectorLiteral(v: readonly number[]): string {
  return '[' + v.map((x) => String(x)).join(',') + ']';
}

interface VectorRow {
  id: string;
  ref: unknown;
  path: string | null;
  line: number | null;
  text: string;
  distance: number | string | null;
}

/**
 * pgvector-backed index on `ht_vectors` (created lazily here, never by migrations). Requires the `vector`
 * extension: when `CREATE EXTENSION IF NOT EXISTS vector` fails this throws HypertestError('unsupported')
 * so callers can fall back to InMemoryVectorIndex. Rows are keyed by (model_id, id): indexes of different
 * embedders share the table without overwriting or removing each other's documents, and searches only compare
 * vectors of the same model. A table created with other dimensions is `conflict`.
 */
export async function createPgVectorIndex(db: SqlDatabase, embedder: Embedder): Promise<VectorIndex> {
  const dims = embedder.dims;
  if (!Number.isInteger(dims) || dims <= 0) throw new HypertestError('invalid_argument', 'embedder.dims must be a positive integer');
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  } catch (e) {
    throw new HypertestError('unsupported', `pgvector is not available on this database: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('ht_vectors'))");
    await tx.query(`CREATE TABLE IF NOT EXISTS ht_vectors (
      id text NOT NULL,
      namespace text NOT NULL,
      model_id text NOT NULL,
      ref jsonb NOT NULL,
      path text,
      line integer,
      text text NOT NULL,
      embedding vector(${dims}) NOT NULL,
      PRIMARY KEY (model_id, id)
    )`);
    // Upgrade a table created by an earlier revision (primary key on id alone ⇒ models clobbered each other).
    const pk = await tx.query<{ col: string }>(
      `SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'ht_vectors'::regclass AND i.indisprimary ORDER BY a.attname`,
    );
    if (pk.rows.map((r) => r.col).join(',') !== 'id,model_id') {
      const con = await tx.query<{ name: string }>(`SELECT conname AS name FROM pg_constraint WHERE conrelid = 'ht_vectors'::regclass AND contype = 'p'`);
      for (const c of con.rows) await tx.query(`ALTER TABLE ht_vectors DROP CONSTRAINT "${c.name.replace(/"/g, '""')}"`);
      await tx.query('ALTER TABLE ht_vectors ADD PRIMARY KEY (model_id, id)');
    }
    await tx.query('CREATE INDEX IF NOT EXISTS ht_vectors_namespace_idx ON ht_vectors (model_id, namespace)');
  });
  const typ = await db.query<{ t: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
      WHERE a.attrelid = 'ht_vectors'::regclass AND a.attname = 'embedding'`,
  );
  if (typ.rows[0]?.t !== `vector(${dims})`) {
    throw new HypertestError('conflict', `ht_vectors.embedding is ${typ.rows[0]?.t ?? 'missing'}, the embedder needs vector(${dims})`);
  }

  return {
    name: 'vector',
    async upsert(docs) {
      docs.forEach(validateDoc);
      if (docs.length === 0) return;
      const vecs = await embedChecked(embedder, docs.map((d) => d.text));
      await db.transaction(async (tx) => {
        for (let i = 0; i < docs.length; i++) {
          const d = docs[i]!;
          await tx.query(
            `INSERT INTO ht_vectors (id, namespace, model_id, ref, path, line, text, embedding) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::vector)
             ON CONFLICT (model_id, id) DO UPDATE SET namespace = EXCLUDED.namespace, ref = EXCLUDED.ref, path = EXCLUDED.path,
               line = EXCLUDED.line, text = EXCLUDED.text, embedding = EXCLUDED.embedding`,
            [d.id, d.namespace, embedder.modelId, JSON.stringify(d.ref), d.path ?? null, d.line ?? null, d.text, vectorLiteral(vecs[i]!)],
          );
        }
      });
    },
    async remove(ids) {
      if (ids.length === 0) return;
      // Only this embedder's documents: another model's index keeps its rows.
      await db.query('DELETE FROM ht_vectors WHERE model_id = $1 AND id = ANY($2)', [embedder.modelId, ids]);
    },
    async search(query: RetrievalQuery, signal?: AbortSignal) {
      throwIfAborted(signal);
      const limit = resolveLimit(query.limit, 10, 'query.limit');
      const globs = compileGlobs(query.pathGlobs);
      const root = normalizeRoot(query.root);
      const inRoot = rootFilter(query.root);
      const [q] = await embedChecked(embedder, [query.text ?? '']);
      if (!q || q.every((x) => x === 0)) return [];
      const params: Array<string | number | string[]> = [vectorLiteral(q), embedder.modelId];
      let sql = `SELECT id, ref, path, line, text, (embedding <=> $1::vector)::float8 AS distance FROM ht_vectors WHERE model_id = $2`;
      if (query.kinds && query.kinds.length > 0) {
        params.push([...query.kinds]);
        sql += ` AND namespace = ANY($${params.length})`;
      }
      if (root !== undefined) {
        params.push(root);
        sql += ` AND (path = $${params.length} OR starts_with(path, $${params.length} || '/'))`;
      }
      params.push(globs ? limit * 5 : limit);
      sql += ` ORDER BY embedding <=> $1::vector ASC, id ASC LIMIT $${params.length}`;
      const r = await db.query<VectorRow>(sql, params);
      const hits: RetrievalHit[] = [];
      for (const row of r.rows) {
        const distance = Number(row.distance);
        const score = 1 - distance;
        if (!Number.isFinite(score) || !(score > 0)) continue;
        if (globs && (row.path === null || !globs(row.path))) continue;
        if (inRoot && !inRoot(row.path ?? undefined)) continue;
        hits.push(hitOf({ ref: fromJsonColumn<Ref>(row.ref), path: row.path ?? undefined, line: row.line ?? undefined, text: row.text }, score));
      }
      return hits.slice(0, limit);
    },
  };
}
