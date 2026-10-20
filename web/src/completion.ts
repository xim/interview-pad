import * as monaco from 'monaco-editor';
import JediWorker from './runners/jedi.worker?worker';

type Signature = [label: string, activeParam: number | null, params: string[], doc: string];

let worker: Worker | undefined;
let seq = 0;
const pending = new Map<number, (result: never) => void>();

function request<T>(kind: string, model: monaco.editor.ITextModel, position: monaco.Position): Promise<T> {
  if (!worker) {
    worker = new JediWorker();
    worker.onmessage = ({ data }) => {
      pending.get(data.id)?.(data.result as never);
      pending.delete(data.id);
    };
    worker.postMessage({ init: new URL('pyodide/', document.baseURI).href });
  }
  const id = ++seq;
  worker.postMessage({ id, kind, src: model.getValue(), line: position.lineNumber, col: position.column - 1 });
  return new Promise((resolve) => pending.set(id, resolve as (result: never) => void));
}

const K = monaco.languages.CompletionItemKind;
const KINDS: Record<string, monaco.languages.CompletionItemKind> = {
  module: K.Module,
  class: K.Class,
  instance: K.Variable,
  function: K.Function,
  param: K.Variable,
  path: K.File,
  keyword: K.Keyword,
  property: K.Property,
  statement: K.Variable,
};

// Python completion, signature help and hover via Jedi; no-ops while `enabled()` is false.
export function registerPythonIntelligence(enabled: () => boolean) {
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      if (!enabled()) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const items = await request<[string, string][]>('complete', model, position);
      return {
        suggestions: items.map(([name, type], i) => ({
          label: name,
          kind: KINDS[type] ?? K.Text,
          insertText: name,
          range,
          sortText: String(i).padStart(4, '0'), // keep Jedi's ranking
        })),
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model, position) {
      if (!enabled()) return null;
      const sigs = await request<Signature[]>('signatures', model, position);
      if (!sigs.length) return null;
      return {
        value: {
          signatures: sigs.map(([label, , params, doc]) => ({
            label,
            documentation: doc,
            parameters: params.map((p) => ({ label: p })),
          })),
          activeSignature: 0,
          activeParameter: sigs[0][1] ?? 0,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerHoverProvider('python', {
    async provideHover(model, position) {
      if (!enabled()) return null;
      const docs = await request<string[]>('hover', model, position);
      return docs.length ? { contents: docs.map((d) => ({ value: '```text\n' + d + '\n```' })) } : null;
    },
  });
}
