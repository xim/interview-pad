// A minimal in-memory node:fs for TS programs (js.worker.ts loads it as source, fresh each run). Declared for the
// editor in ts.ts.
const files = new Map(); // path -> Uint8Array
const dirs = new Set(['/', '/tmp']);

const resolve = (path) => {
  const parts = [];
  for (const part of String(path).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
};
const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const error = (code, what, syscall, path) => Object.assign(new Error(`${code}: ${what}, ${syscall} '${path}'`), { code, syscall, path });
const noEntry = (syscall, path) => error('ENOENT', 'no such file or directory', syscall, path);
const encoding = (options) => (typeof options === 'string' ? options : options?.encoding);
const toBytes = (data) =>
  typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data.buffer ?? data, data.byteOffset, data.byteLength);

function writable(path) {
  const p = resolve(path);
  if (!dirs.has(parent(p))) throw noEntry('open', path);
  if (dirs.has(p)) throw error('EISDIR', 'illegal operation on a directory', 'open', path);
  return p;
}

export function readFileSync(path, options) {
  const data = files.get(resolve(path));
  if (!data) throw dirs.has(resolve(path)) ? error('EISDIR', 'illegal operation on a directory', 'read', path) : noEntry('open', path);
  return encoding(options) ? new TextDecoder(encoding(options)).decode(data) : data.slice();
}

export function writeFileSync(path, data) {
  files.set(writable(path), toBytes(data).slice());
}

export function appendFileSync(path, data) {
  const p = writable(path);
  const old = files.get(p) ?? new Uint8Array();
  const add = toBytes(data);
  const joined = new Uint8Array(old.length + add.length);
  joined.set(old);
  joined.set(add, old.length);
  files.set(p, joined);
}

export const existsSync = (path) => files.has(resolve(path)) || dirs.has(resolve(path));

export function mkdirSync(path, options) {
  const p = resolve(path);
  if (options?.recursive) {
    for (let d = p; d !== '/' && !dirs.has(d); d = parent(d)) {
      if (files.has(d)) throw error('EEXIST', 'file already exists', 'mkdir', path);
      dirs.add(d);
    }
    return;
  }
  if (existsSync(p)) throw error('EEXIST', 'file already exists', 'mkdir', path);
  if (!dirs.has(parent(p))) throw noEntry('mkdir', path);
  dirs.add(p);
}

export function readdirSync(path) {
  const p = resolve(path);
  if (!dirs.has(p)) throw noEntry('scandir', path);
  return [...dirs, ...files.keys()]
    .filter((e) => e !== '/' && parent(e) === p)
    .map((e) => e.slice(e.lastIndexOf('/') + 1))
    .sort();
}

export function rmSync(path, options) {
  const p = resolve(path);
  if (files.delete(p)) return;
  if (!dirs.has(p)) {
    if (!options?.force) throw noEntry('rm', path);
    return;
  }
  if (!options?.recursive) throw error('ERR_FS_EISDIR', 'is a directory', 'rm', path);
  for (const e of [...dirs, ...files.keys()]) if (e === p || e.startsWith(`${p}/`)) dirs.delete(e) || files.delete(e);
}

export function unlinkSync(path) {
  if (!files.delete(resolve(path))) throw noEntry('unlink', path);
}

export default { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync };
