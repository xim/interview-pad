import * as monaco from 'monaco-editor';
import { runWorker, type Runner } from '../run';
import JsWorker from './js.worker?worker';

monaco.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  strict: true,
});

export const tsRunner: Runner = {
  async run(model, ctx) {
    const getWorker = await monaco.typescript.getTypeScriptWorker();
    const ts = await getWorker(model.uri);
    const { outputFiles } = await ts.getEmitOutput(model.uri.toString());
    ctx.start();
    return runWorker(new JsWorker(), outputFiles[0].text, ctx);
  },
};
