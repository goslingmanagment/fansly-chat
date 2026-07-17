// The committed source of truth for changelog.html: every release card on the
// page, in page order (top = newest), and — for 1.7.0+ ONLY — its date.
// Dates are DD.MM.YYYY, transcribed ONCE from the real git tag dates:
//   git for-each-ref --sort=-creatordate \
//     --format='%(refname:short) %(creatordate:format:%d.%m.%Y)' 'refs/tags/v*'
// A bulk retro-tag on 2026-07-11 covers everything through 1.9.3, so many dates
// repeat — honest, not spread out. A release adds ONE entry at the top here AND
// ONE card to changelog.html in the same commit; release-pages.test.ts asserts
// the page's card sequence equals this array exactly and every date matches.
export interface ChangelogRelease {
  version: string;
  date?: string; // DD.MM.YYYY, present iff version >= 1.7.0
}

export const CHANGELOG_MANIFEST: readonly ChangelogRelease[] = [
  { version: '1.9.9', date: '15.07.2026' },
  { version: '1.9.8', date: '15.07.2026' },
  { version: '1.9.7', date: '14.07.2026' },
  { version: '1.9.6', date: '12.07.2026' },
  { version: '1.9.5', date: '12.07.2026' },
  { version: '1.9.4', date: '12.07.2026' },
  { version: '1.9.3', date: '11.07.2026' },
  { version: '1.9.2', date: '11.07.2026' },
  { version: '1.9.1', date: '11.07.2026' },
  { version: '1.9.0', date: '11.07.2026' },
  { version: '1.8.3', date: '11.07.2026' },
  { version: '1.8.2', date: '11.07.2026' },
  { version: '1.8.1', date: '11.07.2026' },
  { version: '1.8.0', date: '11.07.2026' },
  { version: '1.7.1', date: '11.07.2026' },
  { version: '1.7.0', date: '11.07.2026' },
  { version: '1.6.0' },
  { version: '1.5.6' },
  { version: '1.5.5' },
  { version: '1.5.4' },
  { version: '1.5.3' },
  { version: '1.5.2' },
  { version: '1.5.1' },
  { version: '1.5.0' },
  { version: '1.4.1' },
  { version: '1.4.0' },
  { version: '1.3.14' },
  { version: '1.3.13' },
  { version: '1.3.12' },
  { version: '1.3.11' },
  { version: '1.3.10' },
  { version: '1.3.9' },
  { version: '1.3.8' },
  { version: '1.3.7' },
  { version: '1.3.6' },
  { version: '1.3.5' },
  { version: '1.3.4' },
  { version: '1.3.3' },
  { version: '1.3.2' },
  { version: '1.3.1' },
  { version: '1.3.0' },
  { version: '1.2.17' },
  { version: '1.2.15' },
  { version: '1.2.2' },
  { version: '1.2.1' },
  { version: '1.2.0' },
  { version: '1.1.6' },
  { version: '1.1.5' },
  { version: '1.1.4' },
  { version: '1.1.3' },
  { version: '1.1.2' },
  { version: '1.1.1' },
  { version: '1.1.0' },
  { version: '1.0.0' },
];
