import { runWorker, type Runner } from '../run';
import { echo } from './echo';
import PythonWorker from './python.worker?worker';

// Long-lived so Pyodide loads once; replaced after a kill.
let worker: Worker | undefined;

function getWorker() {
  if (!worker) {
    worker = new PythonWorker();
    worker.postMessage({ init: new URL('pyodide/', document.baseURI).href });
  }
  return worker;
}

export const pythonRunner: Runner = {
  preload: getWorker,
  async run(model, ctx, { args, stdin }) {
    try {
      ctx.write(echo(['python', 'main.py', ...args]));
      return (await runWorker(getWorker(), { src: model.getValue(), args, stdin }, ctx, true)).code;
    } catch (e) {
      worker = undefined;
      throw e;
    }
  },
};
