// Runs one JS program as an ES module; console output is forwarded as {type: 'out'}.
// The program ends when module evaluation settles: pending timers/promises are dropped.
const post = (text: string) => postMessage({ type: 'out', text });

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

onmessage = async ({ data: code }: MessageEvent<string>) => {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  let exitCode = 0;
  try {
    await import(/* @vite-ignore */ url);
  } catch (e) {
    post(`Uncaught ${format(e)}\n`);
    exitCode = 1;
  }
  postMessage({ type: 'exit', code: exitCode });
};
