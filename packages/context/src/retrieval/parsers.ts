import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import ts from 'typescript';
import type { SymbolDefinition, SymbolKind, SymbolLanguage, SymbolUsage } from '../contracts.ts';

/**
 * (B[6]) Syntax-tree symbol extraction for the L3 symbol graph — replacing the regular expressions:
 *  - TypeScript / JavaScript: the TypeScript compiler API (`typescript`, in process);
 *  - Python: the standard `ast` module of python3 (one subprocess per index build, all files batched);
 *  - Go: `go/ast` + `go/parser` through a small helper program compiled once per helper directory (cached by source hash) —
 *    a PRIVATE directory agent commands cannot reach (see goAstHelper); without one, Go files use the regex fallback.
 * Each parser returns the file's definitions and its identifier usages (import / write / call / read per name and line).
 * A file a parser cannot handle (python3 or go missing, a syntax error) falls back to the regex extractor — the index
 * records which engine parsed each file (`ParsedFile.engine`).
 */
export type ParserEngine = 'typescript' | 'python-ast' | 'go-ast' | 'regex-fallback';

export interface ParsedFile {
  engine: ParserEngine;
  definitions: SymbolDefinition[];
  /** line (1-based) → name → strongest usage of that identifier on that line (import > write > call > read). */
  usages: Map<number, Map<string, SymbolUsage>>;
}

const USAGE_RANK: Record<SymbolUsage, number> = { import: 4, write: 3, call: 2, read: 1 };

function noteUsage(usages: Map<number, Map<string, SymbolUsage>>, line: number, name: string, usage: SymbolUsage): void {
  let byName = usages.get(line);
  if (!byName) usages.set(line, (byName = new Map()));
  const prev = byName.get(name);
  if (!prev || USAGE_RANK[usage] > USAGE_RANK[prev]) byName.set(name, usage);
}

// ------------------------------------------------------------------------------------------------ TypeScript / JavaScript

function tsScriptKind(path: string, language: SymbolLanguage): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  return language === 'js' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function isFunctionLike(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  let x: ts.Expression = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  return ts.isArrowFunction(x) || ts.isFunctionExpression(x);
}

function isObjectLike(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  let x: ts.Expression = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  if (ts.isObjectLiteralExpression(x)) return true;
  // Object.freeze({ … })
  return ts.isCallExpression(x) && x.arguments.length > 0 && ts.isObjectLiteralExpression(x.arguments[0]!) && /^Object\.freeze$/.test(x.expression.getText());
}

/** Whether `node` (an identifier) is the target of an assignment, compound assignment or ++/--. */
function isWriteTarget(node: ts.Node): boolean {
  let target: ts.Node = node;
  // `a.b.c = …` writes c (the member); `this.x = …` writes x
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) target = node.parent;
  const p = target.parent;
  if (!p) return false;
  if (ts.isBinaryExpression(p) && p.left === target) {
    const k = p.operatorToken.kind;
    return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
  }
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  // a class field initializer `version = 0` and an initialized variable `const v = …` declare-and-write their name
  if ((ts.isPropertyDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === node && p.initializer !== undefined) return true;
  return false;
}

function isCallee(node: ts.Node): boolean {
  let target: ts.Node = node;
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) target = node.parent;
  const p = target.parent;
  return !!p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === target;
}

function inImport(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) return true;
    if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined) return true;
  }
  return false;
}

/** Definitions + identifier usages of one TS/JS source text (TypeScript compiler API). */
export function parseTsJs(text: string, path: string, language: SymbolLanguage): ParsedFile {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, tsScriptKind(path, language));
  const lines = text.split('\n');
  const definitions: SymbolDefinition[] = [];
  const usages = new Map<number, Map<string, SymbolUsage>>();
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (name: string, kind: SymbolKind, node: ts.Node, container?: string) => {
    const line = lineOf(node);
    const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const d: SymbolDefinition = { name, kind, language, path, line, signature: (lines[line - 1] ?? '').trim().slice(0, 200), endLine };
    if (container !== undefined) d.container = container;
    definitions.push(d);
  };
  const declarationNames = new Set<ts.Node>();
  const visit = (node: ts.Node, cls: string | undefined) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = node.name?.text;
      if (name && ts.isClassDeclaration(node)) {
        add(name, 'class', node);
        declarationNames.add(node.name!);
      }
      ts.forEachChild(node, (c) => visit(c, name ?? cls));
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, 'function', node);
      declarationNames.add(node.name);
    } else if (ts.isInterfaceDeclaration(node)) {
      add(node.name.text, 'interface', node);
      declarationNames.add(node.name);
    } else if (ts.isTypeAliasDeclaration(node)) {
      add(node.name.text, 'type', node);
      declarationNames.add(node.name);
    } else if (ts.isEnumDeclaration(node)) {
      add(node.name.text, 'enum', node);
      declarationNames.add(node.name);
    } else if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && cls !== undefined && ts.isClassLike(node.parent)) {
      const name = node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) ? node.name.text : undefined;
      if (name) {
        add(name, 'method', node, cls);
        declarationNames.add(node.name);
      }
    } else if (ts.isPropertyDeclaration(node) && cls !== undefined && isFunctionLike(node.initializer)) {
      const name = ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name) ? node.name.text : undefined;
      if (name) {
        add(name, 'method', node, cls);
        declarationNames.add(node.name);
      }
    } else if (ts.isVariableStatement(node) && node.parent === sf) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        add(decl.name.text, isFunctionLike(decl.initializer) ? 'function' : isObjectLike(decl.initializer) ? 'const_object' : 'variable', node);
        declarationNames.add(decl.name);
      }
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (!declarationNames.has(node) || isWriteTarget(node)) {
        const name = node.text;
        const usage: SymbolUsage = inImport(node) ? 'import' : isWriteTarget(node) ? 'write' : isCallee(node) ? 'call' : 'read';
        noteUsage(usages, lineOf(node), name, usage);
      }
    }
    ts.forEachChild(node, (c) => visit(c, cls));
  };
  visit(sf, undefined);
  return { engine: 'typescript', definitions, usages };
}

// ------------------------------------------------------------------------------------------------ subprocess helper

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

function run(command: string, args: string[], input: string, options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on('error', (e) => done({ code: null, stdout, stderr, spawnError: e.message }));
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

interface WireParsed {
  path: string;
  error?: string;
  definitions?: Array<{ name: string; kind: SymbolKind; line: number; end?: number; container?: string }>;
  usages?: Array<[number, string, SymbolUsage]>;
}

function fromWire(w: WireParsed, language: SymbolLanguage, engine: ParserEngine, text: string): ParsedFile {
  const lines = text.split('\n');
  const definitions: SymbolDefinition[] = (w.definitions ?? []).map((d) => {
    const def: SymbolDefinition = { name: d.name, kind: d.kind, language, path: w.path, line: d.line, signature: (lines[d.line - 1] ?? '').trim().slice(0, 200) };
    if (d.container) def.container = d.container;
    if (typeof d.end === 'number' && d.end >= d.line) def.endLine = d.end;
    return def;
  });
  const usages = new Map<number, Map<string, SymbolUsage>>();
  for (const [line, name, usage] of w.usages ?? []) noteUsage(usages, line, name, usage);
  return { engine, definitions, usages };
}

// ------------------------------------------------------------------------------------------------ Python (ast)

/** python3 program: reads [{path, text}] as JSON on stdin, writes [{path, definitions, usages} | {path, error}]. */
export const PYTHON_AST_PROGRAM = String.raw`
import ast, json, sys

def parse(path, text):
    tree = ast.parse(text, filename=path)
    defs = []
    uses = []
    def use(line, name, usage):
        uses.append([line, name, usage])
    class V(ast.NodeVisitor):
        def __init__(self):
            self.stack = []
        def visit_ClassDef(self, node):
            defs.append({"name": node.name, "kind": "class", "line": node.lineno, "end": node.end_lineno})
            self.stack.append(("class", node.name))
            self.generic_visit(node)
            self.stack.pop()
        def _func(self, node):
            parent = self.stack[-1] if self.stack else None
            d = {"name": node.name, "kind": "method" if parent and parent[0] == "class" else "function", "line": node.lineno, "end": node.end_lineno}
            if parent and parent[0] == "class":
                d["container"] = parent[1]
            defs.append(d)
            self.stack.append(("def", node.name))
            self.generic_visit(node)
            self.stack.pop()
        visit_FunctionDef = _func
        visit_AsyncFunctionDef = _func
        def visit_Import(self, node):
            for a in node.names:
                use(node.lineno, (a.asname or a.name).split(".")[0], "import")
        def visit_ImportFrom(self, node):
            for a in node.names:
                use(node.lineno, a.asname or a.name, "import")
        def visit_Name(self, node):
            use(node.lineno, node.id, "write" if isinstance(node.ctx, (ast.Store, ast.Del)) else "read")
        def visit_Attribute(self, node):
            use(node.lineno, node.attr, "write" if isinstance(node.ctx, (ast.Store, ast.Del)) else "read")
            self.generic_visit(node)
        def visit_AugAssign(self, node):
            t = node.target
            if isinstance(t, ast.Name):
                use(t.lineno, t.id, "write")
            elif isinstance(t, ast.Attribute):
                use(t.lineno, t.attr, "write")
            self.generic_visit(node)
        def visit_Call(self, node):
            f = node.func
            if isinstance(f, ast.Name):
                use(f.lineno, f.id, "call")
            elif isinstance(f, ast.Attribute):
                use(f.lineno, f.attr, "call")
            self.generic_visit(node)
    V().visit(tree)
    return {"path": path, "definitions": defs, "usages": uses}

out = []
for f in json.load(sys.stdin):
    try:
        out.append(parse(f["path"], f["text"]))
    except Exception as e:
        out.append({"path": f["path"], "error": type(e).__name__ + ": " + str(e)})
json.dump(out, sys.stdout)
`;

/**
 * Parses Python files with python3's `ast` (one subprocess for the batch). Returns undefined when python3 cannot run (the
 * caller falls back to the regex extractor); per-file syntax errors come back as undefined entries.
 */
export async function parsePythonFiles(files: Array<{ path: string; text: string }>, options: { timeoutMs?: number } = {}): Promise<Map<string, ParsedFile> | undefined> {
  if (files.length === 0) return new Map();
  const r = await run('python3', ['-I', '-c', PYTHON_AST_PROGRAM], JSON.stringify(files), { timeoutMs: options.timeoutMs ?? 120_000, env: helperEnv() });
  if (r.spawnError || r.code !== 0) return undefined;
  let parsed: WireParsed[];
  try {
    parsed = JSON.parse(r.stdout) as WireParsed[];
  } catch {
    return undefined;
  }
  const texts = new Map(files.map((f) => [f.path, f.text]));
  const out = new Map<string, ParsedFile>();
  for (const w of parsed) if (!w.error && texts.has(w.path)) out.set(w.path, fromWire(w, 'python', 'python-ast', texts.get(w.path)!));
  return out;
}

// ------------------------------------------------------------------------------------------------ Go (go/ast)

/** Go helper: reads [{path, text}] as JSON on stdin, writes [{path, definitions, usages} | {path, error}]. */
export const GO_AST_PROGRAM = `package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
)

type in struct {
	Path string \`json:"path"\`
	Text string \`json:"text"\`
}
type def struct {
	Name      string \`json:"name"\`
	Kind      string \`json:"kind"\`
	Line      int    \`json:"line"\`
	End       int    \`json:"end"\`
	Container string \`json:"container,omitempty"\`
}
type out struct {
	Path        string          \`json:"path"\`
	Error       string          \`json:"error,omitempty"\`
	Definitions []def           \`json:"definitions,omitempty"\`
	Usages      [][3]interface{} \`json:"usages,omitempty"\`
}

func recvName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return recvName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr:
		return recvName(t.X)
	case *ast.IndexListExpr:
		return recvName(t.X)
	}
	return ""
}

func main() {
	var files []in
	if err := json.NewDecoder(os.Stdin).Decode(&files); err != nil {
		os.Exit(2)
	}
	res := make([]out, 0, len(files))
	for _, f := range files {
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, f.Path, f.Text, parser.ParseComments)
		if err != nil {
			res = append(res, out{Path: f.Path, Error: err.Error()})
			continue
		}
		o := out{Path: f.Path}
		line := func(p token.Pos) int { return fset.Position(p).Line }
		use := func(p token.Pos, name, usage string) { o.Usages = append(o.Usages, [3]interface{}{line(p), name, usage}) }
		for _, d := range file.Decls {
			switch x := d.(type) {
			case *ast.FuncDecl:
				if x.Recv != nil && len(x.Recv.List) > 0 {
					o.Definitions = append(o.Definitions, def{Name: x.Name.Name, Kind: "method", Line: line(x.Pos()), End: line(x.End()), Container: recvName(x.Recv.List[0].Type)})
				} else {
					o.Definitions = append(o.Definitions, def{Name: x.Name.Name, Kind: "function", Line: line(x.Pos()), End: line(x.End())})
				}
			case *ast.GenDecl:
				for _, s := range x.Specs {
					switch sp := s.(type) {
					case *ast.TypeSpec:
						kind := "type"
						switch sp.Type.(type) {
						case *ast.StructType:
							kind = "struct"
						case *ast.InterfaceType:
							kind = "interface"
						}
						o.Definitions = append(o.Definitions, def{Name: sp.Name.Name, Kind: kind, Line: line(sp.Pos()), End: line(sp.End())})
					case *ast.ValueSpec:
						for _, n := range sp.Names {
							o.Definitions = append(o.Definitions, def{Name: n.Name, Kind: "variable", Line: line(n.Pos()), End: line(sp.End())})
						}
					}
				}
			}
		}
		writes := map[ast.Expr]bool{}
		calls := map[ast.Expr]bool{}
		ast.Inspect(file, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.AssignStmt:
				for _, l := range x.Lhs {
					writes[l] = true
				}
			case *ast.IncDecStmt:
				writes[x.X] = true
			case *ast.CallExpr:
				calls[x.Fun] = true
			}
			return true
		})
		ast.Inspect(file, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.SelectorExpr:
				usage := "read"
				if writes[x] {
					usage = "write"
				} else if calls[x] {
					usage = "call"
				}
				use(x.Sel.Pos(), x.Sel.Name, usage)
			case *ast.Ident:
				usage := "read"
				if writes[x] {
					usage = "write"
				} else if calls[x] {
					usage = "call"
				}
				use(x.Pos(), x.Name, usage)
			}
			return true
		})
		res = append(res, o)
	}
	_ = json.NewEncoder(os.Stdout).Encode(res)
}
`;

/** Built helpers per (resolved) helper directory. */
const goHelpers = new Map<string, Promise<string | undefined>>();

/** True when `p` exists, is of the wanted kind, is owned by this user and is not writable by group or others. */
async function ownedPrivate(p: string, kind: 'dir' | 'file'): Promise<boolean> {
  try {
    const st = await lstat(p);
    const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
    return (kind === 'dir' ? st.isDirectory() : st.isFile()) && st.uid === uid && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** The only environment a helper build / run sees (never the host's model or provider credentials). */
function helperEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'SYSTEMROOT', 'GOROOT']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

/**
 * The compiled Go helper, built once per helper directory, or undefined (the caller falls back to the regex extractor) when no
 * Go toolchain can build it or the directory is not private.
 *
 * SECURITY: the helper runs in the Hypertest process's context (outside every sandbox), so the directory holding it must be
 * one agent commands can neither read nor write — the composition passes a directory under its state directory, which the
 * local sandbox hides from every command (an empty read-only tmpfs in the jail). A shared, predictable path under the OS temp
 * directory would let a sandboxed command running as the same user replace the binary and have the host execute it (a
 * sandbox escape), so there is no such default: without `helperDir` Go files use the regex fallback. The build uses a
 * private GOCACHE/GOPATH inside the directory, ignores the user's go env file (GOENV=off: an agent-writable `go env -w`
 * could add `-toolexec`), never downloads (GOPROXY=off, GOTOOLCHAIN=local), and sees no host credentials.
 */
export function goAstHelper(helperDir: string | undefined): Promise<string | undefined> {
  if (typeof helperDir !== 'string' || helperDir === '' || !isAbsolute(helperDir)) return Promise.resolve(undefined);
  const dir = resolve(helperDir);
  let helper = goHelpers.get(dir);
  if (!helper) {
    helper = (async () => {
      const hash = createHash('sha256').update(GO_AST_PROGRAM).digest('hex').slice(0, 16);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // a directory someone else owns or can write is never trusted (its content could be swapped)
      if (!(await ownedPrivate(dir, 'dir'))) return undefined;
      const bin = join(dir, `goast-${hash}`);
      if (await ownedPrivate(bin, 'file')) return bin;
      const src = await mkdtemp(join(dir, 'build-'));
      try {
        await writeFile(join(src, 'main.go'), GO_AST_PROGRAM, { mode: 0o600 });
        await writeFile(join(src, 'go.mod'), 'module hypertest/goast\n\ngo 1.21\n', { mode: 0o600 });
        const tmpBin = `${bin}.${process.pid}.tmp`;
        const r = await run('go', ['build', '-trimpath', '-o', tmpBin, '.'], '', {
          cwd: src,
          timeoutMs: 180_000,
          env: helperEnv({
            GOENV: 'off', GOFLAGS: '-mod=mod', GOWORK: 'off', GOPROXY: 'off', GOTOOLCHAIN: 'local', CGO_ENABLED: '0',
            GOCACHE: join(dir, 'gocache'), GOPATH: join(dir, 'gopath'), GOMODCACHE: join(dir, 'gopath', 'pkg', 'mod'),
          }),
        });
        if (r.spawnError || r.code !== 0) return undefined;
        await rename(tmpBin, bin);
        return bin;
      } finally {
        await rm(src, { recursive: true, force: true });
      }
    })().catch(() => undefined);
    goHelpers.set(dir, helper);
  }
  return helper;
}

/**
 * Parses Go files with go/ast (one helper process for the batch); undefined when no `helperDir` is given (see goAstHelper:
 * never a shared temp path) or no Go toolchain can build the helper.
 */
export async function parseGoFiles(files: Array<{ path: string; text: string }>, options: { timeoutMs?: number; helperDir?: string } = {}): Promise<Map<string, ParsedFile> | undefined> {
  if (files.length === 0) return new Map();
  const bin = await goAstHelper(options.helperDir);
  if (!bin) return undefined;
  // re-checked before every run: a helper that is no longer this user's private file is never executed
  if (!(await ownedPrivate(bin, 'file'))) return undefined;
  const r = await run(bin, [], JSON.stringify(files), { timeoutMs: options.timeoutMs ?? 120_000, env: helperEnv() });
  if (r.spawnError || r.code !== 0) return undefined;
  let parsed: WireParsed[];
  try {
    parsed = JSON.parse(r.stdout) as WireParsed[];
  } catch {
    return undefined;
  }
  const texts = new Map(files.map((f) => [f.path, f.text]));
  const out = new Map<string, ParsedFile>();
  for (const w of parsed) if (!w.error && texts.has(w.path)) out.set(w.path, fromWire(w, 'go', 'go-ast', texts.get(w.path)!));
  return out;
}
