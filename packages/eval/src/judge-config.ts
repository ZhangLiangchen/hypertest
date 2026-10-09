/**
 * (F[11], stubs[5]) The independent LLM judge from a CONFIGURATION — not only the scripted CI judge: `configuredJudge`
 * routes over the models of a Hypertest configuration (its own router, the listed routes only), calibrated against the
 * expert-labelled set; `recordingJudge` keeps every packet the judge saw (for human labelling); `labelCalibrationItem`
 * turns a packet + a human label into a calibration item. The judge always runs LAST (graderOrderProblems) and may answer
 * `unknown`; its results count only when calibrated on the answering route.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HypertestError, canonicalJson, sha256Hex, type JsonValue, type Logger } from '@hypertest/core';
import { configuredModels, type HypertestConfig } from '@hypertest/app';
import type { ScriptedBrain } from '@hypertest/model';
import type { CalibrationItem, CalibrationSet, EvidencePacket, JudgeRubric, JudgeVerdict, LlmJudge } from './contracts.ts';
import { JUDGE_VERDICTS, assertCalibrationSet, createLlmJudge, loadCalibrationSet, type JudgeSetup } from './judge.ts';

export interface ConfiguredJudgeOptions {
  /** Routes of the configuration the judge may use (default: every enabled route). */
  routeIds?: readonly string[];
  /** The calibration set (default: the committed one); `false` ⇒ uncalibrated (results never count). */
  calibration?: CalibrationSet | false;
  env?: Record<string, string | undefined>;
  /** Brains of scripted providers of the configuration (tests). */
  scriptedBrains?: Record<string, ScriptedBrain>;
  fetch?: typeof fetch;
  logger?: Logger;
  timeoutMs?: number;
}

/** An independent judge over the configuration's model routes (F[11]). */
export async function configuredJudge(config: HypertestConfig, options: ConfiguredJudgeOptions = {}): Promise<LlmJudge> {
  const { routes, providers } = await configuredModels(
    config,
    { ...(options.env ? { env: options.env } : {}), ...(options.scriptedBrains ? { scriptedBrains: options.scriptedBrains } : {}), ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.logger ? { logger: options.logger } : {}) },
    options.routeIds,
  );
  if (routes.length === 0) throw new HypertestError('precondition_failed', 'the configuration has no enabled model route for the judge');
  const setup: JudgeSetup = { routes, providers };
  const set = options.calibration === undefined ? loadCalibrationSet() : options.calibration;
  if (set !== false) setup.calibration = { set };
  if (options.logger) setup.logger = options.logger;
  if (options.timeoutMs !== undefined) setup.timeoutMs = options.timeoutMs;
  return createLlmJudge(setup);
}

/** One packet the judge saw, as recordingJudge writes it (`<dir>/<packetDigest>.json`). */
export interface RecordedJudgePacket {
  packetDigest: string;
  rubric: JudgeRubric;
  packet: EvidencePacket;
  answer?: { verdict: JudgeVerdict; rationale: string; routeId: string };
}

/**
 * A judge that writes every packet it is asked about (and its answer) to `dir`, for a human to label later
 * (`eval calibrate label`). The identity is the inner judge's: recording changes nothing about the judgement.
 */
export function recordingJudge(inner: LlmJudge, dir: string): LlmJudge {
  mkdirSync(dir, { recursive: true });
  return {
    get identity() {
      return inner.identity;
    },
    async judge(packet, rubric, options) {
      const packetDigest = sha256Hex(canonicalJson(packet as unknown as JsonValue));
      const record: RecordedJudgePacket = { packetDigest, rubric, packet };
      try {
        const answer = await inner.judge(packet, rubric, options);
        record.answer = { verdict: answer.verdict, rationale: answer.rationale, routeId: answer.routeId };
        return answer;
      } finally {
        writeFileSync(join(dir, `${packetDigest}.json`), `${JSON.stringify(record, null, 2)}\n`);
      }
    },
    calibrate: (set, rubric) => inner.calibrate(set, rubric),
    calibration: (rubric) => inner.calibration(rubric),
  };
}

/**
 * (F[11]) Adds a HUMAN label for a recorded packet to a calibration set file (created when missing): the item binds the
 * label to the rubric revision the packet was judged against. Labels come from people (`human:<name>`), never from a model.
 */
export function labelCalibrationItem(input: { setFile: string; packetFile: string; label: string; by: string; note?: string; setId?: string }): { set: CalibrationSet; item: CalibrationItem } {
  if (!(JUDGE_VERDICTS as readonly string[]).includes(input.label)) throw new HypertestError('invalid_argument', `label must be one of ${JUDGE_VERDICTS.join(', ')}`);
  if (!/^human:\S.{0,120}$/.test(input.by)) throw new HypertestError('invalid_argument', `a calibration label is given by a human (human:<name>), got ${JSON.stringify(input.by)}`);
  const recorded = JSON.parse(readFileSync(input.packetFile, 'utf8')) as Partial<RecordedJudgePacket>;
  if (!recorded || typeof recorded !== 'object' || !recorded.packet || !recorded.rubric) throw new HypertestError('invalid_argument', `${input.packetFile} is not a recorded judge packet`);
  let set: CalibrationSet;
  try {
    set = assertCalibrationSet(JSON.parse(readFileSync(input.setFile, 'utf8')), input.setFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    set = { calibrationSetId: input.setId ?? 'human-labels', revision: '1', items: [] };
  }
  const digest = recorded.packetDigest ?? sha256Hex(canonicalJson(recorded.packet as unknown as JsonValue));
  const itemId = `${recorded.rubric.rubricId}:${digest.slice(0, 16)}`;
  if (set.items.some((i) => i.itemId === itemId)) throw new HypertestError('conflict', `the set already labels this packet (${itemId})`);
  const item: CalibrationItem = {
    itemId, rubricId: recorded.rubric.rubricId, rubricRevision: recorded.rubric.revision, packet: recorded.packet, label: input.label as JudgeVerdict, labelledBy: input.by,
    ...(input.note ? { note: input.note } : {}),
  };
  // a changed set is a new revision of it: calibrations of the old one stay what they were
  const n = Number(set.revision);
  const next: CalibrationSet = { ...set, revision: Number.isSafeInteger(n) ? String(n + 1) : `${set.revision}+${set.items.length + 1}`, items: [...set.items, item] };
  // (review) atomically: a crash mid-write never leaves a truncated calibration set (the labels are human work)
  const tmp = `${input.setFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, input.setFile);
  return { set: next, item };
}
