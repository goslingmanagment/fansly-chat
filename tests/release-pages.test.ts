import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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

    const stampedInstallHero = replaceExactlyOnce(
      install,
      /(<span class="eyebrow rise d1"><span class="dot"><\/span> Версия )[^<]+( · Firefox<\/span>)/,
      '$19.8.7$2',
    );
    const stampedInstallLink = replaceExactlyOnce(
      stampedInstallHero,
      /(<a class="btn-ghost" href="#whatsnew">Что нового в )[^<]+( →<\/a>)/,
      '$19.8.7$2',
    );
    const stampedInstall = replaceExactlyOnce(
      stampedInstallLink,
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

    expect(stampedInstall).toContain('Версия 9.8.7 · Firefox');
    expect(stampedInstall).toContain('Что нового в 9.8.7 →');
    expect(stampedInstall).toContain('ChatGoose v9.8.7');
    expect(stampedChangelog).toContain('<span class="nav-version">v9.8.7</span>');
    expect(stampedChangelog).toContain('<p>v9.8.7 &middot; Gosling Agency');
  });

  it('makes both deploy scripts fail closed over all three install version slots', () => {
    const deploy = readRepoFile('scripts/deploy.sh');
    const deployPages = readRepoFile('scripts/deploy-pages.sh');

    for (const script of [deploy, deployPages]) {
      expect(script).toContain('Версия )[^<]+( · Firefox');
      expect(script).toContain('Что нового в )[^<]+( →');
      expect(script).toContain('ChatGoose v)[^<]+( &middot; Gosling Agency');
      expect(script).toContain('matches.length !== 1');
    }
  });

  it('gives every release div a unique anchor id matching its version', () => {
    const changelog = readRepoFile('changelog.html');
    // Each release div carries `id="vX-Y-Z"` derived from its release-version, so
    // the Changelog button's `#v<major>-<minor>-<patch>` target is a real anchor.
    const releaseBlocks = changelog.match(
      /<div class="release"[^>]*>\s*<div class="release-header">\s*<span class="release-version">([0-9]+\.[0-9]+\.[0-9]+)<\/span>/g,
    );
    const openTags = changelog.match(/<div class="release"[^>]*>/g) ?? [];
    // No release div is left without the anchor pass.
    expect(releaseBlocks).not.toBeNull();
    expect(releaseBlocks!.length).toBe(openTags.length);

    const ids: string[] = [];
    const pairRe =
      /<div class="release"([^>]*)>\s*<div class="release-header">\s*<span class="release-version">([0-9]+\.[0-9]+\.[0-9]+)<\/span>/g;
    for (let match = pairRe.exec(changelog); match !== null; match = pairRe.exec(changelog)) {
      const attrs = match[1]!;
      const version = match[2]!;
      const expectedId = `v${version.replace(/\./g, '-')}`;
      expect(attrs).toContain(`id="${expectedId}"`);
      ids.push(expectedId);
    }
    // Unique ids (a duplicate would make the browser jump to the wrong release).
    expect(new Set(ids).size).toBe(ids.length);

    // The anchor for the CURRENT shipped version must exist — the button target.
    const pkg = JSON.parse(readRepoFile('package.json')) as { version: string };
    const currentId = `v${pkg.version.replace(/\./g, '-')}`;
    expect(changelog).toContain(`<div class="release" id="${currentId}">`);
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
