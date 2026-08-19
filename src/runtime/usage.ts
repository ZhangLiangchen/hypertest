import { createHash } from "node:crypto";

import type { AgentUsage, AgentUsageSummary } from "../runtime.js";

export function fingerprintEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.pathname = normalizePath(url.pathname);
  return createHash("sha256").update(url.toString()).digest("hex");
}

export function emptyAgentUsageSummary(runId: string): AgentUsageSummary {
  return {
    schema: "hypertest.model-usage/v1",
    runId,
    providerCalls: 0,
    usageUnavailableCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    retryCount: 0,
    totalLatencyMs: 0,
    estimatedCostUsd: 0,
    records: [],
  };
}

export function aggregateAgentUsage(
  runId: string,
  records: readonly AgentUsage[],
): AgentUsageSummary {
  const summary = records.reduce<AgentUsageSummary>(
    (summary, record) => ({
      ...summary,
      providerCalls: summary.providerCalls + 1,
      usageUnavailableCalls:
        summary.usageUnavailableCalls + (record.usageUnavailable ? 1 : 0),
      inputTokens: summary.inputTokens + (record.inputTokens ?? 0),
      outputTokens: summary.outputTokens + (record.outputTokens ?? 0),
      cachedTokens: summary.cachedTokens + (record.cachedTokens ?? 0),
      totalTokens:
        summary.totalTokens +
        (record.inputTokens ?? 0) +
        (record.outputTokens ?? 0) +
        (record.cachedTokens ?? 0),
      retryCount: summary.retryCount + record.retryCount,
      totalLatencyMs: summary.totalLatencyMs + record.latencyMs,
      estimatedCostUsd:
        summary.estimatedCostUsd + (record.estimatedCostUsd ?? 0),
      records: [...summary.records, record],
    }),
    emptyAgentUsageSummary(runId),
  );
  assertValidAgentUsageSummary(summary);
  return summary;
}

export function assertValidAgentUsageSummary(
  summary: AgentUsageSummary,
): void {
  const invalid = (message: string): never => {
    throw new Error(`Invalid agent usage summary: ${message}`);
  };
  for (const record of summary.records) {
    if (
      record.provider.length === 0 ||
      record.model.length === 0 ||
      !/^[a-f0-9]{64}$/.test(record.endpointFingerprint)
    ) {
      invalid("provider identity is malformed");
    }
    if (
      record.providerRequestId !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,127}$/.test(
        record.providerRequestId,
      )
    ) {
      invalid("provider request id is malformed");
    }
    for (const [name, value] of [
      ["inputTokens", record.inputTokens],
      ["outputTokens", record.outputTokens],
      ["cachedTokens", record.cachedTokens],
      ["latencyMs", record.latencyMs],
      ["retryCount", record.retryCount],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        invalid(`${name} must be a non-negative integer`);
      }
    }
    if (
      record.usageUnavailable &&
      (record.inputTokens !== undefined ||
        record.outputTokens !== undefined ||
        record.cachedTokens !== undefined ||
        record.estimatedCostUsd !== undefined)
    ) {
      invalid("unavailable usage must not contain token or cost estimates");
    }
    if (
      !record.usageUnavailable &&
      (record.inputTokens === undefined || record.outputTokens === undefined)
    ) {
      invalid("available usage must contain input and output tokens");
    }
    if (
      record.estimatedCostUsd !== undefined &&
      (!Number.isFinite(record.estimatedCostUsd) ||
        record.estimatedCostUsd < 0)
    ) {
      invalid("estimated cost must be a non-negative finite number");
    }
  }
  const sum = (select: (record: AgentUsage) => number): number =>
    summary.records.reduce((total, record) => total + select(record), 0);
  const expected = {
    providerCalls: summary.records.length,
    usageUnavailableCalls: sum((record) => record.usageUnavailable ? 1 : 0),
    inputTokens: sum((record) => record.inputTokens ?? 0),
    outputTokens: sum((record) => record.outputTokens ?? 0),
    cachedTokens: sum((record) => record.cachedTokens ?? 0),
    retryCount: sum((record) => record.retryCount),
    totalLatencyMs: sum((record) => record.latencyMs),
    estimatedCostUsd: sum((record) => record.estimatedCostUsd ?? 0),
  };
  const expectedTotalTokens =
    expected.inputTokens + expected.outputTokens + expected.cachedTokens;
  if (
    summary.providerCalls !== expected.providerCalls ||
    summary.usageUnavailableCalls !== expected.usageUnavailableCalls ||
    summary.inputTokens !== expected.inputTokens ||
    summary.outputTokens !== expected.outputTokens ||
    summary.cachedTokens !== expected.cachedTokens ||
    summary.totalTokens !== expectedTotalTokens ||
    summary.retryCount !== expected.retryCount ||
    summary.totalLatencyMs !== expected.totalLatencyMs ||
    Math.abs(summary.estimatedCostUsd - expected.estimatedCostUsd) > 1e-12
  ) {
    invalid("aggregate fields do not match the per-call records");
  }
}

function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/").replace(/\/+$/g, "");
  return collapsed === "" ? "/" : collapsed;
}
