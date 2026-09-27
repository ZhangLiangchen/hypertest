import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { HypertestError } from '@hypertest/core';

const require = createRequire(import.meta.url);

/**
 * The DeepSeek Harness release train this adapter was written and verified against (package-private). DSH is a Developer
 * Preview without semver guarantees, and the adapter relies on the loop behaviour of exactly this train (one step per
 * turn through `agent/pre-step`, the tool scheduler's per-call parallel pool, `tools/post-execute` blocks, the
 * `LlmAdapter` seam), so a DshEngine refuses to exist over any other installed train (pin + adapter, fail closed).
 */
export const SUPPORTED_DSH_VERSION = '0.1.0-rc.6';

/**
 * Every `@deepseek-ai` package the adapter runs on, pinned exactly: the dsh-* train (the packages the adapter imports and
 * their required peers), the cordis plugin kernel, and the two `@deepseek-ai` libraries the train loads at runtime through
 * version RANGES (`schemastery` — the config/settings schemas of dsh-agent-loop, dsh-tools, dsh-llm, … — and `cosmokit`,
 * cordis's runtime), so a drift anywhere in the loaded `@deepseek-ai` code fails closed. Equal to the exact dependency
 * pins in package.json (tested).
 */
export const DSH_PINS: Readonly<Record<string, string>> = Object.freeze({
  '@deepseek-ai/cordis': '4.0.4',
  '@deepseek-ai/cosmokit': '1.8.5',
  '@deepseek-ai/dsh-agent': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-agent-loop': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-attachment': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-brand': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-code-runtime': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-invariants': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-llm': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-scope': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-session': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-session-persistence': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-settings': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-system-prompt': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-timeout': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-tools': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-typert-protocol': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/dsh-user-approval': SUPPORTED_DSH_VERSION,
  '@deepseek-ai/schemastery': '3.18.4',
});

/** Version of an installed package (its package.json, resolved like an import from this package); undefined when absent. */
export function installedVersion(name: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** Installed versions of every pinned package (undefined = not resolvable from this package). */
export function installedDshVersions(pins: Readonly<Record<string, string>> = DSH_PINS): Record<string, string | undefined> {
  return Object.fromEntries(Object.keys(pins).map((name) => [name, installedVersion(name)]));
}

/**
 * Version of the installed `@deepseek-ai/dsh-agent` (the Agent interface of the pinned train). It is the DshEngine version
 * pinned by RuntimeManifests (I11): a different DSH train never serves a run pinned to another.
 */
export const DSH_AGENT_VERSION: string = installedVersion('@deepseek-ai/dsh-agent') ?? 'not-installed';

/** Throws `precondition_failed` unless every pinned package is installed at exactly its pinned version. */
export function assertSupportedDsh(installed: Readonly<Record<string, string | undefined>>, pins: Readonly<Record<string, string>> = DSH_PINS): void {
  const drifted = Object.entries(pins)
    .filter(([name, version]) => installed[name] !== version)
    .map(([name, pinned]) => ({ name, pinned, installed: installed[name] ?? null }));
  if (drifted.length > 0) {
    throw new HypertestError(
      'precondition_failed',
      `@hypertest/runtime-dsh is pinned to DeepSeek Harness ${SUPPORTED_DSH_VERSION}; drifted: ${drifted.map((d) => `${d.name} ${d.installed ?? '(missing)'} ≠ ${d.pinned}`).join(', ')}. The DSH adapter never runs over an unverified train`,
      { details: { supported: SUPPORTED_DSH_VERSION, drifted } },
    );
  }
}

function readVersion(url: URL, fallback: string): string {
  try {
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : fallback;
  } catch {
    return fallback;
  }
}

/** Version of this adapter package (@hypertest/runtime-dsh), reported as `DshEngine.adapterVersion`. */
export const RUNTIME_DSH_PACKAGE_VERSION: string = readVersion(new URL('../package.json', import.meta.url), '0.0.0');
