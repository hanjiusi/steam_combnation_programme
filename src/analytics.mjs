const DICTIONARY = {
  'Logic':['逻辑','mechanic'], 'Programming':['编程','mechanic'], 'Sandbox':['沙盒','mechanic'], 'Steampunk':['蒸汽朋克','theme'], 'Perma Death':['永久死亡','mechanic'], 'Experimental':['实验性','other'], 'Dark Humor':['黑色幽默','theme'], 'Hex Grid':['六角网格','mechanic'], 'Minimalist':['极简','visual'], 'Gun Customization':['枪械定制','mechanic'], 'Abstract':['抽象','visual'], 'Incremental':['增量成长','mechanic'], 'Idler':['放置','mechanic'], 'Mining':['采矿','mechanic'], 'Physics':['物理机制','mechanic'], 'Colony Sim':['殖民模拟','genre'], 'Base Building':['基地建造','mechanic'], 'City Builder':['城市建造','genre'], 'Management':['经营管理','mechanic'], 'Dwarves':['矮人','theme'], 'Tower Defense':['塔防','genre'], 'Bullet Hell':['弹幕','mechanic'], 'Arcade':['街机','genre'], 'Procedural Generation':['程序生成','mechanic'], 'Dark Comedy':['黑色喜剧','theme'],
  'Action':['动作','genre'], 'Adventure':['冒险','genre'], 'RPG':['角色扮演','genre'], 'Strategy':['策略','genre'], 'Simulation':['模拟','genre'], 'Sports':['体育','genre'], 'Racing':['竞速','genre'], 'Casual':['休闲','genre'], 'Puzzle':['解谜','genre'], 'FPS':['第一人称射击','genre'], 'Platformer':['平台跳跃','genre'], 'Survival':['生存','genre'], 'Horror':['恐怖','theme'], 'Sci-fi':['科幻','theme'], 'Fantasy':['奇幻','theme'], 'Space':['太空','theme'], 'Military':['军事','theme'], 'Zombies':['丧尸','theme'], 'Cute':['可爱','theme'], 'Story Rich':['丰富剧情','theme'], 'Deckbuilding':['卡牌构筑','mechanic'], 'Card Battler':['卡牌对战','mechanic'], 'Turn-Based':['回合制','mechanic'], 'Turn-Based Strategy':['回合制策略','mechanic'], 'Roguelike':['Roguelike','mechanic'], 'Roguelite':['Roguelite','mechanic'], 'Action Roguelike':['动作 Roguelike','mechanic'], 'Open World':['开放世界','mechanic'], 'Crafting':['制作','mechanic'], 'Building':['建造','mechanic'], 'Resource Management':['资源管理','mechanic'], 'Automation':['自动化','mechanic'], 'Difficult':['高难度','mechanic'], 'Souls-like':['类魂','mechanic'], 'Exploration':['探索','mechanic'], 'Choices Matter':['选择影响剧情','mechanic'], 'Pixel Graphics':['像素画面','visual'], '2D':['二维','visual'], '3D':['三维','visual'], 'Anime':['动漫','visual'], 'Realistic':['写实','visual'], 'Singleplayer':['单人','mode'], 'Multiplayer':['多人','mode'], 'Co-op':['合作','mode'], 'Online Co-Op':['在线合作','mode'], 'Local Co-Op':['本地合作','mode'], 'PvP':['玩家对战','mode'], 'Indie':['独立游戏','other'], 'Free to Play':['免费游玩','other'], 'Early Access':['抢先体验','other']
};
const DIMENSIONS = {genre:'游戏类型', mechanic:'玩法机制', theme:'主题与叙事', visual:'视觉风格', mode:'游玩方式', other:'其他标签'};
const finite = (x) => Number.isFinite(Number(x)) ? Math.max(0,Number(x)) : 0;
const uniqueTags = (game) => [...new Set((Array.isArray(game.tags) ? game.tags : []).filter(x=>typeof x==='string').map(x=>x.trim()).filter(Boolean))];
const uniqueGames = (games) => {
  const map=new Map();
  for(const raw of Array.isArray(games)?games:[]){
    if(!raw || raw.appid===undefined || !/^\d+$/.test(String(raw.appid))) continue;
    const id=String(raw.appid),prev=map.get(id);
    const tags=[...new Set([...(prev?.tags??[]),...uniqueTags(raw)])];
    map.set(id,{...prev,...raw,appid:Number(id),tags,playtime_forever:Math.max(finite(prev?.playtime_forever),finite(raw.playtime_forever)),playtime_2weeks:Math.max(finite(prev?.playtime_2weeks),finite(raw.playtime_2weeks))});
  }
  return [...map.values()];
};
export function tagInfo(tag) { const [label,dimension]=DICTIONARY[tag]??[tag,'other']; return {id:tag,label,dimension}; }
export function buildProfile(player={},catalog={},options={}) {
  const weightMode=options.weightMode==='time'?'time':'balanced';
  const minOverlap=Math.max(2,Math.floor(finite(options.minOverlap)||3));
  const minLift=Math.max(1,finite(options.minLift)||1.05);
  const catalogGames=uniqueGames(catalog.games).filter(g=>g.tags.length);
  const reference=catalog.reference;
  const useReference=reference && Number.isInteger(reference.catalogTaggedGames) && reference.catalogTaggedGames>0 && reference.frequencies && Array.isArray(reference.relations);
  const N=useReference?reference.catalogTaggedGames:catalogGames.length;
  const frequencies=useReference?new Map(Object.entries(reference.frequencies)):new Map(),pairs=new Map();
  if(!useReference) for(const g of catalogGames){
    for(const tag of g.tags) frequencies.set(tag,(frequencies.get(tag)||0)+1);
    const tags=[...g.tags].sort();
    for(let i=0;i<tags.length;i++) for(let j=i+1;j<tags.length;j++) {
      const key=JSON.stringify([tags[i],tags[j]]); pairs.set(key,(pairs.get(key)||0)+1);
    }
  }
  const metadata=new Map(catalogGames.map(g=>[g.appid,g]));
  const games=uniqueGames(player.games).map(g=>({...g,name:g.name||metadata.get(g.appid)?.name||`App ${g.appid}`,tags:g.tags.length?g.tags:(metadata.get(g.appid)?.tags??[]),hours:g.playtime_forever/60}));
  const aggregates=new Map();
  for(const game of games){
    if(game.hours<=0 || !game.tags.length) continue;
    const mass=weightMode==='time'?game.hours:Math.log1p(game.hours);
    // The historical reference stays fixed when live metadata is refreshed.
    const weights=game.tags.map(tag=>useReference&&!frequencies.has(tag)?1:(N?Math.log((N+1)/((frequencies.get(tag)||0)+1))+1:1));
    const totalWeight=weights.reduce((a,b)=>a+b,0);
    game.tagContributions=game.tags.map((tag,i)=>({tag,contribution:mass*weights[i]/totalWeight}));
    for(const {tag,contribution} of game.tagContributions){
      if(!aggregates.has(tag)) aggregates.set(tag,{...tagInfo(tag),rawScore:0,gameCount:0,hours:0,evidence:[]});
      const row=aggregates.get(tag);row.rawScore+=contribution;row.gameCount++;row.hours+=game.hours;
      row.evidence.push({appid:game.appid,name:game.name,hours:game.hours,contribution});
    }
  }
  const total=[...aggregates.values()].reduce((s,t)=>s+t.rawScore,0), max=Math.max(0,...[...aggregates.values()].map(t=>t.rawScore));
  const tags=[...aggregates.values()].map(t=>({...t,score:max?t.rawScore/max*100:0,share:total?t.rawScore/total:0,evidence:t.evidence.sort((a,b)=>b.contribution-a.contribution).slice(0,12)})).sort((a,b)=>b.rawScore-a.rawScore||a.id.localeCompare(b.id));
  const edges=[];
  const relationRows=useReference?reference.relations:[...pairs].map(([key,coGames])=>{const [source,target]=JSON.parse(key);return {source,target,coGames};});
  for(const relation of relationRows){
    const {source,target,coGames}=relation;
    if(coGames<minOverlap || !aggregates.has(source)||!aggregates.has(target)) continue;
    const support=coGames/N,lift=coGames*N/(frequencies.get(source)*frequencies.get(target));
    if(lift<minLift) continue;
    edges.push({source,target,coGames,support,lift,strength:Math.min(1,(1-1/lift)*Math.min(1,coGames/10))});
  }
  edges.sort((a,b)=>b.strength-a.strength||b.coGames-a.coGames);
  const dimensions=Object.entries(DIMENSIONS).map(([id,label])=>({id,label,score:tags.filter(t=>t.dimension===id).reduce((sum,t)=>sum+t.share,0)*100}));
  const played=games.filter(g=>g.hours>0),tagged=played.filter(g=>g.tags.length);
  const warnings=[...new Set((Array.isArray(player.warnings)?player.warnings:[]).map(w=>typeof w==='string'?w:(w?.message||w?.code||String(w))))];
  const analyzedHours=played.reduce((s,g)=>s+g.hours,0);
  const libraryHours=player.coverage && player.coverage.totalMinutes!=null && Number.isFinite(Number(player.coverage.totalMinutes))?finite(player.coverage.totalMinutes)/60:analyzedHours;
  const denominatorUnknown=player.totalOwned===null || player.coverage?.isPartial===true && player.coverage?.totalGames==null;
  const ownedGames=denominatorUnknown?null:Math.max(games.length,finite(player.totalOwned),finite(player.coverage?.totalGames));
  const isPartial=denominatorUnknown || player.coverage?.isPartial===true || (ownedGames!=null && games.length<ownedGames);
  const taggedOwnedGames=games.filter(g=>g.tags.length).length;
  if(denominatorUnknown) warnings.push('仅获得公开展示的部分游戏；完整游戏库规模与覆盖率未知，画像只代表已取得的游戏证据。');
  if(!N) warnings.push('标签关联参考样本为空；画像仍可由直接游戏标签生成，未计算标签关联。');
  if(played.length>tagged.length) warnings.push(`${played.length-tagged.length} 款已游玩游戏缺少标签；这些偏好证据尚未纳入。`);
  if(!played.length) warnings.push('未获得有游玩时长的游戏记录；无法据此判断偏好。');
  if(tags.length && tagged.length<3) warnings.push('画像证据较少，请结合具体游戏核对；低分或未出现的标签不代表不喜欢。');
  const population=useReference && reference.population ? {...reference.population,tagStats:(reference.population.tagStats||[]).filter(t=>aggregates.has(t.tag)),source:reference.provenance,weightMode:reference.population.weightMode||'balanced'}:null;
  return {schemaVersion:1,population,player:{steamid:String(player.steamid??''),displayName:player.displayName||'Steam 玩家',source:player.source||'unknown'},summary:{ownedGames,playedGames:played.length,analyzedGames:games.length,taggedGames:tagged.length,taggedOwnedGames,totalHours:libraryHours,analyzedHours,coverage:denominatorUnknown?null:(ownedGames?taggedOwnedGames/ownedGames:0),playtimeCoverage:denominatorUnknown?null:(libraryHours?tagged.reduce((s,g)=>s+g.hours,0)/libraryHours:0),taggedSubsetCoverage:games.length?taggedOwnedGames/games.length:0,isPartial,scope:denominatorUnknown?'public_showcase':'library',preferenceEvidenceCoverage:played.length?tagged.length/played.length:0},tags,edges,dimensions,games,warnings,method:{version:'1.1.0',referenceUnknownTagWeight:useReference?'idf=1 when tag is absent from historical catalog; retain direct evidence':null,referenceScope:useReference?'UCSD historical Steam corpus':'local sampled game catalog',referenceProvenance:useReference?reference.provenance:null,weightMode,behaviorWeight:weightMode==='time'?'playtime_forever / 60':'log1p(playtime_forever / 60)',coverageMeaning:'coverage 为有标签游戏占完整游戏库比例；playtimeCoverage 为有标签游戏时长占完整游戏库时长比例。playedGames 仅指已取得详情的已游玩游戏。',tagWeight:'sampleCatalogIdf = 1 + ln((catalogTaggedGames + 1) / (tagDocumentFrequency + 1)); normalize within each game',scoreMeaning:'相对偏好强度：最高标签为 100；不是喜欢概率。share 为直接贡献占比。',unknownMeaning:'缺失或零时长为未知，不判定为不喜欢。',association:'样本游戏标签共现，正关联过滤；不代表同义关系，不传播用户偏好。',catalogSource:catalog.source||'unspecified',catalogFetchedAt:catalog.fetchedAt||null,catalogGames:N,minOverlap,minLift,reviewSentimentUsed:false,evidenceLimit:12}};
}


