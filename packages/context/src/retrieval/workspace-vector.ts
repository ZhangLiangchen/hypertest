import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HypertestError, noopLogger, sha256Hex, throwIfAborted, type Logger } from '@hypertest/core';
import type { Embedder, RetrievalHit, RetrievalKind, RetrievalQuery, Retriever, VectorDocument, VectorIndex } from '../contracts.ts';
import { resolveLimit } from '../util.ts';
import { classifyPath, readTextFile, resolveSearchDir, walkFiles } from './files.ts';
import { extractSymbols, languageOf } from './symbols.ts';
import { InMemoryVectorIndex } from './vector.ts';

/** One embedded unit of a workspace file: a symbol's body, a document section or a window of lines. */
export interface CodeChunk {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  kind: RetrievalKind;
  /** The definition or heading the chunk starts at. */
  symbol?: string;
}

const MARKDOWN_RE = /\.(md|mdx|markdown)$/i;
const FILE_KINDS: readonly RetrievalKind[] = ['code', 'test', 'doc'];

/**
 * Splits a file into chunks at its symbol definitions (TS/JS/Python/Go, SymbolIndex extraction) or markdown headings;
 * other text files (and oversized sections) are cut into windows of at most `maxLines` lines; every chunk text is
 * capped at `maxChars`. Blank chunks are dropped.
 */
export function chunkText(relPath: string, text: string, options: { maxLines?: number; maxChars?: number } = {}): CodeChunk[] {
  const maxLines = options.maxLines ?? 80;
  const maxChars = options.maxChars ?? 4000;
  if (!Number.isInteger(maxLines) || maxLines < 1 || !Number.isInteger(maxChars) || maxChars < 1) throw new HypertestError('invalid_argument', 'maxLines and maxChars must be positive integers');
  const lines = text.split('\n');
  const kind = classifyPath(relPath);
  const starts = new Map<number, string>();
  const lang = languageOf(relPath);
  if (lang) for (const d of extractSymbols(text, relPath, lang)) if (!starts.has(d.line)) starts.set(d.line, d.container ? `${d.container}.${d.name}` : d.name);
  if (MARKDOWN_RE.test(relPath)) {
    lines.forEach((l, i) => {
      const m = /^#{1,6}\s+(.*)$/.exec(l);
      if (m) starts.set(i + 1, m[1]!.trim().slice(0, 120));
    });
  }
  const bounds = [...starts.keys()].sort((a, b) => a - b);
  const sections: Array<{ start: number; end: number; symbol?: string }> = [];
  if (bounds.length === 0 || bounds[0]! > 1) sections.push({ start: 1, end: (bounds[0] ?? lines.length + 1) - 1 });
  bounds.forEach((b, i) => sections.push({ start: b, end: (bounds[i + 1] ?? lines.length + 1) - 1, symbol: starts.get(b)! }));
  const out: CodeChunk[] = [];
  for (const sec of sections) {
    for (let from = sec.start; from <= sec.end; from += maxLines) {
      const to = Math.min(sec.end, from + maxLines - 1);
      let body = lines.slice(from - 1, to).join('\n');
      if (body.trim() === '') continue;
      if (body.length > maxChars) body = body.slice(0, maxChars);
      const c: CodeChunk = { path: relPath, startLine: from, endLine: to, text: body, kind };
      if (sec.symbol !== undefined) c.symbol = sec.symbol;
      out.push(c);
    }
  }
  return out;
}

async function readTrimmed(p: string): Promise<string | undefined> {
  try {
    return (await readFile(p, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/**
 * The commit checked out at `root` (the repository or worktree containing it), read from the git metadata files only
 * (no git process): `.git` directory or `gitdir:` file, HEAD (detached sha or `ref:`), loose refs of the worktree and of
 * the common dir, then packed-refs. undefined when `root` is not in a repository or the ref cannot be resolved.
 */
export async function gitHeadCommit(root: string): Promise<string | undefined> {
  let dir = resolve(root);
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = join(dir, '.git');
    const st = await stat(dotGit).catch(() => undefined);
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec((await readTrimmed(dotGit)) ?? '');
        if (!m) return undefined;
        gitDir = resolve(dir, m[1]!.trim());
      }
      const head = await readTrimmed(join(gitDir, 'HEAD'));
      if (!head) return undefined;
      if (/^[0-9a-f]{40,64}$/.test(head)) return head;
      const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
      if (!ref || ref.split('/').includes('..')) return undefined;
      const common = await readTrimmed(join(gitDir, 'commondir'));
      const commonDir = common ? resolve(gitDir, common) : gitDir;
      for (const base of [gitDir, commonDir]) {
        const sha = await readTrimmed(join(base, ref));
        if (sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
      }
      const packed = (await readTrimmed(join(commonDir, 'packed-refs'))) ?? '';
      for (const line of packed.split('\n')) {
        const m = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(line.trim());
        if (m && m[2] === ref) return m[1];
      }
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

interface Corpus {
  key: string;
  index: VectorIndex;
  shared: boolean;
  ids: string[];
  files: number;
  truncated: boolean;
}

/**
 * LRU cache of the vector corpora of one process (shared by its WorkspaceVectorRetrievers): bounds the memory of many
 * parallel worktrees to `maxCorpora` corpora (default 8). An evicted corpus' documents leave a shared (pgvector) index;
 * an in-memory one is simply dropped (a later search of its workspace populates it again).
 */
export class VectorCorpusCache {
  readonly maxCorpora: number;
  readonly #entries = new Map<string, Promise<Corpus>>();
  readonly #logger: Logger;

  constructor(options: { maxCorpora?: number; logger?: Logger } = {}) {
    const max = options.maxCorpora ?? 8;
    if (!Number.isInteger(max) || max < 1) throw new HypertestError('invalid_argument', 'maxCorpora must be a positive integer');
    this.maxCorpora = max;
    this.#logger = options.logger ?? noopLogger;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The corpus `key` (most recently used first), populating it with `populate` when absent; a failed population is forgotten. */
  obtain(key: string, populate: () => Promise<Corpus>): Promise<Corpus> {
    let ready = this.#entries.get(key);
    if (ready) {
      this.#entries.delete(key);
      this.#entries.set(key, ready);
      return ready;
    }
    ready = populate();
    this.#entries.set(key, ready);
    ready.catch(() => {
      if (this.#entries.get(key) === ready) this.#entries.delete(key);
    });
    while (this.#entries.size > this.maxCorpora) {
      const [oldest, evicted] = this.#entries.entries().next().value!;
      this.#entries.delete(oldest);
      void this.#retire(evicted);
    }
    return ready;
  }

  async #retire(ready: Promise<Corpus>): Promise<void> {
    try {
      const old = await ready;
      if (old.shared && old.ids.length > 0) await old.index.remove(old.ids);
    } catch (e) {
      this.#logger.warn('an evicted vector corpus could not be removed', { error: (e as Error).message });
    }
  }
}

export interface WorkspaceVectorOptions {
  root: string;
  embedder: Embedder;
  /**
   * The corpus cache (shared across retrievers to bound memory); default: a private cache of one corpus (a new commit of
   * the root evicts the previous corpus).
   */
  cache?: VectorCorpusCache;
  /**
   * A shared persistent index (e.g. `createPgVectorIndex`), resolved once per corpus; undefined (or a rejected
   * promise) ⇒ an InMemoryVectorIndex per corpus. Documents of a corpus are namespaced `<corpus>:<kind>`.
   */
  sharedIndex?: () => Promise<VectorIndex | undefined>;
  /** Content version of the root (default gitHeadCommit; undefined ⇒ one corpus for the root's lifetime). */
  version?: (root: string) => Promise<string | undefined>;
  maxFiles?: number;
  maxFileBytes?: number;
  maxChunks?: number;
  maxLines?: number;
  maxChars?: number;
  defaultLimit?: number;
  logger?: Logger;
}

/**
 * L3 semantic retrieval over one workspace: the files under `root` are chunked (chunkText) and embedded LAZILY on the
 * first search, into a corpus cached per workspace + commit (VectorCorpusCache, LRU-bounded: a new HEAD populates another
 * corpus; an evicted corpus leaves a shared index). Bounded: at most `maxFiles` files (≤ `maxFileBytes`, text only, .gitignore/hidden/vendored
 * skipped like ExactSearch) and `maxChunks` chunks. Hits are `source: 'vector'` file refs with path + start line.
 * Uncommitted edits are not re-embedded until the commit changes (ExactSearch and the symbol index cover live text).
 */
export class WorkspaceVectorRetriever implements Retriever {
  readonly name = 'vector';
  readonly #o: Required<Omit<WorkspaceVectorOptions, 'sharedIndex' | 'logger' | 'cache'>> & Pick<WorkspaceVectorOptions, 'sharedIndex'>;
  readonly #logger: Logger;
  readonly #cache: VectorCorpusCache;

  constructor(options: WorkspaceVectorOptions) {
    if (!options || typeof options.root !== 'string' || options.root.length === 0) throw new HypertestError('invalid_argument', 'WorkspaceVectorRetriever needs a root');
    if (!options.embedder) throw new HypertestError('invalid_argument', 'WorkspaceVectorRetriever needs an embedder');
    const o = {
      root: options.root,
      embedder: options.embedder,
      version: options.version ?? gitHeadCommit,
      maxFiles: options.maxFiles ?? 2000,
      maxFileBytes: options.maxFileBytes ?? 256 * 1024,
      maxChunks: options.maxChunks ?? 5000,
      maxLines: options.maxLines ?? 80,
      maxChars: options.maxChars ?? 4000,
      defaultLimit: resolveLimit(options.defaultLimit, 10, 'defaultLimit'),
    };
    for (const k of ['maxFiles', 'maxFileBytes', 'maxChunks'] as const) {
      if (!Number.isInteger(o[k]) || o[k] < 1) throw new HypertestError('invalid_argument', `${k} must be a positive integer`);
    }
    this.#o = options.sharedIndex ? { ...o, sharedIndex: options.sharedIndex } : o;
    this.#logger = options.logger ?? noopLogger;
    this.#cache = options.cache ?? new VectorCorpusCache({ maxCorpora: 1, logger: this.#logger });
  }

  /** The current corpus (populating it when the root's version changed), for diagnostics and tests. */
  async corpus(signal?: AbortSignal): Promise<{ key: string; documents: number; files: number; shared: boolean; truncated: boolean }> {
    const c = await this.#current(signal);
    return { key: c.key, documents: c.ids.length, files: c.files, shared: c.shared, truncated: c.truncated };
  }

  async search(query: RetrievalQuery, signal?: AbortSignal): Promise<RetrievalHit[]> {
    throwIfAborted(signal);
    const limit = resolveLimit(query.limit, this.#o.defaultLimit, 'query.limit');
    const kinds = (query.kinds && query.kinds.length > 0 ? query.kinds : FILE_KINDS).filter((k) => FILE_KINDS.includes(k));
    if (kinds.length === 0) return [];
    const c = await this.#current(signal);
    // namespaces of this corpus (a shared index holds other roots/commits too)
    const namespaced = { ...query, limit, kinds: kinds.map((k) => `${c.key}:${k}`) as RetrievalKind[] };
    return c.index.search(namespaced, signal);
  }

  async #current(signal?: AbortSignal): Promise<Corpus> {
    const absRoot = (await resolveSearchDir(this.#o.root, undefined)).absRoot;
    const version = await this.#o.version(absRoot);
    // per workspace + commit: a worktree's corpus is built from ITS files (uncommitted edits included), so it is never
    // shared with another agent's worktree of the same commit (no cross-agent leak)
    const key = 'wv_' + sha256Hex(`${absRoot}\u0000${version ?? 'worktree'}`).slice(0, 16);
    return this.#cache.obtain(key, () => this.#populate(absRoot, key, signal));
  }

  async #populate(absRoot: string, key: string, signal?: AbortSignal): Promise<Corpus> {
    let index: VectorIndex | undefined;
    if (this.#o.sharedIndex) {
      try {
        index = await this.#o.sharedIndex();
      } catch (e) {
        this.#logger.info('shared vector index unavailable; using an in-memory index', { error: (e as Error).message });
      }
    }
    const shared = index !== undefined;
    index ??= new InMemoryVectorIndex(this.#o.embedder);
    const ids: string[] = [];
    let files = 0;
    let truncated = false;
    let batch: VectorDocument[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await index.upsert(batch);
      ids.push(...batch.map((d) => d.id));
      batch = [];
    };
    for await (const f of walkFiles(absRoot, absRoot, { maxFileBytes: this.#o.maxFileBytes, ...(signal ? { signal } : {}) })) {
      if (files >= this.#o.maxFiles || ids.length + batch.length >= this.#o.maxChunks) {
        truncated = true;
        break;
      }
      let text: string | undefined;
      try {
        text = await readTextFile(f.absPath);
      } catch {
        continue;
      }
      if (text === undefined) continue;
      files++;
      for (const c of chunkText(f.relPath, text, { maxLines: this.#o.maxLines, maxChars: this.#o.maxChars })) {
        if (ids.length + batch.length >= this.#o.maxChunks) {
          truncated = true;
          break;
        }
        const doc: VectorDocument = {
          id: `${key}:${c.path}#${c.startLine}-${c.endLine}`,
          text: `${c.path}${c.symbol ? ` ${c.symbol}` : ''}\n${c.text}`,
          ref: { kind: 'file', id: c.path, ...(c.symbol ? { note: c.symbol } : {}) },
          path: c.path,
          line: c.startLine,
          namespace: `${key}:${c.kind}`,
        };
        batch.push(doc);
        if (batch.length >= 128) await flush();
      }
    }
    await flush();
    if (truncated) this.#logger.info('vector corpus truncated at its bounds', { root: absRoot, files, chunks: ids.length, maxFiles: this.#o.maxFiles, maxChunks: this.#o.maxChunks });
    this.#logger.debug('vector corpus populated', { root: absRoot, key, files, chunks: ids.length, shared });
    return { key, index, shared, ids, files, truncated };
  }
}
