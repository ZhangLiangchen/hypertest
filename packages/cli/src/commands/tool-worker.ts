import { HypertestError } from '@hypertest/core';
import { startToolWorker } from '@hypertest/app';
import { UsageError, list, positionals, str } from '../args.ts';
import type { Command } from '../command.ts';
import { aborted, cliLogger, loadCliConfig, logLevelOf } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';

/** Variable read for the shared secret when --secret-env is not given (secrets are never accepted on the command line). */
export const DEFAULT_TOOL_WORKER_SECRET_ENV = 'HYPERTEST_TOOL_WORKER_SECRET';

/**
 * (row 246) `hypertest tool-worker`: a remote tool worker. It executes the named black-box tools (no side-effect binding)
 * of the configuration for the deployment that lists it under `tools.remoteWorkers` (same shared secret) — capability,
 * permit, ledger and evidence stay with that deployment; operation ids are preserved.
 */
export const toolWorkerCommand: Command = {
  name: 'tool-worker',
  summary: 'execute delegated black-box tools for a Hypertest deployment (remote tool worker) until interrupted',
  usage: ['tool-worker --tools <id,id> [--id <workerId>] [--listen <host:port>] [--secret-env <VAR>] [--config <file>]'],
  optionHelp: [
    ['--tools <list>', 'tool ids to execute (black-box tools without a side-effect binding: http.request, grpc.call, metrics.query, …)'],
    ['--id <workerId>', 'worker id (default: tool-worker)'],
    ['--listen <host:port>', 'listen address (default 127.0.0.1:7431; port 0 = any free port)'],
    ['--secret-env <VAR>', `environment variable holding the shared secret (default ${DEFAULT_TOOL_WORKER_SECRET_ENV}; ≥ 16 characters)`],
  ],
  notes: ['The caller lists this worker under tools.remoteWorkers with the same secret (by variable name). The worker keeps no ledger: the caller records the evidence it returns.'],
  options: { tools: { type: 'string' }, id: { type: 'string' }, listen: { type: 'string' }, 'secret-env': { type: 'string' } },
  longRunning: true,
  async run(ctx, values, args) {
    positionals('tool-worker', args, []);
    const tools = list(values, 'tools');
    if (tools.length === 0) throw new UsageError('--tools is required (comma-separated tool ids)', 'tool-worker');
    const workerId = str(values, 'id') ?? 'tool-worker';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(workerId)) throw new UsageError(`--id must match [A-Za-z0-9][A-Za-z0-9_-]{0,31} (got ${JSON.stringify(workerId)})`, 'tool-worker');
    const listen = str(values, 'listen') ?? '127.0.0.1:7431';
    const m = /^(.+):(\d{1,5})$/.exec(listen);
    if (!m) throw new UsageError(`--listen must be host:port (got ${JSON.stringify(listen)})`, 'tool-worker');
    const port = Number(m[2]);
    if (port > 65535) throw new UsageError('--listen port must be ≤ 65535', 'tool-worker');
    const secretEnv = str(values, 'secret-env') ?? DEFAULT_TOOL_WORKER_SECRET_ENV;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretEnv)) throw new UsageError(`--secret-env must name an environment variable (got ${JSON.stringify(secretEnv)})`, 'tool-worker');
    const { config } = await loadCliConfig(ctx);
    const logger = cliLogger(ctx, logLevelOf(ctx, config.observability?.logLevel ?? 'info'));
    if (ctx.signal.aborted) return EXIT_CODES.ok;
    const worker = await startToolWorker(config, { workerId, tools, secretEnv, host: m[1]!.replace(/^\[|\]$/g, ''), port, env: ctx.io.env, logger }).catch((e: unknown) => {
      throw e instanceof HypertestError ? e : new HypertestError('unavailable', `the tool worker could not start: ${(e as Error).message}`);
    });
    try {
      if (ctx.global.json) ctx.io.stdout.write(`${JSON.stringify({ url: worker.url, workerId: worker.workerId, tools: worker.tools })}\n`);
      else ctx.out(`remote tool worker ${worker.workerId} listening on ${worker.url} (tools: ${worker.tools.join(', ')}); press Ctrl-C to stop`);
      const stop = aborted(ctx.signal);
      await stop.promise;
      stop.dispose();
      if (!ctx.global.json) ctx.err('stopping the tool worker');
    } finally {
      await worker.close();
    }
    return EXIT_CODES.ok;
  },
};
