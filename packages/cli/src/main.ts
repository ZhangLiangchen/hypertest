import { isHypertestError } from '@hypertest/core';
import { HYPERTEST_VERSION } from '@hypertest/app';
import { UsageError, parseCommand, splitCommand } from './args.ts';
import type { Command } from './command.ts';
import { ALL_COMMANDS } from './commands/index.ts';
import { resolveIo, writer, type CommandContext } from './context.ts';
import type { CliIo } from './contracts.ts';
import { EXIT_CODES } from './exit-codes.ts';
import { commandHelp, generalHelp } from './help.ts';

/** Every command, in help order. */
export const COMMANDS: readonly Command[] = ALL_COMMANDS;
const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** Aborts on the first SIGINT/SIGTERM and then restores the default handlers (a second signal terminates). */
function processSignal(): { signal: AbortSignal; dispose(): void } {
  const ctrl = new AbortController();
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const dispose = () => {
    for (const s of signals) process.off(s, onSignal);
  };
  function onSignal(s: NodeJS.Signals): void {
    dispose();
    ctrl.abort(new Error(`received ${s}`));
  }
  for (const s of signals) process.on(s, onSignal);
  return { signal: ctrl.signal, dispose };
}

function closestCommand(name: string): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const c of [...COMMANDS.map((x) => x.name), 'help', 'version']) {
    const d = distance(name, c);
    if (d <= 2 && (!best || d < best.d)) best = { name: c, d };
  }
  return best?.name;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length]![b.length]!;
}

/**
 * The `hypertest` command line. Returns the exit code (never calls process.exit): 0 ok, 1 failure, 2 usage error,
 * `run`: pass 0 / fail 3 / conditional 4 / inconclusive 5, 130 interrupted (see EXIT_CODES).
 */
export async function main(argv: string[], ioInput: Partial<CliIo> = {}): Promise<number> {
  const io = resolveIo(ioInput);
  const out = writer(io.stdout);
  const err = writer(io.stderr);
  const { command: name, rest } = splitCommand(argv);

  if (name === undefined) {
    if (rest.includes('--version') || rest.includes('-v')) {
      out(HYPERTEST_VERSION);
      return EXIT_CODES.ok;
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      out(generalHelp(COMMANDS, HYPERTEST_VERSION));
      return EXIT_CODES.ok;
    }
    err(rest.length === 0 ? generalHelp(COMMANDS, HYPERTEST_VERSION) : `hypertest: missing command (got ${rest.join(' ')}); run \`hypertest --help\``);
    return EXIT_CODES.usage;
  }
  if (name === 'version') {
    out(HYPERTEST_VERSION);
    return EXIT_CODES.ok;
  }
  if (name === 'help') {
    const topic = rest.find((a) => !a.startsWith('-'));
    if (topic === undefined) {
      out(generalHelp(COMMANDS, HYPERTEST_VERSION));
      return EXIT_CODES.ok;
    }
    const c = BY_NAME.get(topic);
    if (!c) {
      err(`hypertest help: unknown command ${JSON.stringify(topic)}`);
      return EXIT_CODES.usage;
    }
    out(commandHelp(c));
    return EXIT_CODES.ok;
  }
  const command = BY_NAME.get(name);
  if (!command) {
    const hint = closestCommand(name);
    err(`hypertest: unknown command ${JSON.stringify(name)}${hint ? ` (did you mean \`${hint}\`?)` : ''}; run \`hypertest --help\``);
    return EXIT_CODES.usage;
  }

  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(name, rest, command.options);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`hypertest ${name}: ${e.message}`);
      err(`run \`hypertest ${name} --help\` for usage`);
      return EXIT_CODES.usage;
    }
    throw e;
  }
  if (parsed.global.help) {
    out(commandHelp(command));
    return EXIT_CODES.ok;
  }

  const longRunning = typeof command.longRunning === 'function' ? command.longRunning(parsed.values) : command.longRunning === true;
  const fromProcess = ioInput.signal === undefined && longRunning ? processSignal() : undefined;
  const signal = ioInput.signal ?? fromProcess?.signal ?? new AbortController().signal;
  const ctx: CommandContext = {
    command: name,
    io,
    global: parsed.global,
    signal,
    out,
    err,
    json: (value) => out(JSON.stringify(value, null, 2)),
  };
  try {
    return await command.run(ctx, parsed.values, parsed.positionals);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`hypertest ${name}: ${e.message}`);
      err(`run \`hypertest ${name} --help\` for usage`);
      return EXIT_CODES.usage;
    }
    const code = isHypertestError(e) ? e.code : 'internal';
    const message = e instanceof Error ? e.message : String(e);
    if (ctx.global.json) ctx.json({ error: { code, message } });
    err(`hypertest ${name}: ${message}${isHypertestError(e) ? ` [${e.code}]` : ''}`);
    if (ctx.global.logLevel === 'debug' && e instanceof Error && e.stack) err(e.stack);
    return EXIT_CODES.failure;
  } finally {
    fromProcess?.dispose();
  }
}
