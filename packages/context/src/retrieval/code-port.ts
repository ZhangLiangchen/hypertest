import type { Logger } from '@hypertest/core';
import type { SymbolDefinition, SymbolReference, SymbolUsage } from '../contracts.ts';
import { SymbolIndex } from './symbols.ts';

/** One row of the code tools' retrieval port (`BuiltinToolOptions.retrieval` of @hypertest/tools, structurally). */
export interface CodeToolRetrievalRow {
  path?: string;
  line?: number;
  snippet: string;
  score: number;
}

export interface CodeToolRetrieval {
  search(query: { text: string; symbol?: string; root?: string; limit?: number }): Promise<CodeToolRetrievalRow[]>;
}

/**
 * The annotation a symbol-graph row carries in front of the source line it shows: `⟦write in AccountState.bump⟧ this.version
 * += 1`. The ReadSet's line verification strips it (stripSymbolAnnotation) so the shown line still pins its file.
 */
const ANNOTATION_RE = /^⟦[^⟧\n]*⟧ /;

export function stripSymbolAnnotation(snippet: string): string {
  return snippet.replace(ANNOTATION_RE, '');
}

const USAGE_ORDER: Record<SymbolUsage, number> = { write: 0, call: 1, read: 2, import: 3 };
const USAGE_SCORE: Record<SymbolUsage, number> = { write: 0.9, call: 0.8, read: 0.5, import: 0.3 };

function definitionRow(d: SymbolDefinition, exact: boolean): CodeToolRetrievalRow {
  return { path: d.path, line: d.line, snippet: `⟦definition ${d.kind} ${d.container ? `${d.container}.` : ''}${d.name}⟧ ${d.signature}`, score: exact ? 1 : 0.7 };
}

function referenceRow(r: SymbolReference): CodeToolRetrievalRow {
  const usage = r.usage ?? 'read';
  return { path: r.path, line: r.line, snippet: `⟦${usage}${r.enclosing ? ` in ${r.enclosing}` : ''}⟧ ${r.snippet}`, score: USAGE_SCORE[usage] };
}

/**
 * (B[6]) The retrieval port of the agent code tools over the L3 symbol graph (syntax-tree parsed: TypeScript compiler API,
 * python3 `ast`, Go `go/ast`; regex only as a per-file fallback), replacing their own regex scan:
 *  - `code.symbols` (a `symbol` query) → definitions whose name contains it, exact first, each labelled with its kind and
 *    container (`⟦definition method AccountState.bump⟧ bump(): void {`);
 *  - `code.references` (a `text` query: `name` or `Owner.member`) → the definitions, then every reference classified from
 *    the syntax tree — writes first, then calls, reads and imports — with its enclosing definition (`⟦write in
 *    AccountState.bump⟧ this.version += 1`): "who writes AccountState.version?" is `code.references AccountState.version`
 *    (writes of `version` narrowed to AccountState's methods and the files using AccountState).
 * One index per workspace root (bounded LRU), rebuilt incrementally before every query (only changed files are re-parsed),
 * so an agent sees its own edits. `goHelperDir`: the private directory of the Go helper (SymbolIndexOptions.goHelperDir).
 */
export function createCodeToolRetrieval(options: { logger?: Logger; maxRoots?: number; goHelperDir?: string } = {}): CodeToolRetrieval {
  const maxRoots = options.maxRoots ?? 16;
  const indexes = new Map<string, SymbolIndex>();
  const indexFor = (root: string): SymbolIndex => {
    let index = indexes.get(root);
    if (index) indexes.delete(root);
    else index = new SymbolIndex(options.goHelperDir !== undefined ? { root, goHelperDir: options.goHelperDir } : { root });
    indexes.set(root, index);
    while (indexes.size > maxRoots) indexes.delete(indexes.keys().next().value!);
    return index;
  };
  return {
    async search(query) {
      if (typeof query.root !== 'string' || query.root === '') return [];
      const limit = Math.max(1, Math.min(query.limit ?? 200, 5000));
      const index = indexFor(query.root);
      const built = await index.build();
      options.logger?.debug('code tools: symbol graph refreshed', { root: query.root, files: built.files, symbols: built.symbols });
      if (query.symbol !== undefined) {
        const q = query.symbol.trim().toLowerCase();
        return (await index.definitionsMatching(query.symbol, limit)).map((d) => definitionRow(d, d.name.toLowerCase() === q));
      }
      const target = query.text.trim();
      if (!/^[A-Za-z_$#][\w$#]*(?:\.[A-Za-z_$#][\w$#]*)*$/.test(target)) return [];
      const member = target.split('.').at(-1)!;
      const rows: CodeToolRetrievalRow[] = (await index.findDefinitions(member)).map((d) => definitionRow(d, true));
      let refs = await index.findReferences(member, Number.MAX_SAFE_INTEGER);
      if (target.includes('.')) {
        // Owner.member: writes narrowed to the owner (SymbolIndex.writers); the other usages stay (labelled, for context)
        const writes = new Set((await index.writers(target, Number.MAX_SAFE_INTEGER)).map((r) => `${r.path}:${r.line}`));
        refs = refs.filter((r) => r.usage !== 'write' || writes.has(`${r.path}:${r.line}`));
      }
      refs.sort((a, b) => USAGE_ORDER[a.usage ?? 'read'] - USAGE_ORDER[b.usage ?? 'read'] || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
      rows.push(...refs.map(referenceRow));
      return rows.slice(0, limit);
    },
  };
}
