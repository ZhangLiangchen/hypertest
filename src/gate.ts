import type { ArtifactRef, Json } from "./contracts.js";

export type GateAction =
  | "enter_implementation"
  | "apply_patch"
  | "publish_change";

export type GateVerdict = "allow" | "deny" | "needs_human";

export interface GateRequest {
  readonly schema: "hypertest.gate-request/v1";
  readonly runId: string;
  readonly action: GateAction;
  readonly sourceRevision: string;
  readonly evidence: readonly ArtifactRef[];
  readonly context?: Json;
}

export interface GateDecision {
  readonly schema: "hypertest.gate-decision/v1";
  readonly verdict: GateVerdict;
  readonly receiptId: string;
  readonly reasonCodes: readonly string[];
  readonly obligations: readonly string[];
  readonly evidenceHashes: readonly string[];
  readonly expiresAtEpochMs?: number;
}

export interface QualityGate {
  decide(request: GateRequest): Promise<GateDecision>;
}

export function assertUsableGateDecision(
  decision: GateDecision,
  nowEpochMs: number,
): void {
  if (decision.verdict !== "allow") {
    throw new Error(`BUGate did not authorize the action: ${decision.verdict}`);
  }
  if (
    decision.expiresAtEpochMs !== undefined &&
    decision.expiresAtEpochMs <= nowEpochMs
  ) {
    throw new Error("BUGate authorization receipt has expired");
  }
  if (decision.receiptId.length === 0) {
    throw new Error("BUGate authorization receipt is missing an id");
  }
}
