# Map: Options Page & Toolbar Popup

## Scope

This document maps the two standalone extension pages of ChatGoose and their local helper modules. Files covered (all read in full from source):

- `src/options/index.ts` (~1057 lines — the entire options UI, imperatively built)
- `src/options/index.html`
- `src/options/dom.ts`
- `src/options/sessions.ts`
- `src/options/agency-hub-settings.ts`
- `src/options/styles.css`
- `src/popup/index.ts`
- `src/popup/index.html`
- `src/popup/styles.css`

Supporting modules are referenced only to trace boundary crossings (`src/shared/storage.ts`, `src/shared/protocol.ts`, `src/shared/agency-hub.ts`, `src/shared/types.ts`, `src/shared/constants.ts`, `src/shared/model-registry.ts`, `src/background/runtime-api.ts`). The four external network boundaries themselves are contracted in `docs/project-kernel/boundaries.md`; this doc describes how these page files touch them (which runtime message they send, not the wire contract).

---

## 1. Distribution / registration (`manifest.json`)

Both pages are declared in the extension manifest (`manifest.json:38-49`):

| Manifest key | Value | Bundle entry |
| --- | --- | --- |
| `action.default_popup` | `"popup.html"` | HTML `src/popup/index.html` → loads `./popup.js` (built from `src/popup/index.ts`) |
| `action.default_title` | `"ChatGoose"` | toolbar button tooltip |
| `options_ui.page` | `"options.html"` | HTML `src/options/index.html` → loads `./options.js` (built from `src/options/index.ts`) |
| `options_ui.open_in_tab` | `true` | options open in a full tab, not an embedded panel |

Both HTML files are minimal shells: a single root `<div>` plus one `<script src>` (`options.js` / `popup.js`). Each imports its `styles.css` as a text string in the corresponding `index.ts` (`import optionsStyles from './styles.css'`, `import popupStyles from './styles.css'`) and injects it at runtime via a `<style>` element.

### Discrepancies (HTML)

- Both `index.html` files declare `<link rel="preconnect">` to `fonts.googleapis.com` / `fonts.gstatic.com` and a `<link rel="stylesheet">` loading the **Outfit** web font (`options/index.html:7-9`, `popup/index.html:7-9`). This is an **external network fetch** at page load. However, neither `styles.css` nor any inline style ever sets `font-family: 'Outfit'` — `body` uses `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif` (`options/styles.css:19`, `popup/styles.css:19`) and `h1`/`h2` do not override it. The Outfit font is therefore fetched but never applied.

---

## 2. Options page — `src/options/index.ts`

Single-file imperative UI. No framework; every element is created with `document.createElement` and inline `style.*` assignments, with a shared `.css` for class-based styling.

### 2.1 Bootstrap & module-level state

- `rootElement = document.getElementById('chatgoose-options-root')` (`index.ts:45`); throws `'Missing options root'` if absent (`index.ts:48-50`).
- `extensionVersion = browser.runtime.getManifest().version` (`index.ts:46`) — **browser-api** read; rendered as a version pill.
- Module-level mutable state (persists across `render()` calls):
  - `renderCleanup: (() => void) | null` (`index.ts:54`) — teardown for the previous render (removes permission listeners).
  - `agencyHubPermissionFeedback: AgencyHubPermissionFeedback | null` (`index.ts:55`).
  - `agencyHubConnectionFeedback: AgencyHubConnectionFeedback` (`index.ts:56`), initialized `{ kind: 'idle' }`.
- Entry point (bottom of file): `injectStyles(optionsStyles); void render();` (`index.ts:1056-1057`).

### 2.2 `render()` (`index.ts:58-1054`)

`async function render()` rebuilds the entire page from scratch on every call. Flow:

1. Runs `renderCleanup?.()` then nulls it (`index.ts:59-60`).
2. `cleanupTasks: Array<() => void>` local list (`index.ts:62`).
3. **Data fetch (two awaits):**
   - `sessions = await sendRuntimeRequest('getSessionsSnapshot')` (`index.ts:63`) — **IPC** one-shot runtime message; returns `SessionSnapshotEntry[]`. (Background handler at `runtime-api.ts:138-190` may enrich unresolved sessions via Fansly API and rekey/reconcile known accounts as a side effect.)
   - `state = await loadStorageState()` (`index.ts:64`) — **storage** read of all of `browser.storage.local` (`storage.ts:62-86`); may itself write back migrated state / reconciled bundled personalities.
   - `sessionsByAccountId = buildSessionLookup(sessions)` (`index.ts:65`, from `sessions.ts`).
4. `root.replaceChildren()` then builds sections in DOM order:
   1. Hero (title `ChatGoose Settings`, subtitle, version tag)
   2. API Configuration
   3. Agency Hub
   4. AI Models
   5. Model Personalities
   6. Account Mappings
   7. Connection Status
5. Sets `renderCleanup` to run all `cleanupTasks` (`index.ts:1047-1050`).
6. Trailing side effects: `await refreshAgencyHubPermissionState(); await runAgencyHubConnectionTest({ force: true });` (`index.ts:1052-1053`).

`render()` is re-invoked by: adding a personality (`index.ts:915`), deleting a personality (`index.ts:886`), and changing an account mapping (`index.ts:980`). Otherwise settings persist in place without a re-render (see debounced savers below).

### 2.3 API Configuration section (`index.ts:86-181`, `816`)

Built via `createSection('API Configuration')`. Controls and the `Settings` field each maps to:

| UI control | Type | `Settings` field | Notes |
| --- | --- | --- | --- |
| `keyInput` | password input + `Show/Hide` toggle | `claudeApiKey` | value seeded from `state.settings.claudeApiKey`; toggle flips input `type` (`index.ts:87-102`) |
| `openRouterKeyInput` | password input + toggle | `openRouterApiKey` | `index.ts:104-119` |
| `quickInput` | number (min 5, max 200) | `quickMessageCount` | label **"Reply + Help message count"** (`index.ts:121-126,175`) |
| `pingInput` | number (min 5, max 200) | `pingMessageCount` | label "Ping message count" (`index.ts:128-133,176`) |
| `improveInput` | number (min 5, max 200) | `improveMessageCount` | label **"Fix message count"** (`index.ts:135-140,177`) |
| `deepInput` | number (min 100, max 3000) | `deepMessageCount` | label "Deep feature message count" (`index.ts:142-147,178`) |
| `debugInput` | checkbox | `debugMode` | label "Enable debug mode" (`index.ts:149-151,157-162`) |
| `promptCachingInput` | checkbox | `promptCachingEnabled` | label "Enable prompt caching" (`index.ts:153-155,164-172`) |

The `min`/`max` HTML attributes are advisory; authoritative clamping happens in `sanitizeSettings` (`storage.ts:88-141`) using `QUICK_MIN/MAX_MESSAGE_COUNT=5/200`, `PING_*=5/200`, `IMPROVE_*=5/200`, `DEEP_*=100/3000` (`constants.ts:109-120`). After save the clamped value is written back into the field unless it is the active element (`index.ts:727-735`).

### 2.4 Agency Hub section (`index.ts:183-558`, `817`)

Built via `createSection('Agency Hub', 'Push Fan Summary results to Agency Hub for durable storage and version history.')`. This is the most stateful part of the page: two independent state machines (host **permission** state and live **connection** state) plus save-on-edit.

**Controls:**
- `agencyHubUrlInput` — `type=url`, placeholder `http://localhost:3000`, seeded from `state.settings.agencyHubBaseUrl` (`index.ts:188-192`).
- `agencyHubKeyInput` — password + `Show/Hide` toggle, seeded from `state.settings.agencyHubApiKey` (`index.ts:194-210`).
- Permission status/meta `<div>`s + `agencyHubPermissionButton` (label toggles `Grant Access` / `Reconnect`) (`index.ts:212-220,387`).
- Connection status/meta `<div>`s + `agencyHubConnectionButton` (`Test Connection`) (`index.ts:221-234`).
- Local render state: `agencyHubConnectionVersion` (monotonic race guard), `lastAgencyHubConnectionSignature` (dedupe key) (`index.ts:236-237`).

**Connection state machine** (`AgencyHubConnectionFeedback`, defined in `agency-hub-settings.ts:17-22`):
- `renderAgencyHubConnectionState()` (`index.ts:239-277`) — renders one of `idle | pending | testing | connected | failed`; disables the Test button when `testing` or when inputs are incomplete (`hasAgencyHubConnectionInputs`). `failed` shows `error.code` + `error.message` + `getUserErrorDescription(error)`.
- `markAgencyHubConnectionPending()` (`index.ts:279-289`) — bumps version, sets `idle` if inputs are blank else `pending`, clears signature.
- `persistAgencyHubSettings()` (`index.ts:291-298`) — `saveSettings({ agencyHubBaseUrl, agencyHubApiKey })` (**storage** write of `settings`) and reflects the sanitized values back into the inputs.
- `runAgencyHubConnectionTest({ force?, saveFirst? })` (`index.ts:300-367`):
  - Computes `signature = buildAgencyHubConnectionSignature(url, key)` (`normalize(url)|key.trim()`).
  - Short-circuits to `idle` if inputs incomplete; short-circuits (no test) if `!force && signature === lastAgencyHubConnectionSignature`.
  - Bumps `agencyHubConnectionVersion`, sets `testing`, optionally `persistAgencyHubSettings()` first.
  - **IPC:** `sendRuntimeRequest('testAgencyHubConnection', { settings: { agencyHubBaseUrl: <raw input>, agencyHubApiKey: <trimmed> } })` (`index.ts:330-335`). Background handler `runtime-api.ts:192-214` calls `agencyHubClient.testConnection` with an `AbortController` timeout (`AGENCY_HUB_PREFETCH_TIMEOUT_MS`).
  - Version guard drops stale responses. On success sets `connected` (with normalized `baseUrl`); on `!response.ok` sets `failed` with `response.error ?? createUserError('hub_request_failed')`. On thrown error logs and sets `failed` with `createUserError('hub_request_failed', { description: 'The connection test could not be completed.' })`.

**Permission state machine** (`AgencyHubPermissionFeedback`, `agency-hub-settings.ts:12-15`):
- `refreshAgencyHubPermissionState()` (`index.ts:369-474`) — the large status renderer:
  - `refreshVersion` guard (`agencyHubPermissionRefreshVersion`) drops stale async runs.
  - `originPattern = buildAgencyHubOriginPattern(normalizedBaseUrl)` → `"<protocol>//<hostname>/*"` (port stripped, `agency-hub.ts:28-36`).
  - `permissionCheck = await getAgencyHubPermissionCheck(originPattern)` (**browser-api** `browser.permissions.contains`, see §5).
  - Button label = `granted ? 'Reconnect' : 'Grant Access'`; disabled when no origin pattern.
  - Status text branches (each with a `permissionScopeNote` appended via `appendAgencyHubMeta`): no URL → "Sync disabled: add an Agency Hub URL."; invalid URL → "Sync disabled: invalid Agency Hub URL."; not granted with various sub-cases (verify error, prior `denied`/`request_error`/`unsupported` feedback, `browser.permissions.request` unavailable, generic "Grant access for …"); granted but no API key → "Sync disabled: Agency Hub API key missing."; fully ready → "Sync ready: ChatGoose can push fan summaries."

**Button handlers:**
- `agencyHubPermissionButton` click (`index.ts:476-536`): normalizes URL + trims key, builds origin pattern; disables button; if `browser.permissions.request` exists calls `browser.permissions.request({ origins: [originPattern] })` (**browser-api**, user-facing permission prompt), else records `unsupported`. On resolution records `denied`/`request_error`/clears feedback, then `saveSettings(settingsPatch)` (**storage**), then `refreshAgencyHubPermissionState()` + `runAgencyHubConnectionTest({ force: true })`.
- `agencyHubConnectionButton` click (`index.ts:538-548`): `persistAgencyHubSettings()` → refresh → force test.

**Input listeners** (`index.ts:768-783`): `input`/`change` on both URL and key inputs call `markAgencyHubConnectionPending()` + `refreshAgencyHubPermissionState()`. (These two inputs are ALSO wired into the generic `saveSettingsDebounced` list at `index.ts:747-761`.)

**Permission change listeners** (`index.ts:784-804`): if `browser.permissions.onAdded`/`onRemoved` addListener/removeListener all exist, registers `handlePermissionChanged` (clears feedback, refresh + force test) on both events and pushes their removal into `cleanupTasks`. This is the only entry added to `cleanupTasks`.

### 2.5 AI Models section (`index.ts:560-818`)

Built via `createSection('AI Models', 'Pick which AI model each feature uses. Claude models use the Anthropic key; Gemini and Grok use the OpenRouter key.')`.

- `FEATURE_ROWS` (`index.ts:566-572`) — five `ModelSelectableFeatureType` rows: `fast-reply` ("Fast Reply"), `ping` ("Ping"), `help-me` ("Help Me"), `chat-review` ("Chat Review"), `fan-summary` ("Fan Summary"), each with helper copy. Note: `improve-draft` and `hi-greeting` are excluded from `ModelSelectableFeatureType` (`types.ts:11`) and therefore have **no** model/reasoning selector.
- `REASONING_LABELS: Record<ReasoningEffort,string>` — `off/low/medium/high/max` → `Off/Low/Medium/High/Max` (`index.ts:574-580`).
- For each feature row: a **model** `<select>` populated from `AI_MODEL_GROUPS` (`index.ts:611-624`) — `<optgroup>` per group (`Anthropic Direct`, `OpenRouter` — `model-registry.ts:164-179`), option text `"${model.label} — ${model.description}"`, `option.title = model.pricingNote` when present. `select.dataset.feature = feature`; `select.value = state.settings.featureModels[feature]`.
- A **reasoning** `<select>` populated from `REASONING_EFFORTS` (`constants.ts:45`); `dataset.reasoningFeature = feature`; `value = state.settings.featureReasoning[feature]`. Kept in `reasoningSelectsByFeature` map (`index.ts:584,640`).
- `updateReasoningCapability(feature, modelId)` (`index.ts:667-683`): `supportsModelReasoningConfig(modelId, feature)` (`model-capabilities.ts:61`) toggles `reasoningSelect.disabled`, `dataset.reasoningSupported`, `aria-disabled`, and a title tooltip ("Reasoning is not supported for this selected model and feature.").
- `openRouterWarning` div + `renderOpenRouterWarning()` (`index.ts:585-604,691`): shows "OpenRouter model selected: add an OpenRouter API key before using those features." iff any model select is an OpenRouter selection (`isOpenRouterModelSelection`, `model-registry.ts:224`) AND `openRouterKeyInput.value` is blank.
- Model select `change` handler (`index.ts:805-814`): re-runs `updateReasoningCapability`, `renderOpenRouterWarning`, `saveSettingsDebounced`.

### 2.6 Debounced settings save (`index.ts:694-767`)

`saveSettingsDebounced = debounce(async () => {...}, 350)` (`index.ts:694-745`) collects EVERY API-config + model control into one `saveSettings` call — this is the primary persistence path for the whole top of the page:

Fields written (all into the single `settings` storage key via `saveSettings`, `storage.ts:143-148`): `claudeApiKey`, `openRouterApiKey`, `agencyHubBaseUrl`, `agencyHubApiKey`, `quickMessageCount`, `pingMessageCount`, `improveMessageCount`, `deepMessageCount`, `debugMode`, `promptCachingEnabled`, `featureModels` (built from `modelSelects` dataset), `featureReasoning` (built from `reasoningSelects` dataset).

After save: values are written back into inputs (sanitized), counts reflected via `writeCount` (skips the focused field), and if the Hub signature changed it triggers `refreshAgencyHubPermissionState()` + `runAgencyHubConnectionTest({ force: true })` (`index.ts:737-744`).

Listener wiring (`index.ts:747-767`): `keyInput, openRouterKeyInput, agencyHubUrlInput, agencyHubKeyInput, quickInput, pingInput, improveInput, deepInput, debugInput, promptCachingInput` each get `input`+`change` → `saveSettingsDebounced`; all reasoning selects get `input`+`change` → `saveSettingsDebounced`; `openRouterKeyInput` additionally gets `input`+`change` → `renderOpenRouterWarning`. (So the two Agency Hub inputs feed both the debounced settings save AND the pending/refresh handlers.)

### 2.7 Model Personalities CRUD (`index.ts:820-919`)

Built via `createSection('Model Personalities')`. Each personality is a card (`makeCard`, `index.ts:850-896`) carrying `dataset.personalityId`, `dataset.personalityBuiltin`, `dataset.personalityBuiltinVersion`, a name input (`data-role="name"`) and a 12-row textarea (`data-role="content"`).

- `collectPersonalityEntries()` (`index.ts:826-841`) reads all `[data-personality-id]` cards back into `Personality[]` (`id`, `name`, `content`, `updatedAt = Date.now()`, plus `builtin`/`builtinVersion` when flagged).
- `savePersonalitiesDebounced = debounce(async () => { state.personalities = await savePersonalities(collectPersonalityEntries()); }, 450)` (`index.ts:843-848`) — persists **without** re-rendering (comment: rebuilding DOM would steal focus/caret). `savePersonalities` writes the `personalities` storage key (`storage.ts:150-156`) after normalizing + reconciling bundled personalities.
- Name/content `input` events → `savePersonalitiesDebounced` (`index.ts:891-892`).
- **Delete** button (only for non-builtin, `index.ts:872-889`): `window.confirm(...)`; cancels the pending debounced save, flushes current edits via `savePersonalities(collectPersonalityEntries())`, then `deletePersonality(personality.id)` (**storage** — removes from `personalities`, strips the id from `accountMappings`, removes matching `summary:*` cache keys, `storage.ts:158-179`), then `await render()`.
- **Add Personality** button (`index.ts:900-916`): cancels debounced save, appends a new `{ id: crypto.randomUUID(), name: 'New Personality', content: '', updatedAt }`, `savePersonalities(...)`, then `render()`. (`crypto.randomUUID()` is a **browser-api** call.)

### 2.8 Account Mappings section (`index.ts:921-1001`)

Built via `createSection('Account Mappings')`. Iterates `state.knownAccounts` (`index.ts:938`). For each account id:
- Looks up `session = sessionsByAccountId.get(accountId)`.
- Heading = `formatAccountHeading(accountId, session)`, meta = `formatAccountMeta(...)` (both from `sessions.ts`).
- A personality `<select>`: first option `Unmapped` (value `''`), then one option per personality using `personalityOptionLabel` — which appends `· <id.slice(0,6)>` when the personality name is non-unique (`personalityNameCounts`, `index.ts:929-936`). `select.value = state.accountMappings[accountId] ?? ''`.
- `change` handler: `await saveAccountMapping(accountId, select.value || null); await render();` — `saveAccountMapping` (`storage.ts:181-200`) resolves the canonical account id + aliases and writes the `accountMappings` storage key.
- An info `<div>`: `"<mapped name or 'Unmapped'> • <Connected|Disconnected>"`.
- Empty state: "No Fansly accounts detected yet." when `state.knownAccounts.length === 0` (`index.ts:993-998`).

### 2.9 Connection Status section (`index.ts:1003-1045`)

Built via `createSection('Connection Status')`. `connectionRows = buildConnectionRows(sessions)` (`sessions.ts:50-67`, dedups by canonical account, keeps newest by `lastSeenAt`), sorted by heading `localeCompare`. Each row is a `.chatgoose-card` showing heading, a right-aligned `Connected`/`Disconnected` label colored via `--chatgoose-success`/`--chatgoose-danger`, and account-id meta. Empty state: "No active sessions captured yet."

### 2.10 Cleanup lifecycle

`renderCleanup` (`index.ts:1047-1050`) runs `cleanupTasks` — in practice only the `browser.permissions.onAdded/onRemoved` listener removal (§2.4). Called at the top of the next `render()` so listeners don't accumulate across re-renders.

### Options — storage keys touched

| Key | Read | Written by (options-triggered) |
| --- | --- | --- |
| all keys (`browser.storage.local.get(null)`) | `loadStorageState` at render start | — |
| `settings` | via `loadStorageState` | `saveSettings` in `saveSettingsDebounced`, `persistAgencyHubSettings`, Grant-Access handler |
| `personalities` | via `loadStorageState` | `savePersonalities` (debounced, add, delete flush), `deletePersonality` |
| `accountMappings` | via `loadStorageState` | `saveAccountMapping`, `deletePersonality` (strips deleted id) |
| `accountAliases` | via `loadStorageState` (used in mapping resolution) | not written directly by options; written inside `saveAccountMapping`'s canonicalization uses existing aliases only |
| `knownAccounts` (`KNOWN_ACCOUNTS_KEY`) | via `loadStorageState` → drives mapping rows | reconciled server-side by the `getSessionsSnapshot` background handler, not by options |
| `summary:*` cache keys | — | removed by `deletePersonality` |
| `schemaVersion` (`STORAGE_SCHEMA_VERSION=7`) | via `loadStorageState` | migration write inside `loadStorageState` when version mismatch / bundled personalities changed |

### Options — runtime messages sent (IPC, one-shot `browser.runtime.sendMessage` via `sendRuntimeRequest`)

| `type` | Payload | Response type | Sent from |
| --- | --- | --- | --- |
| `getSessionsSnapshot` | none | `SessionSnapshotEntry[]` | `render()` start (`index.ts:63`) |
| `testAgencyHubConnection` | `{ settings: { agencyHubBaseUrl, agencyHubApiKey } }` | `AgencyHubConnectionTestResponse` `{ ok, error? }` | `runAgencyHubConnectionTest` (`index.ts:330`) |

### Options — other browser-api usage

`browser.runtime.getManifest().version`; `browser.permissions.contains/request/onAdded/onRemoved` (via helpers + inline); `crypto.randomUUID()`; `window.confirm`; `window.setTimeout`/`clearTimeout` (inside `debounce`). No direct `fetch`/DOM-of-Fansly access — all network happens in the background worker.

---

## 3. `src/options/dom.ts` — options DOM helpers

Pure DOM factory helpers, imported only by `src/options/index.ts` (confirmed: `import … from './dom.js'` is the sole importer). No storage, network, or IPC.

| Export | Signature | Behavior |
| --- | --- | --- |
| `injectStyles(cssText)` | `(string) => void` | creates a `<style>` with `textContent = cssText`, appends to `document.head` (`dom.ts:1-5`) |
| `createSection(title, description?)` | `(string, string?) => HTMLElement` | builds a `<section>` with inline card styling, an `<h2>` title, optional muted description (`dom.ts:7-36`) |
| `labeledField(labelText, input)` | `(string, HTMLElement) => HTMLElement` | wraps an input in a `<label>` grid with a bold `<span>` caption (`dom.ts:38-47`) |
| `createButton(label, secondary=false, danger=false)` | | `<button type=button>` with class `chatgoose-button` + optional `-secondary`/`-danger` modifiers (`dom.ts:49-59`) |
| `createVersionTag(extensionVersion)` | `(string) => HTMLDivElement` | `.chatgoose-version-tag` div with text `"v <version>"` (`dom.ts:61-66`) |
| `Debounced<T>` (type) | `T & { cancel: () => void }` | debounced fn shape (`dom.ts:68-70`) |
| `debounce(callback, waitMs)` | | window-timer debounce; `.cancel()` clears the pending timer (`dom.ts:72-93`) |

The popup does **not** import `dom.ts`; it re-implements local `injectStyles`, `createButton`, `createVersionTag` (see §6).

---

## 4. `src/options/sessions.ts` — session formatting/lookup

Pure functions over `SessionSnapshotEntry[]`; imported only by `src/options/index.ts`. No side effects.

| Export | Behavior |
| --- | --- |
| `getNormalizedUsername(username)` (internal) | trims + strips leading `@`, returns `null` if empty (`sessions.ts:3-6`) |
| `formatAccountHeading(accountId, session)` | `"<displayName> (@<username>)"` when both present and differ; else `"@<username>"`, else `displayName`, else `session.resolvedAccountId ?? accountId` (`sessions.ts:8-25`) |
| `formatAccountMeta(accountId, session)` | `"Account ID: <resolvedAccountId ?? accountId>"` (`sessions.ts:27-33`) |
| `buildSessionLookup(sessions)` | `Map` keyed by both `legacyAccountId` and (when present) `resolvedAccountId` → session (`sessions.ts:35-48`) |
| `buildConnectionRows(sessions)` | dedups by canonical id (`resolvedAccountId ?? legacyAccountId`), keeps entry with max `lastSeenAt`; returns `{ accountId, session }[]` (`sessions.ts:50-67`) |

`SessionSnapshotEntry` shape (`types.ts:682-689`): `legacyAccountId`, `resolvedAccountId`, `username`, `displayName`, `connected`, `lastSeenAt`.

---

## 5. `src/options/agency-hub-settings.ts` — Agency Hub settings helpers

Types + pure helpers + one `browser.permissions`-touching async helper. Imported only by `src/options/index.ts`. Re-exports two helpers from `../shared/agency-hub.js` indirectly (imports `buildAgencyHubOriginPattern`, `normalizeAgencyHubBaseUrl`).

**Exported types:**
- `AgencyHubPermissionCheckResult` = `{ granted: boolean; errorMessage: string | null }` (`:7-10`).
- `AgencyHubPermissionFeedback` = `denied | request_error | unsupported` (each with `originPattern`; `request_error` also `errorMessage`) (`:12-15`).
- `AgencyHubConnectionFeedback` = `idle | pending | testing | connected{baseUrl} | failed{error: UserFacingError}` (`:17-22`).

**Exported functions:**
| Export | Behavior |
| --- | --- |
| `formatAgencyHubError(error)` | `"<name>: <message>"` for `Error`, else `String(error)` (`:24-31`) |
| `appendAgencyHubMeta(baseText, note)` | joins with a space when `note` present (`:33-35`) |
| `buildAgencyHubPermissionScopeNote(baseUrl)` | returns a sentence explaining Firefox grants per-host not per-port; `null` unless the URL has an explicit port (`:37-56`) |
| `buildAgencyHubConnectionSignature(baseUrl, apiKey)` | `"<normalize(baseUrl)>|<apiKey.trim()>"` — dedupe key for connection tests (`:58-60`) |
| `hasAgencyHubConnectionInputs(baseUrl, apiKey)` | both trimmed truthy (`:62-64`) |
| `getAgencyHubPermissionCheck(originPattern)` | **browser-api**: if no pattern → `{granted:false}`; if `browser.permissions.contains` absent → `{granted:true}` (treats as granted); else `await browser.permissions.contains({ origins:[originPattern] })`, catching errors into `errorMessage` (`:66-88`) |

`normalizeAgencyHubBaseUrl` (`agency-hub.ts:9-26`) requires `http:`/`https:`, strips trailing slashes, returns `''` on invalid. `buildAgencyHubOriginPattern` (`agency-hub.ts:28-36`) returns `"<protocol>//<hostname>/*"` — **port intentionally dropped**, which is why the scope note explains per-host granting.

---

## 6. Toolbar popup — `src/popup/index.ts` + HTML + CSS

Small standalone page shown from the toolbar button. No framework; ~119 lines.

### 6.1 Bootstrap (`popup/index.ts:1-33,117-118`)
- `rootElement = document.getElementById('chatgoose-popup-root')` (`:5`); throws `'Missing popup root'` if absent.
- `extensionVersion = browser.runtime.getManifest().version` (`:6`) — **browser-api**.
- Local `injectStyles()`, `createButton(label)`, `createVersionTag()` (`:14-33`) — self-contained duplicates of the options helpers (popup does not import `dom.ts`).
- Entry point: `injectStyles(); void render();` (`:117-118`).

### 6.2 `render()` (`popup/index.ts:59-115`)
- **IPC:** `status = await sendRuntimeRequest('getPopupStatus')` (`:62`) → `PopupStatus`. No payload → background resolves the active tab (`runtime-api.ts:54-136`).
- On thrown error (worker asleep/reloading) → `renderUnavailable()` (`:63-67`).
- Renders:
  - eyebrow `"ChatGoose"`, name = `status.accountLabel`, sub = `status.connected ? 'Fansly session connected' : 'Connection not established'` (`:76-92`).
  - panel with `` `Account: ${status.accountId ?? 'Not connected'}` `` and `` `Conversation: ${status.groupId ?? 'No active chat'}` `` (`:94-107`).
  - `Open Settings` button → `browser.runtime.openOptionsPage()` (**browser-api**, `:109-113`).
  - a version tag.

### 6.3 `renderUnavailable()` (`popup/index.ts:35-57`)
Fallback UI: title `"ChatGoose"`, message "Couldn't reach ChatGoose. Reopen this popup after it reconnects.", and an `Open Settings` button → `browser.runtime.openOptionsPage()`.

### 6.4 What the popup actually consumes vs. the payload — discrepancy

`PopupStatus` extends `TabUiState` (`types.ts:662-680`) and carries many fields: `hasAvailableSummary`, `hasApiKey`, `modelProviderByFeature`, `apiKeyReadyByFeature`, `hasPersonalities`, `mappedPersonalityId`, `mappedPersonalityName`, `compareCardCount`, `compareDraftCount`, plus `accountLabel`. **`popup/index.ts` reads only four of them: `accountLabel`, `connected`, `accountId`, `groupId`.** It does **not** render compare card counts, `hasApiKey`, or the mapped personality directly. The mapped personality surfaces only indirectly: the background computes `accountLabel = mappedPersonalityName ?? (accountId ? 'Unmapped account' : 'Not connected')` (`runtime-api.ts:132-134`), so a mapped personality's name appears as the popup's big heading, and an unmapped-but-connected account shows "Unmapped account". (This differs from the assignment brief, which lists "mapped personality, compare card counts" as popup-displayed — the data is fetched but those specific fields are not shown by this file.)

### 6.5 Popup CSS (`popup/styles.css`)
Shares the same `:root` custom properties as options. `body` `min-width: 320px`, dark theme, system font stack. `.chatgoose-button` and `.chatgoose-version-tag` (positioned `top:12px; right:12px`) styles. No `Outfit` font reference (see §1 discrepancy).

### Popup — messages & storage
- **IPC sent:** `getPopupStatus` (payload optional `{ tabId? }`; popup sends none) → `PopupStatus`.
- **Storage:** none directly (all state comes through the background via `getPopupStatus`).
- **browser-api:** `browser.runtime.getManifest()`, `browser.runtime.openOptionsPage()`, `browser.runtime.sendMessage` (via `sendRuntimeRequest`).

---

## 7. Cross-module dependency summary

- `src/options/index.ts` imports: `./styles.css`, `./agency-hub-settings.js`, `./dom.js`, `./sessions.js`, `../shared/agency-hub.js` (`buildAgencyHubOriginPattern`, `normalizeAgencyHubBaseUrl`), `../shared/constants.js` (`AI_MODEL_GROUPS`, `REASONING_EFFORTS`), `../shared/errors.js` (`createUserError`, `getUserErrorDescription`), `../shared/model-capabilities.js` (`supportsModelReasoningConfig`), `../shared/model-registry.js` (`isOpenRouterModelSelection`), `../shared/protocol.js` (`sendRuntimeRequest`), `../shared/storage.js` (`saveSettings`, `loadStorageState`, `savePersonalities`, `saveAccountMapping`, `deletePersonality`), `../shared/types.js` (types).
- `src/options/dom.ts`, `sessions.ts`, `agency-hub-settings.ts` are imported **only** by `src/options/index.ts`.
- `src/popup/index.ts` imports: `./styles.css`, `../shared/protocol.js` (`sendRuntimeRequest`), `../shared/types.js` (`PopupStatus`).
- Both pages depend on the background worker's `runtime-api.ts` message handler to satisfy their `sendRuntimeRequest` calls (`getSessionsSnapshot`, `testAgencyHubConnection`, `getPopupStatus`). `getSpendersList` (the fourth runtime request) is **not** used by either page.

---

## 8. Open questions / flagged discrepancies

1. **Outfit web font fetched but unused** — both `index.html` files load `fonts.googleapis.com/…Outfit…` but no CSS `font-family` references it (§1).
2. **Popup ignores most of `PopupStatus`** — `hasApiKey`, `compareCardCount`, `compareDraftCount`, `hasAvailableSummary`, `mappedPersonalityId/Name`, and the per-feature provider/key-ready maps are transmitted but not rendered by `popup/index.ts`; only `accountLabel`/`connected`/`accountId`/`groupId` are shown (§6.4). Mapped-personality info reaches the UI only through `accountLabel`.
3. **`buildAgencyHubOriginPattern` drops the port** — host permission granted is `<proto>//<host>/*`, broader than the configured `baseUrl` which may include a port; the UI acknowledges this via `buildAgencyHubPermissionScopeNote` only when a port is present (§5, §2.4).
4. **Missing-`browser.permissions.contains` is treated as "granted"** — `getAgencyHubPermissionCheck` returns `{ granted: true }` when the API is absent (`agency-hub-settings.ts:73-75`), so on a build without `permissions.contains` the options UI reports sync-ready without an actual grant check.
5. **Agency Hub inputs are double-wired** — `agencyHubUrlInput`/`agencyHubKeyInput` fire both `saveSettingsDebounced` (350 ms) and the pending/refresh handlers on every `input`/`change`; a live connection re-test is gated behind the changed-signature check in `saveSettingsDebounced` and the `lastAgencyHubConnectionSignature` dedupe in `runAgencyHubConnectionTest` (§2.4, §2.6).
6. **HTML `min`/`max` vs. `sanitizeSettings` clamps agree** for quick/ping/improve (5–200) and deep (100–3000); the authoritative clamp is server-side in `storage.ts`, so out-of-range values typed in are corrected on save-back (§2.3).
