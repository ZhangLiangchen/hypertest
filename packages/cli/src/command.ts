import type { ParseArgsOptionsConfig } from 'node:util';
import type { OptionValues } from './args.ts';
import type { CommandContext } from './context.ts';

/** One `hypertest` command. */
export interface Command {
  /** Command word (`evidence`, `oracle` and `eval` take a sub-command as their first positional). */
  name: string;
  summary: string;
  /** Usage lines (without the leading `hypertest `). */
  usage: string[];
  /** Option descriptions for `--help` (flag → text). */
  optionHelp?: Array<[string, string]>;
  /** Extra help paragraphs. */
  notes?: string[];
  options: ParseArgsOptionsConfig;
  /**
   * Long-running: SIGINT/SIGTERM abort `ctx.signal` while the command runs (the default signal of the other commands
   * never aborts — they finish on their own).
   */
  longRunning?: boolean | ((values: OptionValues) => boolean);
  run(ctx: CommandContext, values: OptionValues, positionals: string[]): Promise<number>;
}
