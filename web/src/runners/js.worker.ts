// Runs one JS program as an ES module; console output is forwarded as {type: 'out'}.
// The program ends when module evaluation settles: pending timers/promises are dropped.
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

for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...args: unknown[]) => post(args.map(format).join(' ') + '\n');
}

addEventListener('unhandledrejection', (e) => post(`Uncaught (in promise) ${format(e.reason)}\n`));

type Message = { code: string; args: string[]; stdin: string };

onmessage = async ({ data: { code, args, stdin } }: MessageEvent<Message>) => {
  // Node-ish argv; prompt() (as in browsers) returns the next stdin line, null at EOF
  const lines = stdin.split('\n');
  if (lines.at(-1) === '') lines.pop();
  Object.assign(globalThis, { process: { argv: ['node', 'main.ts', ...args] }, prompt: () => lines.shift() ?? null });
  const url = moduleUrl(code.replace(FS_IMPORT, `$1"${moduleUrl(NODE_FS)}"`));
  let exitCode = 0;
  try {
    await import(/* @vite-ignore */ url);
  } catch (e) {
    post(`Uncaught ${format(e)}\n`);
    exitCode = 1;
  }
  postMessage({ type: 'exit', code: exitCode });
};
