# ChatGoose

Firefox extension for agency chatters working in Fansly DMs. It adds reply,
coaching, fan-summary, review, ping, greeting, and spenders-board tools directly
to the Fansly interface.

## Current architecture

ChatGoose is a client of the Agency Hub kernel in `../hub`:

- Fansly conversation data is read live from the page DOM/API in the chatter's
  browser session. Credentials remain in memory and are not copied into the Hub.
- AI generations go only through the kernel feature lane
  (`POST /api/v1/ai/features/:feature`). The extension contains no provider API
  keys, vendor AI SDKs, or prompt library.
- Models, prompt assembly, quotas, and AI cost accounting are owned by core.
- Hub authentication prefers per-device sign-in tokens. The legacy chatter-key
  path remains only for fleet migration compatibility.
- Money and top-spenders data are served by core; the extension does not compute
  its own financial truth.

The local source version is defined by `package.json` and `manifest.json`.
Release history is in [CHANGELOG.md](CHANGELOG.md). Do not copy a version number
from prose when checking what is installed or live; verify the signed update feed.

## Features

- **Reply / Fix** — draft or improve a reply, with tone and Split controls.
- **Coach** — ask follow-up questions about the current fan, attach a draft,
  and use the **Help** situation-analysis preset (also available through H).
- **Recap** — independently cached short (up to 300 messages) and full
  (configurable up to 3000) fan summaries; only the full dossier syncs to Hub.
- **Review** — a readable conversation evaluation with recommendations and examples.
- **Voice** — script, paid audio takes, preview, MP3 download, and native Fansly
  attachment, only for pages whose Hub capability enables it. Sending stays manual.
- **Ping / Hi** — re-engage an inactive fan or greet a new conversation.
- **Spenders** — kernel-backed ranking with data freshness and deleted-account labels.
- **Vault uploader** — on `/creator/vault`, a folder of media goes into the open
  album one file at a time through Fansly's own upload form, each confirmed by
  its album card, with a per-account/per-album checkpoint for resuming; an
  unconfirmed file is never re-uploaded without the chatter's answer.
- **Settings cabinet** — seven panes for status, Hub, personas, accounts,
  generation, hotkeys, and appearance; includes sign-out and a support report.

AI output is always a draft. ChatGoose never sends an AI response without an
explicit human action and never auto-retries an indeterminate send.

## Setup

Requirements:

- Firefox 142+ for the current signed builds;
- access to the agency's core server;
- Node.js 22+ and pnpm for development.

Build and load locally:

```bash
pnpm install
pnpm build
```

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
and select `dist/manifest.json`.

In extension settings, configure the Agency Hub URL and sign in with the
chatter's assigned account/device flow. Do not create or paste Anthropic,
OpenRouter, or other provider keys into the extension.

## Development

```bash
pnpm check      # typecheck + lint + architecture gates + tests + build
pnpm watch      # rebuild on source changes
pnpm test       # Vitest suite
pnpm typecheck  # strict TypeScript check
```

Important references:

- [CLAUDE.md](CLAUDE.md) — binding engineering rules and invariants;
- [docs/decisions.md](docs/decisions.md) — append-only architecture decisions;
- `docs/generated/` — point-in-time code maps; check each file's snapshot SHA
  before relying on line numbers or current-state claims;
- [SPEC_FINAL.md](SPEC_FINAL.md) — historical v1.3 product/UX intent, not current
  architecture.

## Release

Release candidate 2.2.0 adds the **Новые** button for direct Fansly follower
review, explicit draft generation and one-attempt sending. It requires the
paired Hub new-follower support deployed first. Release 2.1.3 is dated
2026-09-11 (Ping reads the fan's names and bio, no
seeded opener); 2.1.2 (the settings cabinet's review-tail fixes), 2.1.1 (the
vault uploader off the shared content path, UTF-8 bundles) and 2.1.0 (the vault
uploader and the scoped Coach Cyrillic guard) are dated 2026-09-10; 2.0.0 is
dated 2026-09-08. Verify the signed update feed when
checking which version is currently available. Agency Hub selects the models and
generation settings; the [2.0 changelog](CHANGELOG.md#200) records the
server-side update.
Voice audio is generated separately through ElevenLabs for accounts enabled
by the administrator.

Releases ship from `main`. Keep `package.json` and `manifest.json` versions equal,
update `CHANGELOG.md` and `changelog.html`, run `pnpm check`, then use
`scripts/deploy.sh`. The deploy script signs the extension, updates the
self-hosted feed, and verifies served version consistency.

The public pages ship together: `install.html` becomes the versionless product
landing at `index.html`; `whats-new-2.html` is the detailed 2.0 walkthrough;
`guide.html` explains everyday use; `changelog.html` retains version history.
The extension links to both the walkthrough and archive from Settings and the
popup. Both deploy scripts publish the walkthrough before any new entry point
links to it. Keep the fixed 2.0 title and URL independent of future version stamps.
