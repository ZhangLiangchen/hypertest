/**
 * OS isolation of the local sandbox (security-2, H1): a sandboxed command whose profile does not allow the open network
 * runs in fresh, unprivileged Linux namespaces created with util-linux `unshare`.
 *
 * Strategies, probed once per process (the first that works wins):
 *   1. `userns_jail` — `unshare --user --map-root-user --net --mount` + a python3 helper that
 *        - brings the namespace's own loopback up (servers a test starts on 127.0.0.1 keep working),
 *        - creates a PID namespace with a fresh `/proc` (the Hypertest process — its environment with API keys, its
 *          `/proc/<pid>/root` view of the host — is invisible), its init reaping and forwarding signals,
 *        - hides the configured paths (an empty read-only tmpfs over a directory, `/dev/null` over a file: the
 *          capability secret, signing keys, the store, the artifacts) and every other workspace (a tmpfs over the
 *          workspaces directory that re-exposes only the command's own root and temp dir),
 *        - re-enters a nested user namespace mapped back to the caller's uid/gid, so the command keeps its identity and
 *          holds no capability over the network, mount and PID namespaces (the mounts are locked: it cannot unmount
 *          them, not even from a namespace of its own),
 *      and reports the command's exit status or terminating signal to the outer helper, which exits the same way;
 *   2. `userns_loopback` — the same without the PID/mount namespaces (the loopback up, the identity restored);
 *   3. `userns` — `unshare --user --map-current-user --net` (no python3: the loopback stays down — no network at all);
 *   4. `userns_root` — `unshare --user --map-root-user --net` (older util-linux: loopback down, uid 0 in the namespace,
 *      no host privilege).
 * Strategies 2–4 isolate the network only (`jail: false`: hidden paths are not hidden — `hypertest doctor` says so).
 * When none works (no util-linux `unshare`, unprivileged user namespaces disabled, another OS) isolation is UNAVAILABLE
 * and the local sandbox refuses every profile but `network: 'open'` (fail closed, never a silent downgrade).
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** What a command's namespaces hide (jail strategy only). */
export interface IsolationSpec {
  /** Working directory of the command (re-entered after the mounts). */
  cwd: string;
  /** Paths hidden from the command (a directory ⇒ empty read-only tmpfs; a file ⇒ `/dev/null`). */
  hide?: readonly string[];
  /** A directory whose content is hidden except `keep` (the command's own workspace root and temp dir). */
  privateDir?: { dir: string; keep: readonly string[] };
  /**
   * Allowlisted egress (jail strategy only): inside the namespace a listener on `host:port` (a loopback address) relays
   * every connection to the unix socket `socket`, which the sandbox serves from outside by connecting to the real
   * endpoint. Nothing else is reachable.
   */
  egress?: ReadonlyArray<{ host: string; port: number; socket: string }>;
  /**
   * (wave 3, row 250) Directories bound read-only for the command (jail strategy only): the workspace root of a read-only
   * workspace (a shared snapshot, the `read_only` sandbox tier) — the command can read it, never change it.
   */
  readOnly?: readonly string[];
}

/** How the local sandbox isolates a command. */
export type NetworkIsolation =
  | {
      available: true;
      strategy: 'userns_jail' | 'userns_loopback' | 'userns' | 'userns_root';
      /** The command's namespace has a working loopback interface. */
      loopback: boolean;
      /** PID + mount namespaces: `/proc` shows only the command's processes; hidden paths and other workspaces are hidden. */
      jail: boolean;
      wrap(argv: readonly string[], spec: IsolationSpec): string[];
    }
  | { available: false; reason: string };

/** Options of `probeNetworkIsolation` (tests point them at missing programs to exercise the fail-closed path). */
export interface NetworkIsolationOptions {
  /** util-linux `unshare` (name looked up in `PATH`, or a path). Default `unshare`. */
  unshare?: string;
  /** python3 for the helper (name or path; `false` disables the helper). Default `python3`. */
  python?: string | false;
  /** PATH used to resolve both (default: this process's PATH). */
  path?: string;
}

/**
 * The helper, run as root of the fresh user namespace (which owns the fresh network and mount namespaces).
 * argv: <config json> <program> <args…>; config { uid, gid, jail, cwd, hide, private: { dir, keep } | null }.
 * Exit 125 + a `hypertest sandbox:` line on stderr when the isolation itself fails; 127 when the program cannot start.
 */
const HELPER = String.raw`
import ctypes, fcntl, json, os, signal, socket, struct, sys, threading
cfg = json.loads(sys.argv[1]); argv = sys.argv[2:]
libc = ctypes.CDLL(None, use_errno=True)
libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
RDONLY, NOSUID, NODEV, NOEXEC, REMOUNT, BIND, REC = 1, 2, 4, 8, 32, 4096, 16384
FWD = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT, signal.SIGUSR1, signal.SIGUSR2)
def fail(msg):
    os.write(2, ('hypertest sandbox: %s\n' % msg).encode()); os._exit(125)
def ok(r, what):
    if r != 0:
        e = ctypes.get_errno(); raise OSError(e, '%s: %s' % (what, os.strerror(e)))
def mount(src, dst, fstype, flags, data):
    ok(libc.mount(src and src.encode(), dst.encode(), fstype and fstype.encode(), flags, data and data.encode()), 'mount ' + dst)
def loopback_up():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: fcntl.ioctl(s.fileno(), 0x8914, struct.pack('16sh', b'lo', 0x1 | 0x8 | 0x40) + bytes(22))
    finally: s.close()
def drop_identity():
    ok(libc.unshare(0x10000000), 'unshare(CLONE_NEWUSER)')
    with open('/proc/self/setgroups', 'w') as f: f.write('deny')
    with open('/proc/self/uid_map', 'w') as f: f.write('%d 0 1\n' % cfg['uid'])
    with open('/proc/self/gid_map', 'w') as f: f.write('%d 0 1\n' % cfg['gid'])
def hide(p):
    p = os.path.realpath(p)
    if not os.path.exists(p): return
    if os.path.isdir(p): mount('tmpfs', p, 'tmpfs', RDONLY | NOSUID | NODEV | NOEXEC, 'size=4k,mode=000')
    else: mount('/dev/null', p, None, BIND, None)
def private(d, keep):
    d = os.path.realpath(d)
    if not os.path.isdir(d): return
    kept = []
    for k in sorted(set(os.path.realpath(x) for x in keep), key=len):
        if (k == d or k.startswith(d + '/')) and os.path.isdir(k): kept.append((k, os.open(k, os.O_PATH | os.O_DIRECTORY)))
    mount('tmpfs', d, 'tmpfs', NOSUID | NODEV, 'size=64k,mode=755')
    for k, fd in kept:
        os.makedirs(k, exist_ok=True)
        mount('/proc/self/fd/%d' % fd, k, None, BIND | REC, None)
        os.close(fd)
    mount('tmpfs', d, None, REMOUNT | RDONLY | NOSUID | NODEV, None)
def ro_bind(p):
    p = os.path.realpath(p)
    if not os.path.isdir(p): return
    mount(p, p, None, BIND | REC, None)
    # keep the flags the underlying mount has (a user namespace may not clear locked nosuid/nodev/noexec), add read-only
    f = os.statvfs(p).f_flag
    keep = (NOSUID if f & 2 else 0) | (NODEV if f & 4 else 0) | (NOEXEC if f & 8 else 0) | (1024 if f & 1024 else 0) | (2048 if f & 2048 else 0) | ((1 << 21) if f & 4096 else 0)
    mount(None, p, None, REMOUNT | BIND | RDONLY | keep, None)
def listen_egress():
    out = []
    for e in cfg.get('egress') or []:
        fam = socket.AF_INET6 if ':' in e['host'] else socket.AF_INET
        l = None
        try:
            l = socket.socket(fam, socket.SOCK_STREAM)
            l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            l.bind((e['host'], e['port'])); l.listen(128)
        except OSError:
            if l is not None: l.close()
            if fam == socket.AF_INET6: continue
            raise
        out.append((l, e['socket']))
    return out
def relay(c, u):
    left = [2]; lock = threading.Lock()
    def one(a, b):
        try:
            while True:
                d = a.recv(65536)
                if not d: break
                b.sendall(d)
        except OSError: pass
        try: b.shutdown(socket.SHUT_WR)
        except OSError: pass
        with lock:
            left[0] -= 1
            if left[0] == 0: c.close(); u.close()
    threading.Thread(target=one, args=(c, u), daemon=True).start()
    threading.Thread(target=one, args=(u, c), daemon=True).start()
def serve_egress(l, path):
    while True:
        try: c, _ = l.accept()
        except OSError: return
        u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try: u.connect(path)
        except OSError:
            c.close(); u.close(); continue
        relay(c, u)
def exec_target():
    for s in FWD + (signal.SIGPIPE, signal.SIGXFSZ): signal.signal(s, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_SETMASK, [])
    try: os.execvp(argv[0], argv)
    except OSError as e:
        os.write(2, ('failed to start %s: %s\n' % (argv[0], e.strerror)).encode()); os._exit(127)
def forward_to(pid):
    def h(s, _f):
        try: os.kill(pid, s)
        except OSError: pass
    for s in FWD: signal.signal(s, h)
try:
    loopback_up()
except OSError as e:
    fail('cannot bring the loopback up: %s' % e)
if not cfg['jail']:
    try: drop_identity()
    except OSError as e: fail(str(e))
    exec_target()
r, w = os.pipe()
try: ok(libc.unshare(0x20000000), 'unshare(CLONE_NEWPID)')
except OSError as e: fail(str(e))
init = os.fork()
if init == 0:
    os.close(r)
    try:
        mount('proc', '/proc', 'proc', NOSUID | NODEV | NOEXEC, None)
        for p in cfg['hide']: hide(p)
        if cfg['private']: private(cfg['private']['dir'], cfg['private']['keep'])
        for p in cfg.get('readonly') or []: ro_bind(p)
        egress = listen_egress()
        drop_identity()
        os.chdir(cfg['cwd'])
    except OSError as e:
        fail(str(e))
    child = os.fork()
    if child == 0:
        os.close(w); exec_target()
    forward_to(child)
    for l, path in egress: threading.Thread(target=serve_egress, args=(l, path), daemon=True).start()
    status = None
    while True:
        try: pid, st = os.waitpid(-1, 0)
        except ChildProcessError: break
        if pid == child: status = st; break
    if status is None: report = 'exit 125'
    elif os.WIFSIGNALED(status): report = 'signal %d' % os.WTERMSIG(status)
    else: report = 'exit %d' % os.WEXITSTATUS(status)
    os.write(w, report.encode()); os._exit(0)
os.close(w)
forward_to(init)
data = b''
while True:
    chunk = os.read(r, 64)
    if not chunk: break
    data += chunk
os.waitpid(init, 0)
kind, _, n = data.decode().partition(' ')
if kind == 'signal':
    n = int(n)
    try: signal.signal(n, signal.SIG_DFL)
    except (OSError, ValueError): pass
    signal.pthread_sigmask(signal.SIG_UNBLOCK, [n]); os.kill(os.getpid(), n); os._exit(128 + n)
os._exit(int(n) if kind == 'exit' else 125)
`;

/** Resolves a program name like `execvp` would (a path is checked as given, relative to `cwd`). */
export function resolveProgram(program: string, pathVar: string | undefined, cwd: string = process.cwd()): string | undefined {
  const executable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (program.includes('/')) {
    const p = isAbsolute(program) ? program : resolve(cwd, program);
    return executable(p) ? p : undefined;
  }
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (dir === '') continue;
    const p = join(dir, program);
    if (executable(p)) return p;
  }
  return undefined;
}

function runQuiet(argv: string[], cwd: string, timeoutMs = 10_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C' } });
    } catch (e) {
      done({ code: null, stdout: '', stderr: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', (e) => {
      clearTimeout(timer);
      done({ code: null, stdout: '', stderr: e.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

/** Probe run inside a candidate: the interfaces it sees (only UP ones with an address), its uid and pid, a hidden file. */
const PROBE_JS = (hiddenFile: string) =>
  [
    "const os = require('node:os'); const fs = require('node:fs');",
    'const ifs = Object.keys(os.networkInterfaces());',
    `let hidden = true; try { fs.readFileSync(${JSON.stringify(hiddenFile)}); hidden = false; } catch {}`,
    "process.stdout.write(JSON.stringify({ ifs, uid: process.getuid(), pid: process.pid, hidden }));",
  ].join('');

/**
 * Probes how this host can isolate a sandboxed command (see the module comment). A strategy counts only when the probe
 * command, run inside it, sees no interface but the loopback, runs with the caller's uid (helper strategies), and —
 * for the jail — is pid ≤ 2 of its namespace and cannot read a hidden file.
 */
export async function probeNetworkIsolation(options: NetworkIsolationOptions = {}): Promise<NetworkIsolation> {
  if (process.platform !== 'linux') return { available: false, reason: `Linux namespaces are needed (this host is ${process.platform})` };
  const pathVar = options.path ?? process.env['PATH'];
  const unshare = resolveProgram(options.unshare ?? 'unshare', pathVar);
  if (!unshare) return { available: false, reason: `util-linux '${options.unshare ?? 'unshare'}' was not found on PATH` };
  const node = process.execPath;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  const dir = mkdtempSync(join(tmpdir(), 'ht-netns-probe-'));
  const secretDir = join(dir, 'secret');
  const secret = join(secretDir, 'key');
  try {
    mkdirSync(secretDir);
    writeFileSync(secret, 'probe');
    const seen = (stdout: string): { ifs: string[]; uid: number; pid: number; hidden: boolean } | undefined => {
      try {
        const s = JSON.parse(stdout) as { ifs: string[]; uid: number; pid: number; hidden: boolean };
        return s.ifs.every((i) => i === 'lo') ? s : undefined;
      } catch {
        return undefined;
      }
    };
    const failures: string[] = [];
    const python = options.python === false ? undefined : resolveProgram(options.python ?? 'python3', pathVar);
    if (python) {
      for (const jail of [true, false]) {
        const flags = jail ? ['--user', '--map-root-user', '--net', '--mount'] : ['--user', '--map-root-user', '--net'];
        const wrap = (argv: readonly string[], spec: IsolationSpec): string[] => {
          const cfg = {
            uid, gid, jail, cwd: spec.cwd, hide: [...(spec.hide ?? [])],
            private: spec.privateDir ? { dir: spec.privateDir.dir, keep: [...spec.privateDir.keep] } : null,
            egress: jail ? (spec.egress ?? []).map((e) => ({ host: e.host, port: e.port, socket: e.socket })) : [],
            readonly: jail ? [...(spec.readOnly ?? [])] : [],
          };
          return [unshare, ...flags, '--', python, '-I', '-c', HELPER, JSON.stringify(cfg), ...argv];
        };
        const r = await runQuiet(wrap([node, '-e', PROBE_JS(secret)], { cwd: dir, hide: [secretDir] }), dir);
        const s = r.code === 0 ? seen(r.stdout) : undefined;
        // os.networkInterfaces() lists only interfaces that are UP with an address: `lo` proves the helper brought it up
        if (s && s.ifs.includes('lo') && s.uid === uid && (!jail || (s.pid <= 2 && s.hidden))) {
          return { available: true, strategy: jail ? 'userns_jail' : 'userns_loopback', loopback: true, jail, wrap };
        }
        failures.push(`python3 helper${jail ? ' (jail)' : ''}: exit ${String(r.code)}${r.stderr ? ` ${r.stderr.trim().split('\n').pop()}` : ''}`);
      }
    }
    for (const [strategy, flags] of [['userns', ['--user', '--map-current-user', '--net']], ['userns_root', ['--user', '--map-root-user', '--net']]] as const) {
      const prefix = [unshare, ...flags, '--'];
      const r = await runQuiet([...prefix, node, '-e', PROBE_JS(secret)], dir);
      if (r.code === 0 && seen(r.stdout)) return { available: true, strategy, loopback: false, jail: false, wrap: (argv) => [...prefix, ...argv] };
      failures.push(`unshare ${flags.join(' ')}: exit ${String(r.code)}`);
    }
    return { available: false, reason: `unprivileged user/network namespaces are unavailable (${failures.join('; ')})` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cache = new Map<string, Promise<NetworkIsolation>>();

/** `probeNetworkIsolation`, memoised per option set for the life of the process. */
export function networkIsolation(options: NetworkIsolationOptions = {}): Promise<NetworkIsolation> {
  const key = JSON.stringify([options.unshare ?? null, options.python ?? null, options.path ?? null]);
  let p = cache.get(key);
  if (!p) {
    p = probeNetworkIsolation(options);
    cache.set(key, p);
  }
  return p;
}
