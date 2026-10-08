import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HypertestError, type JsonValue } from '@hypertest/core';
import type { BuiltinToolOptions, ToolSpec, WorkspaceHandle } from '../../contracts.ts';
import { assertNotGitMetadata, rootResource } from './common.ts';

/**
 * (wave 3, row 248) LSP-equivalent symbol navigation for TypeScript / JavaScript through the TypeScript language service
 * (the engine behind tsserver and the TypeScript LSP servers): `lsp.definitions` (go to definition), `lsp.references`
 * (find all references) and `lsp.diagnostics` (syntactic + semantic diagnostics). The project is the workspace's
 * tsconfig.json (else every TS/JS file of the workspace, allowJs). The language service only READS files, in this
 * process: every file it may read is confined to the workspace (real path inside its root) or the TypeScript lib
 * directory — a symlink or tsconfig `extends` out of the workspace reads nothing. Results name workspace-relative paths.
 */

type TS = typeof import('typescript');
let tsModule: Promise<TS> | undefined;
/** The TypeScript compiler API, loaded on first use (it is large). */
export function loadTypeScript(): Promise<TS> {
  tsModule ??= import('typescript').then((m) => ((m as { default?: TS }).default ?? (m as unknown as TS)));
  return tsModule;
}

const SOURCE_RE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor']);
const MAX_PROJECT_FILES = 3000;

/** A TypeScript project over one workspace (language service + the confined host). */
export interface TsProject {
  ts: TS;
  service: import('typescript').LanguageService;
  root: string;
  files: string[];
  configFile?: string;
  configErrors: string[];
  rel(fileName: string): string;
  abs(relPath: string): string;
  dispose(): void;
}

function walkSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_PROJECT_FILES) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP.has(n) || n.startsWith('.')) continue;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (SOURCE_RE.test(n) && !n.endsWith('.d.ts') && st.size <= 2 * 1024 * 1024) out.push(p);
      if (out.length >= MAX_PROJECT_FILES) return;
    }
  };
  walk(root);
  return out;
}

/** Opens the TypeScript project of a workspace (tsconfig.json when present). */
export async function openTsProject(ws: WorkspaceHandle): Promise<TsProject> {
  const ts = await loadTypeScript();
  const root = realpathSync(ws.root);
  const libDir = dirname(ts.getDefaultLibFilePath({}));
  const inside = (p: string): boolean => {
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      real = resolve(p);
    }
    return real === root || real.startsWith(root + sep) || real.startsWith(libDir + sep);
  };
  const readConfined = (p: string): string | undefined => {
    if (!inside(p)) return undefined;
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  };
  const fileExists = (p: string): boolean => {
    if (!inside(p)) return false;
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const configErrors: string[] = [];
  let options: import('typescript').CompilerOptions = { allowJs: true, checkJs: false, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, strict: true, noEmit: true, allowImportingTsExtensions: true };
  let files: string[];
  const configPath = join(root, 'tsconfig.json');
  let configFile: string | undefined;
  if (fileExists(configPath)) {
    configFile = 'tsconfig.json';
    const read = ts.readConfigFile(configPath, (p) => readConfined(p));
    if (read.error) configErrors.push(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    const host: import('typescript').ParseConfigHost = {
      useCaseSensitiveFileNames: true,
      readDirectory: (dir, ext, exclude, include, depth) => (inside(dir) ? ts.sys.readDirectory(dir, ext, exclude, include, depth).filter((f) => inside(f)) : []),
      fileExists,
      readFile: readConfined,
    };
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, host, root, undefined, configPath);
    for (const e of parsed.errors) if (e.code !== 18003) configErrors.push(ts.flattenDiagnosticMessageText(e.messageText, '\n'));
    options = { ...parsed.options, noEmit: true };
    files = parsed.fileNames.filter((f) => inside(f)).slice(0, MAX_PROJECT_FILES);
  } else {
    files = walkSources(root);
  }
  const versions = new Map<string, number>();
  const host: import('typescript').LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => files,
    getScriptVersion: (f) => String(versions.get(f) ?? 0),
    getScriptSnapshot: (f) => {
      const text = readConfined(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists,
    readFile: readConfined,
    readDirectory: (dir, ext, exclude, include, depth) => (inside(dir) ? ts.sys.readDirectory(dir, ext, exclude, include, depth).filter((f) => inside(f)) : []),
    directoryExists: (d) => {
      if (!inside(d)) return false;
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    },
    getDirectories: (d) => (inside(d) ? ts.sys.getDirectories(d) : []),
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
    useCaseSensitiveFileNames: () => true,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return {
    ts,
    service,
    root,
    files,
    ...(configFile !== undefined ? { configFile } : {}),
    configErrors,
    rel: (f) => {
      const r = relative(root, f);
      if (r.startsWith('..') || isAbsolute(r)) return f.startsWith(libDir) ? `<typescript>/${relative(libDir, f)}` : `<external>/${f.split(/[\\/]/).slice(-2).join('/')}`;
      return r.split(sep).join('/');
    },
    abs: (p) => resolve(root, p),
    dispose: () => service.dispose(),
  };
}

function confinedSource(project: TsProject, path: string): string {
  assertNotGitMetadata(path, 'lsp');
  const abs = project.abs(path);
  const rel = relative(project.root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new HypertestError('permission_denied', `${path} is outside the workspace`);
  if (!SOURCE_RE.test(abs)) throw new HypertestError('invalid_argument', `${path} is not a TypeScript/JavaScript source file`);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new HypertestError('not_found', `no file ${path} in the workspace`);
  }
  if (real !== project.root && !real.startsWith(project.root + sep)) throw new HypertestError('permission_denied', `${path} resolves outside the workspace`);
  if (!project.files.includes(abs) && !project.files.includes(real)) project.files.push(abs);
  return abs;
}

/** The offset of a 1-based line/column, or of the first whole-word occurrence of `symbol` (at/after `line`). */
function positionOf(text: string, input: { line?: number; column?: number; symbol?: string }): number {
  const lines = text.split('\n');
  if (input.symbol !== undefined) {
    const re = new RegExp(`(?<![\\w$])${input.symbol.replace(/[$]/g, '\\$')}(?![\\w$])`);
    for (let i = Math.max(0, (input.line ?? 1) - 1); i < lines.length; i++) {
      const m = re.exec(lines[i]!);
      if (m) return lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0) + m.index;
    }
    throw new HypertestError('not_found', `symbol ${input.symbol} does not occur in the file${input.line ? ` at or after line ${input.line}` : ''}`);
  }
  if (input.line === undefined || input.column === undefined) throw new HypertestError('invalid_argument', 'give line and column, or symbol');
  if (input.line > lines.length || input.column > (lines[input.line - 1]?.length ?? 0) + 1) throw new HypertestError('invalid_argument', `position ${input.line}:${input.column} is outside the file`);
  return lines.slice(0, input.line - 1).reduce((n, l) => n + l.length + 1, 0) + input.column - 1;
}

function location(project: TsProject, fileName: string, start: number): { path: string; line: number; column: number; snippet: string } {
  const sf = project.service.getProgram()?.getSourceFile(fileName);
  const text = sf?.text ?? (() => {
    try {
      return readFileSync(fileName, 'utf8');
    } catch {
      return '';
    }
  })();
  const before = text.slice(0, start);
  const line = before.split('\n').length;
  const column = start - before.lastIndexOf('\n');
  return { path: project.rel(fileName), line, column, snippet: (text.split('\n')[line - 1] ?? '').trim().slice(0, 240) };
}

interface PositionInput {
  path: string;
  line?: number;
  column?: number;
  symbol?: string;
  limit?: number;
}

const POSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Workspace-relative TS/JS file.' },
    line: { type: 'integer', minimum: 1, description: '1-based line of the position (with column), or where to start looking for symbol.' },
    column: { type: 'integer', minimum: 1, description: '1-based column of the position.' },
    symbol: { type: 'string', pattern: '^[A-Za-z_$][\\w$]*$', maxLength: 256, description: 'An identifier: its first occurrence in the file (at/after line) is the position.' },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  },
} as const;

export function lspDefinitionsTool(_options: BuiltinToolOptions): ToolSpec<PositionInput> {
  return {
    id: 'lsp.definitions',
    title: 'Go to definition',
    description: 'TypeScript/JavaScript go-to-definition through the TypeScript language service (type-aware, follows imports): the declarations of the symbol at path + line/column (or the first occurrence of `symbol`).',
    inputSchema: POSITION_SCHEMA,
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 120_000,
    resources: (_input, ctx) => [rootResource(ctx)],
    async execute(input, ctx) {
      const project = await openTsProject(ctx.workspace);
      try {
        const file = confinedSource(project, input.path);
        const pos = positionOf(readFileSync(file, 'utf8'), input);
        const defs = project.service.getDefinitionAtPosition(file, pos) ?? [];
        const out = defs.slice(0, input.limit ?? 50).map((d) => ({ ...location(project, d.fileName, d.textSpan.start), kind: d.kind, name: d.name, containerName: d.containerName || null }));
        return {
          status: 'success',
          structured: { engine: 'typescript-language-service', definitions: out as unknown as JsonValue },
          text: out.map((d) => `${d.path}:${d.line}:${d.column} ${d.kind} ${d.name}${d.containerName ? ` (in ${d.containerName})` : ''}\n  ${d.snippet}`).join('\n') || 'no definition found',
        };
      } finally {
        project.dispose();
      }
    },
  };
}

export function lspReferencesTool(_options: BuiltinToolOptions): ToolSpec<PositionInput> {
  return {
    id: 'lsp.references',
    title: 'Find references',
    description: 'TypeScript/JavaScript find-all-references through the TypeScript language service: every reference to the symbol at path + line/column (or the first occurrence of `symbol`) across the project, marking definitions and writes.',
    inputSchema: POSITION_SCHEMA,
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 120_000,
    resources: (_input, ctx) => [rootResource(ctx)],
    async execute(input, ctx) {
      const project = await openTsProject(ctx.workspace);
      try {
        const file = confinedSource(project, input.path);
        const pos = positionOf(readFileSync(file, 'utf8'), input);
        const groups = project.service.findReferences(file, pos) ?? [];
        const refs = groups.flatMap((g) => g.references.map((r) => ({ ...location(project, r.fileName, r.textSpan.start), isDefinition: r.isDefinition === true, isWriteAccess: r.isWriteAccess === true })));
        const limit = input.limit ?? 200;
        return {
          status: 'success',
          structured: { engine: 'typescript-language-service', symbol: groups[0]?.definition.name ?? null, references: refs.slice(0, limit) as unknown as JsonValue, total: refs.length, truncated: refs.length > limit },
          text: refs.slice(0, limit).map((r) => `${r.path}:${r.line}:${r.column}${r.isDefinition ? ' [definition]' : r.isWriteAccess ? ' [write]' : ''} ${r.snippet}`).join('\n') || 'no references found',
        };
      } finally {
        project.dispose();
      }
    },
  };
}

export interface TsDiagnostic {
  path: string;
  line: number;
  column: number;
  category: 'error' | 'warning' | 'suggestion' | 'message';
  code: string;
  message: string;
}

/** Syntactic + semantic diagnostics of the project (or of `paths`). */
export function projectDiagnostics(project: TsProject, paths?: string[]): TsDiagnostic[] {
  const { ts } = project;
  const targets = paths && paths.length > 0 ? paths.map((p) => confinedSource(project, p)) : project.files;
  const out: TsDiagnostic[] = [];
  for (const e of project.configErrors) out.push({ path: project.configFile ?? 'tsconfig.json', line: 1, column: 1, category: 'error', code: 'TSCONFIG', message: e });
  for (const f of targets) {
    for (const d of [...project.service.getSyntacticDiagnostics(f), ...project.service.getSemanticDiagnostics(f)]) {
      const loc = d.file && d.start !== undefined ? location(project, d.file.fileName, d.start) : { path: project.rel(f), line: 1, column: 1 };
      const category = d.category === ts.DiagnosticCategory.Error ? 'error' : d.category === ts.DiagnosticCategory.Warning ? 'warning' : d.category === ts.DiagnosticCategory.Suggestion ? 'suggestion' : 'message';
      out.push({ path: loc.path, line: loc.line, column: loc.column, category, code: `TS${d.code}`, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') });
    }
  }
  return out;
}

export function lspDiagnosticsTool(_options: BuiltinToolOptions): ToolSpec<{ paths?: string[]; limit?: number }> {
  return {
    id: 'lsp.diagnostics',
    title: 'Type-check diagnostics',
    description: 'TypeScript/JavaScript diagnostics (syntax and type errors) of the workspace project (tsconfig.json) or of the given files, through the TypeScript language service.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { paths: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4096 }, maxItems: 200 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } },
    },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 300_000,
    resources: (_input, ctx) => [rootResource(ctx)],
    async execute(input, ctx) {
      const project = await openTsProject(ctx.workspace);
      try {
        const all = projectDiagnostics(project, input.paths);
        const limit = input.limit ?? 200;
        const errors = all.filter((d) => d.category === 'error').length;
        return {
          status: 'success',
          structured: { engine: 'typescript-language-service', files: input.paths?.length ?? project.files.length, errors, total: all.length, diagnostics: all.slice(0, limit) as unknown as JsonValue, truncated: all.length > limit },
          text: `${errors} error(s), ${all.length} diagnostic(s) in ${input.paths?.length ?? project.files.length} file(s)\n${all.slice(0, limit).map((d) => `${d.path}:${d.line}:${d.column} ${d.category} ${d.code}: ${d.message.split('\n')[0]}`).join('\n')}`,
        };
      } finally {
        project.dispose();
      }
    },
  };
}
