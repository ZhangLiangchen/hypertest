import { HypertestError } from '@hypertest/core';
import type { TestRunnerAdapter } from '../../contracts.ts';
import { buildResult, processHarnessError } from './common.ts';

export interface CommandRunnerOptions {
  command: string[];
  /**
   * An exit code proves nothing about how many tests ran. Without this flag a command run is never
   * `passed` (cases = 0 ⇒ fake-green guard); with it, exit 0 counts as passed.
   */
  allowNoCases?: boolean;
  framework?: string;
  env?: Record<string, string>;
}

/**
 * Generic command runner (exit-code based). Reports `cases: []` explicitly; `passed` is false unless
 * `allowNoCases` and exit 0. Timeouts, kills and start failures are harness errors. Never auto-detected.
 */
export function commandRunner(options: CommandRunnerOptions): TestRunnerAdapter {
  if (!Array.isArray(options?.command) || options.command.length === 0 || options.command.some((a) => typeof a !== 'string')) {
    throw new HypertestError('invalid_argument', 'commandRunner requires a non-empty command array');
  }
  const framework = options.framework ?? 'command';
  return {
    framework,
    async detect() {
      return false;
    },
    async run(ws, request, sandbox) {
      const argv = [...options.command];
      const proc = await sandbox.run(ws, argv, { timeoutMs: request.timeoutMs, signal: request.signal, env: { ...(options.env ?? {}), ...(request.env ?? {}) } });
      const harnessError = processHarnessError(proc, argv[0]!);
      const result = buildResult({ framework, command: argv, exitCode: proc.exitCode, cases: [], durationMs: proc.durationMs, harnessError });
      // buildResult requires ≥1 passed case; an explicit opt-in accepts a clean exit without case data
      if (options.allowNoCases === true && harnessError === undefined && proc.exitCode === 0) result.passed = true;
      return { result, stdout: proc.stdout, stderr: proc.stderr };
    },
  };
}
