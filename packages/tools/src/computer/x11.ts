import { connect, type Socket } from 'node:net';
import { deflateSync, crc32 } from 'node:zlib';
import { HypertestError } from '@hypertest/core';

/**
 * A minimal native X11 client (no Xlib, no xdotool): the connection setup over the display's unix socket, the XTEST
 * extension's FakeInput (pointer motion, buttons, keys), GetKeyboardMapping (text → keycodes) and GetImage (the root
 * window as a PNG). Enough to drive a desktop — e.g. Xvfb — the way a user would. Authentication: none (an X server
 * started for the test desktop with `-ac`, or with a MIT-MAGIC-COOKIE-1 passed as `cookie`).
 */

const enc = new TextEncoder();
const pad4 = (n: number) => (4 - (n % 4)) % 4;

export interface X11Screen {
  root: number;
  width: number;
  height: number;
  depth: number;
}

interface PendingReply {
  resolve(b: Buffer): void;
  reject(e: Error): void;
}

/** Parses `:N` / `:N.S` / `unix:N` into the unix socket path of display N. */
export function x11SocketPath(display: string): string {
  const m = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display.trim());
  if (!m) throw new HypertestError('invalid_argument', `display ${JSON.stringify(display)} is not a local X display (:N)`);
  return `/tmp/.X11-unix/X${m[1]}`;
}

export class X11Connection {
  readonly #socket: Socket;
  #buf = Buffer.alloc(0);
  #seq = 0;
  readonly #pending = new Map<number, PendingReply>();
  #setup: ((b: Buffer) => void) | undefined;
  #error: Error | undefined;
  screen!: X11Screen;
  minKeycode = 8;
  maxKeycode = 255;
  #xtest: number | undefined;
  #keymap: { perCode: number; syms: number[] } | undefined;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('data', (c: Buffer) => this.#onData(c));
    socket.on('error', (e) => this.#fail(e));
    socket.on('close', () => this.#fail(new HypertestError('unavailable', 'the X connection closed')));
  }

  static async open(display: string, options: { cookie?: Buffer; timeoutMs?: number } = {}): Promise<X11Connection> {
    const path = x11SocketPath(display);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(path);
      const t = setTimeout(() => {
        s.destroy();
        reject(new HypertestError('unavailable', `X display ${display} did not answer within ${options.timeoutMs ?? 5000} ms`));
      }, options.timeoutMs ?? 5000);
      s.once('connect', () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(t);
        reject(new HypertestError('unavailable', `X display ${display} is not reachable (${path}): ${e.message}`));
      });
    });
    const conn = new X11Connection(socket);
    await conn.#handshake(options.cookie);
    return conn;
  }

  async #handshake(cookie: Buffer | undefined): Promise<void> {
    const name = cookie ? enc.encode('MIT-MAGIC-COOKIE-1') : new Uint8Array(0);
    const data = cookie ?? Buffer.alloc(0);
    const head = Buffer.alloc(12);
    head.write('l', 0, 'latin1');
    head.writeUInt16LE(11, 2);
    head.writeUInt16LE(0, 4);
    head.writeUInt16LE(name.length, 6);
    head.writeUInt16LE(data.length, 8);
    const reply = new Promise<Buffer>((resolve) => (this.#setup = resolve));
    this.#socket.write(Buffer.concat([head, Buffer.from(name), Buffer.alloc(pad4(name.length)), data, Buffer.alloc(pad4(data.length))]));
    const r = await reply;
    if (r[0] !== 1) {
      const reasonLen = r[1]!;
      throw new HypertestError('permission_denied', `the X server refused the connection: ${r.subarray(8, 8 + reasonLen).toString('latin1')}`);
    }
    const vendorLen = r.readUInt16LE(24);
    const formats = r[29]!;
    this.minKeycode = r[34]!;
    this.maxKeycode = r[35]!;
    let off = 40 + vendorLen + pad4(vendorLen) + formats * 8;
    const root = r.readUInt32LE(off);
    const width = r.readUInt16LE(off + 20);
    const height = r.readUInt16LE(off + 22);
    const depth = r[off + 38]!;
    off += 40;
    this.screen = { root, width, height, depth };
  }

  #fail(e: Error): void {
    if (this.#error) return;
    this.#error = e;
    for (const p of this.#pending.values()) p.reject(e);
    this.#pending.clear();
  }

  #onData(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    if (this.#setup) {
      if (this.#buf.length < 8) return;
      const total = 8 + this.#buf.readUInt16LE(6) * 4;
      if (this.#buf.length < total) return;
      const setup = this.#buf.subarray(0, total);
      this.#buf = this.#buf.subarray(total);
      const done = this.#setup;
      this.#setup = undefined;
      done(Buffer.from(setup));
    }
    for (;;) {
      if (this.#buf.length < 32) return;
      const kind = this.#buf[0]!;
      const total = kind === 1 ? 32 + this.#buf.readUInt32LE(4) * 4 : 32;
      if (this.#buf.length < total) return;
      const msg = Buffer.from(this.#buf.subarray(0, total));
      this.#buf = this.#buf.subarray(total);
      const seq = msg.readUInt16LE(2);
      if (kind === 0) {
        const p = this.#pending.get(seq);
        if (p) {
          this.#pending.delete(seq);
          p.reject(new HypertestError('unavailable', `X error ${msg[1]} (request opcode ${msg[10]}.${msg.readUInt16LE(8)})`));
        }
      } else if (kind === 1) {
        const p = this.#pending.get(seq);
        if (p) {
          this.#pending.delete(seq);
          p.resolve(msg);
        }
      }
      // events (kind ≥ 2) are not selected: ignored
    }
  }

  /** Sends one request; resolves with its reply when `reply` (else after the server processed it: a GetInputFocus round trip). */
  #request(body: Buffer, reply: boolean): Promise<Buffer> {
    if (this.#error) return Promise.reject(this.#error);
    const seq = (this.#seq = (this.#seq + 1) & 0xffff);
    this.#socket.write(body);
    if (!reply) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => this.#pending.set(seq, { resolve, reject }));
  }

  /** Waits until every request sent so far was processed (GetInputFocus round trip). */
  sync(): Promise<Buffer> {
    const b = Buffer.alloc(4);
    b[0] = 43;
    b.writeUInt16LE(1, 2);
    return this.#request(b, true);
  }

  async #xtestOpcode(): Promise<number> {
    if (this.#xtest !== undefined) return this.#xtest;
    const name = enc.encode('XTEST');
    const b = Buffer.alloc(8 + name.length + pad4(name.length));
    b[0] = 98;
    b.writeUInt16LE(b.length / 4, 2);
    b.writeUInt16LE(name.length, 4);
    Buffer.from(name).copy(b, 8);
    const r = await this.#request(b, true);
    if (r[8] !== 1) throw new HypertestError('unsupported', 'the X server has no XTEST extension (input cannot be injected)');
    this.#xtest = r[9]!;
    return this.#xtest;
  }

  async #fake(type: number, detail: number, x = 0, y = 0): Promise<void> {
    const op = await this.#xtestOpcode();
    const b = Buffer.alloc(36);
    b[0] = op;
    b[1] = 2;
    b.writeUInt16LE(9, 2);
    b[4] = type;
    b[5] = detail;
    b.writeUInt32LE(0, 8); // CurrentTime
    b.writeUInt32LE(type === 6 ? this.screen.root : 0, 12);
    b.writeInt16LE(x, 24);
    b.writeInt16LE(y, 26);
    await this.#request(b, false);
  }

  async move(x: number, y: number): Promise<void> {
    await this.#fake(6, 0, x, y);
    await this.sync();
  }

  async click(x: number, y: number, button: 1 | 2 | 3): Promise<void> {
    await this.#fake(6, 0, x, y);
    await this.#fake(4, button);
    await this.#fake(5, button);
    await this.sync();
  }

  async #keymap_(): Promise<{ perCode: number; syms: number[] }> {
    if (this.#keymap) return this.#keymap;
    const count = this.maxKeycode - this.minKeycode + 1;
    const b = Buffer.alloc(8);
    b[0] = 101;
    b.writeUInt16LE(2, 2);
    b[4] = this.minKeycode;
    b[5] = count;
    const r = await this.#request(b, true);
    const perCode = r[1]!;
    const syms: number[] = [];
    for (let i = 0; i < count * perCode; i++) syms.push(r.readUInt32LE(32 + i * 4));
    this.#keymap = { perCode, syms };
    return this.#keymap;
  }

  /** The keycode producing `keysym` and whether Shift is needed; undefined when no key produces it. */
  async keycodeFor(keysym: number): Promise<{ code: number; shift: boolean } | undefined> {
    const { perCode, syms } = await this.#keymap_();
    for (let i = 0; i * perCode < syms.length; i++) {
      if (syms[i * perCode] === keysym) return { code: this.minKeycode + i, shift: false };
    }
    for (let i = 0; i * perCode < syms.length; i++) {
      if (perCode > 1 && syms[i * perCode + 1] === keysym) return { code: this.minKeycode + i, shift: true };
    }
    return undefined;
  }

  async keys(keysyms: number[]): Promise<void> {
    const codes: number[] = [];
    for (const ks of keysyms) {
      const k = await this.keycodeFor(ks);
      if (!k) throw new HypertestError('invalid_argument', `no key produces keysym 0x${ks.toString(16)} on this display`);
      if (k.shift && !codes.includes(-1)) codes.push(-1);
      codes.push(k.code);
    }
    const shift = codes.includes(-1) ? (await this.keycodeFor(0xffe1))?.code : undefined;
    const real = codes.map((c) => (c === -1 ? shift! : c));
    for (const c of real) await this.#fake(2, c);
    for (const c of [...real].reverse()) await this.#fake(3, c);
    await this.sync();
  }

  async typeText(text: string): Promise<void> {
    for (const ch of text) {
      const ks = charKeysym(ch);
      if (ks === undefined) throw new HypertestError('invalid_argument', `character ${JSON.stringify(ch)} cannot be typed (Latin-1, newline and tab only)`);
      await this.keys([ks]);
    }
  }

  /** The root window as RGB rows (ZPixmap GetImage, 24/32 bpp). */
  async rootImage(): Promise<{ width: number; height: number; rgb: Buffer }> {
    const { width, height, root } = this.screen;
    const rows: Buffer[] = [];
    // in bands: one reply must stay below the server's maximum request length
    const band = Math.max(1, Math.floor((256 * 1024) / Math.max(1, width * 4)));
    for (let y = 0; y < height; y += band) {
      const h = Math.min(band, height - y);
      const b = Buffer.alloc(20);
      b[0] = 73;
      b[1] = 2;
      b.writeUInt16LE(5, 2);
      b.writeUInt32LE(root, 4);
      b.writeInt16LE(0, 8);
      b.writeInt16LE(y, 10);
      b.writeUInt16LE(width, 12);
      b.writeUInt16LE(h, 14);
      b.writeUInt32LE(0xffffffff, 16);
      const r = await this.#request(b, true);
      const data = r.subarray(32);
      const bpp = data.length / (width * h) >= 4 ? 4 : 3;
      const stride = data.length / h;
      for (let row = 0; row < h; row++) {
        const out = Buffer.alloc(width * 3);
        for (let x = 0; x < width; x++) {
          const p = row * stride + x * bpp;
          out[x * 3] = data[p + 2]!;
          out[x * 3 + 1] = data[p + 1]!;
          out[x * 3 + 2] = data[p]!;
        }
        rows.push(out);
      }
    }
    return { width, height, rgb: Buffer.concat(rows) };
  }

  close(): void {
    this.#socket.destroy();
  }
}

/** keysym of one character: Latin-1 printable code points map 1:1; newline ⇒ Return, tab ⇒ Tab. */
export function charKeysym(ch: string): number | undefined {
  if (ch === '\n' || ch === '\r') return 0xff0d;
  if (ch === '\t') return 0xff09;
  const c = ch.codePointAt(0)!;
  if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) return c;
  return undefined;
}

const NAMED_KEYS: Readonly<Record<string, number>> = {
  ctrl: 0xffe3, control: 0xffe3, shift: 0xffe1, alt: 0xffe9, super: 0xffeb, meta: 0xffe7,
  return: 0xff0d, enter: 0xff0d, tab: 0xff09, escape: 0xff1b, esc: 0xff1b, backspace: 0xff08, delete: 0xffff, space: 0x20,
  home: 0xff50, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, pageup: 0xff55, pagedown: 0xff56, end: 0xff57, insert: 0xff63,
};

/** keysyms of a key combination like `ctrl+a`, `Return`, `shift+Tab`, `F5`. */
export function comboKeysyms(combo: string): number[] {
  const parts = combo.split('+').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0 || parts.length > 4) throw new HypertestError('invalid_argument', `key combination ${JSON.stringify(combo)} must have 1-4 keys joined by +`);
  return parts.map((p) => {
    const named = NAMED_KEYS[p.toLowerCase()];
    if (named !== undefined) return named;
    const f = /^f(\d{1,2})$/i.exec(p);
    if (f && Number(f[1]) >= 1 && Number(f[1]) <= 12) return 0xffbe + Number(f[1]) - 1;
    if ([...p].length === 1) {
      const ks = charKeysym(p.toLowerCase());
      if (ks !== undefined) return ks;
    }
    throw new HypertestError('invalid_argument', `unknown key ${JSON.stringify(p)} in ${JSON.stringify(combo)}`);
  });
}

/** A PNG (8-bit RGB, no interlace) of RGB rows. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
