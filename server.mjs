import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { obtainPlayer, SteamError } from './src/steam.mjs';
import { buildProfile } from './src/analytics.mjs';
import { publishStreamSnapshot } from './src/stream-engine.mjs';
import { readStreamProfile, readStreamRuntime } from './src/redis-query.mjs';
import { readBackground, mergeBackground } from './src/background.mjs';
import { runSparkProfile } from './src/spark-engine.mjs';
import { saveSteamKey, readSteamKey } from './src/key-store.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const jsonFile = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
async function readEnv() {
  try {
    const text = await readFile(path.join(ROOT, '.env'), 'utf8');
    const values = {};
    for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
    return values;
  } catch { return {}; }
}
export async function loadLocalCatalog() {
  try { return await jsonFile(path.join(ROOT, 'data', 'catalog.json')); }
  catch { return { games: [], source: 'not_seeded', fetchedAt: null }; }
}
export async function loadCatalog() { return mergeBackground(await loadLocalCatalog(), await readBackground(ROOT)); }
async function demoProfile(catalog, weightMode) {
  const demo = await jsonFile(path.join(ROOT, 'data', 'demo-player.json'));
  const index = new Map(catalog.games.map(g => [Number(g.appid), g]));
  demo.games = demo.games.map(g => ({ ...g, ...(index.get(g.appid) || {}), playtime_forever: g.playtime_forever }));
  if (!demo.games.some(g => g.tags?.length)) throw new SteamError('catalog_missing', '尚未准备游戏标签，请先运行 npm run seed。', 503);
  return buildProfile(demo, catalog, { weightMode });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function bodyJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new SteamError('body_too_large', '请求过大。', 413);
    chunks.push(chunk);
  }
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new SteamError('invalid_content_type', '请发送 JSON 请求。', 415);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SteamError('invalid_json', '请求格式不正确。', 400); }
}
export function createApp(config = {}) {
  const jobs = new Map();
  let apiKey = config.apiKey || '';
  const allowPublic = config.allowPublic === true;
  const acquire = config.obtainPlayerImpl || obtainPlayer;
  const analyze = config.buildProfileImpl || buildProfile;
  const catalogReader = config.readCatalogImpl || loadCatalog;
  const snapshotReader = config.readSnapshotImpl || (async id => {const file=path.join(ROOT,'data','snapshots',id+'.json');try {const saved=await jsonFile(file);if(!saved.profile?.tags||saved.profile.player?.steamid!==id)throw new SteamError('snapshot_invalid','快照格式不完整，请联网更新画像。',422);return {...saved.profile,loadedFromSnapshot:true,snapshotSavedAt:(await stat(file)).mtime.toISOString()};}catch(error){if(error.code==='ENOENT')throw new SteamError('snapshot_not_found','请先联网更新一次画像，之后即可离线查看。',404);throw error;}});
  const persist = config.persist !== false;
  const creationTimes = [];
  async function runJob(job, input) {
    job.status = 'running';
    const progress = update => { job.progress = typeof update === 'string' ? { stage: 'fetching', message: update } : { stage: update.stage || 'tags', message: update.message || '正在关联游戏标签…', completed: update.completed ?? update.processed ?? 0, total: update.total ?? 0 }; };
    try {
      const player = await acquire(input.steamInput, {
        apiKey, cacheDir: path.join(ROOT, 'data', 'cache'), maxGames: input.maxGames,
        onProgress: progress
      }, progress);
      const observedAt=new Date().toISOString();
      const catalog = await catalogReader();
      // Add actually fetched, tagged games to the local background catalog, never synthetic behavior.
      const merged = new Map(catalog.games.map(g => [Number(g.appid), g]));
      for (const game of player.games) if (game.tags?.length) merged.set(Number(game.appid), {
        appid: game.appid, name: game.name, tags: game.tags, genres: game.genres || [], source: game.source, fetchedAt: game.fetchedAt
      });
      const nextCatalog = { ...catalog, games: [...merged.values()], fetchedAt: new Date().toISOString() };
      progress({ stage: 'analyzing', message: '正在计算多标签偏好与共现关系…', completed: player.games.length, total: player.games.length });
      let result = analyze(player, nextCatalog, { weightMode: input.weightMode });
      result.method.computeEngine = 'Node.js reference implementation';
      if (config.profileEngine === 'spark') result = await runSparkProfile(ROOT, job.id, player, nextCatalog, result, progress);
      if (persist) {
        await mkdir(path.join(ROOT, 'data', 'snapshots'), { recursive: true });
        await mkdir(path.join(ROOT, 'data', 'events'), { recursive: true });
        // Serialize catalog writes so concurrent jobs do not silently overwrite acquired tags.
        config.catalogWriteChain = (config.catalogWriteChain || Promise.resolve()).catch(() => {}).then(async () => {
          const latest = await loadLocalCatalog();
          const combined = new Map(latest.games.map(g => [Number(g.appid), g]));
          for (const g of player.games) if(g.tags?.length) combined.set(Number(g.appid), {appid:g.appid,name:g.name,tags:g.tags,source:g.source,fetchedAt:g.fetchedAt});
          await writeFile(path.join(ROOT, 'data', 'catalog.json'), JSON.stringify({source:'steam_store_public_pages',fetchedAt:nextCatalog.fetchedAt,games:[...combined.values()]}, null, 2));
        });
        await config.catalogWriteChain;
        await writeFile(path.join(ROOT, 'data', 'snapshots', `${player.steamid}.json`), JSON.stringify({ player, profile: result }, null, 2));
        const events = player.games.map(g => JSON.stringify({ eventId: `${job.id}:${g.appid}`, eventType: 'library_snapshot', observedAt, userId: player.steamid, appid: g.appid, name: g.name, playtime_forever: g.playtime_forever, tags: g.tags || [], source: g.source }));
        const eventFile=path.join(ROOT,'data','events',`${job.id}.ndjson`);
        if(events.length){
          await appendFile(eventFile,events.join('\n')+'\n');
          result.method.streamDelivery=await (config.publishStreamSnapshotImpl||publishStreamSnapshot)(ROOT,eventFile,progress);
          await writeFile(path.join(ROOT,'data','snapshots',`${player.steamid}.json`),JSON.stringify({player,profile:result},null,2));
        }
      }
      job.result = result; job.status = 'complete';
      progress({ stage: 'complete', message: '画像已生成。', completed: player.games.length, total: player.games.length });
    } catch (error) {
      job.status = 'error';
      // Never forward upstream URLs, which may contain the service API key.
      job.error = { code: error.code || 'internal_error', message: error instanceof SteamError ? error.message : '生成画像失败，请稍后重试。' };
    }
  }
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // 默认仅接受本机 Host（防 DNS rebinding 等）；公网穿透模式(ALLOW_PUBLIC=1)下放行隧道域名。
      const host = String(req.headers.host || '');
      const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
      if (!localHost && !allowPublic) throw new SteamError('invalid_host', '仅支持本机访问。', 403);
      const url = new URL(req.url, `http://${host}`);
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const origin = req.headers.origin;
        // 隧道出口为 HTTPS，cloudflared 会带上 X-Forwarded-Proto，据此还原外部协议。
        const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
        if (origin && origin !== `${proto}://${host}`) throw new SteamError('invalid_origin', '请求来源不受支持。', 403);
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const c = await catalogReader();
        return reply(res, 200, { apiKeyConfigured: !!apiKey, catalogGames: c.games.length, catalogFetchedAt: c.fetchedAt, version: '1.0.0', runtime: 'local', bigDataPipeline: c.reference?'public_corpus_ready':'not_loaded', historical: c.reference?{catalogTaggedGames:c.reference.catalogTaggedGames,population:c.reference.population?.users,provenance:c.reference.provenance}:null, profileEngine: config.profileEngine || 'node' });
      }
      if(req.method==='GET' && url.pathname==='/api/big-data'){
        const optional=async filename=>{try{return await jsonFile(path.join(ROOT,filename));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
        const [manifest,batch,warehouse,stream]=await Promise.all([optional('data/public-steam/manifest.json'),optional('data/public-steam/results/run.json'),optional('docs/warehouse-verification.json'),(config.readStreamRuntimeImpl||readStreamRuntime)()]);
        return reply(res,200,{historicalSource:manifest,batch,warehouse,stream,scope:'Local execution with historical public Steam data'});
      }
      if(req.method==='GET' && url.pathname.startsWith('/api/reco/')){
        // 推荐演示数据(BDS 协同): web-data/{meta,users,items}.json 与逐用户 reco/<id>.json
        const rel=url.pathname.slice('/api/reco/'.length);
        const send=async file=>{const text=(await readFile(file,'utf8')).replace(/^\uFEFF/,'');res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(text);};
        try{
          if(rel==='meta.json'||rel==='users.json'||rel==='items.json')return await send(path.join(ROOT,'web-data',rel));
          const userFile=rel.match(/^user\/(\d{1,9})\.json$/);
          if(userFile)return await send(path.join(ROOT,'web-data','reco',`${userFile[1]}.json`));
          throw new SteamError('not_found','推荐数据不存在。',404);
        }catch(error){
          if(error.code==='ENOENT')throw new SteamError('reco_user_missing','该用户不在演示名单中（40 人），或推荐数据尚未生成。',404);
          throw error;
        }
      }
      if(req.method==='GET' && url.pathname.startsWith('/api/stream-profiles/')){
        const id=url.pathname.slice('/api/stream-profiles/'.length);
        if(!/^7656\d{13}$/.test(id))throw new SteamError('invalid_steam_id','请输入正确的 Steam ID64。',400);
        return reply(res,200,await (config.readStreamProfileImpl||readStreamProfile)(id));
      }
      if(req.method==='GET' && url.pathname.startsWith('/api/snapshots/')){const id=url.pathname.slice('/api/snapshots/'.length);if(!/^7656\d{13}$/.test(id))throw new SteamError('invalid_steam_id','请输入正确的 Steam ID64。',400);return reply(res,200,{result:await snapshotReader(id)});}
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await bodyJson(req);
        const key = String(body.apiKey || '').trim();
        if (!/^[a-fA-F0-9]{32}$/.test(key)) throw new SteamError('invalid_api_key', 'Steam Web API key 应为 32 位十六进制字符。', 400);
        const storage = persist ? await (config.saveSteamKeyImpl || saveSteamKey)(ROOT, key) : { persistence: 'memory' };
        apiKey = key;
        return reply(res, 200, { apiKeyConfigured: true, persistence: storage.persistence });
      }
      if (req.method === 'GET' && url.pathname === '/api/demo') {
        return reply(res, 200, await demoProfile(await catalogReader(), url.searchParams.get('weightMode') || 'balanced'));
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const input = await bodyJson(req);
        const steamInput = String(input.steamInput || '').trim();
        if (!steamInput || steamInput.length > 200) throw new SteamError('invalid_steam_id', '请输入 Steam ID64 或个人主页链接。', 400);
        if (!['balanced', 'time'].includes(input.weightMode || 'balanced')) throw new SteamError('invalid_weight_mode', '画像权重模式不支持。', 400);
        const maxGames = input.maxGames === undefined ? 300 : Number(input.maxGames);
        if (!Number.isInteger(maxGames) || maxGames < 1 || maxGames > 2000) throw new SteamError('invalid_max_games', '分析数量须为 1 至 2000 的整数。', 400);
        if ([...jobs.values()].filter(j => j.status === 'running' || j.status === 'queued').length >= 2) throw new SteamError('busy', '已有画像正在生成，请等待完成。', 429);
        const now = Date.now();
        while (creationTimes.length && creationTimes[0] < now - 60000) creationTimes.shift();
        if (creationTimes.length >= 12) throw new SteamError('rate_limit', '请求过于频繁，请稍后重试。', 429);
        creationTimes.push(now);
        for (const [id, j] of jobs) if (j.createdAt < now - 1800000 && !['running','queued'].includes(j.status)) jobs.delete(id);
        const job = { id: randomUUID(), status: 'queued', createdAt: now, progress: { stage: 'queued', message: '准备获取游戏数据…', completed: 0, total: 0 } };
        jobs.set(job.id, job);
        reply(res, 202, { jobId: job.id });
        setImmediate(() => runJob(job, { steamInput, weightMode: input.weightMode || 'balanced', maxGames }));
        return;
      }
      if (req.method === 'GET' && /^\/api\/jobs\/[0-9a-f-]{36}$/.test(url.pathname)) {
        const job = jobs.get(url.pathname.split('/').pop());
        return job ? reply(res, 200, job) : reply(res, 404, { error: { code: 'job_not_found', message: '任务已过期，请重新生成。' } });
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return reply(res, 200, { ok: true });
      if (url.pathname.startsWith('/api/')) return reply(res, 404, { error: { code: 'not_found', message: '接口不存在。' } });
      if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: { code: 'method_not_allowed', message: '请求方法不支持。' } });
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const full = path.resolve(PUBLIC, relative);
      if (!full.startsWith(PUBLIC + path.sep) || !MIME[path.extname(full)]) return reply(res, 404, { error: { code: 'not_found', message: '文件不存在。' } });
      let content;
      try { content = await readFile(full); } catch { return reply(res, 404, { error: { code: 'not_found', message: '文件不存在。' } }); }
      if (relative === 'report.html') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      reply(res, error.status || 500, { error: { code: error.code || 'internal_error', message: error instanceof SteamError ? error.message : '本机服务处理失败。' } });
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = await readEnv();
  const port = Number(process.env.PORT || env.PORT || 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024..65535');
  const profileEngine = process.env.PROFILE_ENGINE || env.PROFILE_ENGINE || 'node';
  if (!['node', 'spark'].includes(profileEngine)) throw new Error('PROFILE_ENGINE must be node or spark');
  const allowPublic = /^(1|true|yes)$/i.test(String(process.env.ALLOW_PUBLIC || env.ALLOW_PUBLIC || ''));
  const app = createApp({ apiKey: process.env.STEAM_API_KEY || env.STEAM_API_KEY || await readSteamKey(ROOT), profileEngine, allowPublic });
  app.listen(port, '127.0.0.1', () => console.log(`Steam Taste Atlas: http://127.0.0.1:${port}${allowPublic ? ' (public tunnel mode)' : ''}`));
  app.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : 'Local server failed.'); process.exitCode = 1; });
}



