import type { Clock } from './clock.ts';
import type { IdGenerator } from './ids.ts';
import type { Logger } from './logger.ts';
import type { SqlDatabase } from './sql.ts';

/** Common dependency bag injected into services. */
export interface BaseDeps {
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
}

export interface SqlDeps extends BaseDeps {
  db: SqlDatabase;
}
