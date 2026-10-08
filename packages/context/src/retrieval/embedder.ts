import { HypertestError } from '@hypertest/core';
import type { Embedder } from '../contracts.ts';

export interface OpenAICompatibleEmbedderOptions {
  /** The provider's API base URL (…/v1); requests go to `${baseUrl}/embeddings`. */
  baseUrl: string;
  model: string;
  /** The vector size the model returns: every answer is verified against it (a mismatch is a provider_error, never padded). */
  dimensions: number;
  /** Bearer token (resolved by the caller from the provider's apiKeyEnv; never logged nor put in an error). */
  apiKey?: string;
  headers?: Record<string, string>;
  /** Per request (default 30 s). */
  timeoutMs?: number;
  /** Texts per request (default 64). */
  batchSize?: number;
  /** The fetch to use (tests inject a fake; default: the global fetch). */
  fetch?: typeof fetch;
}

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
}

/**
 * (B[6]) A semantic embedder over an OpenAI-compatible `POST /embeddings` endpoint (`retrieval.embedder` in the config):
 * `{ model, input: [texts] }` → `{ data: [{ index, embedding }] }`. Each answer must carry exactly one finite vector of
 * `dimensions` numbers per text, in index order; anything else is a provider_error (the hybrid retriever then fuses the
 * other retrievers). Its modelId names the provider route, model and size, so the pgvector index keeps its vectors apart
 * from the hashing embedder's.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly dims: number;
  readonly modelId: string;
  readonly #url: string;
  readonly #o: OpenAICompatibleEmbedderOptions;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAICompatibleEmbedderOptions) {
    if (!options || typeof options.baseUrl !== 'string' || !/^https?:\/\//i.test(options.baseUrl)) throw new HypertestError('invalid_argument', 'OpenAICompatibleEmbedder needs an http(s) baseUrl');
    if (typeof options.model !== 'string' || options.model.trim() === '') throw new HypertestError('invalid_argument', 'OpenAICompatibleEmbedder needs a model');
    if (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 16_000) throw new HypertestError('invalid_argument', 'dimensions must be an integer in [1, 16000]');
    if (options.timeoutMs !== undefined && !(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0)) throw new HypertestError('invalid_argument', 'timeoutMs must be a positive number');
    if (options.batchSize !== undefined && !(Number.isSafeInteger(options.batchSize) && options.batchSize > 0)) throw new HypertestError('invalid_argument', 'batchSize must be a positive integer');
    this.#o = options;
    this.#url = `${options.baseUrl.replace(/\/+$/, '')}/embeddings`;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.dims = options.dimensions;
    this.modelId = `openai-compatible:${options.model}:${options.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    const size = this.#o.batchSize ?? 64;
    for (let i = 0; i < texts.length; i += size) out.push(...(await this.#batch(texts.slice(i, i + size))));
    return out;
  }

  async #batch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(this.#o.headers ?? {}) };
    if (this.#o.apiKey) headers['authorization'] = `Bearer ${this.#o.apiKey}`;
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: 'POST',
        headers,
        // an empty string is not accepted by every server: embed a single space instead (same vector for every empty text)
        body: JSON.stringify({ model: this.#o.model, input: texts.map((t) => (t === '' ? ' ' : t)) }),
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new HypertestError('provider_error', `embeddings request to ${this.#url} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new HypertestError('provider_error', `embeddings endpoint ${this.#url} answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    let body: EmbeddingsResponse;
    try {
      body = (await res.json()) as EmbeddingsResponse;
    } catch (e) {
      throw new HypertestError('provider_error', `embeddings endpoint ${this.#url} answered invalid JSON`, { cause: e });
    }
    const data = Array.isArray(body?.data) ? body.data : undefined;
    if (!data || data.length !== texts.length) {
      throw new HypertestError('provider_error', `embeddings endpoint ${this.#url} returned ${data ? data.length : 'no'} vectors for ${texts.length} texts`);
    }
    const vectors = new Array<number[] | undefined>(texts.length);
    data.forEach((d, pos) => {
      const index = d.index ?? pos;
      if (!Number.isSafeInteger(index) || index < 0 || index >= texts.length || vectors[index] !== undefined) {
        throw new HypertestError('provider_error', `embeddings endpoint ${this.#url} returned an invalid or duplicate index ${String(d.index)}`);
      }
      const v = d.embedding;
      if (!Array.isArray(v) || v.length !== this.dims || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        throw new HypertestError('provider_error', `embeddings endpoint ${this.#url} returned vector #${index} that is not ${this.dims} finite numbers (model ${this.#o.model}; check retrieval.embedder.dimensions)`);
      }
      vectors[index] = v as number[];
    });
    return vectors as number[][];
  }
}
