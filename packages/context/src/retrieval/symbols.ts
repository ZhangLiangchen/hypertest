import { extname, posix } from 'node:path';
import { HypertestError, throwIfAborted } from '@hypertest/core';
import type { ImportEdge, RetrievalHit, RetrievalQuery, Retriever, SymbolDefinition, SymbolIndexOptions, SymbolKind, SymbolLanguage, SymbolReference, SymbolUsage } from '../contracts.ts';
import { cmpStr, resolveLimit } from '../util.ts';
import { compileGlobs, DEFAULT_MAX_FILE_BYTES, kindAllowed, readTextFile, resolveSearchDir, walkFiles } from './files.ts';
import { parseGoFiles, parsePythonFiles, parseTsJs, type ParsedFile, type ParserEngine } from './parsers.ts';

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

/** Extracts definitions from one source text with the regex extractor (the fallback of the syntax-tree parsers). */
export function extractSymbols(text: string, path: string, language: SymbolLanguage): SymbolDefinition[] {
  if (language === 'python') return extractPython(text, path);
  if (language === 'go') return extractGo(text, path);
  return extractTsJs(text, path, language);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------------------------------------------------------ symbol graph (tree-lite)

const JS_IMPORT_FROM = /\bfrom\s*['"]([^'"]+)['"]/;
const JS_IMPORT_BARE = /^\s*import\s*['"]([^'"]+)['"]/;
const JS_IMPORT_CALL = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_IMPORT_LINE = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s*from\b)|\brequire\s*\(\s*['"]|\bimport\s*\(\s*['"]/;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/;
const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\b/;
const GO_IMPORT_ONE = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/;
const GO_IMPORT_ITEM = /^\s*(?:[\w.]+\s+)?"([^"]+)"/;

/** True when the line is an import statement of its language. */
function isImportLine(line: string, language: SymbolLanguage | undefined): boolean {
  if (language === 'python') return PY_IMPORT.test(line) || PY_FROM.test(line);
  if (language === 'go') return /^\s*import\b/.test(line) || /^\s*(?:[\w.]+\s+)?"[^"]+"\s*$/.test(line);
  return JS_IMPORT_LINE.test(line);
}

/** Raw (unresolved) import specifiers of one file. */
export function extractImports(text: string, path: string, language: SymbolLanguage): Array<Omit<ImportEdge, 'to'>> {
  const out: Array<Omit<ImportEdge, 'to'>> = [];
  const lines = text.split('\n');
  const push = (specifier: string, i: number) => out.push({ from: path, specifier, line: i + 1, language });
  let goBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if (language === 'python') {
      if ((m = PY_FROM.exec(line))) push(m[1]!, i);
      else if ((m = PY_IMPORT.exec(line))) for (const mod of m[1]!.split(',')) push(mod.trim(), i);
      continue;
    }
    if (language === 'go') {
      if (goBlock) {
        if (/^\s*\)/.test(line)) goBlock = false;
        else if ((m = GO_IMPORT_ITEM.exec(line))) push(m[1]!, i);
      } else if (/^\s*import\s*\(\s*$/.test(line)) goBlock = true;
      else if ((m = GO_IMPORT_ONE.exec(line))) push(m[1]!, i);
      continue;
    }
    const code = line.replace(/\/\/.*$/, '');
    if ((m = JS_IMPORT_FROM.exec(code)) && /^\s*(?:import|export)\b|^\s*\}/.test(code)) push(m[1]!, i);
    else if ((m = JS_IMPORT_BARE.exec(code))) push(m[1]!, i);
    for (const c of code.matchAll(JS_IMPORT_CALL)) push(c[1]!, i);
  }
  return out;
}

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Resolves an import specifier to a repository file of `files` (relative JS/TS paths, Python modules), else undefined. */
export function resolveImport(edge: Omit<ImportEdge, 'to'>, files: ReadonlySet<string>): string | undefined {
  const dir = posix.dirname(edge.from);
  const first = (candidates: string[]) => candidates.map((c) => posix.normalize(c)).find((c) => !c.startsWith('..') && files.has(c));
  if (edge.language === 'python') {
    const dots = /^\.*/.exec(edge.specifier)![0].length;
    const rest = edge.specifier.slice(dots).replace(/\./g, '/');
    let base = dots > 0 ? dir : '';
    for (let i = 1; i < dots; i++) base = posix.dirname(base);
    const stem = rest ? (base && base !== '.' ? `${base}/${rest}` : rest) : base;
    if (!stem || stem === '.') return undefined;
    return first([`${stem}.py`, `${stem}/__init__.py`]);
  }
  if (edge.language === 'go') {
    // module paths: the longest repository directory the import path ends with
    const hit = [...files].filter((f) => f.endsWith('.go')).map((f) => posix.dirname(f)).filter((d) => d !== '.' && (edge.specifier === d || edge.specifier.endsWith('/' + d)));
    const best = hit.sort((a, b) => b.length - a.length)[0];
    return best === undefined ? undefined : [...files].filter((f) => f.endsWith('.go') && posix.dirname(f) === best).sort()[0];
  }
  if (!edge.specifier.startsWith('.')) return undefined;
  const target = posix.join(dir, edge.specifier);
  const noJs = target.replace(/\.(?:[mc]?js|jsx)$/, '');
  return first([target, ...JS_EXTS.map((e) => noJs + e), ...JS_EXTS.map((e) => `${target}/index${e}`)]);
}

/** Classifies how a reference line uses `name`: import > write (assignment, ++/--, `:=`) > call > read. */
export function classifyUsage(line: string, name: string, language: SymbolLanguage | undefined): SymbolUsage {
  if (isImportLine(line, language)) return 'import';
  const n = escapeRe(name);
  const assign = new RegExp(`(?<![\\w$#])${n}\\s*(?:[-+*/%&|^:]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?![=>])`);
  const incdec = new RegExp(`(?<![\\w$#])${n}\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*(?:[\\w$#]+\\.)*${n}(?![\\w$])`);
  if (assign.test(line) || incdec.test(line)) return 'write';
  if (new RegExp(`(?<![\\w$#])${n}\\s*(?:<[^<>()=]*>\\s*)?\\(`).test(line)) return 'call';
  return 'read';
}

const ENCLOSING_KINDS: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'class', 'struct']);

/**
 * L3 symbol retrieval over TS/JS, Python and Go. (B[6]) Definitions and usages come from real syntax trees — the
 * TypeScript compiler API, python3 `ast`, Go `go/ast` (parsers.ts) — with the regex extractor ("tree-lite") as the per-file
 * fallback when a parser is unavailable or rejects the file (parserEngines() says which engine parsed each file):
 * definitions (functions, classes, interfaces, types, enums / enum-like const objects, top-level consts and variables, class
 * methods and arrow-function properties, Python def/class/async def, Go func/methods/struct/interface) and word-boundary
 * references classified as import / write / call / read from the tree.
 * search(): exact definition 1.0, prefix 0.7, reference 0.3.
 */
export class SymbolIndex implements Retriever {
  readonly name = 'symbol';
  readonly #root: string;
  readonly #languages: ReadonlySet<SymbolLanguage>;
  readonly #maxFileBytes: number;
  readonly #defaultLimit: number;
  readonly #goHelperDir: string | undefined;
  #files = new Map<string, string[]>();
  #defs = new Map<string, SymbolDefinition[]>();
  /** Definitions per file, sorted by line (enclosing-definition lookup). */
  #fileDefs = new Map<string, SymbolDefinition[]>();
  #imports: ImportEdge[] = [];
  /** (B[6]) The syntax-tree parse of each file (definitions + identifier usages) and the engine that produced it. */
  #parsed = new Map<string, ParsedFile>();
  /** (B[6]) Per-file parse cache keyed by path and validated by the file's text: a rebuild re-parses only changed files. */
  #parseCache = new Map<string, { text: string; parsed: ParsedFile; imports: Array<Omit<ImportEdge, 'to'>> }>();
  #built: Promise<{ files: number; symbols: number }> | undefined;
  /** Generation of the latest build() call: an older build that finishes later never overwrites a newer index. */
  #generation = 0;

  constructor(options: SymbolIndexOptions) {
    if (!options || typeof options.root !== 'string' || options.root.length === 0) throw new HypertestError('invalid_argument', 'SymbolIndex needs a root');
    this.#root = options.root;
    this.#languages = new Set(options.languages ?? ['ts', 'js', 'python', 'go']);
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#defaultLimit = resolveLimit(options.defaultLimit, 20, 'defaultLimit');
    this.#goHelperDir = options.goHelperDir;
  }

  /**
   * (Re)builds the index from the files under the root; the latest call wins when builds overlap. Incremental: every file is
   * re-read, but only a file whose text changed since the previous build is parsed again (so callers that need the current
   * state of a workspace — the code tools — simply call build() before a query).
   */
  build(signal?: AbortSignal): Promise<{ files: number; symbols: number }> {
    const generation = ++this.#generation;
    this.#built = (async () => {
      const files = new Map<string, string[]>();
      const defs = new Map<string, SymbolDefinition[]>();
      const fileDefs = new Map<string, SymbolDefinition[]>();
      const parsedFiles = new Map<string, ParsedFile>();
      const rawImports: Array<Omit<ImportEdge, 'to'>> = [];
      const { absRoot } = await resolveSearchDir(this.#root, undefined);
      const byLanguage: Record<'python' | 'go', Array<{ path: string; text: string }>> = { python: [], go: [] };
      const cache = new Map<string, { text: string; parsed: ParsedFile; imports: Array<Omit<ImportEdge, 'to'>> }>();
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
        const cached = this.#parseCache.get(f.relPath);
        if (cached && cached.text === text) {
          cache.set(f.relPath, cached);
          continue;
        }
        const imports = extractImports(text, f.relPath, lang);
        if (lang === 'python' || lang === 'go') {
          byLanguage[lang].push({ path: f.relPath, text });
          cache.set(f.relPath, { text, parsed: regexParsed(text, f.relPath, lang), imports });
        } else {
          cache.set(f.relPath, { text, parsed: parseOrFallback(() => parseTsJs(text!, f.relPath, lang), text, f.relPath, lang), imports });
        }
      }
      // python3 `ast` and Go `go/ast` parse their (changed) files in one batch each; a file they cannot parse keeps the regex
      // fallback set above
      throwIfAborted(signal);
      const [py, go] = await Promise.all([parsePythonFiles(byLanguage.python), parseGoFiles(byLanguage.go, this.#goHelperDir !== undefined ? { helperDir: this.#goHelperDir } : {})]);
      for (const [batch, parsed] of [[byLanguage.python, py], [byLanguage.go, go]] as const) {
        for (const f of batch) {
          const p = parsed?.get(f.path);
          if (p) cache.get(f.path)!.parsed = p;
        }
      }
      for (const [path, c] of cache) {
        parsedFiles.set(path, c.parsed);
        rawImports.push(...c.imports);
      }
      let symbols = 0;
      for (const [path, parsed] of parsedFiles) {
        fileDefs.set(path, [...parsed.definitions].sort((a, b) => a.line - b.line));
        for (const d of parsed.definitions) {
          const list = defs.get(d.name) ?? [];
          list.push(d);
          defs.set(d.name, list);
          symbols++;
        }
      }
      const known = new Set(files.keys());
      const imports: ImportEdge[] = rawImports.map((e) => {
        const to = resolveImport(e, known);
        return to === undefined ? { ...e } : { ...e, to };
      });
      if (generation === this.#generation) {
        this.#files = files;
        this.#defs = defs;
        this.#fileDefs = fileDefs;
        this.#imports = imports;
        this.#parsed = parsedFiles;
        this.#parseCache = cache;
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

  /**
   * Word-boundary occurrences of `name` outside its definition lines, each with its `usage` (import / write / call /
   * read) and `enclosing` definition. `options.usage` (additive) keeps only those usages.
   */
  async findReferences(name: string, limit = 1000, options: { usage?: SymbolUsage[] } = {}): Promise<SymbolReference[]> {
    await this.#ready();
    return this.#references(name, limit, options.usage);
  }

  /**
   * "Who writes X?" — assignments, compound assignments, `:=` and ++/-- of `X`. `Type.member` narrows to writes of
   * `member` inside definitions of `Type` (its methods: `this.member = …`, `self.member = …`) or in files that
   * reference `Type` (e.g. `state.member = …` after importing it). Usages come from the syntax tree of each file (regex
   * classifyUsage only for a file no parser could handle).
   */
  async writers(target: string, limit = 200): Promise<SymbolReference[]> {
    await this.#ready();
    const dot = target.lastIndexOf('.');
    const member = dot >= 0 ? target.slice(dot + 1) : target;
    const qualifier = dot >= 0 ? target.slice(0, dot) : undefined;
    const writes = this.#references(member, Number.MAX_SAFE_INTEGER, ['write']);
    if (!qualifier) return writes.slice(0, limit);
    const owner = qualifier.split('.').at(-1)!;
    const filesUsingOwner = new Set(this.#references(owner, Number.MAX_SAFE_INTEGER).map((r) => r.path));
    for (const d of this.#defs.get(owner) ?? []) filesUsingOwner.add(d.path);
    return writes.filter((r) => r.enclosing?.startsWith(`${owner}.`) || r.enclosing === owner || filesUsingOwner.has(r.path)).slice(0, limit);
  }

  /**
   * (additive, B[6]) Definitions whose name contains `query` (case-insensitive): exact names first, then by path and line —
   * the `code.symbols` question.
   */
  async definitionsMatching(query: string, limit = 50): Promise<SymbolDefinition[]> {
    await this.#ready();
    const q = query.trim().toLowerCase();
    if (q === '') return [];
    const out: SymbolDefinition[] = [];
    for (const [name, list] of this.#defs) if (name.toLowerCase().includes(q)) out.push(...list);
    return out
      .sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q) || cmpStr(a.path, b.path) || a.line - b.line)
      .slice(0, limit);
  }

  /** "Who calls X?" — references that call `name` (the call graph edge is `enclosing` → name). */
  async callers(name: string, limit = 200): Promise<SymbolReference[]> {
    await this.#ready();
    return this.#references(name, limit, ['call']);
  }

  /** Import edges of the index (of one file when `path` is given), sorted by file and line. */
  async imports(path?: string): Promise<ImportEdge[]> {
    await this.#ready();
    return this.#imports.filter((e) => path === undefined || e.from === path).sort((a, b) => cmpStr(a.from, b.from) || a.line - b.line).map((e) => ({ ...e }));
  }

  /** Files importing `path` (reverse import edges). */
  async importers(path: string): Promise<ImportEdge[]> {
    await this.#ready();
    return this.#imports.filter((e) => e.to === path).sort((a, b) => cmpStr(a.from, b.from) || a.line - b.line).map((e) => ({ ...e }));
  }

  /**
   * How a line uses `name`: an import line is `import`; in a file a syntax-tree parser parsed, the strongest usage of that
   * identifier on the line (assignment / ++ / -- target ⇒ write, callee ⇒ call, else read — a name only in a comment or a
   * string is a plain read mention); in a regex-fallback file, classifyUsage of the line.
   */
  #usage(path: string, line: number, text: string, name: string, language: SymbolLanguage | undefined): SymbolUsage {
    if (isImportLine(text, language)) return 'import';
    const parsed = this.#parsed.get(path);
    if (!parsed || parsed.engine === 'regex-fallback') return classifyUsage(text, name, language);
    return parsed.usages.get(line)?.get(name) ?? 'read';
  }

  /** (B[6]) The engine that parsed each indexed file (typescript, python-ast, go-ast, or regex-fallback). */
  async parserEngines(): Promise<Record<string, ParserEngine>> {
    await this.#ready();
    return Object.fromEntries([...this.#parsed].map(([path, p]) => [path, p.engine]).sort((a, b) => cmpStr(a[0] as string, b[0] as string)));
  }

  /**
   * The enclosing definition of a line: (B[6]) from syntax-tree spans, the innermost function / method / class / struct whose
   * span contains the line (its own definition line included); a definition without a span (regex fallback) encloses the
   * lines after it up to the next one.
   */
  #enclosing(path: string, line: number): string | undefined {
    const defs = this.#fileDefs.get(path) ?? [];
    let best: SymbolDefinition | undefined;
    for (const d of defs) {
      if (d.line > line) break;
      if (!ENCLOSING_KINDS.has(d.kind)) continue;
      if (d.endLine !== undefined) {
        // spans nest: a later-starting span that still contains the line is the inner one
        if (d.endLine >= line) best = d;
      } else if (d.line < line) {
        best = d;
      }
    }
    return best ? (best.container ? `${best.container}.${best.name}` : best.name) : undefined;
  }

  #references(name: string, limit: number, usage?: readonly SymbolUsage[]): SymbolReference[] {
    if (!/^[A-Za-z_$#][\w$]*$/.test(name)) return [];
    const re = new RegExp(`(?<![\\w$#])${escapeRe(name)}(?![\\w$])`);
    const defLines = new Set((this.#defs.get(name) ?? []).map((d) => `${d.path}:${d.line}`));
    const out: SymbolReference[] = [];
    const paths = [...this.#files.keys()].sort(cmpStr);
    for (const path of paths) {
      const lines = this.#files.get(path)!;
      const language = languageOf(path);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!) || defLines.has(`${path}:${i + 1}`)) continue;
        const kind = this.#usage(path, i + 1, lines[i]!, name, language);
        if (usage && !usage.includes(kind)) continue;
        const ref: SymbolReference = { name, path, line: i + 1, snippet: lines[i]!.trim().slice(0, 240), usage: kind };
        const enclosing = this.#enclosing(path, i + 1);
        if (enclosing !== undefined) ref.enclosing = enclosing;
        out.push(ref);
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
    // symbol-graph questions ("who writes AccountState.version?", "who calls paginate?") rank the matching edges first
    const intent = /\bwho\s+(writes|assigns|sets|mutates|modifies|updates|calls|invokes|uses)\s+(?:to\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$#][\w$]*)*)/i.exec(query.text ?? '');
    if (intent) {
      const verb = intent[1]!.toLowerCase();
      const writes = /^(writes|assigns|sets|mutates|modifies|updates)$/.test(verb);
      const member = intent[2]!.split('.').at(-1)!;
      // writes: assignments; calls/invokes: call sites; uses: every non-import reference
      const edges = writes ? await this.writers(intent[2]!, limit * 4) : this.#references(member, limit * 4, verb === 'uses' ? ['read', 'call', 'write'] : ['call']);
      const label = writes ? 'writes' : verb === 'uses' ? 'uses' : 'calls';
      for (const r of edges) {
        offer({ source: 'symbol', ref: { kind: 'file', id: r.path, note: `${label} ${intent[2]}${r.enclosing ? ` in ${r.enclosing}` : ''}` }, path: r.path, line: r.line, snippet: r.snippet, score: writes ? 0.9 : 0.8 });
      }
    }
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

/** The regex extractor's result as a ParsedFile (no identifier usages: the line classifier applies). */
function regexParsed(text: string, path: string, language: SymbolLanguage): ParsedFile {
  return { engine: 'regex-fallback', definitions: extractSymbols(text, path, language), usages: new Map() };
}

function parseOrFallback(parse: () => ParsedFile, text: string, path: string, language: SymbolLanguage): ParsedFile {
  try {
    return parse();
  } catch {
    return regexParsed(text, path, language);
  }
}
