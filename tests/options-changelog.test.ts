// Rail footer on the live page: the «нов.» dot's decision and what a click does.
// The changelog itself is a web page — nothing about it ships in the XPI (E59),
// so everything under test here is the link and the seen-version bookkeeping.

import { afterEach, describe, expect, it } from 'vitest';
import { COPY } from '../src/options/copy.js';
import { CHANGELOG_URL } from '../src/shared/constants.js';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';
import type { MountedOptionsPage } from './helpers/options-page.js';
import type { OnboardingSnapshot } from '../src/shared/types.js';

/** The version `browser.runtime.getManifest()` reports under the harness. */
const MOUNTED_VERSION = '0.0.0-test';
const FRESH: OnboardingSnapshot = { version: 1, dismissedAt: null };

function dot(page: MountedOptionsPage): HTMLElement {
  const element = page.document.querySelector<HTMLElement>(
    '[data-role="rail-changelog-unseen"]',
  );
  if (!element) {
    throw new Error('Missing changelog dot');
  }
  return element;
}

function link(page: MountedOptionsPage): HTMLAnchorElement {
  const element = page.document.querySelector<HTMLAnchorElement>(
    '[data-role="rail-changelog"]',
  );
  if (!element) {
    throw new Error('Missing changelog link');
  }
  return element;
}

describe('options rail footer — changelog', () => {
  afterEach(async () => {
    await unmountOptionsPage();
  });

  it('marks an unseen version and clears it on click, opening the web page', async () => {
    const page = await mountOptionsPage({
      sessions: [],
      runtime: { lastSeenVersion: '1.9.10' },
    });

    expect(dot(page).hidden).toBe(false);
    expect(dot(page).textContent).toBe(COPY.rail.changelogUnseen);
    // Nothing is recorded just by looking at the page.
    expect(page.lastSeenWrites()).toEqual([]);

    link(page).click();
    await page.flushAsync();

    expect(page.lastSeenWrites()).toEqual([MOUNTED_VERSION]);
    expect(page.openedTabs()).toEqual([CHANGELOG_URL]);
    expect(dot(page).hidden).toBe(true);
  });

  it('stays quiet when this version has already been seen', async () => {
    const page = await mountOptionsPage({
      sessions: [],
      runtime: { lastSeenVersion: MOUNTED_VERSION },
    });

    expect(dot(page).hidden).toBe(true);
    // Already recorded — no redundant write.
    expect(page.lastSeenWrites()).toEqual([]);
  });

  it('records the version silently on a first run instead of showing a dot', async () => {
    // A fresh install has nothing to catch up on: the checklist is the message,
    // and «нов.» about the build you just installed is noise.
    const page = await mountOptionsPage({
      sessions: [],
      runtime: { onboarding: FRESH },
    });

    expect(page.document.querySelector<HTMLElement>('[data-onboarding="true"]')?.hidden)
      .toBe(false);
    expect(dot(page).hidden).toBe(true);
    expect(page.lastSeenWrites()).toEqual([MOUNTED_VERSION]);
  });

  it('keeps the dot when the seen-version write is rejected', async () => {
    const page = await mountOptionsPage({
      sessions: [],
      runtime: { lastSeenVersion: '1.9.10', setLastSeenVersionOk: false },
    });

    expect(dot(page).hidden).toBe(false);
    link(page).click();
    await page.flushAsync();

    // The tab still opens — a failed bookkeeping write must not break the link.
    expect(page.openedTabs()).toEqual([CHANGELOG_URL]);
    // …and the dot stays: an unread release note is the safe side.
    expect(dot(page).hidden).toBe(false);
  });
});
