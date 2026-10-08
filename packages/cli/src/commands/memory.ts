import { join } from 'node:path';
import { HypertestError } from '@hypertest/core';
import { isLoopbackHost, serveMemory } from '@hypertest/app';
import { UsageError, int, positionals, str } from '../args.ts';
import type { Command } from '../command.ts';
import { aborted, cliLogger, loadCliConfig, logLevelOf } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';

/** Variable read for the memory service's bearer token when --api-key-env is not given. */
export const DEFAULT_MEMORY_API_KEY_ENV = 'HYPERTEST_MEMORY_API_KEY';

/**
 * (B[4]) `hypertest memory serve`: the L4 durable-memory service in the foreground — its own process and its own storage
 * (an embedded PGlite directory), serving the HTTP API a deployment reaches with `memory: { kind: powercontext, baseUrl }`.
 */
export const memoryCommand: Command = {
  name: 'memory',
  summary: 'serve the L4 durable-memory service (its own process and storage) until interrupted',
  usage: ['memory serve [--data-dir <dir>] [--port 7430] [--host 127.0.0.1] [--api-key-env <VAR>]'],
  optionHelp: [
    ['--data-dir <dir>', 'the service\'s own storage (default: memory.dataDir of a `service` configuration, else <project dataDir>/memory)'],
    ['--port <n>', 'listen port (default 7430; 0 = any free port)'],
    ['--host <host>', 'listen host (default 127.0.0.1; a non-loopback host requires an API key)'],
    ['--api-key-env <VAR>', `environment variable holding the bearer token clients must present (default ${DEFAULT_MEMORY_API_KEY_ENV} when set)`],
  ],
  notes: [
    'Point a deployment at it with `memory: { kind: powercontext, baseUrl: <url>, apiKeyEnv: <VAR> }`; `memory: { kind: service }` makes Hypertest start and stop such a process itself.',
    'The token is read from the environment only: a value on the command line would be visible to every process on the host.',
  ],
  options: { 'data-dir': { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, 'api-key-env': { type: 'string' } },
  longRunning: true,
  async run(ctx, values, args) {
    const [sub] = positionals('memory', args, ['sub-command']);
    if (sub !== 'serve') throw new UsageError(`unknown sub-command ${JSON.stringify(sub)} (memory serve)`, 'memory');
    const port = int('memory', values, 'port', { min: 0, max: 65535 }) ?? 7430;
    const host = str(values, 'host') ?? '127.0.0.1';
    const keyVar = str(values, 'api-key-env');
    if (keyVar !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyVar)) throw new UsageError(`--api-key-env must name an environment variable (got ${JSON.stringify(keyVar)})`, 'memory');
    let apiKey: string | undefined;
    if (keyVar !== undefined) {
      apiKey = ctx.io.env[keyVar];
      if (!apiKey) throw new HypertestError('precondition_failed', `--api-key-env ${keyVar}: the variable is not set`);
    } else apiKey = ctx.io.env[DEFAULT_MEMORY_API_KEY_ENV] || undefined;
    if (!isLoopbackHost(host) && apiKey === undefined) throw new HypertestError('invalid_argument', `refusing to serve the memory service on non-loopback host ${host} without an API key (set ${DEFAULT_MEMORY_API_KEY_ENV} or --api-key-env)`);
    let dataDir = str(values, 'data-dir');
    if (dataDir === undefined) {
      const { config } = await loadCliConfig(ctx);
      dataDir = config.memory?.kind === 'service' && config.memory.dataDir ? config.memory.dataDir : join(config.project.dataDir, 'memory');
    }
    const service = await serveMemory({ dataDir, host, port, logger: cliLogger(ctx, logLevelOf(ctx, 'warn')), ...(apiKey !== undefined ? { apiKey } : {}) });
    try {
      if (ctx.global.json) ctx.json({ url: service.url, dataDir, authenticated: apiKey !== undefined });
      else {
        ctx.out(`Hypertest memory service listening on ${service.url} (storage ${dataDir})`);
        if (apiKey === undefined) ctx.out(`no API key: any local process can use it (set ${DEFAULT_MEMORY_API_KEY_ENV} or --api-key-env)`);
        ctx.out('press Ctrl-C to stop');
      }
      const stop = aborted(ctx.signal);
      await stop.promise;
      stop.dispose();
    } finally {
      await service.close();
    }
    return EXIT_CODES.ok;
  },
};
