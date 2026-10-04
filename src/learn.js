// Microsoft Learn data sources: RSS article feed, training Catalog API, and
// article HTML fetch + readable-content extraction. No external dependencies.
import fs from 'node:fs';
import {
  RSS_URL,
  CATALOG_URL,
  CATALOG_CACHE,
  USER_AGENT,
} from './config.js';

async function fetchText(url, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xml,*/*' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// --- Entity / tag helpers -------------------------------------------------

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return NAMED[e] ?? m;
    });
}
const stripTags = (s = '') => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// --- RSS feed -------------------------------------------------------------

export async function fetchRss(query) {
  return parseRss(await fetchText(RSS_URL(query)));
}

// Pure: parse a Microsoft Learn search RSS feed into article items.
export function parseRss(xml) {
  const items = [];
  const seen = new Set();
  const blocks = xml.split(/<item>/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/<\/item>/i)[0];
    const pick = (tag) => {
      const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? decodeEntities(m[1]).trim() : '';
    };
    const title = pick('title');
    const link = pick('link');
    if (!link || !title) continue;
    // Drop the generic documentation landing page and dupes.
    if (/Official Microsoft Power Platform documentation/i.test(title)) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    items.push({
      title,
      url: link,
      description: stripTags(pick('description')).slice(0, 400),
      published: pick('pubDate'),
    });
  }
  return items;
}

// --- Training catalog -----------------------------------------------------

let catalogMem = null;
async function loadCatalog() {
  // Cache the ~6MB catalog on disk for 24h.
  try {
    const stat = fs.statSync(CATALOG_CACHE);
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
      if (!catalogMem) catalogMem = JSON.parse(fs.readFileSync(CATALOG_CACHE, 'utf8'));
      return catalogMem;
    }
  } catch {
    /* no cache yet */
  }
  const json = await fetchText(CATALOG_URL, { timeout: 45000 });
  fs.writeFileSync(CATALOG_CACHE, json);
  catalogMem = JSON.parse(json);
  return catalogMem;
}

export async function fetchCatalog(productsCsv) {
  const products = (productsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (products.length === 0) return [];
  const want = new Set(products);
  const cat = await loadCatalog();
  const out = [];
  const take = (arr, type) => {
    for (const m of arr || []) {
      if (!(m.products || []).some((p) => want.has(p))) continue;
      out.push({
        type,
        uid: m.uid,
        title: m.title,
        url: m.url,
        description: (m.summary || '').slice(0, 300),
        duration: m.duration_in_minutes || null,
        level: (m.levels || [])[0] || '',
        popularity: m.popularity || 0,
        last_modified: m.last_modified || '',
        children: m.number_of_children || null,
      });
    }
  };
  take(cat.learningPaths, 'learningPath');
  take(cat.modules, 'module');
  out.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  return out.slice(0, 120);
}

const cleanUrl = (u) => (u || '').split('?')[0];
const LEVELS = ['beginner', 'intermediate', 'advanced'];

// Official Microsoft Learning Paths for the given products, each with its
// ordered sequence of modules resolved to title + URL. This is the "guided,
// structured by topic & skill level" data.
export async function fetchLearningPaths(productsCsv) {
  const products = (productsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (products.length === 0) return [];
  const want = new Set(products);
  const cat = await loadCatalog();
  const modByUid = new Map((cat.modules || []).map((m) => [m.uid, m]));
  const out = [];
  for (const p of cat.learningPaths || []) {
    if (!(p.products || []).some((x) => want.has(x))) continue;
    const modules = (p.modules || [])
      .map((uid) => modByUid.get(uid))
      .filter(Boolean)
      .map((m) => ({ title: m.title, url: cleanUrl(m.url), duration: m.duration_in_minutes || 0, units: m.number_of_children || 0 }));
    out.push({
      uid: p.uid,
      title: p.title,
      summary: (p.summary || '').slice(0, 260),
      level: (p.levels || [])[0] || '',
      roles: p.roles || [],
      products: p.products || [],
      duration: p.duration_in_minutes || 0,
      url: cleanUrl(p.url),
      popularity: p.popularity || 0,
      modules,
    });
  }
  out.sort((a, b) => b.popularity - a.popularity);
  return out;
}

// A product × skill-level matrix of how many learning paths relate to each —
// the "relationship / topic map".
export async function catalogMap(productsCsv) {
  const cat = await loadCatalog();
  const products = (productsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  const want = products.length ? new Set(products) : null;
  const grid = {};
  for (const p of cat.learningPaths || []) {
    const lv = (p.levels || [])[0] || 'other';
    for (const pr of p.products || []) {
      if (want && !want.has(pr)) continue;
      grid[pr] = grid[pr] || { beginner: 0, intermediate: 0, advanced: 0, other: 0 };
      grid[pr][lv] = (grid[pr][lv] || 0) + 1;
    }
  }
  return { levels: LEVELS, grid };
}

// --- Article extraction ---------------------------------------------------

// Pull a readable subset of a Learn article page. Heuristic: isolate <main>,
// take from the first <h1> onward, strip scripts/nav/aside chrome, keep a
// whitelist of structural tags, and absolutize links/images. "Open on Learn"
// is always available as the guaranteed fallback.
export async function extractArticle(url) {
  return extractFromHtml(await fetchText(url), url);
}

// Pure: extract a readable subset of a Learn article page from its HTML.
export function extractFromHtml(html, url) {
  const meta = (name) => {
    const m = html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'));
    return m ? decodeEntities(m[1]) : '';
  };
  const titleTag = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  const title = decodeEntities(titleTag).replace(/\s*\|\s*Microsoft Learn\s*$/i, '').trim();
  const msDate = meta('ms.date') || meta('updated_at');

  let main = (html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || [])[1] || html;
  const h1 = main.search(/<h1[\s>]/i);
  if (h1 > 0) main = main.slice(h1);

  let body = main
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Trim the trailing "Was this page helpful?" / feedback footer.
  const foot = body.search(/Was this page helpful|<h2[^>]*>\s*Feedback/i);
  if (foot > 500) body = body.slice(0, foot).replace(/<[^>]*$/, '');

  // Drop the leading in-page table-of-contents / feedback chrome that sits
  // between the H1 and the first real content block.
  body = body.replace(/(<\/h1>)([\s\S]*?)(<(?:h2|p)\b)/i, (m, a, mid, c) =>
    /In this article|Summarize this article|Feedback/i.test(mid) ? a + c : m
  );

  // Preserve Microsoft Learn callouts (Note / Tip / Important / Warning /
  // Caution) as styled boxes. They render as <div class="NOTE">…</div>; rename
  // to a token element our sanitizer keeps (plain <div> would be stripped).
  body = body.replace(
    /<div class="(NOTE|TIP|IMPORTANT|WARNING|CAUTION)">([\s\S]*?)<\/div>/gi,
    (m, type, inner) => `<xcallout data-type="${type.toLowerCase()}">${inner}</xcallout>`
  );

  const clean = sanitize(body, url);
  const text = stripTags(clean);
  return { title, content_html: clean, text, ms_date: msDate };
}

// Collect the in-content Microsoft Learn article links from extracted HTML, in
// reading order, de-duplicated — used to "build a guide" from an overview/TOC page.
export function linksFromContent(contentHtml) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(contentHtml || ''))) {
    let url = m[1];
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!/^https:\/\/learn\.microsoft\.com\//i.test(url)) continue;
    if (/\.(png|jpe?g|gif|svg|webp|pdf|zip)(\?|#|$)/i.test(url)) continue;
    url = url.split('#')[0].split('?')[0];
    if (!title || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: title.slice(0, 200) });
  }
  return out;
}

const ALLOWED = new Set([
  'h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote',
  'strong', 'em', 'b', 'i', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'br', 'hr',
]);

function sanitize(htmlFragment, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    base = null;
  }
  // Strip disallowed tags (keep their inner text), neutralize event handlers,
  // and rewrite relative href/src to absolute.
  return htmlFragment
    .replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (full, slash, tag, attrs) => {
      const name = tag.toLowerCase();
      // Callout boxes: emit a themed <div class="callout callout-type">.
      if (name === 'xcallout') {
        if (slash) return '</div>';
        const t = (attrs.match(/data-type="([a-z]+)"/i) || [])[1] || 'note';
        const safe = ['note', 'tip', 'important', 'warning', 'caution'].includes(t) ? t : 'note';
        return `<div class="callout callout-${safe}">`;
      }
      if (!ALLOWED.has(name)) return '';
      if (slash) return `</${name}>`;
      let kept = '';
      if (name === 'a') {
        const href = (attrs.match(/href=["']([^"']*)["']/i) || [])[1];
        const abs = absolutize(href, base);
        if (abs) kept = ` href="${abs}" target="_blank" rel="noopener"`;
      } else if (name === 'img') {
        const src = (attrs.match(/src=["']([^"']*)["']/i) || [])[1];
        const abs = absolutize(src, base);
        const alt = (attrs.match(/alt=["']([^"']*)["']/i) || [])[1] || '';
        return abs ? `<img src="${abs}" alt="${alt.replace(/"/g, '')}" loading="lazy">` : '';
      }
      return `<${name}${kept}>`;
    })
    .replace(/\s+\n/g, '\n')
    .trim();
}

function absolutize(url, base) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (/^(javascript|data):/i.test(url)) return '';
  if (!base) return '';
  try {
    return new URL(url, base).href;
  } catch {
    return '';
  }
}
