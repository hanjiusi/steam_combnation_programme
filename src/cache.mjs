import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const pathFor = (directory, key) => join(directory, createHash('sha256').update(key).digest('hex') + '.json');
export async function readCache(directory, key, maxAgeMs) {
  if (!directory) return null;
  try {
    const entry = JSON.parse(await readFile(pathFor(directory, key), 'utf8'));
    if (!Number.isFinite(entry.savedAt) || Date.now() - entry.savedAt > maxAgeMs) return null;
    return entry.value;
  } catch { return null; }
}
export async function writeCache(directory, key, value) {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const destination = pathFor(directory, key);
  const temporary = destination + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), value }), 'utf8');
  await rename(temporary, destination);
}
