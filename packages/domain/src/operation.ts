/** Resource claim modes for experiment isolation. */
export type ResourceMode = 'read_shared' | 'write_exclusive' | 'fault_exclusive';

/** Hierarchical resource key, e.g. `cluster/prod-test/ns/run-123`, `service/payment`, `loadgen/frigate-01`. */
export interface ResourceClaim {
  resourceKey: string;
  mode: ResourceMode;
  quantity?: number;
}

export interface ResourceRef {
  resourceKey: string;
  kind: string;
  externalId?: string;
}

export interface ResourceLease {
  leaseId: string;
  resourceKey: string;
  owner: string;
  /** Monotonically increasing per resourceKey; side-effect targets accept only token ≥ current. */
  fencingToken: number;
  expiresAt: string;
  acquiredAt: string;
}

export type OperationStatus =
  | 'prepared'
  | 'dispatching'
  | 'acknowledged'
  | 'verified'
  | 'not_applied'
  | 'outcome_unknown'
  | 'reconciling'
  | 'compensating'
  | 'compensated'
  | 'manual_review'
  | 'failed';

export interface OperationRecord {
  operationId: string;
  runId: string;
  workItemId: string;
  agentId?: string;
  toolInvocationId?: string;
  operationType: string;
  adapterId: string;
  target: ResourceRef;
  desiredStateHash: string;
  inputHash: string;
  /** Equals operationId unless the target imposes its own key format. */
  idempotencyKey: string;
  lease?: { leaseId: string; resourceKey: string; fencingToken: number };
  status: OperationStatus;
  externalJobId?: string;
  externalReceipt?: string;
  attempt: number;
  result?: unknown;
  lastError?: string;
  evidenceRefs: string[];
  /** Stable once created: Temporal retries, worker crashes and agent resumes reuse the same record. */
  createdAt: string;
  updatedAt: string;
}

const OP_TRANSITIONS: Record<OperationStatus, readonly OperationStatus[]> = {
  // prepared → not_applied: never dispatched (e.g. refused because another owner holds the resource lease)
  prepared: ['dispatching', 'not_applied', 'failed'],
  dispatching: ['acknowledged', 'outcome_unknown', 'not_applied', 'failed'],
  acknowledged: ['verified', 'outcome_unknown', 'failed'],
  outcome_unknown: ['reconciling'],
  reconciling: ['verified', 'not_applied', 'manual_review', 'acknowledged'],
  not_applied: ['dispatching', 'failed'],
  verified: ['compensating'],
  compensating: ['compensated', 'manual_review'],
  compensated: [],
  // (additive, stubs[8]) a human's manual review may also record that the effect was undone (compensated)
  manual_review: ['verified', 'not_applied', 'failed', 'compensated'],
  failed: [],
};

export function canTransitionOperation(from: OperationStatus, to: OperationStatus): boolean {
  return OP_TRANSITIONS[from].includes(to);
}
export function isTerminalOperation(s: OperationStatus): boolean {
  return s === 'verified' || s === 'compensated' || s === 'failed' || s === 'not_applied' || s === 'manual_review';
}

/** Two claims conflict if their keys overlap (equal or ancestor/descendant) and either is exclusive. */
export function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  const overlap = a.resourceKey === b.resourceKey || a.resourceKey.startsWith(b.resourceKey + '/') || b.resourceKey.startsWith(a.resourceKey + '/');
  if (!overlap) return false;
  return !(a.mode === 'read_shared' && b.mode === 'read_shared');
}
