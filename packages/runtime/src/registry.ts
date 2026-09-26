import { HypertestError } from '@hypertest/core';
import type { RuntimeManifest } from '@hypertest/domain';
import type { AgentEngine, EngineRegistryLike } from './contracts.ts';

/** Engines by kind. Unknown kinds are a not_found fault (never a silent default). */
export class EngineRegistry implements EngineRegistryLike {
  readonly #engines = new Map<string, AgentEngine>();

  constructor(engines: Iterable<AgentEngine> = []) {
    for (const e of engines) this.register(e);
  }

  /** Registers an engine; a second engine of the same kind is a conflict. */
  register(engine: AgentEngine): this {
    if (!engine || typeof engine.kind !== 'string' || engine.kind.length === 0) throw new HypertestError('invalid_argument', 'engine must have a non-empty kind');
    if (typeof engine.runTurn !== 'function' || typeof engine.createSession !== 'function') throw new HypertestError('invalid_argument', `engine ${engine.kind} does not implement AgentEngine`);
    if (this.#engines.has(engine.kind)) throw new HypertestError('conflict', `engine already registered: ${engine.kind}`);
    this.#engines.set(engine.kind, engine);
    return this;
  }

  get(kind: string): AgentEngine {
    const e = this.#engines.get(kind);
    if (!e) throw new HypertestError('not_found', `agent engine not registered: ${kind}`, { details: { kind } });
    return e;
  }

  has(kind: string): boolean {
    return this.#engines.has(kind);
  }

  list(): AgentEngine[] {
    return [...this.#engines.values()];
  }

  /**
   * I11: a live run is pinned to its RuntimeManifest. Throws precondition_failed when `kind` is not pinned by the
   * manifest or the registered engine's version differs from the pinned one (an upgraded engine never serves a run
   * that was created on another version; the run must be migrated explicitly). A pin without a version cannot prove
   * which engine the run was created on, so it fails closed as well.
   */
  assertPinned(manifest: Pick<RuntimeManifest, 'manifestId' | 'agentEngines'>, kind: string): AgentEngine {
    const engine = this.get(kind);
    const pinned = (Array.isArray(manifest?.agentEngines) ? manifest.agentEngines : []).filter((e) => e?.kind === kind);
    if (pinned.length === 0) {
      throw new HypertestError('precondition_failed', `engine ${kind} is not pinned by runtime manifest ${manifest?.manifestId}`, { details: { kind, manifestId: manifest?.manifestId ?? null } });
    }
    if (!pinned.some((e) => typeof e.version === 'string' && e.version.length > 0 && e.version === engine.version)) {
      throw new HypertestError('precondition_failed', `engine ${kind} is version ${engine.version}; runtime manifest ${manifest.manifestId} pins ${pinned.map((e) => e.version || '(no version)').join(', ')}`, {
        details: { kind, version: engine.version, pinned: pinned.map((e) => e.version ?? null), manifestId: manifest.manifestId },
      });
    }
    return engine;
  }

  /** RuntimeManifest.agentEngines entries (sorted by kind). */
  manifestEntries(): Array<{ kind: string; version: string }> {
    return this.list()
      .map((e) => ({ kind: e.kind, version: e.version }))
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  }
}
