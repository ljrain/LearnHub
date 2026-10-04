// Unit tests for Learn Hub's pure logic. Run with: npm test  (node --test)
// These cover parsing, extraction, security, summaries and EPUB packing without
// any network or database.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedUrl } from '../src/config.js';
import { parseRss, extractFromHtml, decodeEntities } from '../src/learn.js';
import { treeFromJson } from '../src/toc.js';
import { localSummary } from '../src/summarize.js';
import { buildEpub, slugify } from '../src/kindle.js';

test('isAllowedUrl: only https Microsoft Learn hosts', () => {
  assert.equal(isAllowedUrl('https://learn.microsoft.com/en-us/x'), true);
  assert.equal(isAllowedUrl('https://sub.microsoft.com/y'), true);
  assert.equal(isAllowedUrl('http://learn.microsoft.com/x'), false, 'http rejected');
  assert.equal(isAllowedUrl('https://evil.com/x'), false);
  assert.equal(isAllowedUrl('https://notmicrosoft.com/x'), false, 'suffix trick');
  assert.equal(isAllowedUrl('https://learn.microsoft.com.evil.com/x'), false, 'subdomain trick');
  assert.equal(isAllowedUrl('not a url'), false);
});

test('decodeEntities: named, numeric and CDATA', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65;&#x42;'), 'a & b <c> AB');
  assert.equal(decodeEntities('<![CDATA[hi & bye]]>'), 'hi & bye');
});

test('parseRss: items parsed, landing page + dupes dropped', () => {
  const xml = `<rss><channel>
    <item><title>Official Microsoft Power Platform documentation</title><link>https://learn.microsoft.com/x</link></item>
    <item><title>Real Article</title><link>https://learn.microsoft.com/en-us/a</link><description>&lt;p&gt;Hello&lt;/p&gt;</description><pubDate>Mon, 01 Jan 2026</pubDate></item>
    <item><title>Dup</title><link>https://learn.microsoft.com/en-us/a</link></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Real Article');
  assert.equal(items[0].url, 'https://learn.microsoft.com/en-us/a');
  assert.match(items[0].description, /Hello/);
});

test('extractFromHtml: keeps article, strips scripts, reads ms.date', () => {
  const html = `<html><head><title>My Title | Microsoft Learn</title>
    <meta name="ms.date" content="2026-01-15T00:00:00Z"></head>
    <body><main><h1>My Title</h1><p>Hello body content here.</p>
    <script>alert(1)</script></main></body></html>`;
  const { title, content_html, text, ms_date } = extractFromHtml(html, 'https://learn.microsoft.com/en-us/x');
  assert.equal(title, 'My Title');
  assert.equal(ms_date, '2026-01-15T00:00:00Z');
  assert.match(content_html, /<h1>My Title<\/h1>/);
  assert.match(content_html, /<p>Hello body content here\.<\/p>/);
  assert.doesNotMatch(content_html, /script|alert/i, 'scripts removed');
  assert.match(text, /Hello body content/);
});

test('extractFromHtml: Learn callouts become styled boxes', () => {
  const html = `<html><head><title>T</title></head><body><main><h1>T</h1>
    <p>Intro.</p>
    <div class="NOTE"><p>Note</p><p>Be careful here.</p></div>
    <div class="WARNING"><p>Warning</p><p>Danger ahead.</p></div>
    </main></body></html>`;
  const { content_html } = extractFromHtml(html, 'https://learn.microsoft.com/en-us/x');
  assert.match(content_html, /<div class="callout callout-note">/);
  assert.match(content_html, /<div class="callout callout-warning">/);
  assert.match(content_html, /Be careful here/);
  assert.doesNotMatch(content_html, /xcallout|class="NOTE"/);
});

test('treeFromJson: resolves urls, drops external, nests groups', () => {
  const json = {
    metadata: { title: 'Guidance' },
    items: [
      { toc_title: 'Root', href: './' },
      { toc_title: 'Group', children: [
        { toc_title: 'Article A', href: 'article-a' },
        { toc_title: 'External', href: 'https://example.com/x' },
      ] },
    ],
  };
  const { title, tree } = treeFromJson(json, 'https://learn.microsoft.com/en-us/ds/toc.json');
  assert.equal(title, 'Guidance');
  assert.equal(tree.length, 2);
  assert.equal(tree[0].url, 'https://learn.microsoft.com/en-us/ds/');
  const group = tree[1];
  assert.equal(group.url, null, 'group header has no url');
  assert.equal(group.children.length, 1, 'external child dropped');
  assert.equal(group.children[0].url, 'https://learn.microsoft.com/en-us/ds/article-a');
});

test('localSummary: produces a tldr and key points', () => {
  const text = 'Copilot Studio is a low-code studio for building agents. ' +
    'Agents extend Copilot with organizational knowledge. ' +
    'You can connect agents to your data and publish them to channels. ' +
    'This overview explains the core concepts of building agents.';
  const html = '<h2>Build agents</h2><h3>Publish</h3>';
  const s = localSummary(text, html);
  assert.equal(s.kind, 'local');
  assert.ok(s.tldr.length > 0);
  assert.ok(Array.isArray(s.key_points) && s.key_points.length >= 1);
  assert.deepEqual(s.key_points.slice(0, 2), ['Build agents', 'Publish']);
});

test('slugify: filesystem-safe names', () => {
  assert.equal(slugify('Hello, World! / Test'), 'hello-world-test');
  assert.equal(slugify(''), 'article');
});

test('buildEpub: valid zip with stored mimetype first', () => {
  const buf = buildEpub({ title: 'T', contentHtml: '<h1>T</h1><p>x & y</p>', url: 'https://learn.microsoft.com/x' });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.slice(0, 4).toString('hex'), '504b0304', 'zip local header signature');
  // First entry must be an uncompressed "mimetype" file (EPUB requirement).
  assert.equal(buf.readUInt16LE(8), 0, 'first entry stored (method 0)');
  const nameLen = buf.readUInt16LE(26);
  assert.equal(buf.slice(30, 30 + nameLen).toString(), 'mimetype');
  assert.ok(buf.includes(Buffer.from('application/epub+zip')));
  assert.ok(buf.includes(Buffer.from('OEBPS/content.opf')));
});
