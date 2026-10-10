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


  it('publishes «Как начать» on the release path too, unstamped, before the pages linking to it', () => {
    // The invite message and both clients point at start.html, so it must be
    // live BEFORE the first invite goes out — and it carries no version slot:
    // the page describes a ceremony, not a build.
    const deploy = readRepoFile('scripts/deploy.sh');
    const pages = readRepoFile('scripts/deploy-pages.sh');
    const start = readRepoFile('start.html');

    for (const script of [deploy, pages]) {
      expect(script).toContain('readonly START_PAGE_FILE="$ROOT_DIR/start.html"');
      expect(script).toContain('scp "$START_PAGE_FILE" "${VPS_HOST}:${remote_tmp_start}"');
      // No stamper ever touches it — not by name, and not by the shared helper.
      expect(script).not.toMatch(/stamp\w*[^\n]*\$START_PAGE_FILE/);
    }

    // Scoped to the RELEASE upload block, not «somewhere in the file»: the
    // pages-only function mentions the same variables, so a file-wide indexOf
    // would pass on the wrong occurrence.
    const releaseUpload = deploy.slice(deploy.indexOf('log "Uploading signed package'));
    expect(releaseUpload).toContain('scp "$START_PAGE_FILE" "${VPS_HOST}:${remote_tmp_start}"');
    expect(releaseUpload.indexOf("mv '$remote_tmp_start'"))
      .toBeLessThan(releaseUpload.indexOf("mv '$remote_tmp_index'"));
    // …and the release verifies it served, which it did not before (P2-8).
    const releaseVerify = deploy.slice(deploy.indexOf('log "Verifying public URLs"'));
    expect(releaseVerify).toContain('verify_http_200_with_retry "${BASE_URL}/start.html" "start page"');

    expect(deploy).toContain('readonly REMOTE_START_PATH="$REMOTE_DIR/start.html"');
    expect(pages).toContain('for page in index.html guide.html changelog.html whats-new-2.html start.html');
    // …and the pages that send a chatter there actually link to it.
    for (const page of ['install.html', 'guide.html']) {
      expect(readRepoFile(page)).toContain('href="start.html"');
    }
    expect(start).not.toMatch(/<span class="nav-version">v[^<]+<\/span>/);
  });

  it('deploy-pages.sh can only ever restate the version the feed already serves', () => {
    // It stamps install.html and changelog.html from the LOCAL manifest, so
    // between a version bump and the release it would publish a landing page
    // advertising a build nobody can install. The parity gate is what keeps it
    // an «republish the current release» tool rather than a second, unguarded
    // release path.
    const pages = readRepoFile('scripts/deploy-pages.sh');
    const deploy = readRepoFile('scripts/deploy.sh');

    expect(pages).toContain('assert_pages_preconditions() {');
    // Called BEFORE anything is stamped or uploaded.
    const gateCall = pages.indexOf('  assert_pages_preconditions "$version"');
    expect(gateCall).toBeGreaterThan(-1);
    expect(gateCall).toBeLessThan(pages.indexOf('stamp_version "$INSTALL_PAGE_FILE"'));
    expect(gateCall).toBeLessThan(pages.indexOf('scp "$INSTALL_PAGE_FILE"'));

    // Same provenance asserts the release path has.
    expect(pages).toContain("Public pages ship from main; current branch is '$branch'");
    expect(pages).toContain('Working tree is dirty');
    expect(pages).toContain('HEAD does not exactly match origin/main');

    // …plus the one this script needs and the release path does not: the local
    // manifest must equal the served feed, and an unreadable feed fails closed.
    expect(pages).toContain('read_served_feed_version() {');
    expect(pages).toContain('if [[ "$served_version" != "$version" ]]; then');
    expect(pages).toContain('сначала релиз через deploy.sh');
    expect(pages).toContain('refusing to stamp pages against a version nobody can confirm');

    // The feed is read through the same extension id the release path writes.
    const extensionId = /readonly EXTENSION_ID="([^"]+)"/.exec(deploy)?.[1];
    expect(extensionId).toBeTruthy();
    expect(pages).toContain(`readonly EXTENSION_ID="${extensionId ?? ''}"`);
  });

  it('--pages-only publishes ONLY start.html: no stamping, no landing, no feed', () => {
    // The mode exists to put «Как начать» online BEFORE the release it belongs
    // to. Anything else it touched would advertise an unreleased build: the
    // landing and the changelog are stamped from the LOCAL manifest, so an
    // early publish would describe a pane the feed cannot yet deliver.
    const deploy = readRepoFile('scripts/deploy.sh');
    const pagesOnlyStart = deploy.indexOf('publish_pages_only() {');
    const pagesOnlyEnd = deploy.indexOf('assert_pages_only_preconditions() {');
    expect(pagesOnlyStart).toBeGreaterThan(-1);
    expect(pagesOnlyEnd).toBeGreaterThan(pagesOnlyStart);
    const body = deploy.slice(pagesOnlyStart, pagesOnlyEnd);

    // What it DOES: one file, one verify.
    expect(body).toContain('scp "$START_PAGE_FILE" "${VPS_HOST}:${remote_tmp_start}"');
    expect(body).toContain("mv '$remote_tmp_start' '$REMOTE_START_PATH'");
    expect(body.match(/\bscp\b/g)).toHaveLength(1);
    expect(body.match(/verify_http_200_with_retry/g)).toHaveLength(1);

    // What it must NEVER do.
    for (const forbidden of [
      'stamp_release_pages',
      'INSTALL_PAGE_FILE',
      'CHANGELOG_PAGE_FILE',
      'GUIDE_PAGE_FILE',
      'WHATS_NEW_PAGE_FILE',
      'INSTALL_PAGE_ASSET',
      'REMOTE_INDEX_PATH',
      'REMOTE_UPDATES_PATH',
      'web-ext sign',
      'tag_release',
      'announce-release.mjs',
      'xpi',
    ]) {
      expect(body).not.toContain(forbidden);
    }

    // Provenance still applies: it publishes the working tree to a public site.
    expect(body).toContain('assert_pages_only_preconditions');
    const gates = deploy.slice(pagesOnlyEnd, deploy.indexOf('main() {'));
    expect(gates).toContain("Public pages ship from main; current branch is '$branch'");
    expect(gates).toContain('Working tree is dirty');
    expect(gates).toContain('HEAD does not exactly match origin/main');
    // The contract-hash gate is deliberately NOT here: start.html makes no
    // kernel call, and requiring it would block publishing ahead of the kernel.
    expect(gates).not.toContain('contractHash');

    expect(deploy).toContain('--pages-only) pages_only=1 ;;');
    expect(deploy).toContain('    publish_pages_only\n');
    expect(deploy).toContain('Unknown argument: $1 (supported: --pages-only)');
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

  it('keeps one upload host across the three scripts, replaceable from the environment', () => {
    // The host is one fact written in three scripts. If the copies drift, the
    // pages go to a server the release never uploads to. CHATGOOSE_VPS_HOST
    // moves all three at once, so a server move needs no code change.
    const deploy = readRepoFile('scripts/deploy.sh');
    const pages = readRepoFile('scripts/deploy-pages.sh');
    const setup = readRepoFile('scripts/setup-vps-ext.sh');

    const defaults = [deploy, pages, setup].map(
      (script) => /^readonly VPS_HOST="\$\{CHATGOOSE_VPS_HOST:-([^}"]+)\}"$/m.exec(script)?.[1],
    );
    expect(defaults[0]).toMatch(/^root@\d+(\.\d+){3}$/);
    expect(new Set(defaults).size).toBe(1);

    // setup-vps-ext.sh waits for DNS to show the server's address before it
    // asks certbot for a certificate. That address is the host's, checked
    // before connecting and handed to the remote half as its argument — a
    // second literal there would outlive the next move.
    expect(setup).toContain('readonly EXPECTED_IP="${VPS_HOST#*@}"');
    const connect = setup.indexOf(`ssh "$VPS_HOST" "bash -s -- '$EXPECTED_IP'" <<'REMOTE'`);
    expect(connect).toBeGreaterThan(-1);
    const formatCheck = setup.indexOf('if [[ ! "$EXPECTED_IP" =~ ');
    expect(formatCheck).toBeGreaterThan(-1);
    expect(formatCheck).toBeLessThan(connect);
    const remote = setup.slice(connect);
    expect(remote).toContain('readonly EXPECTED_IP="${1:?');
    expect(remote).not.toMatch(/EXPECTED_IP="\d/);
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
