'use strict';
// Learn Hub frontend. Vanilla JS SPA talking to the local /api.

const api = {
  async get(path) { return (await fetch(path)).json(); },
  async send(path, method, body) {
    return (await fetch(path, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })).json();
  },
};
const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
const skeletonList = (n = 5) =>
  Array.from({ length: n }, () => '<div class="item skel"><div class="sk-line w70"></div><div class="sk-line w95"></div></div>').join('');

let TOPICS = [];
let currentItem = null; // item open in reader
let firstLoading = false; // true during the initial auto-refresh
let offlineWarning = false; // last refresh couldn't reach Microsoft Learn

// ---- navigation ----
const views = {};
document.querySelectorAll('#tabs button').forEach((b) => {
  b.onclick = () => showView(b.dataset.view);
});
function showView(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== name));
  const fn = { dashboard: renderDashboard, library: renderLibrary, learn: renderLearn, settings: renderSettings, guide: renderGuide }[name];
  if (fn) fn();
}

// ---- theme ----
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light'); }
$('#themeToggle').onclick = async () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(cur); await api.send('/api/settings', 'POST', { theme: cur });
};
$('#guideBtn').onclick = () => showView('guide');

// ---- refresh all ----
$('#refreshAll').onclick = async () => {
  const btn = $('#refreshAll'); btn.classList.add('spin'); btn.textContent = '↻ Refreshing…';
  const r = await api.send('/api/refresh', 'POST');
  btn.classList.remove('spin'); btn.textContent = '↻ Refresh';
  offlineWarning = r.errors > 0;
  if (offlineWarning) toast("Couldn't reach some topics — check your connection or proxy.", 4000);
  else toast(`Refreshed — ${r.added} new item${r.added === 1 ? '' : 's'}.`);
  refreshBadge(); showView(document.querySelector('#tabs button.active').dataset.view);
};

async function refreshBadge() {
  const s = await api.get('/api/stats');
  const b = $('#newBadge'); b.textContent = s.fresh; b.hidden = !s.fresh;
}

// ---- Dashboard ----
async function renderDashboard() {
  const el = $('#dashboard'); el.innerHTML = skeletonList(4);
  const s = await api.get('/api/stats');
  const label = (id) => (TOPICS.find((t) => t.id === id) || {}).label || id;
  const [reading, unread] = await Promise.all([
    s.total ? api.get('/api/items?status=reading') : Promise.resolve([]),
    s.total ? api.get('/api/items?status=unread') : Promise.resolve([]),
  ]);
  const card = (it) => `<div class="item" data-id="${it.id}" data-url="${esc(it.url)}">
      <div class="row1"><span class="title">${esc(it.title)}</span>
        ${it.status === 'reading' ? '<span class="pill reading">reading</span>' : ''}
        ${it.sent_to_kindle_at ? '<span class="pill kindle">Kindle</span>' : ''}
        <span class="pill">${esc(label(it.topic_id))}</span></div>
      ${it.description ? `<div class="desc">${esc(it.description)}</div>` : ''}</div>`;
  const continueList = reading.slice(0, 5).map(card).join('');
  const nextList = unread.slice(0, 8).map(card).join('');
  const stat = (num, lbl) => `<div class="stat-chip"><span class="num">${num}</span><span class="lbl">${lbl}</span></div>`;
  const bars = s.perTopic.map((t) => {
    const pct = t.total ? Math.round((t.read / t.total) * 100) : 0;
    return `<div class="card"><div style="display:flex;justify-content:space-between"><strong>${esc(t.label)}</strong><span class="muted">${t.read}/${t.total}</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }).join('');
  const emptyNext = s.total === 0
    ? (firstLoading
        ? '<div class="empty"><div class="empty-ico">⏳</div>Fetching the latest from Microsoft Learn — one moment…</div>'
        : '<div class="empty"><div class="empty-ico">📭</div>No articles yet — click <b>↻ Refresh</b> (top-right).</div>')
    : '<div class="empty"><div class="empty-ico">🎉</div>All caught up — nothing unread right now.</div>';

  el.innerHTML = `
    <div class="home-hero">
      <h2 class="view-title" style="margin:0">Home</h2>
      ${s.fresh ? `<button class="hero-new" id="heroNew">✨ ${s.fresh} new since your last visit →</button>` : ''}
    </div>
    ${offlineWarning ? '<div class="card banner-warn">⚠️ Couldn\'t reach Microsoft Learn. Check your connection or corporate proxy, then click ↻ Refresh.</div>' : ''}
    <div class="stat-strip">
      ${stat(s.reading, 'In progress')}${stat(s.readWeek, 'Read this week')}${stat(s.read, 'Read total')}${stat(s.sent, 'To Kindle')}${stat(s.total, 'Tracked')}
    </div>
    ${continueList ? `<h3 class="home-h3">Continue reading</h3><div>${continueList}</div>` : ''}
    <h3 class="home-h3">Next up <span class="muted" style="font-weight:400;font-size:13px">— latest unread</span></h3>
    <div>${nextList || emptyNext}</div>
    <h3 class="home-h3">Progress by topic</h3>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">${bars}</div>`;
  el.querySelectorAll('.item').forEach((d) => (d.onclick = () => openReader({ id: d.dataset.id, url: d.dataset.url })));
  const hn = byId('heroNew'); if (hn) hn.onclick = () => { libFilter = 'new'; showView('library'); };
}

// ---- Library ----
let libFilter = 'all';
async function renderLibrary() {
  const el = $('#library');
  const topicOpts = ['<option value="all">All topics</option>', ...TOPICS.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`)].join('');
  el.innerHTML = `
    <h2 class="view-title">Library</h2>
    <div class="seg" id="libSeg">
      <button data-f="all">All</button>
      <button data-f="unread">Unread</button>
      <button data-f="reading">Reading</button>
      <button data-f="read">Read</button>
      <button data-f="new">✨ New</button>
    </div>
    <div class="toolbar">
      <select id="fTopic">${topicOpts}</select>
      <input type="search" id="fQ" placeholder="Search title / description…" />
      <button id="markSeen" class="primary" hidden>Mark all seen</button>
    </div>
    <div id="itemList"></div>`;
  const load = async () => {
    const box = $('#itemList'); box.innerHTML = skeletonList(5);
    document.querySelectorAll('#libSeg button').forEach((b) => b.classList.toggle('active', b.dataset.f === libFilter));
    $('#markSeen').hidden = libFilter !== 'new';
    const topic = $('#fTopic').value, q = ($('#fQ').value || '').toLowerCase();
    if (libFilter === 'new') {
      const data = await api.get('/api/whatsnew');
      const items = data.items
        .filter((i) => topic === 'all' || i.topic_id === topic)
        .filter((i) => !q || (i.title + ' ' + (i.description || '')).toLowerCase().includes(q))
        .map((i) => ({ ...i, status: i.status || 'unread' }));
      renderItems(box, items, 'Nothing new since your last visit. Hit ↻ Refresh to check.');
    } else {
      const qs = new URLSearchParams({ topic, status: libFilter, q });
      renderItems(box, await api.get('/api/items?' + qs));
    }
  };
  document.querySelectorAll('#libSeg button').forEach((b) => (b.onclick = () => { libFilter = b.dataset.f; load(); }));
  $('#fTopic').onchange = load;
  $('#fQ').oninput = (() => { let t; return () => { clearTimeout(t); t = setTimeout(load, 250); }; })();
  $('#markSeen').onclick = async () => { await api.send('/api/whatsnew/seen', 'POST'); toast('Marked all as seen.'); refreshBadge(); load(); };
  load();
}

function renderItems(container, items, emptyMsg = 'No articles here yet — hit ↻ Refresh to pull the latest.') {
  if (!items.length) { container.innerHTML = `<div class="empty"><div class="empty-ico">📭</div>${esc(emptyMsg)}</div>`; return; }
  const label = (id) => (TOPICS.find((t) => t.id === id) || {}).label || id;
  container.innerHTML = items.map((it) => {
    const tags = [];
    if (it.status === 'read') tags.push('<span class="pill read">✓ read</span>');
    else if (it.status === 'reading') tags.push('<span class="pill reading">reading</span>');
    if (it.sent_to_kindle_at) tags.push('<span class="pill kindle">Kindle</span>');
    if (it.source === 'catalog') tags.push('<span class="pill">training</span>');
    return `<div class="item" data-id="${it.id}" data-url="${esc(it.url)}">
      <div class="row1"><span class="title">${esc(it.title)}</span>${tags.join('')}<span class="pill">${esc(label(it.topic_id))}</span></div>
      ${it.description ? `<div class="desc">${esc(it.description)}</div>` : ''}
    </div>`;
  }).join('');
  container.querySelectorAll('.item').forEach((d) => (d.onclick = () => openReader({ id: d.dataset.id, url: d.dataset.url })));
}

// ---- Guided (Learning Paths · Topic map · My plans) ----
const byId = (id) => document.getElementById(id);
const PRODUCT_LABELS = { 'power-apps': 'Power Apps', 'power-automate': 'Power Automate', 'power-platform': 'Power Platform', 'power-pages': 'Power Pages', 'power-bi': 'Power BI', dataverse: 'Dataverse', 'ai-builder': 'AI Builder' };
const prettyProduct = (id) => PRODUCT_LABELS[id] || id;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
let guidedTopic = 'all', guidedLevel = '';

// Open an article as part of a curated order (learning path / plan) so the
// reader's Prev/Next steps through that sequence.
function startOrder(urls, url) { sectionOrder = { tocUrl: 'curated', urls }; openTracked(url); }

function moduleRow(m, label = '') {
  const dot = m.status === 'read' ? '✓' : m.status === 'reading' ? '◐' : '○';
  const cls = m.status === 'read' ? 'tdone' : m.status === 'reading' ? 'tprog' : '';
  return `<a class="tleaf ${cls}" data-url="${esc(m.url)}"><span class="tdot">${dot}</span>${esc(m.title)}${label ? ` <span class="muted" style="font-size:12px">${label}</span>` : ''}</a>`;
}

let learnSub = 'paths';
function renderLearn() {
  const el = $('#learn');
  el.innerHTML = `
    <h2 class="view-title">Learn</h2>
    <div class="seg" id="learnSub">
      <button data-sub="paths">Learning paths</button>
      <button data-sub="sections">Sections</button>
      <button data-sub="plans">My plans</button>
    </div>
    <div id="learnPaths" class="subview"></div>
    <div id="learnSections" class="subview" hidden></div>
    <div id="learnPlans" class="subview" hidden></div>`;
  el.querySelectorAll('#learnSub button').forEach((b) => (b.onclick = () => setLearnSub(b.dataset.sub)));
  setLearnSub(learnSub);
}
function setLearnSub(sub) {
  learnSub = sub;
  document.querySelectorAll('#learnSub button').forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  byId('learnPaths').hidden = sub !== 'paths';
  byId('learnSections').hidden = sub !== 'sections';
  byId('learnPlans').hidden = sub !== 'plans';
  if (sub === 'paths') renderLearnPaths();
  else if (sub === 'sections') renderSections();
  else renderLearnPlans();
}
function renderLearnPaths() {
  const el = $('#learnPaths');
  const topicOpts = ['<option value="all">All topics</option>', ...TOPICS.filter((t) => t.products).map((t) => `<option value="${t.id}">${esc(t.label)}</option>`)].join('');
  el.innerHTML = `
    <div class="toolbar">
      <select id="gTopic">${topicOpts}</select>
      <select id="gLevel">
        <option value="">All levels</option><option value="beginner">Beginner</option>
        <option value="intermediate">Intermediate</option><option value="advanced">Advanced</option>
      </select>
    </div>
    <div id="gMap" class="card" style="margin-bottom:16px"></div>
    <div id="gPaths" class="muted"></div>`;
  $('#gTopic').value = guidedTopic; $('#gLevel').value = guidedLevel;
  $('#gTopic').onchange = () => { guidedTopic = $('#gTopic').value; loadMap(); loadPaths(); };
  $('#gLevel').onchange = () => { guidedLevel = $('#gLevel').value; loadPaths(); };
  loadMap(); loadPaths();
}
function renderLearnPlans() {
  const el = $('#learnPlans');
  el.innerHTML = `
    <div class="toolbar"><input id="planName" placeholder="New plan name (e.g. Copilot Studio basics)" style="flex:1;min-width:220px" /><button id="planAdd" class="primary">Create plan</button></div>
    <p class="muted" style="font-size:13px;margin:0 2px 10px">Build an ordered checklist. Add articles from the reader (⋯ → Add to plan), then step through with Prev/Next.</p>
    <div id="gPlans"></div>`;
  $('#planAdd').onclick = async () => { await api.send('/api/plans', 'POST', { title: $('#planName').value.trim() || 'My plan' }); $('#planName').value = ''; loadPlans(); };
  loadPlans();
}

async function loadMap() {
  const box = $('#gMap');
  const m = await api.get('/api/map?topic=' + encodeURIComponent(guidedTopic));
  const prods = Object.keys(m.grid);
  if (!prods.length) { box.innerHTML = '<span class="muted">No learning-path data for this topic.</span>'; return; }
  const rows = prods.map((pr) => {
    const g = m.grid[pr];
    const cells = m.levels.map((lv) => `<td><button class="mapcell${guidedLevel === lv ? ' on' : ''}" data-level="${lv}">${g[lv] || 0}</button></td>`).join('');
    return `<tr><th>${esc(prettyProduct(pr))}</th>${cells}</tr>`;
  }).join('');
  box.innerHTML = `<b>Topic map</b> <span class="muted" style="font-size:12px">— learning paths by product & level (tap a number to filter)</span>
    <table class="mapgrid"><tr><th></th>${m.levels.map((l) => `<th>${cap(l)}</th>`).join('')}</tr>${rows}</table>`;
  box.querySelectorAll('.mapcell').forEach((b) => (b.onclick = () => { guidedLevel = guidedLevel === b.dataset.level ? '' : b.dataset.level; $('#gLevel').value = guidedLevel; loadMap(); loadPaths(); }));
}

async function loadPaths() {
  const box = $('#gPaths'); box.innerHTML = skeletonList(4);
  const qs = new URLSearchParams({ topic: guidedTopic }); if (guidedLevel) qs.set('level', guidedLevel);
  const paths = await api.get('/api/paths?' + qs);
  if (!paths.length) { box.innerHTML = '<p class="empty">No learning paths for this filter.</p>'; return; }
  box.innerHTML = paths.map((p) => {
    const pct = p.total ? Math.round((p.read / p.total) * 100) : 0;
    const hrs = p.duration ? (p.duration >= 60 ? `~${Math.round(p.duration / 60)} h` : `${p.duration} min`) : '';
    return `<div class="card" style="margin-bottom:10px">
      <div class="sec-head">
        <div><b>${esc(p.title)}</b><div class="muted" style="font-size:13px"><span class="pill lvl-${p.level}">${cap(p.level) || 'path'}</span> · ${p.total} modules${hrs ? ' · ' + hrs : ''} · ${p.read}/${p.total} done</div></div>
        <div class="sec-actions"><button data-path="${p.uid}">Open</button></div>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="path-mods" id="path-${p.uid}" hidden></div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-path]').forEach((b) => (b.onclick = () => togglePath(b.dataset.path)));
}

async function togglePath(uid) {
  const box = byId('path-' + uid);
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = '<p class="muted">Loading…</p>';
  const p = await api.get('/api/paths/' + encodeURIComponent(uid));
  const urls = p.modules.map((m) => m.url);
  box.innerHTML = (p.summary ? `<p class="muted" style="font-size:13px;margin:4px 0 8px">${esc(p.summary)}</p>` : '') +
    p.modules.map((m) => moduleRow(m, m.units ? `· ${m.units} units` : '')).join('');
  box.querySelectorAll('.tleaf[data-url]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); startOrder(urls, a.dataset.url); }));
}

async function loadPlans() {
  const box = $('#gPlans'); const plans = await api.get('/api/plans');
  if (!plans.length) { box.innerHTML = '<p class="empty">No plans yet. Create one above, then add articles from the reader (⋯ → Add to plan).</p>'; return; }
  box.innerHTML = plans.map((pl) => {
    const pct = pl.total ? Math.round((pl.read / pl.total) * 100) : 0;
    return `<div class="card" style="margin-bottom:10px">
      <div class="sec-head">
        <div><b>${esc(pl.title)}</b><div class="muted" style="font-size:13px">${pl.read}/${pl.total} read</div></div>
        <div class="sec-actions"><button data-plan="${pl.id}">Open</button><button data-delplan="${pl.id}">Delete</button></div>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="plan-items" id="plan-${pl.id}" hidden></div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-plan]').forEach((b) => (b.onclick = () => togglePlan(b.dataset.plan)));
  box.querySelectorAll('[data-delplan]').forEach((b) => (b.onclick = async () => { if (confirm('Delete this plan? (your read history stays)')) { await api.send('/api/plans/' + b.dataset.delplan, 'DELETE'); loadPlans(); } }));
}

async function togglePlan(id) {
  const box = byId('plan-' + id);
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = '<p class="muted">Loading…</p>';
  const pl = await api.get('/api/plans/' + id);
  if (!pl.items.length) { box.innerHTML = '<p class="muted" style="font-size:13px">Empty — open an article and use ⋯ → Add to plan.</p>'; return; }
  const urls = pl.items.map((it) => it.url);
  box.innerHTML = pl.items.map((it) => `<div class="plan-row">${moduleRow(it)}<button class="plan-x" data-rm="${esc(it.url)}" title="Remove">✕</button></div>`).join('');
  box.querySelectorAll('.tleaf[data-url]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); startOrder(urls, a.dataset.url); }));
  box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { await api.send('/api/plans/' + id + '/items?url=' + encodeURIComponent(b.dataset.rm), 'DELETE'); box.hidden = true; togglePlan(id); }));
}

// ---- Settings ----
async function renderSettings() {
  const el = $('#settings');
  const s = await api.get('/api/settings');
  const topicChips = TOPICS.map((t) => `<span class="topic-chip">${esc(t.label)} <button data-del="${t.id}" title="Remove">✕</button></span>`).join('');
  el.innerHTML = `
    <h2 class="view-title">Settings</h2>
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-top:0">Topics</h3>
      <div>${topicChips}</div>
      <div class="toolbar" style="margin-top:10px">
        <input id="ntLabel" placeholder="Label (e.g. Dataverse)" />
        <input id="ntQuery" placeholder="Search query (e.g. Dataverse)" />
        <input id="ntProducts" placeholder="Catalog products (optional, comma-sep)" />
        <button id="addTopic" class="primary">Add topic</button>
      </div>
      <p class="muted" style="font-size:12px">Products use Microsoft Learn Catalog ids: power-apps, power-automate, power-pages, dataverse, ai-builder, power-platform. Leave blank for article-only topics (like Copilot Studio).</p>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-top:0">AI summaries</h3>
      <p class="muted">${s.anthropic_key_set ? '✓ Anthropic API key detected — AI summaries enabled.' : 'No API key — local summaries only. Add a key to enable AI summaries.'}</p>
      <div class="form-row"><label>Anthropic API key (stored locally; leave blank to keep current)</label><input id="setKey" type="password" placeholder="sk-ant-…" /></div>
      <div class="form-row"><label>Model</label>
        <select id="setModel">
          ${['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']
            .concat(['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'].includes(s.anthropic_model || 'claude-opus-4-8') ? [] : [s.anthropic_model])
            .map((m) => `<option ${m === (s.anthropic_model || 'claude-opus-4-8') ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
        <span class="muted" style="font-size:12px">Opus = best quality · Haiku = fastest &amp; cheapest. You pay Anthropic per summary.</span>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-top:0">Send to Kindle</h3>
      <div class="form-row"><label>Delivery method</label>
        <select id="kMethod">
          <option value="file" ${s.kindle_method !== 'email' ? 'selected' : ''}>Save EPUB file (use the Send to Kindle app)</option>
          <option value="email" ${s.kindle_method === 'email' ? 'selected' : ''}>Email directly to Kindle</option>
        </select></div>
      <p class="muted" style="font-size:12px">Files are saved to: <code>${esc(s.export_dir)}</code></p>
      <div id="emailCfg" ${s.kindle_method === 'email' ? '' : 'hidden'}>
        <div class="form-row"><label>Your @kindle.com address</label><input id="kEmail" value="${esc(s.kindle_email)}" placeholder="you_abc@kindle.com" /></div>
        <div class="form-row"><label>SMTP host</label><input id="smtpHost" value="${esc(s.smtp_host)}" placeholder="smtp.gmail.com" /></div>
        <div class="form-row"><label>SMTP port</label><input id="smtpPort" value="${esc(s.smtp_port || '465')}" /></div>
        <div class="form-row"><label>SMTP username</label><input id="smtpUser" value="${esc(s.smtp_user)}" placeholder="you@gmail.com" /></div>
        <div class="form-row"><label>SMTP password / app password ${s.smtp_pass_set ? '(saved)' : ''}</label><input id="smtpPass" type="password" placeholder="leave blank to keep current" /></div>
        <div class="form-row"><label>From address</label><input id="smtpFrom" value="${esc(s.smtp_from)}" placeholder="you@gmail.com" /></div>
        <p class="muted" style="font-size:12px">Add your SMTP "from" address to Amazon's Approved Personal Document Email List, or delivery will bounce.</p>
      </div>
      <button id="saveKindle" class="primary">Save Kindle settings</button>
    </div>`;

  el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this topic and its tracked items?')) return;
    await api.send('/api/topics/' + encodeURIComponent(b.dataset.del), 'DELETE');
    await loadTopics(); renderSettings();
  }));
  $('#addTopic').onclick = async () => {
    const label = $('#ntLabel').value.trim(); if (!label) return toast('Enter a label.');
    await api.send('/api/topics', 'POST', { label, query: $('#ntQuery').value.trim() || label, products: $('#ntProducts').value.trim() });
    await loadTopics(); renderSettings(); toast('Topic added — Refresh all to pull its articles.');
  };
  $('#kMethod').onchange = () => ($('#emailCfg').hidden = $('#kMethod').value !== 'email');
  $('#saveKindle').onclick = async () => {
    await api.send('/api/settings', 'POST', {
      kindle_method: $('#kMethod').value, kindle_email: $('#kEmail')?.value || '',
      smtp_host: $('#smtpHost')?.value || '', smtp_port: $('#smtpPort')?.value || '',
      smtp_user: $('#smtpUser')?.value || '', smtp_pass: $('#smtpPass')?.value || '',
      smtp_from: $('#smtpFrom')?.value || '',
    });
    toast('Kindle settings saved.');
  };
  // Persist AI fields on blur.
  $('#setKey').onchange = () => api.send('/api/settings', 'POST', { anthropic_key: $('#setKey').value });
  $('#setModel').onchange = () => api.send('/api/settings', 'POST', { anthropic_model: $('#setModel').value });
}

// ---- Sections (docset TOC + progress) ----
// Shared tree renderer: groups are collapsible headers, articles are clickable
// leaves with a read-status dot. currentUrl highlights the open article.
function renderTree(nodes, currentUrl) {
  const row = (n) => {
    const kids = n.children && n.children.length ? `<div class="tkids">${n.children.map(row).join('')}</div>` : '';
    if (n.url) {
      const dot = n.status === 'read' ? '✓' : n.status === 'reading' ? '◐' : '○';
      const cls = (n.status === 'read' ? 'tdone ' : n.status === 'reading' ? 'tprog ' : '') + (n.url === currentUrl ? 'tcur' : '');
      return `<div class="tnode"><a class="tleaf ${cls}" data-url="${esc(n.url)}"><span class="tdot">${dot}</span>${esc(n.title)}</a>${kids}</div>`;
    }
    return `<div class="tnode"><div class="thead"><span class="tcaret">▾</span>${esc(n.title)}</div>${kids}</div>`;
  };
  return nodes.map(row).join('');
}
function wireTree(container, onOpen) {
  container.querySelectorAll('.tleaf[data-url]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); onOpen(a.dataset.url); }));
  container.querySelectorAll('.thead').forEach((h) => (h.onclick = () => {
    const kids = h.nextElementSibling;
    if (kids && kids.classList.contains('tkids')) {
      kids.hidden = !kids.hidden;
      h.querySelector('.tcaret').textContent = kids.hidden ? '▸' : '▾';
    }
  }));
}
// Open a URL in the reader AND track it (so section progress updates).
async function openTracked(url) {
  const r = await api.send('/api/track', 'POST', { url });
  openReader({ id: r.id, url });
}

async function renderSections() {
  const el = $('#learnSections');
  const list = await api.get('/api/sections');
  el.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <b>Track a whole docset</b>
      <p class="muted" style="font-size:13px;margin:6px 0 10px">Paste a Microsoft Learn section URL — e.g. the Copilot Studio <i>guidance</i> landing page — to build its left-navigation and track your progress through every article.</p>
      <div class="toolbar">
        <input id="secUrl" type="url" placeholder="https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/" style="flex:1;min-width:240px" />
        <button id="secAdd" class="primary">Scan section</button>
      </div>
    </div>
    <div id="secList"></div>`;
  $('#secAdd').onclick = addSection;
  $('#secUrl').onkeydown = (e) => { if (e.key === 'Enter') addSection(); };

  const box = $('#secList');
  if (!list.length) { box.innerHTML = '<p class="empty">No sections yet. Paste a docset URL above and scan it.</p>'; return; }
  box.innerHTML = list.map((s) => {
    const pct = s.total ? Math.round((s.read / s.total) * 100) : 0;
    return `<div class="card" style="margin-bottom:12px">
      <div class="sec-head">
        <div><b>${esc(s.title)}</b><div class="muted" style="font-size:13px">${s.read}/${s.total} read${s.reading ? ` · ${s.reading} in progress` : ''}</div></div>
        <div class="sec-actions">
          <button data-exp="${s.id}">Contents</button>
          <button data-rescan="${s.id}">Rescan</button>
          <button data-del="${s.id}">Remove</button>
        </div>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="sec-tree" id="tree-${s.id}" hidden></div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-exp]').forEach((b) => (b.onclick = () => toggleSectionTree(b.dataset.exp)));
  box.querySelectorAll('[data-rescan]').forEach((b) => (b.onclick = async () => { b.classList.add('spin'); await api.send('/api/sections/' + b.dataset.rescan + '/rescan', 'POST'); toast('Rescanned.'); renderSections(); }));
  box.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Remove this section? (your read history stays)')) { await api.send('/api/sections/' + b.dataset.del, 'DELETE'); renderSections(); } }));
}
async function addSection() {
  const url = $('#secUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) return toast('Paste a full Microsoft Learn URL.');
  toast('Scanning section…', 1500);
  const r = await api.send('/api/sections', 'POST', { url });
  if (r.error) return toast('Scan failed: ' + r.error, 4000);
  toast('Added: ' + (r.title || 'section'));
  renderSections();
}
async function toggleSectionTree(id) {
  const box = $('#tree-' + id);
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = '<p class="muted">Loading…</p>';
  const data = await api.get('/api/sections/' + id);
  box.innerHTML = renderTree(data.tree, null);
  wireTree(box, openTracked);
}


async function renderGuide() {
  const el = $('#guide');
  const [s, st] = await Promise.all([api.get('/api/settings'), api.get('/api/stats')]);
  const topics = TOPICS.length;
  const ai = st.aiConfigured ? '✅ AI summaries enabled' : '⚪ Local summaries only (add an API key in Settings for AI)';
  const kindle = s.kindle_method === 'email'
    ? `✉️ Email to ${s.kindle_email || 'your Kindle (set address in Settings)'}`
    : `💾 Save EPUB files to ${s.export_dir || 'your Kindle export folder'}`;

  const feature = (ico, title, desc) =>
    `<div class="feature"><div class="ico">${ico}</div><div class="ft"><b>${title}</b><span>${desc}</span></div></div>`;
  const road = (badge, cls, title, desc) =>
    `<div class="road"><span class="pill ${cls} st">${badge}</span><div><b>${title}</b><div class="muted" style="font-size:13px">${desc}</div></div></div>`;

  el.innerHTML = `
    <button class="backbtn" onclick="showView('dashboard')">‹ Home</button>
    <h2 class="view-title">Guide &amp; Roadmap</h2>

    <div class="card">
      <b>Your setup</b>
      <ul style="list-style:none;padding:0;margin:10px 0 0;line-height:1.9">
        <li>${ai}</li>
        <li>📩 Send to Kindle: ${kindle}</li>
        <li>📚 Tracking ${st.total} articles across ${topics} topics</li>
        <li>🔄 Daily auto-refresh: double-click <code>setup-schedule.cmd</code> to enable desktop notifications</li>
      </ul>
    </div>

    <h3 class="g-h3">Quick start</h3>
    <ol class="steps card">
      <li>Click <b>↻ Refresh</b> (top-right) to pull the latest from Microsoft Learn. The first launch does this automatically.</li>
      <li>On <b>Home</b>, pick something under <b>Continue reading</b> or <b>Next up</b> — or open the <b>Library</b> to filter (All / Unread / Reading / Read / ✨ New) and search.</li>
      <li>In the reader, tap <b>Aa</b> for theme (Light / Sepia / Night) and text size, spacing, width &amp; typeface — your choice is saved. The bars tuck away as you scroll and return at the top/end, where a <b>✓ Mark as read</b> button waits.</li>
      <li>Tap <b>⋯</b> to mark Reading/Read, rate, add notes, send to Kindle, or add to a plan. Tap <b>✦</b> for a summary, and <b>☰</b> for the section's contents.</li>
      <li>Tap any <b>link inside an article</b> to keep reading in-app (added to your Library). <b>‹ Back</b> steps back through what you followed.</li>
      <li><b>Guided learning</b> lives in the <b>Learn</b> tab: official Learning Paths, a topic map, and your reading plans. Open one and use <b>Prev / Next</b> to step through it.</li>
      <li>On an overview/TOC page, tap <b>Build a guide ›</b> to turn its articles into an ordered plan you read with Prev/Next.</li>
      <li>Check <b>Library → ✨ New</b> for articles added since your last visit, then “Mark all seen”.</li>
    </ol>

    <h3 class="g-h3">Features</h3>
    <div class="card" style="padding:4px 16px">
      ${feature('📖', 'Distraction-free reader', 'Light / Sepia / Night themes, adjustable type, bars that auto-hide as you read, progress & time-left.')}
      ${feature('🔗', 'In-app links', 'Microsoft Learn links open in the reader and are added to your Library automatically.')}
      ${feature('🗺️', 'Section navigation', 'Track an entire Microsoft Learn docset — a left-nav table of contents (☰) with read progress, plus Prev/Next arrows to walk straight through a section.')}
      ${feature('🧭', 'Build a guide from a page', 'On an overview/TOC page, tap “Build a guide” to turn its links into an ordered reading plan you step through with Prev/Next.')}
      ${feature('🎓', 'Guided learning', 'Official Microsoft Learning Paths (ordered by topic & level), a topic map of how products/levels relate, and your own reading plans. While reading, see which paths an article belongs to and "follow" one.')}
      ${feature('✅', 'Reading tracking', 'Mark Reading/Read, star-rate, and take notes. Progress shows on the Dashboard.')}
      ${feature('✦', 'Summaries', 'Instant local summaries, or higher-quality AI summaries when an Anthropic key is set.')}
      ${feature('📝', 'Rich callouts', 'Note, Tip, Important, Warning and Caution boxes render as styled, color-coded panels — not plain text.')}
      ${feature('🆕', 'New since last visit', 'Library → ✨ New lists articles added or updated since you were last here.')}
      ${feature('📩', 'Send to Kindle', 'Turn any article into an EPUB — save the file or email it to your Kindle.')}
      ${feature('🔄', 'Auto-updates', 'Optional daily background refresh with a desktop notification when new articles land.')}
      ${feature('🗂️', 'Custom topics', 'Add or remove exactly what you track in Settings.')}
    </div>

    <h3 class="g-h3">Reading tips</h3>
    <ul class="card" style="line-height:1.9">
      <li><b>Themes &amp; type:</b> the <b>Aa</b> button — Night mode for low light; “Wide” uses the most screen.</li>
      <li><b>Focused reading:</b> the bars auto-hide while you scroll down and return when you scroll up or reach the end.</li>
      <li><b>Contents &amp; paging:</b> <b>☰</b> opens the section's table of contents; <b>Prev / Next</b> walk through a path, section, or guide.</li>
      <li><b>Related paths:</b> when an article belongs to Learning Paths, a strip at the top lets you “follow” one so Prev/Next tracks it.</li>
      <li><b>Build a guide:</b> on a link-heavy overview page, tap <b>Build a guide ›</b> to make an ordered reading plan from it.</li>
      <li><b>Back:</b> <b>‹ Back</b> steps through linked articles; <b>‹ Library</b> returns to your list.</li>
      <li><b>Touch-first:</b> flip your Surface to portrait, drop the keyboard, and read.</li>
    </ul>

    <h3 class="g-h3">Roadmap</h3>
    <div class="card">
      ${road('Done', 'read', 'Kindle-style reader', 'Light/Sepia/Night themes, typography controls, auto-hiding bars, styled Note/Tip callouts.')}
      ${road('Done', 'read', 'In-app article links', 'Learn links open in the reader and save to your Library.')}
      ${road('Done', 'read', 'Section navigation &amp; progress', 'Scan a docset; read &amp; track a whole section from a TOC tree and reader drawer.')}
      ${road('Done', 'read', 'Build a guide from a page', 'Turn an overview/TOC page into an ordered reading plan with Prev/Next.')}
      ${road('Done', 'read', 'Guided learning', 'Learning Paths + topic map + reading plans, with related paths shown in articles.')}
      ${road('Done', 'read', 'Daily auto-refresh', 'Background job with desktop notifications for new articles.')}
      ${road('Done', 'read', 'Local + AI summaries', 'Free local summaries, optional Claude-powered summaries.')}
      ${road('Planned', 'kindle', 'Continue reading', 'Reopen the last article where you left off (scroll position).')}
      ${road('Planned', 'kindle', 'Edge swipe-back', "Swipe from the screen edge to go back, Surface-style.")}
      ${road('Planned', 'kindle', 'Pinned “Saved / linked”', 'A quick shortcut to your followed links on the Dashboard.')}
      ${road('Idea', 'reading', 'Full-text search', 'Search inside article bodies, not just titles.')}
      ${road('Idea', 'reading', 'Highlights &amp; annotations', 'Select text to highlight and keep notes inline.')}
      ${road('Idea', 'reading', 'Offline reading', 'Cache articles to read without a connection.')}
      ${road('Idea', 'reading', 'Corporate proxy support', 'Fetch through a proxy on locked-down networks.')}
      ${road('Idea', 'reading', 'Reading goals &amp; streaks', 'Set a weekly target and track your streak.')}
    </div>

    <h3 class="g-h3">Setup &amp; files</h3>
    <ul class="card" style="line-height:1.9">
      <li><b>Start the app:</b> double-click <code>start.cmd</code> (opens http://localhost:7777).</li>
      <li><b>Daily updates:</b> <code>setup-schedule.cmd</code> (8:00 AM; change with <code>setup-schedule.cmd 07:30</code>; remove with <code>remove-schedule.cmd</code>).</li>
      <li><b>AI summaries:</b> Settings → paste your Anthropic API key.</li>
      <li><b>Your data</b> stays on this PC in <code>data\\learnhub.db</code>; Kindle EPUBs go to your export folder.</li>
    </ul>
    <p class="muted" style="margin:14px 2px">Learn Hub • a personal reading platform for Microsoft Learn — Power Platform &amp; Copilot Studio.</p>
  `;
}

// ---- Reader (Kindle-style) ----
const reader = $('#reader');
const rScroll = $('#rScroll');
let currentWords = 0;
let readerStack = []; // history of {id,url} for in-article link navigation
let sectionOrder = null; // { tocUrl, urls:[...] } cached reading order for prev/next

// Reading preferences (persisted locally, applied instantly).
const RPREFS = Object.assign(
  { theme: 'light', size: 20, lh: 1.75, width: 'medium', font: 'serif' },
  JSON.parse(localStorage.getItem('lh.reader') || '{}')
);
const WIDTHS = { narrow: '680px', medium: '880px', wide: '1200px' };
const FONTS = {
  serif: "'Iowan Old Style','Palatino Linotype','Book Antiqua',Georgia,serif",
  sans: "-apple-system,'Segoe UI',Roboto,system-ui,sans-serif",
};
function applyRPrefs() {
  reader.dataset.rtheme = RPREFS.theme;
  const a = $('#readerContent').style;
  a.setProperty('--r-fs', RPREFS.size + 'px');
  a.setProperty('--r-lh', RPREFS.lh);
  a.setProperty('--r-measure', WIDTHS[RPREFS.width]);
  a.setProperty('--r-ff', FONTS[RPREFS.font]);
  document.querySelectorAll('.r-theme').forEach((b) => b.classList.toggle('active', b.dataset.rt === RPREFS.theme));
  document.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('active', b.dataset.width === RPREFS.width));
  document.querySelectorAll('[data-font]').forEach((b) => b.classList.toggle('active', b.dataset.font === RPREFS.font));
  localStorage.setItem('lh.reader', JSON.stringify(RPREFS));
}

// Bottom sheets
const SHEETS = ['aaSheet', 'sumSheet', 'moreSheet', 'planSheet'];
function openSheet(id) {
  reader.classList.remove('immersive');
  SHEETS.forEach((s) => (s !== id) && $('#' + s).classList.remove('up'));
  const sc = $('#rScrim'), sh = $('#' + id);
  sc.hidden = false; sh.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => { sh.classList.add('up'); sc.classList.add('show'); }));
}
function closeSheets() {
  $('#rScrim').classList.remove('show');
  SHEETS.forEach((s) => $('#' + s).classList.remove('up'));
  setTimeout(() => { $('#rScrim').hidden = true; SHEETS.forEach((s) => ($('#' + s).hidden = true)); }, 280);
}
$('#rScrim').onclick = () => { closeSheets(); closeToc(); };
$('#aaBtn').onclick = () => { closeToc(); openSheet('aaSheet'); };
$('#sumBtn').onclick = () => { closeToc(); openSheet('sumSheet'); };
$('#moreBtn').onclick = () => { closeToc(); openSheet('moreSheet'); };
$('#tocBtn').onclick = openToc;

// Add the current article to a reading plan (from the More sheet).
$('#addPlanBtn').onclick = openPlanPicker;
$('#buildGuideBtn').onclick = buildGuideFromPage;

// Scan the current page's in-content links into an ordered guide (reading plan)
// and start stepping through it with Prev/Next.
async function buildGuideFromPage() {
  closeSheets();
  toast('Scanning this page…', 1500);
  let r;
  try { r = await api.send('/api/plans/from-page', 'POST', { url: currentItem.url }); }
  catch { return toast('Could not scan this page.', 3000); }
  if (!r || !r.count || r.count < 2) return toast('No linked articles found on this page to build a guide.', 3500);
  sectionOrder = { tocUrl: 'guide', urls: r.urls };
  openTracked(r.urls[1] || r.urls[0]); // start at the first linked article
  toast(`Guide built — ${r.count - 1} articles. Use Prev/Next. Saved to Learn → My plans.`, 4000);
}
async function openPlanPicker() {
  const plans = await api.get('/api/plans');
  $('#planPick').innerHTML = plans.length
    ? plans.map((pl) => `<button class="r-planopt" data-plan="${pl.id}">${esc(pl.title)} <span class="muted" style="font-size:12px">${pl.read}/${pl.total}</span></button>`).join('')
    : '<p class="muted" style="font-size:13px;padding:4px 0">No plans yet — create one below.</p>';
  openSheet('planSheet');
  $('#planPick').querySelectorAll('[data-plan]').forEach((b) => (b.onclick = () => addToPlan(b.dataset.plan)));
  $('#newPlanBtn').onclick = async () => {
    const r = await api.send('/api/plans', 'POST', { title: $('#newPlanName').value.trim() || 'My plan' });
    $('#newPlanName').value = '';
    addToPlan(r.id);
  };
}
async function addToPlan(planId) {
  await api.send('/api/plans/' + planId + '/items', 'POST', { url: currentItem.url, title: $('#rTitle').textContent || currentItem.url });
  closeSheets();
  toast('Added to plan.');
}

// Prev / Next: step through the reading order of the article's section.
$('#rPrev').onclick = () => { const u = $('#rPrev').dataset.url; if (u) openTracked(u); };
$('#rNext').onclick = () => { const u = $('#rNext').dataset.url; if (u) openTracked(u); };

// Show which learning paths include the current article, and let you "follow"
// one so Prev/Next steps through that path from here.
async function updateRelated(url) {
  const box = $('#rRelated');
  box.hidden = true; box.innerHTML = '';
  try {
    const hits = await api.get('/api/related?url=' + encodeURIComponent(url));
    if (currentItem.url !== url || !hits.length) return;
    const chips = hits.slice(0, 6).map((h) =>
      `<button class="r-related-chip" data-uid="${esc(h.uid)}"><span>📘 ${esc(h.title)}</span><span class="lv">${cap(h.level)} · step ${h.pos}/${h.total}</span></button>`
    ).join('');
    box.innerHTML = `<div class="r-related-box"><div class="r-related-head">Part of ${hits.length} learning path${hits.length > 1 ? 's' : ''} — tap to follow:</div>${chips}</div>`;
    box.hidden = false;
    box.querySelectorAll('[data-uid]').forEach((b) => (b.onclick = async () => {
      const pth = await api.get('/api/paths/' + encodeURIComponent(b.dataset.uid));
      const urls = pth.modules.map((m) => m.url);
      sectionOrder = { tocUrl: 'path', urls };
      updateSectionNav(url); // refresh Prev/Next to this path's order
      toast('Following: ' + pth.title);
    }));
  } catch { /* no related paths */ }
}

function flattenToc(nodes) {
  const out = [];
  const walk = (a) => { for (const n of a || []) { if (n.url) out.push(n.url); walk(n.children); } };
  walk(nodes);
  return out;
}
// Figure out where the current article sits in its section and set the arrows.
// Uses the cached order when possible; otherwise fetches the docset TOC once.
async function updateSectionNav(url) {
  const nav = $('#rNav');
  const apply = (urls) => {
    const i = urls.indexOf(url);
    if (i < 0) { nav.hidden = true; return; }
    const prev = urls[i - 1] || '', next = urls[i + 1] || '';
    $('#rPrev').dataset.url = prev; $('#rPrev').disabled = !prev;
    $('#rNext').dataset.url = next; $('#rNext').disabled = !next;
    $('#rPos').textContent = `${i + 1} / ${urls.length}`;
    nav.hidden = false;
  };
  if (sectionOrder && sectionOrder.urls.includes(url)) { apply(sectionOrder.urls); return; }
  nav.hidden = true;
  try {
    const data = await api.get('/api/toc?url=' + encodeURIComponent(url));
    if (currentItem.url !== url) return; // user moved on while loading
    const urls = flattenToc(data.tree);
    if (urls.includes(url)) { sectionOrder = { tocUrl: data.tocUrl, urls }; apply(urls); }
    else sectionOrder = null;
  } catch { sectionOrder = null; }
}

// Left "Contents" drawer: the docset TOC for the current article, with read
// status, so you can read and track a whole section.
async function openToc() {
  reader.classList.remove('immersive');
  closeSheets();
  const sc = $('#rScrim'), t = $('#rToc');
  sc.hidden = false; t.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => { t.classList.add('up'); sc.classList.add('show'); }));
  t.innerHTML = '<p class="muted" style="padding:12px">Loading contents…</p>';
  try {
    const data = await api.get('/api/toc?url=' + encodeURIComponent(currentItem.url));
    t.innerHTML =
      `<div class="r-toc-head"><b>${esc(data.title)}</b>` +
      `<span class="muted" style="font-size:12px;flex:1">${data.read}/${data.total} read</span>` +
      `<button id="trackSec" class="small">＋ Track</button></div>` +
      `<div class="r-toc-body">${renderTree(data.tree, currentItem.url)}</div>`;
    $('#trackSec').onclick = async () => { await api.send('/api/sections', 'POST', { url: currentItem.url }); toast('Added to the Sections tab.'); };
    wireTree(t, (url) => { closeToc(); openLink(url); });
    // Scroll the current article into view in the tree.
    const cur = t.querySelector('.tleaf.tcur');
    if (cur) cur.scrollIntoView({ block: 'center' });
  } catch {
    t.innerHTML = '<p class="empty">No section navigation found for this page.</p>';
  }
}
function closeToc() {
  const t = $('#rToc');
  if (t.hidden) return;
  t.classList.remove('up');
  if (SHEETS.every((s) => $('#' + s).hidden)) $('#rScrim').classList.remove('show');
  setTimeout(() => {
    t.hidden = true;
    if (SHEETS.every((s) => $('#' + s).hidden)) $('#rScrim').hidden = true;
  }, 280);
}

// Typography controls
document.querySelectorAll('.r-theme').forEach((b) => (b.onclick = () => { RPREFS.theme = b.dataset.rt; applyRPrefs(); }));
document.querySelectorAll('[data-size]').forEach((b) => (b.onclick = () => {
  RPREFS.size = Math.min(30, Math.max(15, RPREFS.size + (b.dataset.size === '+' ? 1 : -1))); applyRPrefs();
}));
document.querySelectorAll('[data-lh]').forEach((b) => (b.onclick = () => {
  RPREFS.lh = Math.min(2.2, Math.max(1.4, +(RPREFS.lh + (b.dataset.lh === '+' ? 0.1 : -0.1)).toFixed(2))); applyRPrefs();
}));
document.querySelectorAll('[data-width]').forEach((b) => (b.onclick = () => { RPREFS.width = b.dataset.width; applyRPrefs(); }));
document.querySelectorAll('[data-font]').forEach((b) => (b.onclick = () => { RPREFS.font = b.dataset.font; applyRPrefs(); }));

// Tapping the page closes an open sheet (but no longer hides the bars —
// chrome is managed by scroll direction below so it's always recoverable).
rScroll.addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  if (SHEETS.some((s) => !$('#' + s).hidden)) closeSheets();
});

// In-article links to Microsoft Learn open inside the reader (and get added to
// your Library) instead of bouncing out to the website. Other links open normally.
$('#readerContent').addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  // Open Microsoft Learn article links inside the reader; let image/file links
  // and non-Learn links open normally.
  if (/learn\.microsoft\.com/i.test(href) && !/\.(png|jpe?g|gif|svg|webp|pdf|zip)(\?|#|$)/i.test(href)) {
    e.preventDefault();
    openLink(href);
  }
});
async function openLink(url) {
  if (currentItem) readerStack.push({ ...currentItem });
  toast('Opening linked article…', 1200);
  try {
    const r = await api.send('/api/track', 'POST', { url });
    openReader({ id: r.id, url }, true);
  } catch {
    readerStack.pop();
    toast('Could not open that link.', 3000);
  }
}

// Scroll: update progress AND manage the bars. They hide while you read
// downward for a clean view, and always reappear when you scroll up or reach
// the top/end of the article — so the controls are never stuck off-screen.
let lastScrollY = 0;
rScroll.addEventListener('scroll', () => {
  updateProgress();
  const y = rScroll.scrollTop;
  const max = rScroll.scrollHeight - rScroll.clientHeight;
  if (y < 60 || max - y < 120) reader.classList.remove('immersive');       // near top or end → show
  else if (y - lastScrollY > 8) reader.classList.add('immersive');         // scrolling down → hide
  else if (lastScrollY - y > 8) reader.classList.remove('immersive');      // scrolling up → show
  lastScrollY = y;
}, { passive: true });
function updateProgress() {
  const max = rScroll.scrollHeight - rScroll.clientHeight;
  const pct = max > 10 ? rScroll.scrollTop / max : (currentWords ? 1 : 0);
  $('#rBar').style.width = (pct * 100).toFixed(1) + '%';
  const left = Math.max(0, Math.ceil((currentWords * (1 - pct)) / 220));
  $('#rPlabel').textContent = currentWords ? `${Math.round(pct * 100)}%  •  ~${left} min left` : '';
}

$('#readerClose').onclick = () => {
  if (readerStack.length) { openReader(readerStack.pop(), true); return; }
  reader.classList.remove('immersive');
  reader.hidden = true;
  refreshBadge();
  const v = document.querySelector('#tabs button.active')?.dataset.view;
  if (v) showView(v);
};

async function openReaderByUrl(url) {
  const items = await api.get('/api/items?q=');
  const it = items.find((i) => i.url === url);
  openReader(it ? { id: it.id, url } : { id: null, url });
}

async function openReader({ id, url }, keepStack = false) {
  if (!keepStack) readerStack = [];
  currentItem = { id, url };
  reader.hidden = false;
  reader.classList.remove('immersive');
  closeSheets();
  closeToc();
  applyRPrefs();
  $('#readerClose').textContent = readerStack.length ? '‹ Back' : '‹ Library';
  $('#rTitle').textContent = '';
  $('#rBar').style.width = '0%'; $('#rPlabel').textContent = ''; $('#rNav').hidden = true;
  $('#rGuidePrompt').hidden = true;
  $('#readerContent').innerHTML = '<p class="r-updated">Loading…</p>';
  $('#summaryBox').innerHTML = '<span class="muted">Choose Local or AI to generate a summary.</span>';
  $('#openLearn').href = url;
  document.querySelectorAll('[data-sum]').forEach((b) => b.classList.toggle('active', b.dataset.sum === 'local'));
  rScroll.scrollTop = 0; lastScrollY = 0;

  let state = {};
  if (id) {
    const rows = await api.get('/api/items?q=');
    state = rows.find((r) => r.id === id) || {};
  }
  renderStars(state.rating || 0);
  $('#notes').value = state.notes || '';
  syncStatusButtons(state.status);

  const art = await api.get('/api/article?url=' + encodeURIComponent(url));
  if (art.error) {
    $('#readerContent').innerHTML = `<p class="r-updated">Couldn't extract this page.</p><p><a href="${esc(url)}" target="_blank" rel="noopener">Open it on Microsoft Learn ↗</a></p>`;
    return;
  }
  $('#rTitle').textContent = art.title;
  // Article HTML already begins with the page's own <h1>, so don't duplicate the title.
  const meta = art.ms_date ? `<p class="r-updated">Updated ${esc(art.ms_date.slice(0, 10))}</p>` : '';
  $('#readerContent').innerHTML = meta + art.content_html + '<div class="r-end" id="rEnd"></div>';
  currentWords = ($('#readerContent').textContent.match(/\S+/g) || []).length;
  updateProgress();
  updateSectionNav(url);
  updateRelated(url);
  renderEndBar(id, state.status);
  maybeShowGuidePrompt();

  if (id && (!state.status || state.status === 'unread')) setStatus('reading', true);
}

// If a guide was already built from this page, offer to open it. Otherwise, if
// the page is link-heavy (an overview / TOC), offer to build one.
const normUrl = (u = '') => u.split('#')[0].split('?')[0];

async function maybeShowGuidePrompt() {
  const gp = $('#rGuidePrompt');
  gp.hidden = true;
  const pageUrl = normUrl(currentItem?.url || '');

  // Already have a guide built from this page? Show an "open it" link instead.
  if (pageUrl) {
    let existing = null;
    try {
      const plans = await api.get('/api/plans');
      existing = plans.find((pl) => pl.total >= 2 && normUrl(pl.source) === pageUrl);
    } catch { /* ignore — fall through to Build */ }
    if (existing) {
      gp.innerHTML = `<div class="r-guide-box"><span>🧭 You built a guide from this page — <b>${existing.read}/${existing.total}</b> read.</span><button class="r-guide-btn" id="rOpenGuide">Open guide ›</button></div>`;
      gp.hidden = false;
      $('#rOpenGuide').onclick = () => openGuidePlan(existing.id);
      return;
    }
  }

  // No guide yet — offer to build one when the page links to enough articles.
  const links = [...$('#readerContent').querySelectorAll('a[href]')].filter((a) => {
    const h = a.getAttribute('href') || '';
    return /learn\.microsoft\.com/i.test(h) && !/\.(png|jpe?g|gif|svg|webp|pdf|zip)(\?|#|$)/i.test(h);
  });
  const urls = new Set(links.map((a) => a.getAttribute('href').split('#')[0]));
  if (urls.size >= 4) {
    gp.innerHTML = `<div class="r-guide-box"><span>🧭 This page links to <b>${urls.size}</b> articles.</span><button class="r-guide-btn" id="rBuildGuide">Build a guide ›</button></div>`;
    gp.hidden = false;
    $('#rBuildGuide').onclick = buildGuideFromPage;
  }
}

// Open an existing guide and resume at its first unread article (Prev/Next paging).
async function openGuidePlan(id) {
  closeSheets();
  const pl = await api.get('/api/plans/' + id);
  const items = pl.items || [];
  const urls = items.map((it) => it.url);
  if (urls.length < 2) return toast('This guide is empty.', 3000);
  sectionOrder = { tocUrl: 'guide', urls };
  const resume = items.slice(1).find((it) => it.status !== 'read') || items[1] || items[0];
  openTracked(resume.url);
  toast('Opened guide — use Prev/Next.', 2500);
}

// An explicit "finished — mark as read" action at the end of every article, so
// you never need the top bar to complete it.
function renderEndBar(id, status) {
  const end = $('#rEnd'); if (!end) return;
  if (!id) { end.innerHTML = '<div class="r-end-note">Opened from Training — not tracked.</div>'; return; }
  const done = status === 'read';
  end.innerHTML =
    `<button class="r-endbtn" id="rEndRead" ${done ? 'disabled' : ''}>${done ? '✓ Read' : '✓ Mark as read'}</button>` +
    `<button class="r-endbtn ghost" id="rEndBack">Back to list</button>`;
  const er = $('#rEndRead');
  if (er && !done) er.onclick = () => { setStatus('read'); er.textContent = '✓ Read'; er.disabled = true; };
  $('#rEndBack').onclick = () => $('#readerClose').click();
}

function syncStatusButtons(status) {
  document.querySelectorAll('[data-status]').forEach((b) => b.classList.toggle('active', b.dataset.status === status));
}
document.querySelectorAll('[data-status]').forEach((b) => (b.onclick = () => setStatus(b.dataset.status)));
async function setStatus(status, silent) {
  if (!currentItem?.id) { if (!silent) toast("Not tracked (opened from Training)."); return; }
  await api.send('/api/reading', 'POST', { item_id: currentItem.id, status });
  syncStatusButtons(status);
  if (!silent) toast('Marked ' + status + '.');
}

$('#kindleBtn').onclick = async () => {
  const btn = $('#kindleBtn'); btn.classList.add('spin');
  const r = await api.send('/api/kindle', 'POST', { url: currentItem.url, item_id: currentItem.id });
  btn.classList.remove('spin');
  if (r.error) toast('Kindle: ' + r.error, 4000);
  else if (r.sentTo) toast('Emailed to ' + r.sentTo);
  else toast('Saved EPUB → ' + r.path, 4000);
};

document.querySelectorAll('[data-sum]').forEach((b) => (b.onclick = async () => {
  document.querySelectorAll('[data-sum]').forEach((x) => x.classList.toggle('active', x === b));
  const box = $('#summaryBox'); box.innerHTML = '<span class="muted">Summarizing…</span>';
  const s = await api.send('/api/summary', 'POST', { url: currentItem.url, mode: b.dataset.sum });
  if (s.error) { box.innerHTML = '<span class="muted">Error: ' + esc(s.error) + '</span>'; return; }
  const pts = (s.key_points || []).map((p) => `<li>${esc(p)}</li>`).join('');
  box.innerHTML = `${s.fallback ? '<div class="muted" style="font-size:12px">(AI unavailable — showing local summary)</div>' : ''}<p>${esc(s.tldr)}</p>${pts ? `<ul>${pts}</ul>` : ''}`;
}));

function renderStars(n) {
  const box = $('#ratingStars'); box.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement('span'); s.textContent = '★'; s.className = i <= n ? 'on' : '';
    s.onclick = async () => { if (currentItem?.id) { await api.send('/api/reading', 'POST', { item_id: currentItem.id, rating: i }); renderStars(i); toast('Rated ' + i + '★'); } };
    box.appendChild(s);
  }
}
$('#saveNotes').onclick = async () => {
  if (!currentItem?.id) return toast('Item not tracked.');
  await api.send('/api/reading', 'POST', { item_id: currentItem.id, notes: $('#notes').value });
  toast('Notes saved.');
};

// ---- boot ----
async function loadTopics() { TOPICS = await api.get('/api/topics'); }
(async function init() {
  const s = await api.get('/api/settings');
  applyTheme(s.theme || 'light');
  await loadTopics();
  const st = await api.get('/api/stats');
  firstLoading = st.total === 0;
  await refreshBadge();
  showView('dashboard'); // shows the "Fetching…" state while firstLoading

  if (firstLoading) {
    const r = await api.send('/api/refresh', 'POST');
    firstLoading = false;
    offlineWarning = r.errors > 0 && st.total === 0;
    toast(offlineWarning ? "Couldn't reach Microsoft Learn — check your connection." : `Loaded ${r.added} articles from Microsoft Learn.`);
    await refreshBadge();
    if (document.querySelector('#tabs button.active').dataset.view === 'dashboard') renderDashboard();
  }
})();

// Register the service worker so Learn Hub is installable (Start menu / dock) and
// the shell loads offline. Non-fatal if it fails or isn't supported.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
