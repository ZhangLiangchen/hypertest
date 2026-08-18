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
import type { AdapterCommandProfile, HyperTestProfile } from "./profile.js";
import { loadProfile } from "./profile.js";
import { validateRepairPatch } from "./repair.js";
import type { AgentRuntime, AgentUsageSummary } from "./runtime.js";
import { collectAgentResult, emptyAgentUsageSummary } from "./runtime.js";
import {
  createRunLedger,
  recordTransition,
  type RunEvent,
  type RunLedger,
} from "./state-machine.js";

export interface OrchestratorOptions {
  readonly artifactRoot?: string;
  readonly runtime?: AgentRuntime;
  readonly now?: () => number;
}

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
    const gateDecisionRefs: ArtifactRef<"gate-decision">[] = [];
    const qualityGate = createQualityGate(profile);

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

      const planningRuntime =
        profile.runtime.provider === "deterministic"
          ? undefined
          : this.options.runtime;
      const plan = await createTestPlan(contract, contractRef, {
        maxCasesPerOperation: 12,
        ...(planningRuntime === undefined ? {} : { runtime: planningRuntime }),
        runId: request.runId,
        tokenBudget: Math.min(
          request.budget.tokenBudget,
          profile.runtime.budgets.tokenBudget,
        ),
        deadlineEpochMs: deadline,
        onUsage: (summary) => {
          modelUsage = summary;
        },
      });
      const modelUsageRef = await this.store.putJson({
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
      const planRef = await this.store.putJson({
        runId: request.runId,
        relativePath: "test-plan.json",
        kind: "test-plan",
        schema: "hypertest.test-plan/v1",
        sourceRevision: request.sourceRevision,
        value: plan as unknown as Json,
      });
      await advance("plan_ready");

      if (request.mode === "plan") {
        return this.finishSummary(
          request,
          ledger,
          "planned",
          { testPlan: planRef },
          gateDecisionRefs,
          warnings,
        );
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
        return this.finishSummary(
          request,
          ledger,
          ledger.state,
          { testPlan: planRef },
          gateDecisionRefs,
          warnings,
        );
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
        ledger = {
          ...ledger,
          state: applyDecision.verdict === "deny" ? "rejected" : "needs_human",
        };
        return this.finishSummary(
          request,
          ledger,
          ledger.state,
          { testPlan: planRef, patch: patchRef },
          gateDecisionRefs,
          warnings,
        );
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
        const testRun = await this.store.readJson<TestRun>(runRef);
        coverageRef = await this.normalizeCoverageIfAvailable(
          profile,
          request,
          workspace,
          deadline,
          runResponse,
        );

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

        const repairLimit = Math.min(
          request.budget.maxRepairRounds,
          profile.runtime.budgets.maxRepairRounds,
        );
        if (
          !lastDiagnosis.repairAllowed ||
          ledger.repairRounds >= repairLimit ||
          this.options.runtime === undefined
        ) {
          await advance("unsafe_or_unknown");
          break;
        }
        await advance("safe_repair");
        const repairPatch = await this.generateRepairPatch(
          request,
          deadline,
          plan,
          patchRef,
          runRef,
          diagnosisRef,
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
        await advance("repair_applied");
      }

      if (ledger.state !== "publish_gate") {
        return this.finishSummary(
          request,
          ledger,
          ledger.state === "verify" ? "verified" : ledger.state,
          {
            testPlan: planRef,
            patch: patchRef,
            ...(runRef === undefined ? {} : { testRun: runRef }),
            ...(coverageRef === undefined ? {} : { coverage: coverageRef }),
            ...(diagnosisRef === undefined ? {} : { diagnosis: diagnosisRef }),
          },
          gateDecisionRefs,
          warnings,
        );
      }

      if (request.mode !== "propose") {
        return this.finishSummary(
          request,
          ledger,
          "verified",
          {
            testPlan: planRef,
            patch: patchRef,
            ...(runRef === undefined ? {} : { testRun: runRef }),
            ...(coverageRef === undefined ? {} : { coverage: coverageRef }),
            ...(diagnosisRef === undefined ? {} : { diagnosis: diagnosisRef }),
          },
          gateDecisionRefs,
          warnings,
        );
      }

      if (profile.adapters.scm === undefined) {
        warnings.push("No SCM adapter is configured; verified patch was not published");
        return this.finishSummary(
          request,
          ledger,
          "verified",
          {
            testPlan: planRef,
            patch: patchRef,
            ...(runRef === undefined ? {} : { testRun: runRef }),
            ...(coverageRef === undefined ? {} : { coverage: coverageRef }),
          },
          gateDecisionRefs,
          warnings,
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
        return this.finishSummary(
          request,
          ledger,
          ledger.state,
          { testPlan: planRef, patch: patchRef, testRun: runRef! },
          gateDecisionRefs,
          warnings,
        );
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
      return this.finishSummary(
        request,
        ledger,
        ledger.state,
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
        gateDecisionRefs,
        warnings,
      );
    } catch (error) {
      await emit("run_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      if (
        ledger.state !== "completed" &&
        ledger.state !== "needs_human" &&
        ledger.state !== "rejected" &&
        ledger.state !== "failed"
      ) {
        try {
          ledger = recordTransition(ledger, "fatal_error", this.now());
        } catch {
          ledger = { ...ledger, state: "failed" };
        }
      }
      warnings.push(error instanceof Error ? error.message : String(error));
      return this.finishSummary(
        request,
        ledger,
        "failed",
        {},
        gateDecisionRefs,
        warnings,
      );
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
    request: RunRequest,
    deadline: number,
    plan: TestPlan,
    currentPatch: ArtifactRef<"patch">,
    runRef: ArtifactRef<"test-run">,
    diagnosisRef: ArtifactRef<"diagnosis">,
  ): Promise<ArtifactRef<"patch">> {
    const result = await collectAgentResult(this.options.runtime!, {
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
      tokenBudget: request.budget.tokenBudget,
      deadlineEpochMs: deadline,
    });
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
    finalState: string,
    fields: Omit<RunSummary, "schema" | "runId" | "sourceRevision" | "finalState" | "gateDecisions" | "warnings">,
    gateDecisions: readonly ArtifactRef<"gate-decision">[],
    warnings: readonly string[],
  ): Promise<RunSummary> {
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
