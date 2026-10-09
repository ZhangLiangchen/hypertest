# Committed eval baselines

`core-scripted-multi-llm.json` is the baseline of the eval release gate (`npm run eval:gate`, CI): the SuiteResult of
`hypertest eval run core --arms scripted-multi-llm` (one trial per task, in-process). The gate refuses a candidate that is
not comparable with it (another suite id, suite revision or suite content fingerprint, eval harness revision or mode,
grader or oracle revision per task — a grader change only through a bridge without discontinuity).

## Protocol for a new baseline

1. A grader changed (its source fingerprint moved): bump its revision in `src/grader-revisions.ts`, keep the previous
   revision as a retained grader (`src/retained-graders.ts`), record the fingerprint
   (`HYPERTEST_UPDATE_GRADER_LOCK=1 node --test packages/eval/test/grader-versions.test.ts`).
2. A suite changed (its tasks, brains or fixtures): bump its revision and record the fingerprint
   (`HYPERTEST_UPDATE_SUITE_LOCK=1 node --test packages/eval/test/suite-versions.test.ts`).
3. Bridge every changed grader on the same trials and write the new baseline from the same run:
   `hypertest eval bridge core --grader <id>@<old revision> --arms scripted-multi-llm --out baselines/core-bridge-<id>-<old>-<new>.json --result-out baselines/core-scripted-multi-llm.json`.
   A bridge with a discontinuity (an outcome flipped) is a re-baseline that must be explained here; without one, results
   graded by either revision stay comparable (`eval gate --bridge <file>`).
4. Every trial of the new baseline must pass; record the change below.

## History

| Date | Baseline | Why | Bridge |
|---|---|---|---|
| (wave 1–2) | `core@core-1`, 7 tasks | context-freshness, model-switch (+ baseline), security-injection, test-generation (+ insensitive, defect) | – |
| 2026-10-08 (audit wave 3) | `core@core-2`, 19 tasks, suite fingerprint `498e2f0e…` | (a) suite revision core-1 → core-2: the core suite also runs the extended core tasks (API black-box, Performance ×2, FaultTolerance ×2, Evidence: missing evidence, MultiAgent ×2) and the chaos cases (kill after success, budget exhaustion, competing faults, unqueryable target); (b) grader `generatedTestsGoverned` revision 1 → 2 (wave 1, gate governance). The 7 tasks of core-1 reach the same results and verdicts as before. The evidence-TAMPER task is not in the gate suite: its attack leaves a store that does not verify, so the gate's evidence criterion fails it by design (it runs in `evidence` and `deep`). `test/suite-versions.test.ts` checks that this file is the locked core suite, that every trial passed and that it passes the gate against itself. | `core-bridge-generatedTestsGoverned-1-2.json`: 3 pairs (test-generation, -insensitive, -defect), agreement 1, no outcome flipped — **no discontinuity** |
