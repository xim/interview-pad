import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI, WASIProcExit } from '@bjorn3/browser_wasi_shim';

const SIGABRT_EXIT = 134;
const SIGSEGV_EXIT = 139;
const EAGAIN = 6;
const ENOTSUP = 58;
const POOL = 16; // threads that can run at once; more fail with EAGAIN
// ctl: [last thread id, then per pool worker: state, tid, arg]; state 0 idle, 1 being assigned, 2 assigned
const SLOT = 3;

// Runtime frames above the user's code (abort and its reporters) and below main or a thread's function (startup).
const RUNTIME_FRAME = /^(abort|__ubsan_handle_\w+|report(\(.*)?|std::__2::__libcpp_verbose_abort\(.*)$/;
const STARTUP_FRAME = /^(__main_void|__main_argc_argv|_start|wasi_thread_start|__wasi_thread_start_C|void\* std::__2::__thread_proxy.*)$/;

// WASM traps carry no signal, so classify from the message and the (name-section) stack.
function describeCrash(e: unknown) {
  const frames = String((e as Error)?.stack ?? '')
    .split('\n')
    .map((l) => l.trim().match(/^at (?:a\.out\.|wasm-function\[\d+\]\.)?(.*?)(?: \(wasm:.*\))?$/)?.[1]) // module is named after the output file
    .filter((f): f is string => !!f && !f.includes('.js'));
  const aborted = frames[0] === 'abort';
  const user = frames.filter((f) => !RUNTIME_FRAME.test(f));
  const end = user.findIndex((f) => STARTUP_FRAME.test(f));
  const message = e instanceof Error ? e.message : String(e);
  // out-of-bounds memory or function-table access (wording differs per browser) is what a native build would segfault on
  const segfault = /out of bounds/.test(message);
  const summary = aborted
    ? 'Aborted'
    : segfault
      ? 'Segmentation fault'
      : `Crashed: ${message === 'unreachable' ? 'trap (unreachable code)' : message}`;
  const trace = (end < 0 ? user : user.slice(0, end))
    .map((f) => `    at ${f === '__original_main' ? 'main' : f}\n`) // main(void) is renamed by the toolchain
    .join('');
  return { text: `\n\x1b[1;31m[${summary}]\x1b[0m\n${trace}`, code: segfault && !aborted ? SIGSEGV_EXIT : SIGABRT_EXIT };
}

// The module's memory import (programs link with --import-memory); JS can't read its limits yet.
function memoryLimits(wasm: Uint8Array) {
  let p = 8; // magic, version
  const u32 = () => {
    let r = 0;
    for (let s = 0; ; s += 7) {
      const b = wasm[p++];
      r |= (b & 0x7f) << s;
      if (b < 0x80) return r >>> 0;
    }
  };
  const skip = (n: number) => (p += n);
  const limits = () => {
    const flags = wasm[p++];
    const initial = u32();
    return { initial, maximum: flags & 1 ? u32() : undefined, shared: !!(flags & 2) };
  };
  while (p < wasm.length) {
    const id = wasm[p++];
    const end = u32() + p;
    if (id === 2) {
      for (let n = u32(); n--; ) {
        skip(u32()); // module name
        skip(u32()); // field name
        const kind = wasm[p++];
        if (kind === 2) return limits();
        if (kind === 0) u32(); // function: type index
        else if (kind === 1) {
          skip(1); // table: element type, limits
          limits();
        } else skip(2); // global: type, mutability; tag: attribute, type index (< 128 here)
      }
    }
    p = end;
  }
}

// stdin's read position is shared by the threads' instances
class SharedStdin extends OpenFile {
  constructor(
    data: Uint8Array,
    private pos: Int32Array,
  ) {
    super(new File(data));
  }
  fd_read(size: number) {
    this.file_pos = BigInt(Atomics.load(this.pos, 0));
    const r = super.fd_read(size);
    Atomics.store(this.pos, 0, Number(this.file_pos));
    return r;
  }
}

type Program = {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  ctl: Int32Array;
  stdinPos: Int32Array;
  fileNotice: Int32Array; // set once the notice below was shown
  args: string[];
  stdin: Uint8Array;
};
type Exports = {
  _start: () => void;
  wasi_thread_start: (tid: number, arg: number) => void;
  __ip_flush?: () => void;
  __ip_uncaught?: (unwindException: number) => void;
  __cpp_exception?: WebAssembly.Tag;
};

function instantiate(p: Program, thread: boolean) {
  let pending = '';
  const output = () => {
    const decoder = new TextDecoder();
    return new ConsoleStdout((bytes) => (pending += decoder.decode(bytes, { stream: true })));
  };
  const stdio = [new SharedStdin(p.stdin, p.stdinPos), output(), output()];
  // a fresh in-memory filesystem per run, for the main thread only: threads have their own WASI state
  const root = new PreopenDirectory('/', new Map([['tmp', new Directory(new Map())]]));
  const wasi = new WASI(['./a.out', ...p.args], [], [...stdio, root]);
  if (thread) {
    for (const [name, call] of Object.entries(wasi.wasiImport)) {
      if (!/^(path_|fd_)/.test(name)) continue;
      wasi.wasiImport[name] = (...args: number[]) => {
        // the preopen probe (libc's table is shared, and may be filled from any thread) and stdio work everywhere
        if (name.startsWith('fd_prestat_') || (name.startsWith('fd_') && args[0] <= 2)) return call(...args);
        if (Atomics.exchange(p.fileNotice, 0, 1) === 0) {
          postMessage({ type: 'out', text: '\n\x1b[1;33m[file I/O is only available on the main thread]\x1b[0m\n' });
        }
        return ENOTSUP;
      };
    }
  }
  const { fd_write, poll_oneoff } = wasi.wasiImport;
  // one message per write, so a line isn't split around another thread's output
  wasi.wasiImport.fd_write = (...args) => {
    const r = fd_write(...args);
    if (pending) postMessage({ type: 'out', text: pending });
    pending = '';
    return r;
  };
  // the shim busy-waits for sleeps; for a single relative clock subscription, block instead and let it time out at once
  wasi.wasiImport.poll_oneoff = (subs: number, events: number, n: number) => {
    const view = new DataView(p.memory.buffer);
    if (n === 1 && view.getUint8(subs + 8) === 0 && !(view.getUint16(subs + 40, true) & 1)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(view.getBigUint64(subs + 24, true)) / 1e6);
      view.setBigUint64(subs + 24, 0n, true);
    }
    return poll_oneoff(subs, events, n);
  };
  const spawn = (arg: number) => {
    for (let slot = 0; slot < POOL; slot++) {
      const i = 1 + slot * SLOT;
      if (Atomics.compareExchange(p.ctl, i, 0, 1) !== 0) continue;
      const tid = Atomics.add(p.ctl, 0, 1) + 1; // the main thread's is 0x3fffffff
      p.ctl[i + 1] = tid;
      p.ctl[i + 2] = arg;
      Atomics.store(p.ctl, i, 2);
      Atomics.notify(p.ctl, i);
      return tid;
    }
    return -EAGAIN;
  };
  const imports = { env: { memory: p.memory }, wasi: { 'thread-spawn': spawn }, wasi_snapshot_preview1: wasi.wasiImport };
  const instance = new WebAssembly.Instance(p.module, imports);
  wasi.inst = instance as { exports: { memory: WebAssembly.Memory } };
  return instance.exports as unknown as Exports;
}

// Runs main or a thread; returns the program's exit code, or undefined when a thread just returned.
function run(exports: Exports, start: () => void): number | undefined {
  try {
    start();
  } catch (e) {
    if (e instanceof WASIProcExit) return e.code;
    // the instance stays callable after a trap; helpers from runtime.c
    try {
      exports.__ip_flush?.();
      if (exports.__cpp_exception && e instanceof WebAssembly.Exception && e.is(exports.__cpp_exception)) {
        exports.__ip_uncaught?.(e.getArg(exports.__cpp_exception, 0) as number);
        exports.__ip_flush?.();
        postMessage({ type: 'out', text: '\n\x1b[1;31m[Aborted: uncaught exception]\x1b[0m\n' });
        return SIGABRT_EXIT;
      }
    } catch {}
    const crash = describeCrash(e);
    postMessage({ type: 'out', text: crash.text });
    return crash.code;
  }
}

type Message = { wasm: Uint8Array<ArrayBuffer>; args: string[]; stdin: string } | { thread: Program & { slot: number } };

onmessage = async ({ data }: MessageEvent<Message>) => {
  if ('thread' in data) {
    // a pool worker, started by clang.ts: runs the threads handed to its slot, blocking in between
    const p = data.thread;
    const i = 1 + p.slot * SLOT;
    for (;;) {
      while (Atomics.load(p.ctl, i) !== 2) Atomics.wait(p.ctl, i, Atomics.load(p.ctl, i));
      const exports = instantiate(p, true);
      const code = run(exports, () => exports.wasi_thread_start(p.ctl[i + 1], p.ctl[i + 2]));
      if (code !== undefined) postMessage({ type: 'exit', code }); // exit() or a crash in a thread ends the program
      Atomics.store(p.ctl, i, 0);
    }
  }
  const module = await WebAssembly.compile(data.wasm);
  const p: Program = {
    module,
    memory: new WebAssembly.Memory(memoryLimits(data.wasm)!),
    ctl: new Int32Array(new SharedArrayBuffer(4 * (1 + POOL * SLOT))),
    stdinPos: new Int32Array(new SharedArrayBuffer(4)),
    fileNotice: new Int32Array(new SharedArrayBuffer(4)),
    args: data.args,
    stdin: new TextEncoder().encode(data.stdin),
  };
  // the pool is started by clang.ts, as workers can't start others while blocked (e.g. in pthread_join)
  if (WebAssembly.Module.imports(module).some((i) => i.module === 'wasi' && i.name === 'thread-spawn')) {
    postMessage({ type: 'threads', thread: p, pool: POOL });
  }
  const exports = instantiate(p, false);
  postMessage({ type: 'exit', code: run(exports, () => exports._start()) ?? 0 });
};
