import * as monaco from 'monaco-editor';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { $, type Me } from './main';
import type { Lang } from './pad';
import { cppRunner } from './runners/cpp';
import { pythonRunner } from './runners/python';
import { tsRunner } from './runners/ts';

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 64 * 1024;
const FLUSH_MS = 50;

export type RunContext = {
  write: (text: string) => void;
  status: (text: string) => void;
  signal: AbortSignal;
};

export type Runner = {
  preload?: () => void;
  // resolves with the exit code; rejects when aborted via ctx.signal
  run: (model: monaco.editor.ITextModel, ctx: RunContext) => Promise<number>;
};

type RunState = {
  status: 'running' | 'done';
  by: string;
  clientId: number;
  lang: Lang;
  phase?: string;
  exitCode?: number | null;
  ms?: number;
};

const RUNNERS: Record<Lang, Runner> = { cpp: cppRunner, python: pythonRunner, ts: tsRunner };

// Run in a disposable worker speaking {type: 'out', text} / {type: 'exit', code}; terminated on abort.
export function runWorker(worker: Worker, message: unknown, ctx: RunContext): Promise<number> {
  return new Promise((resolve, reject) => {
    const done = () => {
      worker.terminate();
      ctx.signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      done();
      reject(new Error(String(ctx.signal.reason)));
    };
    if (ctx.signal.aborted) return abort();
    ctx.signal.addEventListener('abort', abort);
    worker.onmessage = ({ data }) => {
      if (data.type === 'out') ctx.write(data.text);
      else if (data.type === 'exit') {
        done();
        resolve(data.code);
      }
    };
    worker.onerror = (e) => {
      done();
      reject(new Error(e.message));
    };
    worker.postMessage(message);
  });
}

export function setupRun(opts: {
  me: Me;
  doc: Y.Doc;
  awareness: WebsocketProvider['awareness'];
  editor: monaco.editor.IStandaloneCodeEditor;
  currentLang: () => Lang;
  model: (lang: Lang) => monaco.editor.ITextModel;
}) {
  const { me, doc, awareness } = opts;
  const state = doc.getMap('state');
  const output = doc.getText('output');
  const runButton = $<HTMLButtonElement>('run');
  const stopButton = $<HTMLButtonElement>('stop');
  let abort: AbortController | undefined;

  const runState = () => state.get('run') as RunState | undefined;
  const busy = () => {
    const r = runState();
    // a runner that disconnected mid-run leaves a stale 'running' state behind
    return r?.status === 'running' && awareness.getStates().has(r.clientId);
  };
  const setRun = (patch: Partial<RunState>) => state.set('run', { ...runState(), ...patch });

  async function run() {
    if (busy()) return;
    const lang = opts.currentLang();
    abort = new AbortController();
    const timer = setTimeout(() => abort?.abort('killed: timeout'), TIMEOUT_MS);
    doc.transact(() => {
      output.delete(0, output.length);
      state.set('run', { status: 'running', by: me.name, clientId: doc.clientID, lang } satisfies RunState);
    });

    let pending = '';
    let written = 0;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (!pending) return;
      const room = MAX_OUTPUT - written;
      const text = pending.length > room ? pending.slice(0, room) + '\n[output truncated]\n' : pending;
      written += pending.length;
      pending = '';
      output.insert(output.length, text);
    };
    const write = (text: string) => {
      if (written + pending.length > MAX_OUTPUT) return;
      pending += text;
      flushTimer ??= setTimeout(flush, FLUSH_MS);
    };

    const t0 = performance.now();
    let exitCode: number | null = null;
    try {
      exitCode = await RUNNERS[lang].run(opts.model(lang), { write, status: (phase) => setRun({ phase }), signal: abort.signal });
    } catch (e) {
      write(`\n[${abort.signal.aborted ? abort.signal.reason : `error: ${e instanceof Error ? e.message : e}`}]\n`);
    }
    clearTimeout(timer);
    clearTimeout(flushTimer);
    flush();
    abort = undefined;
    setRun({ status: 'done', phase: undefined, exitCode, ms: Math.round(performance.now() - t0) });
  }

  runButton.onclick = run;
  stopButton.onclick = () => abort?.abort('killed: stopped');
  opts.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

  const render = () => {
    const r = runState();
    runButton.disabled = busy();
    stopButton.hidden = !(busy() && r?.clientId === doc.clientID);
    const label = r?.lang === undefined ? '' : ` (${r.lang}, by ${r.by})`;
    $('run-status').textContent = !r
      ? ''
      : busy()
        ? `${r.phase ?? 'Running'}…${label}`
        : r.status === 'running'
          ? `Runner disconnected${label}`
          : r.exitCode === null
            ? `Aborted${label}`
            : `Exit ${r.exitCode} · ${r.ms} ms${label}`;
  };
  state.observe(render);
  awareness.on('change', render);
  render();

  const pre = $('output');
  const renderOutput = () => {
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = output.toString();
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  };
  output.observe(renderOutput);
  renderOutput();

  return { preload: (lang: Lang) => RUNNERS[lang].preload?.() };
}
