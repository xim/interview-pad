import * as monaco from 'monaco-editor';
import { renderAnsi } from './ansi';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { $, type Me } from './main';
import type { Lang } from './pad';
import { clangRunner } from './runners/clang';
import { pythonRunner } from './runners/python';
import { tsRunner } from './runners/ts';

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 64 * 1024;
const FLUSH_MS = 50;

export type RunContext = {
  write: (text: string) => void;
  status: (text: string) => void;
  // user code starts now: the timeout covers only what follows, not runtime loading/compiling
  start: () => void;
  signal: AbortSignal;
};

export type RunInput = { flags: string[]; args: string[]; stdin: string };

export type Runner = {
  preload?: () => void;
  // resolves with the exit code; rejects when aborted via ctx.signal
  run: (model: monaco.editor.ITextModel, ctx: RunContext, input: RunInput) => Promise<number>;
};

// Whitespace-separated, with '...' / "..." grouping (no escapes).
export const splitArgs = (s: string) =>
  [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

type RunState = {
  status: 'running' | 'done';
  by: string;
  clientId: number;
  lang: Lang;
  phase?: string;
  exitCode?: number | null;
  ms?: number;
};

const RUNNERS: Record<Lang, Runner> = { c: clangRunner('c'), cpp: clangRunner('cpp'), python: pythonRunner, ts: tsRunner };

// Run in a worker speaking {type: 'out', text} / {type: 'status', text} / {type: 'start'} / {type: 'exit', code}.
// The worker is terminated on abort or error, and after exit unless keepAlive.
// Resolves with the exit message, so workers can return more than the code.
export function runWorker<T = {}>(
  worker: Worker,
  message: unknown,
  ctx: RunContext,
  keepAlive = false,
): Promise<{ code: number } & T> {
  return new Promise((resolve, reject) => {
    const done = (terminate: boolean) => {
      if (terminate) worker.terminate();
      ctx.signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      done(true);
      reject(new Error(String(ctx.signal.reason)));
    };
    if (ctx.signal.aborted) return abort();
    ctx.signal.addEventListener('abort', abort);
    worker.onmessage = ({ data }) => {
      if (data.type === 'out') ctx.write(data.text);
      else if (data.type === 'status') ctx.status(data.text);
      else if (data.type === 'start') ctx.start();
      else if (data.type === 'exit') {
        done(!keepAlive);
        resolve(data);
      }
    };
    worker.onerror = (e) => {
      done(true);
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
  flags: (lang: Lang) => string;
}) {
  const { me, doc, awareness } = opts;
  const state = doc.getMap('state');
  const input = () => ({ args: splitArgs((state.get('args') as string) ?? ''), stdin: (state.get('stdin') as string) ?? '' });
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
    const ctrl = (abort = new AbortController());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = 0;
    const start = () => {
      started = performance.now();
      setRun({ phase: undefined });
      timer ??= setTimeout(() => ctrl.abort(`killed: timeout after ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS);
    };
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
      const ctx = { write, status: (phase: string) => setRun({ phase }), start, signal: ctrl.signal };
      exitCode = await RUNNERS[lang].run(opts.model(lang), ctx, { flags: splitArgs(opts.flags(lang)), ...input() });
    } catch (e) {
      write(`\n\x1b[1;31m[${ctrl.signal.aborted ? ctrl.signal.reason : `error: ${e instanceof Error ? e.message : e}`}]\x1b[0m\n`);
    }
    // timer is only set once the program itself started (not on compile errors)
    if (timer && exitCode !== null) {
      const color = exitCode ? '\x1b[1;31m' : '\x1b[32m';
      write(`${color}Program exited with code ${exitCode}\x1b[0m \x1b[2m(${Math.round(performance.now() - started)} ms)\x1b[0m\n`);
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
    renderAnsi(output.toString(), pre);
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  };
  output.observe(renderOutput);
  renderOutput();

  return { preload: (lang: Lang) => RUNNERS[lang].preload?.() };
}
