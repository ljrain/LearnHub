// Build a Microsoft Learn docset "table of contents" (the left navigation) from
// any article/landing URL in that docset. Learn exposes it as a toc.json whose
// location is given by the page's <meta name="toc_rel">. Returns a nested tree
// of { title, url, children } with absolute, anchor-stripped article URLs.
import { USER_AGENT } from './config.js';

async function fetchText(url, timeout = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function mapNode(n, base) {
  const children = (n.children || n.items || []).map((c) => mapNode(c, base)).filter(Boolean);
  const href = n.href;
  let url = null;
  if (href && !/^#/.test(href) && !/^(mailto|tel):/i.test(href)) {
    try {
      const u = new URL(href, base); // resolves relative hrefs against the toc.json location
      u.hash = '';
      if (/(^|\.)learn\.microsoft\.com$/i.test(u.hostname)) url = u.href;
      else if (/^https?:/i.test(href) === false) url = u.href; // relative → same docset host
    } catch {
      /* ignore */
    }
  }
  const title = (n.toc_title || n.name || '').trim() || '(untitled)';
  if (!url && children.length === 0) return null; // drop external/empty leaves
  return { title, url, children };
}

export async function buildTocTree(startUrl) {
  // Cache page→tocUrl and parsed toc trees so paging through a section (and
  // reopening articles in the same docset) doesn't refetch from Learn.
  let tocUrl = pageTocUrlCache.get(startUrl);
  if (!tocUrl) {
    const html = await fetchText(startUrl);
    const tocRel =
      (html.match(/name=["']toc_rel["'][^>]*content=["']([^"']+)["']/i) || [])[1] ||
      (html.match(/content=["']([^"']+)["'][^>]*name=["']toc_rel["']/i) || [])[1] ||
      'toc.json';
    try {
      tocUrl = new URL(tocRel, startUrl).href;
    } catch {
      tocUrl = new URL('toc.json', startUrl).href;
    }
    pageTocUrlCache.set(startUrl, tocUrl);
  }

  const cached = tocCache.get(tocUrl);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
    return { tocUrl, startUrl, title: cached.title, tree: cached.tree };
  }

  const json = JSON.parse(await fetchText(tocUrl));
  const { title, tree } = treeFromJson(json, tocUrl);
  tocCache.set(tocUrl, { tree, title, ts: Date.now() });
  return { tocUrl, startUrl, title, tree };
}

// Pure: turn a parsed toc.json into { title, tree } with absolute article URLs.
export function treeFromJson(json, tocUrl) {
  const tree = (json.items || []).map((n) => mapNode(n, tocUrl)).filter(Boolean);
  const title =
    (json.metadata && (json.metadata.title || json.metadata.breadcrumb_name)) ||
    (tree[0] && tree[0].title) ||
    'Section';
  return { title, tree };
}

const pageTocUrlCache = new Map();
const tocCache = new Map();
