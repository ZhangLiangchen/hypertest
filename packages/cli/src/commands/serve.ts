import { HypertestError } from '@hypertest/core';
import { isLoopbackHost, startApiServer, type ApiServerOptions, type HypertestConfig } from '@hypertest/app';
import { UsageError, int, positionals, str } from '../args.ts';
import type { Command } from '../command.ts';
import { aborted, withInstance } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';

/** Default port of `hypertest serve`. */
export const DEFAULT_API_PORT = 7420;
/** Variable read for the API token when --token-env is not given (tokens are never accepted on the command line). */
export const DEFAULT_API_TOKEN_ENV = 'HYPERTEST_API_TOKEN';
/** Minimum API token length (as startApiServer enforces). */
export const MIN_API_TOKEN_LENGTH = 16;

export const serveCommand: Command = {
  name: 'serve',
  summary: 'serve the HTTP API (and drive runs in this process) until interrupted',
  usage: ['serve [--port 7420] [--host 127.0.0.1] [--token-env <VAR>] [--no-resume]'],
  optionHelp: [
    ['--port <n>', `listen port (default ${DEFAULT_API_PORT}; 0 = any free port)`],
    ['--host <host>', 'listen host (default 127.0.0.1; a non-loopback host requires a token)'],
    ['--token-env <VAR>', `environment variable holding the bearer token (default ${DEFAULT_API_TOKEN_ENV} when set); human decisions over the API require it`],
    ['--no-resume', 'do not resume incomplete runs at start'],
  ],
  notes: ['The token is read from the environment only: a value on the command line would be visible to every process on the host.'],
  options: { port: { type: 'string' }, host: { type: 'string' }, 'token-env': { type: 'string' }, resume: { type: 'boolean', default: true } },
  longRunning: true,
  async run(ctx, values, args) {
    positionals('serve', args, []);
    const port = int('serve', values, 'port', { min: 0, max: 65535 }) ?? DEFAULT_API_PORT;
    const host = str(values, 'host');
    const tokenVar = str(values, 'token-env');
    if (tokenVar !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenVar)) throw new UsageError(`--token-env must name an environment variable (got ${JSON.stringify(tokenVar)})`, 'serve');
    let token: string | undefined;
    if (tokenVar !== undefined) {
      token = ctx.io.env[tokenVar];
      if (!token) throw new HypertestError('precondition_failed', `--token-env ${tokenVar}: the variable is not set`);
    } else token = ctx.io.env[DEFAULT_API_TOKEN_ENV] || undefined;
    // what startApiServer would refuse is refused before the store is opened (and before any run is resumed)
    const tokenSource = tokenVar ?? DEFAULT_API_TOKEN_ENV;
    if (token !== undefined && token.length < MIN_API_TOKEN_LENGTH) throw new HypertestError('invalid_argument', `the API token in ${tokenSource} must be at least ${MIN_API_TOKEN_LENGTH} characters`);
    if (host !== undefined && !isLoopbackHost(host) && token === undefined) {
      throw new HypertestError('invalid_argument', `refusing to serve the API on non-loopback host ${host} without a token (set ${DEFAULT_API_TOKEN_ENV} or --token-env)`);
    }
    return withInstance(ctx, { drivesAgents: true, logLevel: 'config' }, async ({ ht }) => {
      if (ctx.signal.aborted) {
        // stopped while starting: neither listen nor resume anything
        if (!ctx.global.json) ctx.err('stopping: interrupted before the server started');
        return EXIT_CODES.ok;
      }
      const options: ApiServerOptions = { port };
      if (host !== undefined) options.host = host;
      if (token !== undefined) options.token = token;
      // listen first: a server that cannot start (port in use, …) must not have started run loops that it then aborts
      const server = await startApiServer(ht, options);
      try {
        const resumed = values['resume'] === false ? [] : await ht.resumeIncomplete();
        if (ctx.global.json) ctx.json({ url: server.url, manifestId: ht.manifest.manifestId, resumed, authenticated: token !== undefined });
        else {
          ctx.out(`Hypertest API listening on ${server.url} (runtime manifest ${ht.manifest.manifestId})`);
          if (resumed.length > 0) ctx.out(`resumed ${resumed.length} run${resumed.length === 1 ? '' : 's'}: ${resumed.join(', ')}`);
          if (token === undefined) ctx.out(`no API token: human decisions (approvals, oracle proposals) are refused over the API (set ${DEFAULT_API_TOKEN_ENV} or --token-env)`);
          ctx.out('press Ctrl-C to stop');
        }
        const stop = aborted(ctx.signal);
        await stop.promise;
        stop.dispose();
        if (!ctx.global.json) ctx.err('stopping: incomplete runs stay resumable');
      } finally {
        await server.close();
      }
      return EXIT_CODES.ok;
    });
  },
};

export const workerCommand: Command = {
  name: 'worker',
  summary: 'host a Temporal worker (durable.kind temporal, workerMode external) until interrupted',
  usage: ['worker [--config <file>]'],
  notes: [
    'Clients configured with durable.workerMode external (run, resume, serve) only start workflows; `hypertest worker` executes them.',
    'Every worker must use the same configuration as the clients: a run is only driven by a runtime with the manifest it is pinned to (I11).',
  ],
  options: {},
  longRunning: true,
  async run(ctx, _values, args) {
    positionals('worker', args, []);
    // this process hosts the activities + workflows: the embedded worker of the Temporal durable runtime
    const adjust = (config: HypertestConfig): HypertestConfig => {
      if (config.durable.kind !== 'temporal') {
        throw new HypertestError('precondition_failed', `\`hypertest worker\` hosts Temporal activities: the configuration's durable.kind is ${config.durable.kind} (set durable: { kind: temporal, address: ..., workerMode: external })`);
      }
      return { ...config, durable: { ...config.durable, workerMode: 'embedded' } };
    };
    return withInstance(ctx, { drivesAgents: true, logLevel: 'config', adjust }, async ({ ht }) => {
      const durable = ht.durable as typeof ht.durable & { start?: () => Promise<void>; taskQueue?: string };
      if (typeof durable.start !== 'function') throw new HypertestError('unsupported', 'the Temporal durable runtime cannot be started eagerly (no start())');
      if (ctx.signal.aborted) {
        if (!ctx.global.json) ctx.err('stopping: interrupted before the worker started');
        return EXIT_CODES.ok;
      }
      await durable.start();
      const address = ht.config.durable.kind === 'temporal' ? ht.config.durable.address : '?';
      if (ctx.global.json) ctx.json({ address, taskQueue: durable.taskQueue ?? null, manifestId: ht.manifest.manifestId });
      else ctx.out(`Temporal worker polling ${durable.taskQueue ?? 'the task queue'} at ${address} (runtime manifest ${ht.manifest.manifestId}); press Ctrl-C to stop`);
      const stop = aborted(ctx.signal);
      await stop.promise;
      stop.dispose();
      if (!ctx.global.json) ctx.err('stopping the worker');
      return EXIT_CODES.ok;
    });
  },
};
