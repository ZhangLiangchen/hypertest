import type { ActorRef } from '@hypertest/domain';

export interface IndependenceViolation {
  rule: 'provider_unknown' | 'same_provider' | 'role_unknown' | 'same_role';
  message: string;
}

/**
 * I8 independence of an AGENT approver from the actor that produced the request/proposal. Fail closed:
 * independence that cannot be established (unknown provider or role) counts as a violation.
 *  - the approver must have a known model provider;
 *  - against an agent producer: both providers known and different, both roles known and different.
 */
export function agentIndependenceViolation(producer: ActorRef, approver: ActorRef): IndependenceViolation | undefined {
  if (!approver.modelProvider) {
    return { rule: 'provider_unknown', message: `agent approver ${approver.id} has no model provider; independence cannot be established` };
  }
  if (producer.kind !== 'agent') return undefined;
  if (!producer.modelProvider) {
    return { rule: 'provider_unknown', message: `producer ${producer.id} has no recorded model provider; agent independence cannot be established` };
  }
  if (approver.modelProvider === producer.modelProvider) {
    return { rule: 'same_provider', message: `agent approver ${approver.id} shares model provider ${approver.modelProvider} with the producer ${producer.id}` };
  }
  if (!approver.role || !producer.role) {
    return { rule: 'role_unknown', message: `agent approver ${approver.id} or producer ${producer.id} has no recorded role; role independence cannot be established` };
  }
  if (approver.role === producer.role) {
    return { rule: 'same_role', message: `agent approver ${approver.id} has the producer's role ${approver.role}` };
  }
  return undefined;
}

/** Serializes async critical sections per key within one process (the store's CAS covers other processes). */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = previous.then(() => mine);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
