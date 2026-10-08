import type { Command } from '../command.ts';
import { approvalsCommand, approveCommand, experienceCommand, oracleCommand, waiveCommand } from './decide.ts';
import { doctorCommand } from './doctor.ts';
import { evalCommand } from './eval.ts';
import { initCommand } from './init.ts';
import { modelCommand } from './model.ts';
import { eventsCommand, evidenceCommand, reportCommand, statusCommand } from './inspect.ts';
import { cancelCommand, resumeCommand, runCommand } from './run.ts';
import { runtimeCommand } from './runtime.ts';
import { serveCommand, workerCommand } from './serve.ts';

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
  oracleCommand,
  waiveCommand,
  experienceCommand,
  cancelCommand,
  runtimeCommand,
  modelCommand,
  evalCommand,
  serveCommand,
  workerCommand,
]);
