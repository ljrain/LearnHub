// Central configuration + default seed data for Learn Hub.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = path.join(ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'learnhub.db');
export const CATALOG_CACHE = path.join(DATA_DIR, 'catalog.json');

export const PORT = Number(process.env.LEARNHUB_PORT || 7777);
// Bind to localhost by default so the app isn't exposed on your network. Set
// LEARNHUB_HOST=0.0.0.0 only if you deliberately want to read from another device.
export const HOST = process.env.LEARNHUB_HOST || '127.0.0.1';

// Server-side fetches are restricted to Microsoft Learn to avoid being used as
// an open proxy (SSRF) if the app is ever exposed beyond localhost.
export function isAllowedUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && /(^|\.)microsoft\.com$/i.test(x.hostname);
  } catch {
    return false;
  }
}

// Where EPUB files are written for the "save file" Send-to-Kindle path.
export const EXPORT_DIR =
  process.env.LEARNHUB_EXPORT_DIR || path.join(os.homedir(), 'LearnHub-Kindle');

export const USER_AGENT = 'LearnHub/1.0 (+personal learning app)';
export const LOCALE = 'en-us';

// Microsoft Learn endpoints (no auth required).
export const RSS_URL = (query) =>
  `https://learn.microsoft.com/api/search/rss?search=${encodeURIComponent(query)}&locale=${LOCALE}`;
export const CATALOG_URL = `https://learn.microsoft.com/api/catalog/?locale=${LOCALE}`;

// Topics seeded on first run. `query` drives the RSS article feed; `products`
// (comma-separated Catalog product ids) drives the Training tab. Copilot Studio
// is not in the training catalog, so it has no products and falls back to RSS.
export const DEFAULT_TOPICS = [
  { id: 'copilot-studio', label: 'Copilot Studio', query: 'Copilot Studio agents', products: '' },
  { id: 'power-apps', label: 'Power Apps', query: 'Power Apps', products: 'power-apps' },
  { id: 'power-automate', label: 'Power Automate', query: 'Power Automate', products: 'power-automate' },
  {
    id: 'power-platform',
    label: 'Power Platform (rest)',
    query: 'Power Platform administration governance ALM',
    products: 'power-platform,power-pages,dataverse,ai-builder',
  },
];

// AI summaries. API key preferred from env; Settings can override (stored in DB).
export const AI_DEFAULT_MODEL = 'claude-opus-4-8';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
