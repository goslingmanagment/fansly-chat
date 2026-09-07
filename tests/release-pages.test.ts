import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CHANGELOG_URL } from '../src/shared/constants.js';

const root = new URL('../', import.meta.url);
const readRepoFile = (path: string): string =>
  readFileSync(new URL(path, root), 'utf8');

const replaceExactlyOnce = (
  source: string,
  pattern: RegExp,
  replacement: string,
): string => {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));
  expect(matches).toHaveLength(1);
  return source.replace(pattern, replacement);
};

describe('release page stamping', () => {
  it('has one mutable version slot per install/changelog location', () => {
    const install = readRepoFile('install.html');
    const changelog = readRepoFile('changelog.html');

    const stampedInstall = replaceExactlyOnce(
      install,
      /(<p class="footer">ChatGoose )v[^<]+( &middot; Gosling Agency<\/p>)/,
      '$1v9.8.7$2',
    );
    const stampedNav = replaceExactlyOnce(
      changelog,
      /(<span class="nav-version">)v[^<]+(<\/span>)/,
      '$1v9.8.7$2',
    );
    const stampedChangelog = replaceExactlyOnce(
      stampedNav,
      /(<p>)v[^<]+( &middot; Gosling Agency &middot; Kernel-served AI<\/p>)/,
      '$1v9.8.7$2',
    );

    expect(stampedInstall).toContain('<a class="btn-ghost" href="whats-new-2.html">Что нового в 2.0 →</a>');
    expect(stampedInstall).not.toContain('Что нового в 9.8.7');
    expect(stampedInstall).toContain('ChatGoose v9.8.7');
    expect(stampedChangelog).toContain('<span class="nav-version">v9.8.7</span>');
    expect(stampedChangelog).toContain('<p>v9.8.7 &middot; Gosling Agency');
  });

  it('makes both deploy scripts fail closed over the single install footer version slot', () => {
    const deploy = readRepoFile('scripts/deploy.sh');
    const deployPages = readRepoFile('scripts/deploy-pages.sh');

    for (const script of [deploy, deployPages]) {
      expect(script).not.toContain('Версия )[^<]+( · Firefox');
      expect(script).not.toContain('Что нового в )[^<]+( →');
      expect(script).toContain('ChatGoose v)[^<]+( &middot; Gosling Agency');
      expect(script).toContain('matches.length !== 1');
    }
  });


  it('publishes the fixed 2.0 walkthrough before pages linking to it, without stamping it', () => {
    const deploy = readRepoFile('scripts/deploy.sh');
    const pages = readRepoFile('scripts/deploy-pages.sh');
    for (const script of [deploy, pages]) {
      expect(script).toContain('readonly WHATS_NEW_PAGE_FILE="$ROOT_DIR/whats-new-2.html"');
      expect(script).toContain('scp "$WHATS_NEW_PAGE_FILE" "${VPS_HOST}:${remote_tmp_whats_new}"');
      expect(script).toContain('remote_tmp_whats_new="$REMOTE_DIR/.whats-new-2.html.upload.$$"');
      expect(script.indexOf("mv '$remote_tmp_whats_new'"))
        .toBeLessThan(script.indexOf("mv '$remote_tmp_index'"));
      expect(script).not.toMatch(/stamp\w*[^\n]*\$WHATS_NEW_PAGE_FILE/);
    }
    for (const entryPoint of ["mv '$remote_tmp_latest_xpi'", "mv '$remote_tmp_updates'"]) {
      expect(deploy.indexOf("mv '$remote_tmp_whats_new'"))
        .toBeLessThan(deploy.indexOf(entryPoint));
    }
    const main = deploy.indexOf('main() {');
    const signing = deploy.indexOf('  web-ext sign', main);
    const preflight = deploy.indexOf('require_file "$WHATS_NEW_PAGE_FILE"', main);
    expect(preflight).toBeGreaterThan(main);
    expect(preflight).toBeLessThan(signing);
    expect(deploy).toContain('REMOTE_WHATS_NEW_PATH="$REMOTE_DIR/whats-new-2.html"');
    expect(deploy).toContain('verify_http_200_with_retry "${BASE_URL}/whats-new-2.html"');
    expect(pages).toContain('[[ -f "$file" ]] || fail');
    expect(pages).toContain('for page in index.html guide.html changelog.html whats-new-2.html');
    expect(pages).toContain('[[ "$status" == "200" ]] || fail');
  });

  it('keeps local landing filenames out of public page links', () => {
    for (const page of ['install.html', 'whats-new-2.html', 'changelog.html', 'guide.html']) {
      const html = readRepoFile(page);
      expect(html).not.toMatch(/href=["'](?:\.\/|\/)?install\.html(?:["'#?])/);
      if (page !== 'whats-new-2.html') {
        expect(html).toContain('href="whats-new-2.html"');
      }
    }
  });

  it('pins the in-extension changelog link to the host deploy.sh publishes', () => {
    // The changelog is a WEB page (E59) — the extension only links to it, so the
    // constant and the deploy target are one fact in two files. A drift here ships
    // a rail link to a host nobody publishes.
    const deploy = readRepoFile('scripts/deploy.sh');
    const baseUrl = /readonly BASE_URL="([^"]+)"/.exec(deploy)?.[1];
    expect(baseUrl).toBeTruthy();
    expect(CHANGELOG_URL).toBe(`${baseUrl ?? ''}/changelog.html`);
    // …and that is the file the deploy actually uploads.
    expect(deploy).toContain('REMOTE_CHANGELOG_PATH="$REMOTE_DIR/changelog.html"');
    // No `#v<X-Y-Z>` anchor while the anchored per-release page (E42) is not
    // deployed: adding the anchor is a release commit that must FOLLOW that
    // deploy, never precede it.
    expect(CHANGELOG_URL).not.toContain('#');
  });

  it('keeps the guide intentionally versionless', () => {
    const guide = readRepoFile('guide.html');

    expect(guide).toContain('<span class="nav-version">auto-update</span>');
    expect(guide).toContain('Версию проверяйте по update feed');
    expect(guide).not.toMatch(/<span class="nav-version">v[^<]+<\/span>/);
  });

  it('validates pages and remote identity before AMO signing', () => {
    const deploy = readRepoFile('scripts/deploy.sh');
    const deployEnvExample = readRepoFile('.env.deploy.example');
    const mainIndex = deploy.indexOf('main() {');
    const coreGateIndex = deploy.indexOf('  assert_core_persona_catalog_ready', mainIndex);
    const stampIndex = deploy.indexOf('  stamp_release_pages "$version"', mainIndex);
    const signIndex = deploy.indexOf('  web-ext sign \\', mainIndex);

    expect(coreGateIndex).toBeGreaterThan(mainIndex);
    expect(stampIndex).toBeGreaterThan(mainIndex);
    expect(signIndex).toBeGreaterThan(stampIndex);
    expect(coreGateIndex).toBeLessThan(signIndex);
    expect(deploy).toContain('fetch origin main --tags --quiet');
    expect(deploy).toContain('rev-parse origin/main');
    expect(deploy).toContain('/api/v1/ai/persona-catalog');
    expect(deploy).toContain('if [[ "$status" != "401" ]]');
    expect(deploy).toContain(
      'readonly PRODUCTION_AGENCY_HUB_BASE_URL="https://gosling-agency.ru"',
    );
    expect(deploy).toContain(
      '[[ "$AGENCY_HUB_BASE_URL" != "$PRODUCTION_AGENCY_HUB_BASE_URL" ]]',
    );
    expect(deploy).toContain('health.contractHash');
    expect(deploy).toContain('[[ "$deployed_contract_hash" != "$expected_contract_hash" ]]');
    expect(deployEnvExample).toContain(
      'AGENCY_HUB_BASE_URL=https://gosling-agency.ru',
    );
    expect(deploy).toContain('vendor/kernel-sdk/kernel-sdk.vendor.json');
    expect(deploy).toContain('manifest.sourceCommit');
    expect(deploy).toContain('[[ ! "$vendor_source_commit" =~ ^[0-9a-f]{40}$ ]]');
    expect(deploy.indexOf('[[ ! "$vendor_source_commit" =~ ^[0-9a-f]{40}$ ]]'))
      .toBeLessThan(signIndex);
    expect(deploy).not.toContain('stamp_guide_page_version');
  });

  it('checks the announce before signing and sends it only after tagging', () => {
    const deploy = readRepoFile('scripts/deploy.sh');
    const mainIndex = deploy.indexOf('main() {');
    const checkIndex = deploy.indexOf('announce-release.mjs" --check --version', mainIndex);
    const signIndex = deploy.indexOf('  web-ext sign \\', mainIndex);
    const tagIndex = deploy.indexOf('  tag_release "$version"', mainIndex);
    const skipGuardIndex = deploy.indexOf('"${SKIP_ANNOUNCE:-0}" == "1"', mainIndex);
    const sendIndex = deploy.indexOf('announce-release.mjs" --version', mainIndex);
    expect(checkIndex).toBeGreaterThan(mainIndex);
    expect(signIndex).toBeGreaterThan(checkIndex);
    expect(tagIndex).toBeGreaterThan(signIndex);
    expect(skipGuardIndex).toBeGreaterThan(tagIndex);
    expect(sendIndex).toBeGreaterThan(skipGuardIndex);
    // Announce failure is nonfatal once the release is live, and the send
    // requires credentials up front (deterministic failures fail preflight).
    expect(deploy).toContain('WARNING: Telegram announce failed');
    expect(deploy).toContain('TELEGRAM_BOT_TOKEN:?Missing');
    // The token must never be exported to child processes.
    expect(deploy).not.toContain('set -a');
  });
});
