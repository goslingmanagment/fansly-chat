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

  it('keeps one upload host across both deploy scripts, replaceable from the environment', () => {
    // The host is one fact written in two scripts. If the copies drift, the
    // pages go to a server the release never uploads to. CHATGOOSE_VPS_HOST
    // moves both at once, so a server move needs no code change.
    const deploy = readRepoFile('scripts/deploy.sh');
    const pages = readRepoFile('scripts/deploy-pages.sh');

    const defaults = [deploy, pages].map(
      (script) => /^readonly VPS_HOST="\$\{CHATGOOSE_VPS_HOST:-([^}"]+)\}"$/m.exec(script)?.[1],
    );
    expect(defaults[0]).toMatch(/^root@\d+(\.\d+){3}$/);
    expect(new Set(defaults).size).toBe(1);
  });

  it('proves the upload host serves the public name before signing or uploading anything', () => {
    // The scripts upload to VPS_HOST over SSH and check the result through
    // BASE_URL. When another server answers for the public name, the release
    // path spends an AMO version on files nobody reads, and both page paths
    // report success on the other server's old pages. A marker written into
    // REMOTE_DIR and read back through BASE_URL ties the two together. It
    // also holds when another server forwards the name to the upload host,
    // which a DNS comparison would reject.
    const deploy = readRepoFile('scripts/deploy.sh');
    const pages = readRepoFile('scripts/deploy-pages.sh');

    const probeOf = (script: string): string => {
      const start = script.indexOf('assert_upload_host_serves_public_site() {\n');
      expect(start).toBeGreaterThan(-1);
      const end = script.indexOf('\n}\n', start);
      expect(end).toBeGreaterThan(start);
      return script.slice(start, end);
    };
    const probe = probeOf(deploy);
    // One check in two self-contained scripts: the copies may not drift.
    expect(probeOf(pages)).toBe(probe);

    // Write over SSH, read through the public name, remove, then judge. The
    // removal comes before the verdict, so a failed check leaves nothing in
    // the public directory.
    const write = probe.indexOf(
      `ssh "$VPS_HOST" "printf '%s' '$token' > '$marker_path' && chmod 644 '$marker_path'"`,
    );
    const read = probe.indexOf('"${BASE_URL}/${marker_name}"');
    const remove = probe.indexOf(`ssh "$VPS_HOST" "rm -f '$marker_path'"`);
    const verdict = probe.indexOf('if [[ "$status" == "200" && "$served" == "$token" ]]; then');
    expect(write).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(write);
    expect(remove).toBeGreaterThan(read);
    expect(verdict).toBeGreaterThan(remove);
    // Only the marker itself passes: the verdict holds the one `return`, there
    // is no switch that skips the check, and the function ends in a failure.
    // Each failure names the upload host; a refusal (the 403 a new server
    // answers until the name moves to it) is not reported as another server.
    expect(probe.match(/\breturn\b/g)).toHaveLength(1);
    expect(probe.slice(verdict)).toContain(
      'The public name is served elsewhere: a marker written to ${VPS_HOST}:${REMOTE_DIR} did not come back through ${BASE_URL}',
    );
    expect(probe.slice(verdict)).toContain(
      'The public name refused the probe marker (HTTP ${status}): a marker written to ${VPS_HOST}:${REMOTE_DIR}',
    );
    expect(probe.slice(verdict)).toContain('Could not check that ${BASE_URL} is served from ${VPS_HOST}:${REMOTE_DIR}');
    expect(probe.trimEnd().split('\n').at(-1)).toMatch(/^ {2}fail "/);

    // The token is random and reaches a remote command and a URL only as 32
    // hex characters.
    expect(probe).toContain('randomBytes(16).toString("hex")');
    const shape = probe.indexOf('if [[ ! "$token" =~ ^[0-9a-f]{32}$ ]]; then');
    expect(shape).toBeGreaterThan(-1);
    expect(shape).toBeLessThan(write);
    // A name that is new on every run, so no cache has an answer for it, and
    // that matches none of the nginx locations with rules of their own.
    expect(probe).toContain('local marker_name=".upload-host-probe.${token}"');
    // An error page is never read as the marker, with or without retries.
    expect(probe).toContain('      --fail \\\n');
    // `|| true` outside the substitution: inside it, bash 5.3 skipped the EXIT
    // trap on a SIGHUP during the read and the marker stayed on the server.
    expect(probe).toContain('      "${BASE_URL}/${marker_name}"\n  )" || true\n');
    // A host without REMOTE_DIR does not serve the site: never create it here.
    expect(probe).not.toContain('mkdir');

    // Release path: with the other preflight asserts, before the build and
    // before the irreversible AMO request.
    const main = deploy.indexOf('main() {');
    const releaseCall = deploy.indexOf('\n  assert_upload_host_serves_public_site\n', main);
    expect(releaseCall).toBeGreaterThan(deploy.indexOf('\n  assert_core_persona_catalog_ready\n', main));
    expect(releaseCall).toBeLessThan(deploy.indexOf('  pnpm build', main));
    expect(releaseCall).toBeLessThan(deploy.indexOf('  web-ext sign \\', main));

    // --pages-only: after the provenance asserts, before the upload.
    const pagesOnly = deploy.slice(
      deploy.indexOf('publish_pages_only() {'),
      deploy.indexOf('assert_pages_only_preconditions() {'),
    );
    const pagesOnlyCall = pagesOnly.indexOf('\n  assert_upload_host_serves_public_site\n');
    expect(pagesOnlyCall).toBeGreaterThan(pagesOnly.indexOf('\n  assert_pages_only_preconditions\n'));
    expect(pagesOnlyCall).toBeLessThan(pagesOnly.indexOf('ssh "$VPS_HOST"'));
    expect(pagesOnlyCall).toBeLessThan(pagesOnly.search(/\bscp\b/));

    // deploy-pages.sh: after its own gate, before anything is stamped or sent.
    const pagesMain = pages.indexOf('main() {');
    const pagesCall = pages.indexOf('\n  assert_upload_host_serves_public_site\n', pagesMain);
    expect(pagesCall).toBeGreaterThan(pages.indexOf('  assert_pages_preconditions "$version"', pagesMain));
    expect(pagesCall).toBeLessThan(pages.indexOf('stamp_version "$INSTALL_PAGE_FILE"'));
    expect(pagesCall).toBeLessThan(pages.indexOf('ssh "$VPS_HOST" "mkdir -p'));
    expect(pagesCall).toBeLessThan(pages.indexOf('scp "$INSTALL_PAGE_FILE"'));

    // No way out leaves the marker unattended: the probe names it before the
    // write, forgets the name in one place only, after a removal succeeded
    // (a failed write may have left the file all the same), and both EXIT
    // traps remove the marker they are told about.
    const named = probe.indexOf('upload_host_probe_marker="$marker_path"');
    expect(named).toBeGreaterThan(-1);
    expect(named).toBeLessThan(write);
    const forgotten = probe.indexOf('upload_host_probe_marker=""');
    expect(forgotten).toBeGreaterThan(remove);
    expect(forgotten).toBeLessThan(verdict);
    expect(probe.lastIndexOf('upload_host_probe_marker=""')).toBe(forgotten);
    for (const script of [deploy, pages]) {
      const cleanup = script.slice(script.indexOf('cleanup() {'), script.indexOf('trap cleanup EXIT'));
      expect(cleanup).toContain(`"rm -f '$upload_host_probe_marker'"`);
    }
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
