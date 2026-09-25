import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelPolicy } from '@hypertest/domain';
import type { ModelCapabilityProfile, RouteRequest } from '../src/index.ts';

export function profile(overrides: Partial<ModelCapabilityProfile> & { routeId: string }): ModelCapabilityProfile {
  return {
    provider: 'scripted',
    model: `${overrides.routeId}-model`,
    capabilities: ['tool_use', 'parallel_tool_calls', 'structured_output', 'reasoning', 'long_context'],
    structuredOutput: 'native',
    reasoning: 'visible',
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    continuationCompatibilityClass: `cc:${overrides.routeId}`,
    maxDataClassification: 'confidential',
    quality: { default: 0.7 },
    toolReliability: 0.8,
    costPerMillionInputUsd: 1,
    costPerMillionOutputUsd: 4,
    typicalLatencyMs: 1000,
    maxActionRisk: 'high',
    enabled: true,
    ...overrides,
  };
}

export function routeRequest(overrides: Partial<RouteRequest> = {}, policy: ModelPolicy = {}): RouteRequest {
  return {
    runId: 'run_1',
    agentId: 'agt_1',
    role: 'analyst',
    taskType: 'analyze',
    policy,
    requiredCapabilities: [],
    actionRisk: 'low',
    dataClassification: 'internal',
    contextTokensEstimate: 1000,
    contextSnapshotId: 'ctx_1',
    ...overrides,
  };
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

export interface MockServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

/** Local HTTP mock (127.0.0.1, ephemeral port). The handler receives the parsed JSON body. */
export async function startMockServer(handler: (req: CapturedRequest, res: ServerResponse) => void | Promise<void>): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = { __raw: text };
      }
      const captured: CapturedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      requests.push(captured);
      Promise.resolve(handler(captured, res)).catch((e: unknown) => {
        if (!res.headersSent) res.writeHead(599);
        res.end(String(e));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Writes an OpenAI-style SSE stream (`data: <json>` events, optional `[DONE]`). */
export async function writeSse(res: ServerResponse, events: Array<unknown>, options: { done?: boolean; delayMs?: number; split?: boolean } = {}): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) {
    const frame = `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`;
    if (options.split) {
      // Exercise chunk-boundary handling: split every frame in the middle (including CRLF-free cuts).
      const mid = Math.floor(frame.length / 2);
      res.write(frame.slice(0, mid));
      await pause(1);
      res.write(frame.slice(mid));
    } else res.write(frame);
    if (options.delayMs) await pause(options.delayMs);
  }
  if (options.done !== false) res.write('data: [DONE]\n\n');
  res.end();
}

/** Writes an Anthropic-style SSE stream (`event: <type>` + `data: <json>`). */
export function writeAnthropicSse(res: ServerResponse, events: Array<Record<string, unknown>>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${String(e['type'])}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`);
  res.end();
}

export function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Deterministic PRNG (mulberry32) for seeded property tests. */
export function rng(seed: number): { next(): number; int(lo: number, hi: number): number; pick<T>(xs: readonly T[]): T; bool(p?: number): boolean } {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
    bool: (p = 0.5) => next() < p,
  };
}
