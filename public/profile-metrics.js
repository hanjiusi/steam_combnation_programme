const knownNumber = value => value != null && Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null;
const format = (value, digits = 0) => value == null ? '未知' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
const ratio = value => { const n = knownNumber(value); return n == null ? '未知' : `${format(Math.min(1, n > 1 ? n / 100 : n) * 100, 1)}%`; };
export function profileMetrics(profile) {
  const summary = profile.summary ?? {};
  const games = Array.isArray(profile.games) ? profile.games : [];
  const showcase = summary.scope === 'public_showcase' || profile.player?.source === 'steam_public_profile_xml';
  const partial = showcase || summary.isPartial === true;
  const analyzed = knownNumber(summary.analyzedGames) ?? games.length;
  const tagged = knownNumber(summary.taggedOwnedGames) ?? knownNumber(summary.taggedGames) ?? games.filter(g => g.tags?.length).length;
  const gameHours = game => knownNumber(game.hours) ?? (knownNumber(game.playtime_forever) ?? 0) / 60;
  const owned = Object.hasOwn(summary, 'ownedGames') ? knownNumber(summary.ownedGames) : showcase ? null : games.length;
  return {
    partial, showcase, analyzed, tagged,
    owned: format(owned),
    played: format(knownNumber(summary.playedGames) ?? games.filter(g => gameHours(g) > 0).length),
    hours: format(knownNumber(summary.totalHours) ?? games.reduce((sum, g) => sum + gameHours(g), 0), 1),
    coverage: ratio(summary.coverage),
    subsetCoverage: ratio(summary.taggedSubsetCoverage ?? (analyzed ? tagged / analyzed : 0)),
    playtimeCoverage: ratio(summary.playtimeCoverage),
    playedLabel: partial ? '已取得的已玩游戏' : '玩过的游戏',
    hoursLabel: showcase ? '已展示游戏累计游玩' : '累计游玩',
    ownedDetail: showcase ? '完整游戏库规模未知' : '拥有的游戏',
    coverageDetail: `已取得 ${format(tagged)} / ${format(analyzed)} 款有标签`,
    scopeTitle: showcase ? '部分游戏画像，完整游戏库未知' : '部分游戏画像，仅基于已取得的记录',
    scopeMessage: showcase ? '来自 Steam 公开主页展示的游戏和时长，只能描述这部分游戏的偏好。完整游戏库数量、标签覆盖率和时长覆盖率均未知。' : '部分游戏未取得详情或标签；请结合已取得的游戏证据理解这张画像。'
  };
}