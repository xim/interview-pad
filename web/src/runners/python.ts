import { runWorker, type Runner } from '../run';
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
  async run(model, ctx) {
    try {
      return await runWorker(getWorker(), model.getValue(), ctx, true);
    } catch (e) {
      worker = undefined;
      throw e;
    }
  },
};
