# ChatGoose

Firefox extension for agency chatters working in Fansly DMs. It adds reply,
coaching, fan-summary, review, ping, greeting, and spenders-board tools directly
to the Fansly interface.

## Current architecture

ChatGoose is a client of the Agency Hub kernel in `../core`:

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

The exact shipped version is defined by `package.json` and `manifest.json`.
Release history is in [CHANGELOG.md](CHANGELOG.md). Do not copy a version number
from prose when checking what is installed or live; verify the signed update feed.

## Features

- **Reply** — draft a context-aware response, with tone and split-message modes.
- **Improve** — rewrite the current composer draft.
- **Help** — coaching and suggested next moves.
- **Summary** — update the fan relationship profile.
- **Review** — evaluate the conversation and chatter performance.
- **Ping** — re-engage an inactive fan.
- **Hi** — greeting for a new or very short conversation.
- **Spenders board** — kernel-backed ranking and reactivation context.

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

Releases ship from `main`. Keep `package.json` and `manifest.json` versions equal,
update `CHANGELOG.md` and `changelog.html`, run `pnpm check`, then use
`scripts/deploy.sh`. The deploy script signs the extension, updates the
self-hosted feed, and verifies served version consistency.

The public `install.html`, `guide.html`, and `changelog.html` pages are shipped
with the release and must describe the same kernel/device-token architecture as
this README.
