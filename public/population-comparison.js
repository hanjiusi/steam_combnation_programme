export function populationComparison(profile, limit=12) {
  const population=profile.population;
  if(!population?.tagStats?.length) return {available:false,reason:'no_baseline'};
  if((profile.method?.weightMode||'balanced')!==(population.weightMode||'balanced')) return {available:false,reason:'mode_mismatch'};
  const baseline=new Map(population.tagStats.map(row=>[row.tag,row]));
  const rows=profile.tags.filter(tag=>baseline.has(tag.id)).slice(0,limit).map(tag=>({
    tag:tag.id,label:tag.label,current:tag.share*100,historical:Number(baseline.get(tag.id).meanShareAllUsers)*100
  }));
  const max=Math.max(0,...rows.flatMap(row=>[row.current,row.historical]));
  return {available:true,users:population.users,profiledUsers:population.profiledUsers,rows:rows.map(row=>({...row,currentWidth:max?100*row.current/max:0,historicalWidth:max?100*row.historical/max:0}))};
}
