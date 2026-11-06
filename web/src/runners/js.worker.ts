// Runs one JS program as an ES module; console output is forwarded as {type: 'out'}.
// As in Node, the program ends once the module has evaluated and no timers are pending.
import NODE_FS from './node-fs.js?raw';

const post = (text: string) => postMessage({ type: 'out', text });
const moduleUrl = (source: string) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
// a blob-URL module can't resolve bare specifiers, so point imports of fs / node:fs at the in-memory one
const FS_IMPORT = /(\b(?:from|import)\s*\(?\s*)(['"])(?:node:)?fs\2/g;

function format(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? String(v);
  if (v instanceof Map) return `Map(${format([...v])})`;
  if (v instanceof Set) return `Set(${format([...v])})`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

for (const method of ['log', 'info', 'warn', 'error', 'debug', 'dir'] as const) {
  console[method] = (...args: unknown[]) => post(args.map(format).join(' ') + '\n');
}
console.assert = (ok, ...args) => ok || console.error('Assertion failed' + (args.length ? ':' : ''), ...args);
const timeLabels = new Map<string, number>();
const elapsed = (label: string) => `${label}: ${(performance.now() - (timeLabels.get(label) ?? NaN)).toFixed(3)}ms`;
console.time = (label = 'default') => void timeLabels.set(label, performance.now());
console.timeLog = (label = 'default', ...args) => console.log(elapsed(label), ...args);
console.timeEnd = (label = 'default') => (console.log(elapsed(label)), timeLabels.delete(label));
console.table = (data: unknown) => {
  if (typeof data !== 'object' || !data) return console.log(data);
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  const rows = Object.entries(data);
  const keys = [...new Set(rows.flatMap(([, v]) => (isObject(v) ? Object.keys(v) : ['Values'])))];
  const cell = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : format(v));
  const table = [['(index)', ...keys], ...rows.map(([i, v]) => [i, ...keys.map((k) => cell(isObject(v) ? v[k] : v))])];
  const widths = table[0].map((_, c) => Math.max(...table.map((r) => r[c].length)));
  post(table.map((r) => r.map((v, c) => v.padEnd(widths[c])).join(' │ ')).join('\n') + '\n');
};

// pending timers keep the program alive, as in Node (a setInterval until the time limit)
const timers = new Set<number>();
let idle: (() => void) | undefined;
const { setTimeout: realSetTimeout, setInterval: realSetInterval, clearTimeout: realClearTimeout } = globalThis;
// a task later, so that promise continuations scheduling the next timer have run
const checkIdle = () => realSetTimeout(() => timers.size || idle?.());
const track = (repeat: boolean) => (f: TimerHandler, ms?: number, ...args: unknown[]) => {
  const id: number = (repeat ? realSetInterval : realSetTimeout)(() => {
    if (!repeat) timers.delete(id);
    try {
      (f as (...a: unknown[]) => void)(...args);
    } catch (e) {
      uncaught(e);
    }
    checkIdle();
  }, ms);
  timers.add(id);
  return id;
};
const clear = (id?: number) => {
  realClearTimeout(id);
  if (id !== undefined) timers.delete(id);
  checkIdle();
};
Object.assign(globalThis, { setTimeout: track(false), setInterval: track(true), clearTimeout: clear, clearInterval: clear });

// process.exit() ends the run at once: the exit message makes run.ts terminate this worker
class Exit extends Error {}
const exit = (code: number) => {
  postMessage({ type: 'exit', code });
  throw new Exit();
};
function uncaught(e: unknown) {
  if (e instanceof Exit) return;
  post(`Uncaught ${format(e)}\n`);
  postMessage({ type: 'exit', code: 1 });
}

addEventListener('unhandledrejection', (e) => e.reason instanceof Exit || post(`Uncaught (in promise) ${format(e.reason)}\n`));

type Message = { code: string; args: string[]; stdin: string };

onmessage = async ({ data: { code, args, stdin } }: MessageEvent<Message>) => {
  // Node-ish argv; prompt() (as in browsers) returns the next stdin line, null at EOF
  const lines = stdin.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const write = (text: unknown) => (post(String(text)), true);
  const process = {
    argv: ['node', 'main.ts', ...args],
    env: {},
    exitCode: undefined as number | undefined,
    exit: (code?: number) => exit(code ?? process.exitCode ?? 0),
    stdout: { write },
    stderr: { write },
  };
  Object.assign(globalThis, { process, prompt: () => lines.shift() ?? null });
  const url = moduleUrl(code.replace(FS_IMPORT, `$1"${moduleUrl(NODE_FS)}"`));
  try {
    await import(/* @vite-ignore */ url);
    await new Promise<void>((resolve) => ((idle = resolve), checkIdle()));
    exit(process.exitCode ?? 0);
  } catch (e) {
    uncaught(e);
  }
};
