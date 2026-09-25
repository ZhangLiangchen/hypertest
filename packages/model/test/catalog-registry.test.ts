import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError, canonicalJson, sha256Hex, jsonClone } from '@hypertest/core';
import { ModelCatalog, ProviderRegistry, ScriptedProvider, estimateCostUsd, type ModelCapabilityProfile } from '../src/index.ts';
import { profile } from './helpers.ts';

const isCode = (code: string) => (e: unknown) => e instanceof HypertestError && e.code === code;

test('catalog revision is mc_ + sha256(canonicalJson(profiles))[0..16] and deterministic', () => {
  const ps = [profile({ routeId: 'a' }), profile({ routeId: 'b', enabled: false })];
  const cat = new ModelCatalog(ps);
  assert.equal(cat.revision, 'mc_' + sha256Hex(canonicalJson(ps)).slice(0, 16));
  assert.match(cat.revision, /^mc_[0-9a-f]{16}$/);
  assert.equal(new ModelCatalog(jsonClone(ps)).revision, cat.revision);
  const changed = [profile({ routeId: 'a', costPerMillionInputUsd: 2 }), profile({ routeId: 'b', enabled: false })];
  assert.notEqual(new ModelCatalog(changed).revision, cat.revision);
});

test('catalog list() returns every profile including disabled ones; get() by routeId', () => {
  const cat = new ModelCatalog([profile({ routeId: 'a' }), profile({ routeId: 'b', enabled: false })]);
  assert.deepEqual(cat.list().map((p) => [p.routeId, p.enabled]), [['a', true], ['b', false]]);
  assert.equal(cat.get('b')?.enabled, false);
  assert.equal(cat.get('zzz'), undefined);
});

test('catalog is immutable: caller mutations after construction do not change it; returned profiles are frozen', () => {
  const ps = [profile({ routeId: 'a' })];
  const cat = new ModelCatalog(ps);
  const rev = cat.revision;
  ps[0]!.maxDataClassification = 'restricted';
  assert.equal(cat.get('a')?.maxDataClassification, 'confidential');
  assert.throws(() => {
    (cat.get('a') as ModelCapabilityProfile).maxDataClassification = 'restricted';
  }, TypeError);
  assert.equal(cat.revision, rev);
});

test('catalog rejects duplicate routeIds', () => {
  assert.throws(() => new ModelCatalog([profile({ routeId: 'a' }), profile({ routeId: 'a', provider: 'other' })]), (e: unknown) => isCode('invalid_argument')(e) && /duplicate routeId a/.test((e as Error).message));
});

test('catalog rejects malformed profiles (unknown classification, unknown capability, bad scores, NaN)', () => {
  const bad: Array<Partial<ModelCapabilityProfile>> = [
    { maxDataClassification: 'secret' as never },
    { maxActionRisk: 'extreme' as never },
    { capabilities: ['telepathy' as never] },
    { quality: { default: 1.5 } },
    { toolReliability: -0.1 },
    { costPerMillionInputUsd: Number.NaN },
    { contextWindow: 0 },
    { structuredOutput: 'maybe' as never },
  ];
  for (const b of bad) {
    assert.throws(() => new ModelCatalog([profile({ routeId: 'x', ...b })]), isCode('invalid_argument'), JSON.stringify(b));
  }
  assert.throws(() => new ModelCatalog([{ ...profile({ routeId: 'x' }), surprise: true } as never]), isCode('invalid_argument'));
});

test('withScores returns a new catalog with merged quality and a new revision; unknown route → not_found', () => {
  const cat = new ModelCatalog([profile({ routeId: 'a', quality: { default: 0.5, lead: 0.6 } }), profile({ routeId: 'b' })]);
  const next = cat.withScores({ a: { lead: 0.9, reviewer: 0.4 } });
  assert.deepEqual(next.get('a')?.quality, { default: 0.5, lead: 0.9, reviewer: 0.4 });
  assert.deepEqual(cat.get('a')?.quality, { default: 0.5, lead: 0.6 });
  assert.notEqual(next.revision, cat.revision);
  assert.throws(() => cat.withScores({ nope: { lead: 1 } }), isCode('not_found'));
  assert.throws(() => cat.withScores({ a: { lead: 2 } }), isCode('invalid_argument'));
});

test('estimateCostUsd uses per-million prices', () => {
  const p = profile({ routeId: 'a', costPerMillionInputUsd: 3, costPerMillionOutputUsd: 15 });
  assert.equal(estimateCostUsd(p, 1_000_000, 0), 3);
  assert.equal(estimateCostUsd(p, 2000, 1000), (2000 * 3 + 1000 * 15) / 1_000_000);
  assert.equal(estimateCostUsd(p, 0, 0), 0);
});

test('provider registry: register/get/has/list, unknown ⇒ not_found, duplicate ⇒ conflict unless replace', () => {
  const reg = new ProviderRegistry();
  const a = new ScriptedProvider({ providerId: 'a', brain: () => ({ text: 'x' }) });
  const b = new ScriptedProvider({ providerId: 'b', brain: () => ({ text: 'y' }) });
  reg.register(a).register(b);
  assert.equal(reg.get('a'), a);
  assert.equal(reg.has('b'), true);
  assert.equal(reg.has('c'), false);
  assert.deepEqual(reg.list().map((p) => p.providerId), ['a', 'b']);
  assert.throws(() => reg.get('c'), isCode('not_found'));
  const a2 = new ScriptedProvider({ providerId: 'a', brain: () => ({ text: 'z' }) });
  assert.throws(() => reg.register(a2), isCode('conflict'));
  reg.register(a2, { replace: true });
  assert.equal(reg.get('a'), a2);
  const adapters = reg.adapters();
  assert.deepEqual(adapters.map((x) => x.provider), ['a', 'b']);
  assert.equal(adapters[0]!.package, '@hypertest/model#scripted');
  assert.equal(adapters[0]!.version, '0.3.0-dev');
});
