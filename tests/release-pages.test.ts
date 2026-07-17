import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CHANGELOG_MANIFEST } from './fixtures/changelog-manifest.js';

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

describe('changelog web register', () => {
  const html = readRepoFile('changelog.html');

  // [{version, body}] in document order, split on the <!-- x.y.z --> markers.
  const cards = (() => {
    const parts = html.split(/\n\s*<!-- (\d+\.\d+\.\d+) -->\n/).slice(1);
    const out: { version: string; body: string }[] = [];
    for (let i = 0; i < parts.length; i += 2) out.push({ version: parts[i]!, body: parts[i + 1]! });
    return out;
  })();
  const cmp = (a: string, b: string): number => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
    return 0;
  };

  it('matches the committed manifest card sequence exactly (order + count)', () => {
    // The single durable pin: catches any dropped, inserted, or reordered card
    // forever — a release adds one card here AND one manifest line, together.
    expect(cards.map((c) => c.version)).toEqual(CHANGELOG_MANIFEST.map((e) => e.version));
  });

  it('does not backfill the eight absent 1.2.x releases (canon: page = what users saw)', () => {
    const versions = cards.map((c) => c.version);
    for (const absent of ['1.2.14', '1.2.13', '1.2.12', '1.2.11', '1.2.10', '1.2.9', '1.2.6', '1.2.5']) {
      expect(versions).not.toContain(absent);
    }
    // Explicit canon guard on top of the sequence pin: even if a future edit added
    // 1.2.x to BOTH the page and the manifest (so the sequence test still passed),
    // this negative loop would still fail — the divergence is deliberate, forever.
  });

  it('anchors every release uniquely and exposes the current (newest) version anchor', () => {
    const ids: string[] = [];
    for (const { version, body } of cards) {
      const slug = `v${version.replace(/\./g, '-')}`;
      expect(body, version).toContain(`id="${slug}"`);
      ids.push(slug);
    }
    expect(new Set(ids).size).toBe(ids.length);
    // newest card first → its anchor is the current-version target of the P2 button
    expect(cards[0]!.body).toContain(`id="v${cards[0]!.version.replace(/\./g, '-')}"`);
    // The CURRENT shipped version (package.json) must have a real anchor — the P2
    // Changelog button's `#v<major>-<minor>-<patch>` target. Merged from the PR #10
    // anchor test; robust to the milestone card's `class="release milestone"`.
    const pkg = JSON.parse(readRepoFile('package.json')) as { version: string };
    expect(ids).toContain(`v${pkg.version.replace(/\./g, '-')}`);
  });

  it('lists versions in strictly descending semver order', () => {
    for (let i = 1; i < cards.length; i += 1) {
      expect(cmp(cards[i - 1]!.version, cards[i]!.version), `${cards[i - 1]!.version} > ${cards[i]!.version}`).toBeGreaterThan(0);
    }
  });

  it('renders every manifest date on its card and dates every 1.7.0+ release (no fabricated dates)', () => {
    const bodyByVersion = new Map(cards.map((c) => [c.version, c.body]));
    for (const { version, date } of CHANGELOG_MANIFEST) {
      const body = bodyByVersion.get(version)!;
      const m = body.match(/<span class="release-date">([^<]+)<\/span>/);
      if (date) {
        expect(m, `${version} must render its manifest date ${date}`).not.toBeNull();
        expect(m![1]!, `${version} date must equal the manifest`).toBe(date);
      } else {
        expect(m, `${version} must be dateless`).toBeNull();
      }
      // The manifest itself must obey the policy: date present iff version >= 1.7.0.
      expect(Boolean(date), `${version} date presence must equal (version >= 1.7.0)`).toBe(cmp(version, '1.7.0') >= 0);
      if (date) expect(date, `${version} date format`).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    }
    // No git shelling, no fixed count: dates are the committed manifest, and the
    // sequence test above guarantees the page's cards are exactly these versions.
  });

  it('wraps every card in the uniform collapsed <details> — no baked open, no index logic', () => {
    for (const { version, body } of cards) {
      expect(body, `${version} details`).toContain('<details class="release-detail">');
      expect(body, `${version} toggle`).toContain('<summary class="release-detail-toggle">Подробнее</summary>');
      expect(body, `${version} must ship collapsed (open is applied at load by the page script, never baked)`)
        .not.toMatch(/<details class="release-detail" open/);
      // serif summary stays above the fold — outside the collapsed details
      if (body.includes('release-summary')) {
        expect(body.indexOf('release-summary'), `${version} summary above the fold`)
          .toBeLessThan(body.indexOf('release-detail'));
      }
    }
    // progressive enhancement: a tiny inline script opens the latest three at load
    expect(html).toMatch(/querySelectorAll\('\.release'\)/);
    expect(html).toMatch(/\.open\s*=\s*true/);
  });

  it('collapses «Технически» groups into <details> and keeps none as a div title', () => {
    expect(html).not.toMatch(/<div class="change-group-title[^"]*">[\s\S]*?Технически<\/div>/);
    const techDetails = (html.match(/<details class="change-group tech-group">/g) || []).length;
    const techSummaries = (html.match(/Технически<\/summary>/g) || []).length;
    expect(techDetails).toBe(techSummaries);
    expect(techDetails).toBeGreaterThan(20);
  });

  it('gives milestone releases a clay card class', () => {
    const milestone = cards.find((c) => c.version === '1.6.0')!;
    expect(milestone.body).toContain('class="release milestone"');
  });

  it('adopts the family palette + fonts, dark theme, serif summary — and drops the old blue/Inter', () => {
    for (const token of ['--paper', '--clay', 'Fraunces', 'Hanken Grotesk', '@media (prefers-color-scheme: dark)']) {
      expect(html, token).toContain(token);
    }
    expect(html).toMatch(/\.release-summary\s*\{[^}]*var\(--serif\)/);
    expect(html).toMatch(/\.release-version\s*\{[^}]*var\(--mono\)/);
    expect(html).not.toContain('--blue');
    expect(html).not.toMatch(/#4A7AE3/i);
    expect(html).not.toContain('family=Inter');
    expect(html).not.toContain("'Inter'");
  });

  it('keeps both deploy stamp slots present exactly once', () => {
    expect(html.match(/<span class="nav-version">v[^<]+<\/span>/g)).toHaveLength(1);
    expect(html.match(/<p>v[^<]+ &middot; Gosling Agency &middot; Kernel-served AI<\/p>/g)).toHaveLength(1);
  });
});
