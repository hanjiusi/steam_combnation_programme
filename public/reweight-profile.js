// Reuse per-game tag weights from the acquired profile so switching modes
// keeps exactly the same catalog, game records, and co-occurrence relations.
export function reweightProfile(profile, weightMode) {
  if (!['balanced','time'].includes(weightMode)) throw new Error('不支持的计算方式。');
  if (profile.method?.weightMode === weightMode) return profile;
  const info = new Map(profile.tags.map(t => [String(t.id), t]));
  const aggregates = new Map();
  const games = profile.games.map(game => {
    const hours = Number(game.hours ?? Number(game.playtime_forever)/60);
    if (!(hours > 0) || !game.tags?.length) return {...game};
    const original = game.tagContributions;
    if (!Array.isArray(original) || !original.length) throw new Error('当前画像缺少逐游戏标签权重，请重新生成一次画像。');
    const total = original.reduce((s,t) => s+Number(t.contribution),0);
    if (!(total > 0)) throw new Error('当前画像的标签权重无效，请重新生成一次画像。');
    const mass = weightMode==='time' ? hours : Math.log1p(hours);
    const tagContributions = original.map(t => ({tag:t.tag,contribution:mass*Number(t.contribution)/total}));
    for (const t of tagContributions) {
      const label = info.get(String(t.tag));
      if (!label) throw new Error('当前画像缺少标签信息，请重新生成一次画像。');
      if (!aggregates.has(t.tag)) aggregates.set(t.tag,{id:label.id,label:label.label,dimension:label.dimension,rawScore:0,gameCount:0,hours:0,evidence:[]});
      const row = aggregates.get(t.tag);row.rawScore+=t.contribution;row.gameCount++;row.hours+=hours;
      row.evidence.push({appid:game.appid,name:game.name,hours,contribution:t.contribution});
    }
    return {...game,tagContributions};
  });
  const rows = [...aggregates.values()];
  const total = rows.reduce((s,t)=>s+t.rawScore,0);
  const max = Math.max(0,...rows.map(t=>t.rawScore));
  const limit = profile.method?.evidenceLimit ?? 12;
  const tags = rows.map(t=>({...t,score:max?t.rawScore/max*100:0,share:total?t.rawScore/total:0,evidence:t.evidence.sort((a,b)=>b.contribution-a.contribution).slice(0,limit)})).sort((a,b)=>b.rawScore-a.rawScore||a.id.localeCompare(b.id));
  const dimensions = (profile.dimensions??[]).map(d=>({...d,score:tags.filter(t=>t.dimension===d.id).reduce((s,t)=>s+t.share,0)*100}));
  const method = {...profile.method,weightMode,behaviorWeight:weightMode==='time'?'playtime_forever / 60':'log1p(playtime_forever / 60)',sourceComputeEngine:profile.method?.sourceComputeEngine??profile.method?.computeEngine??'Node.js reference implementation',computeEngine:'Browser local reweight',referenceVerification:'使用原始画像的逐游戏标签权重，在本机浏览器重新分配行为贡献'};
  if(method.sparkRun){method.sourceSparkRun=method.sparkRun;delete method.sparkRun;}
  return {...profile,games,tags,dimensions,method};
}
