import type { Command } from './command.ts';

const GLOBAL_HELP: Array<[string, string]> = [
  ['-c, --config <file>', 'configuration file (default: hypertest.config.yaml in the current directory or a parent; $HYPERTEST_CONFIG)'],
  ['--scripted-brains <module>', 'ES module exporting `brains` (provider id → scripted brain) for scripted providers'],
  ['--log-level <level>', 'debug | info | warn | error, JSON lines on stderr (default warn; serve/worker: the configuration\'s; $HYPERTEST_LOG_LEVEL)'],
  ['--json', 'machine-readable output on stdout'],
  ['-h, --help', 'help for a command'],
];

function options(rows: Array<[string, string]>): string[] {
  const width = Math.max(...rows.map(([f]) => f.length));
  return rows.map(([f, text]) => `  ${f.padEnd(width)}  ${text}`);
}

export function generalHelp(commands: readonly Command[], version: string): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  return [
    `hypertest ${version} — evidence-driven, multi-model, durable autonomous testing agent`,
    '',
    'usage: hypertest <command> [options]',
    '',
    'commands:',
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    `  ${'help'.padEnd(width)}  help [<command>]`,
    `  ${'version'.padEnd(width)}  print the version`,
    '',
    'global options:',
    ...options(GLOBAL_HELP),
    '',
    'exit codes: 0 ok, 1 failure, 2 usage error; `run`: pass 0, fail 3, conditional 4, inconclusive 5; 130 interrupted',
    'run `hypertest <command> --help` for the options of a command',
  ].join('\n');
}

export function commandHelp(command: Command): string {
  const lines = ['usage:', ...command.usage.map((u) => `  hypertest ${u}`), '', command.summary];
  if (command.optionHelp && command.optionHelp.length > 0) lines.push('', 'options:', ...options(command.optionHelp));
  lines.push('', 'global options:', ...options(GLOBAL_HELP));
  for (const n of command.notes ?? []) lines.push('', n);
  return lines.join('\n');
}
