export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON-lines logger writing to a stream (stderr by default). */
export function jsonLogger(options: { level?: LogLevel; stream?: NodeJS.WritableStream; fields?: Record<string, unknown> } = {}): Logger {
  const level = options.level ?? 'info';
  const stream = options.stream ?? process.stderr;
  const base = options.fields ?? {};
  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    stream.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields }) + '\n');
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (f) => jsonLogger({ level, stream, fields: { ...base, ...f } }),
  };
}

/** In-memory logger for assertions in tests. */
export class MemoryLogger implements Logger {
  readonly entries: Array<{ level: LogLevel; msg: string; fields: Record<string, unknown> }>;
  readonly #base: Record<string, unknown>;
  constructor(entries: Array<{ level: LogLevel; msg: string; fields: Record<string, unknown> }> = [], base: Record<string, unknown> = {}) {
    this.entries = entries;
    this.#base = base;
  }
  #push(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    this.entries.push({ level, msg, fields: { ...this.#base, ...fields } });
  }
  debug(msg: string, fields?: Record<string, unknown>) { this.#push('debug', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>) { this.#push('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>) { this.#push('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>) { this.#push('error', msg, fields); }
  child(fields: Record<string, unknown>): Logger {
    return new MemoryLogger(this.entries, { ...this.#base, ...fields });
  }
}
