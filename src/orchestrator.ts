import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ProcessAdapterClient,
  createCallContext,
} from "./adapter-protocol.js";
import { FileArtifactStore } from "./artifact-store.js";
import type {
  AdapterResponse,
  ArtifactRef,
  CoverageMap,
  Diagnosis,
  Json,
  RunRequest,
  RunSummary,
  SutContract,
  TestPlan,
  TestRun,
} from "./contracts.js";
import { diagnoseFailure } from "./diagnosis.js";
import {
  ProcessQualityGate,
  StaticQualityGate,
  assertUsableGateDecision,
  createGateRequest,
  type GateAction,
  type GateDecision,
  type QualityGate,
} from "./gate.js";
import { createTestPlan } from "./planner.js";
import type { ModelRuntimeProvider } from "./model-config.js";
import type { AdapterCommandProfile, HyperTestProfile } from "./profile.js";
import { loadProfile } from "./profile.js";
import { validateRepairPatch } from "./repair.js";
import type { AgentRuntime, AgentUsageSummary } from "./runtime.js";
import {
  AgentRuntimeError,
  aggregateAgentUsage,
  assertValidAgentUsageSummary,
  collectAgentRun,
  emptyAgentUsageSummary,
} from "./runtime.js";
import {
  assertValidRunLedger,
  createRunLedger,
  recordTransition,
  type RunEvent,
  type RunLedger,
} from "./state-machine.js";

export interface OrchestratorOptions {
  readonly artifactRoot?: string;
  readonly runtime?: AgentRuntime;
  readonly runtimeProvider?: ModelRuntimeProvider;
  readonly now?: () => number;
}

type SummaryFields = Omit<
  RunSummary,
  | "schema"
  | "runId"
  | "sourceRevision"
  | "finalState"
  | "modelUsage"
  | "ledger"
  | "gateDecisions"
  | "warnings"
>;

export class HyperTestOrchestrator {
  private readonly artifactRoot: string;
  private readonly store: FileArtifactStore;
  private readonly now: () => number;

  public constructor(private readonly options: OrchestratorOptions = {}) {
    this.artifactRoot = resolve(options.artifactRoot ?? ".testagent");
    this.store = new FileArtifactStore(this.artifactRoot);
    this.now = options.now ?? Date.now;
  }

  public async run(request: RunRequest): Promise<RunSummary> {
    const profile = await loadProfile(request.profilePath);
    const deadline = this.now() + Math.min(request.budget.wallClockMs, profile.runtime.budgets.wallClockMs);
    const workspace = workspaceRef(request.workspacePath, request.sourceRevision);
    let ledger = createRunLedger(request.runId);
    const warnings: string[] = [];
    let modelUsage: AgentUsageSummary = emptyAgentUsageSummary(request.runId);
    let modelUsageRef: ArtifactRef<"model-usage"> | undefined;
    let summaryFields: SummaryFields = {};
    const gateDecisionRefs: ArtifactRef<"gate-decision">[] = [];
    const qualityGate = createQualityGate(profile);
    const runtimeProvider =
      this.options.runtimeProvider ?? profile.runtime.provider;
    const modelRuntime =
      runtimeProvider === "deterministic" ? undefined : this.options.runtime;
    const tokenBudget = Math.min(
      request.budget.tokenBudget,
      profile.runtime.budgets.tokenBudget,
    );

    const emit = async (event: string, detail?: Json): Promise<void> => {
      await this.store.appendEvent(request.runId, {
        atEpochMs: this.now(),
        event,
        state: ledger.state,
        ...(detail === undefined ? {} : { detail }),
      });
    };
    const advance = async (event: RunEvent, detail?: string): Promise<void> => {
      ledger = recordTransition(ledger, event, this.now(), detail);
      await emit("transition", { event, to: ledger.state });
    };
    const mergeModelUsage = (summary: AgentUsageSummary): void => {
      modelUsage = aggregateAgentUsage(request.runId, [
        ...modelUsage.records,
        ...summary.records,
      ]);
    };
    const persistModelUsage = async (): Promise<ArtifactRef<"model-usage">> => {
      if (modelUsageRef !== undefined) return modelUsageRef;
      assertValidAgentUsageSummary(modelUsage);
      modelUsageRef = await this.store.putJson({
        runId: request.runId,
        relativePath: "model-usage.json",
        kind: "model-usage",
        schema: "hypertest.model-usage/v1",
        sourceRevision: request.sourceRevision,
        value: modelUsage as unknown as Json,
      });
      warnings.push(`model-usage=${modelUsageRef.uri}`);
      await emit("model_usage_recorded", {
        artifactUri: modelUsageRef.uri,
        artifactSha256: modelUsageRef.sha256,
        providerCalls: modelUsage.providerCalls,
        usageUnavailableCalls: modelUsage.usageUnavailableCalls,
        inputTokens: modelUsage.inputTokens,
        outputTokens: modelUsage.outputTokens,
        cachedTokens: modelUsage.cachedTokens,
        retryCount: modelUsage.retryCount,
      });
      return modelUsageRef;
    };
    const finish = async (
      finalState: RunSummary["finalState"],
      fields: SummaryFields,
    ): Promise<RunSummary> => {
      const usageRef = await persistModelUsage();
      return this.finishSummary(
        request,
        ledger,
        finalState,
        { ...fields, modelUsage: usageRef },
        gateDecisionRefs,
        warnings,
      );
    };

    try {
      await emit("run_started", { profile: profile.name, mode: request.mode });
      await advance("accepted");
      this.assertDeadline(deadline);

      const rawContractText = await readFile(profile.sut.contractSource);
      const rawContractRef = await this.store.put({
        runId: request.runId,
        relativePath: `raw-contract-${basenameSafe(profile.sut.contractSource)}`,
        kind: "raw-sut-contract",
        schema: "hypertest.raw-sut-contract/v1",
        mediaType: profile.sut.sourceKind.includes("json")
          ? "application/json"
          : "text/plain",
        sourceRevision: request.sourceRevision,
        content: rawContractText,
      });

      const sutClient = new ProcessAdapterClient(
        withArtifactEnvironment(profile.adapters.sut, this.artifactRoot),
      );
      const contractResponse = await sutClient.invoke<
        Json,
        ArtifactRef<"sut-contract">
      >(
        "importContract",
        createCallContext({
          runId: request.runId,
          workspace,
          sourceRevision: request.sourceRevision,
          deadlineEpochMs: deadline,
        }),
        {
          source: rawContractRef as unknown as Json,
          sourceKind: profile.sut.sourceKind,
        },
      );
      const contractRef = requireArtifactOutcome(
        contractResponse,
        "sut-contract",
      ) as ArtifactRef<"sut-contract">;
      const contract = await this.store.readJson<SutContract>(contractRef);
      await advance("evidence_ready");
      await advance("analysis_ready");
      this.assertDeadline(deadline);

      if (runtimeProvider !== "deterministic" && modelRuntime === undefined) {
        throw new Error(
          `Runtime provider ${runtimeProvider} was selected but no AgentRuntime was configured`,
        );
      }
      const plan = await createTestPlan(contract, contractRef, {
        maxCasesPerOperation: 12,
        ...(modelRuntime === undefined ? {} : { runtime: modelRuntime }),
        runId: request.runId,
        tokenBudget,
        deadlineEpochMs: deadline,
        maxTurns: Math.min(
          request.budget.maxTurns,
          profile.runtime.budgets.maxTurns,
        ),
        maxToolCalls: Math.min(
          request.budget.maxToolCalls,
          profile.runtime.budgets.maxToolCalls,
        ),
        onUsage: (summary) => {
          mergeModelUsage(summary);
        },
        onAgentEvent: async (event) => {
          if (event.type === "tool_requested") {
            await emit("model_tool_requested", {
              callId: event.callId,
              name: event.name,
            });
          } else if (event.type === "tool_completed") {
            await emit("model_tool_completed", {
              callId: event.callId,
              name: event.name,
              durationMs: event.durationMs,
              status: event.isError ? "error" : "ok",
            });
          }
        },
      });
      const planRef = await this.store.putJson({
        runId: request.runId,
        relativePath: "test-plan.json",
        kind: "test-plan",
        schema: "hypertest.test-plan/v1",
        sourceRevision: request.sourceRevision,
        value: plan as unknown as Json,
      });
      summaryFields = { ...summaryFields, testPlan: planRef };
      await advance("plan_ready");

      if (request.mode === "plan") {
        return finish("planned", { testPlan: planRef });
      }

      const preCode = await this.authorize(
        qualityGate,
        request,
        "enter_implementation",
        [contractRef, planRef],
        gateDecisionRefs,
      );
      await advance(eventForVerdict(preCode));
      if (preCode.verdict !== "allow") {
        return finish(blockedOutcome(preCode), { testPlan: planRef });
      }

      const testClient = new ProcessAdapterClient(
        withArtifactEnvironment(profile.adapters.test, this.artifactRoot),
      );
      const inventoryRef = await this.store.putJson({
        runId: request.runId,
        relativePath: "test-inventory.json",
        kind: "test-inventory",
        schema: "hypertest.test-inventory/v1",
        sourceRevision: request.sourceRevision,
        value: { tests: [] },
      });
      const renderResponse = await testClient.invoke<Json, ArtifactRef<"patch">>(
        "render",
        createCallContext({
          runId: request.runId,
          workspace,
          sourceRevision: request.sourceRevision,
          deadlineEpochMs: deadline,
        }),
        {
          plan: planRef as unknown as Json,
          contract: contractRef as unknown as Json,
          inventory: inventoryRef as unknown as Json,
        },
      );
      let patchRef = requireArtifactOutcome(renderResponse, "patch") as ArtifactRef<"patch">;
      summaryFields = { ...summaryFields, patch: patchRef };
      await advance("patch_rendered");

      const validation = await testClient.invoke<Json, ArtifactRef<"validation-report">>(
        "validate",
        createCallContext({
          runId: request.runId,
          workspace,
          sourceRevision: request.sourceRevision,
          deadlineEpochMs: deadline,
        }),
        { patch: patchRef as unknown as Json },
      );
      requireArtifactOutcome(validation, "validation-report");
      await advance("patch_valid");

      const applyDecision = await this.authorize(
        qualityGate,
        request,
        "apply_patch",
        [contractRef, planRef, patchRef],
        gateDecisionRefs,
      );
      if (applyDecision.verdict !== "allow") {
        await advance(eventForVerdict(applyDecision));
        return finish(blockedOutcome(applyDecision), {
          testPlan: planRef,
          patch: patchRef,
        });
      }

      let runRef: ArtifactRef<"test-run"> | undefined;
      let coverageRef: ArtifactRef<"coverage-map"> | undefined;
      let diagnosisRef: ArtifactRef<"diagnosis"> | undefined;
      let lastDiagnosis: Diagnosis | undefined;

      while (true) {
        this.assertDeadline(deadline);
        const runResponse = await testClient.invoke<Json, ArtifactRef<"test-run">>(
          "run",
          createCallContext({
            runId: request.runId,
            workspace,
            sourceRevision: request.sourceRevision,
            deadlineEpochMs: deadline,
          }),
          {
            patch: patchRef as unknown as Json,
            workspacePath: resolve(request.workspacePath),
          },
        );
        runRef = requireArtifactOutcome(runResponse, "test-run") as ArtifactRef<"test-run">;
        summaryFields = { ...summaryFields, testRun: runRef };
        const testRun = await this.store.readJson<TestRun>(runRef);
        coverageRef = await this.normalizeCoverageIfAvailable(
          profile,
          request,
          workspace,
          deadline,
          runResponse,
        );
        if (coverageRef !== undefined) {
          summaryFields = { ...summaryFields, coverage: coverageRef };
        }

        if (testRun.status === "passed") {
          await advance("tests_passed");
          await advance("verification_passed");
          break;
        }

        await advance("tests_failed");
        lastDiagnosis = diagnoseFailure({
          run: testRun,
          runRef,
          generatedPaths: readChangedPaths(patchRef),
          operationIds: plan.cases.flatMap((item) => item.operationIds),
        });
        diagnosisRef = await this.store.putJson({
          runId: request.runId,
          relativePath: `diagnosis-${ledger.repairRounds}.json`,
          kind: "diagnosis",
          schema: "hypertest.diagnosis/v1",
          sourceRevision: request.sourceRevision,
          value: lastDiagnosis as unknown as Json,
        });
        summaryFields = { ...summaryFields, diagnosis: diagnosisRef };

        const repairLimit = Math.min(
          2,
          request.budget.maxRepairRounds,
          profile.runtime.budgets.maxRepairRounds,
        );
        if (
          !lastDiagnosis.repairAllowed ||
          ledger.repairRounds >= repairLimit ||
          modelRuntime === undefined
        ) {
          await advance("unsafe_or_unknown");
          break;
        }
        await advance("safe_repair");
        if (modelUsage.usageUnavailableCalls > 0) {
          await advance(
            "human_required",
            "Model usage is unavailable, so repair cannot be authorized within the hard token budget",
          );
          break;
        }
        const remainingTokenBudget = Math.max(
          0,
          tokenBudget - modelUsage.totalTokens,
        );
        if (remainingTokenBudget === 0) {
          await advance(
            "human_required",
            "Model token budget exhausted before repair",
          );
          break;
        }
        const repairPatch = await this.generateRepairPatch(
          modelRuntime,
          request,
          deadline,
          plan,
          patchRef,
          runRef,
          diagnosisRef,
          remainingTokenBudget,
          mergeModelUsage,
        );
        const patchText = await this.store.readText(repairPatch);
        const safety = validateRepairPatch(lastDiagnosis, patchText, {
          allowedWriteGlobs: profile.workspace.allowedWriteGlobs,
          forbiddenGlobs: profile.workspace.forbiddenGlobs,
          maxChangedFiles: 8,
          maxAddedLines: 800,
        });
        if (!safety.safe) {
          warnings.push(...safety.violations);
          await advance("human_required", "Repair patch violated safety policy");
          break;
        }

        const repairDecision = await this.authorize(
          qualityGate,
          request,
          "apply_patch",
          [planRef, runRef, diagnosisRef, repairPatch],
          gateDecisionRefs,
        );
        await advance(eventForVerdict(repairDecision));
        if (repairDecision.verdict !== "allow") break;
        patchRef = repairPatch;
        summaryFields = { ...summaryFields, patch: patchRef };
        await advance("repair_applied");
      }

      if (ledger.state !== "publish_gate") {
        return finish(
          stoppedOutcome(ledger.state),
          {
            testPlan: planRef,
            patch: patchRef,
            ...(runRef === undefined ? {} : { testRun: runRef }),
            ...(coverageRef === undefined ? {} : { coverage: coverageRef }),
            ...(diagnosisRef === undefined ? {} : { diagnosis: diagnosisRef }),
          },
        );
      }

      if (request.mode !== "propose") {
        return finish(
          "verified",
          {
            testPlan: planRef,
            patch: patchRef,
            ...(runRef === undefined ? {} : { testRun: runRef }),
            ...(coverageRef === undefined ? {} : { coverage: coverageRef }),
            ...(diagnosisRef === undefined ? {} : { diagnosis: diagnosisRef }),
          },
        );
      }

      if (profile.adapters.scm === undefined) {
        warnings.push("No SCM adapter is configured; verified patch was not published");
        return finish(
          "verified",
          {
            testPlan: planRef,
            patch: patchRef,
            ...(runRef === undefined ? {} : { testRun: runRef }),
            ...(coverageRef === undefined ? {} : { coverage: coverageRef }),
          },
        );
      }

      const proposalRef = await this.store.putJson({
        runId: request.runId,
        relativePath: "change-proposal.json",
        kind: "change-proposal",
        schema: "hypertest.change-proposal/v1",
        sourceRevision: request.sourceRevision,
        value: {
          title: `HyperTest: generated tests for ${contract.title}`,
          description: changeDescription(request, plan, lastDiagnosis),
          baseRevision: request.sourceRevision,
          patchHash: patchRef.sha256,
        },
      });
      const publishDecision = await this.authorize(
        qualityGate,
        request,
        "publish_change",
        [planRef, patchRef, runRef!, proposalRef],
        gateDecisionRefs,
      );
      await advance(eventForVerdict(publishDecision));
      if (publishDecision.verdict !== "allow") {
        return finish(blockedOutcome(publishDecision), {
          testPlan: planRef,
          patch: patchRef,
          testRun: runRef!,
        });
      }

      const scmClient = new ProcessAdapterClient(
        withArtifactEnvironment(profile.adapters.scm, this.artifactRoot),
      );
      const publishResponse = await scmClient.invoke<Json, {
        readonly changeId: string;
        readonly url: string;
        readonly branch: string;
        readonly created: boolean;
      }>(
        "publishDraft",
        createCallContext({
          runId: request.runId,
          workspace,
          sourceRevision: request.sourceRevision,
          deadlineEpochMs: deadline,
        }),
        {
          baseRevision: request.sourceRevision,
          patch: patchRef as unknown as Json,
          gateDecision: gateDecisionRefs.at(-1) as unknown as Json,
          proposal: proposalRef as unknown as Json,
          title: `HyperTest: generated tests for ${contract.title}`,
          description: changeDescription(request, plan, lastDiagnosis),
          idempotencyKey: `${request.runId}-${patchRef.sha256}`,
        },
      );
      if (publishResponse.status !== "ok" || publishResponse.outcome === undefined) {
        throw new Error(
          `SCM adapter failed: ${publishResponse.diagnostics.map((item) => item.message).join("; ")}`,
        );
      }
      await advance("published");
      return finish(
        "completed",
        {
          testPlan: planRef,
          patch: patchRef,
          testRun: runRef!,
          ...(coverageRef === undefined ? {} : { coverage: coverageRef }),
          ...(diagnosisRef === undefined ? {} : { diagnosis: diagnosisRef }),
          change: {
            id: publishResponse.outcome.changeId,
            url: publishResponse.outcome.url,
          },
        },
      );
    } catch (error) {
      const failureMessage =
        error instanceof Error ? error.message : String(error);
      await persistModelUsage();
      if (
        ledger.state !== "completed" &&
        ledger.state !== "needs_human" &&
        ledger.state !== "rejected" &&
        ledger.state !== "failed"
      ) {
        try {
          await advance("fatal_error", failureMessage);
        } catch {
          ledger = { ...ledger, state: "failed" };
          await emit("transition", {
            event: "fatal_error",
            to: "failed",
            recovered: true,
          });
        }
      }
      await emit("run_failed", { message: failureMessage });
      warnings.push(failureMessage);
      return finish("failed", summaryFields);
    }
  }

  private async authorize(
    gate: QualityGate,
    run: RunRequest,
    action: GateAction,
    evidence: readonly ArtifactRef[],
    refs: ArtifactRef<"gate-decision">[],
  ): Promise<GateDecision> {
    const request = createGateRequest({
      runId: run.runId,
      action,
      sourceRevision: run.sourceRevision,
      evidence,
    });
    const decision = await gate.decide(request);
    if (decision.verdict === "allow") {
      assertUsableGateDecision(decision, request, this.now());
    }
    const ref = await this.store.putJson({
      runId: run.runId,
      relativePath: `gate-${refs.length + 1}-${action}.json`,
      kind: "gate-decision",
      schema: "hypertest.gate-decision/v1",
      sourceRevision: run.sourceRevision,
      value: decision as unknown as Json,
    });
    refs.push(ref);
    return decision;
  }

  private async normalizeCoverageIfAvailable(
    profile: HyperTestProfile,
    request: RunRequest,
    workspace: ArtifactRef<"workspace">,
    deadline: number,
    runResponse: AdapterResponse<ArtifactRef<"test-run">>,
  ): Promise<ArtifactRef<"coverage-map"> | undefined> {
    const raw = runResponse.artifacts.find((item) => item.kind === "raw-coverage");
    if (raw === undefined || profile.adapters.coverage === undefined) return undefined;
    const client = new ProcessAdapterClient(
      withArtifactEnvironment(profile.adapters.coverage, this.artifactRoot),
    );
    const response = await client.invoke<Json, ArtifactRef<"coverage-map">>(
      "normalize",
      createCallContext({
        runId: request.runId,
        workspace,
        sourceRevision: request.sourceRevision,
        deadlineEpochMs: deadline,
      }),
      { source: raw as unknown as Json },
    );
    if (response.status === "unsupported") return undefined;
    return requireArtifactOutcome(response, "coverage-map") as ArtifactRef<"coverage-map">;
  }

  private async generateRepairPatch(
    runtime: AgentRuntime,
    request: RunRequest,
    deadline: number,
    plan: TestPlan,
    currentPatch: ArtifactRef<"patch">,
    runRef: ArtifactRef<"test-run">,
    diagnosisRef: ArtifactRef<"diagnosis">,
    tokenBudget: number,
    onUsage: (summary: AgentUsageSummary) => void,
  ): Promise<ArtifactRef<"patch">> {
    let outcome;
    try {
      outcome = await collectAgentRun(runtime, {
        runId: `${request.runId}-repair-${randomUUID()}`,
        phase: "repair",
        systemPrompt:
          "Return JSON with patchText containing a complete replacement unified diff. Preserve or strengthen every oracle. Never add skips, expected failures, broad exception swallowing, or production-code edits.",
        prompt: JSON.stringify({
          plan,
          currentPatch: await this.store.readText(currentPatch),
          testRun: await this.store.readJson<TestRun>(runRef),
          diagnosis: await this.store.readJson<Diagnosis>(diagnosisRef),
        }),
        tools: [],
        artifacts: [currentPatch, runRef, diagnosisRef],
        tokenBudget,
        deadlineEpochMs: deadline,
        expectedResultSchema: {
          type: "object",
          additionalProperties: false,
          required: ["patchText"],
          properties: {
            patchText: {
              type: "string",
              minLength: 1,
              maxLength: 1_048_576,
            },
          },
        },
        maxTurns: 1,
        maxToolCalls: 0,
        maxOutputBytes: 1_048_576,
        maxOutputTokens: Math.max(1, Math.min(tokenBudget, 4_096)),
      });
    } catch (error) {
      if (error instanceof AgentRuntimeError && error.usage !== undefined) {
        onUsage(error.usage);
      }
      throw error;
    }
    onUsage(outcome.usage);
    const result = outcome.result;
    if (!isRecord(result) || typeof result.patchText !== "string") {
      throw new Error("Repair runtime did not return patchText");
    }
    return this.store.put({
      runId: request.runId,
      relativePath: `repair-${Date.now()}.patch`,
      kind: "patch",
      schema: "hypertest.patch/v1",
      mediaType: "text/x-diff",
      sourceRevision: request.sourceRevision,
      content: result.patchText,
    });
  }

  private async finishSummary(
    request: RunRequest,
    ledger: RunLedger,
    finalState: RunSummary["finalState"],
    fields: SummaryFields & {
      readonly modelUsage: ArtifactRef<"model-usage">;
    },
    gateDecisions: readonly ArtifactRef<"gate-decision">[],
    warnings: readonly string[],
  ): Promise<RunSummary> {
    assertSummaryLedgerState(finalState, ledger);
    assertValidRunLedger(ledger);
    const ledgerRef = await this.store.putJson({
      runId: request.runId,
      relativePath: "run-ledger.json",
      kind: "run-ledger",
      schema: "hypertest.run-ledger/v1",
      sourceRevision: request.sourceRevision,
      value: ledger as unknown as Json,
    });
    const summary: RunSummary = {
      schema: "hypertest.run-summary/v1",
      runId: request.runId,
      sourceRevision: request.sourceRevision,
      finalState,
      ...fields,
      ledger: ledgerRef,
      gateDecisions,
      warnings: [...warnings, `ledger=${ledgerRef.uri}`],
    };
    await this.store.putJson({
      runId: request.runId,
      relativePath: "run-summary.json",
      kind: "run-summary",
      schema: "hypertest.run-summary/v1",
      sourceRevision: request.sourceRevision,
      value: summary as unknown as Json,
    });
    return summary;
  }

  private assertDeadline(deadline: number): void {
    if (this.now() >= deadline) throw new Error("HyperTest run deadline exceeded");
  }
}

function assertSummaryLedgerState(
  finalState: RunSummary["finalState"],
  ledger: RunLedger,
): void {
  const expected: Record<RunSummary["finalState"], RunLedger["state"]> = {
    planned: "pre_code_gate",
    verified: "publish_gate",
    completed: "completed",
    needs_human: "needs_human",
    rejected: "rejected",
    failed: "failed",
  };
  if (ledger.state !== expected[finalState]) {
    throw new Error(
      `Run outcome ${finalState} is inconsistent with ledger state ${ledger.state}`,
    );
  }
}

function createQualityGate(profile: HyperTestProfile): QualityGate {
  if (profile.gate.mode === "static-allow") return new StaticQualityGate("allow");
  if (profile.gate.mode === "static-deny") return new StaticQualityGate("deny", ["PROFILE_STATIC_DENY"]);
  const process = profile.gate.process;
  if (process === undefined) throw new Error("Process gate mode requires gate.process");
  const command = process.executable ?? process.command;
  if (command === undefined) throw new Error("Gate process has no executable");
  return new ProcessQualityGate({
    command,
    ...(process.args === undefined ? {} : { args: process.args }),
    ...(process.cwd === undefined ? {} : { cwd: process.cwd }),
    ...(process.env === undefined ? {} : { env: process.env }),
    ...(process.timeoutMs === undefined ? {} : { timeoutMs: process.timeoutMs }),
  });
}

function withArtifactEnvironment(
  adapter: AdapterCommandProfile,
  artifactRoot: string,
): AdapterCommandProfile {
  return {
    ...adapter,
    env: {
      ...adapter.env,
      HYPERTEST_ARTIFACT_ROOT: artifactRoot,
    },
  };
}

function requireArtifactOutcome(
  response: AdapterResponse<ArtifactRef>,
  kind: string,
): ArtifactRef {
  if (response.status !== "ok" || response.outcome === undefined) {
    throw new Error(
      `Adapter did not produce ${kind}: ${response.diagnostics.map((item) => item.message).join("; ")}`,
    );
  }
  if (response.outcome.kind !== kind) {
    throw new Error(`Adapter returned ${response.outcome.kind}, expected ${kind}`);
  }
  return response.outcome;
}

function workspaceRef(path: string, revision: string): ArtifactRef<"workspace"> {
  const absolute = resolve(path);
  return {
    kind: "workspace",
    schema: "hypertest.workspace/v1",
    uri: pathToFileURL(absolute).href,
    mediaType: "application/vnd.hypertest.workspace",
    sha256: createHash("sha256").update(`${absolute}\0${revision}`).digest("hex"),
    sourceRevision: revision,
  };
}

function eventForVerdict(decision: GateDecision): RunEvent {
  if (decision.verdict === "allow") return "allowed";
  if (decision.verdict === "deny") return "denied";
  return "human_required";
}

function blockedOutcome(
  decision: GateDecision,
): "rejected" | "needs_human" {
  if (decision.verdict === "deny") return "rejected";
  if (decision.verdict === "needs_human") return "needs_human";
  throw new Error("An allow decision is not a blocked run outcome");
}

function stoppedOutcome(
  state: RunLedger["state"],
): "needs_human" | "rejected" | "failed" {
  if (
    state === "needs_human" ||
    state === "rejected" ||
    state === "failed"
  ) {
    return state;
  }
  throw new Error(`Run stopped in a non-terminal ledger state: ${state}`);
}

function basenameSafe(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1)?.replace(/[^A-Za-z0-9._-]/g, "-") || "contract";
}

function readChangedPaths(ref: ArtifactRef): string[] {
  const value = ref.metadata?.changedPaths;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function changeDescription(
  request: RunRequest,
  plan: TestPlan,
  diagnosis: Diagnosis | undefined,
): string {
  return [
    "## HyperTest generated change",
    "",
    `- Run: \`${request.runId}\``,
    `- Base revision: \`${request.sourceRevision}\``,
    `- Planned cases: ${plan.cases.length}`,
    ...(diagnosis === undefined
      ? []
      : [`- Last diagnosis: ${diagnosis.category} (${diagnosis.confidence.toFixed(2)})`]),
    "",
    "The change was executed in an isolated workspace and passed the configured quality gate before publication.",
  ].join("\n");
}

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
