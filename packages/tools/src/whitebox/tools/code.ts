import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonValue } from '@hypertest/core';
import type { BuiltinToolOptions, ToolSpec } from '../../contracts.ts';
import { rootResource } from './common.ts';

export type SymbolKind = 'function' | 'class' | 'method' | 'variable' | 'type' | 'interface';
export interface SymbolHit {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
}

const CODE_FILE = /\.(m|c)?[jt]sx?$|\.py$|\.go$/;
const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '__pycache__', '.venv', 'venv', 'coverage']);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'new', 'typeof']);

type Rule = { re: RegExp; kind: SymbolKind };
const RULES: Record<'js' | 'py' | 'go', Rule[]> = {
  js: [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/, kind: 'type' },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: 'function' },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'variable' },
    { re: /^\s+(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/, kind: 'method' },
  ],
  py: [
    { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class' },
    { re: /^([A-Z_][A-Z0-9_]*)\s*=/, kind: 'variable' },
  ],
  go: [
    { re: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, kind: 'method' },
    { re: /^func\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: 'interface' },
    { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: 'class' },
    { re: /^type\s+([A-Za-z_]\w*)\b/, kind: 'type' },
    { re: /^(?:var|const)\s+([A-Za-z_]\w*)/, kind: 'variable' },
  ],
};

function langOf(file: string): 'js' | 'py' | 'go' {
  return file.endsWith('.py') ? 'py' : file.endsWith('.go') ? 'go' : 'js';
}

/** Workspace code files (bounded walk, stable order). */
export async function codeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= MAX_FILES) return;
      if (name.startsWith('.') || SKIP.has(name)) continue;
      const p = join(dir, name);
      const st = await lstat(p).catch(() => undefined);
      if (!st || st.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) await walk(p, r);
      else if (st.isFile() && CODE_FILE.test(name) && st.size <= MAX_FILE_BYTES) out.push(r);
    }
  };
  await walk(root, '');
  return out;
}

/** Regex-based symbol definitions of one file (TS/JS, Python, Go). */
export function extractSymbols(path: string, source: string): SymbolHit[] {
  const lang = langOf(path);
  const hits: SymbolHit[] = [];
  source.split('\n').forEach((line, i) => {
    for (const rule of RULES[lang]) {
      const m = rule.re.exec(line);
      if (!m) continue;
      let name = m[m.length - 1]!;
      let kind = rule.kind;
      if (lang === 'py' && rule.kind === 'function') {
        name = m[2]!;
        if ((m[1] ?? '').length > 0) kind = 'method';
      }
      if (KEYWORDS.has(name)) continue;
      hits.push({ name, kind, path, line: i + 1 });
      break;
    }
  });
  return hits;
}

interface SymbolsInput {
  query: string;
  kind?: SymbolKind;
  limit?: number;
}

export function codeSymbolsTool(options: BuiltinToolOptions): ToolSpec<SymbolsInput> {
  return {
    id: 'code.symbols',
    title: 'Find symbols',
    description: 'Find symbol definitions (functions, classes, methods, types, interfaces, variables) whose name contains the query (case-insensitive; exact matches first) across TS/JS, Python and Go files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        kind: { enum: ['function', 'class', 'method', 'variable', 'type', 'interface'] },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
    },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 60_000,
    resources: (_input, ctx) => [rootResource(ctx)],
    async execute(input, ctx) {
      const limit = input.limit ?? 50;
      if (options.retrieval) {
        const rows = await options.retrieval.search({ text: input.query, symbol: input.query, root: ctx.workspace.root, limit });
        const symbols = rows.slice(0, limit).map((r) => ({ path: r.path ?? null, line: r.line ?? null, snippet: r.snippet, score: r.score }));
        return { status: 'success', structured: { engine: 'retrieval', symbols: symbols as unknown as JsonValue }, text: symbols.map((s) => `${s.path ?? '?'}:${s.line ?? '?'} ${s.snippet}`).join('\n') || 'no symbols found' };
      }
      const q = input.query.toLowerCase();
      const hits: SymbolHit[] = [];
      for (const f of await codeFiles(ctx.workspace.root)) {
        const src = await readFile(join(ctx.workspace.root, f), 'utf8').catch(() => '');
        for (const h of extractSymbols(f, src)) if (h.name.toLowerCase().includes(q) && (!input.kind || h.kind === input.kind)) hits.push(h);
      }
      hits.sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
      const symbols = hits.slice(0, limit);
      return {
        status: 'success',
        structured: { engine: 'regex', symbols: symbols as unknown as JsonValue, truncated: hits.length > limit },
        text: symbols.map((s) => `${s.path}:${s.line} ${s.kind} ${s.name}`).join('\n') || 'no symbols found',
      };
    },
  };
}

interface ReferencesInput {
  symbol: string;
  limit?: number;
}

export function codeReferencesTool(options: BuiltinToolOptions): ToolSpec<ReferencesInput> {
  return {
    id: 'code.references',
    title: 'Find references',
    description: 'Find whole-word occurrences of a symbol across TS/JS, Python and Go files (definitions are flagged).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['symbol'],
      properties: { symbol: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z_$#][\\w$.]*$' }, limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 } },
    },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 60_000,
    resources: (_input, ctx) => [rootResource(ctx)],
    async execute(input, ctx) {
      const limit = input.limit ?? 200;
      if (options.retrieval) {
        const rows = await options.retrieval.search({ text: input.symbol, root: ctx.workspace.root, limit });
        const refs = rows.slice(0, limit).map((r) => ({ path: r.path ?? null, line: r.line ?? null, text: r.snippet, score: r.score }));
        return { status: 'success', structured: { engine: 'retrieval', references: refs as unknown as JsonValue }, text: refs.map((r) => `${r.path ?? '?'}:${r.line ?? '?'}: ${r.text}`).join('\n') || 'no references found' };
      }
      const escaped = input.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
      const refs: Array<{ path: string; line: number; text: string; isDefinition: boolean }> = [];
      let truncated = false;
      outer: for (const f of await codeFiles(ctx.workspace.root)) {
        const src = await readFile(join(ctx.workspace.root, f), 'utf8').catch(() => '');
        if (!src.includes(input.symbol)) continue;
        const defs = new Set(extractSymbols(f, src).filter((s) => s.name === input.symbol).map((s) => s.line));
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i]!)) continue;
          if (refs.length >= limit) {
            truncated = true;
            break outer;
          }
          refs.push({ path: f, line: i + 1, text: lines[i]!.trim().slice(0, 300), isDefinition: defs.has(i + 1) });
        }
      }
      return {
        status: 'success',
        structured: { engine: 'regex', references: refs as unknown as JsonValue, truncated },
        text: refs.map((r) => `${r.path}:${r.line}${r.isDefinition ? ' (definition)' : ''}: ${r.text}`).join('\n') || 'no references found',
      };
    },
  };
}
