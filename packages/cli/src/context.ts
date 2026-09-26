import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HypertestError, jsonLogger, type LogLevel, type Logger } from '@hypertest/core';
import { createHypertest, loadConfig, type HypertestConfig, type HypertestInstance, type HypertestOverrides } from '@hypertest/app';
import { UsageError, type GlobalOptions } from './args.ts';
import type { CliIo, CliOutput, EvalModuleLike, ScriptedBrainMap, ScriptedBrainsContext, ScriptedBrainsModule } from './contracts.ts';

/** Configuration file names looked up (in this order) in the working directory and its ancestors. */
export const CONFIG_FILE_NAMES: readonly string[] = Object.freeze(['hypertest.config.yaml', 'hypertest.config.yml', 'hypertest.config.json']);
/** Environment variable naming the configuration file (below `--config`, above the directory lookup). */
export const CONFIG_ENV = 'HYPERTEST_CONFIG';
/** Environment variable setting the log level (below `--log-level`). */
export const LOG_LEVEL_ENV = 'HYPERTEST_LOG_LEVEL';

export interface ResolvedIo extends Omit<CliIo, 'signal' | 'loadEval'> {
  loadEval: () => Promise<EvalModuleLike>;
}

export function resolveIo(io: Partial<CliIo> = {}): ResolvedIo {
  return {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env,
    cwd: io.cwd ? resolve(io.cwd) : process.cwd(),
    loadEval: io.loadEval ?? (async () => (await import('@hypertest/eval')) as unknown as EvalModuleLike),
  };
}

/** Everything a command runs with. */
export interface CommandContext {
  command: string;
  io: ResolvedIo;
  global: GlobalOptions;
  /** Aborted by SIGINT/SIGTERM (long-running commands) or `io.signal`. */
  signal: AbortSignal;
  out(line?: string): void;
  err(line?: string): void;
  /** Writes one JSON document (pretty) to stdout. */
  json(value: unknown): void;
}

export function writer(stream: CliOutput): (line?: string) => void {
  return (line = '') => {
    stream.write(line.endsWith('\n') ? line : `${line}\n`);
  };
}

/**
 * The configuration file: `--config` (relative to cwd), else `$HYPERTEST_CONFIG`, else the nearest
 * hypertest.config.{yaml,yml,json} in cwd or an ancestor directory. Undefined when none exists (an explicit
 * path is returned even when missing: loadConfig reports it).
 */
export function findConfig(io: Pick<ResolvedIo, 'cwd' | 'env'>, explicit?: string): string | undefined {
  if (explicit !== undefined) return resolve(io.cwd, explicit);
  const fromEnv = io.env[CONFIG_ENV];
  if (fromEnv) return resolve(io.cwd, fromEnv);
  let dir = io.cwd;
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const p = join(dir, name);
      if (existsSync(p) && statSync(p).isFile()) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Loads the configuration (interpolated with io.env) or fails with guidance when there is none. */
export async function loadCliConfig(ctx: Pick<CommandContext, 'io' | 'global'>): Promise<{ config: HypertestConfig; path: string }> {
  const path = findConfig(ctx.io, ctx.global.config);
  if (!path) {
    throw new HypertestError('not_found', `no ${CONFIG_FILE_NAMES[0]} found in ${ctx.io.cwd} or its parent directories; run \`hypertest init\` or pass --config <file>`);
  }
  return { config: await loadConfig(path, { env: ctx.io.env }), path };
}

/**
 * The log level: `--log-level`, else $HYPERTEST_LOG_LEVEL, else `fallback` (short commands default to `warn` so
 * human output stays readable; `serve`/`worker` use the configuration's level).
 */
export function logLevelOf(ctx: Pick<CommandContext, 'io' | 'global'>, fallback: LogLevel): LogLevel {
  if (ctx.global.logLevel) return ctx.global.logLevel;
  const fromEnv = ctx.io.env[LOG_LEVEL_ENV];
  if (fromEnv === 'debug' || fromEnv === 'info' || fromEnv === 'warn' || fromEnv === 'error') return fromEnv;
  return fallback;
}

/** JSON-lines logger on the CLI's stderr (stdout stays reserved for command output). */
export function cliLogger(ctx: Pick<CommandContext, 'io'>, level: LogLevel): Logger {
  return jsonLogger({ level, stream: ctx.io.stderr as unknown as NodeJS.WritableStream, fields: { component: 'hypertest' } });
}

/** Loads a `--scripted-brains` module (usage error when it cannot be loaded or has the wrong shape). */
export async function loadBrainsModule(ctx: Pick<CommandContext, 'io' | 'command'>, modulePath: string): Promise<ScriptedBrainsModule> {
  const file = resolve(ctx.io.cwd, modulePath);
  if (!existsSync(file)) throw new UsageError(`--scripted-brains: module ${file} does not exist`, ctx.command);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (e) {
    throw new UsageError(`--scripted-brains: module ${file} could not be loaded: ${(e as Error).message}`, ctx.command);
  }
  const out: ScriptedBrainsModule = {};
  const exported = mod['brains'] ?? mod['default'];
  if (exported !== undefined) {
    if (typeof exported !== 'function' && !isPlainObject(exported)) {
      throw new UsageError(`--scripted-brains: ${file} must export \`brains\` (or a default export) as a map of provider id → brain, or a factory returning one`, ctx.command);
    }
    out.brains = exported as NonNullable<ScriptedBrainsModule['brains']>;
  }
  if (mod['evalBrains'] !== undefined) {
    if (typeof mod['evalBrains'] !== 'function') throw new UsageError(`--scripted-brains: ${file}: \`evalBrains\` must be a function (task, fixture) => brains`, ctx.command);
    out.evalBrains = mod['evalBrains'] as NonNullable<ScriptedBrainsModule['evalBrains']>;
  }
  if (out.brains === undefined && out.evalBrains === undefined) {
    throw new UsageError(`--scripted-brains: ${file} exports neither \`brains\`, a default export nor \`evalBrains\``, ctx.command);
  }
  return out;
}

/** The brain map of a loaded module (a factory is called with the command's context); every entry must be a function. */
export async function brainMap(ctx: Pick<CommandContext, 'io' | 'command'>, mod: ScriptedBrainsModule, config: HypertestConfig, what: string): Promise<ScriptedBrainMap> {
  if (mod.brains === undefined) return {};
  const input: ScriptedBrainsContext = { command: ctx.command, config, env: ctx.io.env, cwd: ctx.io.cwd };
  const map: unknown = typeof mod.brains === 'function' ? await mod.brains(input) : mod.brains;
  if (!isPlainObject(map)) throw new UsageError(`--scripted-brains: ${what}: the brains factory must return a map of provider id → brain`, ctx.command);
  for (const [id, brain] of Object.entries(map)) {
    if (typeof brain !== 'function') throw new UsageError(`--scripted-brains: ${what}: brains.${id} is not a function`, ctx.command);
  }
  return map as ScriptedBrainMap;
}

/** A brain for read-only commands: a scripted provider is never invoked there, and if it were it answers `unavailable`. */
function inertBrain(providerId: string, command: string): ScriptedBrainMap[string] {
  return () => ({ error: 'unavailable', message: `scripted provider ${providerId} has no brain in \`hypertest ${command}\` (pass --scripted-brains)` });
}

/**
 * The configuration of a process that never executes an agent turn (it only starts, signals or reads runs): a Temporal
 * durable runtime connects as a client (`workerMode: external`). The Temporal runtime starts its embedded worker lazily
 * on the first startRun/signal/awaitCompletion, so without this a short-lived command (`approve`, `cancel`, `oracle
 * decide`, `run --detach`) would host a worker for a moment: it would poll the task queue, take activities of live runs
 * (with inert brains in the read/decide commands) and abandon them when it exits. The runtime manifest does not depend
 * on the durable configuration, so the pinning of runs (I11) is unaffected.
 */
export function clientOnlyConfig(config: HypertestConfig): HypertestConfig {
  if (config.durable.kind !== 'temporal' || config.durable.workerMode === 'external') return config;
  return { ...config, durable: { ...config.durable, workerMode: 'external' } };
}

export interface OpenOptions {
  /**
   * The command executes agent turns in this process (run, resume, serve, worker): every scripted provider needs a real
   * brain. Otherwise scripted providers get inert brains and the process never hosts a Temporal worker (clientOnlyConfig).
   */
  drivesAgents: boolean;
  /** Default log level when neither --log-level nor $HYPERTEST_LOG_LEVEL is given (default `warn`). */
  logLevel?: LogLevel | 'config';
  /** Adjusts the loaded configuration before composition (e.g. `worker` hosts the Temporal worker). */
  adjust?: (config: HypertestConfig) => HypertestConfig;
}

export interface OpenInstance {
  ht: HypertestInstance;
  config: HypertestConfig;
  configPath: string;
  logger: Logger;
}

/**
 * Loads the configuration and composes a Hypertest instance for one command. Scripted providers get their brains from
 * `--scripted-brains`; read-only commands get inert brains for the ones not given (composition requires one per
 * scripted provider, and a read-only command never invokes a model). The caller closes the instance.
 */
export async function openInstance(ctx: CommandContext, options: OpenOptions): Promise<OpenInstance> {
  const loaded = await loadCliConfig(ctx);
  const adjusted = options.adjust ? options.adjust(loaded.config) : loaded.config;
  const config = options.drivesAgents ? adjusted : clientOnlyConfig(adjusted);
  const brains: ScriptedBrainMap = {};
  if (ctx.global.scriptedBrains !== undefined) {
    const mod = await loadBrainsModule(ctx, ctx.global.scriptedBrains);
    Object.assign(brains, await brainMap(ctx, mod, config, ctx.global.scriptedBrains));
  }
  for (const p of config.models.providers) {
    if (p.kind !== 'scripted' || Object.hasOwn(brains, p.id)) continue;
    if (options.drivesAgents) {
      throw new UsageError(`model provider ${p.id} is scripted: pass --scripted-brains <module> exporting brains.${p.id}`, ctx.command);
    }
    brains[p.id] = inertBrain(p.id, ctx.command);
  }
  const level = options.logLevel === 'config' ? logLevelOf(ctx, config.observability?.logLevel ?? 'info') : logLevelOf(ctx, options.logLevel ?? 'warn');
  const logger = cliLogger(ctx, level);
  const overrides: HypertestOverrides = { env: ctx.io.env, logger };
  if (Object.keys(brains).length > 0) overrides.scriptedBrains = brains;
  const ht = await createHypertest(config, overrides);
  return { ht, config: ht.config, configPath: loaded.path, logger };
}

/** Opens an instance, runs `fn`, and always closes the instance. */
export async function withInstance<T>(ctx: CommandContext, options: OpenOptions, fn: (o: OpenInstance) => Promise<T>): Promise<T> {
  const o = await openInstance(ctx, options);
  try {
    return await fn(o);
  } finally {
    await o.ht.close();
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Resolves when `signal` aborts (never rejects); `dispose` detaches the listener. */
export function aborted(signal: AbortSignal): { promise: Promise<'aborted'>; dispose(): void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<'aborted'>((resolveAbort) => {
    if (signal.aborted) {
      resolveAbort('aborted');
      return;
    }
    listener = () => resolveAbort('aborted');
    signal.addEventListener('abort', listener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) signal.removeEventListener('abort', listener);
    },
  };
}

/** Sleeps `ms` unless `signal` aborts first (resolves either way; true when aborted). */
export function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolveSleep) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolveSleep(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
