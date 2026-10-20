import { commands, Exit } from '@yowasp/clang';

import RUNTIME from './runtime.c?raw';

// Always passed, ahead of the user's flags (so those can still override). WASM doesn't fault on null or
// out-of-bounds accesses, so catch UB with UBSan (handlers in runtime.c) and libc++ hardening (which only
// prints its message with the experimental ENFORCE semantic; QUICK_ENFORCE traps silently).
const HIDDEN = {
  c: ['-fsanitize=undefined', '-fno-sanitize-recover=all'],
  cpp: [
    // exception runtime built by scripts/clang-eh.mjs; the tag export lets wasi.worker.ts report uncaught ones
    '-fwasm-exceptions',
    '-Wl,--export=__cpp_exception',
    '-fsanitize=undefined',
    '-fno-sanitize-recover=all',
    '-fexperimental-library',
    '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST',
    '-D_LIBCPP_ASSERTION_SEMANTIC=_LIBCPP_ASSERTION_SEMANTIC_ENFORCE',
  ],
};

const post = (text: string) => postMessage({ type: 'out', text });
const decoder = new TextDecoder();
const write = (bytes: Uint8Array | null) => bytes && post(decoder.decode(bytes, { stream: true }));

let lastPct = -1;
const fetchProgress = ({ doneLength, totalLength }: { doneLength: number; totalLength: number }) => {
  const pct = Math.floor((doneLength / totalLength) * 20) * 5;
  if (pct === lastPct) return;
  lastPct = pct;
  postMessage({ type: 'status', text: pct < 100 ? `Downloading compiler ${pct}%` : 'Compiling' });
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
    post(`$ ${name} ${flags.join(' ')} ${source}\n`);
    const args = [...HIDDEN[lang], ...flags, ...Object.keys(files), '-o', 'main.wasm'];
    const out = await commands[name](args, files, { stdout: write, stderr: write, fetchProgress });
    const wasm = out!['main.wasm'] as Uint8Array;
    postMessage({ type: 'exit', code: 0, wasm });
  } catch (e) {
    if (!(e instanceof Exit)) post(`${e}\n`);
    postMessage({ type: 'exit', code: e instanceof Exit ? e.code : 1 });
  }
};
