import { runWorker, type Runner } from '../run';
import { echo } from './echo';
import ClangWorker from './clang.worker?worker';
import WasiWorker from './wasi.worker?worker';

// Long-lived and shared by C/C++ so the ~100 MB compiler loads once; replaced after a kill.
// Programs run in a separate worker.
let compiler: Worker | undefined;

function getCompiler() {
  if (!compiler) {
    compiler = new ClangWorker();
    compiler.postMessage({ init: new URL('clang/', document.baseURI).href });
  }
  return compiler;
}

export const clangRunner = (lang: 'c' | 'cpp'): Runner => ({
  preload: () => getCompiler().postMessage({ preload: true }),
  async run(model, ctx, { flags, args, stdin }) {
    let result;
    try {
      result = await runWorker<{ wasm?: Uint8Array; ms: number }>(getCompiler(), { lang, src: model.getValue(), flags }, ctx, true);
    } catch (e) {
      compiler = undefined;
      throw e;
    }
    const took = `\x1b[2m(${(result.ms / 1000).toFixed(1)} s)\x1b[0m`;
    if (!result.wasm) {
      ctx.write(`\x1b[1;31m[compilation failed]\x1b[0m ${took}\n`);
      return result.code;
    }
    ctx.write(`\x1b[2mcompiled\x1b[0m ${took}\n`);
    ctx.write(echo(['./a.out', ...args]));
    ctx.start();
    return (await runWorker(new WasiWorker(), { wasm: result.wasm, args, stdin }, ctx)).code;
  },
});
