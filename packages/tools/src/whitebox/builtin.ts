import { HypertestError } from '@hypertest/core';
import { blackboxTools, type BlackboxToolOptions } from '../blackbox/index.ts';
import type { BuiltinToolOptions, ToolSpec } from '../contracts.ts';
import { codeReferencesTool, codeSymbolsTool } from './tools/code.ts';
import { fsApplyPatchTool, fsListTool, fsReadTool, fsSearchTool, fsWriteTool } from './tools/fs.ts';
import { gitBlameTool, gitCommitTool, gitDiffTool, gitLogTool, gitShowTool, gitStatusTool } from './tools/git.ts';
import { shellExecTool } from './tools/shell.ts';
import { coverageCollectTool, mutationRunTool, testRunTool } from './tools/testing.ts';

/** All white-box tool specs (fs, git, shell, test, coverage, mutation, code). */
export function whiteboxTools(options: BuiltinToolOptions): ToolSpec[] {
  if (!options || !options.sandbox || !options.workspaces) throw new HypertestError('invalid_argument', 'builtinTools requires sandbox and workspaces');
  return [
    fsReadTool(options),
    fsListTool(options),
    fsSearchTool(options),
    fsWriteTool(options),
    fsApplyPatchTool(options),
    gitStatusTool(options),
    gitDiffTool(options),
    gitLogTool(options),
    gitShowTool(options),
    gitBlameTool(options),
    gitCommitTool(options),
    shellExecTool(options),
    testRunTool(options),
    coverageCollectTool(options),
    mutationRunTool(options),
    codeSymbolsTool(options),
    codeReferencesTool(options),
  ] as ToolSpec[];
}

/**
 * Every built-in tool: the white-box specs plus the black-box specs of `blackboxTools(options)` (the single
 * coordination point between the two halves of this package; imported statically so a missing or renamed
 * export is a compile error instead of a silently smaller tool catalog). The options object is passed
 * through: `httpAllowlist`, `enableBrowser` and `stateDir` (optional here; without it load.observe dedupes
 * evidence in-process only) are read by the black-box half.
 */
export function builtinTools(options: BuiltinToolOptions): ToolSpec[] {
  const specs = whiteboxTools(options);
  specs.push(...blackboxTools(options as BuiltinToolOptions & BlackboxToolOptions));
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.id)) throw new HypertestError('conflict', `builtin tool id ${s.id} is defined twice`);
    seen.add(s.id);
  }
  return specs;
}
