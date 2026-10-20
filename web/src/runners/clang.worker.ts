import { commands, Exit } from '@yowasp/clang';

import { HIDDEN_FLAGS } from './clang-flags';
import { echo } from './echo';
import RUNTIME from './runtime.c?raw';


const post = (text: string) => postMessage({ type: 'out', text });
const decoder = new TextDecoder();
const write = (bytes: Uint8Array | null) => bytes && post(decoder.decode(bytes, { stream: true }));

let lastPct = -1;
let compileStart = 0;
const fetchProgress = ({ doneLength, totalLength }: { doneLength: number; totalLength: number }) => {
  const pct = Math.floor((doneLength / totalLength) * 20) * 5;
  if (pct === lastPct) return;
  lastPct = pct;
  postMessage({ type: 'status', text: pct < 100 ? `Downloading compiler ${pct}%` : 'Compiling' });
  if (pct === 100) compileStart = performance.now(); // a first-run download doesn't count as compile time
};

let libeh: Promise<Uint8Array> | undefined;

onmessage = async ({ data }) => {
  if (data.init) {
    libeh = fetch(`${data.init}libeh.a`).then(async (r) => {
      if (!r.ok) throw new Error(`libeh.a: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    return;
  }
  if (data.preload) {
    try {
      await commands.clang(['--version'], {}, { stdout: null, fetchProgress });
    } catch {}
    return;
  }
  postMessage({ type: 'status', text: 'Compiling' });
  try {
    const { lang, src, flags } = data as { lang: 'c' | 'cpp'; src: string; flags: string[] };
    const name = lang === 'c' ? 'clang' : 'clang++';
    const source = `main.${lang}`;
    const files: Record<string, string | Uint8Array> = { [source]: src, [`runtime.${lang}`]: RUNTIME };
    if (lang === 'cpp') files['libeh.a'] = await libeh!;
    post(echo([name, ...flags, source]));
    // colors aren't on by default since this isn't a terminal; the output pane renders ANSI
    const args = ['-fcolor-diagnostics', '-fansi-escape-codes', ...HIDDEN_FLAGS[lang], ...flags, ...Object.keys(files), '-o', 'a.out'];
    compileStart = performance.now();
    const out = await commands[name](args, files, { stdout: write, stderr: write, fetchProgress });
    const wasm = out!['a.out'] as Uint8Array;
    postMessage({ type: 'exit', code: 0, wasm, ms: performance.now() - compileStart });
  } catch (e) {
    if (!(e instanceof Exit)) post(`${e}\n`);
    postMessage({ type: 'exit', code: e instanceof Exit ? e.code : 1, ms: performance.now() - compileStart });
  }
};
