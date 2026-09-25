import { HypertestError } from '@hypertest/core';
import { RISK_ORDER } from '@hypertest/domain';
import type { AdapterRegistryLike, SideEffectAdapter } from './contracts.ts';

const RECONCILIATION_CLASSES = new Set(['deterministic', 'best_effort', 'non_reconcilable']);

/** Registry of SideEffectAdapters by adapterId. Capabilities are validated at registration. */
export class AdapterRegistry implements AdapterRegistryLike {
  readonly #adapters = new Map<string, SideEffectAdapter>();

  constructor(adapters: Iterable<SideEffectAdapter<any, any>> = []) {
    for (const a of adapters) this.register(a);
  }

  register(adapter: SideEffectAdapter<any, any>): this {
    if (!adapter || typeof adapter.adapterId !== 'string' || adapter.adapterId.length === 0) {
      throw new HypertestError('invalid_argument', 'adapter.adapterId must be a non-empty string');
    }
    const caps = adapter.capabilities;
    // Object.hasOwn, not `in`: 'toString'/'constructor' must not pass as a risk class (they would then
    // compare as "not high risk" and unlock blind retries).
    if (!caps || !RECONCILIATION_CLASSES.has(caps.reconciliationClass) || typeof caps.riskClass !== 'string' || !Object.hasOwn(RISK_ORDER, caps.riskClass)) {
      throw new HypertestError('invalid_argument', `adapter ${adapter.adapterId} declares invalid capabilities`, { details: { capabilities: caps as unknown as Record<string, unknown> } });
    }
    if (caps.supportsCompensation && typeof adapter.compensate !== 'function') {
      throw new HypertestError('invalid_argument', `adapter ${adapter.adapterId} declares supportsCompensation but has no compensate()`);
    }
    if (this.#adapters.has(adapter.adapterId)) throw new HypertestError('conflict', `adapter ${adapter.adapterId} is already registered`);
    this.#adapters.set(adapter.adapterId, adapter as SideEffectAdapter);
    return this;
  }

  get(adapterId: string): SideEffectAdapter {
    const a = this.#adapters.get(adapterId);
    if (!a) throw new HypertestError('not_found', `no side-effect adapter registered for ${adapterId}`, { details: { adapterId } });
    return a;
  }

  has(adapterId: string): boolean {
    return this.#adapters.has(adapterId);
  }

  list(): SideEffectAdapter[] {
    return [...this.#adapters.values()];
  }
}
