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
- Hub authentication is one login and one password, traded for a per-device
  credential through the kernel's public password route — no cookie, no
  reserve/activate. The same pair signs the chatter into the OnlyFans desktop
  app. The legacy chatter key is gone: field, fallback and storage slot were
  removed in 2.4.0 (storage v17).
- Money and top-spenders data are served by core; the extension does not compute
  its own financial truth.

The local source version is defined by `package.json` and `manifest.json`.
Release history is in [CHANGELOG.md](CHANGELOG.md). Do not copy a version number
from prose when checking what is installed or live; verify the signed update feed.

## Features

- **Reply / Fix** — draft or improve a reply; tone arms Reply, Split works on both (2–3 messages).
- **Coach** — ask follow-up questions about the current fan, attach a draft,
  and use the **Help** situation-analysis preset (also available through H).
- **Recap** — independently cached short (up to 300 messages) and full
  (configurable up to 3000) fan summaries; only the full dossier syncs to Hub.
- **Review** — a readable conversation evaluation with recommendations and examples.
- **Voice** — script, paid audio takes, preview, MP3 download, and native Fansly
  attachment, only for pages whose Hub capability enables it. Sending stays manual.
- **Ping / Hi** — re-engage an inactive fan or greet a new conversation. Hi in
  the chat (three variants) and the **Новые** followers window (one draft) are
  one kernel feature, `hi-greeting` with `variantCount`, fed by one greeting
  context (`src/shared/greeting-context.ts`): display name, username, saved
  name, bio, avatar, welcome and mass messages labelled as automated, and a
  freshness gate of at most 10 *personal* messages. Welcome definitions come
  from one shared, cached, paced service
  (`src/background/welcome-definitions.ts`). The chat reads one Fansly page; a
  conversation that does not fit it is Reply or Ping territory (E136).
- **Новые фоловеры** (2.4.6, E138) — a fast pass shows the followers and
  confirmed results, then one automatic queue resolves only the remaining fans
  by their account IDs and reads their chats. Confirmed rows are usable while
  the queue runs; selecting a pending fan makes them next. Pause/continue keeps
  results and drafts and checks only the remainder. A run may create empty
  technical chats. Generation and sending still require a human click and
  confirmed history; a listing/search miss never means «Не писали».
- **Spenders** — kernel-backed ranking with data freshness and deleted-account labels.
- **Vault uploader** — on `/creator/vault`, a folder of media goes into the open
  album one file at a time through Fansly's own upload form, each confirmed by
  its album card, with a per-account/per-album checkpoint for resuming; an
  unconfirmed file is never re-uploaded without the chatter's answer.
- **Incoming-message sound** (2.7.0, E145) — the desktop app's blip when a fan
  writes to a chat that is not open in the focused window, while a Fansly tab of
  that model is open. A MAIN-world `document_start` tap listens passively on the
  page's own wsv3 socket; the background decides (own, automated, tips, 180 s
  freshness, per-model mute, 2 s throttle) and plays it. Tone, volume and the
  switch live in «Вид», the per-model switch in «Аккаунты». Since 2.7.1 (E146)
  a new follower rings too (FollowerService `type 2` on the same socket), with
  its own switch and tone; the per-model switch silences both. Eight tones;
  the message default is Fansly's `chime`, the OnlyFans app's `blip` a choice.
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

In extension settings, open **Аккаунт ChatGoose** and sign in with the login and
password the chatter set through the owner's invite link. The hub address ships
pre-filled and lives under «Дополнительно»; the first sign-in also asks Firefox
for access to that origin. Do not create or paste Anthropic, OpenRouter, or other
provider credentials into the extension — it holds none.

## Development

### Hotkeys (2.5.0, E141)

The scheme is the hub's `packages/chatgoose-hotkeys` (spec: its README),
vendored into `vendor/chatgoose-hotkeys` as `@chatgoose/hotkeys` by the hub's
`scripts/vendor-hotkeys.mjs` — never edit it here; re-vendor the extension and
the desktop app from the same hub commit. `src/shared/hotkeys.ts` maps the family
actions onto the extension's action ids and builds every label;
`src/content/hotkey-input.ts` holds the one engine instance both content bundles
feed (the fresh-press roll-over guard needs every keydown and keyup).

### Two-phase follower verification (2.4.6, E138)

`FollowersService` keeps one scan with two phases. Discovery and the first
checks reuse positive proofs, inbox matches, and saved creator/fan chat IDs.
Unresolved identities become `pending`, never `ready`. The sequential tail
uses a single `POST /group` attempt, validates both participants, saves the ID,
and reads `GET /group` plus paginated history through the existing checker.
A missing `lastMessage` field in the POST response proves nothing about history.
Only an exhausted history proves `ready`/`reply`; a personal outgoing message
proves `contacted`. `hidden` is diagnostic data with no inferred cause.

Follower GETs and chat-resolution POSTs share one creator lane. Phase-two
identity/history requests are not automatically retried: the first 429 stops
the tail; five consecutive network, timeout, 404 or 5xx failures stop an outage
run. Local refusals remain visible per fan. A soft pause cancels a POST still
waiting for admission, but lets an already dispatched POST finish and save the
ID before stopping. Closing the window or changing the session aborts the work.
Continue rechecks only unfinished rows and reuses saved IDs. Selecting a row
only changes the next item of an existing run.

Verify/generate/send share the queue's creator/fan lock. Sending retains the
live-history and reviewed-revision checks, Hub reservation/dispatch and durable
attempt journal. `POST /message` never enters the read FIFO after Hub dispatch,
and an uncertain delivery is never retried. Text search remains only a read-only
preview fallback for old positive proofs that carry no saved chat ID.

### New-follower diagnostics

Enable **Режим отладки** in **Генерация → Служебное**, then open **Новые**
(or refresh an already open follower window). **Отладка ↗** opens that run's
live text journal in an extension tab. Select a run/account or fan, search events,
filter errors, and use **Копировать весь лог** or **Сохранить .txt**. Exports
always include the full retained run, regardless of screen filters.
The viewer shows 2,000 events per page, initially the latest page; use **Ранее**,
**Позже** or **К последним** to navigate. Search and filters cover the whole run.

The journal records UTC timestamps and monotonic millisecond offsets/durations,
actual Fansly HTTP attempts/statuses/backoffs, pagination, cache use, welcome
refreshes, message classification by ID, eligibility reasons, continuation,
generation and send preflights/custody. Hub spans measure whole client calls;
they do not claim to be an HTTP wire trace. Message bodies, signed image URLs,
credentials and AI prompts are excluded. Generation and sending remain explicit.

Tracing is selected when the scan starts. The last eight runs remain in background
memory after closing the follower window; an extension/background restart clears
them. Each run retains at most 100,000 events and 20,000,000 serialized characters
(whichever limit is reached first), with older-event omissions counted visibly.
Save `.txt` before restarting/reloading. A viewer that already loaded a report
can still export its last received snapshot if the background becomes unavailable.
No settings migration or additional Fansly requests are required for diagnostics.

### Checks

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

Release 2.7.1 (E146) adds the new-follower sound on the same page-socket path:
the tap also forwards `serviceId 3 / type 2` follows, the background rings a
follow of one of our models with its own tone and switch (settings v19). No new
permission, no Fansly request, SDK and Core contracts unchanged.

Release 2.7.0 (E145) adds the incoming-message sound: two new `document_start`
content scripts (`content-socket-tap.js` in the MAIN world, `content-sound-relay.js`
isolated) next to the idle bootstrap, the decision and the AudioContext in the
background, settings v18. No new permission, no Fansly request, SDK and Core
contracts unchanged. Tabs opened before the update need a reload.

Release 2.5.1 (E142) adds Split on Fix: the sticky Split flag sends
`preferSplit` with Fix too, and a 2–3 part result opens in the inline panel
with an Insert per part, pinned to its draft. The prompt is Core #268, already
in production; SDK and Core contracts are unchanged.

Release 2.5.0 (E141) moves the hotkeys onto the family scheme shared with the
OnlyFans desktop app (`@chatgoose/hotkeys`, vendored from the hub): ⌘/Ctrl +
E I G P . for everything that writes text, ⌘⇧ / Ctrl+Alt + H S O B L M C for
panels, matched by physical key so the Russian layout works. Ship it together
with the desktop release (a non-updated desktop reads ⌘E as its old Review), with
`SKIP_ANNOUNCE=1`. SDK and Core contracts are unchanged.

Release 2.4.6 adds the two-phase New Followers check (E138, E139): a fast
positive-proof pass followed by one automatic identity/history queue for the
unresolved remainder. Confirmed rows stay usable, selecting a pending fan makes
them next, and pause/continue preserves drafts and verified chat IDs. Pending
rows require confirmed history before generation or sending. Empty technical
chats can be created during verification; messages remain explicit human actions.
The queue shares the creator pacing lane and stops on a rate limit or a series
of transport errors. SDK and Core contracts are unchanged from 2.4.5.

Release 2.4.5 unifies the Hi greeting across both surfaces: one `hi-greeting`
contract (`variantCount`, `personalMessageCount`) replaces the `greetingMode`
flag, one shared greeting context (`src/shared/greeting-context.ts`) and one
welcome-definitions service (`src/background/welcome-definitions.ts`) feed the
chat button and the New Followers window alike. The chat Hi gains the fan's
avatar, username and saved name and labels automated messages; its gate counts
personal messages only, so welcome and mass messages no longer lock a fan out,
while a follower with more than 10 personal messages is refused as a
conversation, not a greeting (E136, E137). Ships on the SDK re-vendored from the
deployed Core `82571f3c` (Core Decision 379).

Release 2.4.4 stops the new-followers window from reading an inbox listing or
search miss as «не писали»: such a row says «Чат не найден», the chat is
resolved by identity (`POST /group`) at «Проверить чат» / «Сгенерировать», a
blocked send is loud, and the scan reads an inbox prefix instead of one search
per fan. The pacer gets its safety patch: jitter on the binding deadline, a
first limit widens the whole lane, a FBuddy-grade cooldown, no upward probing,
a narrow delayed recheck with a fuse (E133, E134, E135). Ships on the SDK
re-vendored from Core `301a127a` (E132).

Release 2.4.3 replaces the follower read scheduler with the Fansly pacer
(`src/background/fansly-pacer/`): a pace policy per route family, a learned
spacing per key, a 400 ms jittered gap on the creator lane, limits that survive
the background page, and one automatic recheck of a row that hit a passing
Fansly error (E130, E131).

Release 2.4.2 takes saved-name reads off the new-follower scan's critical path
(names show from discovery, notes load after the verdicts, best-effort), lets a
Fansly rate-limit penalty decay one level per five quiet minutes followed by
twenty answered reads, and spaces `/account` reads 5 s apart (E128).

Release 2.4.1 fixes premature storage readiness timeouts, leads signed-out
users directly to sign-in across Settings/popup/chat, and prevents a delayed
old-session error from replacing the newly signed-in view. Existing device
credentials and settings are preserved.

Release 2.4.0 replaces the sign-in ceremony: one login and one password, issued
to the chatter as an invite link by the owner, work in both the extension and the
OnlyFans desktop app. The legacy chatter key is removed end to end, and a 401 the
kernel gives a reason for (revoked / expired) now signs this device out by itself
instead of leaving a dead session in place. `start.html` is the shared
«Как начать» page both clients point at.
Release 2.2.1 adds the opt-in new-follower diagnostic journal described above.
The accidentally assigned 2.3.0 number was withdrawn and is retained only in
release history; its implementation is preserved in 2.2.1.
Release 2.2.0 adds the **Новые** button for direct Fansly follower review, explicit
draft generation and one-attempt sending, with the paired Hub new-follower support. Release 2.1.3 is dated
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
Use `SKIP_ANNOUNCE=1 scripts/deploy.sh` to publish without a Telegram announcement;
the local changelog validation still runs before signing.

The scripts upload over SSH to the server that serves `ext.gosling-agency.ru`.
Its address is the `VPS_HOST` default shared by `scripts/deploy.sh`,
`scripts/deploy-pages.sh` and `scripts/setup-vps-ext.sh`. To upload to another
server, set `CHATGOOSE_VPS_HOST=user@host` in the environment; `.env.deploy` is
not read for it.

The public pages ship together: `install.html` becomes the versionless product
landing at `index.html`; `start.html` is the shared onboarding page for both
clients; `whats-new-2.html` is the detailed 2.0 walkthrough; `guide.html`
explains everyday use; `changelog.html` retains version history.
The extension links to both the walkthrough and archive from Settings and the
popup. Both deploy scripts publish the walkthrough before any new entry point
links to it. Keep the fixed 2.0 title and URL independent of future version stamps.
