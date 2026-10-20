// Self-hosts Pyodide in public/pyodide: the core from node_modules plus a few prebuilt packages
// (and their deps) from the Pyodide CDN, verified against the lock file, which is trimmed to what's hosted.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const PACKAGES = ['numpy', 'pyyaml', 'sortedcontainers', 'regex', 'more-itertools'];
const CORE = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip'];

const src = new URL('../node_modules/pyodide/', import.meta.url);
const dest = new URL('../public/pyodide/', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', src)));
const lock = JSON.parse(await readFile(new URL('pyodide-lock.json', src)));

await mkdir(dest, { recursive: true });
for (const f of CORE) await copyFile(new URL(f, src), new URL(f, dest));

const wanted = new Set();
const visit = (name) => {
  if (wanted.has(name)) return;
  if (!lock.packages[name]) throw new Error(`unknown Pyodide package: ${name}`);
  wanted.add(name);
  lock.packages[name].depends.forEach(visit);
};
PACKAGES.forEach(visit);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
for (const name of wanted) {
  const { file_name, sha256: expected } = lock.packages[name];
  const file = new URL(file_name, dest);
  if ((await readFile(file).then(sha256, () => null)) === expected) continue;
  const r = await fetch(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${file_name}`);
  if (!r.ok) throw new Error(`${file_name}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha256(buf) !== expected) throw new Error(`${file_name}: sha256 mismatch`);
  await writeFile(file, buf);
  console.log(`pyodide: fetched ${file_name}`);
}

lock.packages = Object.fromEntries([...wanted].map((n) => [n, lock.packages[n]]));
await writeFile(new URL('pyodide-lock.json', dest), JSON.stringify(lock));
