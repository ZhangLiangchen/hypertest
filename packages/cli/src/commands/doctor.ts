import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isHypertestError } from '@hypertest/core';
import { diagnose, loadConfig } from '@hypertest/app';
import { int, positionals } from '../args.ts';
import type { Command } from '../command.ts';
import { CONFIG_FILE_NAMES, findConfig } from '../context.ts';
import type { DoctorCheck, DoctorReport } from '../contracts.ts';
import { EXIT_CODES } from '../exit-codes.ts';

const exec = promisify(execFile);

/** Minimum Node.js version (the packages are executed from TypeScript source with native type stripping). */
export const MIN_NODE_VERSION: readonly [number, number, number] = [22, 18, 0];

export function nodeVersionCheck(version: string = process.versions.node): DoctorCheck {
  const parts = version.split('.').map((x) => Number.parseInt(x, 10));
  const [major = 0, minor = 0, patch = 0] = parts;
  const [M, m, p] = MIN_NODE_VERSION;
  const ok = major !== M ? major > M : minor !== m ? minor > m : patch >= p;
  return ok
    ? { name: 'node', status: 'ok', detail: `Node.js ${version}` }
    : { name: 'node', status: 'error', detail: `Node.js ${version} is too old: Hypertest needs ≥ ${MIN_NODE_VERSION.join('.')} (native TypeScript type stripping)` };
}

/** A command's first output line, or undefined when it is missing or fails within `timeoutMs`. */
async function probe(command: string, args: string[], timeoutMs: number): Promise<{ ok: true; out: string } | { ok: false; missing: boolean; error: string }> {
  try {
    const { stdout } = await exec(command, args, { timeout: timeoutMs, windowsHide: true });
    return { ok: true, out: stdout.trim().split('\n')[0] ?? '' };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.code === 'ENOENT') return { ok: false, missing: true, error: `${command} not found on PATH` };
    const detail = err.killed ? `no answer within ${timeoutMs} ms` : (err.stderr?.trim().split('\n')[0] || err.message);
    return { ok: false, missing: false, error: detail };
  }
}

export async function gitCheck(timeoutMs: number): Promise<DoctorCheck> {
  const r = await probe('git', ['--version'], timeoutMs);
  if (r.ok) return { name: 'git', status: 'ok', detail: r.out };
  return { name: 'git', status: 'warn', detail: `${r.error}: white-box runs (worktrees, diffs, --commit resolution) need git` };
}

/** Docker is optional (OCI sandbox, docker environments): informational unless the configuration needs it (diagnose reports that). */
export async function dockerCheck(timeoutMs: number): Promise<DoctorCheck> {
  const cli = await probe('docker', ['--version'], timeoutMs);
  if (!cli.ok) return { name: 'docker', status: 'info', detail: `${cli.error} (only needed for sandbox.kind oci and docker environments)` };
  const daemon = await probe('docker', ['version', '--format', '{{.Server.Version}}'], timeoutMs);
  if (daemon.ok && daemon.out !== '') return { name: 'docker', status: 'info', detail: `${cli.out}; daemon ${daemon.out} reachable` };
  return { name: 'docker', status: 'info', detail: `${cli.out}; the daemon is not reachable (${daemon.ok ? 'no server version' : daemon.error}) — only needed for sandbox.kind oci and docker environments` };
}

const MARK: Record<DoctorCheck['status'], string> = { ok: 'ok', warn: 'WARN', error: 'ERROR', info: 'info' };

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'check Node.js, the configuration, provider key variables (names only), infrastructure, BUGate binding, git and docker',
  usage: ['doctor [--config <file>] [--no-connect] [--timeout-ms <n>] [--json]'],
  optionHelp: [
    ['--no-connect', 'do not probe the configured infrastructure (PostgreSQL, NATS, Temporal, OPA, PowerContext)'],
    ['--timeout-ms <n>', 'per-probe timeout (default 3000)'],
  ],
  notes: ['Secret values are never printed: only whether the variables named by *Env fields are set. Exit code 0 when no check is an error, 1 otherwise.'],
  options: { connect: { type: 'boolean', default: true }, 'timeout-ms': { type: 'string' } },
  async run(ctx, values, args) {
    positionals('doctor', args, []);
    const timeoutMs = int('doctor', values, 'timeout-ms', { min: 1, max: 600_000 }) ?? 3000;
    const connect = values['connect'] !== false;
    const checks: DoctorCheck[] = [nodeVersionCheck()];
    const configPath = findConfig(ctx.io, ctx.global.config);
    if (!configPath) {
      checks.push({ name: 'config', status: 'error', detail: `no ${CONFIG_FILE_NAMES[0]} found in ${ctx.io.cwd} or its parent directories (run \`hypertest init\` or pass --config)` });
    } else {
      try {
        const config = await loadConfig(configPath, { env: ctx.io.env });
        checks.push({ name: 'config', status: 'ok', detail: `loaded ${configPath}` });
        const report = await diagnose(config, { env: ctx.io.env, connect, timeoutMs });
        checks.push(...report.checks.filter((c) => !(c.name === 'config' && c.status === 'ok')));
      } catch (e) {
        const errors = isHypertestError(e) && Array.isArray(e.details['errors']) ? (e.details['errors'] as unknown[]).map(String) : [(e as Error).message];
        for (const detail of errors) checks.push({ name: 'config', status: 'error', detail: `${configPath}: ${detail}` });
      }
    }
    checks.push(await gitCheck(timeoutMs));
    checks.push(await dockerCheck(timeoutMs));
    const report: DoctorReport = { ok: checks.every((c) => c.status !== 'error'), ...(configPath ? { configPath } : {}), checks };
    if (ctx.global.json) ctx.json(report);
    else {
      const width = Math.max(...checks.map((c) => c.name.length));
      for (const c of checks) ctx.out(`[${MARK[c.status].padEnd(5)}] ${c.name.padEnd(width)}  ${c.detail}`);
      const errors = checks.filter((c) => c.status === 'error').length;
      const warnings = checks.filter((c) => c.status === 'warn').length;
      ctx.out('');
      ctx.out(report.ok ? `ok${warnings > 0 ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}` : `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
    }
    return report.ok ? EXIT_CODES.ok : EXIT_CODES.failure;
  },
};
