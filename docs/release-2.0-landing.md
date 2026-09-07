# ChatGoose 2.0 landing acceptance

The September 6 sections below are historical acceptance records. The final
release journey and current preview are described in the September 7 section;
it supersedes the earlier main-page demos, stamping and local-only deployment
scope (E92).

Implemented in `install.html`, the source already deployed as the distribution
site's `index.html`. Local preview: `http://127.0.0.1:4173` while its preview
server is running. No website or extension publication was performed.

- Brand: paper, clay, Source Serif 4 (including Cyrillic), Hanken Grotesk;
  unchanged existing logo embedded from `icons/icon-128.png`.
- New features: conversational Coach/Help, independent Short/Full Recaps,
  Cabinet, gated Voice. Review, everyday reply tools and Spenders are presented
  as continuing or improved capabilities.
- Fictional product examples are labelled. They contain no customer messages,
  credentials or operational data. They do not measure generated writing quality.
- Coach: all three scenarios switch; keyboard next/previous and Home/End work.
- Recap: Short/Full switch independently of Coach; default 3000-message full
  depth is identified as configurable.
- Cabinet: light/dark selection updates its preview and pressed state.
- Keyboard focus, skip link and reduced motion are provided. Browser checks at
  320, 390, 768, 1280 and 1440px showed no horizontal page overflow. Desktop
  Coach/Recap and mobile Recap/Cabinet were visually inspected. The small-screen
  hero uses a single Coach column so the product text stays readable.
- All six existing release-page tests pass. Independent DOM execution verified
  tab selection, focus, panels and theme switching. Inline script syntax passes
  `node --check`; IDs and fragment links resolve uniquely. No new runtime deps.
- Existing stamp patterns and production download origin remain unchanged.
  The install action navigates to the published XPI and does not assert that an
  installation succeeded. Desktop Firefox 142+ and Agency Hub onboarding are
  explained in the install section.

Before public 2.0 launch, remove candidate disclosures only when the actual
release feed is ready, and update the Voice readiness line after successful live
paid-audio acceptance. Use the repository's established release scripts.

## Separate feature walkthrough

`whats-new-2.html` is an additional productivity-focused version requested after
the general landing. It preserves `install.html` and explains new behavior,
entry points, practical steps and limitations. Its retained local preview is
`http://127.0.0.1:4180/whats-new-2.html` while the preview server runs.

Two independent code/copy reviews checked Coach, both Recaps, the Cabinet,
Voice, Review, toolbar and Spenders. They corrected Voice tone/edit order and
matched context-setting names to the actual Cabinet. A DOM check verified all
seven Cabinet tabs, keyboard navigation and focus, unique IDs and fragment links.
Browser QA covered the desktop overview and Recap table, Cabinet switching,
keyboard End, mobile layout and the expanded auto-recap explanation.
No new package, extension build, production page or update-feed change is needed
for the local alternative.

## Prompt coverage — 2026-09-07

Added `#prompts` to the standalone walkthrough, overview and navigation, with
matching candidate entries in both changelogs. The section explains the
implemented Reply/Fix/Hi/Ping changes in Hub commits `1746d006`, `f3bb7888` and
`1702c086`, plus the earlier Help/Review evidence-based Russian analysis.
Reply and Fix examples come from the candidate templates and are labelled as
examples, not live generation results.

Rollout status was checked independently: the running API image is
`sha256:c68b4c5c77711040c26b1d0e74b45156982039f68f7f0bda0c8a5152a2aac770`,
labelled `agency-hub.source-revision=2475b3046332`. That revision excludes the
three September prompt commits; its prompts tree is identical to `7fac98f`.
Read-only string checks in `/app/apps/runtime/dist/api.js` confirm the old
Reply/Fix markers and absence of the new v10/Fix markers. The page therefore
says the rework is prepared and needs a separate Hub update. Earlier Help/Review
changes are already part of that server revision. No Hub writes or extension
rebuild were performed. See E90 for the evidence boundary.

Validation: independent source/copy review found no unsupported claims. All six
release-page tests pass; inline script syntax, unique IDs and fragment targets
are valid. Browser checks covered the new navigation link, desktop and 390px
section layout, and 320px overflow (none). The rollout notice remains visible
on mobile even though the decorative status badge is hidden. No console errors.


## Consistent release journey — 2026-09-07

Local preview: `http://127.0.0.1:4180/index.html` while the preview server runs.
It maps the real production route to local `install.html`.

| Page | Role | Next step |
|---|---|---|
| `index.html` (source `install.html`) | ChatGoose product, familiar tools and concise 2.0 features | Feature cards link directly to the relevant walkthrough section |
| `whats-new-2.html` | Detailed 2.0 workflows, examples, configuration and limitations | Guide, install, version history |
| `guide.html` | Setup and everyday reference | Main product, 2.0 changes, version history |
| `changelog.html` | Chronological archive; 2.0 entry at `#v2-0-0` | Detailed 2.0 walkthrough |

Settings and popup now link to the fixed walkthrough and the separate archive.
The popup fallback retains these links when its runtime read fails; Settings
keeps the existing unseen-version bookkeeping. These changes are built locally,
but have not replaced the user's already installed Firefox candidate.

The main keeps its versionless product name and three Coach scenarios. Duplicate
Recap/Cabinet demos move into the detailed walkthrough. Five linked cards cover
Recap, Cabinet, Review, prompts and optimizations; Voice appears once below with
a full draft-to-audio illustration and a direct walkthrough link. Font, paper,
clay, text colors and brand assets are aligned across all four pages. On narrow
screens the overview rows provide navigation without repeating a separate TOC.
The seven Cabinet tabs expose the correct horizontal/vertical orientation and
use the corresponding arrow keys. Long historical code strings wrap at 320px.

Source verification for optimization copy:

- Published 1.9.11 tag `7510322` and recorded deployed `2344f2a` have identical
  tree `899a4782a275fe3a5a83d6b57f8caa03deff2a88`.
- `d9d54a0`: `src/content/bootstrap.ts` loads the main chat UI dynamically;
  `src/content/index.ts` batches updates by animation frame;
  `src/content/overlay/overlay-controller.ts` appends streamed text.
- `5ff8d49`: separate completed short/full recap results avoid replacing one
  format with the other; opening a saved result does not start generation.
- `aaa75b7`: Coach shows stage and elapsed time while waiting.
- `ea35aaba`: progressive Spenders snapshots already belong to 1.9.11, so
  they are not described as a new 2.0 optimization. Pending server-side prompt
  caching work is also excluded from shipped-browser claims.

Both deploy scripts publish and HTTP-check `whats-new-2.html`. Full deploy moves
the walkthrough into place before `chatgoose-latest.xpi`, `updates.json` and the
main page; pages-only deploy publishes it before referring pages. The main
footer is the only mutable version slot on the product page. Its fixed 2.0
link and the walkthrough itself are never changed by future version stamping.
The archive retains its two existing mutable slots. Existing release gates
remain intact. Neither script was run against production.

Validation: three independent GPT-6 Astra reviewers examined implemented
desktop/mobile screenshots and current source. Their fixes were applied, with
a final independent check of deploy ordering. `pnpm check` passed: typecheck,
lint, kernel cutover gates, 111 test files / 2108 tests, and production build.
Shell syntax checks passed. Local cross-page links, unique IDs and inline
script syntax were checked. Browser checks covered 320/390/1280px layouts,
Cabinet keyboard orientation after resize, and transitions among pages.
Screenshots are retained in `/tmp/chatgoose-release-design-20260907/`.

Candidate notices remain. The pages, new extension links and publication scripts
are ready for review locally. No website publish, signed XPI, feed change, Hub
deployment or additional Firefox installation was performed in this pass.


## Voice-first presentation and technical detail — 2026-09-07

The owner-requested follow-up focuses on `whats-new-2.html` (E93). Voice leads
the section order, side navigation and compact overview cards. Its three-step
reference switches between text preparation, multiple takes and attachment.
The example carries a visible no-audio label; it does not connect to ElevenLabs
or invoke an extension action. Tone names are deliberately plain text.

Coach, Recap, Cabinet, prompts and optimizations now lead with their practical
effect and an at-a-glance parameter strip. Expandable technical notes keep
configuration, implementation and recovery details available without forcing
them into the main reading flow. Existing page/fragment URLs remain valid.

Three GPT-6 Astra agents independently checked source facts and the implemented
presentation. Voice facts come from `src/content/voice/voice-panel.ts`,
`attempt-controller.ts`, the attachment adapter, shared constants and the Hub
`voice-profiles.ts` service in the prepared language-fix checkout. Its model
and output format are described as defaults that account profiles can override.
The editor's 600 characters and duration estimate are advisory, not output
guarantees. Paid generation and pending live acceptance remain explicit.

Validation: all eight release-page tests pass; inline JS parses; IDs and
fragment targets are unique/valid. Browser checks confirm three Voice steps
and the Cabinet select independently, Home/End and arrows work, and Cabinet
orientation tracks resize. All six technical disclosures were opened at 320px
with no horizontal overflow. Desktop and 390px screenshots cover the overview,
Voice and parameter strips. A final independent mobile review found no blocking
issue after fixing the Voice badge's effect on title width. Screenshots 16–19
in `/tmp/chatgoose-release-design-20260907/` document the presentation; 19 is
the corrected mobile Voice view. No publication or extension reinstall.


## Conversational copy revision — 2026-09-07

At the owner's request, the walkthrough's lead copy now describes situations
on a chatter's shift, with natural Russian phrasing in headings and labels.
Voice remains first; technical parameters and readiness notices remain. The
prepared prompt changes are framed as requested behavior rather than a promised
output. An independent GPT-6 Astra editorial review found the tone more natural
and identified two ambiguous phrases; both were clarified.

A before/after DOM comparison verified identical element structure, attributes,
CSS and JS. Only text changed, so no extension rebuild or new behavior tests
were needed. Browser checks covered desktop and narrow layouts; the updated
page is open in the local preview. No publication was performed.


## Full product story on the main landing — 2026-09-07

E95 responds to the owner's observation that the main page appeared to contain
only the 2.0 features. It now follows the complete everyday workflow:

1. Versionless ChatGoose hero, Agency Hub requirement and product chapter links.
2. Four interactive writing examples: Reply, Fix, Hi and Ping, with supporting
   copy about personas, tones, Split and keyboard shortcuts.
3. Recap, Help and Review, alongside an illustrative fan dossier.
4. A standalone Spenders section, semantic spending table and keyboard workflow.
5. One compact Voice-first 2.0 chapter linking to the detailed walkthrough.

This replaces the previous main-page Coach demo, five large release cards and
separate Voice illustration. Their unused CSS is removed. The approved detailed
walkthrough stays unchanged; main-page version stamping and existing public
navigation remain intact. Main-page examples are fictional and require no AI
request, browser-extension connection or account mutation.

An independent GPT-6 Astra source audit checked the evergreen catalog against
published 1.9.11. Help and Review were already accessible there through hotkeys;
conversational Coach and separate short/full Recap results belong to the new
release. An independent editorial review caught an invalid guide fragment and
imprecise persona-binding copy; both were corrected. A separate visual reviewer
checked the implemented desktop and mobile screenshots and found no remaining
material layout issue. Its suggestions to surface the Hub requirement in the
hero and describe the actual rendering optimization were incorporated.

Validation: all eight release-page tests pass. All four public pages have valid
local fragment targets and unique IDs; inline scripts parse. Browser checks
cover 1280px desktop and 390/320px mobile layouts. Every writing scenario renders
with exactly one visible panel and no horizontal overflow at 320px. Arrow keys,
Home/End, focus and orientation changes after resizing were checked. Mobile
tabs use a compact row so the selected example follows immediately. Screenshots
25–33 under `/tmp/chatgoose-release-design-20260907/` record the review, including
the superseded tall mobile tabs in 29 and the corrected layout in 30.

Only the local product landing and these decision/acceptance notes changed in
this pass. No extension runtime change, installation or publication was needed.


## More visible 2.0 chapter without losing the product — 2026-09-07

E96 responds to the owner's follow-up that the compact update had received too
little attention. An early announcement links to the update, and the chapter
now follows the writing examples, before the unchanged context and Spenders
sections. The product hero and all evergreen capabilities remain.

Voice has a prominent text/takes/attachment illustration, with no actual audio
or fake playback control. Coach and Recap have separate illustrated stories;
Cabinet, prepared prompt improvements and rendering optimizations follow as
smaller links. The full-walkthrough CTA is more visible. On narrow screens the
Voice illustration precedes its explanatory copy. The detailed walkthrough,
extension runtime and publication state are unchanged.

An independent GPT-6 Astra editorial reviewer identified an ambiguous Recap
depth note. Source verification confirmed the fixed 300-message short window
and configurable full depth, defaulting to 3000; the note was corrected. A
separate GPT-6 Astra reviewer checked the implemented desktop screenshots and
found the update visible without replacing the product identity.

Validation: eight release-page tests pass; local fragment links, unique IDs and
inline scripts check cleanly. Desktop screenshots 35–37 and mobile screenshots
38–39 are retained under `/tmp/chatgoose-release-design-20260907/`. Browser
checks cover 1280/390/320px layouts with no page overflow; short/full number
cards fit at 320px. The final copy and spacing refinements preserve the same
structure and routes. No publication or extension installation was performed.


## Fresh critics and Telegram draft — 2026-09-07

E97 adds independent GPT-6 Astra interface/source reviews and a detailed
Telegram draft. Guide inconsistencies, missing hotkey targets, mobile anchor
visibility and FAQ keyboard access were corrected. Eight release-page tests,
four-page local link/ID/script checks and desktop/320px browser verification
pass. A final independent visual review found no remaining material issue.

The [new review record](release-2.0-pages-review.md) contains the fixes and
fresh production observations at 17:12 MSK: feed 1.9.11, walkthrough 404,
Hub revision `dcbba081d3bf`, differing SDK/Hub contract hashes and unchanged
pending prompt rollout. This dated snapshot supersedes earlier server-version
observations for the purpose of this review; it does not update Voice billing
or prove successful paid acceptance. The [Telegram draft](release-2.0-telegram-draft.md)
is four messages, about 12.7k characters, prepared and not sent.
