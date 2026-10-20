import * as monaco from 'monaco-editor';
import { runWorker, type Runner } from '../run';
import JsWorker from './js.worker?worker';

monaco.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  strict: true,
});
// provided by js.worker
monaco.typescript.typescriptDefaults.addExtraLib('declare const process: { argv: string[] };', 'ts:runtime.d.ts');

export const tsRunner: Runner = {
  async run(model, ctx, { args, stdin }) {
    const getWorker = await monaco.typescript.getTypeScriptWorker();
    const ts = await getWorker(model.uri);
    const { outputFiles } = await ts.getEmitOutput(model.uri.toString());
    ctx.start();
    return (await runWorker(new JsWorker(), { code: outputFiles[0].text, args, stdin }, ctx)).code;
  },
};
