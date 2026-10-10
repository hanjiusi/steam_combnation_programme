import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
let cached;
const parse = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
export async function readBackground(root) {
  const dir = path.join(root, 'data', 'public-steam');
  try {
    const paths = ['catalog.json','baseline.json'].map(name=>path.join(dir,name));
    const stamps = await Promise.all(paths.map(file=>stat(file)));
    const key = paths.join('|')+stamps.map(s=>s.mtimeMs+':'+s.size).join('|');
    if(cached?.key===key) return cached.value;
    const [catalog,reference] = await Promise.all(paths.map(parse));
    if(!Array.isArray(catalog.games)||!Number.isInteger(reference.catalogTaggedGames)||reference.catalogTaggedGames<1||!reference.frequencies||!Array.isArray(reference.relations)) throw new Error('invalid background');
    const value={catalog,reference};
    cached={key,value};return value;
  } catch(error) {
    if(error.code==='ENOENT') return null;
    throw error;
  }
}
export function mergeBackground(local, background) {
  if(!background) return local;
  const games = new Map(background.catalog.games.map(game=>[Number(game.appid),game]));
  for(const game of local.games||[]) {
    const previous=games.get(Number(game.appid));
    games.set(Number(game.appid),{...previous,...game,tags:game.tags?.length?game.tags:(previous?.tags||[])});
  }
  return {...local,games:[...games.values()],source:background.catalog.source+' + local Steam metadata',reference:background.reference};
}
