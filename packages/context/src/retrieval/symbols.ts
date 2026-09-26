import { extname } from 'node:path';
import { HypertestError, throwIfAborted } from '@hypertest/core';
import type { RetrievalHit, RetrievalQuery, Retriever, SymbolDefinition, SymbolIndexOptions, SymbolKind, SymbolLanguage, SymbolReference } from '../contracts.ts';
import { cmpStr, resolveLimit } from '../util.ts';
import { compileGlobs, DEFAULT_MAX_FILE_BYTES, kindAllowed, readTextFile, resolveSearchDir, walkFiles } from './files.ts';

const LANG_BY_EXT: Record<string, SymbolLanguage> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go',
};

export function languageOf(path: string): SymbolLanguage | undefined {
  return LANG_BY_EXT[extname(path).toLowerCase()];
}

const JS_ID = '[A-Za-z_$][\\w$]*';
const NOT_METHODS: ReadonlySet<string> = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'super', 'constructor', 'typeof', 'await', 'yield', 'do', 'else', 'try', 'with', 'import', 'export']);

const TS_CLASS = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${JS_ID})`);
const TS_FUNCTION = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${JS_ID})`);
const TS_INTERFACE = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?interface\\s+(${JS_ID})`);
const TS_TYPE = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?type\\s+(${JS_ID})\\s*(?:<|=)`);
const TS_ENUM = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${JS_ID})`);
const TS_VAR = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${JS_ID})\\s*(?::[^=]+)?=\\s*(.*)$`);
const TS_ARROW_RHS = new RegExp(`^(?:async\\s+)?(?:function\\b|(?:<[^>]*>\\s*)?\\([^)]*\\)\\s*(?::[^=]+?)?\\s*=>|${JS_ID}\\s*=>|\\(\\s*$|\\([^)]*$)`);
const TS_OBJECT_RHS = /^(?:\{|Object\.freeze\(\s*\{)/;
const MODIFIERS = '(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set)\\s+)*';
const TS_METHOD = new RegExp(`^${MODIFIERS}\\*?\\s*(#?${JS_ID})\\s*(?:<[^>(]*>)?\\s*\\(`);
const TS_PROPERTY_ARROW = new RegExp(`^${MODIFIERS}(#?${JS_ID})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)|${JS_ID})\\s*(?::[^=]+?)?\\s*=>`);

/** Removes string literals and comments so braces/keywords inside them are not counted. */
function stripJsLine(line: string, state: { inBlock: boolean }): string {
  let s = line;
  if (state.inBlock) {
    const end = s.indexOf('*/');
    if (end < 0) return '';
    s = s.slice(end + 2);
    state.inBlock = false;
  }
  s = s.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
  s = s.replace(/\/\*.*?\*\//g, ' ');
  const open = s.indexOf('/*');
  if (open >= 0) {
    s = s.slice(0, open);
    state.inBlock = true;
  }
  const comment = s.indexOf('//');
  if (comment >= 0) s = s.slice(0, comment);
  return s;
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

export function extractTsJs(text: string, path: string, language: SymbolLanguage): SymbolDefinition[] {
  const out: SymbolDefinition[] = [];
  const lines = text.split('\n');
  const state = { inBlock: false };
  // bodyDepth: brace depth inside the class body; opened: its '{' has been seen (headers may span lines).
  const classes: Array<{ name: string; bodyDepth: number; opened: boolean }> = [];
  let depth = 0;
  const add = (name: string, kind: SymbolKind, i: number, container?: string) => {
    const d: SymbolDefinition = { name, kind, language, path, line: i + 1, signature: lines[i]!.trim().slice(0, 200) };
    if (container !== undefined) d.container = container;
    out.push(d);
  };
  for (let i = 0; i < lines.length; i++) {
    const code = stripJsLine(lines[i]!, state);
    const t = code.trim();
    const cls = classes.at(-1);
    const inClassBody = cls !== undefined && cls.opened && depth === cls.bodyDepth;
    let m: RegExpExecArray | null;
    if (t) {
      if ((m = TS_CLASS.exec(t))) {
        add(m[1]!, 'class', i);
        classes.push({ name: m[1]!, bodyDepth: depth + 1, opened: false });
      } else if ((m = TS_FUNCTION.exec(t))) add(m[1]!, 'function', i);
      else if ((m = TS_INTERFACE.exec(t))) add(m[1]!, 'interface', i);
      else if ((m = TS_TYPE.exec(t))) add(m[1]!, 'type', i);
      else if ((m = TS_ENUM.exec(t))) add(m[1]!, 'enum', i);
      else if (inClassBody && (m = TS_PROPERTY_ARROW.exec(t))) add(m[1]!, 'method', i, cls.name);
      else if (inClassBody && (m = TS_METHOD.exec(t)) && !NOT_METHODS.has(m[1]!)) add(m[1]!, 'method', i, cls.name);
      else if (depth === 0 && (m = TS_VAR.exec(t))) {
        const rhs = m[2]!.trim();
        add(m[1]!, TS_ARROW_RHS.test(rhs) ? 'function' : TS_OBJECT_RHS.test(rhs) ? 'const_object' : 'variable', i);
      }
    }
    const opens = count(code, '{');
    depth = Math.max(0, depth + opens - count(code, '}'));
    const top = classes.at(-1);
    if (top && !top.opened && opens > 0) {
      if (depth >= top.bodyDepth) top.opened = true;
      else classes.pop(); // one-line class `class X {}`
    }
    while (classes.length > 0 && classes.at(-1)!.opened && depth < classes.at(-1)!.bodyDepth) classes.pop();
  }
  return out;
}

export function extractPython(text: string, path: string): SymbolDefinition[] {
  const out: SymbolDefinition[] = [];
  const lines = text.split('\n');
  const stack: Array<{ kind: 'class' | 'def'; name: string; indent: number }> = [];
  let inString: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inString) {
      if (line.includes(inString)) inString = undefined;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
    let m: RegExpExecArray | null;
    if ((m = /^class\s+([A-Za-z_]\w*)/.exec(trimmed))) {
      out.push({ name: m[1]!, kind: 'class', language: 'python', path, line: i + 1, signature: trimmed.slice(0, 200) });
      stack.push({ kind: 'class', name: m[1]!, indent });
    } else if ((m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(trimmed))) {
      const parent = stack.at(-1);
      const d: SymbolDefinition = { name: m[1]!, kind: parent?.kind === 'class' ? 'method' : 'function', language: 'python', path, line: i + 1, signature: trimmed.slice(0, 200) };
      if (parent?.kind === 'class') d.container = parent.name;
      out.push(d);
      stack.push({ kind: 'def', name: m[1]!, indent });
    }
    // Skip the body of a multi-line (doc)string opened on this line.
    for (const q of ['"""', "'''"]) {
      const n = trimmed.split(q).length - 1;
      if (n % 2 === 1) inString = q;
    }
  }
  return out;
}

export function extractGo(text: string, path: string): SymbolDefinition[] {
  const out: SymbolDefinition[] = [];
  const lines = text.split('\n');
  let inTypeBlock = false;
  const add = (name: string, kind: SymbolKind, i: number, container?: string) => {
    const d: SymbolDefinition = { name, kind, language: 'go', path, line: i + 1, signature: lines[i]!.trim().slice(0, 200) };
    if (container !== undefined) d.container = container;
    out.push(d);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\/\/.*$/, '');
    let m: RegExpExecArray | null;
    if (inTypeBlock) {
      if (/^\)/.test(line)) inTypeBlock = false;
      else if ((m = /^\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b/.exec(line))) add(m[1]!, m[2] === 'struct' ? 'struct' : 'interface', i);
      else if ((m = /^\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(?:=\s*)?\S/.exec(line))) add(m[1]!, 'type', i);
      continue;
    }
    if ((m = /^func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)\s*[[(]/.exec(line))) add(m[2]!, 'method', i, m[1]!);
    else if ((m = /^func\s+([A-Za-z_]\w*)\s*[[(]/.exec(line))) add(m[1]!, 'function', i);
    else if (/^type\s*\(\s*$/.test(line)) inTypeBlock = true;
    else if ((m = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b/.exec(line))) add(m[1]!, m[2] === 'struct' ? 'struct' : 'interface', i);
    else if ((m = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(?:=\s*)?\S/.exec(line))) add(m[1]!, 'type', i);
    else if ((m = /^(?:var|const)\s+([A-Za-z_]\w*)\b/.exec(line))) add(m[1]!, 'variable', i);
  }
  return out;
}

/** Extracts definitions from one source text. */
export function extractSymbols(text: string, path: string, language: SymbolLanguage): SymbolDefinition[] {
  if (language === 'python') return extractPython(text, path);
  if (language === 'go') return extractGo(text, path);
  return extractTsJs(text, path, language);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * L3 symbol retrieval over TS/JS, Python and Go with regex extraction ("tree-lite"): definitions (functions,
 * classes, interfaces, types, enums / enum-like const objects, exported consts, class methods, arrow functions,
 * Python def/class/async def, Go func/methods/struct/interface) and word-boundary references.
 * search(): exact definition 1.0, prefix 0.7, reference 0.3.
 */
export class SymbolIndex implements Retriever {
  readonly name = 'symbol';
  readonly #root: string;
  readonly #languages: ReadonlySet<SymbolLanguage>;
  readonly #maxFileBytes: number;
  readonly #defaultLimit: number;
  #files = new Map<string, string[]>();
  #defs = new Map<string, SymbolDefinition[]>();
  #built: Promise<{ files: number; symbols: number }> | undefined;
  /** Generation of the latest build() call: an older build that finishes later never overwrites a newer index. */
  #generation = 0;

  constructor(options: SymbolIndexOptions) {
    if (!options || typeof options.root !== 'string' || options.root.length === 0) throw new HypertestError('invalid_argument', 'SymbolIndex needs a root');
    this.#root = options.root;
    this.#languages = new Set(options.languages ?? ['ts', 'js', 'python', 'go']);
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#defaultLimit = resolveLimit(options.defaultLimit, 20, 'defaultLimit');
  }

  /** (Re)builds the index from the files under the root; the latest call wins when builds overlap. */
  build(signal?: AbortSignal): Promise<{ files: number; symbols: number }> {
    const generation = ++this.#generation;
    this.#built = (async () => {
      const files = new Map<string, string[]>();
      const defs = new Map<string, SymbolDefinition[]>();
      const { absRoot } = await resolveSearchDir(this.#root, undefined);
      let symbols = 0;
      for await (const f of walkFiles(absRoot, absRoot, { maxFileBytes: this.#maxFileBytes, ...(signal ? { signal } : {}) })) {
        const lang = languageOf(f.relPath);
        if (!lang || !this.#languages.has(lang)) continue;
        let text: string | undefined;
        try {
          text = await readTextFile(f.absPath);
        } catch {
          continue;
        }
        if (text === undefined) continue;
        files.set(f.relPath, text.split('\n'));
        for (const d of extractSymbols(text, f.relPath, lang)) {
          const list = defs.get(d.name) ?? [];
          list.push(d);
          defs.set(d.name, list);
          symbols++;
        }
      }
      if (generation === this.#generation) {
        this.#files = files;
        this.#defs = defs;
      }
      return { files: files.size, symbols };
    })();
    const current = this.#built;
    current.catch(() => {
      if (this.#built === current) this.#built = undefined;
    });
    return current;
  }

  async #ready(signal?: AbortSignal): Promise<void> {
    await (this.#built ?? this.build(signal));
  }

  /** Definitions named exactly `name`. */
  async findDefinitions(name: string): Promise<SymbolDefinition[]> {
    await this.#ready();
    return [...(this.#defs.get(name) ?? [])].sort((a, b) => cmpStr(a.path, b.path) || a.line - b.line);
  }

  /** Word-boundary occurrences of `name` outside its definition lines. */
  async findReferences(name: string, limit = 1000): Promise<SymbolReference[]> {
    await this.#ready();
    return this.#references(name, limit);
  }

  #references(name: string, limit: number): SymbolReference[] {
    if (!/^[A-Za-z_$#][\w$]*$/.test(name)) return [];
    const re = new RegExp(`(?<![\\w$#])${escapeRe(name)}(?![\\w$])`);
    const defLines = new Set((this.#defs.get(name) ?? []).map((d) => `${d.path}:${d.line}`));
    const out: SymbolReference[] = [];
    const paths = [...this.#files.keys()].sort(cmpStr);
    for (const path of paths) {
      const lines = this.#files.get(path)!;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!) || defLines.has(`${path}:${i + 1}`)) continue;
        out.push({ name, path, line: i + 1, snippet: lines[i]!.trim().slice(0, 240) });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async search(query: RetrievalQuery, signal?: AbortSignal): Promise<RetrievalHit[]> {
    throwIfAborted(signal);
    await this.#ready(signal);
    const names = query.symbol ? [query.symbol.trim()] : [...new Set((query.text ?? '').match(/[A-Za-z_$][\w$]*/g) ?? [])].slice(0, 5);
    if (names.length === 0 || names.every((n) => !n)) return [];
    const limit = resolveLimit(query.limit, this.#defaultLimit, 'query.limit');
    const globFilter = compileGlobs(query.pathGlobs);
    const { relDir } = await resolveSearchDir(this.#root, query.root);
    const inScope = (p: string) => (!relDir || p === relDir || p.startsWith(relDir + '/')) && (!globFilter || globFilter(p)) && kindAllowed(p, query.kinds);

    const best = new Map<string, RetrievalHit>();
    const offer = (hit: RetrievalHit) => {
      if (!inScope(hit.path!)) return;
      const key = `${hit.path}:${hit.line}`;
      const prev = best.get(key);
      if (!prev || hit.score > prev.score) best.set(key, hit);
    };
    const defHit = (d: SymbolDefinition, score: number): RetrievalHit => ({
      source: 'symbol',
      ref: { kind: 'file', id: d.path, note: `${d.kind} ${d.container ? d.container + '.' : ''}${d.name}` },
      path: d.path,
      line: d.line,
      snippet: d.signature,
      score,
    });
    for (const name of names) {
      if (!name) continue;
      for (const d of this.#defs.get(name) ?? []) offer(defHit(d, 1.0));
      const lower = name.toLowerCase();
      for (const [n, list] of this.#defs) {
        if (n !== name && n.toLowerCase().startsWith(lower)) for (const d of list) offer(defHit(d, 0.7));
      }
      for (const r of this.#references(name, limit * 4)) {
        offer({ source: 'symbol', ref: { kind: 'file', id: r.path, note: `reference ${name}` }, path: r.path, line: r.line, snippet: r.snippet, score: 0.3 });
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score || cmpStr(a.path!, b.path!) || a.line! - b.line!).slice(0, limit);
  }
}
