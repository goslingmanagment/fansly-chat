> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# 01 — Build, Packaging, Toolchain, Distribution

Covers the build pipeline (`esbuild.config.mjs`), the WebExtension manifest
(`manifest.json`), the TypeScript / vitest / eslint toolchain, the CI workflow,
the ambient type declarations, and the self-hosted release/distribution scripts.

## 1. Package identity & scripts

`package.json:1-40`:

- `name: "chatgoose"`, `version: "1.6.0"`, `type: "module"`, `packageManager: "pnpm@10.33.1"`, `engines.node >= 22`.
- Dependencies (`package.json:34-37`): `@kernel/sdk` is `link:./vendor/kernel-sdk` (the vendored compiled kernel SDK — see `15-vendor-kernel-sdk.md`), and `zod ^4.1.5`. There is **no** `@anthropic-ai/sdk`, no OpenRouter dependency, no other runtime dependency — the vendor AI stack was removed in the Stage 32 cutover.
- devDependencies (`package.json:22-32`): `esbuild ^0.27.3`, `typescript ^6.0.3`, `typescript-eslint ^8.46.4`, `eslint ^9.39.1`, `vitest ^4.0.18`, `jsdom ^28.1.0`, `@types/firefox-webext-browser ^143.0.0`.
- Scripts (`package.json:11-19`):
  - `build` → `node esbuild.config.mjs`
  - `check` → `pnpm typecheck && pnpm lint && pnpm gates && pnpm test && pnpm build`
  - `watch` → `node esbuild.config.mjs --watch`
  - `lint` → `eslint .`
  - `test` / `test:watch` → `vitest run` / `vitest`
  - `typecheck` → `tsc --noEmit`
  - `gates` → `node scripts/check-ai-cutover.mjs`
- `pnpm.onlyBuiltDependencies: ["esbuild"]` (`package.json:38-41`).

## 2. esbuild bundle pipeline (`esbuild.config.mjs`)

Four IIFE entry points, one per extension context (`esbuild.config.mjs:12-17`):

| Entry | Source | Output |
|---|---|---|
| `background` | `src/background/index.ts` | `dist/background.js` |
| `content` | `src/content/index.ts` | `dist/content.js` |
| `options` | `src/options/index.ts` | `dist/options.js` |
| `popup` | `src/popup/index.ts` | `dist/popup.js` |

Build options (`esbuild.config.mjs:84-100`): `bundle: true`, `format: 'iife'`,
`platform: 'browser'`, `target: ['firefox128']`, `sourcemap: true`. Loaders map
`.md` and `.css` to `text` (`esbuild.config.mjs:92-95`) — Markdown and CSS files
are inlined into the JS bundles as strings. A `define` injects
`__CHATGOOSE_BUILD_TIME__` as the ISO build timestamp (`esbuild.config.mjs:96-98`),
consumed via `src/shared/constants.ts:150` (`BUILD_TIME`) and declared in
`src/env.d.ts:1`.

`ensureStaticFiles()` (`esbuild.config.mjs:67-78`) copies non-bundled assets into
`dist/`: `options.html`, `popup.html`, `manifest.json`, and the `icons/` folder.
`buildOnce()` (`esbuild.config.mjs:80-103`) wipes and recreates `dist/` before
each build. Watch mode (`esbuild.config.mjs:105-170`) adds a static-copy plugin
on `onEnd` and filesystem watchers.

### The `virtual:model-card-drafts` plugin and the missing `prompts/` directory

`modelCardDraftsPlugin()` (`esbuild.config.mjs:26-65`) resolves the virtual
module `virtual:model-card-drafts` by reading `prompts/drafts/*.md`
(`esbuild.config.mjs:9-10`, `draftsDir`). **The `prompts/` directory does not
exist in the repository** (it is also listed in `.gitignore:11-12` as
`drafts/` / `prompts/drafts/`). When `readdir(draftsDir)` throws, the plugin
falls back to `files = []` (`esbuild.config.mjs:42-45`), so the virtual module
compiles to `export default { };` — an **empty draft catalog**. The consumer is
`src/shared/compare-cards.ts` (documented in `04-background-compare.md`); its
runtime catalog is therefore currently empty. The ambient module declaration is
`src/virtual-drafts.d.ts` (`Record<string, string>`). `vitest.config.ts:5-28`
mirrors the same `prompts/drafts` read with the same empty-object fallback for
the test environment.

## 3. WebExtension manifest (`manifest.json`)

- `manifest_version: 3` (`manifest.json:2`) — note the repo's `CLAUDE.md`
  prose says "MV2"; the actual manifest is **MV3**.
- `name: "ChatGoose"`, `version: "1.6.0"`, `description: "AI-powered chat assistant for Fansly.com"` (`manifest.json:3-5`).
- `permissions` (`manifest.json:6-11`): `storage`, `unlimitedStorage`, `webRequest`, `tabs`.
- `host_permissions` (`manifest.json:12-15`): `*://fansly.com/*`, `*://apiv3.fansly.com/*` — the only statically granted hosts.
- `optional_host_permissions` (`manifest.json:16-19`): `http://*/*`, `https://*/*` — the Agency Hub / kernel origin is requested at runtime from this broad optional grant (the options page requests it; `AgencyHubClient.hasHostPermission` gates every kernel call — see `src/background/agency-hub-client.ts:130-145`). There are **no** static vendor AI hosts (`api.anthropic.com`, `openrouter.ai`) in the manifest — removed at cutover.
- `background.scripts: ["background.js"]` (`manifest.json:20-24`) — a non-persistent MV3 background loaded as a classic script (not a module worker).
- `content_scripts` (`manifest.json:25-35`): `content.js` injected into `*://fansly.com/*` at `run_at: document_idle`.
- `action.default_popup: "popup.html"` (`manifest.json:36-43`); `options_ui.page: "options.html"`, `open_in_tab: true` (`manifest.json:44-47`).
- `browser_specific_settings.gecko` (`manifest.json:53-67`): `id: "chatgoose@gosling.agency"`, `strict_min_version: "142.0"`, `update_url: "https://ext.gosling-agency.ru/updates.json"` (self-hosted update feed), and `data_collection_permissions.required` declaring `authenticationInfo`, `personallyIdentifyingInfo`, `personalCommunications`, `financialAndPaymentInfo`, `websiteContent`.

The Pass 1 historical map recorded the vendor-AI host permissions and additional
data-collection scoping; the current manifest carries none of the vendor hosts —
the cutover shrank the permission surface (release notes in `CLAUDE.md:13-20`).

## 4. TypeScript config (`tsconfig.json`)

`target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `lib: [DOM, DOM.Iterable, ES2022]`, `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `noFallthroughCasesInSwitch: true`, `skipLibCheck: true`, `types: ["firefox-webext-browser"]`, `isolatedModules: true`, `useDefineForClassFields: true`, `outDir: dist-ts` (`tsconfig.json:2-19`). `include: ["src/**/*.ts", "tests/**/*.ts"]` (`tsconfig.json:20`). The config is browser-pure (the `browser.*` global comes from `@types/firefox-webext-browser`); Node-only scripts (`scripts/*.mjs`) live outside the typecheck and get their globals from the eslint config instead. `tsc --noEmit` (typecheck) doubles as the kernel-contract breaking-change gate: a renamed SDK operation fails compilation at every call site (`CLAUDE.md:72-74`).

## 5. Vitest config (`vitest.config.ts`)

- `test.environment: 'node'` (`vitest.config.ts:61`), `globals: true`, `include: ['tests/**/*.test.ts']`, coverage reporters `text`/`html`. DOM-dependent tests construct jsdom explicitly rather than using a global jsdom environment (see `16-tests-overview.md`).
- `define.__CHATGOOSE_BUILD_TIME__` is stubbed to `'test-build'` (`vitest.config.ts:31-33`).
- Two plugins reproduce esbuild's asset handling: `chatgoose-raw-text-assets` turns `.md`/`.css` imports into default-string exports (`vitest.config.ts:35-43`), and `chatgoose-virtual-drafts` resolves `virtual:model-card-drafts` via `loadDrafts()` (`vitest.config.ts:44-58`), which reads `prompts/drafts` and falls back to `{}` when absent (`vitest.config.ts:14-28`).

## 6. ESLint config (`eslint.config.mjs`)

Flat config (`typescript-eslint`). Notable rules:

- Ignores `node_modules`, `dist`, `dist-ts`, `vendor/**` (the generated SDK is never linted), `coverage`, `docs` (`eslint.config.mjs:11-20`).
- `@typescript-eslint/no-explicit-any: 'error'` (`eslint.config.mjs:47`); `no-unused-vars` allows `^_` prefixes (`eslint.config.mjs:37-40`).
- **Process-split boundary rule** (`eslint.config.mjs:57-74`): files under `src/content/**` may not import from `**/background/*` (`no-restricted-imports`) — content scripts run in the page world and must talk to the background only over runtime messaging. This is a lint-enforced architectural boundary.
- `.mjs` config/scripts get Node globals injected (`eslint.config.mjs:24-34`); `.d.ts` files relax `consistent-type-imports` (`eslint.config.mjs:51-56`).

## 7. AI-cutover grep gates (`scripts/check-ai-cutover.mjs`, `pnpm gates`)

A standalone Node script (run inside `pnpm check`) that greps `src/**/*.ts` and fails the build if the cutover is regressed (`scripts/check-ai-cutover.mjs`):

- Fails if any file references `api.anthropic.com` or `openrouter.ai` (`scripts/check-ai-cutover.mjs:25-28`) — no direct vendor endpoints allowed.
- Fails if any file imports a deleted module (`scripts/check-ai-cutover.mjs:30-35`): `llm-client`, `anthropic-client`, `openrouter-client`, `llm-cost`, `llm-stream-utils`, `model-registry`, `model-capabilities`, `feature-readiness`, `agency-hub-usage-reporter`, `shared/prompts`. This enumerates the modules that existed pre-cutover and are now gone. A mirrored assertion runs inside vitest as `tests/ai-cutover-gates.test.ts` (see `16-tests-overview.md`).

## 8. Ambient declarations

- `src/env.d.ts`: declares `__CHATGOOSE_BUILD_TIME__: string`, the `*.md`/`*.css` string modules, and a narrow `node:fs.readFileSync` shim.
- `src/virtual-drafts.d.ts`: declares `virtual:model-card-drafts` as `Record<string, string>`.
- `tests/jsdom.d.ts`, `tests/node-shims.d.ts`: test-only ambient types (see `16-tests-overview.md`).

## 9. CI (`.github/workflows/ci.yml`)

Triggers on every `pull_request` and on pushes to `main` and `bar-tone-menu`
(`.github/workflows/ci.yml:3-8`). One `check` job on `ubuntu-latest`: checkout →
pnpm setup → Node 22 with pnpm cache → `pnpm install --frozen-lockfile` →
`pnpm check` (`.github/workflows/ci.yml:10-33`). The vendored-SDK drift gate
(`tests/kernel-sdk-vendor.test.ts`, asserting the vendor manifest `contractHash`
== the SDK's exported `KERNEL_CONTRACT_HASH`) runs inside the test step
(`.github/workflows/ci.yml:29-31`).

## 10. Distribution — self-hosted Firefox auto-update

The extension is **not** listed on AMO; it is signed unlisted and served from a
self-hosted feed. `.env.deploy` / `.env.deploy.example` hold AMO API credentials
(`WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`, read at `scripts/deploy.sh:79-80`).

### `scripts/deploy.sh` — full release

Constants (`scripts/deploy.sh:5-22`): VPS `root@152.53.191.242` (the default;
`CHATGOOSE_VPS_HOST` overrides it), remote dir
`/var/www/ext`, base URL `https://ext.gosling-agency.ru`, extension id
`chatgoose@gosling.agency`. Flow (`scripts/deploy.sh:259-410`):

1. Requires `node`, `pnpm`, `web-ext`, `ssh`, `scp`, `curl`, `shasum`.
2. `pnpm build`.
3. Reads `version` and `strict_min_version` from `manifest.json` and asserts `package.json` version == manifest version (`scripts/deploy.sh:284-290`) — a mismatch aborts before signing.
4. `web-ext sign --channel unlisted --source-dir dist` against AMO (`scripts/deploy.sh:295-304`), producing a signed `.xpi`.
5. Builds `updates.json` with the version, `update_link` (`…/chatgoose-<version>.xpi`), `update_hash: sha256:<sha>`, and gecko `strict_min_version` (`scripts/deploy.sh:321-340`).
6. Stamps the version into the user-facing pages (`install.html`, `guide.html`, `changelog.html`) via regex slots, then restores the working copies afterward (`scripts/deploy.sh:132-226, 357-368`).
7. Uploads xpi + `chatgoose-latest.xpi` + `updates.json` + the three HTML pages + `mascot.png` atomically (temp file → `mv`) over ssh/scp (`scripts/deploy.sh:342-382`).
8. Verifies the install page, `updates.json`, versioned xpi, and latest xpi all return HTTP 200 (retry loop, `scripts/deploy.sh:228-257, 384-388`).
9. Asserts the **served** `updates.json` version equals the release version (`scripts/deploy.sh:390-406`) — guards against a stale upload.

### `scripts/deploy-pages.sh` — pages-only

Deploys only `install.html` / `guide.html` / `changelog.html` (+ `mascot.png`)
without rebuilding or re-signing (`scripts/deploy-pages.sh:1-99`); stamps versions
from `manifest.json` and scps to the same VPS.

### `scripts/setup-vps-ext.sh` — removed (E147)

The one-time provisioning script for the nginx site of `ext.gosling-agency.ru`
was removed in 2026-10: nothing in the repository creates or rewrites that
site. README «The site on the server» describes the site file. The extension
feed and the kernel/Agency Hub API share the same physical VPS
(`152.53.191.242`) but distinct nginx sites/hostnames.

The user-facing HTML pages themselves (`install.html`, `guide.html`,
`changelog.html`, `README.md`, `changelog.html`) live at the repo root and are
release artifacts, not part of the extension bundle.
