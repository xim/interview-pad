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

// Preamble PCH, as clangd does: the leading block of #include lines is precompiled with the same flags, so re-runs
// skip re-parsing the standard headers. Only exactly those headers, so a missing #include still fails. On a cache
// miss it's built first and then compiled against, so the work isn't duplicated (nor done in the background).
const PREAMBLE = /^(?:[ \t]*(?:#[ \t]*include[ \t]*[<"][^>"\n]+[>"][ \t]*)?(?:\/\/[^\n]*)?\n)*/;
const MAX_PCHS = 3; // ~10-15 MB each
const pchs = new Map<string, Uint8Array>();
// key -> reason; not retried (e.g. a device where it runs out of memory) until includes or flags change
const pchFailed = new Map<string, string>();
async function buildPch(key: string, preamble: string, args: string[]) {
  let stderr = '';
  try {
    const out = await commands['clang++'](
      [...args, '-Xclang', '-fno-pch-timestamp', '-x', 'c++-header', 'pre.hpp', '-o', 'pre.pch'],
      { 'pre.hpp': preamble },
      { stdout: null, stderr: (b) => b && (stderr += decoder.decode(b)), fetchProgress },
    );
    pchs.set(key, out!['pre.pch'] as Uint8Array);
    if (pchs.size > MAX_PCHS) pchs.delete(pchs.keys().next().value!);
    return pchs.get(key);
  } catch (e) {
    pchFailed.set(key, stderr.split('\n').find((l) => /error/i.test(l)) ?? String(e).split('\n')[0]);
  }
}

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
  const { lang, src, flags } = data as { lang: 'c' | 'cpp'; src: string; flags: string[] };
  const name = lang === 'c' ? 'clang' : 'clang++';
  const source = `main.${lang}`;
  const language = [...HIDDEN_FLAGS[lang].filter((f) => !f.startsWith('-Wl,')), ...flags];
  const preamble = lang === 'cpp' ? PREAMBLE.exec(src)![0] : ''; // C compiles fast enough without
  const key = JSON.stringify([language, preamble]);
  const inputs: Record<string, string | Uint8Array> = { [source]: src, [`runtime.${lang}`]: RUNTIME };
  if (lang === 'cpp') inputs['libeh.a'] = await libeh!;
  post(echo([name, ...flags, source]));
  // colors aren't on by default since this isn't a terminal; the output pane renders ANSI
  const args = ['-fcolor-diagnostics', '-fansi-escape-codes', ...HIDDEN_FLAGS[lang], ...flags];
  compileStart = performance.now();
  const cached = pchs.get(key);
  const wanted = /#[ \t]*include/.test(preamble) && !pchFailed.has(key);
  const pch = cached ?? (wanted ? await buildPch(key, preamble, language) : undefined);
  const pchArgs = pch ? ['-include-pch', 'pre.pch'] : [];
  const pchFiles: Record<string, string | Uint8Array> = pch ? { 'pre.hpp': preamble, 'pre.pch': pch } : {};
  const pchNote = pch && (cached ? 'cached' : 'built');
  try {
    const out = await commands[name]([...args, ...pchArgs, ...Object.keys(inputs), '-o', 'a.out'], { ...inputs, ...pchFiles }, {
      stdout: write,
      stderr: write,
      fetchProgress,
    });
    const wasm = out!['a.out'] as Uint8Array;
    // a failure the real compile didn't hit isn't the user's #include; show it (e.g. out of memory)
    if (wanted && !pch) post(`\x1b[2m(precompiled headers unavailable: ${pchFailed.get(key)})\x1b[0m\n`);
    postMessage({ type: 'exit', code: 0, wasm, ms: performance.now() - compileStart, pch: pchNote });
  } catch (e) {
    if (!(e instanceof Exit)) post(`${e}\n`);
    postMessage({ type: 'exit', code: e instanceof Exit ? e.code : 1, ms: performance.now() - compileStart, pch: pchNote });
  }
};
