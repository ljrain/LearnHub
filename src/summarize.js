// Summaries: a dependency-free extractive summarizer (always available) plus an
// optional Claude-powered summarizer used when an Anthropic API key is present.
import {
  AI_DEFAULT_MODEL,
  ANTHROPIC_VERSION,
  ANTHROPIC_URL,
} from './config.js';
// Note: db is imported lazily inside the AI path so this module (and its pure
// localSummary) can be used/tested without opening the database.

const STOP = new Set(
  ('a an the and or but of to in on for with is are was were be been being this that these those ' +
    'it its as at by from your you we our can will would should could may might also more most ' +
    'use using used how what when where which who why about into than then them they their').split(' ')
);

// Extractive TL;DR: score sentences by term frequency + position, keep the top
// few in original order. Key points come from the article's H2/H3 outline.
export function localSummary(text, html = '') {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const sentences = clean
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 400);

  const freq = new Map();
  for (const w of clean.toLowerCase().match(/[a-z][a-z0-9'-]+/g) || []) {
    if (STOP.has(w) || w.length < 3) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  const scored = sentences.map((s, i) => {
    let score = 0;
    for (const w of s.toLowerCase().match(/[a-z][a-z0-9'-]+/g) || []) score += freq.get(w) || 0;
    score = score / Math.sqrt(s.length); // length-normalize
    score *= 1 + Math.max(0, (8 - i) / 16); // mild lead bias
    return { s, i, score };
  });

  const top = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);

  const headings = [...(html || '').matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    kind: 'local',
    tldr: top.join(' ') || clean.slice(0, 400),
    key_points: headings.length ? headings : top.slice(0, 5),
  };
}

// Claude summary via raw HTTP (keeps the app dependency-free). Falls back to
// the local summarizer on any error so the feature never hard-fails.
export async function aiSummary(title, text) {
  const { getSetting } = await import('./db.js');
  const apiKey = process.env.ANTHROPIC_API_KEY || getSetting('anthropic_key');
  if (!apiKey) throw new Error('no-api-key');
  const model = getSetting('anthropic_model') || AI_DEFAULT_MODEL;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      tldr: { type: 'string' },
      key_points: { type: 'array', items: { type: 'string' } },
    },
    required: ['tldr', 'key_points'],
  };

  const body = {
    model,
    max_tokens: 1024,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [
      {
        role: 'user',
        content:
          `Summarize this Microsoft Learn article for a practitioner tracking Power Platform / Copilot Studio.\n` +
          `Return a 2-3 sentence TL;DR and 3-6 concise key points (what's new or what to do).\n\n` +
          `Title: ${title}\n\nArticle:\n${(text || '').slice(0, 14000)}`,
      },
    ],
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  const parsed = JSON.parse(textBlock.text);
  return { kind: 'ai', tldr: parsed.tldr, key_points: parsed.key_points || [] };
}
