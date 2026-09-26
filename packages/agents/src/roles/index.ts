import { deepFreeze } from '@hypertest/core';
import type { RoleDefinition } from '../contracts.ts';
import { ARCHITECTURE_ANALYST_ROLE, CODE_CHANGE_ANALYST_ROLE, HISTORICAL_BUG_ANALYST_ROLE } from './analysts.ts';
import { CONDENSER_ROLE } from './condenser.ts';
import { ENVIRONMENT_ROLE } from './environment.ts';
import { EXECUTOR_ROLE } from './executor.ts';
import { FIXER_ROLE } from './fixer.ts';
import { LEAD_ROLE } from './lead.ts';
import { METRICS_ANALYST_ROLE } from './metrics-analyst.ts';
import { RCA_ROLE } from './rca.ts';
import { REVIEWER_ROLE } from './reviewer.ts';
import { TEST_DESIGNER_ROLE } from './test-designer.ts';
import { VISION_GUI_ROLE } from './vision-gui.ts';
import { LOCAL_PRIVATE_ROLE } from './local-private.ts';

export { ANALYSIS_OUTPUT_SCHEMA } from './analysts.ts';
export { CONDENSE_OUTPUT_SCHEMA } from './condenser.ts';
export { ENVIRONMENT_OUTPUT_SCHEMA } from './environment.ts';
export { EXECUTION_OUTPUT_SCHEMA } from './executor.ts';
export { FIX_OUTPUT_SCHEMA } from './fixer.ts';
export { LEAD_OUTPUT_SCHEMA } from './lead.ts';
export { METRICS_OUTPUT_SCHEMA } from './metrics-analyst.ts';
export { RCA_OUTPUT_SCHEMA } from './rca.ts';
export { EVIDENCE_PRODUCER_ROLES, REVIEW_OUTPUT_SCHEMA } from './reviewer.ts';
export { TEST_DESIGN_OUTPUT_SCHEMA } from './test-designer.ts';
export { GUI_CHECK_METHODS, GUI_OUTPUT_SCHEMA } from './vision-gui.ts';
export { PRIVATE_OUTPUT_SCHEMA } from './local-private.ts';

/**
 * (additive) Built-in roles that only a special route can serve: `vision_gui` needs a route with the `vision` capability,
 * `local_private` a route accepting restricted data (`maxDataClassification: restricted`, i.e. a local model). Nothing
 * plans them unless the lead does; `hypertest doctor` reports their route coverage separately from the core roles.
 */
export const SPECIALIST_ROLES: readonly string[] = Object.freeze(['vision_gui', 'local_private']);

/**
 * The built-in role catalog (deep-frozen: roles are shared policy data; derive variants through
 * RoleCatalog overrides, never by mutation).
 */
export const BUILTIN_ROLES: RoleDefinition[] = deepFreeze([
  LEAD_ROLE,
  CODE_CHANGE_ANALYST_ROLE,
  ARCHITECTURE_ANALYST_ROLE,
  HISTORICAL_BUG_ANALYST_ROLE,
  TEST_DESIGNER_ROLE,
  EXECUTOR_ROLE,
  RCA_ROLE,
  FIXER_ROLE,
  REVIEWER_ROLE,
  METRICS_ANALYST_ROLE,
  ENVIRONMENT_ROLE,
  CONDENSER_ROLE,
  VISION_GUI_ROLE,
  LOCAL_PRIVATE_ROLE,
]);
