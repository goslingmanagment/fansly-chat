> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Map: Build, Packaging & Distribution

## Scope

This document maps the build/bundle pipeline, the MV3 manifest, the TypeScript/test configuration, the CI workflow, and the self-hosted Firefox distribution + auto-update channel. Files covered in full:

- `esbuild.config.mjs`
- `manifest.json`
- `tsconfig.json`
- `vitest.config.ts`
- `package.json`
- `package-lock.json` (dependency inventory only)
- `src/env.d.ts`
- `src/virtual-drafts.d.ts`
- `.github/workflows/ci.yml`
- `scripts/deploy.sh`
- `scripts/deploy-pages.sh`
- `scripts/setup-vps-ext.sh`
- `.env.deploy.example`
- `.gitignore`
- the `dist/` built-output layout

Noted for existence + role only (not audited): `README.md`, `CHANGELOG.md`, `changelog.html`, `guide.html`, `install.html`, `SPEC_FINAL.md`, `TODO.md`, `mascot.png`, `icons/`.

Cross-referenced but not re-derived: this repo's external-boundary contract tables live in `docs/project-kernel/boundaries.md`. Boundary details specific to build/distribution (the self-hosted update channel, AMO signing) are given inline below.

---

## 1. `package.json` — scripts, module type, dependencies

`package.json` root fields:

- `name`: `chatgoose`, `version`: `1.5.6` (kept in lockstep with `manifest.json` version — both `1.5.6`).
- `main`: `index.js` (no such file exists at root; unused — the extension has no npm entry point).
- `type`: `commonjs`. The build script is `esbuild.config.mjs` (`.mjs` forces ESM regardless of this field).
- `license`: `ISC`. `author`/`description`/`keywords` empty.
- `directories.test`: `tests`.

### Scripts (`package.json:9-16`)

| Script | Command | Purpose |
|---|---|---|
| `build` | `node esbuild.config.mjs` | One-shot bundle into `dist/`. |
| `watch` | `node esbuild.config.mjs --watch` | Incremental rebuild watch mode. |
| `test` | `vitest run` | Run test suite once. |
| `test:watch` | `vitest` | Vitest watch mode. |
| `typecheck` | `tsc --noEmit` | Type-check only, no emit. |
| `check` | `npm run typecheck && npm test && npm run build` | Full gate; run by CI. |

### Dependencies

No runtime `dependencies` (root `dependencies: {}` in the lockfile). All packages are `devDependencies` (`package.json:21-27`):

| Package | Range | Resolved (lockfile) | Role |
|---|---|---|---|
| `@types/firefox-webext-browser` | `^143.0.0` | — | Ambient `browser.*` WebExtension typings (referenced by `tsconfig.json` `types`). |
| `esbuild` | `^0.27.3` | `0.27.4` | Bundler (all four entry points). |
| `jsdom` | `^28.1.0` | — | DOM environment for tests (pulled transitively by vitest usage; `jsdom`-based tests set `environment` per-file — global default is `node`). |
| `typescript` | `^5.9.3` | — | `tsc` type-checker. |
| `vitest` | `^4.0.18` | — | Test runner (pulls `rolldown` `1.0.0-rc.11` and its native bindings transitively — Vitest 4 uses Rolldown). |

`package-lock.json` is `lockfileVersion: 3`, 149 packages total. The bulk are platform-specific optional binaries: `@esbuild/*` (all `0.27.4`) and `@rolldown/binding-*` (all `1.0.0-rc.11`). `jsdom`'s CSS/DOM stack (`@asamuzakjp/*`, `@csstools/*`, `@acemir/cssom`, `nwsapi`) appears transitively.

**Not in `package.json`:** `web-ext` (the AMO signing CLI). `scripts/deploy.sh` requires the `web-ext` command on `PATH` (`deploy.sh:262`) but it is not a declared dependency — it must be globally installed on the deploy machine.

---

## 2. `esbuild.config.mjs` — the bundle pipeline

ESM script run by Node (`node esbuild.config.mjs`). Imports: `node:fs` (`existsSync`, `watch as watchFs`), `node:fs/promises` (`cp`, `mkdir`, `readdir`, `readFile`, `rm`, `writeFile`), `node:path`, and `esbuild`.

### Constants (`esbuild.config.mjs:6-17`)

- `root = process.cwd()` — build must be invoked from repo root.
- `outdir = <root>/dist`.
- `watchMode` — true if `--watch` is in `process.argv`.
- `promptsDir = <root>/prompts`, `draftsDir = <root>/prompts/drafts`.
- `entryPoints`: four IIFE bundles →
  - `background` → `src/background/index.ts`
  - `content` → `src/content/index.ts`
  - `options` → `src/options/index.ts`
  - `popup` → `src/popup/index.ts`

  esbuild names outputs after the entry keys: `dist/background.js`, `dist/content.js`, `dist/options.js`, `dist/popup.js`.

### Shared esbuild options (`buildOnce` at `:80-103`, and the watch `context` at `:109-135`)

Identical config in both call sites:

- `bundle: true`, `format: 'iife'`, `platform: 'browser'`.
- `target: ['firefox128']` — transpiles to Firefox 128 baseline. (Note: the manifest's `strict_min_version` is `142.0`; the esbuild target `firefox128` is a lower floor than the manifest's declared minimum.)
- `sourcemap: true` — emits `*.js.map` alongside each bundle.
- `loader`: `{ '.md': 'text', '.css': 'text' }` — `.md` and `.css` imports resolve to their file contents as a default-exported string.
- `define`: `{ __CHATGOOSE_BUILD_TIME__: JSON.stringify(new Date().toISOString()) }` — a global compile-time constant stamped with the build's ISO timestamp.
- `plugins`: `[modelCardDraftsPlugin()]` (watch build additionally adds a `chatgoose-static-copy` plugin, below).

### `buildOnce()` (`:80-103`)

1. `rm(outdir, { recursive: true, force: true })` then `mkdir(outdir)` — clean rebuild each run.
2. `esbuild.build(...)` with the shared options.
3. `ensureStaticFiles()`.

Top-level control flow (`:105-170`): if not watch, `await buildOnce()`. Otherwise `buildOnce()` then set up an esbuild `context` + FS watchers (below).

### `ensureStaticFiles()` (`:67-78`) — static-file copying

- `mkdir(dist/icons, { recursive: true })`.
- Reads `src/options/index.html` → writes `dist/options.html`.
- Reads `src/popup/index.html` → writes `dist/popup.html`.
- Reads root `manifest.json` → writes `dist/manifest.json` (verbatim copy; not transformed).
- `cp(icons/ → dist/icons/, recursive)`.

The two HTML files are renamed from `index.html` (source) to `options.html` / `popup.html` (dist) to match `manifest.json`'s `options_ui.page` = `options.html` and `action.default_popup` = `popup.html`. Each source HTML references its sibling script by relative path: `src/options/index.html` loads `./options.js`, `src/popup/index.html` loads `./popup.js`. Both HTML `<head>`s also load the `Outfit` font stylesheet from `https://fonts.googleapis.com` (external network fetch at page load, not part of the bundle).

### `modelCardDraftsPlugin()` (`:26-65`) — the `virtual:model-card-drafts` plugin

esbuild plugin `name: 'chatgoose-virtual-drafts'`:

- `onResolve` for exact import `virtual:model-card-drafts` → resolves to path `virtual:model-card-drafts`, namespace `chatgoose-virtual-drafts`.
- `onLoad` (filter `/.*/` in that namespace):
  1. `readdir(draftsDir)` (`prompts/drafts/`), filter files whose lowercased name ends `.md`, sort via `compareDraftNames` (locale `en`, `sensitivity: 'base'`, `numeric: true`). On any error (e.g. dir missing) → `files = []`.
  2. Generates a synthetic TS module: one `import draftN from "<abs path>";` per file, and a default export object mapping `<filename without .md>: draftN`.
  3. Returns `{ contents, resolveDir: root, loader: 'ts' }`. The imported `.md` files then flow through the `.md` text loader, so each draft's value is its raw markdown string.

**Discrepancy / important:** `prompts/drafts/` is **gitignored** (`.gitignore:9`, and also `drafts/` at `:8`) and is **not present** in the working tree. In a normal checkout the `readdir` throws, `files = []`, and `virtual:model-card-drafts` compiles to `export default {}`. So the "Multi"/compare model-card drafts are empty unless a developer supplies `prompts/drafts/*.md` locally. See §11 for the consumer.

`compareDraftNames` (`:19-24`) is duplicated verbatim in `vitest.config.ts` and in `src/shared/compare-cards.ts`.

### Watch mode (`:107-170`)

1. `buildOnce()` first.
2. `esbuild.context(...)` with shared options plus an extra plugin `chatgoose-static-copy` whose `onEnd` calls `ensureStaticFiles()` after every incremental rebuild.
3. `ctx.watch()` — esbuild watches the module graph.
4. Additional raw `fs.watch` watchers on directory changes esbuild's graph would miss (new/removed draft files):
   - `promptsDir` — rebuild when the changed entry is `drafts` (the drafts subdir itself appearing/disappearing).
   - `draftsDir` — rebuild when filename is non-string or ends `.md`.
   - Both filtered by `existsSync(watchPath)`, so a missing `prompts/drafts/` yields no drafts watcher.
   - Each watcher calls `ctx.rebuild()`; errors logged as `'Failed to rebuild compare drafts module'`.
5. `process.on('exit')` closes watchers. Logs `'Watching ChatGoose...'`.

---

## 3. `src/env.d.ts` and `src/virtual-drafts.d.ts` — ambient declarations

`src/env.d.ts`:

- `declare const __CHATGOOSE_BUILD_TIME__: string;` — types the esbuild `define`. Consumed at `src/shared/constants.ts:207`: `export const BUILD_TIME = __CHATGOOSE_BUILD_TIME__;`.
- `declare module '*.md'` → `default: string`. Types the `.md` text loader (used by `src/shared/prompts.ts:1-7`, importing the seven feature prompt templates from `prompts/*.md`).
- `declare module '*.css'` → `default: string`. Types the `.css` text loader (used by `src/options/index.ts:1`, `src/popup/index.ts:1`, `src/content/index.ts:1`, each importing `./styles.css` and injecting it at runtime).
- `declare module 'node:fs'` with a narrowed `readFileSync(path, encoding): string` — a local shim so source that touches `node:fs` type-checks under DOM libs.

`src/virtual-drafts.d.ts`:

- `declare module 'virtual:model-card-drafts'` → `const drafts: Record<string, string>; export default drafts;` — types the virtual module produced by the esbuild plugin (§2) and the Vitest plugin (§5).

---

## 4. `tsconfig.json` — type-checking config

Used only by `tsc --noEmit` (the `typecheck` script). Key `compilerOptions`:

- `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`.
- `lib: ["DOM", "DOM.Iterable", "ES2022"]`.
- Strictness: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`.
- `skipLibCheck: true`.
- `types: ["firefox-webext-browser"]` — only this ambient type package is auto-included (provides global `browser`).
- `allowSyntheticDefaultImports`, `resolveJsonModule`, `isolatedModules`, `useDefineForClassFields`.
- `baseUrl: "."`, `outDir: "dist-ts"` — `outDir` is declared but never used, since typecheck runs with `--noEmit`; no `dist-ts/` directory is produced.
- `include: ["src/**/*.ts", "tests/**/*.ts"]`.

---

## 5. `vitest.config.ts` — test configuration

Imports `node:fs` (`readdirSync`, `readFileSync`), `node:path`, `defineConfig` from `vitest/config`.

- `define`: `{ __CHATGOOSE_BUILD_TIME__: JSON.stringify('test-build') }` — under test, `BUILD_TIME` === `'test-build'`.
- Two plugins that re-implement the esbuild loaders for the test environment:
  - `chatgoose-raw-text-assets` — `transform` hook: any module id ending `.md` or `.css` becomes `export default <JSON.stringify(code)>` (mirrors the esbuild text loader).
  - `chatgoose-virtual-drafts` — `resolveId`/`load` hooks resolve `virtual:model-card-drafts` (rollup-style `\0`-prefixed id) to `export default <JSON.stringify(loadDrafts())>`.
- `loadDrafts()` (`:14-28`) reads `prompts/drafts/*.md` (same filter + `compareDraftNames` sort as esbuild), returns `{ <name-without-.md>: <file contents> }`; on error returns `{}`. Same gitignored-directory caveat as §2 applies to tests.
- `test`:
  - `environment: 'node'` (per-file overrides can select jsdom).
  - `include: ['tests/**/*.test.ts']`.
  - `globals: true`.
  - `coverage.reporter: ['text', 'html']`.

`compareDraftNames` here (`:7-12`) is a third copy of the same comparator (see §2).

---

## 6. `manifest.json` — the MV3 manifest (full)

The source `manifest.json` (root) is copied verbatim to `dist/manifest.json` by `ensureStaticFiles()`. Full contents:

- `manifest_version`: `3`.
- `name`: `ChatGoose`; `version`: `1.5.6`; `description`: `AI-powered chat assistant for Fansly.com`.
- `permissions` (`:6-11`): `storage`, `unlimitedStorage`, `webRequest`, `tabs`.
- `host_permissions` (`:12-17`) — granted at install:
  - `*://fansly.com/*` (Fansly web app / DOM + content script)
  - `*://apiv3.fansly.com/*` (Fansly REST API — boundary 1)
  - `*://api.anthropic.com/*` (Anthropic Messages API — boundary 2)
  - `https://openrouter.ai/*` (OpenRouter — boundary 3)
- `optional_host_permissions` (`:18-21`): `http://*/*`, `https://*/*` — broad optional grant used to reach the **configurable Agency Hub base URL** (boundary 4), whose origin is unknown at build time and requested at runtime.
- `background` (`:22-26`): `{ "scripts": ["background.js"] }` — MV3 background as a non-persistent event page loading the bundled `background.js` (Firefox supports the `scripts` form; no `service_worker`).
- `content_scripts` (`:27-37`): one entry — `matches: ["*://fansly.com/*"]`, `js: ["content.js"]`, `run_at: "document_idle"`. No `css` entry is declared; content styles ship inside `content.js` (imported from `./styles.css` via the text loader and injected at runtime).
- `action` (`:38-45`): `default_popup: "popup.html"`, `default_title: "ChatGoose"`, `default_icon`: 48/96 px.
- `options_ui` (`:46-49`): `page: "options.html"`, `open_in_tab: true`.
- `icons` (`:50-54`): 48/96/128 px → `icons/icon-*.png`.
- `browser_specific_settings.gecko` (`:55-70`):
  - `id`: `chatgoose@gosling.agency`
  - `strict_min_version`: `142.0`
  - `update_url`: `https://ext.gosling-agency.ru/updates.json` — the **self-hosted update manifest** (distribution boundary; see §8/§10).
  - `data_collection_permissions.required`: `["authenticationInfo", "personallyIdentifyingInfo", "personalCommunications", "financialAndPaymentInfo", "websiteContent"]` — the AMO data-collection disclosure block (newer Firefox/AMO field).

---

## 7. `dist/` — built-output layout

Produced by `npm run build`. Observed contents:

| Path | Origin | Notes |
|---|---|---|
| `dist/background.js` (+ `.js.map`) | esbuild bundle of `src/background/index.ts` | IIFE. |
| `dist/content.js` (+ `.js.map`) | esbuild bundle of `src/content/index.ts` | IIFE; includes injected CSS text. |
| `dist/options.js` (+ `.js.map`) | esbuild bundle of `src/options/index.ts` | IIFE. |
| `dist/popup.js` (+ `.js.map`) | esbuild bundle of `src/popup/index.ts` | IIFE. |
| `dist/options.html` | copied+renamed from `src/options/index.html` | loads `./options.js`. |
| `dist/popup.html` | copied+renamed from `src/popup/index.html` | loads `./popup.js`. |
| `dist/manifest.json` | verbatim copy of root `manifest.json` | packaging root. |
| `dist/icons/icon-48.png`, `icon-96.png`, `icon-128.png` | copied from `icons/` | action + toolbar + install icons. |
| `dist/.amo-upload-uuid` | written by `web-ext sign` | JSON: `{ "uploadUuid": "...", "channel": "unlisted", "xpiCrcHash": "..." }` — AMO upload-dedup cache, left in `dist/` after signing (not part of the extension). |

`dist/` is the `--source-dir` for `web-ext sign`. `dist/` is gitignored (`.gitignore:2`).

---

## 8. `scripts/deploy.sh` — build, sign, and publish the self-hosted update channel

`bash`, `set -euo pipefail`. This is the primary distribution boundary: it builds, AMO-signs, and uploads the extension + auto-update manifest + release pages to the VPS.

### Constants (`deploy.sh:4-22`)

- `ROOT_DIR` — repo root (resolved from script location).
- `ENV_FILE = <root>/.env.deploy`.
- `VPS_HOST = root@45.8.230.111`.
- `REMOTE_DIR = /var/www/ext`.
- `BASE_URL = https://ext.gosling-agency.ru`.
- `EXTENSION_ID = chatgoose@gosling.agency` (must match manifest gecko id).
- Local page sources: `install.html`, `guide.html`, `changelog.html`, asset `mascot.png`.
- `LATEST_XPI_NAME = chatgoose-latest.xpi`.
- Remote targets: `updates.json`, `index.html`, `mascot.png`, `guide.html`, `changelog.html`, `chatgoose-latest.xpi` under `REMOTE_DIR`.
- Verify loop: `VERIFY_ATTEMPTS = 30`, `VERIFY_DELAY_SECONDS = 10` (≤ 5 min per URL).

### Helpers

- `cleanup` (EXIT trap, `:30-46`) — restores stamped release pages (`restore_release_pages`), removes temp `artifacts_dir` and `updates_file`, preserves original exit code.
- `require_command` / `require_file` — preflight checks.
- `load_env` (`:69-81`) — sources `.env.deploy` with `set -a`; requires `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`.
- `read_manifest_version` (`:83-95`) — inline Node reads `manifest.version` from `manifest.json`.
- `read_manifest_min_version` (`:97-110`) — inline Node reads `browser_specific_settings.gecko.strict_min_version` (falls back to `applications.gecko`); errors if absent.
- Page-stamping (`stamp_install_page_version`, `stamp_guide_page_version`, `stamp_changelog_page_version`, `:132-210`) — inline Node regex-replaces version slots in the three HTML pages:
  - install page: `<p class="footer">ChatGoose v… &middot; Gosling Agency</p>`
  - guide/changelog: `<span class="nav-version">v…</span>` and `<p>v… &middot; Gosling Agency &middot; Powered by selected AI providers</p>`
  - Each throws if its slot is not found. `stamp_release_pages` backs up originals to `mktemp` files first; `restore_release_pages` restores them after upload.
- `verify_http_200_with_retry` (`:228-257`) — `curl` a URL until HTTP 200 or 30 attempts; fails otherwise.

### `main()` flow (`:259-384`)

1. `require_command`: `node npm web-ext ssh scp curl shasum`. (**`web-ext` is required but not an npm dependency.**)
2. `require_file`: the three HTML pages + `mascot.png`.
3. `load_env`; `cd ROOT_DIR`.
4. `npm run build` (produces `dist/`).
5. Read `version` and `min_version` from `manifest.json`.
6. Create temp `artifacts_dir` and `updates_file`.
7. **Sign with AMO** (`:288-296`):
   ```
   web-ext sign --channel unlisted --source-dir dist --artifacts-dir <tmp>
     --no-config-discovery --api-key $WEB_EXT_API_KEY --api-secret $WEB_EXT_API_SECRET
     --timeout 600000 --approval-timeout 600000
   ```
   Channel `unlisted` = self-distribution (AMO signs but does not list). Locate the produced `*.xpi`; fail if none.
8. Compute names/URLs: `xpi_name = chatgoose-<version>.xpi`, `xpi_url = <BASE_URL>/<xpi_name>`, `latest_xpi_url = <BASE_URL>/chatgoose-latest.xpi`; `sha256 = shasum -a 256 <xpi>`.
9. **Generate `updates.json`** (`:313-332`) — the Firefox auto-update manifest:
   ```json
   {
     "addons": {
       "chatgoose@gosling.agency": {
         "updates": [
           {
             "version": "<version>",
             "update_link": "<BASE_URL>/chatgoose-<version>.xpi",
             "update_hash": "sha256:<sha256>",
             "applications": { "gecko": { "strict_min_version": "<min_version>" } }
           }
         ]
       }
     }
   }
   ```
   (The `applications.gecko` block is required for Firefox auto-update to accept the entry — see the user-memory note `updates-json-applications-block.md`.)
10. Stamp release pages (`stamp_release_pages`).
11. **Upload** (`:352-374`) via `ssh`/`scp` to `REMOTE_DIR` using per-file dot-prefixed temp names suffixed `$$` (PID), then atomically: `chmod 644`, `mv` each temp into place, and additionally `cp` the versioned xpi to `chatgoose-latest.xpi`. Uploaded: signed xpi (versioned), `updates.json`, `index.html` (from `install.html`), `mascot.png`, `guide.html`, `changelog.html`. `restore_release_pages` runs right after scp.
12. **Verify** (`:376-380`): retry-until-200 for `<BASE_URL>/`, `/updates.json`, versioned xpi URL, latest xpi URL.
13. Log install page + latest install link.

**Distribution model:** self-hosted unlisted add-on. Firefox clients read `manifest.json`'s `update_url` (`https://ext.gosling-agency.ru/updates.json`), compare `version`, and download `update_link` verified against `update_hash`.

---

## 9. `scripts/deploy-pages.sh` — static-page-only deploy

`bash`, `set -euo pipefail`. Deploys only the three HTML pages + mascot, without rebuilding or re-signing. Same `VPS_HOST`, `REMOTE_DIR`, `BASE_URL` as `deploy.sh`.

- `read_manifest_version` — inline Node reads `manifest.version`.
- `stamp_version(file, version, ...patternStrs)` (`:45-60`) — inline Node applies each regex (`new RegExp(ps)`, no flags → first match) replacing `$1v<version>$2`; throws if a pattern is absent.
- `main()` (`:62-96`):
  1. Read version; back up the three pages to `mktemp`.
  2. Stamp: install page footer; guide nav+footer; changelog nav+footer (same slots as `deploy.sh`).
  3. `ssh mkdir -p $REMOTE_DIR`; `scp` `install.html → index.html`, `guide.html`, `changelog.html`, `mascot.png` into `REMOTE_DIR` (direct scp, no atomic temp-swap here — differs from `deploy.sh`).
  4. `cleanup` EXIT trap restores the backed-up local pages.

No verification step and no `web-ext`/`updates.json` handling.

---

## 10. `scripts/setup-vps-ext.sh` — VPS provisioning (nginx + TLS)

`bash`, `set -euo pipefail`. One-time/idempotent provisioning of the `ext.gosling-agency.ru` static host. Runs a remote heredoc on `VPS_HOST` (`root@45.8.230.111`) via `ssh "$VPS_HOST" 'bash -s' <<'REMOTE'`.

Remote constants (`:23-33`): `REMOTE_DIR=/var/www/ext`, `DOMAIN=ext.gosling-agency.ru`, `EXPECTED_IP=45.8.230.111`, `AGENCY_HUB_SITE=/etc/nginx/sites-available/agency-hub`, per-domain nginx site paths, `CERT_DIR=/etc/letsencrypt/live/<domain>`, DNS wait 30×10s.

Remote steps:

- `mkdir -p /var/www/ext`.
- `cleanup_agency_hub` (`:50-93`) — Python edits the existing `agency-hub` nginx site: strips any `# BEGIN CHATGOOSE EXTENSION … # END CHATGOOSE EXTENSION` block, and inserts a `# … HARD CUTOFF` block that adds `location ^~ /ext/ { return 404; }` before the dashboard `location / {` — so the Agency Hub app no longer serves `/ext/` (the extension host is now a separate vhost). Errors if the dashboard `location /` is not found.
- `disable_legacy_backup_site` — renames any leftover `agency-hub.bak-chatgoose-ext` enabled symlink into `sites-available`.
- `write_http_site` (`:101-133`) — writes the port-80 nginx server for `DOMAIN`, `root /var/www/ext`, with:
  - `location = /updates.json` → `application/json`, `Cache-Control: no-cache, no-store, must-revalidate` (+ `Pragma: no-cache`, `Expires: 0`) — the update manifest is never cached.
  - `location ~ \.xpi$` → `application/x-xpinstall`, `Cache-Control: public, max-age=31536000, immutable` — xpi files cached a year.
  - `location = /` → serve `index.html`; catch-all `location /` → `try_files`.
- `ensure_site_enabled` — symlink into `sites-enabled`; `reload_nginx` (`nginx -t` then `systemctl reload nginx || nginx -s reload`).
- TLS: if no cert (`has_certificate`), `wait_for_dns` (dig `@1.1.1.1`/`@8.8.8.8` or `getent`, up to 5 min) then `certbot certonly --webroot --webroot-path /var/www/ext --domain <domain> --non-interactive --agree-tos --keep-until-expiring`. Exits `2` if DNS never resolves; exits `1` if `certbot` missing.
- `write_https_site` (`:135-179`) — rewrites the site with a port-80 → 443 redirect and an SSL server (same `updates.json`/`.xpi`/index locations, plus `ssl_certificate` from `CERT_DIR`, letsencrypt options + dhparams). `reload_nginx` again.

The `updates.json` cache headers here are what make `deploy.sh`'s freshly-uploaded update manifest immediately visible to Firefox update checks.

---

## 11. Downstream consumers of build-time symbols

- `__CHATGOOSE_BUILD_TIME__` → `src/shared/constants.ts:207` exports `BUILD_TIME`. (Value = build ISO timestamp in prod, `'test-build'` under Vitest.)
- `virtual:model-card-drafts` → `src/shared/compare-cards.ts:1` imports it as `modelCardDrafts`. `getCompareDraftSource()` (`compare-cards.ts:9-14`) returns `globalThis.__CHATGOOSE_COMPARE_DRAFTS__` if set, else the bundled `modelCardDrafts` — a runtime override hook for the compare/"Multi" drafts. Because `prompts/drafts/` is gitignored/absent, the bundled default is `{}` in normal builds, and `getCompareDraftCount()` returns `0` unless a developer adds draft files or injects the global.
- `.md` text loader → `src/shared/prompts.ts:1-7` imports the seven feature prompt templates from `prompts/*.md` (`fast-reply`, `improve-draft`, `help-me`, `fan-summary`, `chat-review`, `ping`, `hi-greeting`). These `prompts/*.md` (not the `drafts/` subdir) are committed and present.
- `.css` text loader → `src/{options,popup,content}/index.ts` each import `./styles.css` as a string for runtime injection.

---

## 12. `.github/workflows/ci.yml` — CI

- `name: CI`. Triggers: `pull_request` (any), and `push` to `main`.
- Single job `check` on `ubuntu-latest`:
  1. `actions/checkout@v4`.
  2. `actions/setup-node@v4` with `node-version: 22`, `cache: npm`.
  3. `npm ci`.
  4. `npm run check` → `typecheck` (`tsc --noEmit`) + `test` (`vitest run`) + `build` (`node esbuild.config.mjs`).

CI does not sign, deploy, or upload artifacts; it only gates that the project type-checks, tests pass, and bundles.

---

## 13. `.gitignore` and `.env.deploy.example`

`.gitignore`:
```
node_modules/
dist/
.env.deploy
.DS_Store
TODO.md
TOMO.md
reviews/
drafts/
prompts/drafts/
.claude/
*.zip
```
Notable: `dist/` (build output), `.env.deploy` (AMO secrets), and both `drafts/` and `prompts/drafts/` (the compare draft sources consumed by the virtual module — hence empty by default). `TODO.md` is gitignored yet present in the working tree (`TOMO.md` does not exist).

`.env.deploy.example` — template for `.env.deploy`:
```
WEB_EXT_API_KEY=
WEB_EXT_API_SECRET=
```
The real `.env.deploy` (present locally, gitignored) supplies AMO JWT credentials consumed by `deploy.sh` → `web-ext sign`.

---

## 14. Ancillary files (existence + role only)

| File | Role |
|---|---|
| `README.md` | Human-facing product/feature overview (English). |
| `CHANGELOG.md` | Release changelog (Russian). Head shows `1.5.6`. |
| `changelog.html` | Release page deployed to VPS as `changelog.html` (stamped by deploy scripts). |
| `guide.html` | User guide page deployed to VPS as `guide.html` (stamped). |
| `install.html` | Install landing page deployed to VPS as `index.html` (stamped). References `mascot.png`. |
| `mascot.png` | Install-page image asset (~4.7 MB), uploaded to VPS as `mascot.png`. |
| `SPEC_FINAL.md` | Requirements spec (product version 1.3, dated 2026-03-01). |
| `TODO.md` | Working task list (gitignored but present). |
| `icons/` | `icon-48.png`, `icon-96.png`, `icon-128.png` — manifest/action icons, copied into `dist/icons/`. |

---

## 15. Boundaries touched by these files

| Kind | Detail |
|---|---|
| distribution | `manifest.json` `update_url = https://ext.gosling-agency.ru/updates.json`; `deploy.sh` signs (AMO `web-ext sign --channel unlisted`) and uploads `chatgoose-<version>.xpi` + `chatgoose-latest.xpi` + `updates.json` (with `update_hash: sha256:…`) to `root@45.8.230.111:/var/www/ext`. |
| distribution | AMO signing API via `web-ext sign` using `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET` from `.env.deploy`; leaves `dist/.amo-upload-uuid`. |
| network | `install.html`/`guide.html`/`changelog.html` public URLs verified via `curl` (deploy) and served by nginx (`setup-vps-ext.sh`); options/popup HTML fetch the `Outfit` font from `fonts.googleapis.com` at page load. |
| browser-api | manifest `permissions`: `storage`, `unlimitedStorage`, `webRequest`, `tabs`; `host_permissions` for `fansly.com`, `apiv3.fansly.com`, `api.anthropic.com`, `openrouter.ai`; `optional_host_permissions` `http://*/*` + `https://*/*` for the configurable Agency Hub origin. |
| build-define | `__CHATGOOSE_BUILD_TIME__` (esbuild `define`) → `BUILD_TIME`; `virtual:model-card-drafts` synthetic module → `compare-cards.ts`. |

## 16. Open questions / discrepancies

1. **Empty compare drafts by default.** `prompts/drafts/` is gitignored and not present, so `virtual:model-card-drafts` bundles to `{}` in a clean build; `getCompareDraftCount()` returns `0` unless drafts are added locally or `globalThis.__CHATGOOSE_COMPARE_DRAFTS__` is injected.
2. **esbuild target vs manifest min version.** esbuild targets `firefox128` while `manifest.json` declares `strict_min_version: 142.0` — the transpile floor is older than the declared runtime floor.
3. **`web-ext` not a declared dependency.** `deploy.sh` requires `web-ext` on `PATH`; it is absent from `package.json` (assumed global install on the deploy host).
4. **`tsconfig.outDir: dist-ts` unused.** Typecheck runs `--noEmit`; no `dist-ts/` is produced.
5. **`package.json main: index.js`** points to a nonexistent file (harmless; the package is not consumed as a module).
6. **`deploy-pages.sh` uploads non-atomically** (direct `scp` into final paths), whereas `deploy.sh` uses temp-file + `mv` swaps.
