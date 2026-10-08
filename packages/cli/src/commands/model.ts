import { HypertestError } from '@hypertest/core';
import { modelPricesFile, readPricesFile, updatePricesFile } from '@hypertest/app';
import { UsageError, positionals, required, str } from '../args.ts';
import type { Command } from '../command.ts';
import { loadCliConfig, withInstance, type CommandContext } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import { table } from '../format.ts';

function price(command: string, values: Parameters<Command['run']>[1], name: string): number {
  const raw = required(command, values, name);
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new UsageError(`--${name} must be a number ≥ 0 (USD per million tokens), got ${JSON.stringify(raw)}`, command);
  return v;
}

/** `model prices set|clear|list`: the observed-prices file (re-read by a running Hypertest at its next turn boundary). */
async function prices(ctx: CommandContext, values: Parameters<Command['run']>[1], args: string[]): Promise<number> {
  const action = args[1];
  const { config } = await loadCliConfig(ctx);
  const file = modelPricesFile(config);
  if (action === 'list') {
    positionals('model', args, ['prices', 'list']);
    const doc = await readPricesFile(file);
    if (ctx.global.json) ctx.json({ file, ...doc });
    else {
      const rows = Object.entries(doc.prices).map(([routeId, p]) => {
        const route = config.models.routes.find((r) => r.routeId === routeId);
        const catalog = route?.costPerMillionInputUsd !== undefined ? `$${route.costPerMillionInputUsd}/$${route.costPerMillionOutputUsd}` : 'unknown';
        return [routeId, `$${p.inputPerMillionUsd}/$${p.outputPerMillionUsd}`, catalog, p.source ?? '', p.observedAt ?? ''];
      });
      if (rows.length === 0) ctx.out(`no observed prices (${file})`);
      else for (const l of table(['ROUTE', 'OBSERVED IN/OUT', 'CATALOG IN/OUT', 'SOURCE', 'OBSERVED AT'], rows)) ctx.out(l);
    }
    return EXIT_CODES.ok;
  }
  if (action !== 'set' && action !== 'clear') throw new UsageError(`unknown sub-command model prices ${action ?? ''} (set | clear | list)`, 'model');
  const [, , routeId] = positionals('model', args, ['prices', action, 'routeId']);
  if (!config.models.routes.some((r) => r.routeId === routeId)) {
    throw new HypertestError('invalid_argument', `route ${routeId} is not configured (${config.models.routes.map((r) => r.routeId).join(', ') || 'no routes'})`);
  }
  const observed =
    action === 'set'
      ? { inputPerMillionUsd: price('model', values, 'input'), outputPerMillionUsd: price('model', values, 'output'), observedAt: new Date().toISOString(), source: str(values, 'source') ?? 'operator' }
      : undefined;
  const doc = await updatePricesFile(file, routeId!, observed);
  if (ctx.global.json) ctx.json({ file, routeId, price: observed ?? null, prices: doc.prices });
  else {
    ctx.out(observed ? `observed price of ${routeId}: $${observed.inputPerMillionUsd}/$${observed.outputPerMillionUsd} per million tokens in/out` : `observed price of ${routeId} cleared`);
    ctx.err(`wrote ${file}; a running Hypertest applies it at the next turn boundary (models.priceGuard decides whether the route's circuit opens)`);
  }
  return EXIT_CODES.ok;
}

export const modelCommand: Command = {
  name: 'model',
  summary: 'model operations: switch a run\'s agents to another route; record observed route prices for the price guard',
  usage: [
    'model switch <runId> <role|agentId> <routeId> --by <name> [--reason <text>] [--json]',
    'model prices set <routeId> --input <usd> --output <usd> [--source <text>] [--json]',
    'model prices clear <routeId> [--json]',
    'model prices list [--json]',
  ],
  optionHelp: [
    ['--by <name>', 'switch: the human requesting the switch (recorded on L0)'],
    ['--reason <text>', 'switch: why (recorded with the request)'],
    ['--input <usd>', 'prices set: observed USD per million input tokens'],
    ['--output <usd>', 'prices set: observed USD per million output tokens'],
    ['--source <text>', 'prices set: where the price comes from (default operator)'],
  ],
  notes: [
    'model switch: the target agents (the agent, or every agent of the role, including ones created later) switch at their NEXT safe turn boundary, after the permission/profile re-check (switchReason manual); a switch the re-check refuses records no epoch (model.switch_refused). With the embedded PGlite store, run it while no other process drives the run, or use the API (POST /runs/:id/model-switch).',
    'model prices: the file (models.pricesFile, default <dataDir>/state/model-prices.json) is re-read by a running Hypertest at every turn boundary; an observed price beyond models.priceGuard.maxIncreasePct over the catalog price opens the route\'s circuit (model.circuit_opened, reason price_change).',
  ],
  options: { by: { type: 'string' }, reason: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' }, source: { type: 'string' } },
  async run(ctx, values, args) {
    if (args[0] === 'prices') return prices(ctx, values, args);
    if (args[0] !== 'switch') throw new UsageError(args[0] === undefined ? 'missing sub-command (model switch | model prices)' : `unknown sub-command model ${args[0]}`, 'model');
    const [, runId, target, routeId] = positionals('model', args, ['switch', 'runId', 'role|agentId', 'routeId']);
    const by = required('model', values, 'by');
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      const sw = await ht.requestModelSwitch(runId!, target!, routeId!, { kind: 'human', id: by }, str(values, 'reason'));
      if (ctx.global.json) ctx.json({ switch: sw });
      else ctx.out(`switch ${sw.switchId}: ${sw.target.kind === 'agent' ? `agent ${sw.target.agentId}` : `role ${sw.target.role}`} → route ${sw.routeId} at the next safe turn boundary`);
      return EXIT_CODES.ok;
    });
  },
};
