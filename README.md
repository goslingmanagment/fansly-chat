# ChatGoose

Firefox extension for agency chatters working in Fansly DMs. It adds reply,
coaching, fan-summary, review, ping, greeting, and spenders-board tools directly
to the Fansly interface.

For development against Fansly, start with [the Fansly development guide](docs/fansly-development.md):
Chrome DevTools MCP, the downloaded bundle, chat DOM/lifecycle, API/WebSocket
research and the relevant source files in this client.

## Current architecture

ChatGoose is a client of the Agency Hub kernel in `../hub`:

- Fansly conversation data is read live from the page DOM/API in the chatter's
  browser session. Credentials remain in memory and are not copied into the Hub.
- AI generations go only through the kernel feature lane
  (`POST /api/v1/ai/features/:feature`). The extension contains no provider API
  keys, vendor AI SDKs, or prompt library.
- The transcript a generation sends (`clientContext.transcript`) is in UTC:
  `[HH:MM]` and a `--- YYYY-MM-DD ---` line before each day's first message,
  never the chatter's own clock (E168, the hub's format since hub #622).
  Every request says so (`clientContext.transcriptClock: 'utc'`).
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
  A fan Fansly will not let the model DM (a paid DM, or rules the model does
  not meet: Fansly's own check of the chat's `dmPermissionFlags`,
  `src/shared/fansly-dm-permissions.ts`) is «Нельзя написать» with the reason,
  and nothing is generated or sent; the chatter may exclude such a fan from
  «К обработке» in this browser (2.8.1, E155).
- **Fansly через вкладку** (2.7.2, E149) — an opt-in switch («Генерация» →
  «Служебное») for a chatter without a system-wide VPN. Firefox gives the
  background's requests no tab, so Multi-Account Containers' per-container proxy
  never applies to them and they leave from the chatter's own address (from a
  Russian line, CloudFront freezes such a connection after ~8–17 KB). With the
  switch on, the content bootstrap mounts a hidden extension frame
  (`fansly-relay.html`, in a closed shadow root) in every Fansly tab; the
  background hands it each ready request (`src/background/fansly-transport.ts`)
  and the request leaves through that tab's container proxy, per model.
  Pacing, retries and the one-attempt write rule are unchanged; a send checks
  the route before it takes any custody. Off by default.
- **Spenders** — kernel-backed ranking with data freshness and deleted-account labels.
- **Дата регистрации фана** (2.8.0, E152) — «Регистрация» in Fansly's own chat
  header row, after Gallery: a click shows when the fan registered and how long
  ago. The date is decoded from the fan's account id, a snowflake
  (`src/shared/fansly-id-time.ts`), never fetched. Learning the id is free
  after a generation in the chat and one attempt of `GET /group/<id>`
  otherwise (no retries, nothing during a rate-limit cooldown), so nothing is
  read until the chatter clicks; the answer stays until the page reloads or
  the tab changes account. One-to-one chats only
  (`src/content/fan-registration.ts`).
- **Заметки** (2.9.0, E157; AI fill 2.10.0, E159; merge and quotes 2.11.0, E164; fields 2.12.0, E166) — the fan's native Fansly notes (what Fansly's own «Edit
  User Notes» modal shows, two clicks deep in the name menu) in a ChatGoose
  panel: «Заметки» after «Регистрация» in the header row, or ⌘⇧K /
  Ctrl+Alt+K. Regular notes (contentType 12000) are listed, added, edited and
  deleted with an in-card confirmation; the custom name (12002) is the
  panel's title, edited in place; «+ Анкета» starts the agency's
  questionnaire (offered while the fan has none). A questionnaire reads as a
  table (the label, its facts one per line, the month a fact was said at the
  right, empty fields folded into one line) and is edited as fields, one fact
  per line; «Текстом» shows the one text Fansly stores, which is what the
  fields read and write (E166). Three views, chosen
  in the panel and kept in settings (`fanNotesView`, v21): «Всегда справа»
  docks in the empty column Fansly leaves right of the chat and reads each
  opened chat once it stayed open 0.7 s; «Справа по кнопке» (default) and
  «Окно по центру» read nothing until opened. A read is the group read (only
  when the fan is not known yet) plus `GET /account?ids=`, one attempt each,
  none during a rate-limit cooldown, kept for the tab's lifetime; writes are
  Fansly's own `POST /notes`, `/notes/edit`, `/notes/delete`, one attempt on an
  explicit save or delete; an edit is confirmed by `success`, as Fansly's own
  modal confirms it (E170). Every free note shows its creation date from
  Fansly's `createdAt` in its head; Fansly keeps no edit time (E171).
  Chatter-eyes-only: the custom name and free notes
  never reach a prompt; the questionnaire's labels and values go to Core for
  the fill only (E164) (`src/content/fan-notes/`, `src/shared/fan-notes.ts`).
  «✨ Дополнить из чата» (E159, E164; «✨ Заполнить из чата» until E166) on a
  questionnaire (a note of `Label: value` lines), being read or edited, runs
  the kernel feature `fan-notes-fill` (Sonnet by
  default) over the whole chat, read like a full Recap; it dates its facts
  from the transcript's day lines. It sends the labels with the
  chatter's current values (`noteFields` + `noteValues`; a value over 2 000
  characters is left out) and the template labels the note lacks. Empty
  fields are filled and new lines (template fields, a field the AI names
  itself, with «В Другое») go straight into the draft; a filled field is
  never overwritten — a rewrite is offered under that field as the facts it
  adds or drops, with «Принять» — except «Другое», which takes a fact moved
  out of another field straight away. The fields the fill wrote are marked. Core answers an unchanged field `Label: =`, so the answer
  does not grow with the questionnaire. Each fact comes with the fan's own words and the date the
  extension found them in the chat it sent («не нашлось в переписке»
  otherwise); quotes are shown, never saved. Nothing is saved until the
  chatter saves the note.
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

- [AGENTS.md](AGENTS.md) — binding engineering rules and invariants;
- [docs/decisions.md](docs/decisions.md) — append-only architecture decisions;
- `docs/generated/` — point-in-time code maps; check each file's snapshot SHA
  before relying on line numbers or current-state claims;
- [SPEC_FINAL.md](SPEC_FINAL.md) — historical v1.3 product/UX intent, not current
  architecture.

## Release

Release 2.12.1 (E168, E169) sends every generation's transcript in UTC with a
`--- YYYY-MM-DD ---` line before each day's first message, and every request
says so (`clientContext.transcriptClock: 'utc'`), so Core's `Now:` line calls
the times UTC instead of the chatter's device clock. Core's half (hub #622,
#628) is in production with hub #643 (`305f4e18`, contract `d4e21741…`); the
SDK was re-vendored from that commit. No new permission. Tabs opened before
the update need a reload.

Release 2.12.0 (E166, E167) reshapes the notes panel: a questionnaire reads
as a table and is edited as fields, the fill's rewrites sit under their
fields, the custom name is the panel's title, «✨ Заполнить из чата» is now
«✨ Дополнить из чата». Core's `fan-notes-fill` merge prompt puts one fact in
one field and keeps purchases in «Медиа» (hub #601), deployed as production's
commit plus that change alone (`c2b1843c5eaa`); the contract is unchanged
(`663d132f…`), so the SDK was not re-vendored. No new permission. Tabs opened
before the update need a reload.

Release 2.11.0 (E164, E165) makes «✨ Заполнить из чата» merge into the
questionnaire instead of overwriting it and show the fan's own words behind
each fact: Core's `fan-notes-fill` merge mode (hub #593, Core `bc0f6dbc`),
the questionnaire's values travel to Core (`noteValues`), the template gains
«График», «Планы и даты», «Другое». SDK re-vendored from the deployed Core
(contract `663d132f…`); Core keeps serving the SDK of 2.10.1 (`a6f77fbb…`).
No new permission. Tabs opened before the update need a reload.

Release 2.10.1 (E159, E160, E161; 2.10.0 was signed but never served) adds
«✨ Заполнить из чата» to the notes panel:
the Core feature `fan-notes-fill` (Sonnet 5.5 by default, Core `a3449f77`,
#572) fills a questionnaire from the whole chat. SDK re-vendored from the
deployed Core (contract `a6f77fbb…`); Core keeps serving the SDK of 2.8.1 and
2.9.0 (`030124…`). No new permission. Tabs opened before the update need a
reload.

Release 2.9.0 (E157, E158) adds the fan-notes panel: Fansly's own notes and
custom name, read and written with Fansly's `/account?ids=` and `/notes*`
calls on the follower lane. Settings v21 (`fanNotesView`, default on demand);
hotkey scheme 2 (⌘⇧K / Ctrl+Alt+K, client `fansly`), vendored from hub
`0a96105d`. No new permission, SDK and Core contracts unchanged. Tabs opened
before the update need a reload.

Release 2.8.0 (E152) adds the fan's registration date to the chat header: a
click on «Регистрация» decodes it from the fan's account id. At most one
attempt of `GET /group/<id>` per click, none after a generation in the chat.
No new permission, no settings change, SDK and Core contracts unchanged. Tabs
opened before the update need a reload.

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
Its address is the `VPS_HOST` default shared by `scripts/deploy.sh` and
`scripts/deploy-pages.sh`. To upload to another server, set
`CHATGOOSE_VPS_HOST=user@host` in the environment; `.env.deploy` is not read
for it. The scripts only put files into `/var/www/ext`; the nginx site that
serves them is described under [The site on the server](#the-site-on-the-server).

Before anything is signed or uploaded, `scripts/deploy.sh` (the release and
`--pages-only`) and `scripts/deploy-pages.sh` check that this server is the one
behind the public name: they write a one-off marker file into the site
directory over SSH, read it back through `https://ext.gosling-agency.ru` and
remove it (E148). The run goes on only if the marker comes back. Otherwise it
stops there and says which case it was: another server answers for the name,
the site refuses the request, or the name could not be reached. The check
passes whether DNS points at the server or another server forwards the name
to it.

The public pages ship together: `install.html` becomes the versionless product
landing at `index.html`; `start.html` is the shared onboarding page for both
clients; `whats-new-2.html` is the detailed 2.0 walkthrough; `guide.html`
explains everyday use; `changelog.html` retains version history.
The extension links to both the walkthrough and archive from Settings and the
popup. Both deploy scripts publish the walkthrough before any new entry point
links to it. Keep the fixed 2.0 title and URL independent of future version stamps.

Chatters read the pages at `https://chatgoose.gosling-agency.ru/fansly/`, one
level below the common home of the ChatGoose clients (E154). That site belongs
to `~/code/1-platform/agency-site` (its README, «Addresses»): its nginx serves
the files this repository publishes, and the page addresses on
`ext.gosling-agency.ru` redirect there. The header logo of every page links to
the home as `../`, and `start.html` links to the desktop page as `../desktop/`.
Keep a link to a neighbouring page relative, with no host in it. The install
link is the exception: `/fansly/` serves only the pages and `mascot.png`, so
the XPI keeps its `ext.gosling-agency.ru` address. The copy of the `ext.` site
in the next section was read before that redirect was added and does not show
it.

### The site on the server

Nothing in this repository creates or rewrites the nginx site for
`ext.gosling-agency.ru` (E147). The site is one file on the server,
`/etc/nginx/sites-available/ext.gosling-agency.ru`. It is edited there, and a
server move copies it across: the move to agency-de in 2026-10 did that with
`migrate/70-ext-feed.sh` from
`~/code/8-docs/2026-10-10-server-migration-netcup/`, which also added the
`/u/` location. That folder is not a repository, so this section keeps a copy
of the file.

The deploy scripts need four things from the site:

- `/updates.json` is served as JSON and is never cached. Firefox polls it for
  updates.
- Every `*.xpi` is served as `application/x-xpinstall`, so Firefox offers to
  install it. A versioned XPI never changes, so it may be cached for a year.
- `/chatgoose-latest.xpi` is the exception: the landing's install button
  downloads it and every release replaces it, so it is never cached.
- `/` answers with `index.html`; the other pages are plain files.

Two other projects publish into the same site, and an edit has to keep their
paths: chat-extension under `chat-extension/`, and onlyfans-chat under
`desktop/` plus the Windows update feed, which the site serves from
`/srv/chatgoose-updates` under `/u/`.

The file as read from agency-de on 2026-10-11:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name ext.gosling-agency.ru;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ext.gosling-agency.ru;
    root /var/www/ext;
    location /u/ { root /srv/chatgoose-updates; try_files $uri =404; }
    index index.html;

    ssl_certificate /etc/letsencrypt/live/ext.gosling-agency.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ext.gosling-agency.ru/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location = /updates.json {
        default_type application/json;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        try_files $uri =404;
    }

    location = /chatgoose-latest.xpi {
        default_type application/x-xpinstall;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        try_files $uri =404;
    }

    location ~ \.xpi$ {
        default_type application/x-xpinstall;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }

    location = / {
        try_files /index.html =404;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
```

While the site is being moved between servers, the live file also has four
lines that answer 403 to everyone except the previous server:
`set_real_ip_from`, `real_ip_header`, `real_ip_recursive` and an `if` on
`$realip_remote_addr`. They are removed when DNS is switched and are left out
above.

The certificate is from Let's Encrypt; certbot renews it with the webroot
method over `/var/www/ext`. On a server that has no certificate yet, nginx
cannot load the HTTPS block: serve `/var/www/ext` over plain HTTP first, issue
the certificate, then install the file above.

If the server and this section disagree, the server is right: correct the
section.
