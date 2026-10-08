import type { Command } from '../command.ts';
import { approvalsCommand, approveCommand, experienceCommand, oracleCommand, rejectCommand, waiveCommand } from './decide.ts';
import { doctorCommand } from './doctor.ts';
import { evalCommand } from './eval.ts';
import { initCommand } from './init.ts';
import { modelCommand } from './model.ts';
import { operationsCommand } from './operations.ts';
import { eventsCommand, evidenceCommand, reportCommand, statusCommand } from './inspect.ts';
import { cancelCommand, resumeCommand, runCommand } from './run.ts';
import { runtimeCommand } from './runtime.ts';
import { serveCommand, workerCommand } from './serve.ts';
import { memoryCommand } from './memory.ts';
import { skillCommand } from './skill.ts';

/** Every command in help order. */
export const ALL_COMMANDS: readonly Command[] = Object.freeze([
  initCommand,
  doctorCommand,
  runCommand,
  statusCommand,
  resumeCommand,
  reportCommand,
  eventsCommand,
  evidenceCommand,
  approvalsCommand,
  approveCommand,
  rejectCommand,
  operationsCommand,
  oracleCommand,
  waiveCommand,
  experienceCommand,
  skillCommand,
  memoryCommand,
  cancelCommand,
  runtimeCommand,
  modelCommand,
  evalCommand,
  serveCommand,
  workerCommand,
]);
