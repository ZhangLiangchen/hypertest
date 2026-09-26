import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import type { LogLevel } from '@hypertest/core';

/** A malformed command line (exit code 2). */
export class UsageError extends Error {
  readonly command: string | undefined;
  constructor(message: string, command?: string) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

export type OptionValues = Record<string, string | boolean | string[] | undefined>;

/** Options every command accepts. */
export const GLOBAL_OPTIONS = {
  config: { type: 'string', short: 'c' },
  'scripted-brains': { type: 'string' },
  'log-level': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

export interface GlobalOptions {
  config?: string;
  scriptedBrains?: string;
  logLevel?: LogLevel;
  json: boolean;
  help: boolean;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v);
}

/**
 * Strict parse of one command's arguments (global options included). Unknown options, missing values and
 * type mismatches are usage errors.
 */
export function parseCommand(command: string, args: string[], options: ParseArgsOptionsConfig): { values: OptionValues; positionals: string[]; global: GlobalOptions } {
  let parsed: { values: OptionValues; positionals: string[] };
  try {
    parsed = parseArgs({ args, options: { ...GLOBAL_OPTIONS, ...options }, strict: true, allowPositionals: true, allowNegative: true }) as { values: OptionValues; positionals: string[] };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) throw new UsageError((e as Error).message, command);
    throw e;
  }
  const v = parsed.values;
  const logLevel = v['log-level'];
  if (logLevel !== undefined && !isLogLevel(logLevel)) throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join(', ')} (got ${JSON.stringify(logLevel)})`, command);
  const global: GlobalOptions = { json: v['json'] === true, help: v['help'] === true };
  if (typeof v['config'] === 'string') global.config = v['config'];
  if (typeof v['scripted-brains'] === 'string') global.scriptedBrains = v['scripted-brains'];
  if (isLogLevel(logLevel)) global.logLevel = logLevel;
  return { values: v, positionals: parsed.positionals, global };
}

/**
 * Splits argv into the command path and the remaining arguments. Global options may precede the command
 * (`hypertest --config f run …`); their values are skipped when looking for the command token.
 */
export function splitCommand(argv: string[]): { command: string | undefined; rest: string[] } {
  const valued = new Set<string>();
  for (const [name, spec] of Object.entries(GLOBAL_OPTIONS)) {
    if (spec.type === 'string') {
      valued.add(`--${name}`);
      if ('short' in spec && spec.short) valued.add(`-${spec.short}`);
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') return { command: undefined, rest: argv };
    if (a.startsWith('-')) {
      if (valued.has(a)) i++; // `--config file`
      continue;
    }
    return { command: a, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { command: undefined, rest: argv };
}

export function str(values: OptionValues, name: string): string | undefined {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
}

export function flag(values: OptionValues, name: string): boolean {
  return values[name] === true;
}

export function list(values: OptionValues, name: string): string[] {
  const v = values[name];
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return raw.flatMap((x) => x.split(',')).map((x) => x.trim()).filter((x) => x !== '');
}

/** An integer option within [min, max] (usage error otherwise). */
export function int(command: string, values: OptionValues, name: string, bounds: { min: number; max?: number }): number | undefined {
  const v = str(values, name);
  if (v === undefined) return undefined;
  const n = /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(n) || n < bounds.min || n > max) {
    throw new UsageError(`--${name} must be an integer${bounds.max !== undefined ? ` between ${bounds.min} and ${bounds.max}` : ` ≥ ${bounds.min}`} (got ${JSON.stringify(v)})`, command);
  }
  return n;
}

/** Exactly `count` positionals (usage error naming them otherwise). */
export function positionals(command: string, given: string[], names: string[], optional: string[] = []): string[] {
  if (given.length < names.length) throw new UsageError(`missing ${names.slice(given.length).map((n) => `<${n}>`).join(' ')}`, command);
  if (given.length > names.length + optional.length) {
    throw new UsageError(`unexpected argument${given.length - names.length - optional.length > 1 ? 's' : ''}: ${given.slice(names.length + optional.length).join(' ')}`, command);
  }
  return given;
}

/** A required string option (usage error when absent or blank). */
export function required(command: string, values: OptionValues, name: string): string {
  const v = str(values, name);
  if (v === undefined || v.trim() === '') throw new UsageError(`--${name} is required`, command);
  return v;
}
