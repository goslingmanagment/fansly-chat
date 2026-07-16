# Changelog Web-Register — Parallel-Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Rev 1** — initial plan from spec §11 + a full artifact audit: `changelog.html` (54 release cards, Inter font, own blue-bearing palette, no dates, no anchors), `install.html` (the family web-register donor: `--paper/#f6f2ea … --clay/#c4704b`, Fraunces + Hanken Grotesk, goose mascot), `scripts/deploy.sh` (`stamp_changelog_page_version` — two byte-exact slots) **and** `scripts/deploy-pages.sh` (the standalone page-only deploy — a second stamper over the same two slots), `tests/release-pages.test.ts` (slot-cardinality pins), and `CHANGELOG.md` (62 versions vs the page's 54 — the eight 1.2.x deliberately absent).

**Goal:** Rebuild `changelog.html` as the family web register — install.html's `--paper/--clay` palette, Fraunces serif + Hanken Grotesk, the goose mascot, a `prefers-color-scheme` dark swap — with per-release `id="v1-9-6"` anchors, dates for the tagged 1.7.0+ releases, serif release summaries as the loudest text of each card, semantic groups recolored to Исправлено (green) / Изменено (neutral) / Новое (clay) with the old blue gone, «Технически» groups collapsed into `<details>`, and every release older than the latest three collapsed to its summary. **All existing release texts transfer verbatim (pure re-markup, proven by a diff step).** The two deploy stamp slots stay byte-exact so both `deploy.sh` and `deploy-pages.sh` keep stamping with zero script edits.

**Architecture:** The rebuild is **atomic** — the new head/CSS and the 54 re-marked cards ship as ONE green commit (`changelog.html` + the extended `tests/release-pages.test.ts`), because the new invariants (palette, anchors, dates, collapse) are cross-cutting and there is no partial-green intermediate. The body transform is **not** a hand-edit of 1900 lines (error-prone) — it is a small, throwaway Node build script in the scratchpad that (1) reads the current `changelog.html`, (2) applies four pure per-card operations (anchor id, date span, «Технически»→`<details>` tag-swap, collapse-wrapper insertion) that touch **zero** card text, (3) re-assembles the document from family head/nav/hero/footer templates that carry the exact stamp slots, and (4) runs a **text-preservation assertion** (every `<li>` and every `release-summary` inner-HTML identical old→new) that aborts the write on any drift. The scratchpad tooling is not committed; only `changelog.html`, the test, and the decision entry are.

**Tech Stack:** Static HTML + inline `<style>` (no build step for the page — it is served as-is). Throwaway ESM build scripts run under the repo's Node (`node --input-type=module` style, `node:fs` only — the same shim surface the deploy scripts use). Tests: vitest, `readFileSync` + string/regex scanning (the existing `release-pages.test.ts` style — no jsdom, no `any`). Fonts: Google Fonts CDN via `<link>`, exactly like `install.html` (see Global Constraints — the local-font mandate is scoped to extension pages only).

**Spec:** `docs/superpowers/specs/2026-07-16-options-redesign-design.md` §11 (Changelog.html), with §2.4 (web-page dark theme), §2.5 (font scoping), and §13.4 / §13 ordering.

## Global Constraints

- Execution happens in a fresh toolkit worktree: `~/code/agentic-control-plane/bin/agent task chatgoose changelog-web-register` before the first edit (repo is in repos.yaml; the canonical checkout is owner-only and shared — never edit it directly).
- `pnpm check` (typecheck + lint + gates + tests + build) green before EVERY commit; `tests/release-pages.test.ts` is part of that suite. The page rebuild lands as a SINGLE commit (`changelog.html` + the extended test) — do not commit a red suite by splitting the test from the page it pins.
- **Byte-exact stamp slots (the deploy invariant):** the committed page MUST contain, matchable exactly once, `<span class="nav-version">v1.7.1</span>` and `<p>v1.7.1 &middot; Gosling Agency &middot; Kernel-served AI</p>`. These two slots are stamped by BOTH `scripts/deploy.sh` (`stamp_changelog_page_version`, regex `/(<span class="nav-version">)v[^<]+(<\/span>)/` and `/(<p>)v[^<]+( &middot; Gosling Agency &middot; Kernel-served AI<\/p>)/`) AND `scripts/deploy-pages.sh` (generic `stamp_version`, regex `(<span class="nav-version">v)[^<]+(</span>)` and `(<p>v)[^<]+( &middot; Gosling Agency &middot; Kernel-served AI</p>)`). Both forms target the same markup; keep the footer `<p>` **attribute-less** and the `v` immediately after `<p>` / inside the span. **Neither deploy script may be edited.**
- **No text rewrites:** every release summary and every changes-list `<li>` transfers verbatim. The only text the transform ADDS is date spans, the «Подробнее» collapse toggle, and anchor ids/`<details>` wrappers (attributes + structure, never prose). Task 3's diff-verify proves it and aborts on any drift.
- **Canon (spec §11):** `CHANGELOG.md` stays the full 62-version archive; the page keeps its 54 cards. The eight 1.2.x releases the page never showed (1.2.14, 1.2.13, 1.2.12, 1.2.11, 1.2.10, 1.2.9, 1.2.6, 1.2.5) stay absent — do NOT backfill. The page = "what users saw"; the markdown = full history. This divergence is recorded, deliberate.
- **Dates policy (spec §11):** format `DD.MM.YYYY`, only for 1.7.0+ (the 16 tagged releases = the top 16 cards, 1.7.0 … 1.9.9); every older card stays dateless. The three earliest tags (v1.7.0, v1.7.1, v1.8.0) are retro-tags with approximate dates — stamp them anyway; more honest than an invented backfill for the pre-tag era. Future releases stamp their own date on release.
- **Fonts:** the web register keeps the Google Fonts CDN (Fraunces + Hanken Grotesk) exactly as `install.html` does. The local-woff2 mandate (spec §2.5) is scoped to EXTENSION pages (options/popup/debug-prompt) — `changelog.html`/`install.html`/`guide.html` are hosted web pages and are out of that scope. Do NOT bundle fonts here.
- **Track independence:** no `src/` changes, no storage schema, no `manifest.json`/`package.json` bump, no vendored-SDK touch. Pure web page + test + decision doc.
- **Ordering (spec §13):** the rebuilt anchored `changelog.html` must be DEPLOYED before (or together with) the P2 options release that adds the «Версия → Changelog» button linking `changelog.html#v<major>-<minor>-<patch>` — a link must not ship before its target exists. A standalone page-only deploy IS available: `scripts/deploy-pages.sh` stamps + scp's `changelog.html` (with `install.html`/`guide.html`/`mascot.png`) without rebuilding or re-signing the extension, so the owner can push the anchors live ahead of the P2 release. Task 6 records this.

## File Structure

```
changelog.html                    (rebuild in place: family <head>/CSS + prefers-color-scheme dark;
                                    body cards re-marked — anchors, dates, collapse, «Технически» <details>;
                                    nav/hero/footer restyled to family tokens, stamp slots byte-exact)
tests/release-pages.test.ts       (extend: a new 'changelog web register' describe block — anchors,
                                    dates, version order, collapse, tech-details, palette/no-blue,
                                    dark theme, serif summary; plus a dual-deploy stamp dry-run)
docs/decisions.md                 (append the changelog-register decision entry + summary-table row)

<scratchpad>/changelog/shell.mjs  (NOT committed — family <head>/CSS + NAV/HERO/FOOTER templates,
                                    the two byte-exact stamp slots live here)
<scratchpad>/changelog/build.mjs  (NOT committed — reads changelog.html, transforms the 54 cards,
                                    assembles from shell templates, runs the text-preservation
                                    assertion, writes changelog.html)
```

`<scratchpad>` = the session scratchpad directory (outside the repo; the two `.mjs` files are throwaway build tooling, never staged). All CSS is inlined into `changelog.html`'s `<style>` — the served page stays self-contained, exactly as today.

---

### Task 1: Derive the release-date map from Git tags

The 16 tags (v1.7.0 … v1.9.9) are the only trustworthy dates; the map feeds Task 3's `build.mjs`. This is the one non-deterministic, tag-dependent step — isolate it here so the transform script stays a pure function of its inputs.

**Files:** none committed (produces a value pasted into Task 3's script).

- [ ] **Step 1: List the tags with dates.**

Run:
```bash
git for-each-ref --sort=-creatordate --format='%(refname:short) %(creatordate:format:%d.%m.%Y)' 'refs/tags/v*'
```
Expected: exactly **16** lines, newest first, e.g.
```
v1.9.9 07.07.2026
v1.9.8 06.07.2026
v1.9.7 04.07.2026
v1.9.6 03.07.2026
v1.9.5 02.07.2026
v1.9.4 01.07.2026
v1.9.3 30.06.2026
v1.9.2 29.06.2026
v1.9.1 28.06.2026
v1.9.0 27.06.2026
v1.8.3 24.06.2026
v1.8.2 22.06.2026
v1.8.1 20.06.2026
v1.8.0 18.06.2026
v1.7.1 15.06.2026
v1.7.0 12.06.2026
```
(These exact dates are illustrative — use the real command output. If the count is not 16 or the earliest tag is not `v1.7.0`, STOP and reconcile with the owner: the dates policy assumes exactly these tags.)

- [ ] **Step 2: Record the map** as the `RELEASE_DATES` constant for Task 3 (strip the leading `v`, `DD.MM.YYYY` values verbatim from the command):

```js
// Regenerated from: git for-each-ref --sort=-creatordate \
//   --format='%(refname:short) %(creatordate:format:%d.%m.%Y)' 'refs/tags/v*'
// Only 1.7.0+ is tagged; v1.7.0/v1.7.1/v1.8.0 are retro-tags (approximate).
const RELEASE_DATES = {
  '1.9.9': '07.07.2026', '1.9.8': '06.07.2026', '1.9.7': '04.07.2026',
  '1.9.6': '03.07.2026', '1.9.5': '02.07.2026', '1.9.4': '01.07.2026',
  '1.9.3': '30.06.2026', '1.9.2': '29.06.2026', '1.9.1': '28.06.2026',
  '1.9.0': '27.06.2026', '1.8.3': '24.06.2026', '1.8.2': '22.06.2026',
  '1.8.1': '20.06.2026', '1.8.0': '18.06.2026', '1.7.1': '15.06.2026',
  '1.7.0': '12.06.2026',
};
```

No commit — this value is consumed by Task 3.

---

### Task 2: Author the family shell — `<head>`/CSS + nav/hero/footer templates

Produces `<scratchpad>/changelog/shell.mjs` exporting four exact strings the Task 3 assembler concatenates. This is the "new page skeleton/CSS in full" deliverable: adopt install.html's `--paper/--clay` palette + Fraunces/Hanken/mono, add the `prefers-color-scheme` dark swap (pure token override — no per-component dark rules), recolor the semantic groups (blue gone), make the summary serif-loud, and add anchor/date/collapse/milestone rules. The nav/hero/footer keep today's structure (mascot preserved) restyled by CSS — **the two stamp slots are written byte-exact here.**

**Files:**
- Create: `<scratchpad>/changelog/shell.mjs` (not committed)

**Interfaces:**
- Produces (named exports): `HEAD` (`<!DOCTYPE>` … `<style>…</style></head><body>`), `NAV`, `HERO`, `FOOTER` (`<footer>…</footer></body></html>`).

- [ ] **Step 1: Write `shell.mjs`** (complete):

```js
// Throwaway build input for changelog.html — NOT committed.
export const HEAD = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChatGoose — Что нового</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --paper: #f6f2ea; --paper-2: #fdfbf6; --paper-3: #f1ebe0;
      --ink: #2a2016; --ink-soft: #6c5d4d; --ink-faint: #a3947f;
      --clay: #c4704b; --clay-deep: #a8543a;
      --clay-tint: rgba(196, 112, 75, 0.10); --clay-line: rgba(196, 112, 75, 0.22);
      --green: #2f7d5b;
      --line: rgba(42, 32, 22, 0.10); --line-soft: rgba(42, 32, 22, 0.06);
      --serif: "Fraunces", Georgia, "Times New Roman", serif;
      --sans: "Hanken Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
      --shadow: 0 1px 2px rgba(42, 32, 22, 0.04), 0 8px 28px rgba(42, 32, 22, 0.06);
    }

    /* Dark theme — a pure token swap (spec §2.4); no per-component dark rules. */
    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #17130e; --paper-2: #201a13; --paper-3: #2a2219;
        --ink: #ece3d5; --ink-soft: #b8a894; --ink-faint: #8a7c6a;
        --clay: #d98a64; --clay-deep: #e6a07c;
        --clay-tint: rgba(217, 138, 100, 0.14); --clay-line: rgba(217, 138, 100, 0.30);
        --green: #5fb98a;
        --line: rgba(236, 227, 213, 0.12); --line-soft: rgba(236, 227, 213, 0.07);
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.30), 0 8px 28px rgba(0, 0, 0, 0.40);
      }
    }

    body {
      background: var(--paper); color: var(--ink);
      font-family: var(--sans); font-size: 15px; line-height: 1.7;
      -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    }
    a { color: inherit; text-decoration: none; }

    /* ── Nav ── */
    .nav {
      position: sticky; top: 0; z-index: 100;
      background: color-mix(in srgb, var(--paper) 85%, transparent);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--line); padding: 0 24px;
    }
    .nav-inner { max-width: 720px; margin: 0 auto; display: flex; align-items: center; height: 56px; gap: 16px; }
    .nav-brand { display: flex; align-items: center; gap: 10px; color: var(--ink); flex-shrink: 0; }
    .nav-brand img { width: 32px; height: 32px; border-radius: 50%; }
    .nav-brand span { font-family: var(--serif); font-weight: 600; font-size: 17px; letter-spacing: -0.01em; }
    .nav-actions { display: flex; align-items: center; gap: 10px; margin-left: auto; flex-shrink: 0; }
    .nav-link { font-size: 13px; font-weight: 500; color: var(--ink-soft); padding: 5px 12px; border-radius: 999px; transition: all 0.15s; }
    .nav-link:hover { color: var(--ink); background: var(--clay-tint); }
    .nav-version { font-family: var(--mono); font-size: 12px; color: var(--clay-deep); background: var(--clay-tint); border: 1px solid var(--clay-line); padding: 3px 9px; border-radius: 999px; flex-shrink: 0; }

    /* ── Hero ── */
    .hero { max-width: 720px; margin: 0 auto; padding: 64px 24px 48px; text-align: center; }
    .hero h1 { font-family: var(--serif); font-size: 40px; font-weight: 600; letter-spacing: -0.02em; }
    .hero-sub { font-size: 16px; color: var(--ink-soft); margin-top: 8px; }

    /* ── Timeline ── */
    .timeline { max-width: 720px; margin: 0 auto; padding: 0 24px 80px; }
    .release { position: relative; padding-left: 32px; padding-bottom: 48px; scroll-margin-top: 76px; }
    .release:last-child { padding-bottom: 0; }
    .release::before { content: ''; position: absolute; left: 7px; top: 10px; bottom: 0; width: 2px; background: var(--line); }
    .release:last-child::before { display: none; }
    .release::after { content: ''; position: absolute; left: 1px; top: 6px; width: 14px; height: 14px; border-radius: 50%; background: var(--paper); border: 2.5px solid var(--clay-line); }
    .release:first-child::after { background: var(--clay); border-color: var(--clay); }

    .release-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .release-version { font-family: var(--mono); font-size: 20px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); }
    .release-date { font-family: var(--mono); font-size: 12px; font-weight: 500; color: var(--ink-faint); }
    .release-badge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 9px; border-radius: 999px; }
    .release-badge.latest { background: color-mix(in srgb, var(--green) 12%, transparent); color: var(--green); }
    .release-badge.milestone { background: var(--clay-tint); color: var(--clay-deep); }

    .release-changes { background: var(--paper-2); border: 1px solid var(--line); border-radius: 16px; padding: 20px 24px; box-shadow: var(--shadow); }
    .release.milestone .release-changes { border-color: var(--clay); box-shadow: 0 0 0 1px var(--clay-line), var(--shadow); }

    /* Summary — serif, the loudest text of the card (spec §11). */
    .release-summary { font-family: var(--serif); font-size: 18px; font-weight: 500; line-height: 1.5; color: var(--ink); margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
    .release-summary p { margin-bottom: 8px; }
    .release-summary p:last-child { margin-bottom: 0; }
    .release-summary em { font-style: italic; color: var(--clay-deep); }

    .change-group { margin-bottom: 16px; }
    .change-group:last-child { margin-bottom: 0; }
    .change-group-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .change-group-title .dot { width: 6px; height: 6px; border-radius: 50%; }
    /* Semantic recolor (spec §11): Исправлено green, Изменено neutral, Новое clay. No blue. */
    .change-group-title.fixed { color: var(--green); }
    .change-group-title.fixed .dot { background: var(--green); }
    .change-group-title.improved { color: var(--ink-soft); }
    .change-group-title.improved .dot { background: var(--ink-faint); }
    .change-group-title.new { color: var(--clay-deep); }
    .change-group-title.new .dot { background: var(--clay); }

    .changes-list { list-style: none; }
    .changes-list li { position: relative; padding-left: 16px; margin-bottom: 6px; font-size: 14px; color: var(--ink-soft); line-height: 1.6; }
    .changes-list li:last-child { margin-bottom: 0; }
    .changes-list li::before { content: ''; position: absolute; left: 0; top: 9px; width: 4px; height: 4px; border-radius: 50%; background: var(--ink-faint); }
    .changes-list li strong { color: var(--ink); font-weight: 600; }
    .changes-list li code { font-family: var(--mono); font-size: 12.5px; background: var(--paper-3); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; color: var(--clay-deep); }
    .changes-list li a { color: var(--clay-deep); text-decoration: underline; text-underline-offset: 2px; }

    /* Collapse: «Технически» groups + older-than-latest-3 cards → <details>. */
    summary { list-style: none; cursor: pointer; }
    summary::-webkit-details-marker { display: none; }
    .release-detail { margin-top: 2px; }
    .release-detail-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--clay-deep); }
    .release-detail-toggle::after { content: '▾'; display: inline-block; transition: transform 0.18s ease; }
    .release-detail[open] > .release-detail-toggle { margin-bottom: 14px; }
    .release-detail[open] > .release-detail-toggle::after { transform: rotate(180deg); }
    details.tech-group > summary::after { content: '▾'; display: inline-block; margin-left: 4px; font-size: 11px; color: var(--ink-faint); transition: transform 0.18s ease; }
    details.tech-group[open] > summary::after { transform: rotate(180deg); }

    /* ── Footer ── */
    .footer { max-width: 720px; margin: 0 auto; padding: 32px 24px; border-top: 1px solid var(--line); text-align: center; }
    .footer-brand { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .footer-brand img { width: 24px; height: 24px; border-radius: 50%; }
    .footer-brand span { font-family: var(--serif); font-weight: 600; font-size: 15px; color: var(--ink); }
    .footer p { font-family: var(--mono); font-size: 12.5px; color: var(--ink-faint); }

    @media (max-width: 480px) {
      .hero { padding: 48px 16px 32px; }
      .hero h1 { font-size: 30px; }
      .timeline { padding: 0 16px 60px; }
      .release { padding-left: 28px; }
      .release-changes { padding: 16px 18px; }
    }
  </style>
</head>
<body>`;

export const NAV = `
<nav class="nav">
  <div class="nav-inner">
    <a href="index.html" class="nav-brand">
      <img src="mascot.png" alt="ChatGoose">
      <span>ChatGoose</span>
    </a>
    <div class="nav-actions">
      <a href="guide.html" class="nav-link">Руководство</a>
      <a href="index.html" class="nav-link">Установить</a>
      <span class="nav-version">v1.7.1</span>
    </div>
  </div>
</nav>`;

export const HERO = `
<div class="hero">
  <h1>Что нового</h1>
  <p class="hero-sub">История обновлений ChatGoose</p>
</div>`;

export const FOOTER = `
<footer class="footer">
  <div class="footer-brand">
    <img src="mascot.png" alt="ChatGoose">
    <span>ChatGoose</span>
  </div>
  <p>v1.7.1 &middot; Gosling Agency &middot; Kernel-served AI</p>
</footer>

</body>
</html>`;
```

The `nav-version` and footer `<p>` are the two byte-exact stamp slots — carried forward as `v1.7.1` (the current committed placeholder; deploy rewrites it). Keep them EXACTLY as written.

- [ ] **Step 2: Sanity-check the templates in isolation** (no page written yet):

Run (from the scratchpad dir):
```bash
node --input-type=module -e "import('./changelog/shell.mjs').then(m => { for (const k of ['HEAD','NAV','HERO','FOOTER']) console.log(k, m[k].length); const all = m.HEAD+m.NAV+m.HERO+m.FOOTER; for (const t of ['--paper','--clay','Fraunces','Hanken Grotesk','prefers-color-scheme: dark','var(--serif)','.change-group-title.new','<span class=\"nav-version\">v1.7.1</span>','<p>v1.7.1 &middot; Gosling Agency &middot; Kernel-served AI</p>']) if (!all.includes(t)) throw new Error('MISSING '+t); if (/--blue|#4A7AE3|family=Inter/i.test(all)) throw new Error('legacy token leaked'); console.log('shell OK'); })"
```
Expected: four length lines, then `shell OK` (fails loudly if any family token, the dark block, a serif summary rule, the recolored `new` group, either stamp slot is missing, or a legacy blue/Inter token leaked).

No commit (scratchpad only).

---

### Task 3: The transformation script + text-preservation diff

Produces `<scratchpad>/changelog/build.mjs`: reads the current `changelog.html`, splits the timeline into its 54 cards on the `<!-- x.y.z -->` markers (unambiguous delimiters — no fragile nested-`</div>` counting), applies four **pure** per-card operations, re-assembles with the Task 2 shell, runs the text-preservation assertion, and writes `changelog.html` only if it passes.

The four per-card operations (each touches zero card text):
1. **Anchor + milestone class:** `<div class="release">` → `<div class="release[ milestone]" id="v<slug>">` (slug = version with dots→dashes). `milestone` is added iff the card already carries a `release-badge milestone` span (today only 1.6.0 — auto-detected, never hardcoded).
2. **Date span:** if the version is in `RELEASE_DATES` (1.7.0+), insert `<span class="release-date">DD.MM.YYYY</span>` after the version span. Older cards: nothing.
3. **«Технически» → `<details>`:** each change-group whose title text is exactly «Технически» becomes `<details class="change-group tech-group">` with its title `<div>`→`<summary>` (class + inner text preserved; `<ul>` untouched).
4. **Collapse older cards:** cards past the latest three (document index ≥ 3) get their post-summary groups wrapped in `<details class="release-detail"><summary class="release-detail-toggle">Подробнее</summary>…</details>`. The latest three stay expanded (groups inline). The serif `release-summary` always stays visible above the fold. (Cards with no summary — the ancient 1.0.0/1.1.x — collapse to just their header + the «Подробнее» toggle; acceptable, they are dateless and pre-summary.)

**Files:**
- Create: `<scratchpad>/changelog/build.mjs` (not committed)

**Interfaces:**
- Consumes: `./shell.mjs`, `RELEASE_DATES` (Task 1), the repo `changelog.html` path via `process.argv[2]`.
- Produces: rewritten `changelog.html` (in place) + a stdout report; throws (no write) on any text drift.

- [ ] **Step 1: Write `build.mjs`** (complete — paste the Task 1 `RELEASE_DATES` into the marked slot):

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { HEAD, NAV, HERO, FOOTER } from './shell.mjs';

const LATEST_EXPANDED = 3;

// ── PASTE the Task 1 map here (regenerate from git for-each-ref) ──
const RELEASE_DATES = {
  '1.9.9': '07.07.2026', '1.9.8': '06.07.2026', '1.9.7': '04.07.2026',
  '1.9.6': '03.07.2026', '1.9.5': '02.07.2026', '1.9.4': '01.07.2026',
  '1.9.3': '30.06.2026', '1.9.2': '29.06.2026', '1.9.1': '28.06.2026',
  '1.9.0': '27.06.2026', '1.8.3': '24.06.2026', '1.8.2': '22.06.2026',
  '1.8.1': '20.06.2026', '1.8.0': '18.06.2026', '1.7.1': '15.06.2026',
  '1.7.0': '12.06.2026',
};

const target = process.argv[2];
if (!target) throw new Error('usage: node build.mjs <path-to-changelog.html>');
const original = readFileSync(target, 'utf8');

// Extract the timeline inner and split into cards on the version comments.
const tOpen = original.indexOf('<div class="timeline">');
const footerComment = original.indexOf('<!-- ─── Footer');
if (tOpen < 0 || footerComment < 0) throw new Error('timeline/footer markers not found');
const timelineInner = original.slice(tOpen + '<div class="timeline">'.length, footerComment);
// closing </div> of .timeline sits just before the footer comment — drop it.
const lastTimelineClose = timelineInner.lastIndexOf('</div>');
const cardsRegion = timelineInner.slice(0, lastTimelineClose);

const parts = cardsRegion.split(/\n\s*<!-- (\d+\.\d+\.\d+) -->\n/);
// parts[0] = leading whitespace; then [version, body, version, body, ...]
const cards = [];
for (let i = 1; i < parts.length; i += 2) {
  cards.push({ version: parts[i], body: parts[i + 1] });
}
if (cards.length !== 54) throw new Error(`expected 54 cards, got ${cards.length}`);

function transformCard(version, body, index) {
  const slug = 'v' + version.replace(/\./g, '-');
  const milestone = /class="release-badge milestone"/.test(body);
  const date = RELEASE_DATES[version];

  // --- header: keep version span + any badges verbatim; add date span ---
  const headerInner = body.match(/<div class="release-header">([\s\S]*?)<\/div>\s*<div class="release-changes">/)[1];
  const versionSpan = headerInner.match(/<span class="release-version">[\s\S]*?<\/span>/)[0];
  const badges = headerInner.match(/<span class="release-badge[\s\S]*?<\/span>/g) || [];
  const dateSpan = date ? `\n      <span class="release-date">${date}</span>` : '';
  const headerHtml =
    `    <div class="release-header">\n      ${versionSpan}${dateSpan}` +
    badges.map((b) => `\n      ${b}`).join('') + `\n    </div>`;

  // --- changes: slice between .release-changes open and its close ---
  const openTag = '<div class="release-changes">';
  const openIdx = body.indexOf(openTag);
  const relClose = body.lastIndexOf('</div>');            // .release close
  const changesClose = body.lastIndexOf('</div>', relClose - 1); // .release-changes close
  const changesInner = body.slice(openIdx + openTag.length, changesClose);

  // split off the optional serif summary (no nested <div> inside it)
  const sumMatch = changesInner.match(/^\s*<div class="release-summary">[\s\S]*?<\/div>\s*/);
  const summary = sumMatch ? sumMatch[0].trim() : '';
  let groups = changesInner.slice(sumMatch ? sumMatch[0].length : 0).trim();

  // op 3: «Технически» change-groups → <details>
  groups = groups.replace(
    /<div class="change-group">(\s*)<div class="change-group-title ([^"]+)"><span class="dot"><\/span> Технически<\/div>([\s\S]*?<\/ul>)(\s*)<\/div>/g,
    '<details class="change-group tech-group">$1<summary class="change-group-title $2"><span class="dot"></span> Технически</summary>$3$4</details>',
  );

  // op 4: collapse everything past the latest three
  if (index >= LATEST_EXPANDED) {
    groups = `<details class="release-detail">` +
      `<summary class="release-detail-toggle">Подробнее</summary>\n      ${groups}\n      </details>`;
  }

  const cls = milestone ? 'release milestone' : 'release';
  const summaryHtml = summary ? `\n      ${summary}` : '';
  return `  <!-- ${version} -->\n  <div class="${cls}" id="${slug}">\n` +
    `${headerHtml}\n    <div class="release-changes">${summaryHtml}\n      ${groups}\n    </div>\n  </div>`;
}

const newCards = cards.map((c, i) => transformCard(c.version, c.body, i)).join('\n\n');
const rebuilt = `${HEAD}\n${NAV}\n${HERO}\n\n<div class="timeline">\n\n${newCards}\n\n</div>\n${FOOTER}\n`;

// ── Text-preservation assertion: every <li> and every summary must be
//    byte-identical (whitespace-normalized) old→new; the transform adds
//    structure/attributes/dates only, never prose. Abort on any drift. ──
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const lis = (h) => (h.match(/<li>[\s\S]*?<\/li>/g) || []).map(norm);
const sums = (h) => (h.match(/<div class="release-summary">[\s\S]*?<\/div>/g) || []).map(norm);
// group titles: normalize the wrapper tag (div↔summary) so only class+text compare
const titles = (h) => (h.match(/class="change-group-title [^"]+">[\s\S]*?<\/(?:div|summary)>/g) || [])
  .map((s) => norm(s.replace(/<\/(?:div|summary)>$/, '</T>')));

const oldLis = lis(cardsRegion), newLis = lis(rebuilt);
const oldSums = sums(cardsRegion), newSums = sums(rebuilt);
const oldTitles = titles(cardsRegion), newTitles = titles(rebuilt);

function assertEqualArrays(a, b, label) {
  if (a.length !== b.length) throw new Error(`${label}: count ${a.length} → ${b.length}`);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) throw new Error(`${label}[${i}] drifted:\n  OLD ${a[i]}\n  NEW ${b[i]}`);
  }
}
assertEqualArrays(oldLis, newLis, 'changes-list <li>');
assertEqualArrays(oldSums, newSums, 'release-summary');
assertEqualArrays(oldTitles, newTitles, 'change-group-title');

writeFileSync(target, rebuilt);
console.log(`rebuilt ${target}`);
console.log(`  cards: ${cards.length} | li preserved: ${newLis.length} | summaries: ${newSums.length}`);
console.log(`  dated: ${cards.filter((c) => RELEASE_DATES[c.version]).length} | ` +
  `collapsed: ${cards.length - LATEST_EXPANDED} | ` +
  `tech-details: ${(rebuilt.match(/<details class="change-group tech-group">/g) || []).length} | ` +
  `milestones: ${(rebuilt.match(/<div class="release milestone"/g) || []).length}`);
```

- [ ] **Step 2: Dry-run against a COPY** (never mutate the repo file until the assertion is proven):

Run (from the repo root; `$SCRATCH` = the scratchpad dir):
```bash
cp changelog.html "$SCRATCH/changelog.before.html"
node "$SCRATCH/changelog/build.mjs" "$SCRATCH/changelog.before.html"
```
Expected: no throw; a report like
```
rebuilt .../changelog.before.html
  cards: 54 | li preserved: 317 | summaries: 42
  dated: 16 | collapsed: 51 | tech-details: 28 | milestones: 1
```
(`li preserved`/`summaries` counts reflect the current page — the point is the assertion did not throw, `dated` is exactly 16, `tech-details` is 28, `milestones` is 1.) If it throws on `<li>`/summary/title drift, FIX the carving regexes until text is provably preserved — do not proceed.

No commit (scratchpad only). The real write happens in Task 4 after the test exists.

---

### Task 4: Extend the test, generate the page, commit (atomic)

Test-first: add the new invariants to `tests/release-pages.test.ts`, watch them FAIL against the current page, then run `build.mjs` against the real `changelog.html` and watch them PASS. Commit the rebuilt page and the test **together** (the single green commit).

**Files:**
- Modify: `tests/release-pages.test.ts`
- Modify: `changelog.html` (generated by `build.mjs`)

- [ ] **Step 1: Append the new describe block** to `tests/release-pages.test.ts` (after the existing `describe`; reuse its `readRepoFile`). No `any`; string/regex only, matching the file's style:

```ts
describe('changelog web register', () => {
  const html = readRepoFile('changelog.html');

  // [{version, body}] in document order, split on the <!-- x.y.z --> markers.
  const cards = (() => {
    const parts = html.split(/\n\s*<!-- (\d+\.\d+\.\d+) -->\n/).slice(1);
    const out: { version: string; body: string }[] = [];
    for (let i = 0; i < parts.length; i += 2) out.push({ version: parts[i]!, body: parts[i + 1]! });
    return out;
  })();
  const cmp = (a: string, b: string): number => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
    return 0;
  };

  it('keeps the 54 cards and does not backfill the eight absent 1.2.x', () => {
    expect(cards).toHaveLength(54);
    const versions = cards.map((c) => c.version);
    for (const absent of ['1.2.14', '1.2.13', '1.2.12', '1.2.11', '1.2.10', '1.2.9', '1.2.6', '1.2.5']) {
      expect(versions).not.toContain(absent);
    }
  });

  it('anchors every release uniquely and exposes the current (newest) version anchor', () => {
    const ids: string[] = [];
    for (const { version, body } of cards) {
      const slug = `v${version.replace(/\./g, '-')}`;
      expect(body, version).toContain(`id="${slug}"`);
      ids.push(slug);
    }
    expect(new Set(ids).size).toBe(ids.length);
    // newest card first → its anchor is the current-version target of the P2 button
    expect(cards[0]!.body).toContain(`id="v${cards[0]!.version.replace(/\./g, '-')}"`);
  });

  it('lists versions in strictly descending semver order', () => {
    for (let i = 1; i < cards.length; i += 1) {
      expect(cmp(cards[i - 1]!.version, cards[i]!.version), `${cards[i - 1]!.version} > ${cards[i]!.version}`).toBeGreaterThan(0);
    }
  });

  it('dates exactly the 1.7.0+ releases, as DD.MM.YYYY; older cards stay dateless', () => {
    for (const { version, body } of cards) {
      const m = body.match(/<span class="release-date">([^<]+)<\/span>/);
      if (cmp(version, '1.7.0') >= 0) {
        expect(m, `${version} must be dated`).not.toBeNull();
        expect(m![1]!).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
      } else {
        expect(m, `${version} must be dateless`).toBeNull();
      }
    }
    expect(cards.filter((c) => /release-date/.test(c.body))).toHaveLength(16);
  });

  it('expands the latest three and collapses every older card to its summary', () => {
    cards.slice(0, 3).forEach((c) => expect(c.body, c.version).not.toContain('release-detail'));
    cards.slice(3).forEach((c) => {
      expect(c.body, c.version).toContain('<details class="release-detail">');
      expect(c.body, c.version).toContain('<summary class="release-detail-toggle">Подробнее</summary>');
      expect(c.body, `${c.version} must render collapsed (no open attr)`).not.toMatch(/<details class="release-detail" open/);
    });
  });

  it('collapses «Технически» groups into <details> and keeps none as a div title', () => {
    expect(html).not.toMatch(/<div class="change-group-title[^"]*">[\s\S]*?Технически<\/div>/);
    const techDetails = (html.match(/<details class="change-group tech-group">/g) || []).length;
    const techSummaries = (html.match(/Технически<\/summary>/g) || []).length;
    expect(techDetails).toBe(techSummaries);
    expect(techDetails).toBeGreaterThan(20);
  });

  it('gives milestone releases a clay card class', () => {
    const milestone = cards.find((c) => c.version === '1.6.0')!;
    expect(milestone.body).toContain('class="release milestone"');
  });

  it('adopts the family palette + fonts, dark theme, serif summary — and drops the old blue/Inter', () => {
    for (const token of ['--paper', '--clay', 'Fraunces', 'Hanken Grotesk', '@media (prefers-color-scheme: dark)']) {
      expect(html, token).toContain(token);
    }
    expect(html).toMatch(/\.release-summary\s*\{[^}]*var\(--serif\)/);
    expect(html).toMatch(/\.release-version\s*\{[^}]*var\(--mono\)/);
    expect(html).not.toContain('--blue');
    expect(html).not.toMatch(/#4A7AE3/i);
    expect(html).not.toContain('family=Inter');
    expect(html).not.toContain("'Inter'");
  });

  it('keeps both deploy stamp slots present exactly once', () => {
    expect(html.match(/<span class="nav-version">v[^<]+<\/span>/g)).toHaveLength(1);
    expect(html.match(/<p>v[^<]+ &middot; Gosling Agency &middot; Kernel-served AI<\/p>/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** (the current page has no anchors/dates/family palette):

Run: `pnpm vitest run tests/release-pages.test.ts`
Expected: the `changelog web register` block FAILS (anchors/dates/palette/collapse); the original 5 tests still PASS.

- [ ] **Step 3: Generate the page** with the proven Task 3 script, writing the real file:

Run (from repo root):
```bash
node "$SCRATCH/changelog/build.mjs" "$(pwd)/changelog.html"
```
Expected: the same report as Task 3 Step 2 (`cards: 54 | li preserved: 317 | summaries: 42 | dated: 16 | collapsed: 51 | tech-details: 28 | milestones: 1`), no throw.

- [ ] **Step 4: Run tests + full check**

Run: `pnpm vitest run tests/release-pages.test.ts && pnpm check`
Expected: the `changelog web register` block PASSES, the original 5 PASS, `pnpm check` all green.

- [ ] **Step 5: Manual eyeball** — open `changelog.html` in a browser: family paper/clay look, serif summaries loudest, latest three expanded and older cards collapsed to a «Подробнее» toggle, «Технически» sub-groups fold, dates on 1.7.0+ only, no blue anywhere; toggle OS dark mode → pure token swap, still readable. Click the address bar to `changelog.html#v1-6-0` → the 1.6.0 milestone (clay border) lands below the sticky nav.

- [ ] **Step 6: Commit (atomic)**

```bash
git add changelog.html tests/release-pages.test.ts
git commit -m "feat(changelog): rebuild as the family web register — anchors, dates, collapse, dark theme"
```

---

### Task 5: Prove the deploy invariant (both stampers, no script edits)

The rebuild must stamp cleanly through BOTH deploy paths with zero edits to either script. Pin that as a permanent test and verify it live.

**Files:**
- Modify: `tests/release-pages.test.ts` (one more `it`)

- [ ] **Step 1: Add the dual-deploy stamp dry-run** inside the `changelog web register` describe (reuse `replaceExactlyOnce` from the top of the file — it already asserts single-match and returns the stamped source):

```ts
  it('stamps cleanly through both deploy.sh and deploy-pages.sh (no script edits needed)', () => {
    // deploy.sh — stamp_changelog_page_version (v OUTSIDE group 1, re-added as $1v…$2)
    const a = replaceExactlyOnce(html, /(<span class="nav-version">)v[^<]+(<\/span>)/, '$1v9.8.7$2');
    const b = replaceExactlyOnce(a, /(<p>)v[^<]+( &middot; Gosling Agency &middot; Kernel-served AI<\/p>)/, '$1v9.8.7$2');
    // deploy-pages.sh — generic stamp_version (v INSIDE group 1, kept as $1…$2)
    const c = replaceExactlyOnce(html, /(<span class="nav-version">v)[^<]+(<\/span>)/, '$19.8.7$2');
    const d = replaceExactlyOnce(c, /(<p>v)[^<]+( &middot; Gosling Agency &middot; Kernel-served AI<\/p>)/, '$19.8.7$2');
    for (const stamped of [b, d]) {
      expect(stamped).toContain('<span class="nav-version">v9.8.7</span>');
      expect(stamped).toContain('<p>v9.8.7 &middot; Gosling Agency &middot; Kernel-served AI</p>');
    }
    // both deploy scripts still carry their changelog slot regexes unchanged
    const deploy = readRepoFile('scripts/deploy.sh');
    const deployPages = readRepoFile('scripts/deploy-pages.sh');
    expect(deploy).toContain('changelog nav version');
    expect(deploy).toContain('changelog footer version');
    expect(deployPages).toContain('(<span class="nav-version">v)[^<]+(</span>)');
    expect(deployPages).toContain('(<p>v)[^<]+( &middot; Gosling Agency &middot; Kernel-served AI</p>)');
  });
```

- [ ] **Step 2: Run + confirm the scripts are untouched.**

Run:
```bash
pnpm vitest run tests/release-pages.test.ts
git status --porcelain scripts/deploy.sh scripts/deploy-pages.sh
```
Expected: green; `git status` prints NOTHING for both scripts (deploy tooling was never edited — the deploy invariant holds by construction).

- [ ] **Step 3: Optional live stamp dry-run** (proves deploy.sh's own node stamper matches the new page). This mutates a COPY, never `changelog.html`:
```bash
cp changelog.html "$SCRATCH/stamp-check.html"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const s = readFileSync(process.argv[1], "utf8");
  for (const re of [/(<span class="nav-version">)v[^<]+(<\/span>)/g, /(<p>)v[^<]+( &middot; Gosling Agency &middot; Kernel-served AI<\/p>)/g]) {
    const n = (s.match(re) || []).length;
    if (n !== 1) throw new Error("slot matched " + n + " times: " + re);
  }
  console.log("both changelog stamp slots match exactly once");
' "$SCRATCH/stamp-check.html"
```
Expected: `both changelog stamp slots match exactly once`.

- [ ] **Step 4: Commit**

```bash
git add tests/release-pages.test.ts
git commit -m "test(changelog): pin dual-deploy stamp invariant (deploy.sh + deploy-pages.sh)"
```

---

### Task 6: Record the decision, full check, finish

**Files:**
- Modify: `docs/decisions.md`
- Test: `pnpm check`

- [ ] **Step 1: Append the decision entry** to `docs/decisions.md` (verify the next free E-number at merge time; add the matching one-line summary-table row):

```markdown
**E<N> (2026-07-<DD>).** changelog.html rebuilt as the family web register:
install.html's --paper/--clay palette, Fraunces + Hanken Grotesk (Google
Fonts CDN, same as install — the local-woff2 mandate is scoped to extension
pages only, E<P1>), the goose mascot, and a prefers-color-scheme dark swap
(pure token override; install/guide stay light). Per-release id="v1-9-6"
anchors (the P2 «Версия → Changelog» button targets
changelog.html#v<major>-<minor>-<patch>). Dates DD.MM.YYYY for the 16 tagged
1.7.0+ releases only (the three earliest are retro-tags, approximate); older
cards stay dateless — no invented backfill. Serif release summaries as the
loudest text; groups recolored Исправлено=green / Изменено=neutral /
Новое=clay (the old blue is gone); milestones get a clay card border.
«Технически» groups and every release older than the latest three collapse
into <details>. CANON: CHANGELOG.md stays the full 62-version archive; the
page keeps its 54 cards (the eight 1.2.x — 1.2.14/13/12/11/10/9/6/5 — stay
absent); page = "what users saw", markdown = full history. All release texts
transferred verbatim (a build-time diff asserts every <li>/summary is
byte-identical). DEPLOY: the two stamp slots (nav-version span + footer <p>)
stay byte-exact for BOTH deploy.sh (stamp_changelog_page_version) and
deploy-pages.sh (generic stamp_version) — neither script edited;
release-pages.test.ts pins anchors, dates, order, collapse, palette, and the
dual-stamp dry-run. ORDERING: the anchored page deploys before (or with) the
P2 release; deploy-pages.sh gives a standalone page-only deploy path so the
anchors can go live ahead of P2. Spec:
docs/superpowers/specs/2026-07-16-options-redesign-design.md §11.
```

- [ ] **Step 2: Full check**

Run: `pnpm check`
Expected: all green.

- [ ] **Step 3: Commit + push + Draft PR + toolkit review**

```bash
git add docs/decisions.md
git commit -m "docs: record changelog web-register decision (E<N>)"
git push -u origin ai/<task-id>-changelog-web-register
gh pr create --draft --title "Changelog: family web register — anchors, dates, collapse, dark theme" --body "Spec: docs/superpowers/specs/2026-07-16-options-redesign-design.md §11. Independent parallel track: no src/ change, no schema, no version bump. All release texts transferred verbatim (build-time diff proves it); both stamp slots byte-exact for deploy.sh + deploy-pages.sh.

Deploy ordering: this page must ship before or with the P2 options release (the «Версия → Changelog» button links changelog.html#v<major>-<minor>-<patch>). Standalone deploy available via scripts/deploy-pages.sh.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
~/code/agentic-control-plane/bin/agent review chatgoose --pr <N>
```

- [ ] **Step 4: Note for the owner** — to publish the anchors AHEAD of the P2 release, run `bash scripts/deploy-pages.sh` from a clean `main` after merge (it stamps from `manifest.json` and scp's `changelog.html` + `install.html` + `guide.html` + `mascot.png`, no rebuild/sign). Otherwise the page ships on the next full `scripts/deploy.sh` release, which must be ≥ the P2 release.

---

## Self-Review Notes (rev 1)

- **Spec §11 coverage:** family web register look (install.html `--paper/--clay` palette + Fraunces/Hanken + mascot) — Task 2 CSS; versions in mono + `id="v1-9-6"` anchors — Task 3 op 1 / Task 4 test; dates only for trustworthy 1.7.0+ tags as DD.MM.YYYY, older dateless — Task 1 map + Task 3 op 2 + Task 4 date test; serif summary as the loudest text — Task 2 `.release-summary`; groups Исправлено=green / Изменено=neutral / Новое=clay via a pure CSS class-color remap (`fixed`/`improved`/`new`), blue gone — Task 2; milestone clay border — Task 2 + Task 3 op 1 (1.6.0, auto-detected); «Технически» → `<details>` and older-than-3 collapsed — Task 3 ops 3–4 + Task 4 collapse test; prefers-color-scheme dark — Task 2; deploy invariant (both slots byte-exact, both stampers, no edits) — Task 5. All checks in the extended `release-pages.test.ts`.
- **Canon decision restated:** the page stays at 54 cards; the eight 1.2.x (1.2.14/13/12/11/10/9/6/5) that were never on it are NOT backfilled — pinned by a negative test. `CHANGELOG.md` (62) remains the full archive.
- **Dates decision restated:** DD.MM.YYYY, format pinned by regex in the test; only the 16 tagged 1.7.0+ releases are dated (the top 16 cards); the three earliest tags are retro/approximate but still stamped; future releases stamp on release. The test asserts hasDate ⇔ version ≥ 1.7.0, so the policy can't silently drift.
- **Transformation approach (chosen + justified):** a throwaway scratchpad Node script, NOT a hand-edit — a manual re-markup of 54 cards across ~1900 lines is exactly the error-prone work the brief warns against. The four operations are pure (insertion + a title tag-swap; the group recolor is a CSS-only remap, so zero group-title edits), and a build-time text-preservation assertion (ordered `<li>` + `release-summary` + `change-group-title` inner-HTML arrays identical old→new) ABORTS the write on any prose drift — the safety net that makes the string approach trustworthy. Card splitting is on the unambiguous `<!-- x.y.z -->` markers, avoiding fragile nested-`</div>` counting. jsdom was rejected: its serializer normalizes entities/whitespace and would threaten the byte-exact `&middot;` stamp slots and reformat the whole file.
- **Standalone-deploy finding:** `scripts/deploy-pages.sh` DOES provide a page-only path (stamps + scp's changelog.html without rebuild/sign), so the anchors can go live before P2. Its generic `stamp_version` uses a slightly different regex form than `deploy.sh`'s `stamp_changelog_page_version` (the `v` sits inside vs outside group 1) — both target the same slot; Task 5 dry-runs BOTH forms so the page is proven compatible with each.
- **Atomic-commit rationale:** the invariants are cross-cutting, so the page + its test land in one green commit (Task 4); Tasks 5–6 add only green-passing tests/docs. No commit is ever red — `pnpm check` includes `release-pages.test.ts`.
- **Deliberately out of scope:** the P2 options «Changelog» button (separate release, must not precede this deploy), any extension/`src` code, storage/schema, version bumps, font bundling (extension-page-only per §2.5), and any rewrite of release prose (pure re-markup).
