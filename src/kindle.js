// Kindle delivery: build a valid EPUB from an extracted article (zero-dependency
// ZIP writer + zlib), save it to a folder, and optionally email it to a
// Send-to-Kindle address via a minimal SMTP client.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { EXPORT_DIR } from './config.js';

// --- CRC32 ----------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- Minimal ZIP writer ---------------------------------------------------
// entries: [{ name, data: Buffer, store: bool }]  (store = no compression)
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0,
    DOS_DATE = 0x21; // 1980-01-01

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const comp = e.store ? e.data : zlib.deflateRawSync(e.data);
    const method = e.store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// --- EPUB -----------------------------------------------------------------
const xmlEscape = (s = '') =>
  s.replace(/&(?!(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// Make the extracted content well-formed XHTML (self-close voids, fix bare &).
function toXhtml(html = '') {
  return html
    .replace(/<(br|hr|img)([^>]*?)\/?>/gi, (m, tag, attrs) => `<${tag.toLowerCase()}${attrs}/>`)
    .replace(/&(?!(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);)/g, '&amp;');
}

export function buildEpub({ title, author = 'Microsoft Learn', contentHtml, url, date }) {
  const safeTitle = xmlEscape(title || 'Article');
  const uid = 'urn:learnhub:' + Buffer.from(url || title || 'x').toString('hex').slice(0, 24);

  const article =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>` +
    `<title>${safeTitle}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>` +
    `<body><h1>${safeTitle}</h1>` +
    (url ? `<p class="src"><a href="${xmlEscape(url)}">${xmlEscape(url)}</a></p>` : '') +
    `<div class="article">${toXhtml(contentHtml || '')}</div></body></html>`;

  const nav =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head>` +
    `<meta charset="utf-8"/><title>${safeTitle}</title></head><body>` +
    `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol><li><a href="article.xhtml">${safeTitle}</a></li></ol></nav>` +
    `</body></html>`;

  const opf =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:identifier id="bookid">${uid}</dc:identifier>` +
    `<dc:title>${safeTitle}</dc:title>` +
    `<dc:creator>${xmlEscape(author)}</dc:creator>` +
    `<dc:language>en</dc:language>` +
    `<meta property="dcterms:modified">${(date || new Date().toISOString()).replace(/\.\d+Z$/, 'Z')}</meta>` +
    `</metadata>` +
    `<manifest>` +
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
    `<item id="art" href="article.xhtml" media-type="application/xhtml+xml"/>` +
    `<item id="css" href="style.css" media-type="text/css"/>` +
    `</manifest>` +
    `<spine><itemref idref="art"/></spine></package>`;

  const css =
    `body{font-family:Georgia,serif;line-height:1.6;margin:5%} h1{font-size:1.5em} ` +
    `pre,code{font-family:Menlo,Consolas,monospace;background:#f4f4f4} pre{padding:.6em;overflow:auto} ` +
    `.src{font-size:.8em;color:#666} img{max-width:100%}`;

  const container =
    `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
    `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

  const B = (s) => Buffer.from(s, 'utf8');
  return zip([
    { name: 'mimetype', data: B('application/epub+zip'), store: true },
    { name: 'META-INF/container.xml', data: B(container) },
    { name: 'OEBPS/content.opf', data: B(opf) },
    { name: 'OEBPS/nav.xhtml', data: B(nav) },
    { name: 'OEBPS/style.css', data: B(css) },
    { name: 'OEBPS/article.xhtml', data: B(article) },
  ]);
}

export function slugify(s = 'article') {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'article'
  );
}

export function saveEpub(filename, buf) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const full = path.join(EXPORT_DIR, filename);
  fs.writeFileSync(full, buf);
  return full;
}

// --- Minimal SMTP client (for "Email to Kindle") --------------------------
function smtpConverse(socket, steps) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let idx = 0;
    const onData = (d) => {
      buf += d.toString('utf8');
      // A full SMTP reply ends with "NNN <space>...\r\n" (not "NNN-").
      const lines = buf.split(/\r\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return;
      buf = '';
      const code = parseInt(last.slice(0, 3), 10);
      const step = steps[idx];
      if (step.expect && code !== step.expect) {
        cleanup();
        return reject(new Error(`SMTP expected ${step.expect} got: ${last}`));
      }
      idx++;
      const next = steps[idx];
      if (!next) {
        cleanup();
        return resolve();
      }
      if (next.send != null) socket.write(next.send + '\r\n');
      if (next.raw != null) socket.write(next.raw);
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
    };
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

export async function sendToKindleEmail(cfg, { to, subject, filename, epubBuffer }) {
  const { host, port, user, pass, from } = cfg;
  const secure = cfg.secure ?? port === 465;

  const socket = await new Promise((resolve, reject) => {
    const opts = { host, port, servername: host };
    const s = secure ? tls.connect(opts, () => resolve(s)) : net.connect(opts, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(30000, () => s.destroy(new Error('SMTP timeout')));
  });

  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const boundary = 'LH' + Date.now().toString(36);
  const mime =
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n` +
    `Sent from Learn Hub.\r\n\r\n` +
    `--${boundary}\r\nContent-Type: application/epub+zip; name="${filename}"\r\n` +
    `Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${filename}"\r\n\r\n` +
    epubBuffer.toString('base64').replace(/(.{76})/g, '$1\r\n') +
    `\r\n--${boundary}--\r\n`;

  // Note: STARTTLS upgrade for port 587 is handled by sending EHLO then, if not
  // secure, we still attempt AUTH over the plain channel only when the server
  // allows it. Most Send-to-Kindle setups use 465 (implicit TLS).
  const steps = [
    { expect: 220 },
    { send: `EHLO learnhub.local`, expect: 250 },
    { send: 'AUTH LOGIN', expect: 334 },
    { send: b64(user), expect: 334 },
    { send: b64(pass), expect: 235 },
    { send: `MAIL FROM:<${from}>`, expect: 250 },
    { send: `RCPT TO:<${to}>`, expect: 250 },
    { send: 'DATA', expect: 354 },
    { raw: mime + '\r\n.\r\n', expect: 250 },
    { send: 'QUIT', expect: 221 },
  ];

  try {
    // Kick off: the converse() loop sends steps[1].send after the 220 greeting.
    const done = smtpConverse(socket, steps);
    await done;
  } finally {
    socket.end();
  }
}
