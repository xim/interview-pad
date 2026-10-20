import { ConsoleStdout, File, OpenFile, WASI } from '@bjorn3/browser_wasi_shim';

const SIGABRT_EXIT = 134;

const output = () => {
  const decoder = new TextDecoder();
  return new ConsoleStdout((bytes) => postMessage({ type: 'out', text: decoder.decode(bytes, { stream: true }) }));
};

onmessage = async ({ data: wasm }: MessageEvent<Uint8Array<ArrayBuffer>>) => {
  const wasi = new WASI(['main'], [], [new OpenFile(new File([])), output(), output()]);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(wasm), { wasi_snapshot_preview1: wasi.wasiImport });
  let code;
  try {
    code = wasi.start(instance as { exports: { memory: WebAssembly.Memory; _start: () => unknown } });
  } catch (e) {
    // abort() and other traps surface as a RuntimeError such as "unreachable"
    postMessage({ type: 'out', text: `\n[${e}]\n` });
    code = SIGABRT_EXIT;
  }
  postMessage({ type: 'exit', code });
};
