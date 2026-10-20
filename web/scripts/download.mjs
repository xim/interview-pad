// fetch() that keeps a copy in $DOWNLOAD_CACHE (a cache mount in the Containerfile), if set.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function download(url) {
  const dir = process.env.DOWNLOAD_CACHE;
  const file = dir && join(dir, createHash('sha256').update(url).digest('hex'));
  if (file) {
    try {
      return await readFile(file);
    } catch {}
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (file) {
    await mkdir(dir, { recursive: true });
    await writeFile(file, buf);
  }
  return buf;
}
