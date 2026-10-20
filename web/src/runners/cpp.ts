import { runWorker, type Runner } from '../run';
import CppWorker from './cpp.worker?worker';
import WasiWorker from './wasi.worker?worker';

// Long-lived so the ~100 MB compiler loads once; replaced after a kill. Programs run in a separate worker.
let compiler: Worker | undefined;

function getCompiler() {
  compiler ??= new CppWorker();
  return compiler;
}

export const cppRunner: Runner = {
  preload: () => getCompiler().postMessage({ preload: true }),
  async run(model, ctx) {
    let result;
    try {
      result = await runWorker<{ wasm?: Uint8Array }>(getCompiler(), model.getValue(), ctx, true);
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
};
