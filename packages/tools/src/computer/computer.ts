import { execFile } from 'node:child_process';
import { HypertestError, abortReason, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { ToolContext, ToolOutcome, ToolSpec } from '../contracts.ts';
import { runCommand } from '../blackbox/common.ts';
import { X11Connection, charKeysym, comboKeysyms, encodePng } from './x11.ts';

/**
 * Computer use (technology-selection §Tool Runtime "Computer Use Tool"): pixel-level control of a desktop for what neither
 * the DOM (browser.*) nor an API can reach — the last resort of the vision/GUI tester. Pluggable backends:
 *  - `x11`: a native X11 client (XTEST input + GetImage screenshots) for an X server such as Xvfb — no external tool;
 *  - `xdotool`: the xdotool CLI for input and a screenshot command (default ImageMagick `import -window root png:-`);
 *  - `fake`: an in-memory desktop for tests (documented test backend: it records actions, its screenshots are synthetic).
 * Tools: `computer.screenshot` (read; `screenshot` evidence), `computer.click`, `computer.type`, `computer.key` (external
 * effects on the desktop: ledgered by the runtime, each recorded as `ui-action` evidence with a screenshot after it). The
 * desktop is the resource `desktop/<displayId>`, granted by the operator to the permission profiles in `grantTo`
 * (ToolSpec.grant); its environment class is the operator's (`environmentClass`, default local: a display of this host).
 */

export interface ComputerBackend {
  readonly kind: 'x11' | 'xdotool' | 'fake';
  size(signal: AbortSignal): Promise<{ width: number; height: number }>;
  screenshot(signal: AbortSignal): Promise<Uint8Array>;
  click(x: number, y: number, button: 'left' | 'middle' | 'right', signal: AbortSignal): Promise<void>;
  type(text: string, signal: AbortSignal): Promise<void>;
  key(combo: string, signal: AbortSignal): Promise<void>;
  close?(): Promise<void>;
}

const BUTTONS = { left: 1, middle: 2, right: 3 } as const;

/** Runs a command whose stdout is binary (a PNG screenshot). */
function binaryCommand(file: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ exitCode: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, signal, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', windowsHide: true }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
      resolve({ exitCode: e ? (typeof e.code === 'number' ? e.code : 127) : 0, stdout: Buffer.from(stdout ?? Buffer.alloc(0)), stderr: Buffer.from(stderr ?? Buffer.alloc(0)).toString('utf8') || (e?.message ?? '') });
    });
  });
}

/** The native X11 backend (XTEST): one connection, opened on first use and re-opened after a failure. */
export function x11Backend(options: { display: string; cookie?: Buffer }): ComputerBackend {
  let conn: Promise<X11Connection> | undefined;
  const get = (): Promise<X11Connection> => {
    conn ??= X11Connection.open(options.display, options.cookie ? { cookie: options.cookie } : {});
    conn.catch(() => (conn = undefined));
    return conn;
  };
  const guarded = async <T>(f: (c: X11Connection) => Promise<T>): Promise<T> => {
    const c = await get();
    try {
      return await f(c);
    } catch (e) {
      c.close();
      conn = undefined;
      throw e;
    }
  };
  return {
    kind: 'x11',
    size: () => guarded(async (c) => ({ width: c.screen.width, height: c.screen.height })),
    screenshot: () => guarded(async (c) => {
      const img = await c.rootImage();
      return new Uint8Array(encodePng(img.width, img.height, img.rgb));
    }),
    click: (x, y, button) => guarded((c) => c.click(x, y, BUTTONS[button])),
    type: (text) => guarded((c) => c.typeText(text)),
    key: (combo) => guarded((c) => c.keys(comboKeysyms(combo))),
    async close() {
      const c = conn;
      conn = undefined;
      if (c) (await c.catch(() => undefined))?.close();
    },
  };
}

/** The xdotool backend: input through the xdotool CLI, screenshots through `screenshotCommand` (PNG on stdout). */
export function xdotoolBackend(options: { display: string; xdotool?: string; screenshotCommand?: string[] }): ComputerBackend {
  const env = { ...process.env, DISPLAY: options.display };
  const xdotool = options.xdotool ?? 'xdotool';
  const run = async (args: string[], signal: AbortSignal): Promise<string> => {
    const r = await runCommand(xdotool, args, { timeoutMs: 30_000, signal, env });
    if (r.exitCode !== 0) throw new HypertestError('unavailable', `xdotool ${args[0]} failed (exit ${r.exitCode}${r.spawnError ? `, ${r.spawnError}` : ''}): ${r.stderr.trim().slice(0, 500)}`);
    return r.stdout;
  };
  return {
    kind: 'xdotool',
    async size(signal) {
      const out = await run(['getdisplaygeometry'], signal);
      const [w, h] = out.trim().split(/\s+/).map(Number);
      if (!Number.isFinite(w) || !Number.isFinite(h)) throw new HypertestError('unavailable', `xdotool getdisplaygeometry answered ${JSON.stringify(out.trim())}`);
      return { width: w!, height: h! };
    },
    async screenshot(signal) {
      const [cmd, ...args] = options.screenshotCommand ?? ['import', '-window', 'root', 'png:-'];
      const r = await binaryCommand(cmd!, args, env, signal);
      if (r.exitCode !== 0 || r.stdout.subarray(0, 4).toString('latin1') !== '\x89PNG') throw new HypertestError('unavailable', `screenshot command ${cmd} failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 300)}`);
      return new Uint8Array(r.stdout);
    },
    async click(x, y, button, signal) {
      await run(['mousemove', '--sync', String(x), String(y), 'click', String(BUTTONS[button])], signal);
    },
    async type(text, signal) {
      await run(['type', '--delay', '1', '--', text], signal);
    },
    async key(combo, signal) {
      comboKeysyms(combo); // validated: never an xdotool option or an arbitrary keysym string from the model
      await run(['key', '--clearmodifiers', '--', combo], signal);
    },
  };
}

/** The documented fake backend (tests only): an in-memory 320×200 desktop recording every action. */
export function fakeComputerBackend(): ComputerBackend & { actions: Array<Record<string, JsonValue>> } {
  const actions: Array<Record<string, JsonValue>> = [];
  const width = 320;
  const height = 200;
  return {
    kind: 'fake',
    actions,
    async size() {
      return { width, height };
    },
    async screenshot() {
      // a gradient whose last row encodes the number of actions so far (distinct after each action)
      const rgb = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 3;
        rgb[p] = x % 256;
        rgb[p + 1] = y % 256;
        rgb[p + 2] = y === height - 1 ? actions.length % 256 : 128;
      }
      return new Uint8Array(encodePng(width, height, rgb));
    },
    async click(x, y, button) {
      actions.push({ action: 'click', x, y, button });
    },
    async type(text) {
      actions.push({ action: 'type', text });
    },
    async key(combo) {
      comboKeysyms(combo);
      actions.push({ action: 'key', combo });
    },
  };
}

export interface ComputerToolsOptions {
  backend: ComputerBackend;
  /** The desktop's resource id (`desktop/<displayId>`). */
  displayId: string;
  /** Environment class of the desktop (policy input; default `local`: a display of this host, e.g. Xvfb). */
  environmentClass?: string;
  /** Permission profiles granted `desktop/<displayId>` (default test_executor). */
  grantTo?: string[];
}

const COORD: JsonSchema = { type: 'integer', minimum: 0, maximum: 16_384 };

/** The computer.* tools over one desktop. */
export function computerTools(options: ComputerToolsOptions): ToolSpec[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(options.displayId)) throw new HypertestError('invalid_argument', `displayId ${JSON.stringify(options.displayId)} is not a valid resource segment`);
  const resource = `desktop/${options.displayId}`;
  const grant = { scopes: [resource], profiles: [...(options.grantTo ?? ['test_executor'])] };
  const environmentClass = options.environmentClass ?? 'local';
  const backend = options.backend;
  const common = { resources: () => [resource], environmentClass: () => environmentClass, grant, timeoutMs: 60_000 };

  const shot = async (ctx: ToolContext, summary: string, parents?: string[]) => {
    const png = await backend.screenshot(ctx.signal);
    return ctx.recordEvidence({
      evidenceType: 'screenshot', data: png, mimeType: 'image/png', summary: summary.slice(0, 500),
      structured: { desktop: options.displayId, backend: backend.kind, bytes: png.byteLength }, provenance: { target: resource },
      ...(parents ? { parentEvidenceIds: parents } : {}),
    });
  };
  const fail = (e: unknown, ctx: ToolContext): ToolOutcome => {
    if (ctx.signal.aborted) throw abortReason(ctx.signal);
    return { status: 'failed', error: { code: e instanceof HypertestError ? e.code : 'unavailable', message: (e as Error).message } };
  };
  /** One input action: performed, recorded as ui-action evidence, followed by a screenshot of its result. */
  const act = async (ctx: ToolContext, action: Record<string, JsonValue>, perform: () => Promise<void>): Promise<ToolOutcome> => {
    try {
      await perform();
      const ev = await ctx.recordEvidence({
        evidenceType: 'ui-action', data: JSON.stringify(action), mimeType: 'application/json', summary: `${action['action']} on ${resource}: ${JSON.stringify(action).slice(0, 200)}`,
        structured: { desktop: options.displayId, backend: backend.kind, ...action }, provenance: { target: resource }, ...(ctx.operationId !== undefined ? { operationId: ctx.operationId } : {}),
      });
      const after = await shot(ctx, `screenshot after ${action['action']} on ${resource}`, [ev.evidenceId]);
      return { status: 'success', structured: { ...action, evidenceId: ev.evidenceId, screenshotEvidenceId: after.evidenceId } as JsonValue, evidenceRefs: [ev.evidenceId, after.evidenceId] };
    } catch (e) {
      return fail(e, ctx);
    }
  };
  const inside = async (x: number, y: number, ctx: ToolContext) => {
    const { width, height } = await backend.size(ctx.signal);
    if (x >= width || y >= height) throw new HypertestError('invalid_argument', `(${x}, ${y}) is outside the ${width}×${height} desktop`);
  };

  return [
    {
      id: 'computer.screenshot', title: 'Computer: screenshot', description: `Screenshot of the desktop ${options.displayId} (screenshot evidence). Use it to locate what you will click; prefer browser.* / DOM whenever they can reach the element.`,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} }, effect: 'read', riskClass: 'low', evidenceTypes: ['screenshot'], ...common,
      async execute(_input, ctx) {
        try {
          const { width, height } = await backend.size(ctx.signal);
          const ev = await shot(ctx, `screenshot of ${resource} (${width}×${height})`);
          return { status: 'success', structured: { width, height, evidenceId: ev.evidenceId }, evidenceRefs: [ev.evidenceId] };
        } catch (e) {
          return fail(e, ctx);
        }
      },
    },
    {
      id: 'computer.click', title: 'Computer: click', description: 'Click at pixel coordinates of the desktop (from a computer.screenshot you judged). Last resort after DOM and API.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: COORD, y: COORD, button: { type: 'string', enum: ['left', 'middle', 'right'] } } },
      effect: 'external', riskClass: 'medium', evidenceTypes: ['ui-action', 'screenshot'], ...common,
      async execute(input: { x: number; y: number; button?: 'left' | 'middle' | 'right' }, ctx) {
        return act(ctx, { action: 'click', x: input.x, y: input.y, button: input.button ?? 'left' }, async () => {
          await inside(input.x, input.y, ctx);
          await backend.click(input.x, input.y, input.button ?? 'left', ctx.signal);
        });
      },
    },
    {
      id: 'computer.type', title: 'Computer: type text', description: 'Type text into the focused element of the desktop (Latin-1, newline, tab).',
      inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } } },
      effect: 'external', riskClass: 'medium', evidenceTypes: ['ui-action', 'screenshot'], ...common,
      async execute(input: { text: string }, ctx) {
        for (const ch of input.text) if (charKeysym(ch) === undefined) return { status: 'failed', error: { code: 'invalid_argument', message: `character ${JSON.stringify(ch)} cannot be typed` } };
        // the typed text is evidence: secret-named values never belong in it (credentials are not typed by agents)
        return act(ctx, { action: 'type', text: ctx.secrets ? ctx.secrets.redact(input.text) : input.text }, () => backend.type(input.text, ctx.signal));
      },
    },
    {
      id: 'computer.key', title: 'Computer: key combination', description: 'Press a key or combination on the desktop (e.g. Return, Tab, ctrl+a, shift+Tab, F5).',
      inputSchema: { type: 'object', additionalProperties: false, required: ['keys'], properties: { keys: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9+]+$' } } },
      effect: 'external', riskClass: 'medium', evidenceTypes: ['ui-action', 'screenshot'], ...common,
      async execute(input: { keys: string }, ctx) {
        try {
          comboKeysyms(input.keys);
        } catch (e) {
          return fail(e, ctx);
        }
        return act(ctx, { action: 'key', keys: input.keys }, () => backend.key(input.keys, ctx.signal));
      },
    },
  ] as ToolSpec[];
}
