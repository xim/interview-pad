import { runWorker, type Runner } from '../run';
import ClangWorker from './clang.worker?worker';
import WasiWorker from './wasi.worker?worker';

// Long-lived and shared by C/C++ so the ~100 MB compiler loads once; replaced after a kill.
// Programs run in a separate worker.
let compiler: Worker | undefined;

function getCompiler() {
  compiler ??= new ClangWorker();
  return compiler;
}

export const clangRunner = (lang: 'c' | 'cpp'): Runner => ({
  preload: () => getCompiler().postMessage({ preload: true }),
  async run(model, ctx, flags) {
    let result;
    try {
      result = await runWorker<{ wasm?: Uint8Array }>(getCompiler(), { lang, src: model.getValue(), flags }, ctx, true);
    } catch (e) {
      compiler = undefined;
      throw e;
    }
    if (!result.wasm) {
      ctx.write('[compilation failed]\n');
      return result.code;
    }
    ctx.start();
    return (await runWorker(new WasiWorker(), result.wasm, ctx)).code;
  },
});
