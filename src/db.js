// SQLite persistence (built-in node:sqlite). Stores topics, items, reading
// state, cached article content, cached summaries, and app settings.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DB_PATH, DATA_DIR, DEFAULT_TOPICS, SYNC_SAFE_DB } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
// WAL is fastest for local use, but its -wal/-shm side-files make cloud-folder
// sync unsafe. When syncing (LEARNHUB_DATA_DIR set) use a single-file rollback
// journal so the one .db file is always complete between writes.
db.exec(SYNC_SAFE_DB ? 'PRAGMA journal_mode = DELETE;' : 'PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  query TEXT NOT NULL,
  products TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  topic_id TEXT,
  title TEXT,
  url TEXT,
  description TEXT,
  source TEXT,            -- 'rss' | 'catalog'
  published TEXT,
  last_modified TEXT,
  first_seen_at TEXT,
  extra TEXT              -- JSON blob (duration, level, popularity, ...)
);
CREATE INDEX IF NOT EXISTS idx_items_topic ON items(topic_id);
CREATE TABLE IF NOT EXISTS reading (
  item_id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'unread',   -- unread | reading | read
  rating INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  read_at TEXT,
  sent_to_kindle_at TEXT,
  kindle_format TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS summaries (
  url TEXT,
  kind TEXT,              -- 'local' | 'ai'
  tldr TEXT,
  key_points TEXT,        -- JSON array
  created_at TEXT,
  PRIMARY KEY (url, kind)
);
CREATE TABLE IF NOT EXISTS article_cache (
  url TEXT PRIMARY KEY,
  title TEXT,
  content_html TEXT,
  text TEXT,
  ms_date TEXT,
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  title TEXT,
  toc_url TEXT,
  start_url TEXT,
  tree TEXT,            -- JSON tree of { title, url, children }
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  title TEXT,
  items TEXT,           -- JSON array of { url, title }
  created_at TEXT
);
`);

// Seed default topics once.
const topicCount = db.prepare('SELECT COUNT(*) AS n FROM topics').get().n;
if (topicCount === 0) {
  const ins = db.prepare(
    'INSERT INTO topics (id, label, query, products, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  );
  const now = new Date().toISOString();
  for (const t of DEFAULT_TOPICS) ins.run(t.id, t.label, t.query, t.products, now);
}

export const itemId = (url) => createHash('sha1').update(url).digest('hex').slice(0, 16);

export function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Settings are stored in meta under a "setting:" prefix.
export function getSetting(key, fallback = '') {
  return getMeta('setting:' + key, fallback);
}
export function setSetting(key, value) {
  setMeta('setting:' + key, value);
}
