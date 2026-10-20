import * as monaco from 'monaco-editor';
import ClangdWorker from './runners/clangd.worker?worker';

let worker: Worker | undefined;
let config: { flags?: Record<'c' | 'cpp', string[]>; completion?: boolean } = {};

// Starts clangd once; lazily, since it's a large download.
export function startClangd(onStatus: (text: string) => void) {
  if (worker) return;
  worker = new ClangdWorker();
  worker.onmessage = ({ data }) => 'status' in data && onStatus(data.status);
  const lsp = new MessageChannel();
  worker.postMessage({ port: lsp.port2, init: new URL('clangd/', document.baseURI).href, ...config }, [lsp.port2]);
  lsp.port1.start();
  // the transport only needs postMessage/addEventListener, which a MessagePort has
  new monaco.lsp.MonacoLspClient(monaco.lsp.createTransportToWorker(lsp.port1 as unknown as Worker));
}

// Remembered until clangd starts.
export function configureClangd(patch: typeof config) {
  config = { ...config, ...patch };
  worker?.postMessage(patch);
}
