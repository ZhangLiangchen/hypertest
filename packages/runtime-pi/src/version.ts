import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { HypertestError } from '@hypertest/core';

const require = createRequire(import.meta.url);

/**
 * Version of the installed `@earendil-works/pi-agent-core` (its package.json, resolved like the import itself). It is
 * the PiEngine version pinned by RuntimeManifests (I11): a different pi-agent-core never serves a run pinned to another.
 */
export const PI_AGENT_CORE_VERSION: string = (require('@earendil-works/pi-agent-core/package.json') as { version: string }).version;

/**
 * The pi-agent-core version this adapter was written and verified against (package-private; it must equal the exact
 * dependency pin in this package's package.json — checked by test/pi-engine.test.ts). The adapter relies on pi
 * internals of this version (prepare-all-then-execute parallel batches, `finishTurn`, the live tool array), so a PiEngine
 * refuses to exist over any other installed version (pin + adapter, fail closed).
 */
export const SUPPORTED_PI_AGENT_CORE_VERSION = '0.87.1';

/** Throws `precondition_failed` unless `installed` is exactly the supported pi-agent-core version. */
export function assertSupportedPiAgentCore(installed: string, supported: string = SUPPORTED_PI_AGENT_CORE_VERSION): void {
  if (installed !== supported) {
    throw new HypertestError(
      'precondition_failed',
      `@earendil-works/pi-agent-core ${installed} is installed, but @hypertest/runtime-pi is pinned to ${supported}; the pi adapter never runs over an unverified pi-agent-core`,
      { details: { installed, supported } },
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

/** Version of this adapter package (@hypertest/runtime-pi), reported as `PiEngine.adapterVersion`. */
export const RUNTIME_PI_PACKAGE_VERSION: string = readVersion(new URL('../package.json', import.meta.url), '0.0.0');
