# 2.0 walkthrough: mobile review, September 8, 2026

Scope: `https://ext.gosling-agency.ru/whats-new-2.html`, followed by the same
page served locally for the CSS corrections. The public HTML matched the
release source before editing. This review does not cover mobile installation
of the Firefox extension.

## Findings and corrections

1. **First screen and navigation — usable; spacing improved.** At 320px the
   overview's descriptions were squeezed beside the arrow, and “Оптимизации”
   extended past its 90px grid column. It left only 0.89px before the arrow.
   Descriptions now use the full card width at 13px. Narrow-screen padding and
   gaps give the longest heading a 98px column and 4.89px of visible clearance;
   emergency word wrapping handles larger fallback text.
2. **Voice example — working; tap targets enlarged.** All three steps select
   the corresponding panel. The example contains no playable audio. Mobile
   controls now have a minimum height of 44px instead of approximately 38px.
3. **Recap — working.** The comparison becomes two columns with a shared row
   heading on phones; all five comparison rows remain present. The full table
   fits its container at 320px without horizontal scrolling.
4. **Cabinet example — working; tap targets enlarged.** All seven tabs select
   their matching panel. The mobile tab list wraps; ArrowRight from the final
   tab returns focus and selection to the first. Its orientation switches at
   the existing 580px breakpoint. Mobile targets now have a minimum 44px height.
5. **Technical details — working.** All six native disclosures expand.
   Code and long parameter values stay within the page, including at 320px.
6. **End-of-page links — working; tap targets enlarged.** The guide,
   installation and archive links retain their destinations. Standalone
   navigation/footer links now have at least 44px of tap height below 850px.
   Inline links inside prose keep their normal text flow.

## Verification

- Browser viewport checks: 320, 360, 390, 430, 580, 581, 700, 701, 768, 850,
  851, 1024 and 1280 CSS pixels. No outer horizontal overflow, including with
  every technical disclosure open. Desktop layout above 850px is preserved.
- Saved screenshots were inspected, including before/after first screens,
  Voice steps and technical details, the full visible Recap table, and Cabinet.
- Independent GPT-6 Astra source review found no regression in the mobile
  cascade, links, ARIA relationships or example behavior. A final CSS check
  also preserved centered alignment for the more-specific secondary nav link.
- Preview console: no warnings or errors observed.
- `NODE_OPTIONS=--max-old-space-size=2048 CI=true pnpm check`: typecheck, lint,
  cutover gates, 111 test files / 2108 tests, and build.

Evidence folder:
`/Users/dmitriy/Documents/Codex/2026-09-08/chatgoose-2.0-mobile/`.
It contains the original and corrected screenshots, layout matrices, the check
log and the final publication receipt. The local audit report embeds the saved
screenshots in reading order.

Limits: this is responsive browser testing, not a run on physical iOS/Android
devices or a full Safari/VoiceOver/accessibility compliance assessment. Widths
alone do not emulate mobile browser chrome, platform fonts or touch hardware.
