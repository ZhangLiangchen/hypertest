import type { Migration } from '@hypertest/core';

export * from './contracts.ts';
export { NON_RETRYABLE_ERROR_CODES, isRetryableFault } from './errors.ts';
export {
  LocalDurableRuntime, RESUMABLE_RUN_STATUSES, OBSERVE_BACKOFF_MIN_MS, OBSERVE_BACKOFF_MAX_MS, DEFAULT_MAX_IDLE_MS, DEFAULT_MAX_ATTEMPTS, ZERO_IDLE_STREAK,
} from './local.ts';
export {
  createTemporalActivities, toApplicationFailure, ACTIVITY_NON_RETRYABLE_ERROR_TYPES, ACTIVITY_HEARTBEAT_INTERVAL_MS,
  type TemporalActivities, type ExecuteTurnActivityInput, type ClaimAfterResumeInput,
} from './temporal/activities.ts';
export {
  TemporalDurableRuntime, createTemporalWorker, bundleTemporalWorkflows, DEFAULT_TEMPORAL_NAMESPACE, DEFAULT_TEMPORAL_TASK_QUEUE, TEMPORAL_WORKFLOWS_PATH,
} from './temporal/runtime.ts';
export {
  runWorkflowId, workItemWorkflowId, DEFAULT_MAX_WORKFLOW_ITERATIONS, DEFAULT_WORKFLOW_MAX_IDLE_MS,
  type TestRunWorkflowState, type WorkItemWorkflowInput, type WorkItemWorkflowResult, type WakePayload,
} from './temporal/workflows.ts';

/**
 * The durable runtime owns no tables: run/work lifecycle truth is the control plane's (ht_runs, work items, leases)
 * and, on Temporal, the workflow history. Exported for uniformity with the other packages' migration lists.
 */
export const durableMigrations: Migration[] = [];
