/* 推荐实验室: 前端逻辑(零依赖, 数据来自 /api/reco/*) */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 3) => Number(v).toFixed(d);
const signed = (v, d = 4) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
const STEAM = (appid) => `https://store.steampowered.com/app/${appid}/`;

const state = { user: null, modeKey: 'hybrid', yAxis: 'als', pointIdx: 0 };
let meta, users, tagNames, itemMap, current;
const recoCache = new Map();

boot();

async function boot() {
  const status = $('#reco-status');
  try {
    const [m, u, it] = await Promise.all([
      fetchJson('/api/reco/meta.json'), fetchJson('/api/reco/users.json'), fetchJson('/api/reco/items.json'),
    ]);
    meta = m; users = u; tagNames = it.tags;
    itemMap = new Map(it.items.map((row) => [row[0], row]));
    const sorted = [...users].sort((a, b) => (a.case ? 0 : 1) - (b.case ? 0 : 1) || a.user - b.user);
    $('#user-select').innerHTML = sorted.map((x) =>
      `<option value="${x.user}">${x.case ? `案例 ${x.case} · ` : ''}用户 ${x.user}（${esc(x.top_tags.slice(0, 3).map((t) => t[0]).join(' · '))}）</option>`).join('');
    const def = users.find((x) => x.case === 'B') || users[0];
    $('#user-select').value = String(def.user);
    state.user = def.user;
    renderTabs(); renderKneePanel(); renderMethod(); bindControls();
    await loadUser(def.user);
    status.textContent = `${meta.n_users} 用户 · ${meta.n_items} 游戏 · 5 种相似度模式`;
  } catch (error) {
    status.textContent = '实验数据不可用';
    showError(error);
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error?.message || detail; } catch { /* 非 JSON 错误体 */ }
    throw new Error(detail);
  }
  return res.json();
}

async function loadUser(uid) {
  if (!recoCache.has(uid)) recoCache.set(uid, fetchJson(`/api/reco/user/${uid}.json`));
  current = await recoCache.get(uid);
  state.pointIdx = current.modes[state.modeKey].knee;
  renderUser(); renderPareto(); renderCards(); renderMetrics();
}

function renderTabs() {
  $('#mode-tabs').innerHTML = meta.modes.map((m) =>
    `<button type="button" class="filter-tab" role="tab" data-key="${m.key}" aria-selected="false">${esc(m.label)}</button>`).join('');
  [...document.querySelectorAll('#mode-tabs [data-key]')].forEach((btn) => {
    btn.addEventListener('click', () => {
      state.modeKey = btn.dataset.key;
      state.pointIdx = current.modes[state.modeKey].knee;
      syncTabs(); renderPareto(); renderCards(); renderMetrics(); renderKneePanel();
    });
  });
  syncTabs();
}

function syncTabs() {
  [...document.querySelectorAll('#mode-tabs [data-key]')].forEach((btn) => {
    const on = btn.dataset.key === state.modeKey;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  });
}

function renderUser() {
  const u = users.find((x) => x.user === state.user);
  $('#user-title').textContent = `用户 ${u.user}`;
  $('#user-meta').textContent = `SteamID ${u.steamid}`;
  $('#top-tags').innerHTML = u.top_tags.map((t) =>
    `<span class="chip"><b>${esc(t[0])}</b><span class="chip-muted"> ${t[1].toFixed(3)} · IDF ${t[2].toFixed(1)}</span></span>`).join('');
  const banner = $('#case-banner');
  if (u.case) {
    const texts = {
      A: '标签融合把“清一色”列表打散：该用户膝点的多样性提升在 40 人中最大。',
      B: '最近一次正反馈（留一测试物品）仍被膝点列表推荐命中，可在卡片上查看命中徽标。',
      C: '接近全体 40 人统计中位的典型用户，用于对照观察。',
    };
    banner.hidden = false;
    $('#case-title').textContent = `案例 ${u.case} · ${u.case_label}`;
    $('#case-message').textContent = texts[u.case] || '';
  } else {
    banner.hidden = true;
  }
}

/* ---------- 帕累托前沿 ---------- */
const PAD = ([a, b]) => { const s = (b - a) || 0.05; return [a - s * 0.08, b + s * 0.14]; };
function ticks(a, b, count) {
  const step0 = (b - a) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function renderPareto() {
  const mode = current.modes[state.modeKey];
  const pts = mode.points;
  const W = 900, H = 430, L = 66, R = 26, T = 20, B = 52;
  const yi = state.yAxis === 'als' ? 1 : 2;
  const [x0, x1] = PAD([Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))]);
  const [y0, y1] = PAD([Math.min(...pts.map((p) => p[yi])), Math.max(...pts.map((p) => p[yi]))]);
  const sx = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const sy = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const xt = ticks(x0, x1, 5), yt = ticks(y0, y1, 4);

  let g = '';
  for (const v of xt) g += `<line class="grid-line" x1="${sx(v).toFixed(1)}" y1="${T}" x2="${sx(v).toFixed(1)}" y2="${H - B}"></line>`;
  for (const v of yt) g += `<line class="grid-line" x1="${L}" y1="${sy(v).toFixed(1)}" x2="${W - R}" y2="${sy(v).toFixed(1)}"></line>`;
  g += `<line class="axis-line" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"></line>`;
  g += `<line class="axis-line" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"></line>`;
  for (const v of xt) g += `<text x="${sx(v).toFixed(1)}" y="${H - B + 18}" text-anchor="middle">${v.toFixed(3)}</text>`;
  for (const v of yt) g += `<text x="${L - 8}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${v.toFixed(3)}</text>`;
  g += `<text class="axis-title" x="${(L + W - R) / 2}" y="${H - 10}" text-anchor="middle">RelDCG@10 · 猜得准 →</text>`;
  const cy = (T + H - B) / 2;
  g += `<text class="axis-title" x="16" y="${cy}" text-anchor="middle" transform="rotate(-90 16 ${cy})">${state.yAxis === 'als' ? 'ALS-ILD@10' : 'TAG-ILD@10'} · 看得宽 →</text>`;

  const base = meta.als_top10;
  const bx = base.rdcg, by = state.yAxis === 'als' ? base.als_ild : base.tag_ild;
  g += `<line class="base-line ${state.yAxis}" x1="${sx(bx).toFixed(1)}" y1="${T}" x2="${sx(bx).toFixed(1)}" y2="${H - B}"></line>`;
  g += `<line class="base-line ${state.yAxis}" x1="${L}" y1="${sy(by).toFixed(1)}" x2="${W - R}" y2="${sy(by).toFixed(1)}"></line>`;
  g += `<text class="base-label ${state.yAxis}" x="${(sx(bx) + 6).toFixed(1)}" y="${T + 14}">基线 RelDCG</text>`;
  g += `<text class="base-label ${state.yAxis}" x="${W - R - 9}" y="${(sy(by) - 7).toFixed(1)}" text-anchor="end">基线 ${state.yAxis === 'als' ? 'ALS-ILD' : 'TAG-ILD'}</text>`;

  const sorted = [...pts].sort((a, b) => a[0] - b[0]);
  g += `<polyline class="frontier-line" points="${sorted.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[yi]).toFixed(1)}`).join(' ')}"></polyline>`;

  pts.forEach((p, i) => {
    const cls = ['pareto-point'];
    if (i === mode.knee) cls.push('knee');
    if (i === state.pointIdx) cls.push('selected');
    const tip = `#${i} · RelDCG ${fmt(p[0])} · ALS-ILD ${fmt(p[1])} · TAG-ILD ${fmt(p[2])} · hitNDCG ${fmt(p[3])}`;
    g += `<g class="${cls.join(' ')}" data-idx="${i}" tabindex="0" role="button" aria-label="${tip}">`
      + `<circle cx="${sx(p[0]).toFixed(1)}" cy="${sy(p[yi]).toFixed(1)}" r="${i === state.pointIdx ? 7 : i === mode.knee ? 6.5 : 5}"></circle>`
      + `<title>${tip}</title></g>`;
  });
  const kp = pts[mode.knee];
  if (kp) g += `<text class="point-tag" x="${(sx(kp[0]) + 9).toFixed(1)}" y="${(sy(kp[yi]) - 9).toFixed(1)}">膝点</text>`;

  const svg = $('#pareto-svg');
  svg.innerHTML = g;
  [...svg.querySelectorAll('.pareto-point')].forEach((el) => {
    const pick = () => { state.pointIdx = Number(el.dataset.idx); renderPareto(); renderCards(); renderMetrics(); };
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });

  $('#pareto-caption').textContent = `${mode.label} · ${pts.length} 条候选列表（ALS top-300 候选池 · NSGA-II 60 代）`;
  $('#pareto-count').textContent = `共 ${pts.length} 条 · 当前 #${state.pointIdx}${state.pointIdx === mode.knee ? '（膝点）' : ''}`;
  $('#pareto-footnote').textContent = state.yAxis === 'als'
    ? '纵轴 ALS-ILD：列表内 128 维隐向量两两余弦距离；虚线为全库 ALS 基线。点击任意点查看该列表。'
    : '纵轴 TAG-ILD：列表内标签 IDF 向量两两余弦距离；虚线为全库 ALS 基线。点击任意点查看该列表。';
  document.querySelectorAll('.yaxis').forEach((b) => {
    const on = b.dataset.axis === state.yAxis;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/* ---------- 推荐卡片 ---------- */
function renderCards() {
  const mode = current.modes[state.modeKey];
  const list = mode.lists[state.pointIdx];
  const testId = current.test.item;
  const u = users.find((x) => x.user === state.user);
  const topSet = new Set(u.top_tags.map((t) => t[0]));
  $('#cards-caption').textContent = `${mode.label} · 列表 #${state.pointIdx}${state.pointIdx === mode.knee ? '（膝点）' : ''} · 卡片可点击进入 Steam 商店（需联网）`;
  $('#reco-cards').innerHTML = list.map((itemId, rank) => {
    const [, appid, name, tagIdx] = itemMap.get(itemId);
    const names = tagIdx.map((t) => tagNames[t]);
    const hitTags = names.filter((n) => topSet.has(n));
    const rest = names.filter((n) => !topSet.has(n));
    const shown = [...hitTags, ...rest].slice(0, 8);
    const chips = shown.map((n) => `<span class="chip ${topSet.has(n) ? 'chip-hit' : ''}">${esc(n)}</span>`).join('')
      + (names.length > shown.length ? `<span class="chip chip-muted">+${names.length - shown.length}</span>` : '');
    const isHit = itemId === testId;
    return `<article class="reco-card ${isHit ? 'hit' : ''}">
      <div class="card-head"><span class="rank">#${rank + 1}</span><span class="card-name"><a href="${STEAM(appid)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a></span></div>
      <div class="card-sub"><code>app ${appid}</code><span>画像标签重合 ${hitTags.length}/${names.length}</span>${isHit ? `<span class="badge-hit">✓ 命中留一测试（第 ${rank + 1} 位）</span>` : ''}</div>
      <div class="chips">${chips}</div>
    </article>`;
  }).join('');

  const base = current.als_top10;
  $('#baseline-metrics').innerHTML = `RelDCG <b>${fmt(base.metrics[0])}</b> · ALS-ILD <b>${fmt(base.metrics[1])}</b> · TAG-ILD <b>${fmt(base.metrics[2])}</b> · hitNDCG <b>${fmt(base.metrics[3])}</b>`;
  $('#baseline-list').innerHTML = base.list.map((itemId) => {
    const [, appid, name] = itemMap.get(itemId);
    return `<a href="${STEAM(appid)}" target="_blank" rel="noopener noreferrer" class="${itemId === testId ? 'hit' : ''}">${esc(name)}</a>`;
  }).join('');
}

function renderMetrics() {
  const mode = current.modes[state.modeKey];
  const p = mode.points[state.pointIdx];
  const base = current.als_top10.metrics;
  const d = (v, i) => {
    const x = v - base[i];
    return `<span class="${x >= 0 ? 'delta-up' : 'delta-down'}">(${signed(x, 3)})</span>`;
  };
  $('#point-metrics').innerHTML = `
    <span>RelDCG@10</span><span><b>${fmt(p[0])}</b>${d(p[0], 0)}</span>
    <span>ALS-ILD</span><span><b>${fmt(p[1])}</b>${d(p[1], 1)}</span>
    <span>TAG-ILD</span><span><b>${fmt(p[2])}</b>${d(p[2], 2)}</span>
    <span>hitNDCG</span><span><b>${fmt(p[3])}</b>${d(p[3], 3)}</span>`;
  const pos = mode.lists[state.pointIdx].indexOf(current.test.item);
  $('#test-truth').innerHTML = `<b>${esc(current.test.name)}</b>（app ${current.test.app_id}）<br>`
    + (pos >= 0
      ? `<span class="truth-hit">✓ 当前列表命中 · 第 ${pos + 1} 位</span>`
      : `<span class="truth-miss">当前列表未命中（可切换模式或点击前沿上其他列表点）</span>`);
}

/* ---------- 膝点对比 ---------- */
function renderKneePanel() {
  const base = meta.als_top10;
  const lo = 0.72, hi = 1.04;
  const w = (v) => Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 100;
  const row = (m) => {
    const cur = m.key === state.modeKey;
    const { rdcg, als_ild, tag_ild, hit_ndcg } = m.knee;
    return `<div class="knee-row${cur ? ' current' : ''}">
      <span class="knee-label">${esc(m.label)}${cur ? ' · 当前' : ''}<small>RelDCG ${rdcg.toFixed(3)} · 前沿 ${m.frontier_total} 点</small></span>
      <span class="bar-cell"><span class="bar-track"><span class="bar-fill als" style="width:${w(als_ild).toFixed(1)}%"></span><i class="bar-ref" style="left:${w(base.als_ild).toFixed(1)}%"></i></span><span class="bar-val">${als_ild.toFixed(4)}</span></span>
      <span class="bar-cell"><span class="bar-track"><span class="bar-fill tag" style="width:${w(tag_ild).toFixed(1)}%"></span><i class="bar-ref" style="left:${w(base.tag_ild).toFixed(1)}%"></i></span><span class="bar-val">${tag_ild.toFixed(4)}</span></span>
      <span class="bar-val">${hit_ndcg.toFixed(3)}</span>
    </div>`;
  };
  $('#knee-bars').innerHTML = `<div class="knee-head"><span>模式</span><span>膝点 ALS-ILD</span><span>膝点 TAG-ILD</span><span>hitNDCG</span></div>`
    + meta.modes.map(row).join('');
  const cur = meta.modes.find((m) => m.key === state.modeKey);
  const rho = cur.rho && cur.rho['rho0.90'];
  $('#knee-note').innerHTML = '竖线 = ALS 基线（全库直接 Top-10）的对应数值，便于直接读差距。'
    + (rho ? `<br>当前模式 · 等准确度 ρ=0.90（每用户门槛 = 自己 ALS 基线 RelDCG 的 90%）：TAG-ILD <b>${signed(rho.gain_tag_ild)}</b>、ALS-ILD <b>${signed(rho.gain_als_ild)}</b>（覆盖 ${rho.n_users}/40 用户）。` : '')
    + '<br>报告结论：<b>w=0.5（平台区 0.5–0.75）</b>在几乎不损失「猜得准」的前提下显著提升标签多样性；纯标签 w=1 开始明显牺牲 ALS-ILD。';
}

/* ---------- 口径与方法 ---------- */
function renderMethod() {
  const prov = Object.entries(meta.provenance).map(([f, h]) => `<code>${esc(f)}</code> ${h}`).join('<br>');
  $('#method-details').innerHTML = `
    <p>${esc(meta.protocol)}</p>
    <dl>
      <dt>数据规模</dt><dd>训练交互 112,707 用户 × 6,489 款游戏；演示用户 ${meta.n_users} 人；标签词表 ${meta.n_tags} 个（含 IDF 权重）。</dd>
      <dt>ALS 因子</dt><dd>隐向量维度 128；相关度 = 用户向量 · 物品向量，逐用户 min-max 归一化后为 rel。</dd>
      <dt>RelDCG@10</dt><dd>mean(rel[列表] / log2(名次+1))，名次从 1 起。</dd>
      <dt>ALS-ILD@10</dt><dd>1 − 2·Σ<sub>i&lt;j</sub> cos(v<sub>i</sub>, v<sub>j</sub>) / (10×9)，v 为 L2 归一化隐向量。</dd>
      <dt>TAG-ILD@10</dt><dd>同一公式，向量换为标签 IDF 向量（Steam Taste Atlas 画像口径）。</dd>
      <dt>hitNDCG</dt><dd>留一测试物品在列表第 p 位记 1/log2(p+2)，未命中记 0。</dd>
      <dt>相似度混合</dt><dd>sim = (1−w)·cos(ALS) + w·cos(标签 IDF)；NSGA-II 第二目标 = (1−w)·ALS-ILD + w·TAG-ILD。</dd>
      <dt>膝点</dt><dd>该用户前沿上 RelDCG × 混合 ILD 最大的点（与实验脚本 sweep_sim_w.py 同口径，本页全部指标已逐位复算校验）。</dd>
      <dt>ALS 基线</dt><dd>不设候选池、全库直接取 Top-10；NSGA 列表均取自 ALS 召回 Top-300 候选池。</dd>
    </dl>
    <p>数据来源与校验（SHA-256 前 16 位，来源目录 ${esc(meta.bds_dir)}）：</p>
    <div class="prov">${prov}</div>`;
}

function bindControls() {
  $('#user-select').addEventListener('change', async (e) => {
    state.user = Number(e.target.value);
    try { await loadUser(state.user); } catch (error) { showError(error); }
  });
  document.querySelectorAll('.yaxis').forEach((b) => b.addEventListener('click', () => {
    state.yAxis = b.dataset.axis;
    renderPareto();
  }));
  $('#knee-btn').addEventListener('click', () => {
    state.pointIdx = current.modes[state.modeKey].knee;
    renderPareto(); renderCards(); renderMetrics();
  });
}

function showError(error) {
  $('#error-panel').hidden = false;
  $('#error-message').textContent = `${error.message || error}\n若是首次运行，请先执行 tools/build_reco_data.py 生成 web-data 数据，再刷新本页。`;
}