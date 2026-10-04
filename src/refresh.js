// Shared refresh logic used by both the HTTP server (/api/refresh) and the
// scheduled background job (notify-refresh.js). Pulls RSS articles + training
// catalog entries for a topic, upserts them, and reports which were brand new.
import { db, itemId, setMeta } from './db.js';
import { fetchRss, fetchCatalog } from './learn.js';

const now = () => new Date().toISOString();

const UPSERT = `
INSERT INTO items (id, topic_id, title, url, description, source, published, last_modified, first_seen_at, extra)
VALUES (@id, @topic_id, @title, @url, @description, @source, @published, @last_modified, @first_seen_at, @extra)
ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description,
  published=excluded.published, last_modified=excluded.last_modified, extra=excluded.extra`;

export async function refreshTopic(topic) {
  // Topics with no query and no products (e.g. the "Saved / linked" bucket) are
  // not fetched from Microsoft Learn — they only hold articles opened via links.
  if (!topic.query && !topic.products) return { added: 0, newItems: [], error: false };
  const newItems = [];
  let error = false;
  const exists = db.prepare('SELECT first_seen_at FROM items WHERE id = ?');
  const upsert = db.prepare(UPSERT);

  const put = (a, source, extra) => {
    const id = itemId(a.url);
    const row = exists.get(id);
    if (!row) newItems.push({ title: a.title, url: a.url, topic_id: topic.id });
    upsert.run({
      id,
      topic_id: topic.id,
      title: a.title,
      url: a.url,
      description: a.description || '',
      source,
      published: a.published || '',
      last_modified: a.last_modified || '',
      first_seen_at: row?.first_seen_at || now(),
      extra: JSON.stringify(extra || {}),
    });
  };

  const rss = await fetchRss(topic.query).catch(() => { error = true; return []; });
  for (const a of rss) put(a, 'rss', {});

  if (topic.products) {
    const cat = await fetchCatalog(topic.products).catch(() => { error = true; return []; });
    for (const m of cat)
      put(
        { title: m.title, url: m.url, description: m.description, last_modified: m.last_modified },
        'catalog',
        { type: m.type, duration: m.duration, level: m.level, children: m.children }
      );
  }

  setMeta('lastcheck:' + topic.id, now());
  return { added: newItems.length, newItems, error };
}

export async function refreshAll(onlyEnabled = true) {
  const topics = db
    .prepare(`SELECT * FROM topics ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY rowid`)
    .all();
  let added = 0, errors = 0;
  const newItems = [];
  for (const t of topics) {
    const r = await refreshTopic(t);
    added += r.added;
    if (r.error) errors++;
    newItems.push(...r.newItems);
  }
  return { added, newItems, errors };
}
