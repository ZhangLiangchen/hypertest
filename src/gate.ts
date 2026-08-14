import { createHash, randomUUID } from "node:crypto";

import type { ArtifactRef, Json } from "./contracts.js";
import { runProcess } from "./process.js";

export type GateAction =
  | "enter_implementation"
  | "apply_patch"
  | "publish_change";

export type GateVerdict = "allow" | "deny" | "needs_human";

export interface GateRequest {
  readonly schema: "hypertest.gate-request/v1";
  readonly requestId: string;
  readonly runId: string;
  readonly action: GateAction;
  readonly sourceRevision: string;
  readonly evidence: readonly ArtifactRef[];
  readonly context?: Json;
}

export interface GateDecision {
  readonly schema: "hypertest.gate-decision/v1";
  readonly requestId: string;
  readonly requestHash: string;
  readonly verdict: GateVerdict;
  readonly receiptId: string;
  readonly reasonCodes: readonly string[];
  readonly obligations: readonly string[];
  readonly evidenceHashes: readonly string[];
  readonly expiresAtEpochMs?: number;
  readonly authority?: string;
}

export interface QualityGate {
  decide(request: GateRequest): Promise<GateDecision>;
}

export function createGateRequest(
  input: Omit<GateRequest, "schema" | "requestId"> & { readonly requestId?: string },
): GateRequest {
  return {
    schema: "hypertest.gate-request/v1",
    requestId: input.requestId ?? randomUUID(),
    runId: input.runId,
    action: input.action,
    sourceRevision: input.sourceRevision,
    evidence: input.evidence,
    ...(input.context === undefined ? {} : { context: input.context }),
  };
}

export function gateRequestHash(request: GateRequest): string {
  return createHash("sha256")
    .update(canonicalJson(request))
    .digest("hex");
}

export function assertUsableGateDecision(
  decision: GateDecision,
  request: GateRequest,
  nowEpochMs: number,
): void {
  if (decision.schema !== "hypertest.gate-decision/v1") {
    throw new Error("Quality gate returned an unsupported decision schema");
  }
  if (decision.requestId !== request.requestId) {
    throw new Error("Quality gate decision request id does not match");
  }
  if (decision.requestHash !== gateRequestHash(request)) {
    throw new Error("Quality gate decision does not bind the current request");
  }
  if (decision.verdict !== "allow") {
    throw new Error(`Quality gate did not authorize the action: ${decision.verdict}`);
  }
  if (
    decision.expiresAtEpochMs !== undefined &&
    decision.expiresAtEpochMs <= nowEpochMs
  ) {
    throw new Error("Quality gate authorization receipt has expired");
  }
  if (decision.receiptId.length === 0) {
    throw new Error("Quality gate authorization receipt is missing an id");
  }

  const expected = [...new Set(request.evidence.map((item) => item.sha256))].sort();
  const actual = [...new Set(decision.evidenceHashes)].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Quality gate receipt does not bind all current evidence hashes");
  }
}

export class StaticQualityGate implements QualityGate {
  public constructor(
    private readonly verdict: GateVerdict = "allow",
    private readonly reasonCodes: readonly string[] = [],
  ) {}

  public async decide(request: GateRequest): Promise<GateDecision> {
    return {
      schema: "hypertest.gate-decision/v1",
      requestId: request.requestId,
      requestHash: gateRequestHash(request),
      verdict: this.verdict,
      receiptId: `static-${request.requestId}`,
      reasonCodes: this.reasonCodes,
      obligations: [],
      evidenceHashes: request.evidence.map((item) => item.sha256),
      authority: "static-development-gate",
    };
  }
}

export interface ProcessQualityGateOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export class ProcessQualityGate implements QualityGate {
  public constructor(private readonly options: ProcessQualityGateOptions) {}

  public async decide(request: GateRequest): Promise<GateDecision> {
    const result = await runProcess({
      command: this.options.command,
      ...(this.options.args === undefined ? {} : { args: this.options.args }),
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      timeoutMs: this.options.timeoutMs ?? 30_000,
      maxOutputBytes: 1_048_576,
      stdin: `${JSON.stringify(request)}\n`,
    });

    if (result.timedOut) {
      throw new Error("Quality gate timed out; protected action remains blocked");
    }
    if (result.cancelled) {
      throw new Error("Quality gate was cancelled; protected action remains blocked");
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Quality gate process failed with exit ${result.exitCode ?? "unknown"}: ${result.stderr.trim()}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Quality gate returned invalid JSON: ${String(error)}`);
    }
    return validateGateDecision(parsed);
  }
}

export function validateGateDecision(value: unknown): GateDecision {
  if (typeof value !== "object" || value === null) {
    throw new Error("Quality gate decision must be an object");
  }
  const record = value as Record<string, unknown>;
  const requiredStrings = [
    "schema",
    "requestId",
    "requestHash",
    "verdict",
    "receiptId",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof record[key] !== "string") {
      throw new Error(`Quality gate decision field ${key} must be a string`);
    }
  }
  if (
    !["allow", "deny", "needs_human"].includes(record.verdict as string)
  ) {
    throw new Error("Quality gate decision verdict is invalid");
  }
  for (const key of ["reasonCodes", "obligations", "evidenceHashes"] as const) {
    if (
      !Array.isArray(record[key]) ||
      !(record[key] as unknown[]).every((item) => typeof item === "string")
    ) {
      throw new Error(`Quality gate decision field ${key} must be a string array`);
    }
  }
  if (
    record.expiresAtEpochMs !== undefined &&
    typeof record.expiresAtEpochMs !== "number"
  ) {
    throw new Error("Quality gate decision expiry must be a number");
  }
  return value as GateDecision;
}

function canonicalJson(value: Json | GateRequest): string {
  return JSON.stringify(sortJson(value as unknown as Json));
}

function sortJson(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
