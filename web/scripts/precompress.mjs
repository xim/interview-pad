// Writes .br and .gz siblings for the compressible files in dist/ (served by server/app.py's Static), at settings
// far too slow to compress per request. Results are cached by content hash in $COMPRESS_CACHE, if set (a cache mount
// in the Containerfile), so unchanged files such as the compiler aren't recompressed on every build.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const dist = new URL('../dist/', import.meta.url).pathname;
const COMPRESSIBLE = /\.(m?js|css|html|json|txt|wasm|tar|ttf|svg)$/; // zips and wheels are compressed already
const MIN_SIZE = 1024;
const cacheDir = process.env.COMPRESS_CACHE;

const ENCODINGS = {
  br: (data) =>
    promisify(brotliCompress)(data, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_LGWIN]: 24, // the 16 MB maximum window helps the large wasm files
        [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    }),
  gz: (data) => promisify(gzip)(data, { level: 9 }),
};

async function compressed(data, ext) {
  const file = cacheDir && join(cacheDir, `${createHash('sha256').update(data).digest('hex')}.${ext}`);
  if (file) {
    try {
      return await readFile(file);
    } catch {}
  }
  const out = await ENCODINGS[ext](data);
  if (file) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, out);
  }
  return out;
}

const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter((e) => e.isFile() && COMPRESSIBLE.test(e.name))
  .map((e) => join(e.parentPath, e.name));

let before = 0;
let after = 0;
await Promise.all(
  files.map(async (path) => {
    const data = await readFile(path);
    if (data.length < MIN_SIZE) return;
    before += data.length;
    let best = data.length;
    for (const ext of Object.keys(ENCODINGS)) {
      const out = await compressed(data, ext);
      if (out.length >= data.length * 0.95) continue; // not worth an encoding
      await writeFile(`${path}.${ext}`, out);
      best = Math.min(best, out.length);
    }
    after += best;
  }),
);
const mb = (n) => (n / 1e6).toFixed(1);
console.log(`precompress: ${files.length} files, ${mb(before)} MB -> ${mb(after)} MB with the best encoding`);
