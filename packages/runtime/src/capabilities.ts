import { HypertestError } from '@hypertest/core';
import type { AgentEngine, EngineCapabilities } from './contracts.ts';

/**
 * (A[4]) How the host uses an engine's EngineCapabilities: what an engine lacks is EMULATED by the host when the host can
 * provide it on any engine, and REFUSED when it cannot be emulated.
 *
 *   continuableChild  engine.resumeChild reactivates a continuable child (native) | the host reactivates the session and
 *                     runs a turn (emulated)
 *   backgroundChild   the engine runs the child itself | the host schedules the child as its own work item next to its
 *                     parent (emulated — the default: the scheduler owns budgets and concurrency, I12)
 *   peerMessaging     required for continuable children and delegate.message (input reaches the model only through an
 *                     engine draining the session inbox): refused without it
 *   providerSwitch    model switches at turn boundaries | switches stay on the session's provider (emulated); another
 *                     provider is refused (`model.switch_refused`, the agent pauses when its provider is unavailable)
 *   structuredOutput  the engine passes responseFormat through | the host validates complete_work output against the work
 *                     item's schema (emulated; that check runs for every engine anyway)
 *   nativeCompaction / nativeComputerUse / sandboxProfiles  informational: compaction, computer use and sandboxes are host
 *                     services (context layer, browser tools, tool runtime)
 */
export type CapabilityMode = 'engine' | 'host_emulated';

export interface ChildModes {
  continuable: CapabilityMode | null;
  background: CapabilityMode | null;
}

function caps(engine: Pick<AgentEngine, 'capabilities'>): Partial<EngineCapabilities> {
  return engine.capabilities ?? {};
}

/** The modes a child is created with on `engine`; throws precondition_failed for what cannot be emulated. */
export function childModes(engine: Pick<AgentEngine, 'kind' | 'capabilities'>, request: { continuable: boolean; background: boolean }): ChildModes {
  const c = caps(engine);
  if (request.continuable && c.peerMessaging === false) {
    throw new HypertestError('precondition_failed', `engine ${engine.kind} cannot host a continuable child: it cannot receive its parent's messages (peerMessaging: false) and the host cannot emulate that`, {
      details: { engineKind: engine.kind, capability: 'peerMessaging' },
    });
  }
  return {
    continuable: request.continuable ? (c.continuableChild === true ? 'engine' : 'host_emulated') : null,
    background: request.background ? (c.backgroundChild === true ? 'engine' : 'host_emulated') : null,
  };
}

/** Every capability of an engine with the mode the host uses it in (diagnostics: `hypertest status`, GET /runs/:id/agents). */
export function capabilityModes(engine: Pick<AgentEngine, 'capabilities'>): Record<keyof EngineCapabilities, CapabilityMode | 'refused'> {
  const c = caps(engine);
  const m = (v: boolean | undefined): CapabilityMode => (v === true ? 'engine' : 'host_emulated');
  return {
    providerSwitch: m(c.providerSwitch),
    continuableChild: m(c.continuableChild),
    backgroundChild: m(c.backgroundChild),
    peerMessaging: c.peerMessaging === true ? 'engine' : 'refused',
    structuredOutput: m(c.structuredOutput),
    sandboxProfiles: m(c.sandboxProfiles),
    nativeCompaction: m(c.nativeCompaction),
    nativeComputerUse: m(c.nativeComputerUse),
  };
}
