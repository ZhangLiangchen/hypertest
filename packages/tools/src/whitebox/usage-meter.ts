import { AsyncLocalStorage } from 'node:async_hooks';
import { stat } from 'node:fs/promises';
import { HypertestError } from '@hypertest/core';
import type { ArtifactRef } from '@hypertest/domain';
import type { ArtifactStore } from '@hypertest/evidence';
import type { SandboxRunner, ToolUsage } from '../contracts.ts';

/**
 * (conformance-5) Resource metering of ONE tool invocation: the wall time of the sandbox processes it ran (`computeMs`)
 * and the bytes it stored in the ArtifactStore (`artifactBytes`, each distinct object once). The ToolRuntime opens a
 * meter per `execute` and runs the call inside it (AsyncLocalStorage); the metered sandbox and artifact store report to
 * whatever meter is current, so every process and every put made on behalf of the call — by the tool, a test runner,
 * evidence recording, output offload — is attributed to it, and concurrent calls never mix.
 *
 * `maxArtifactBytes` is enforced BEFORE a put: a put that would exceed it is refused with `budget_exhausted` (nothing is
 * stored), so an exhausted artifact budget is a typed outcome, never a silent overrun.
 */
export class UsageMeter {
  computeMs = 0;
  artifactBytes = 0;
  readonly #seen = new Set<string>();
  readonly maxArtifactBytes: number | undefined;

  constructor(limits?: { maxArtifactBytes?: number }) {
    const max = limits?.maxArtifactBytes;
    if (max !== undefined && !(typeof max === 'number' && Number.isFinite(max) && max >= 0)) {
      throw new HypertestError('invalid_argument', `limits.maxArtifactBytes must be a finite number ≥ 0 (got ${String(max)})`);
    }
    this.maxArtifactBytes = max;
  }

  addCompute(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.computeMs += ms;
  }

  /** Refuses a put of `size` bytes that would exceed the call's artifact budget. */
  admitPut(size: number, what: string): void {
    if (this.maxArtifactBytes === undefined) return;
    if (this.artifactBytes + size > this.maxArtifactBytes) {
      throw new HypertestError('budget_exhausted', `artifact budget exhausted: storing ${what} (${size} bytes) would exceed the ${this.maxArtifactBytes} bytes left for this call (${this.artifactBytes} already stored)`, {
        details: { dimension: 'artifactBytes', requested: size, stored: this.artifactBytes, limit: this.maxArtifactBytes },
      });
    }
  }

  recordPut(ref: ArtifactRef): void {
    if (this.#seen.has(ref.sha256)) return;
    this.#seen.add(ref.sha256);
    if (Number.isFinite(ref.size) && ref.size > 0) this.artifactBytes += ref.size;
  }

  usage(): ToolUsage {
    return { computeMs: Math.round(this.computeMs), artifactBytes: this.artifactBytes };
  }
}

const current = new AsyncLocalStorage<UsageMeter>();

/** Runs `fn` with `meter` as the current usage meter. */
export function runMetered<T>(meter: UsageMeter, fn: () => Promise<T>): Promise<T> {
  return current.run(meter, fn);
}

/** The meter of the tool call this code runs for (undefined outside a metered call). */
export function currentMeter(): UsageMeter | undefined {
  return current.getStore();
}

const METERED = Symbol.for('hypertest.tools.metered');

/**
 * A SandboxRunner that reports each process's wall time (`ProcessResult.durationMs`) to the current meter. Wrapping an
 * already metered runner returns it unchanged (never counted twice).
 */
export function meteredSandbox(inner: SandboxRunner): SandboxRunner {
  if ((inner as unknown as Record<symbol, unknown>)[METERED]) return inner;
  const wrapped: SandboxRunner & { [METERED]: true } = {
    [METERED]: true,
    async run(ws, command, options) {
      const meter = current.getStore();
      const started = performance.now();
      try {
        const r = await inner.run(ws, command, options);
        meter?.addCompute(typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0 ? r.durationMs : performance.now() - started);
        return r;
      } catch (e) {
        meter?.addCompute(performance.now() - started);
        throw e;
      }
    },
  };
  if (inner.kind !== undefined) (wrapped as { kind?: SandboxRunner['kind'] }).kind = inner.kind;
  if (inner.available) wrapped.available = () => inner.available!();
  return wrapped;
}

/**
 * An ArtifactStore that meters (and bounds) the puts made inside a metered call; reads pass through. Outside a metered
 * call it is the inner store.
 */
export function meteredArtifacts(inner: ArtifactStore): ArtifactStore {
  if ((inner as unknown as Record<symbol, unknown>)[METERED]) return inner;
  const wrapped: ArtifactStore & { [METERED]: true } = {
    [METERED]: true,
    kind: inner.kind,
    async put(data, options) {
      const meter = current.getStore();
      meter?.admitPut(typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength, `an artifact (${options.mimeType})`);
      const ref = await inner.put(data, options);
      meter?.recordPut(ref);
      return ref;
    },
    async putFile(path, options) {
      const meter = current.getStore();
      if (meter?.maxArtifactBytes !== undefined) meter.admitPut((await stat(path)).size, `file ${path}`);
      const ref = await inner.putFile(path, options);
      meter?.recordPut(ref);
      return ref;
    },
    get: (ref) => inner.get(ref),
    getText: (ref, maxBytes) => inner.getText(ref, maxBytes),
    exists: (sha256) => inner.exists(sha256),
    verify: (ref) => inner.verify(ref),
  };
  if (inner.head) wrapped.head = (ref) => inner.head!(ref);
  return wrapped;
}
