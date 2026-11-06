import * as monaco from 'monaco-editor';
import { runWorker, type Runner } from '../run';
import { echo } from './echo';
import JsWorker from './js.worker?worker';

monaco.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  strict: true,
});
// provided by js.worker
monaco.typescript.typescriptDefaults.addExtraLib('declare const process: { argv: string[] };', 'ts:runtime.d.ts');
const NODE_FS = `{
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, options: string | { encoding: string }): string;
  export function writeFileSync(path: string, data: string | ArrayBufferView): void;
  export function appendFileSync(path: string, data: string | ArrayBufferView): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function unlinkSync(path: string): void;
  const fs: { readFileSync: typeof readFileSync; writeFileSync: typeof writeFileSync; appendFileSync: typeof appendFileSync;
    existsSync: typeof existsSync; mkdirSync: typeof mkdirSync; readdirSync: typeof readdirSync; rmSync: typeof rmSync;
    unlinkSync: typeof unlinkSync };
  export default fs;
}`;
// node-fs.js, in-memory and fresh each run
monaco.typescript.typescriptDefaults.addExtraLib(`declare module 'node:fs' ${NODE_FS}\ndeclare module 'fs' ${NODE_FS}`, 'ts:fs.d.ts');

export const tsRunner: Runner = {
  async run(model, ctx, { args, stdin }) {
    const getWorker = await monaco.typescript.getTypeScriptWorker();
    const ts = await getWorker(model.uri);
    const { outputFiles } = await ts.getEmitOutput(model.uri.toString());
    ctx.write(echo(['main.ts', ...args]));
    ctx.start();
    return (await runWorker(new JsWorker(), { code: outputFiles[0].text, args, stdin }, ctx)).code;
  },
};
