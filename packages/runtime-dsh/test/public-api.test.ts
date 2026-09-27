import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import * as api from '../src/index.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('runtime exports: the engine, its kind, versions and pins only', () => {
  assert.deepEqual(Object.keys(api).sort(), ['DSH_AGENT_VERSION', 'DSH_ENGINE_KIND', 'DSH_PINS', 'DshEngine', 'RUNTIME_DSH_PACKAGE_VERSION', 'SUPPORTED_DSH_VERSION']);
  assert.ok(Object.isFrozen(api.DSH_PINS));
});

test('no DeepSeek Harness / cordis type appears in the exported signatures (declaration emit of the public surface)', () => {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    allowImportingTsExtensions: true,
    declaration: true,
    emitDeclarationOnly: true,
    // Only code counts (doc comments may name DSH).
    removeComments: true,
    skipLibCheck: true,
    types: ['node'],
  };
  const emitted = new Map<string, string>();
  const host = ts.createCompilerHost(options);
  host.writeFile = (fileName, text) => emitted.set(fileName.replace(/\\/g, '/'), text);
  const program = ts.createProgram([join(SRC, 'index.ts')], options, host);
  const result = program.emit();
  assert.deepEqual(result.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);

  // The public surface: index.d.ts and every module it re-exports (transitively).
  const surface: string[] = [];
  const pending = [join(SRC, 'index.d.ts').replace(/\\/g, '/')];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (surface.includes(file)) continue;
    const text = emitted.get(file);
    assert.ok(text !== undefined, `declarations emitted for ${file}`);
    surface.push(file);
    for (const m of text.matchAll(/export\s+(?:\*|\{[^}]*\})\s+from\s+['"](\.[^'"]+)['"]/g)) pending.push(join(dirname(file), m[1]!.replace(/\.ts$/, '.d.ts')).replace(/\\/g, '/'));
  }
  assert.deepEqual(surface.map((f) => f.slice(f.lastIndexOf('/') + 1)).sort(), ['contracts.d.ts', 'dsh-engine.d.ts', 'index.d.ts', 'version.d.ts']);
  for (const file of surface) {
    const text = emitted.get(file)!;
    assert.doesNotMatch(text, /@deepseek-ai|cordis|schemastery/i, `${file} leaks a DSH type:\n${text}`);
  }
  // Sanity: the check would catch a leak — the private conversion and kernel modules do mention DSH types.
  for (const internal of ['/convert.d.ts', '/kernel.d.ts']) {
    const text = [...emitted.entries()].find(([f]) => f.endsWith(internal))?.[1] ?? '';
    assert.match(text, /@deepseek-ai\//, `${internal} names DSH types`);
  }
});
