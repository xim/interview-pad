import { ConsoleStdout, File, OpenFile, WASI } from '@bjorn3/browser_wasi_shim';

const SIGABRT_EXIT = 134;

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
    // abort(), UBSan (trap mode) and libc++ hardening checks all surface as this, without details
    const hint = String(e).includes('unreachable') ? ': abort(), or a UB sanitizer / libc++ hardening check failed' : '';
    postMessage({ type: 'out', text: `\n[${e}${hint}]\n` });
    code = SIGABRT_EXIT;
  }
  postMessage({ type: 'exit', code });
};
