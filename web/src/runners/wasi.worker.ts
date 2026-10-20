import { ConsoleStdout, File, OpenFile, WASI } from '@bjorn3/browser_wasi_shim';

const SIGABRT_EXIT = 134;

// Runtime frames above the user's code (abort and its reporters) and below main (libc startup).
const RUNTIME_FRAME = /^(abort|__cxa_throw|__ubsan_handle_\w+|report|std::__2::__libcpp_verbose_abort\(.*)$/;
const STARTUP_FRAME = /^(__main_void|__main_argc_argv|_start)$/;

// WASM traps carry no signal, so classify from the message and the (name-section) stack.
function describeCrash(e: unknown) {
  const frames = String((e as Error)?.stack ?? '')
    .split('\n')
    .map((l) => l.trim().match(/^at (?:\S+?\.wasm\.|wasm-function\[\d+\]\.)?(.*?)(?: \(wasm:.*\))?$/)?.[1])
    .filter((f): f is string => !!f && !f.includes('.js'));
  const aborted = frames[0] === 'abort';
  const user = frames.filter((f) => !RUNTIME_FRAME.test(f));
  const end = user.findIndex((f) => STARTUP_FRAME.test(f));
  const message = e instanceof Error ? e.message : String(e);
  const summary = aborted ? 'Aborted' : `Crashed: ${message === 'unreachable' ? 'trap (unreachable code)' : message}`;
  const trace = (end < 0 ? user : user.slice(0, end))
    .map((f) => `    at ${f === '__original_main' ? 'main' : f}\n`) // main(void) is renamed by the toolchain
    .join('');
  return `\n[${summary}]\n${trace}`;
}

const output = () => {
  const decoder = new TextDecoder();
  return new ConsoleStdout((bytes) => postMessage({ type: 'out', text: decoder.decode(bytes, { stream: true }) }));
};

type Message = { wasm: Uint8Array<ArrayBuffer>; args: string[]; stdin: string };

onmessage = async ({ data: { wasm, args, stdin } }: MessageEvent<Message>) => {
  const stdinFile = new OpenFile(new File(new TextEncoder().encode(stdin)));
  const wasi = new WASI(['main', ...args], [], [stdinFile, output(), output()]);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(wasm), { wasi_snapshot_preview1: wasi.wasiImport });
  let code;
  try {
    code = wasi.start(instance as { exports: { memory: WebAssembly.Memory; _start: () => unknown } });
  } catch (e) {
    postMessage({ type: 'out', text: describeCrash(e) });
    code = SIGABRT_EXIT;
  }
  postMessage({ type: 'exit', code });
};
