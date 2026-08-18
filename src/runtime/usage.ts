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
  return records.reduce<AgentUsageSummary>(
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
        (record.outputTokens ?? 0),
      retryCount: summary.retryCount + record.retryCount,
      totalLatencyMs: summary.totalLatencyMs + record.latencyMs,
      estimatedCostUsd:
        summary.estimatedCostUsd + (record.estimatedCostUsd ?? 0),
      records: [...summary.records, record],
    }),
    emptyAgentUsageSummary(runId),
  );
}

function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/").replace(/\/+$/g, "");
  return collapsed === "" ? "/" : collapsed;
}
