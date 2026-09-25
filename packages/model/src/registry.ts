import { HypertestError } from '@hypertest/core';
import type { ModelProvider, ProviderRegistryLike } from './contracts.ts';

/** Provider instances by provider id. Unknown ids are a `not_found` fault (never a silent default). */
export class ProviderRegistry implements ProviderRegistryLike {
  readonly #providers = new Map<string, ModelProvider>();

  constructor(providers: Iterable<ModelProvider> = []) {
    for (const p of providers) this.register(p);
  }

  /** Registers a provider; a second provider with the same id is a `conflict` unless `replace` is set. */
  register(provider: ModelProvider, options: { replace?: boolean } = {}): this {
    if (!provider.providerId) throw new HypertestError('invalid_argument', 'provider has no providerId');
    if (this.#providers.has(provider.providerId) && !options.replace) {
      throw new HypertestError('conflict', `provider already registered: ${provider.providerId}`);
    }
    this.#providers.set(provider.providerId, provider);
    return this;
  }

  get(providerId: string): ModelProvider {
    const p = this.#providers.get(providerId);
    if (!p) throw new HypertestError('not_found', `model provider not registered: ${providerId}`, { details: { providerId } });
    return p;
  }

  has(providerId: string): boolean {
    return this.#providers.has(providerId);
  }

  list(): ModelProvider[] {
    return [...this.#providers.values()];
  }

  /** Adapter bill of materials for RuntimeManifest.providerAdapters (sorted by provider id). */
  adapters(): Array<{ provider: string; package: string; version: string }> {
    return this.list()
      .map((p) => ({ provider: p.providerId, package: p.adapterInfo.package, version: p.adapterInfo.version }))
      .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
  }
}
