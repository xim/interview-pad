// clangd for C/C++ editor features, built by tools/clangd/build.sh (emscripten, threaded: needs cross-origin
// isolation). LSP JSON-RPC objects travel on a MessagePort to Monaco's client (clangd.ts); this worker's own
// messages carry control (init, flags, completion toggle) and status.
// by path: the package's exports don't expose it; same file (and hashed asset) the compiler loads
import resourcesUrl from '../../node_modules/@yowasp/clang/gen/llvm-resources.tar?url';
import { HIDDEN_FLAGS } from './clang-flags';

type Lang = 'c' | 'cpp';
type Message = {
  id?: number | string;
  method?: string;
  params?: { textDocument?: { uri?: string } };
  error?: { code: number };
};

// ContentModified / RequestCancelled: routine for stale requests, but Monaco's client surfaces them as errors
const CANCELLED = new Set([-32801, -32800]);

const DOCS = /^file:\/\/\/main\.(c|cpp)$/; // Monaco's client syncs every model; keep Python/TS away from clangd
// what the bundled clang uses (its resource tarball is mounted at /usr), so clangd sees the same headers
const BASE = ['--target=wasm32-wasip1', '-resource-dir=/usr', '--sysroot=/usr'];
const COMPLETION = new Set(['textDocument/completion', 'textDocument/signatureHelp']);

let port: MessagePort;
let flags: Record<Lang, string[]> | undefined;
let initializeId: Message['id'];
let initialized = false;
let completion = true;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// stdin: emscripten pulls one byte at a time; null ends the current read. The patched clangd awaits
// stdinReady() before each read.
const chunks: Uint8Array[] = [];
let chunk: Uint8Array | undefined;
let pos = 0;
let wake: (() => void) | undefined;

const stdin = () => {
  chunk ??= chunks.shift();
  if (chunk && pos < chunk.length) return chunk[pos++];
  chunk = undefined;
  pos = 0;
  return null;
};
const stdinReady = () =>
  chunk || chunks.length ? Promise.resolve() : new Promise<void>((resolve) => (wake = resolve));

function toClangd(message: unknown) {
  const body = encoder.encode(JSON.stringify(message));
  chunks.push(encoder.encode(`Content-Length: ${body.length}\r\n\r\n`), body);
  wake?.();
  wake = undefined;
}

// stdout: Content-Length framed JSON
let out: number[] = [];
let length = -1;
const stdout = (byte: number) => {
  out.push(byte);
  if (length < 0) {
    if (byte === 10 && out.at(-2) === 13 && out.at(-3) === 10) {
      length = Number(/Content-Length:\s*(\d+)/i.exec(decoder.decode(new Uint8Array(out)))?.[1] ?? 0);
      out = [];
    }
  } else if (out.length === length) {
    fromClangd(JSON.parse(decoder.decode(new Uint8Array(out))));
    out = [];
    length = -1;
  }
};

function fromClangd(message: Message) {
  if (message.error && CANCELLED.has(message.error.code)) message = { jsonrpc: '2.0', id: message.id, result: null } as Message;
  if (message.id !== undefined && message.id === initializeId && !message.method) {
    initialized = true;
    pushFlags();
  }
  port.postMessage(message);
}

function fromMonaco(message: Message) {
  const uri = message.params?.textDocument?.uri;
  const isRequest = message.id !== undefined && message.method;
  if ((uri && !DOCS.test(uri)) || (!completion && COMPLETION.has(message.method!))) {
    if (isRequest) port.postMessage({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'initialize') initializeId = message.id;
  toClangd(message);
}

function pushFlags() {
  if (!initialized || !flags) return;
  const command = (lang: Lang) => ({
    workingDirectory: '/',
    compilationCommand: [
      lang === 'c' ? 'clang' : 'clang++',
      ...BASE,
      ...HIDDEN_FLAGS[lang].filter((f) => !f.startsWith('-Wl,')),
      ...flags![lang],
      `/main.${lang}`,
    ],
  });
  const changes = { '/main.c': command('c'), '/main.cpp': command('cpp') };
  toClangd({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: { compilationDatabaseChanges: changes } } });
}

const status = (text: string) => postMessage({ status: text });

// Only for progress (and to warm the HTTP cache): emscripten then streams from the same URL, which lets
// the browser reuse its compiled-code cache across sessions; a blob: URL would defeat that.
async function fetchWithProgress(url: string) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
  const total = Number(r.headers.get('Content-Length')) || 0;
  let done = 0;
  let lastPct = -1;
  for (const reader = r.body.getReader(); ; ) {
    const { done: end, value } = await reader.read();
    if (end) break;
    done += value.length;
    const pct = total ? Math.min(99, Math.floor((done / total) * 100)) : -1;
    if (pct !== lastPct && pct % 10 === 0) status(`Loading C/C++ IntelliSense ${pct}%`);
    lastPct = pct;
  }
}

type FS = { mkdirTree(path: string): void; writeFile(path: string, data: Uint8Array): void };

// Minimal ustar reader (+ GNU long names); only headers are needed.
function untar(tar: Uint8Array, fs: FS, root: string) {
  const str = (off: number, len: number) => decoder.decode(tar.subarray(off, off + len)).replace(/\0.*$/s, '');
  let longName: string | undefined;
  for (let off = 0; off + 512 <= tar.length; ) {
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[off + 156]);
    const data = tar.subarray(off + 512, off + 512 + size);
    const prefix = str(off + 345, 155);
    const name = longName ?? (prefix ? `${prefix}/` : '') + str(off, 100);
    longName = undefined;
    if (!str(off, 100)) break;
    if (type === 'L') longName = decoder.decode(data).replace(/\0.*$/s, '');
    else if ((type === '0' || type === '\0') && name.startsWith('include/')) {
      const path = `${root}/${name}`;
      fs.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      fs.writeFile(path, data);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

async function start(base: string) {
  try {
    const [{ default: Clangd }, , tar] = await Promise.all([
      import(/* @vite-ignore */ `${base}clangd.js`),
      fetchWithProgress(`${base}clangd.wasm`),
      fetch(resourcesUrl).then((r) => r.arrayBuffer()),
    ]);
    const fail = () => status('C/C++ IntelliSense stopped');
    const clangd = await Clangd({
      thisProgram: '/usr/bin/clangd',
      stdin,
      stdinReady,
      stdout,
      stderr: () => {},
      onAbort: fail,
      onExit: fail,
    });
    untar(new Uint8Array(tar), clangd.FS, '/usr');
    clangd.callMain(['--header-insertion=never', '--background-index=false', '--pch-storage=memory', '-j=2']);
    status('');
  } catch (e) {
    status('C/C++ IntelliSense unavailable');
    console.warn('clangd:', e);
  }
}

onmessage = ({ data }) => {
  if (data.port) {
    port = data.port;
    port.onmessage = ({ data }) => fromMonaco(data);
    start(data.init);
  }
  if (data.flags) {
    flags = data.flags;
    pushFlags();
  }
  if ('completion' in data) completion = data.completion;
};
