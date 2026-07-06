> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Options settings page + toolbar popup

Two `browser_action`/extension UI surfaces, both plain DOM (no framework),
both dark-only (`color-scheme: dark`, `src/options/styles.css:12`,
`src/popup/styles.css:12`):

- **Options page** — the full settings screen. Entry `src/options/index.ts`
  (`render()` at line 53, invoked at line 930), mounted into
  `#chatgoose-options-root` (`src/options/index.html:12`), styles injected from
  a bundled CSS string (`injectStyles(optionsStyles)`, `src/options/index.ts:929`).
- **Popup** — the toolbar dropdown. Entry `src/popup/index.ts` (`render()` at
  line 59), mounted into `#chatgoose-popup-root` (`src/popup/index.html:12`).

Both HTML files load Google Fonts (`Outfit`) over the network via
`<link>` (`src/options/index.html:7-9`, `src/popup/index.html:7-9`) and pull
their app version from `browser.runtime.getManifest().version`
(`src/options/index.ts:41`, `src/popup/index.ts:6`), rendered as a pill via
`createVersionTag` (`src/options/dom.ts:61-66`, `src/popup/index.ts:28-33`).

## No vendor AI key or model UI (post-1.6.0)

The options page renders **no vendor AI provider key field, no per-feature
model picker, and no reasoning-effort selector.** After Stage 32 the AI config
is entirely kernel-side; the extension holds no vendor keys. The only
credential fields present are Agency-Hub credentials (device-token sign-in and a
legacy Hub API key — see below), which authenticate to the Agency Hub kernel,
not to any LLM provider.

Two artifacts in the source are stale relative to this and describe UI that is
never rendered:

- The hero subtitle text still reads "Configure AI providers, personalities,
  mappings, and live Fansly connections." (`src/options/index.ts:75`) — there is
  no "AI providers" control on the page.
- A leftover section banner comment `// ─── AI Models ───`
  (`src/options/index.ts:600`) precedes only the debounced settings-save
  closure (`saveSettingsDebounced`, line 602); no "AI Models" section is built
  or appended.
- The `TabUiState` type still carries `modelProviderByFeature` and
  `apiKeyReadyByFeature` fields (`src/shared/types.ts:672-673`), and `PopupStatus`
  extends it, but neither the popup nor the options page reads or renders those
  fields.

## Options page structure

`render()` clears the root (`src/options/index.ts:62`) and appends, in DOM
order:

1. **Hero** (`src/options/index.ts:66-78`) — version pill, `h1`
   "ChatGoose Settings", and the (stale) subtitle.
2. **Generation** section (`createSection('Generation')`, appended line 690).
3. **Agency Hub** section (appended line 691).
4. **Model Personalities** section (appended line 792).
5. **Account Mappings** section (appended line 874).
6. **Connection Status** section (appended line 918).

Sections are built by `createSection(title, description?)`
(`src/options/dom.ts:7-36`); individual controls are wrapped by
`labeledField(labelText, input)` (`src/options/dom.ts:38-47`). Buttons come
from `createButton(label, secondary?, danger?)` (`src/options/dom.ts:49-59`).

Before the first render, `render()` awaits two data sources
(`src/options/index.ts:58-60`): `sendRuntimeRequest('getSessionsSnapshot')`
(live Fansly sessions from the background) and `loadStorageState()`
(persisted settings/personalities/mappings from `storage.local`). Tests pin
that the snapshot request runs **before** the storage read
(`tests/options-accounts.test.ts:152`).

### Generation section — fields

Section title only, no description (`src/options/index.ts:81`). All controls
share one debounced writer (`saveSettingsDebounced`, 350 ms,
`src/options/index.ts:602-638`); each field wires both `input` and `change`
(`src/options/index.ts:640-652`).

| Label | Element | Attrs | Settings key | Sanitizer clamp |
|---|---|---|---|---|
| "Reply + Help message count" | `input[type=number]` | min 5 / max 200 | `quickMessageCount` | `QUICK_MIN..MAX` = 5..200 (`src/options/index.ts:83-88`) |
| "Ping message count" | `input[type=number]` | min 5 / max 200 | `pingMessageCount` | 5..200 (`src/options/index.ts:90-95`) |
| "Fix message count" | `input[type=number]` | min 5 / max 200 | `improveMessageCount` | 5..200 (`src/options/index.ts:97-102`) |
| "Deep feature message count" | `input[type=number]` | min 100 / max 3000 | `deepMessageCount` | 100..3000 (`src/options/index.ts:104-109`) |
| "Enable debug mode" | `input[type=checkbox]` | — | `debugMode` | boolean (`src/options/index.ts:111-113`) |
| "Enable prompt caching" | `input[type=checkbox]` | — | `promptCachingEnabled` | boolean (`src/options/index.ts:115-117`) |

The `min`/`max` HTML attributes are cosmetic; the authoritative clamp is
`sanitizeSettings` (`src/shared/storage.ts:76-108`) against the constants in
`src/shared/constants.ts:54-65`. After each save, the clamped value is written
back into any field the user is **not** currently editing
(`writeCount`, `src/options/index.ts:620-628`); a test drives a `9999` deep
count and asserts the field snaps back to `3000`
(`tests/options-accounts.test.ts:245-260`).

### Agency Hub section — fields

`createSection('Agency Hub', 'Push Fan Summary results to Agency Hub for
durable storage and version history.')` (`src/options/index.ts:146-149`).
Appended controls, in order (`src/options/index.ts:587-598`):

1. **"Agency Hub base URL"** — `input[type=url]`, placeholder
   `http://localhost:3000`, value from `settings.agencyHubBaseUrl`
   (`src/options/index.ts:150-154`) → `agencyHubBaseUrl`.
2. **"Sign in (device token)"** — a row of `Hub username` (`input[type=text]`,
   `autocomplete=username`), `Hub password` (`input[type=password]`,
   `autocomplete=current-password`), and a "Sign in & issue device token"
   button (`src/options/index.ts:514-585`). See the sign-in flow below.
3. **Device-token status line + meta** (`hubSignInStatus`, `hubSignInMeta`) —
   shows "Device token active ✓" vs "No device token yet."
   (`renderHubSignInState`, `src/options/index.ts:534-547`).
4. **"Agency Hub API key (legacy fallback)"** — `input[type=password]`,
   `autocomplete=off`, value from `settings.agencyHubApiKey`, paired with a
   Show/Hide toggle button that flips the input's `type`
   (`src/options/index.ts:156-172`) → `agencyHubApiKey`.
5. **Permission status line + meta** (`agencyHubPermissionStatus`,
   `agencyHubPermissionMeta`) — host-permission state (see below).
6. **Connection status line + meta** (`agencyHubConnectionStatus`,
   `agencyHubConnectionMeta`) — live connection-test state.
7. **Action row** — "Grant Access" (relabeled "Reconnect" once granted,
   `src/options/index.ts:350`) and "Test Connection" buttons
   (`src/options/index.ts:182-196`).

### Model Personalities section

`createSection('Model Personalities')` (`src/options/index.ts:694`). Renders
one card per personality in `state.personalities` (`makeCard`,
`src/options/index.ts:723-769`), each with:

- **"Name"** — `input` (`data-role=name`).
- **"Personality content"** — `textarea` (`data-role=content`, 12 rows).
- **Delete** button — only for non-builtin personalities
  (`src/options/index.ts:745-762`); confirms via `window.confirm`, cancels the
  pending debounced save, flushes current edits, then `deletePersonality` +
  full re-render.

Edits persist through `savePersonalitiesDebounced` (450 ms,
`src/options/index.ts:716-721`), which reads current DOM values via
`collectPersonalityEntries` (`src/options/index.ts:699-714`) and does **not**
re-render — a test asserts the input element is not replaced mid-edit
(`tests/options-accounts.test.ts:200-223`). Builtin flags/versions ride
`data-*` attributes on the card and are round-tripped back into the saved
`Personality` (`src/options/index.ts:704-713`). "Add Personality"
(`src/options/index.ts:773-789`) appends a `crypto.randomUUID()`-keyed blank
entry and re-renders.

### Account Mappings section

`createSection('Account Mappings')` (`src/options/index.ts:795`). One row per
`state.knownAccounts` entry (`src/options/index.ts:811-864`):

- A label block: heading from `formatAccountHeading(accountId, session)` and a
  meta line "Account ID: <resolvedAccountId>" from `formatAccountMeta`
  (`src/options/sessions.ts:8-33`); `session` is looked up from the snapshot via
  `buildSessionLookup` (`src/options/sessions.ts:35-48`).
- A `<select>` whose options are "Unmapped" (value `''`) plus every
  personality; duplicate personality names are disambiguated with a
  6-char id suffix via `personalityOptionLabel`
  (`src/options/index.ts:806-809`; test `tests/options-accounts.test.ts:225-243`).
  Changing it calls `saveAccountMapping(accountId, select.value || null)` then
  re-renders (`src/options/index.ts:851-854`).
- An info line combining the mapped personality label with the
  session `Connected`/`Disconnected` state.

Empty state: "No Fansly accounts detected yet." when `knownAccounts` is empty
(`src/options/index.ts:866-871`).

### Connection Status section

`createSection('Connection Status')` (`src/options/index.ts:877`). Rows come
from `buildConnectionRows(sessions)` (`src/options/sessions.ts:50-67`), which
dedupes by canonical account id keeping the newest `lastSeenAt`
(test `tests/options-accounts.test.ts:161-191`), then sorted by heading. Each
card shows the account heading, a "Connected"/"Disconnected" badge colored via
`--chatgoose-success`/`--chatgoose-danger`, and the "Account ID:" meta line
(`src/options/index.ts:884-908`). Empty state: "No active sessions captured
yet." (`src/options/index.ts:910-915`).

## Device-token sign-in flow (username + password → device token)

Introduced Stage 32 (`src/options/index.ts:513`). The click handler
(`src/options/index.ts:549-578`):

1. Reads `username`, `password`, and the (unsaved) base-URL field; requires all
   three or shows "Enter the Hub base URL, username, and password first."
2. Calls `sendRuntimeRequest('issueAgencyHubDeviceToken', { baseUrl, username,
   password })` (`src/options/index.ts:560-564`).
3. On `ok`, sets an **in-memory sentinel** `state.settings.agencyHubDeviceToken
   = 'set'` (`src/options/index.ts:566`), clears the password field, and shows
   `Device token <keyPrefix>… issued (expires <date>)`. On failure, shows
   `Sign-in failed: <error.message>`.

Boundary — the token itself never crosses back into the page. The background
handler (`src/background/runtime-api.ts:218-253`) drives
`issueAgencyHubDeviceToken` (`src/background/device-token.ts:35-86`), which
logs in over `credentials: 'include'` cookies, calls
`authIssueDeviceToken`, and on success writes the real token straight into
storage with `saveSettings({ agencyHubBaseUrl, agencyHubDeviceToken:
issued.token })` (`src/background/runtime-api.ts:238`). The runtime **response**
carries only `{ ok, keyPrefix, label, expiresAt }`
(`AgencyHubDeviceTokenResponse`, `src/shared/types.ts:719-722`) — never the
token. Thus the options page's `agencyHubDeviceToken` value is only ever the
literal `'set'` sentinel or the loaded stored value; it does not write the
token field itself.

The device token is stored in the same `settings` record and custody class as
the legacy key (`Settings.agencyHubDeviceToken`, `src/shared/types.ts:19-21`;
default `''`, `src/shared/migrations.ts:15`). The kernel dual-accepts both and
prefers the device token when present.

## Agency Hub connection (base URL, test, host-permission grant)

### Host-permission grant (optional_host_permissions)

The permission grant is issued **directly from the options page**, not through
the background. The "Grant Access" handler
(`src/options/index.ts:439-499`) builds an origin pattern with
`buildAgencyHubOriginPattern` (`src/shared/agency-hub.ts:28-36`, e.g.
`http://localhost/*` — host-scoped, port dropped) and calls
`browser.permissions.request({ origins: [originPattern] })`
(`src/options/index.ts:456`). Regardless of grant/deny it then saves the
normalized URL + trimmed key, refreshes the permission state, and re-runs the
connection test. A test asserts `permissions.request` fires **before** the
`storage.set` for settings (`tests/options-agency-hub.test.ts:255-296`).

Permission state is read (not requested) via `getAgencyHubPermissionCheck` →
`browser.permissions.contains({ origins: [originPattern] })`
(`src/options/agency-hub-settings.ts:66-88`); when `contains` is absent the
check reports `granted: true` (`agency-hub-settings.ts:73-75`). The status line
distinguishes: no URL, invalid URL, not-granted, `denied`, `request_error`,
`unsupported`, granted-but-no-API-key, and the ready state
(`src/options/index.ts:333-437`). Because Firefox grants per host (not per
port), a note explains that `<origin>/*` covers a port-bearing configured URL
(`buildAgencyHubPermissionScopeNote`, `src/options/agency-hub-settings.ts:37-56`).
The page also subscribes to `browser.permissions.onAdded`/`onRemoved` to
re-check on external permission changes (`src/options/index.ts:669-689`),
cleaned up on the next render (`cleanupTasks`, `renderCleanup`,
`src/options/index.ts:920-923`).

### Live connection test

`runAgencyHubConnectionTest` (`src/options/index.ts:262-330`) calls
`sendRuntimeRequest('testAgencyHubConnection', { settings: { agencyHubBaseUrl,
agencyHubApiKey (trimmed), agencyHubDeviceToken } })`
(`src/options/index.ts:292-298`); the device-token value comes from
`state.settings.agencyHubDeviceToken`. The background handler
(`src/background/runtime-api.ts:194-216`) delegates to
`agencyHubClient.testConnection(...)`; the response is
`{ ok: boolean; error?: UserFacingError }` (`src/shared/types.ts:765-768`).
Feedback states are `idle | pending | testing | connected | failed`
(`AgencyHubConnectionFeedback`, `src/options/agency-hub-settings.ts:17-22`) and
render into the status/meta lines (`src/options/index.ts:201-239`). The test
auto-runs on load (`src/options/index.ts:926`) and after any Hub-signature
change (`src/options/index.ts:630-637`). A signature
(`buildAgencyHubConnectionSignature`, `agency-hub-settings.ts:58-60`) suppresses
redundant re-tests.

Notable gating behavior: both the "Test Connection" button's enablement and the
`idle`/`pending` transitions require **both** the base URL and the legacy API
key to be non-empty — `hasAgencyHubConnectionInputs(baseUrl, apiKey)` checks
`apiKey.trim()` (`src/options/agency-hub-settings.ts:62-64`; button disabled at
`src/options/index.ts:205-206`). So a device-token-only configuration (URL +
token, no legacy key) leaves the connection test **idle and the button
disabled**, and the permission status shows "Sync disabled: Agency Hub API key
missing." (`src/options/index.ts:423-430`) even though sync can work off the
token. The device token is still sent in the test payload; it just does not
satisfy the has-inputs gate.

## What is written to storage.local

All writes go through the `src/shared/storage.ts` helpers, which sanitize on
the way in. The options page never writes raw objects directly.

- **`settings`** — via `saveSettings(patch)` (`src/shared/storage.ts:110-115`),
  which merges the patch over existing settings and runs `sanitizeSettings`
  (`src/shared/storage.ts:76-108`: URL normalized, keys trimmed, counts clamped,
  booleans coerced). Patches the options page emits:
  - `saveSettingsDebounced` writes `agencyHubBaseUrl`, `agencyHubApiKey`,
    `quickMessageCount`, `pingMessageCount`, `improveMessageCount`,
    `deepMessageCount`, `debugMode`, `promptCachingEnabled`
    (`src/options/index.ts:603-612`).
  - `persistAgencyHubSettings` writes `agencyHubBaseUrl`, `agencyHubApiKey`
    (`src/options/index.ts:253-260`).
  - Grant-Access handler writes normalized `agencyHubBaseUrl` + trimmed
    `agencyHubApiKey` (`src/options/index.ts:488`).
  - The two settings fields the options page never patches:
    `agencyHubDeviceToken` (written only by the background token handler,
    `src/background/runtime-api.ts:238`) and `spendersLegacyRebuild`
    (a hidden, UI-less storage-only fallback flag, `src/shared/types.ts:22-25`).
    `saveSettings` preserves both across a merge.
- **`personalities`** — via `savePersonalities` (`src/shared/storage.ts:117-123`),
  which normalizes and reconciles bundled personalities. Written on debounced
  edit, add, and delete.
- **`accountMappings`** — via `saveAccountMapping(accountId, personalityId |
  null)` (`src/shared/storage.ts:148-167`), which resolves the canonical account
  id and clears alias keys before setting.
- **`deletePersonality`** (`src/shared/storage.ts:125-146`) additionally writes
  `personalities` + `accountMappings` and removes cached summary keys for the
  deleted personality.

`loadStorageState` (`src/shared/storage.ts:50-74`) may also write back a
migrated/reconciled state on load (schema-version bump or bundled-personality
reconcile).

## The popup

`src/popup/index.ts` renders on load (`render()`, line 59). It calls
`sendRuntimeRequest('getPopupStatus')` with **no payload**
(`src/popup/index.ts:62`), so the background resolves the active current-window
tab rather than a passed `tabId` (`src/background/runtime-api.ts:54-72`). The
response is a `PopupStatus` (`src/shared/types.ts:681-683`, extends
`TabUiState`).

Rendered content (`src/popup/index.ts:70-114`):

- Eyebrow "ChatGoose", then `status.accountLabel` as the headline. The label is
  computed server-side as the mapped personality name, else "Unmapped account",
  else "Not connected" (`src/background/runtime-api.ts:134-136`).
- Sub-line: "Fansly session connected" when `status.connected`, else
  "Connection not established" (`src/popup/index.ts:90`).
- A panel with two rows: `Account: <status.accountId ?? 'Not connected'>` and
  `Conversation: <status.groupId ?? 'No active chat'>`
  (`src/popup/index.ts:102-107`).
- An "Open Settings" button calling `browser.runtime.openOptionsPage()`
  (`src/popup/index.ts:109-112`).

If the runtime request throws (background asleep/reloading), `render()` catches
and calls `renderUnavailable` (`src/popup/index.ts:35-57`): headline
"ChatGoose", message "Couldn't reach ChatGoose. Reopen this popup after it
reconnects.", and the same "Open Settings" button. Tests cover both the normal
label render and the unreachable fallback (`tests/popup.test.ts:51-66`).

The popup shows **no** AI provider/model/key controls and issues no writes; it
is read-only status plus a single navigation button. (The background does derive
`PopupStatus.hasApiKey` as "kernel lane configured" — normalized Hub base URL
plus either a device token or the legacy key, `src/background/runtime-api.ts:125-128`
— but the popup does not read that field.)

## Runtime-message boundary summary

Commands the popup/options page send via `sendRuntimeRequest`
(`src/shared/protocol.ts:270-288`; map in `src/shared/types.ts:696-710`):

| Command | Sent by | Request | Response |
|---|---|---|---|
| `getSessionsSnapshot` | options (`index.ts:58`) | none | `SessionSnapshotEntry[]` |
| `getPopupStatus` | popup (`index.ts:62`) | optional `tabId` (popup omits it) | `PopupStatus` |
| `testAgencyHubConnection` | options (`index.ts:292`) | `{ settings: { agencyHubBaseUrl, agencyHubApiKey, agencyHubDeviceToken } }` | `{ ok, error? }` |
| `issueAgencyHubDeviceToken` | options (`index.ts:560`) | `{ baseUrl, username, password }` | `{ ok, keyPrefix, label, expiresAt }` or `{ ok:false, error }` |

Host-permission requests (`browser.permissions.request`) and reads
(`browser.permissions.contains`) are **not** runtime messages — the options page
calls the WebExtension `permissions` API directly
(`src/options/index.ts:456`, `src/options/agency-hub-settings.ts:79`).
