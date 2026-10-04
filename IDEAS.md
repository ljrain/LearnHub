# 💡 Ideas & Future Enhancements

A running list of ways Learn Hub could grow more useful. Nothing here is committed work —
it's a backlog of ideas, roughly prioritized. Contributions and opinions welcome.

> Guiding principle: Learn Hub is **zero-dependency** (Node built-ins + vanilla JS, with optional
> Claude for AI). Weigh every feature against that — most of the list below can be done without
> reaching for npm packages, which is the sweet spot.

---

## 🎯 Highest-leverage (big value, fits the app's grain)

- **Full-text search across article bodies.** Today you can browse/filter but not search *inside*
  what you've read. If `node:sqlite` supports FTS5, "find everything mentioning *connection
  references*" becomes trivial. Likely the single biggest usefulness jump.
- **Resume where you left off.** Save scroll position per article (reading state is already
  tracked). Reopen and land exactly where you stopped.
- **"What changed" on updated articles.** `ms.date` is already captured. When an article you've
  read is republished, show a **Recently updated** view and use Claude to summarize *the delta*
  ("the section on agents was rewritten"). Directly serves the "stay current" pillar.
- **Ask-this-article (and ask-my-library).** A small Q&A box: "explain this page like I'm new to
  Dataverse," or across the whole library, "summarize everything I've read about Copilot Studio
  topics." The content and the Claude API are already in place.

## 📚 Turn reading into retention

- **Highlights & notes on selection** — select text → save; export all highlights per topic.
- **Auto-quizzes / flashcards** — generate comprehension questions per article or learning path
  (Claude), optionally with spaced repetition.
- **Reading goals & weekly review** — "you read 6 articles; here's a 5-line recap," generated from
  what you marked read.

## 🧭 Deeper guided learning

- **Certification tracks** — curated reading lists mapped to **PL-900 / PL-200 / PL-400 / PL-600**
  and Copilot Studio, with progress toward "exam-ready" (Microsoft publishes the skills-measured
  outlines).
- **Learning-path progress + prerequisites** — completion %, estimated time left, and "read X
  before Y" ordering hints.

## 🔔 Staying current (the updates pillar)

- **Release-wave tracking** — the Power Platform / Dynamics release planner is structured and highly
  relevant; surface upcoming features for your products.
- **Broaden sources** beyond Learn — Power Platform blog, Microsoft 365 roadmap, admin Message
  Center — using the same read/track/summarize flow.
- **Watch specific pages/sections** and notify only when *those* change.

## 🗂️ Organization & portability

- **Backup / restore & move between machines** — JSON (or the SQLite file) export/import, plus OPML
  for topics. Everything is local, so this is how you'd get it onto a second device.
- **Deliberate "download for offline"** — article bodies are already cached; make it an explicit,
  durable offline library (pairs with the service worker).

## 🛠️ Robustness & fixes

- **Extraction reliability** — it's heuristic. Add a fixture-based test suite (saved real Learn HTML
  → assert clean extraction) so template changes don't silently break reading. Handle **tables,
  images, and code blocks** well in both the reader *and* the EPUB.
- **Conditional fetches** (ETag / If-Modified-Since) — politer to Learn, faster refreshes, and
  exactly what powers reliable "updated article" detection.
- **Accessibility pass** — focus management in the reader/bottom-sheets, screen-reader labels,
  system light/dark auto.
- **Server-endpoint tests** — the current unit tests cover pure functions; the API routes are
  untested. Worth adding before the feature surface grows.
- **Secret storage** — the Anthropic key sits in plaintext SQLite (fine for a local alpha); OS
  keychain integration would harden it later.

---

## ▶️ Suggested first three

High value and in-grain:

1. **Full-text search**
2. **Resume where you left off**
3. **"What changed" updates**
