import { readFileSync } from 'node:fs';

function readVersion(url: URL, fallback: string): string {
  try {
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : fallback;
  } catch {
    return fallback;
  }
}

/** Version of @hypertest/runtime (package.json), reported as the native engine version in RuntimeManifests. */
export const RUNTIME_PACKAGE_VERSION: string = readVersion(new URL('../package.json', import.meta.url), '0.0.0');
