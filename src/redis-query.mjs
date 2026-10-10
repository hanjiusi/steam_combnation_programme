import net from 'node:net';
import { readFile } from 'node:fs/promises';
const manifestUrl = new URL('../pipeline/results/stream-runtime.json', import.meta.url);
const MAX_BYTES = 1024 * 1024;
const HOST = '127.0.0.1';
const PORT = 6379;

export async function readStreamRuntime() {
  try {
    const raw = await readFile(manifestUrl, 'utf8');
    if (Buffer.byteLength(raw) > 100_000) throw new Error('Manifest too large');
    const manifest = JSON.parse(raw);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(manifest.catalogVersion ?? '')) throw new Error('Invalid catalog version');
    return {
      configured: true, catalogVersion: manifest.catalogVersion,
      engine: manifest.engine, mode: manifest.mode, status: manifest.status,
      verifiedAt: manifest.verifiedAt, users: manifest.users,
      events: manifest.events, source: manifest.source,
    };
  } catch { return { configured: false, reason: 'stream_runtime_not_configured' }; }
}

function getRedis(key) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    let incoming = Buffer.alloc(0), settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true; socket.destroy();
      if (error) reject(error); else resolve(result);
    }
    socket.setTimeout(2000, () => finish(new Error('Redis timeout')));
    socket.on('error', error => finish(error));
    socket.on('end', () => { if (!settled) finish(new Error('Incomplete Redis response')); });
    socket.on('connect', () => {
      socket.write(`*2\r\n$3\r\nGET\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`);
    });
    socket.on('data', chunk => {
      if (incoming.length + chunk.length > MAX_BYTES + 64) return finish(new Error('Redis profile exceeds limit'));
      incoming = Buffer.concat([incoming, chunk]);
      const headerEnd = incoming.indexOf('\r\n');
      if (headerEnd < 0) return;
      const header = incoming.subarray(0, headerEnd).toString('ascii');
      if (!/^\$-?\d+$/.test(header)) return finish(new Error('Unexpected Redis response'));
      const bytes = Number(header.slice(1));
      if (bytes === -1) return finish(null, null);
      if (bytes < 0 || bytes > MAX_BYTES) return finish(new Error('Invalid Redis size'));
      const start = headerEnd + 2;
      if (incoming.length < start + bytes + 2) return;
      if (incoming[start + bytes] !== 13 || incoming[start + bytes + 1] !== 10) return finish(new Error('Invalid Redis terminator'));
      finish(null, incoming.subarray(start, start + bytes).toString('utf8'));
    });
  });
}

export async function readStreamProfile(steamid) {
  if (!/^\d{17}$/.test(String(steamid))) throw new TypeError('Steam ID64 must have 17 digits');
  const runtime = await readStreamRuntime();
  if (!runtime.configured) return { available: false, result: null, reason: runtime.reason };
  try {
    const raw = await getRedis(`steam:profile:${runtime.catalogVersion}:${steamid}`);
    if (raw === null) return { available: true, result: null, runtime };
    const result = JSON.parse(raw);
    if (result.steamid !== String(steamid) || result.catalogVersion !== runtime.catalogVersion || !Array.isArray(result.tags)) {
      throw new Error('Redis profile identity mismatch');
    }
    return { available: true, result, runtime };
  } catch {
    return { available: false, result: null, reason: 'redis_unavailable', runtime };
  }
}
