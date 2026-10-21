import { ConsoleStdout, File, OpenFile, WASI } from '@bjorn3/browser_wasi_shim';

const SIGABRT_EXIT = 134;
const SIGSEGV_EXIT = 139;

// Runtime frames above the user's code (abort and its reporters) and below main (libc startup).
const RUNTIME_FRAME = /^(abort|__ubsan_handle_\w+|report(\(.*)?|std::__2::__libcpp_verbose_abort\(.*)$/;
const STARTUP_FRAME = /^(__main_void|__main_argc_argv|_start)$/;

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

const output = () => {
  const decoder = new TextDecoder();
  return new ConsoleStdout((bytes) => postMessage({ type: 'out', text: decoder.decode(bytes, { stream: true }) }));
};

type Message = { wasm: Uint8Array<ArrayBuffer>; args: string[]; stdin: string };

onmessage = async ({ data: { wasm, args, stdin } }: MessageEvent<Message>) => {
  const stdinFile = new OpenFile(new File(new TextEncoder().encode(stdin)));
  const wasi = new WASI(['./a.out', ...args], [], [stdinFile, output(), output()]);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(wasm), { wasi_snapshot_preview1: wasi.wasiImport });
  const exports = instance.exports as {
    __ip_flush?: () => void;
    __ip_uncaught?: (unwindException: number) => void;
    __cpp_exception?: WebAssembly.Tag;
  };
  let code;
  try {
    code = wasi.start(instance as { exports: { memory: WebAssembly.Memory; _start: () => unknown } });
  } catch (e) {
    // the instance stays callable after a trap; helpers from runtime.c
    try {
      exports.__ip_flush?.();
      if (exports.__cpp_exception && e instanceof WebAssembly.Exception && e.is(exports.__cpp_exception)) {
        exports.__ip_uncaught?.(e.getArg(exports.__cpp_exception, 0) as number);
        exports.__ip_flush?.();
        postMessage({ type: 'out', text: '\n\x1b[1;31m[Aborted: uncaught exception]\x1b[0m\n' });
        return postMessage({ type: 'exit', code: SIGABRT_EXIT });
      }
    } catch {}
    const crash = describeCrash(e);
    postMessage({ type: 'out', text: crash.text });
    code = crash.code;
  }
  postMessage({ type: 'exit', code });
};
