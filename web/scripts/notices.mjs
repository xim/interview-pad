// Writes public/licenses.txt: the license texts of everything served to the browser (linked from the About dialog).
// Run after pyodide.mjs, which provides the Python wheels.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { download } from './download.mjs';

const web = new URL('../', import.meta.url);
const NODE_ONLY = new Set(['ws', '@types/emscripten']); // pyodide's dependencies for running under Node
const LICENSE_FILE = /^(licen[cs]e|copying|notice|thirdpartynotices)/i;

// Shipped without license files in their npm packages, or not from npm at all
const UPSTREAM = [
  ['YoWASP Clang (Clang/LLD toolchain package)', 'https://raw.githubusercontent.com/YoWASP/clang/develop/LICENSE.txt'],
  ['YoWASP runtime (bundled into YoWASP Clang)', 'https://raw.githubusercontent.com/YoWASP/runtime-js/develop/LICENSE.txt'],
  ['LLVM: Clang, LLD, libc++, libc++abi, libunwind, compiler-rt, clangd', 'https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-22.1.8/llvm/LICENSE.TXT'],
  ['wasi-libc', 'https://raw.githubusercontent.com/WebAssembly/wasi-libc/main/LICENSE'],
  ['musl (part of wasi-libc)', 'https://raw.githubusercontent.com/WebAssembly/wasi-libc/main/libc-top-half/musl/COPYRIGHT'],
  ['Pyodide', 'https://raw.githubusercontent.com/pyodide/pyodide/314.0.7/LICENSE'],
  ['CPython (in Pyodide)', 'https://raw.githubusercontent.com/python/cpython/v3.14.2/LICENSE'],
  ['Emscripten (runtime code in Pyodide and clangd)', 'https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.22/LICENSE'],
  ['clangd-in-browser (clangd build recipe and patch)', 'https://raw.githubusercontent.com/guyutongxue/clangd-in-browser/main/LICENSE'],
];

const sections = [];
const add = (title, text) => sections.push(`${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n\n${text.trim()}\n`);

// npm packages in the browser bundle: the runtime dependency closure
const seen = new Set();
async function npm(name) {
  if (seen.has(name) || NODE_ONLY.has(name)) return;
  seen.add(name);
  const dir = new URL(`node_modules/${name}/`, web);
  const pkg = JSON.parse(await readFile(new URL('package.json', dir)));
  const files = (await readdir(dir)).filter((f) => LICENSE_FILE.test(f)).sort();
  if (files.length) {
    const texts = await Promise.all(files.map((f) => readFile(new URL(f, dir), 'utf8')));
    add(`${name} ${pkg.version} (${pkg.license})`, texts.join('\n\n'));
  }
  for (const dep of Object.keys(pkg.dependencies ?? {})) await npm(dep);
}
for (const dep of Object.keys(JSON.parse(await readFile(new URL('package.json', web))).dependencies)) await npm(dep);

for (const [title, url] of UPSTREAM) add(title, (await download(url)).toString());

// Minimal zip reader for the wheels' license files (central directory + deflate)
function unzip(buf, wanted) {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const out = [];
  for (let p = buf.readUInt32LE(eocd + 16), n = buf.readUInt16LE(eocd + 10); n--; ) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const [nameLen, extraLen, commentLen] = [buf.readUInt16LE(p + 28), buf.readUInt16LE(p + 30), buf.readUInt16LE(p + 32)];
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const local = buf.readUInt32LE(p + 42);
    if (wanted(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      out.push([name, (method === 8 ? inflateRawSync(data) : data).toString('utf8')]);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const pyodide = new URL('public/pyodide/', web);
const lock = JSON.parse(await readFile(new URL('pyodide-lock.json', pyodide)));
for (const [name, { version, file_name }] of Object.entries(lock.packages).sort()) {
  const files = unzip(await readFile(new URL(file_name, pyodide)), (n) => {
    const [dir, ...rest] = n.split('/');
    return dir.endsWith('.dist-info') && (LICENSE_FILE.test(rest.at(-1)) || rest[0] === 'licenses') && !n.endsWith('/');
  });
  const metadata = unzip(await readFile(new URL(file_name, pyodide)), (n) => /\.dist-info\/METADATA$/.test(n))[0]?.[1] ?? '';
  const license = /^License-Expression: (.*)$/m.exec(metadata)?.[1] ?? /^License: (.*)$/m.exec(metadata)?.[1] ?? 'see below';
  add(`${name} ${version} (Python package; ${license})`, files.map(([, text]) => text).join('\n\n') || `License: ${license}`);
}

const HEADER = `interview-pad third-party notices

Components are used unmodified, except clangd (built from LLVM with a small stdin patch, see tools/clangd/ in the
interview-pad sources). Source code: MPL-2.0 parts (Pyodide, DOMPurify, orjson, tqdm) at https://github.com/pyodide/pyodide,
https://github.com/cure53/DOMPurify, https://github.com/ijl/orjson, https://github.com/tqdm/tqdm; the others at the
project pages linked from the About dialog.
`;
await writeFile(new URL('public/licenses.txt', web), `${HEADER}\n${sections.join('\n')}`);
console.log(`notices: wrote public/licenses.txt (${sections.length} components)`);
