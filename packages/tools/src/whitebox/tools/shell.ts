import { HypertestError, type JsonValue } from '@hypertest/core';
import type { BuiltinToolOptions, ToolSpec } from '../../contracts.ts';
import { argumentPathDenial } from '../argv-guard.ts';
import { sandboxCwd } from '../sandbox.ts';
import { pathResource, rootResource } from './common.ts';

/** Default shell.exec allowlist. Shells (bash/sh/zsh) are deliberately absent: argv only, no shell. */
export const DEFAULT_SHELL_ALLOWLIST: readonly string[] = Object.freeze(['node', 'npm', 'npx', 'python3', 'python', 'pytest', 'go', 'git', 'ls', 'cat', 'grep', 'rg', 'sed', 'awk', 'head', 'tail', 'wc', 'diff', 'make']);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

interface ShellInput {
  command: string[];
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
}

/** Why a command is not allowed (undefined when it is). */
export function shellDenial(command: readonly string[], allowlist: readonly string[], permitCommands?: readonly string[]): string | undefined {
  const program = command[0];
  if (program === undefined || program === '') return 'empty command';
  if (program.includes('/') || program.includes('\\')) return `command must be a bare program name from the allowlist, not a path: ${program}`;
  if (!allowlist.includes(program)) return `command ${JSON.stringify(program)} is not in the shell allowlist (${allowlist.join(', ')})`;
  if (permitCommands !== undefined && !permitCommands.includes(program)) return `command ${JSON.stringify(program)} is outside the permit's allowedCommands (${permitCommands.join(', ')})`;
  return undefined;
}

export function shellExecTool(options: BuiltinToolOptions): ToolSpec<ShellInput> {
  const allowlist = options.shellAllowlist ?? DEFAULT_SHELL_ALLOWLIST;
  return {
    id: 'shell.exec',
    title: 'Run command',
    description: `Run an allowlisted program with an argv array (no shell: no pipes, globbing or redirection) in the workspace sandbox with a scrubbed environment. Allowed programs: ${allowlist.join(', ')}. Arguments may only name paths inside the workspace (no absolute paths outside it, no .. escapes). stdout/stderr are recorded as evidence.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', maxLength: 32 * 1024 } },
        cwd: { type: 'string', minLength: 1, maxLength: 4096 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
        stdin: { type: 'string', maxLength: 1024 * 1024 },
      },
    },
    effect: 'execute',
    riskClass: 'medium',
    timeoutMs: MAX_TIMEOUT_MS + 5_000,
    // a program can touch anything in the workspace whatever its cwd: the capability must cover the root
    // (a cwd outside the root is still refused by the sandbox's cwd confinement)
    resources: (input, ctx) => (input.cwd ? [rootResource(ctx), pathResource(ctx, input.cwd)] : [rootResource(ctx)]),
    async execute(input, ctx) {
      const denial = shellDenial(input.command, allowlist, ctx.permit.constraints?.allowedCommands);
      if (denial) return { status: 'denied', error: { code: 'permission_denied', message: denial } };
      // security-H1a: the local sandbox confines only the cwd; the program resolves its arguments itself (inside an OCI
      // container argv names container paths — the mount namespace is the boundary there)
      const argDenial = options.sandbox.kind === 'oci' ? undefined : await confinedArguments(ctx.workspace, input.cwd, input.command);
      if (argDenial) return { status: 'denied', error: { code: 'permission_denied', message: argDenial } };
      const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx.permit.constraints?.maxDurationMs ?? MAX_TIMEOUT_MS);
      const runOpts: Parameters<typeof options.sandbox.run>[2] = { timeoutMs, signal: ctx.signal };
      if (input.cwd !== undefined) runOpts.cwd = input.cwd;
      if (input.stdin !== undefined) runOpts.stdin = input.stdin;
      const r = await options.sandbox.run(ctx.workspace, input.command, runOpts);
      const evidenceRefs: string[] = [];
      const provenance = { command: input.command };
      if (r.stdout.length > 0) {
        const ev = await ctx.recordEvidence({ evidenceType: 'stdout', data: r.stdout, mimeType: 'text/plain', summary: `stdout of ${input.command.join(' ').slice(0, 200)}${r.stdoutTruncated ? ' (truncated)' : ''}`, provenance });
        evidenceRefs.push(ev.evidenceId);
      }
      if (r.stderr.length > 0) {
        const ev = await ctx.recordEvidence({ evidenceType: 'stderr', data: r.stderr, mimeType: 'text/plain', summary: `stderr of ${input.command.join(' ').slice(0, 200)}${r.stderrTruncated ? ' (truncated)' : ''}`, provenance });
        evidenceRefs.push(ev.evidenceId);
      }
      const structured: Record<string, JsonValue> = {
        exitCode: r.exitCode,
        signal: r.signal,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        stdoutBytes: Buffer.byteLength(r.stdout),
        stderrBytes: Buffer.byteLength(r.stderr),
        stdoutTruncated: r.stdoutTruncated,
        stderrTruncated: r.stderrTruncated,
      };
      const text = `exit ${r.exitCode ?? 'null'}${r.signal ? ` (signal ${r.signal})` : ''}${r.timedOut ? ' (timed out)' : ''}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
      if (r.spawnError) return { status: 'failed', error: { code: 'not_found', message: `could not start ${input.command[0]}: ${r.spawnError}` }, structured, text, evidenceRefs };
      if (r.timedOut) return { status: 'timeout', error: { code: 'timeout', message: `command timed out after ${timeoutMs}ms` }, structured, text, evidenceRefs };
      // a non-zero exit is a legitimate outcome of a successful tool call
      return { status: 'success', structured, text, evidenceRefs };
    },
  };
}

/**
 * Why agent argv would reach outside the workspace (see argumentPathDenial), resolved against the confined cwd.
 * A cwd that escapes the root is refused here too (the sandbox would refuse it as well).
 */
export async function confinedArguments(ws: Parameters<typeof argumentPathDenial>[0], cwd: string | undefined, command: readonly string[]): Promise<string | undefined> {
  let abs: string;
  try {
    abs = await sandboxCwd(ws, cwd);
  } catch (e) {
    if (e instanceof HypertestError) return `cwd ${JSON.stringify(cwd)}: ${e.message}`;
    throw e;
  }
  return argumentPathDenial(ws, abs, command);
}
