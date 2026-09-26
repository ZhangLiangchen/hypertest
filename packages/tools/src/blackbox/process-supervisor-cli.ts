/**
 * Runs the process supervisor as its own process (so it outlives a crashed Hypertest process, e.g. PoC C):
 *
 *   node process-supervisor-cli.ts [--port N] [--host H] [--cwd DIR] [--state-file F] [--log-file F]
 *                                  [--control-token T] [--allow-env KEY]... [--env KEY=VALUE]... -- <command> [args...]
 *
 * Prints one JSON line `{"url","controlUrl","controlBaseUrl","port","childPid","generation"}` on stdout once
 * the child is ready (`controlUrl` carries the control token; pass --control-token to keep it stable across
 * supervisor restarts, e.g. together with --state-file); SIGTERM/SIGINT close the supervisor and stop the child.
 */
import { startProcessSupervisor, type ProcessSupervisorOptions } from './process-supervisor.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) {
    process.stderr.write('usage: process-supervisor-cli [options] -- <command> [args...]\n');
    process.exit(2);
  }
  const flags = argv.slice(0, sep);
  const options: ProcessSupervisorOptions = { command: argv.slice(sep + 1) };
  const env: Record<string, string> = {};
  const allow: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const v = flags[i + 1];
    if (v === undefined) throw new Error(`missing value for ${f}`);
    i++;
    switch (f) {
      case '--port':
        options.port = Number(v);
        break;
      case '--host':
        options.host = v;
        break;
      case '--cwd':
        options.cwd = v;
        break;
      case '--state-file':
        options.stateFile = v;
        break;
      case '--log-file':
        options.logFile = v;
        break;
      case '--control-token':
        options.controlToken = v;
        break;
      case '--allow-env':
        allow.push(v);
        break;
      case '--env': {
        const eq = v.indexOf('=');
        if (eq <= 0) throw new Error(`--env expects KEY=VALUE, got ${v}`);
        env[v.slice(0, eq)] = v.slice(eq + 1);
        break;
      }
      default:
        throw new Error(`unknown option ${f}`);
    }
  }
  if (Object.keys(env).length > 0) options.env = env;
  if (allow.length > 0) options.allowedEnvOverrides = allow;
  const sup = await startProcessSupervisor(options);
  process.stdout.write(JSON.stringify({ url: sup.url, controlUrl: sup.controlUrl, controlBaseUrl: sup.controlBaseUrl, port: sup.port, childPid: sup.childPid ?? null, generation: sup.generation }) + '\n');
  const shutdown = () => {
    void sup.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(`process-supervisor: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
