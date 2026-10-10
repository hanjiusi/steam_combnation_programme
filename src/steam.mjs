import { join } from 'node:path';
import { readCache, writeCache } from './cache.mjs';

export class SteamError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'SteamError'; this.code = code; this.status = status; }
}
const API = 'https://api.steampowered.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let metadataQueue = Promise.resolve();
let lastMetadataRequest = 0;
const defaultCache = () => join(process.cwd(), 'data', 'cache');
const keyOf = options => options.apiKey ?? process.env.STEAM_API_KEY;
export function validateSteamId(value) {
  const text = String(value).trim();
  if (!/^\d{17}$/.test(text)) throw new SteamError('invalid_steam_id', '请输入 Steam ID64 或 steamcommunity.com 的个人主页链接。');
  const id = BigInt(text);
  if (id < 76561197960265728n || id > 76561202255233023n) throw new SteamError('invalid_steam_id', 'Steam ID64 不在个人账号的有效范围内。');
  return text;
}
export function decodeHtml(text) {
  return text.replace(/&(?:#x([\da-f]+)|#(\d+)|(amp|quot|apos|lt|gt|nbsp));/gi, (_, hex, dec, named) => {
    if (hex || dec) { const n = Number.parseInt(hex || dec, hex ? 16 : 10); return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[named.toLowerCase()];
  });
}
const clean = text => decodeHtml(text.replace(/<[^>]*>/g, '')).trim();
export function parseStoreTags(html) {
  const tags = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const className = match[1].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '';
    if (className.split(/\s+/).includes('app_tag')) {
      const tag = clean(match[2]);
      if (tag && tag !== '+' && !tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}
async function request(url, options = {}, format = 'json') {
  const fetchImpl = options.fetchImpl || fetch;
  try {
    const response = await fetchImpl(String(url), { signal: AbortSignal.timeout(options.timeoutMs || 12000), headers: { 'User-Agent': 'SteamTasteAtlas/1.0 (local educational portrait)', 'Accept-Language': 'en-US,en;q=0.8' }, redirect: 'follow' });
    if (response.status === 429) throw new SteamError('rate_limit', 'Steam 请求频率受限，请稍后重试。', 429);
    if ([401, 403].includes(response.status)) throw new SteamError('access_denied', 'Steam 拒绝访问，请检查服务器 API key 和数据公开状态。', 403);
    if (!response.ok) throw new SteamError('upstream_error', 'Steam 服务暂时不可用。', 502);
    return format === 'text' ? await response.text() : await response.json();
  } catch (error) {
    if (error instanceof SteamError) throw error;
    // Never propagate upstream exception text: it can contain the URL and secret API key.
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new SteamError(timedOut ? 'timeout' : 'network_error', timedOut ? 'Steam 请求超时，请重试。' : '无法连接 Steam 服务，请检查网络。', 502);
  }
}
function apiUrl(service, method, apiKey, params) {
  const url = new URL(`${API}/${service}/${method}/${method === 'GetPlayerSummaries' ? 'v2' : 'v1'}/`);
  url.searchParams.set('key', apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}
export async function resolveSteamId(input, options = {}) {
  if (typeof input !== 'string' || input.length > 256) throw new SteamError('invalid_steam_id', 'Steam ID 或主页链接格式不正确。');
  let value = input.trim();
  if (/^\d+$/.test(value)) return validateSteamId(value);
  if (/^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\//i.test(value)) {
    let url;
    try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); } catch { throw new SteamError('invalid_steam_id', 'Steam 主页链接格式不正确。'); }
    if (!['steamcommunity.com', 'www.steamcommunity.com'].includes(url.hostname) || url.username || url.password || url.port) throw new SteamError('invalid_steam_id', '仅支持 Steam 官方个人主页链接。');
    const match = url.pathname.match(/^\/(profiles|id)\/([^/]+)\/?$/);
    if (!match) throw new SteamError('invalid_steam_id', '请提供个人主页链接，不是游戏或社区页面。');
    if (match[1] === 'profiles') return validateSteamId(match[2]);
    value = match[2];
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new SteamError('invalid_steam_id', '自定义 Steam 主页名称格式不正确。');
  const apiKey = keyOf(options);
  if (!apiKey) {
    const xml = await request(`https://steamcommunity.com/id/${encodeURIComponent(value)}/?xml=1`, options, 'text');
    const id = xmlValue(xml, 'steamID64');
    if (!id) throw new SteamError('user_not_found', '公开 Steam 主页没有返回对应用户。', 404);
    return validateSteamId(id);
  }
  const payload = await request(apiUrl('ISteamUser', 'ResolveVanityURL', apiKey, { vanityurl: value }), options);
  if (payload.response?.success !== 1 || !payload.response.steamid) throw new SteamError('user_not_found', '没有找到这个 Steam 用户。', 404);
  return validateSteamId(payload.response.steamid);
}
async function playerSummary(steamid, options) {
  const payload = await request(apiUrl('ISteamUser', 'GetPlayerSummaries', keyOf(options), { steamids: steamid }), options);
  return payload.response?.players?.find(player => player.steamid === steamid) || null;
}
export async function fetchOwnedGames(steamid, options = {}) {
  steamid = validateSteamId(steamid);
  const apiKey = keyOf(options);
  if (!apiKey) throw new SteamError('missing_api_key', '服务端尚未配置 Steam Web API key，配置一次后即可查询公开游戏库。', 503);
  const payload = await request(apiUrl('IPlayerService', 'GetOwnedGames', apiKey, { steamid, include_appinfo: 1, include_played_free_games: 1, language: options.language || 'schinese' }), options);
  const response = payload.response;
  if (!response || (!Array.isArray(response.games) && response.game_count !== 0)) {
    let summary = null;
    try { summary = await playerSummary(steamid, options); } catch { /* Visibility remains unknown, never assume empty. */ }
    if (summary?.communityvisibilitystate === 1) throw new SteamError('private', '该用户主页为私密，无法生成真实画像。', 403);
    throw new SteamError('not_visible', '游戏详情不可见或账号不存在。请将游戏详情和游玩时长设为公开后重试。', 403);
  }
  const unique = new Map();
  for (const game of response.games || []) {
    if (!Number.isSafeInteger(game.appid) || game.appid <= 0) continue;
    unique.set(game.appid, { appid: game.appid, name: typeof game.name === 'string' ? game.name : `App ${game.appid}`, playtime_forever: Math.max(0, Number(game.playtime_forever) || 0), ...(game.playtime_2weeks !== undefined ? { playtime_2weeks: Math.max(0, Number(game.playtime_2weeks) || 0) } : {}) });
  }
  return [...unique.values()];
}
async function fetchMetadataUncached(appid, options) {
  const html = await request(`https://store.steampowered.com/app/${appid}/?l=english`, options, 'text');
  const ageRestricted = /game-agecheck-tags|agegate_birthday_selector|agecheck_form/.test(html);
  const tags = ageRestricted ? [] : parseStoreTags(html);
  const name = clean(html.match(/<div\b[^>]*class=["'][^"']*apphub_AppName[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || `App ${appid}`).replace(/ on Steam$/, '');
  const genres = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["'][^"']*\/genre\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const genre = clean(match[1]); if (genre && !genres.includes(genre)) genres.push(genre);
  }
  if (tags.length) return { appid, name, tags, genres, source: 'steam_store_tags', fetchedAt: new Date().toISOString() };
  const payload = await request(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`, options);
  const item = payload[String(appid)];
  if (item?.success && item.data) {
    const fallbackGenres = [...new Set((item.data.genres || []).map(genre => genre.description).filter(Boolean))];
    return { appid, name: item.data.name || name, tags: [], genres: fallbackGenres, source: fallbackGenres.length ? 'steam_appdetails_genres' : 'unavailable', fetchedAt: new Date().toISOString() };
  }
  return { appid, name, tags: [], genres: [], source: 'unavailable', fetchedAt: new Date().toISOString() };
}
export async function fetchGameMetadata(appid, options = {}) {
  appid = Number(appid);
  if (!Number.isSafeInteger(appid) || appid <= 0) throw new SteamError('invalid_app_id', '游戏 ID 格式不正确。');
  const directory = options.cacheDir === false ? null : options.cacheDir || defaultCache();
  const key = `metadata-en-v1-${appid}`;
  const cached = await readCache(directory, key, 24 * 60 * 60 * 1000);
  if (cached && cached.appid === appid && Array.isArray(cached.tags) && Array.isArray(cached.genres) && !(cached.source === 'steam_store_tags' && cached.tags.length < 3)) return cached;
  const task = metadataQueue.catch(() => {}).then(async () => {
    const wait = Math.max(0, 350 - (Date.now() - lastMetadataRequest));
    if (wait) await sleep(wait);
    lastMetadataRequest = Date.now();
    const result = await fetchMetadataUncached(appid, options);
    try { await writeCache(directory, key, result); } catch { /* A cache failure must not prevent a portrait. */ }
    return result;
  });
  metadataQueue = task;
  return task;
}
export async function enrichGames(games, options = {}, onProgress) {
  const limit = Math.max(1, Math.min(2000, Number(options.maxGames) || 300));
  const selected = [...games].sort((a, b) => b.playtime_forever - a.playtime_forever || a.appid - b.appid).slice(0, limit);
  const enriched = [], warnings = [];
  let halted = false;
  for (const game of selected) {
    let metadata;
    if (!halted) {
      try { metadata = await fetchGameMetadata(game.appid, options); }
      catch (error) {
        warnings.push({ appid: game.appid, code: error.code || 'metadata_error', message: error.message });
        if (error.code === 'rate_limit') halted = true;
      }
    }
    enriched.push({ ...game, ...(metadata || { tags: [], genres: [], source: 'unavailable', fetchedAt: new Date().toISOString() }), name: game.name || metadata?.name });
    if (onProgress) onProgress({ processed: enriched.length, total: selected.length, appid: game.appid });
  }
  if (games.length > selected.length) warnings.push({ code: 'truncated', message: `当前只处理游玩时长最高的 ${selected.length} 款，共 ${games.length} 款。` });
  if (halted) warnings.push({ code: 'rate_limit', message: 'Steam 限流后停止元数据请求，其余游戏保留但无标签。' });
  const tagged = enriched.filter(game => game.tags.length).length;
  const totalMinutes = games.reduce((sum, game) => sum + game.playtime_forever, 0);
  const coveredMinutes = enriched.filter(game => game.tags.length).reduce((sum, game) => sum + game.playtime_forever, 0);
  return { games: enriched, warnings, totalOwned: games.length, processed: enriched.length, coverage: { taggedGames: tagged, processedGames: enriched.length, totalGames: games.length, gameRatio: games.length ? tagged / games.length : 0, playtimeRatio: totalMinutes ? coveredMinutes / totalMinutes : 0, totalMinutes, coveredMinutes } };
}
export async function obtainPlayer(input, options = {}, onProgress) {
  const steamid = await resolveSteamId(input, options);
  if (!keyOf(options)) {
    const publicProfile = await fetchPublicProfile(steamid, options);
    const result = await enrichGames(publicProfile.games, options, onProgress || options.onProgress);
    return { steamid, displayName: publicProfile.displayName, source: 'steam_public_profile_xml', dataType: 'partial_public_profile', fetchedAt: publicProfile.fetchedAt, ...result, totalOwned: null, coverage: { ...result.coverage, totalGames: null, gameRatio: null, playtimeRatio: null }, warnings: [{ code: 'partial_library', message: '当前仅读取公开主页展示的部分游戏与累计时长，不代表完整游戏库。配置服务端 Steam API key 后可查询公开游戏库。' }, ...result.warnings] };
  }
  const owned = await fetchOwnedGames(steamid, options);
  let summary = null;
  const result = await enrichGames(owned, options, onProgress || options.onProgress);
  try { summary = await playerSummary(steamid, options); } catch { result.warnings.push({ code: 'profile_unavailable', message: '未读取到玩家昵称，使用 Steam ID 显示。' }); }
  if (!owned.length) result.warnings.push({ code: 'empty_library', message: '官方接口返回的可见游戏列表为空，无法据此判断兴趣。' });
  if (owned.length && owned.every(game => game.playtime_forever === 0)) result.warnings.push({ code: 'no_playtime', message: '未获得有效游玩时长；可能尚未游玩，或单独隐藏了游玩时长。' });
  return { steamid, displayName: summary?.personaname || steamid, source: 'steam_web_api', ...result };
}


const xmlValue = (xml, tag) => {
  const value = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '';
  return decodeHtml(value.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim();
};
export function parsePublicProfileXml(xml, expectedSteamid) {
  if (/<html\b/i.test(xml) || !/<profile\b/.test(xml)) throw new SteamError('not_visible', '公开主页未返回可解析的用户信息。', 403);
  const privacy = xmlValue(xml, 'privacyState');
  if (privacy === 'private' || privacy === 'friendsonly') throw new SteamError('private', '该用户主页不公开，无法读取游戏信息。', 403);
  const steamid = xmlValue(xml, 'steamID64');
  if (steamid !== expectedSteamid) throw new SteamError('user_not_found', 'Steam 主页没有返回对应的用户。', 404);
  if (privacy !== 'public') throw new SteamError('not_visible', '无法确认主页游戏信息公开。', 403);
  const games = new Map();
  for (const match of xml.matchAll(/<(mostPlayedGame|recentGame)>([\s\S]*?)<\/\1>/gi)) {
    const body = match[2];
    const appid = Number(xmlValue(body, 'gameLink').match(/^https?:\/\/steamcommunity\.com\/app\/(\d+)\/?$/)?.[1]);
    const hoursText = xmlValue(body, 'hoursOnRecord').replace(/,/g, '');
    const hours = Number(hoursText);
    if (!Number.isSafeInteger(appid) || appid <= 0 || !hoursText || !Number.isFinite(hours) || hours < 0) continue;
    const game = { appid, name: xmlValue(body, 'gameName') || `App ${appid}`, playtime_forever: Math.round(hours * 60), dataType: 'public_profile_subset' };
    const previous = games.get(appid);
    if (!previous || previous.playtime_forever < game.playtime_forever) games.set(appid, game);
  }
  return { steamid, displayName: xmlValue(xml, 'steamID') || steamid, games: [...games.values()], privacy, fetchedAt: new Date().toISOString() };
}
export async function fetchPublicProfile(steamid, options = {}) {
  steamid = validateSteamId(steamid);
  const xml = await request(`https://steamcommunity.com/profiles/${steamid}/?xml=1&l=schinese`, options, 'text');
  const result = parsePublicProfileXml(xml, steamid);
  if (!result.games.length) throw new SteamError('missing_api_key', '公开主页没有展示可用的游戏与时长。请配置服务端 Steam API key，以查询公开游戏库。', 503);
  return result;
}

