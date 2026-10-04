// Learn Hub — local HTTP server. Serves the SPA and a small JSON API, proxies
// Microsoft Learn (avoids browser CORS + X-Frame-Options), and opens a browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { PORT, HOST, PUBLIC_DIR, EXPORT_DIR, isAllowedUrl } from './src/config.js';
import { db, itemId, getSetting, setSetting, getMeta, setMeta } from './src/db.js';
import { fetchCatalog, extractArticle, fetchLearningPaths, catalogMap, linksFromContent } from './src/learn.js';
import { refreshTopic, refreshAll } from './src/refresh.js';
import { buildTocTree } from './src/toc.js';
import { localSummary, aiSummary } from './src/summarize.js';
import { buildEpub, saveEpub, slugify, sendToKindleEmail } from './src/kindle.js';

const now = () => new Date().toISOString();
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

// Reject any server-side fetch target that isn't a Microsoft Learn URL.
const okUrl = (res, url) => {
  if (isAllowedUrl(url)) return true;
  json(res, 400, { error: 'Only https://learn.microsoft.com URLs are allowed.' });
  return false;
};

function serveStatic(req, res, pathname) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache, must-revalidate', // always serve the latest UI
  });
  fs.createReadStream(file).pipe(res);
}

// --- Data helpers ---------------------------------------------------------

function listTopics(onlyEnabled = false) {
  return db
    .prepare(`SELECT * FROM topics ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY rowid`)
    .all();
}

async function refreshTopicById(id) {
  const t = listTopics().find((x) => x.id === id);
  return t ? refreshTopic(t) : { added: 0, newItems: [] };
}

// A bucket for articles the user opens by following in-article links. It has no
// query/products, so Refresh never fetches it.
function ensureSavedTopic() {
  if (!db.prepare('SELECT 1 FROM topics WHERE id = ?').get('saved')) {
    db.prepare('INSERT INTO topics (id,label,query,products,enabled,created_at) VALUES (?,?,?,?,1,?)')
      .run('saved', 'Saved / linked', '', '', now());
  }
}

// Ensure a URL exists in the library (adding it to the Saved bucket if new);
// returns its item id so reading/notes/kindle tracking works.
async function trackUrl(url, titleHint = '') {
  const id = itemId(url);
  if (db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)) return id;
  ensureSavedTopic();
  let title = titleHint, desc = '';
  if (!title) {
    try {
      const art = await getArticle(url);
      title = art.title; desc = (art.text || '').slice(0, 220);
    } catch { title = url; }
  }
  db.prepare('INSERT INTO items (id,topic_id,title,url,description,source,published,last_modified,first_seen_at,extra) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'saved', title, url, desc, 'link', '', '', now(), '{}');
  return id;
}

// Fetch + cache an article's extracted content (single source of truth).
async function getArticle(url) {
  let art = db.prepare('SELECT * FROM article_cache WHERE url = ?').get(url);
  if (!art) {
    const ex = await extractArticle(url);
    db.prepare('INSERT OR REPLACE INTO article_cache (url,title,content_html,text,ms_date,fetched_at) VALUES (?,?,?,?,?,?)')
      .run(url, ex.title, ex.content_html, ex.text, ex.ms_date, now());
    art = { url, ...ex };
  }
  return art;
}

// Products to query the training catalog with: one topic's, or all enabled.
function productsFor(topicId) {
  if (topicId && topicId !== 'all') return listTopics().find((x) => x.id === topicId)?.products || '';
  return listTopics(true).map((t) => t.products).filter(Boolean).join(',');
}
const statusOf = (map, url) => map.get(itemId(url)) || 'unread';

// The section a URL belongs to (its directory), used to keep a built guide
// within the same docs area and drop cross-references to other products.
function sectionPrefix(url) {
  try {
    const u = new URL(url);
    let path = u.pathname;
    if (!path.endsWith('/')) path = path.slice(0, path.lastIndexOf('/') + 1);
    return u.origin + path;
  } catch { return ''; }
}
function findTocNode(nodes, url) {
  const bare = (url || '').replace(/\/$/, '');
  for (const n of nodes || []) {
    if (n.url === url || (n.url && n.url.replace(/\/$/, '') === bare)) return n;
    const f = findTocNode(n.children, url);
    if (f) return f;
  }
  return null;
}
function collectSubtree(node) {
  const out = [];
  const walk = (n) => { if (n.url) out.push({ url: n.url, title: n.title }); (n.children || []).forEach(walk); };
  walk(node);
  return out;
}

// --- Section (docset TOC) helpers ---------------------------------------
function readingMap() {
  const m = new Map();
  for (const r of db.prepare('SELECT item_id, status FROM reading').all()) m.set(r.item_id, r.status);
  return m;
}
// Annotate a TOC tree with per-article reading status and return progress counts.
function annotateTree(nodes, map) {
  let total = 0, read = 0, reading = 0;
  const walk = (arr) =>
    arr.map((n) => {
      const children = walk(n.children || []);
      let status = null;
      if (n.url) {
        total++;
        status = map.get(itemId(n.url)) || 'unread';
        if (status === 'read') read++;
        else if (status === 'reading') reading++;
      }
      return { title: n.title, url: n.url, status, children };
    });
  const tree = walk(nodes || []);
  return { tree, total, read, reading };
}

function itemsQuery({ topic, status, q, source }) {
  const where = [];
  const args = [];
  if (topic && topic !== 'all') { where.push('i.topic_id = ?'); args.push(topic); }
  if (source) { where.push('i.source = ?'); args.push(source); }
  if (status && status !== 'all') {
    if (status === 'unread') where.push("COALESCE(r.status,'unread') = 'unread'");
    else { where.push('r.status = ?'); args.push(status); }
  }
  if (q) { where.push('(i.title LIKE ? OR i.description LIKE ?)'); args.push('%' + q + '%', '%' + q + '%'); }
  const sql = `
    SELECT i.*, COALESCE(r.status,'unread') AS status, r.rating, r.notes,
           r.sent_to_kindle_at, r.read_at
    FROM items i LEFT JOIN reading r ON r.item_id = i.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (i.published || i.last_modified) DESC, i.rowid DESC`;
  return db.prepare(sql).all(...args);
}

function stats() {
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const total = n('SELECT COUNT(*) n FROM items');
  const read = n("SELECT COUNT(*) n FROM reading WHERE status='read'");
  const reading = n("SELECT COUNT(*) n FROM reading WHERE status='reading'");
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const readWeek = n('SELECT COUNT(*) n FROM reading WHERE status=? AND read_at > ?', 'read', weekAgo);
  const sent = n('SELECT COUNT(*) n FROM reading WHERE sent_to_kindle_at IS NOT NULL');
  const marker = getMeta('seen_marker', '');
  const fresh = marker
    ? n('SELECT COUNT(*) n FROM items WHERE first_seen_at > ?', marker)
    : 0;
  const perTopic = listTopics().map((t) => ({
    id: t.id, label: t.label,
    total: n('SELECT COUNT(*) n FROM items WHERE topic_id=?', t.id),
    read: n("SELECT COUNT(*) n FROM items i JOIN reading r ON r.item_id=i.id WHERE i.topic_id=? AND r.status='read'", t.id),
  }));
  const recent = db.prepare(
    "SELECT i.title, i.url, r.read_at FROM reading r JOIN items i ON i.id=r.item_id WHERE r.status='read' ORDER BY r.read_at DESC LIMIT 8"
  ).all();
  return { total, read, reading, readWeek, sent, fresh, perTopic, recent };
}

async function getSummary(url, mode) {
  const row = db.prepare('SELECT * FROM summaries WHERE url=? AND kind=?').get(url, mode === 'ai' ? 'ai' : 'local');
  if (row) return { kind: row.kind, tldr: row.tldr, key_points: JSON.parse(row.key_points || '[]'), cached: true };

  const art = await getArticle(url);
  let s;
  if (mode === 'ai') {
    try { s = await aiSummary(art.title, art.text); }
    catch { s = { ...localSummary(art.text, art.content_html), fallback: true }; }
  } else {
    s = localSummary(art.text, art.content_html);
  }
  db.prepare('INSERT OR REPLACE INTO summaries (url,kind,tldr,key_points,created_at) VALUES (?,?,?,?,?)')
    .run(url, s.kind, s.tldr, JSON.stringify(s.key_points || []), now());
  return s;
}

// --- Request router -------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (!p.startsWith('/api/')) return serveStatic(req, res, p);

    if (p === '/api/topics' && req.method === 'GET') return json(res, 200, listTopics());
    if (p === '/api/topics' && req.method === 'POST') {
      const b = await readBody(req);
      const id = (b.id || slugify(b.label || b.query || 'topic')) + '';
      db.prepare('INSERT OR REPLACE INTO topics (id,label,query,products,enabled,created_at) VALUES (?,?,?,?,1,?)')
        .run(id, b.label || id, b.query || b.label || id, b.products || '', now());
      return json(res, 200, { ok: true, id });
    }
    if (p.startsWith('/api/topics/') && req.method === 'PATCH') {
      const id = decodeURIComponent(p.split('/')[3]);
      const b = await readBody(req);
      if (b.enabled != null) db.prepare('UPDATE topics SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, id);
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/topics/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.split('/')[3]);
      db.prepare('DELETE FROM topics WHERE id=?').run(id);
      db.prepare('DELETE FROM items WHERE topic_id=?').run(id);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      const which = u.searchParams.get('topic');
      const result = which && which !== 'all' ? await refreshTopicById(which) : await refreshAll(true);
      const errors = result.errors ?? (result.error ? 1 : 0);
      return json(res, 200, { ok: true, added: result.added, errors });
    }

    if (p === '/api/items' && req.method === 'GET') {
      return json(res, 200, itemsQuery({
        topic: u.searchParams.get('topic'),
        status: u.searchParams.get('status'),
        q: u.searchParams.get('q'),
        source: u.searchParams.get('source'),
      }));
    }

    if (p === '/api/whatsnew' && req.method === 'GET') {
      const marker = getMeta('seen_marker', '');
      const rows = marker
        ? db.prepare('SELECT i.*, t.label AS topic_label FROM items i JOIN topics t ON t.id=i.topic_id WHERE i.first_seen_at > ? ORDER BY i.first_seen_at DESC').all(marker)
        : db.prepare('SELECT i.*, t.label AS topic_label FROM items i JOIN topics t ON t.id=i.topic_id ORDER BY i.first_seen_at DESC LIMIT 25').all();
      return json(res, 200, { marker, items: rows });
    }
    if (p === '/api/whatsnew/seen' && req.method === 'POST') {
      setMeta('seen_marker', now());
      return json(res, 200, { ok: true });
    }

    if (p === '/api/article' && req.method === 'GET') {
      const url = u.searchParams.get('url');
      if (!url) return json(res, 400, { error: 'url required' });
      if (!okUrl(res, url)) return;
      const art = await getArticle(url);
      return json(res, 200, { title: art.title, content_html: art.content_html, ms_date: art.ms_date, url });
    }

    if (p === '/api/track' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.url) return json(res, 400, { error: 'url required' });
      if (!okUrl(res, b.url)) return;
      const id = await trackUrl(b.url, b.title || '');
      return json(res, 200, { id });
    }

    // Live TOC for the docset an article belongs to (used by the reader drawer).
    if (p === '/api/toc' && req.method === 'GET') {
      const url = u.searchParams.get('url');
      if (!url) return json(res, 400, { error: 'url required' });
      if (!okUrl(res, url)) return;
      const { tocUrl, title, tree } = await buildTocTree(url);
      return json(res, 200, { title, tocUrl, ...annotateTree(tree, readingMap()) });
    }

    // Saved sections (docsets the user is tracking end-to-end).
    if (p === '/api/sections' && req.method === 'GET') {
      const map = readingMap();
      const rows = db.prepare('SELECT * FROM sections ORDER BY created_at DESC').all().map((s) => {
        const a = annotateTree(JSON.parse(s.tree || '[]'), map);
        return { id: s.id, title: s.title, total: a.total, read: a.read, reading: a.reading };
      });
      return json(res, 200, rows);
    }
    if (p === '/api/sections' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.url) return json(res, 400, { error: 'url required' });
      if (!okUrl(res, b.url)) return;
      const { tocUrl, startUrl, title, tree } = await buildTocTree(b.url);
      const id = itemId(tocUrl);
      db.prepare('INSERT OR REPLACE INTO sections (id,title,toc_url,start_url,tree,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, title, tocUrl, startUrl, JSON.stringify(tree), now());
      return json(res, 200, { id, title });
    }
    if (p.startsWith('/api/sections/') && req.method === 'GET') {
      const id = decodeURIComponent(p.split('/')[3]);
      const s = db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
      if (!s) return json(res, 404, { error: 'not found' });
      return json(res, 200, { id, title: s.title, start_url: s.start_url, ...annotateTree(JSON.parse(s.tree || '[]'), readingMap()) });
    }
    if (p.match(/^\/api\/sections\/[^/]+\/rescan$/) && req.method === 'POST') {
      const id = decodeURIComponent(p.split('/')[3]);
      const s = db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
      if (!s) return json(res, 404, { error: 'not found' });
      const { tocUrl, startUrl, title, tree } = await buildTocTree(s.start_url);
      db.prepare('UPDATE sections SET title=?, toc_url=?, start_url=?, tree=? WHERE id=?')
        .run(title, tocUrl, startUrl, JSON.stringify(tree), id);
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/sections/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.split('/')[3]);
      db.prepare('DELETE FROM sections WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }

    // --- Guided: Learning Paths, topic map, custom plans ---
    if (p === '/api/map' && req.method === 'GET') {
      return json(res, 200, await catalogMap(productsFor(u.searchParams.get('topic'))));
    }
    if (p === '/api/paths' && req.method === 'GET') {
      const level = u.searchParams.get('level');
      const map = readingMap();
      let paths = await fetchLearningPaths(productsFor(u.searchParams.get('topic')));
      if (level) paths = paths.filter((x) => x.level === level);
      const list = paths.map((pth) => ({
        uid: pth.uid, title: pth.title, summary: pth.summary, level: pth.level,
        roles: pth.roles, products: pth.products, duration: pth.duration,
        total: pth.modules.length,
        read: pth.modules.filter((m) => statusOf(map, m.url) === 'read').length,
      }));
      return json(res, 200, list);
    }
    if (p.startsWith('/api/paths/') && req.method === 'GET') {
      const uid = decodeURIComponent(p.split('/')[3]);
      const paths = await fetchLearningPaths(productsFor('all'));
      const pth = paths.find((x) => x.uid === uid);
      if (!pth) return json(res, 404, { error: 'not found' });
      const map = readingMap();
      const modules = pth.modules.map((m) => ({ ...m, status: statusOf(map, m.url) }));
      return json(res, 200, { ...pth, modules });
    }
    // Learning paths that include the given article/module URL (shown in the reader).
    if (p === '/api/related' && req.method === 'GET') {
      const url = u.searchParams.get('url');
      if (!url) return json(res, 400, { error: 'url required' });
      const map = readingMap();
      const paths = await fetchLearningPaths(productsFor('all'));
      const hits = [];
      for (const pth of paths) {
        const idx = pth.modules.findIndex((m) => m.url === url);
        if (idx < 0) continue;
        hits.push({
          uid: pth.uid, title: pth.title, level: pth.level,
          pos: idx + 1, total: pth.modules.length,
          read: pth.modules.filter((m) => statusOf(map, m.url) === 'read').length,
        });
      }
      return json(res, 200, hits);
    }

    if (p === '/api/plans' && req.method === 'GET') {
      const map = readingMap();
      const rows = db.prepare('SELECT * FROM plans ORDER BY created_at DESC').all().map((pl) => {
        const items = JSON.parse(pl.items || '[]');
        return { id: pl.id, title: pl.title, total: items.length, read: items.filter((it) => statusOf(map, it.url) === 'read').length };
      });
      return json(res, 200, rows);
    }
    if (p === '/api/plans' && req.method === 'POST') {
      const b = await readBody(req);
      const id = 'pl' + Date.now().toString(36);
      db.prepare('INSERT INTO plans (id,title,items,created_at) VALUES (?,?,?,?)').run(id, (b.title || 'My plan').slice(0, 120), '[]', now());
      return json(res, 200, { id });
    }
    // Build a reading plan (guide) from a page: prefer the docset TOC subtree
    // rooted here (authoritative + full depth), else the page's in-content links;
    // then keep only links within the same section.
    if (p === '/api/plans/from-page' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.url) return json(res, 400, { error: 'url required' });
      if (!okUrl(res, b.url)) return;
      const pageUrl = b.url.split('#')[0].split('?')[0]; // normalize (drop ?context=, #anchor)
      const art = await getArticle(pageUrl);
      let items = [], fromToc = false;
      try {
        const { tree } = await buildTocTree(pageUrl);
        const node = findTocNode(tree, pageUrl);
        if (node) { items = collectSubtree(node); fromToc = true; }
      } catch { /* not a docset TOC page */ }
      if (items.length < 2) { fromToc = false; items = [{ url: pageUrl, title: art.title }, ...linksFromContent(art.content_html)]; }

      // A TOC subtree is already curated, so keep it as-is; only filter the
      // looser link-scrape fallback down to the same section.
      const prefix = sectionPrefix(pageUrl);
      const seen = new Set();
      items = items
        .filter((it) => fromToc || !prefix || it.url.startsWith(prefix))
        .filter((it) => !seen.has(it.url) && seen.add(it.url));
      if (!items.some((it) => it.url === pageUrl)) items.unshift({ url: pageUrl, title: art.title });
      else if (items[0].url !== pageUrl) items = [items.find((it) => it.url === pageUrl), ...items.filter((it) => it.url !== pageUrl)];
      if (items.length < 2) return json(res, 200, { count: 0 });

      const id = 'pl' + Date.now().toString(36);
      const title = ('Guide: ' + (art.title || 'Guide')).replace(/\s+-\s+Microsoft.*$/i, '').slice(0, 120);
      db.prepare('INSERT INTO plans (id,title,items,created_at) VALUES (?,?,?,?)').run(id, title, JSON.stringify(items), now());
      return json(res, 200, { id, title, count: items.length, urls: items.map((i) => i.url) });
    }
    if (p.match(/^\/api\/plans\/[^/]+\/items$/) && req.method === 'POST') {
      const id = decodeURIComponent(p.split('/')[3]);
      const b = await readBody(req);
      if (!b.url) return json(res, 400, { error: 'url required' });
      if (!okUrl(res, b.url)) return;
      const pl = db.prepare('SELECT * FROM plans WHERE id=?').get(id);
      if (!pl) return json(res, 404, { error: 'not found' });
      const items = JSON.parse(pl.items || '[]');
      if (!items.some((x) => x.url === b.url)) {
        items.push({ url: b.url, title: (b.title || b.url).slice(0, 200) });
        db.prepare('UPDATE plans SET items=? WHERE id=?').run(JSON.stringify(items), id);
      }
      return json(res, 200, { ok: true, total: items.length });
    }
    if (p.match(/^\/api\/plans\/[^/]+\/items$/) && req.method === 'DELETE') {
      const id = decodeURIComponent(p.split('/')[3]);
      const pl = db.prepare('SELECT * FROM plans WHERE id=?').get(id);
      if (!pl) return json(res, 404, { error: 'not found' });
      const items = JSON.parse(pl.items || '[]').filter((x) => x.url !== u.searchParams.get('url'));
      db.prepare('UPDATE plans SET items=? WHERE id=?').run(JSON.stringify(items), id);
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/plans/') && req.method === 'GET') {
      const id = decodeURIComponent(p.split('/')[3]);
      const pl = db.prepare('SELECT * FROM plans WHERE id=?').get(id);
      if (!pl) return json(res, 404, { error: 'not found' });
      const map = readingMap();
      const items = JSON.parse(pl.items || '[]').map((it) => ({ ...it, status: statusOf(map, it.url) }));
      return json(res, 200, { id: pl.id, title: pl.title, items });
    }
    if (p.startsWith('/api/plans/') && req.method === 'DELETE') {
      db.prepare('DELETE FROM plans WHERE id=?').run(decodeURIComponent(p.split('/')[3]));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/summary' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.url) return json(res, 400, { error: 'url required' });
      if (!okUrl(res, b.url)) return;
      return json(res, 200, await getSummary(b.url, b.mode));
    }

    if (p === '/api/reading' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.item_id) return json(res, 400, { error: 'item_id required' });
      const cur = db.prepare('SELECT * FROM reading WHERE item_id=?').get(b.item_id) || {};
      const status = b.status ?? cur.status ?? 'unread';
      const read_at = status === 'read' ? (cur.read_at || now()) : cur.read_at || null;
      db.prepare(`INSERT INTO reading (item_id,status,rating,notes,read_at,updated_at)
        VALUES (@id,@status,@rating,@notes,@read_at,@updated)
        ON CONFLICT(item_id) DO UPDATE SET status=@status, rating=@rating, notes=@notes, read_at=@read_at, updated_at=@updated`)
        .run({ id: b.item_id, status, rating: b.rating ?? cur.rating ?? 0, notes: b.notes ?? cur.notes ?? '', read_at, updated: now() });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/stats' && req.method === 'GET')
      return json(res, 200, { ...stats(), aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY || getSetting('anthropic_key')) });

    if (p === '/api/training' && req.method === 'GET') {
      const topic = listTopics().find((t) => t.id === u.searchParams.get('topic'));
      if (!topic) return json(res, 200, { items: [], note: 'Unknown topic' });
      if (!topic.products)
        return json(res, 200, { items: [], note: `${topic.label} has no training catalog entries — see the Library tab or Microsoft Learn for its modules.` });
      return json(res, 200, { items: await fetchCatalog(topic.products) });
    }

    if (p === '/api/kindle' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.url) return json(res, 400, { error: 'url required' });
      if (!okUrl(res, b.url)) return;
      const art = await getArticle(b.url);
      const epub = buildEpub({ title: art.title, contentHtml: art.content_html, url: b.url, date: art.ms_date });
      const filename = slugify(art.title) + '.epub';

      let result = { ok: true, filename };
      const method = b.method || getSetting('kindle_method', 'file');
      if (method === 'email') {
        const cfg = {
          host: getSetting('smtp_host'), port: Number(getSetting('smtp_port') || 465),
          user: getSetting('smtp_user'), pass: getSetting('smtp_pass'),
          from: getSetting('smtp_from') || getSetting('smtp_user'),
        };
        const to = getSetting('kindle_email');
        if (!cfg.host || !cfg.user || !to)
          return json(res, 400, { error: 'Email not configured — set SMTP + Kindle address in Settings.' });
        await sendToKindleEmail(cfg, { to, subject: art.title, filename, epubBuffer: epub });
        result.sentTo = to;
      } else {
        result.path = saveEpub(filename, epub);
        result.exportDir = EXPORT_DIR;
      }
      if (b.item_id) {
        db.prepare(`INSERT INTO reading (item_id,status,sent_to_kindle_at,kindle_format,updated_at)
          VALUES (?, 'unread', ?, 'epub', ?)
          ON CONFLICT(item_id) DO UPDATE SET sent_to_kindle_at=excluded.sent_to_kindle_at, kindle_format='epub', updated_at=excluded.updated_at`)
          .run(b.item_id, now(), now());
      }
      return json(res, 200, result);
    }

    if (p === '/api/settings' && req.method === 'GET') {
      const keys = ['anthropic_model', 'kindle_method', 'kindle_email', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_from', 'theme', 'auto_refresh'];
      const out = {};
      for (const k of keys) out[k] = getSetting(k, '');
      out.anthropic_key_set = Boolean(process.env.ANTHROPIC_API_KEY || getSetting('anthropic_key'));
      out.smtp_pass_set = Boolean(getSetting('smtp_pass'));
      out.export_dir = EXPORT_DIR;
      return json(res, 200, out);
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      for (const [k, v] of Object.entries(b)) {
        if (k === 'anthropic_key' && v === '') continue; // don't clear with blank
        if (k === 'smtp_pass' && v === '') continue;
        setSetting(k, v);
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    return json(res, 500, { error: String(err.message || err) });
  }
});

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.on('error', (err) => {
  const url = `http://localhost:${PORT}`;
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  Learn Hub is already running at ${url}`);
    console.log(`  Opening it in your browser — you can close this window.\n`);
    openBrowser(url);
    setTimeout(() => process.exit(0), 600);
    return;
  }
  console.error(`\n  Could not start Learn Hub: ${err.message}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Learn Hub running at ${url}`);
  console.log(`  Kindle exports: ${EXPORT_DIR}\n`);
  openBrowser(url);
});
