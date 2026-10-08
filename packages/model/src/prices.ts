import { readFile, rename, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HypertestError, type Logger } from '@hypertest/core';
import type { ObservedPrice, PriceSource } from './contracts.ts';

/**
 * (A[1]) Observed model prices as a file — the runtime-observable price channel of the price guard. Format:
 *
 *   { "version": 1, "prices": { "<routeId>": { "inputPerMillionUsd": 3, "outputPerMillionUsd": 15,
 *                                              "observedAt": "2026-10-08T00:00:00Z", "source": "operator" } } }
 *
 * `hypertest models prices set` writes it (atomically: temp file + rename); a running Hypertest re-reads it at the next
 * safe point (the router reads the source at every route / invoke / validate) when its modification time or size changed.
 * A file that cannot be parsed keeps the last good prices (logged) — a broken edit never removes the guard.
 */
export interface PricesFile {
  version: 1;
  prices: Record<string, ObservedPrice>;
}

function finiteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Validates a prices file document (throws invalid_argument with the first problems). */
export function parsePricesFile(raw: unknown, where = 'prices file'): PricesFile {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HypertestError('invalid_argument', `${where}: must be a JSON object { version: 1, prices: { <routeId>: {...} } }`);
  const doc = raw as Record<string, unknown>;
  if (doc['version'] !== 1) problems.push(`version must be 1 (got ${JSON.stringify(doc['version'])})`);
  const prices = doc['prices'];
  const out: Record<string, ObservedPrice> = {};
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) problems.push('prices must be a mapping of route id to price');
  else {
    for (const [routeId, p] of Object.entries(prices as Record<string, unknown>)) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        problems.push(`prices.${routeId} must be an object`);
        continue;
      }
      const e = p as Record<string, unknown>;
      if (!finiteNonNegative(e['inputPerMillionUsd']) || !finiteNonNegative(e['outputPerMillionUsd'])) {
        problems.push(`prices.${routeId}: inputPerMillionUsd and outputPerMillionUsd must be finite numbers ≥ 0`);
        continue;
      }
      const price: ObservedPrice = { inputPerMillionUsd: e['inputPerMillionUsd'], outputPerMillionUsd: e['outputPerMillionUsd'] };
      if (typeof e['observedAt'] === 'string') price.observedAt = e['observedAt'];
      if (typeof e['source'] === 'string') price.source = e['source'];
      out[routeId] = price;
    }
  }
  if (problems.length > 0) throw new HypertestError('invalid_argument', `${where}: ${problems.join('; ')}`, { details: { problems } });
  return { version: 1, prices: out };
}

/** A PriceSource over a prices file, re-read when it changes (mtime/size); a missing file means "no observed prices". */
export function createFilePriceSource(path: string, options: { logger?: Logger } = {}): PriceSource & { readonly path: string } {
  let key: string | undefined;
  let last: Record<string, ObservedPrice> = {};
  return {
    path,
    async current() {
      let st;
      try {
        st = await stat(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          key = undefined;
          last = {};
          return last;
        }
        throw e;
      }
      const k = `${st.ino}:${st.mtimeMs}:${st.size}`;
      if (k === key) return last;
      try {
        last = parsePricesFile(JSON.parse(await readFile(path, 'utf8')), path).prices;
        key = k;
        options.logger?.info('observed model prices loaded', { path, routes: Object.keys(last).length });
      } catch (e) {
        options.logger?.error('observed model prices could not be read; keeping the last good prices', { path, error: (e as Error).message });
      }
      return last;
    },
  };
}

/** Reads a prices file (an empty document when it does not exist). */
export async function readPricesFile(path: string): Promise<PricesFile> {
  try {
    return parsePricesFile(JSON.parse(await readFile(path, 'utf8')), path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, prices: {} };
    throw e;
  }
}

/**
 * Sets (or with `price` undefined removes) the observed price of one route, atomically (temp file + rename), and returns
 * the new document. Used by `hypertest models prices set|clear`.
 */
export async function updatePricesFile(path: string, routeId: string, price: ObservedPrice | undefined): Promise<PricesFile> {
  if (typeof routeId !== 'string' || routeId.trim() === '') throw new HypertestError('invalid_argument', 'routeId must be a non-empty string');
  const doc = await readPricesFile(path);
  if (price === undefined) delete doc.prices[routeId];
  else doc.prices[routeId] = parsePricesFile({ version: 1, prices: { [routeId]: price } }).prices[routeId]!;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return doc;
}
