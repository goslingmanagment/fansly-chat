# Options Redesign P1 — Shell & Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Rev 3** — after a codex ultra cross-review (2026-07-16). Key deltas from rev 1: the shared test helper is NEW-tests-only (existing suites keep their local harnesses); the Аккаунты merge preserves the `mapping-info` persona-availability node and newest-snapshot-wins; the Hub re-wrap keeps `agencyHubPermissionStatus` in the DOM; a full Russian copy sweep task replaces the strings-only pass; the fonts task covers debug-prompt, mono 600, provenance, and shim-safe tests.

**Goal:** Rebuild the options page shell to desktop parity (sticky nav + scrollspy + section cards + family primitives + Russian copy + local fonts) with zero behavior change to settings/save/hub logic.

**Architecture:** Keep `src/options/index.ts` as the single orchestrator and the ONE central write controller; extract only presentation: new DOM primitives in `dom.ts`, a page shell in `shell.ts`, component CSS in `styles.css`. Sections are re-wrapped visually in place — their handlers, save chains, and race guards move verbatim, never rewritten. Per-section module extraction is deliberately deferred to P2/P3 (the spec's §10 split lands incrementally as those phases rebuild each section).

**Tech Stack:** Plain TS + DOM (no framework), esbuild (CSS as text, injected `<style>`), vitest + JSDOM (dynamic `await import('../src/options/index.js')` after globals are staged, as in existing options tests).

**Spec:** `docs/superpowers/specs/2026-07-16-options-redesign-design.md` (§3, §6 presentation-only parts, §9, §10; P1 scope from §13.1).

## Global Constraints

- Execution happens in a fresh toolkit worktree: `~/code/agentic-control-plane/bin/agent task chatgoose options-redesign-p1` before the first edit (repo is in repos.yaml; canonical checkout is owner-only).
- `pnpm check` (typecheck + lint + gates + tests + build) green before EVERY commit. Note: `pnpm typecheck` covers tests too, and the repo uses hand-rolled Node type shims (`tests/node-shims.d.ts`), NOT `@types/node` — test code may only use APIs those shims declare (extend the shims explicitly if a new API is needed).
- Lint forbids `any` (`no-explicit-any`) — no `as any` anywhere, including tests.
- Storage schema stays at `STORAGE_SCHEMA_VERSION = 14` — no migration, no new persisted keys.
- The E37 future-schema barrier, the E36 persona preservation/recovery/export machinery, and the E19 custody discipline (dedicated credential keys, dirty-tracking, serialized saves, pagehide path) move UNCHANGED. Tests pinning them must stay green unweakened.
- One central write controller: no new module reads or writes `browser.storage` — only `index.ts` does, exactly as today.
- No new network calls of any kind in P1.
- UI copy: Russian with English terms per the glossary in Task 9. Exact strings are given per task; do not improvise.
- Family tokens in `src/options/styles.css` `:root` / `.chatgoose-theme-dark` are frozen — extend with component classes only, never edit token values. Dark theme stays a pure variable swap (no per-component dark rules).
- Do not touch `package.json`/`manifest.json` versions (release bumps are a separate release step).

## File Structure

```
src/options/
  index.html      (modify: lang="ru", Russian <title>, drop Google Fonts links)
  styles.css      (extend: @font-face + component classes + desktop card metrics)
  dom.ts          (extend: badge/toggle/chips/cap/label-row/saved-flash builders)
  shell.ts        (create: page layout, nav, scrollspy)
  copy.ts         (create: all P1 Russian strings, one exported const)
  sessions.ts     (modify: newest-wins lookup, relative-minutes helper, RU strings)
  index.ts        (modify: mount shell, re-wrap sections, merge accounts, wire flash, RU strings)
src/popup/index.html        (modify: drop Google Fonts links)
src/popup/styles.css        (modify: @font-face block)
src/debug-prompt/index.html (modify only if it links Google Fonts — check first)
src/debug-prompt/styles.css (modify only if it references the family font names — check first)
assets/fonts/*.woff2        (create: committed font binaries + README.md provenance)
esbuild.config.mjs          (modify: copy assets/fonts → dist/fonts)
tests/helpers/options-page.ts (create: slim mount helper for NEW tests only)
tests/options-dom.test.ts     (create)
tests/options-shell.test.ts   (create)
tests/options-shell-mount.test.ts (create)
tests/local-fonts.test.ts     (create)
tests/options-accounts.test.ts / options-agency-hub.test.ts / options-persona-recovery.test.ts
                              (modify: new assertions via THEIR OWN local harnesses; RU string updates)
docs/decisions.md             (append the P1 entry in the same PR)
docs/superpowers/specs/2026-07-16-options-redesign-design.md
                              (modify §10: per-section split is incremental — P2/P3)
```

---

### Task 1: Slim mount helper for NEW tests (existing suites keep their harnesses)

Existing suites (`options-accounts`, `options-agency-hub`, `options-persona-recovery`) each own a rich local harness whose control hooks (`stallNextStorageSet`, `releaseFirstStorageSet`, reassignable `currentState`, snapshot-promise control, `loadOptionsPage(options)`, `getSectionByTitle`) are called dozens of times inside test bodies. Extracting that harness cannot be byte-identical (ESM imports are not reassignable). Therefore: DO NOT move it. New P1 tests get a small independent helper; new assertions that belong to existing behavioral areas are written INSIDE the existing files using their local harnesses.

**Files:**
- Create: `tests/helpers/options-page.ts`
- Test: `tests/options-shell-mount.test.ts` gets a smoke test in Task 4 proving the helper mounts the real page.

**Interfaces:**
- Produces (named exports of `tests/helpers/options-page.ts`):

```ts
import type { PersistedState, SessionSnapshotEntry, Settings } from '../../src/shared/types.js';

export interface MountOverrides {
  settings?: Partial<Settings>;                                    // deep-merged over defaults
  state?: Partial<Omit<PersistedState, 'settings' | 'schemaVersion'>>;
  sessions?: SessionSnapshotEntry[];                               // getSessionsSnapshot reply
}
export interface MountedOptionsPage {
  document: Document;
  window: Window & typeof globalThis;
  flushAsync: () => Promise<void>;
  getState: () => PersistedState;    // reads the in-memory storage record
}
export function mountOptionsPage(overrides?: MountOverrides): Promise<MountedOptionsPage>;
export function unmountOptionsPage(): Promise<void>;
```

- [ ] **Step 1: Implement the helper.** Model every fake on the reference harness in `tests/options-accounts.test.ts` — the JSDOM construction and global stubbing block (starting near line 87: `dom = new JSDOM(`), the `browser` global (storage.local get/set over an in-memory record, `runtime.sendMessage` answering `getSessionsSnapshot`, `runtime.getManifest`, permissions stubs), and the mount call `await vi.resetModules(); await import('../src/options/index.js')` (near line 206). Copy those fake BODIES into the helper (adjusting the import path to `../../src/options/index.js` — the helper sits one directory deeper), parameterized like this:

```ts
import { vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { STORAGE_SCHEMA_VERSION } from '../../src/shared/constants.js';
import { createDefaultSettings } from '../../src/shared/storage.js'; // if not exported, inline the default Settings object from src/shared/constants.ts defaults instead

let dom: InstanceType<typeof JSDOM> | null = null;

export async function mountOptionsPage(overrides: MountOverrides = {}): Promise<MountedOptionsPage> {
  const settings: Settings = { ...createDefaultSettings(), ...overrides.settings };
  const state: PersistedState = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings,
    personalities: [],
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
    ...overrides.state,
  } as PersistedState;   // if PersistedState has more required keys on main (personaCatalog etc.), list them here explicitly with their defaults — copy the exact default record the reference harness builds
  const sessions = overrides.sessions ?? [];

  dom = new JSDOM('<!doctype html><html><body><div id="chatgoose-options-root"></div></body></html>', { url: 'https://localhost/options.html' });
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('navigator', window.navigator);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', window.HTMLInputElement);
  vi.stubGlobal('HTMLSelectElement', window.HTMLSelectElement);
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('CustomEvent', window.CustomEvent);
  // matchMedia + browser global: copy the fake bodies from the reference
  // harness verbatim here (storage over `stored`, sendMessage answering
  // getSessionsSnapshot with `sessions`, getManifest {version:'0.0.0-test'},
  // permissions.contains -> false, storage.onChanged listener registry).
  const stored: Record<string, unknown> = buildStoredRecordFromState(state); // same key layout the reference harness uses (settings blob + custody keys + schemaVersion + persona keys)
  /* …stubGlobal('browser', …) exactly as the reference harness… */

  vi.resetModules();
  await import('../../src/options/index.js');
  const flushAsync = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) { await Promise.resolve(); }
    await vi.runOnlyPendingTimersAsync().catch(() => undefined);
    for (let i = 0; i < 20; i += 1) { await Promise.resolve(); }
  };
  await flushAsync();
  return { document: window.document, window: window as Window & typeof globalThis, flushAsync, getState: () => readStateBackFromStored(stored) };
}

export async function unmountOptionsPage(): Promise<void> {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  dom?.window.close();
  dom = null;
}
```

  The two `buildStoredRecordFromState`/`readStateBackFromStored` functions must mirror the exact storage-key layout the app reads (`serializePersistedState` in `src/shared/storage.ts` is the authority — use it directly if exported; otherwise copy the reference harness's record builder). Do not invent key names: run the Task 4 smoke test to prove the mount renders.

- [ ] **Step 2: Typecheck the helper**

Run: `pnpm typecheck`
Expected: PASS (no `any`, shim-safe imports only).

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/options-page.ts
git commit -m "test(options): slim mount helper for new shell tests"
```

---

### Task 2: DOM primitives — badge, cap, toggle, chip group, label row, saved flash

**Files:**
- Modify: `src/options/dom.ts`
- Modify: `src/options/styles.css`
- Test: `tests/options-dom.test.ts` (create)

**Interfaces:**
- Produces (all exported from `src/options/dom.ts`):

```ts
export type BadgeTone = 'neutral' | 'green' | 'amber' | 'bad' | 'clay';
export function createBadge(label: string, tone?: BadgeTone, mono?: boolean): HTMLSpanElement;
export function createCap(text: string): HTMLSpanElement;
export function createToggle(label: string, hint?: string): { root: HTMLLabelElement; input: HTMLInputElement };
export function createChipGroup(
  choices: Array<{ value: string; label: string }>,
  initialValue: string,
): { root: HTMLDivElement; input: HTMLSelectElement };
export function createLabelRow(label: string, control: HTMLElement): HTMLElement;
  // returns <label class="chatgoose-lrow"> when control IS an input/select/textarea
  // (click-to-focus + accessible name preserved), otherwise <div class="chatgoose-lrow">
export function createSavedFlash(): {
  root: HTMLDivElement;
  showSaved: () => void;
  showError: (message: string) => void;
};
```

- [ ] **Step 1: Write failing tests** in `tests/options-dom.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

let dom: InstanceType<typeof JSDOM>;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
  vi.stubGlobal('HTMLSelectElement', dom.window.HTMLSelectElement);
  vi.stubGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement);
  vi.stubGlobal('Event', dom.window.Event);       // realm-correct events for dispatch
  vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  dom.window.close();
});

describe('options dom primitives', () => {
  it('createBadge renders tone and mono classes', async () => {
    const { createBadge } = await import('../src/options/dom.js');
    const badge = createBadge('активен', 'green');
    expect(badge.className).toContain('chatgoose-badge');
    expect(badge.className).toContain('chatgoose-badge-green');
    expect(badge.textContent).toBe('активен');
    expect(createBadge('LIVE', 'green', true).className).toContain('chatgoose-badge-mono');
  });

  it('createToggle drives a real checkbox', async () => {
    const { createToggle } = await import('../src/options/dom.js');
    const { root, input } = createToggle('Debug mode', 'окно отладки промпта');
    expect(root.tagName).toBe('LABEL');
    expect(input.type).toBe('checkbox');
    expect(root.textContent).toContain('Debug mode');
    expect(root.textContent).toContain('окно отладки промпта');
  });

  it('createChipGroup mirrors selection into a hidden select and fires change', async () => {
    const { createChipGroup } = await import('../src/options/dom.js');
    const { root, input } = createChipGroup(
      [
        { value: 'system', label: 'Системная' },
        { value: 'light', label: 'Светлая' },
        { value: 'dark', label: 'Тёмная' },
      ],
      'light',
    );
    const chips = root.querySelectorAll('button.chatgoose-chip');
    expect(chips).toHaveLength(3);
    expect(input.value).toBe('light');
    expect(chips[1]!.className).toContain('chatgoose-chip-selected');
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    (chips[2] as HTMLButtonElement).click();
    expect(input.value).toBe('dark');
    expect(events).toEqual(['input', 'change']);
    expect(chips[2]!.className).toContain('chatgoose-chip-selected');
    expect(chips[1]!.className).not.toContain('chatgoose-chip-selected');
  });

  it('createSavedFlash toggles saved and error states', async () => {
    vi.useFakeTimers();
    const { createSavedFlash } = await import('../src/options/dom.js');
    const flash = createSavedFlash();
    expect(flash.root.hidden).toBe(true);
    flash.showSaved();
    expect(flash.root.hidden).toBe(false);
    expect(flash.root.className).toContain('chatgoose-saved-flash-ok');
    expect(flash.root.textContent).toBe('Сохранено ✓');
    vi.advanceTimersByTime(2200);
    expect(flash.root.hidden).toBe(true);
    flash.showError('Не удалось сохранить');
    expect(flash.root.className).toContain('chatgoose-saved-flash-bad');
    expect(flash.root.textContent).toContain('Не удалось сохранить');
  });

  it('createLabelRow wraps a form control in a real label, other content in a div', async () => {
    const { createLabelRow } = await import('../src/options/dom.js');
    const input = document.createElement('input');
    const labeled = createLabelRow('Адрес хаба', input);
    expect(labeled.tagName).toBe('LABEL');
    expect(labeled.querySelector('.chatgoose-lrow-label')?.textContent).toBe('Адрес хаба');
    const block = document.createElement('div');
    const wrapped = createLabelRow('Вход устройства', block);
    expect(wrapped.tagName).toBe('DIV');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/options-dom.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement in `src/options/dom.ts`** (same code as below, complete):

```ts
export type BadgeTone = 'neutral' | 'green' | 'amber' | 'bad' | 'clay';

export function createBadge(label: string, tone: BadgeTone = 'neutral', mono = false): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = `chatgoose-badge chatgoose-badge-${tone}${mono ? ' chatgoose-badge-mono' : ''}`;
  badge.textContent = label;
  return badge;
}

export function createCap(text: string): HTMLSpanElement {
  const cap = document.createElement('span');
  cap.className = 'chatgoose-cap';
  cap.textContent = text;
  return cap;
}

export function createToggle(
  label: string,
  hint?: string,
): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = document.createElement('label');
  root.className = 'chatgoose-toggle-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'chatgoose-toggle-input';
  const track = document.createElement('span');
  track.className = 'chatgoose-toggle';
  const text = document.createElement('span');
  text.className = 'chatgoose-toggle-label';
  text.textContent = label;
  root.append(input, track, text);
  if (hint) {
    const hintNode = document.createElement('span');
    hintNode.className = 'chatgoose-toggle-hint';
    hintNode.textContent = hint;
    root.append(hintNode);
  }
  return { root, input };
}

export function createChipGroup(
  choices: Array<{ value: string; label: string }>,
  initialValue: string,
): { root: HTMLDivElement; input: HTMLSelectElement } {
  const root = document.createElement('div');
  root.className = 'chatgoose-chip-group';
  const input = document.createElement('select');
  input.className = 'chatgoose-chip-value';
  input.hidden = true;
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    input.append(option);
  }
  input.value = initialValue;
  const buttons: HTMLButtonElement[] = [];
  const renderSelection = (): void => {
    for (const button of buttons) {
      button.classList.toggle('chatgoose-chip-selected', button.dataset.value === input.value);
    }
  };
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chatgoose-chip';
    button.dataset.value = choice.value;
    button.textContent = choice.label;
    button.addEventListener('click', () => {
      if (input.value === choice.value) return;
      input.value = choice.value;
      renderSelection();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    buttons.push(button);
    root.append(button);
  }
  root.append(input);
  renderSelection();
  return { root, input };
}

function isFormControl(node: HTMLElement): boolean {
  return node instanceof HTMLInputElement
    || node instanceof HTMLSelectElement
    || node instanceof HTMLTextAreaElement;
}

export function createLabelRow(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement(isFormControl(control) ? 'label' : 'div');
  row.className = 'chatgoose-lrow';
  const labelNode = document.createElement('span');
  labelNode.className = 'chatgoose-lrow-label';
  labelNode.textContent = label;
  const controlWrap = document.createElement('span');
  controlWrap.className = 'chatgoose-lrow-control';
  controlWrap.append(control);
  row.append(labelNode, controlWrap);
  return row;
}

const SAVED_FLASH_VISIBLE_MS = 2000;

export function createSavedFlash(): {
  root: HTMLDivElement;
  showSaved: () => void;
  showError: (message: string) => void;
} {
  const root = document.createElement('div');
  root.className = 'chatgoose-saved-flash';
  root.hidden = true;
  let hideTimer: number | null = null;
  const show = (className: string, text: string, autoHide: boolean): void => {
    root.className = `chatgoose-saved-flash ${className}`;
    root.textContent = text;
    root.hidden = false;
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = autoHide
      ? window.setTimeout(() => { root.hidden = true; hideTimer = null; }, SAVED_FLASH_VISIBLE_MS)
      : null;
  };
  return {
    root,
    showSaved: () => show('chatgoose-saved-flash-ok', 'Сохранено ✓', true),
    showError: (message: string) => show('chatgoose-saved-flash-bad', `Ошибка: ${message}`, false),
  };
}
```

- [ ] **Step 4: Add the component CSS** to `src/options/styles.css` (append after the existing rules; tokens via `var()` only):

```css
/* ── P1 components: desktop vocabulary ── */
.chatgoose-badge {
  display: inline-flex; align-items: center; gap: 5px;
  border-radius: 999px; border: 1px solid var(--chatgoose-line);
  padding: 1.5px 9px; font-size: 11px; font-weight: 600;
  background: var(--chatgoose-bg2); color: var(--chatgoose-ink-mid);
  white-space: nowrap;
}
.chatgoose-badge-green { background: var(--chatgoose-green-bg); border-color: var(--chatgoose-green-line); color: var(--chatgoose-green); }
.chatgoose-badge-amber { background: var(--chatgoose-amber-bg); border-color: var(--chatgoose-amber-line); color: var(--chatgoose-amber); }
.chatgoose-badge-bad { background: transparent; border-color: color-mix(in srgb, var(--chatgoose-bad) 45%, transparent); color: var(--chatgoose-bad); }
.chatgoose-badge-clay { background: var(--chatgoose-clay-bg); border-color: var(--chatgoose-clay-line); color: var(--chatgoose-clay-ink); }
.chatgoose-badge-mono { font-family: var(--chatgoose-font-mono); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10.5px; }

.chatgoose-cap { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; color: var(--chatgoose-ink-low); }
.chatgoose-num { font-family: var(--chatgoose-font-mono); font-variant-numeric: tabular-nums; }

.chatgoose-toggle-row { display: flex; gap: 9px; align-items: center; cursor: pointer; }
.chatgoose-toggle-input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.chatgoose-toggle {
  width: 32px; height: 18px; border-radius: 999px; flex: none; position: relative;
  border: 1px solid var(--chatgoose-line-strong); background: var(--chatgoose-bg3);
  transition: background 150ms ease, border-color 150ms ease;
}
.chatgoose-toggle::after {
  content: ''; position: absolute; top: 2px; left: 0; width: 12px; height: 12px;
  border-radius: 50%; background: #fff; transform: translateX(3px);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18); transition: transform 150ms ease;
}
.chatgoose-toggle-input:checked + .chatgoose-toggle { background: var(--chatgoose-clay); border-color: var(--chatgoose-clay); }
.chatgoose-toggle-input:checked + .chatgoose-toggle::after { transform: translateX(16px); background: var(--chatgoose-bg1); }
.chatgoose-toggle-input:focus-visible + .chatgoose-toggle { outline: 2px solid var(--chatgoose-clay); outline-offset: 2px; }
.chatgoose-toggle-label { font-weight: 600; font-size: 12.5px; }
.chatgoose-toggle-hint { font-size: 11.5px; color: var(--chatgoose-ink-low); }

.chatgoose-chip-group { display: flex; gap: 4px; flex-wrap: wrap; }
.chatgoose-chip {
  border: 0; background: transparent; border-radius: 999px; padding: 3.5px 12px;
  font: 500 12px/1.5 var(--chatgoose-font); color: var(--chatgoose-ink-mid); cursor: pointer;
}
.chatgoose-chip:hover { background: var(--chatgoose-bg2); }
.chatgoose-chip:focus-visible { outline: 2px solid var(--chatgoose-clay); outline-offset: 2px; }
.chatgoose-chip-selected { background: var(--chatgoose-ink); color: var(--chatgoose-bg1); font-weight: 600; }
.chatgoose-chip-selected:hover { background: var(--chatgoose-ink); }

.chatgoose-lrow { display: flex; gap: 14px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid var(--chatgoose-line); }
.chatgoose-lrow:last-of-type { border-bottom: 0; }
.chatgoose-lrow-label { width: 150px; flex: none; font-weight: 600; font-size: 12.5px; padding-top: 6px; }
.chatgoose-lrow-control { flex: 1; min-width: 0; display: grid; gap: 7px; }

.chatgoose-saved-flash {
  position: fixed; right: 18px; bottom: 16px; z-index: 20;
  border-radius: 999px; padding: 5px 14px; font: 600 11.5px/1.5 var(--chatgoose-font);
  box-shadow: var(--chatgoose-shadow);
}
.chatgoose-saved-flash-ok { background: var(--chatgoose-green-bg); border: 1px solid var(--chatgoose-green-line); color: var(--chatgoose-green); }
.chatgoose-saved-flash-bad { background: var(--chatgoose-clay-bg); border: 1px solid color-mix(in srgb, var(--chatgoose-bad) 45%, transparent); color: var(--chatgoose-bad); }
@media (prefers-reduced-motion: reduce) {
  .chatgoose-toggle, .chatgoose-toggle::after, .chatgoose-button { transition: none; }
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/options-dom.test.ts`
Expected: PASS (all 5).

- [ ] **Step 6: Commit**

```bash
git add src/options/dom.ts src/options/styles.css tests/options-dom.test.ts
git commit -m "feat(options): family primitives — badge, toggle, chips, label row, saved flash"
```

---

### Task 3: Page shell — layout, sticky nav, scrollspy, desktop card metrics

**Files:**
- Create: `src/options/shell.ts`
- Modify: `src/options/styles.css` (layout/nav classes + card metric retune)
- Test: `tests/options-shell.test.ts` (create)

**Interfaces:**
- Produces (exported from `src/options/shell.ts`):

```ts
export interface ShellSection { id: string; title: string; }
export interface OptionsShell {
  layout: HTMLDivElement;
  main: HTMLDivElement;
  addSection: (id: string, card: HTMLElement) => void;
  setActiveNav: (id: string) => void;
  dispose: () => void;
}
export function buildShell(sections: ShellSection[], scrollRoot?: HTMLElement): OptionsShell;
```

- [ ] **Step 1: Write failing tests** in `tests/options-shell.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

let dom: InstanceType<typeof JSDOM>;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
});
afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

describe('options shell', () => {
  const SECTIONS = [
    { id: 'hub', title: 'Agency Hub' },
    { id: 'accounts', title: 'Аккаунты' },
  ];

  it('renders one nav item per section and anchors cards', async () => {
    const { buildShell } = await import('../src/options/shell.js');
    const shell = buildShell(SECTIONS);
    const items = shell.layout.querySelectorAll('.chatgoose-nav-item');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toBe('Agency Hub');
    const card = document.createElement('section');
    shell.addSection('hub', card);
    expect(card.dataset.shellSection).toBe('hub');
    expect(shell.main.contains(card)).toBe(true);
  });

  it('nav click scrolls to the section card', async () => {
    const { buildShell } = await import('../src/options/shell.js');
    const shell = buildShell(SECTIONS);
    const card = document.createElement('section');
    card.scrollIntoView = vi.fn();
    shell.addSection('hub', card);
    (shell.layout.querySelector('.chatgoose-nav-item[data-nav-id="hub"]') as HTMLButtonElement).click();
    expect(card.scrollIntoView).toHaveBeenCalled();
  });

  it('setActiveNav moves the active class', async () => {
    const { buildShell } = await import('../src/options/shell.js');
    const shell = buildShell(SECTIONS);
    shell.setActiveNav('accounts');
    const active = shell.layout.querySelectorAll('.chatgoose-nav-item-active');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.navId).toBe('accounts');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/options-shell.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/options/shell.ts`:**

```ts
export interface ShellSection { id: string; title: string; }
export interface OptionsShell {
  layout: HTMLDivElement;
  main: HTMLDivElement;
  addSection: (id: string, card: HTMLElement) => void;
  setActiveNav: (id: string) => void;
  dispose: () => void;
}

export function buildShell(sections: ShellSection[], scrollRoot?: HTMLElement): OptionsShell {
  const layout = document.createElement('div');
  layout.className = 'chatgoose-layout';
  const nav = document.createElement('nav');
  nav.className = 'chatgoose-nav';
  const main = document.createElement('div');
  main.className = 'chatgoose-main';
  layout.append(nav, main);

  const itemsById = new Map<string, HTMLButtonElement>();
  const cardsById = new Map<string, HTMLElement>();

  const setActiveNav = (id: string): void => {
    for (const [itemId, item] of itemsById) {
      item.classList.toggle('chatgoose-nav-item-active', itemId === id);
    }
  };

  for (const section of sections) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chatgoose-nav-item';
    item.dataset.navId = section.id;
    item.textContent = section.title;
    item.addEventListener('click', () => {
      cardsById.get(section.id)?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
      setActiveNav(section.id);
    });
    itemsById.set(section.id, item);
    nav.append(item);
  }

  let observer: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0]?.target as HTMLElement | undefined;
        if (first?.dataset.shellSection) setActiveNav(first.dataset.shellSection);
      },
      { root: scrollRoot ?? null, rootMargin: '-20% 0px -70% 0px' },
    );
  }

  const addSection = (id: string, card: HTMLElement): void => {
    card.dataset.shellSection = id;
    cardsById.set(id, card);
    main.append(card);
    observer?.observe(card);
  };

  return { layout, main, addSection, setActiveNav, dispose: () => observer?.disconnect() };
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
```

- [ ] **Step 4: Add layout CSS + desktop card metrics** to `src/options/styles.css`:

```css
.chatgoose-layout { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 22px; align-items: start; padding: 0 20px; }
.chatgoose-nav { display: grid; gap: 2px; position: sticky; top: 16px; }
.chatgoose-nav-item {
  border: 0; background: transparent; text-align: left; cursor: pointer;
  padding: 5.5px 10px; border-left: 2px solid transparent; border-radius: 0 7px 7px 0;
  font: 500 12.5px/1.5 var(--chatgoose-font); color: var(--chatgoose-ink-mid);
}
.chatgoose-nav-item:hover { background: var(--chatgoose-bg2); }
.chatgoose-nav-item:focus-visible { outline: 2px solid var(--chatgoose-clay); outline-offset: 2px; }
.chatgoose-nav-item-active { background: var(--chatgoose-bg2); color: var(--chatgoose-ink); font-weight: 650; border-left-color: var(--chatgoose-clay); }
.chatgoose-main { display: grid; gap: 18px; min-width: 0; }

/* Desktop card metrics inside the shell (spec §10: radius 9, title 15, hint 12).
   Scoped to .chatgoose-main so the recovery page keeps rendering unchanged. */
.chatgoose-main .chatgoose-section { margin: 0; padding: 16px; border-radius: var(--chatgoose-radius-card); }
.chatgoose-main .chatgoose-section h2 { font-size: 15px; }
.chatgoose-main .chatgoose-section .chatgoose-section-desc { font-size: 12px; color: var(--chatgoose-ink-low); }

@media (max-width: 680px) {
  .chatgoose-layout { grid-template-columns: 1fr; }
  .chatgoose-nav { position: static; grid-auto-flow: column; overflow-x: auto; }
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/options-shell.test.ts`
Expected: PASS (3).

- [ ] **Step 6: Commit**

```bash
git add src/options/shell.ts src/options/styles.css tests/options-shell.test.ts
git commit -m "feat(options): page shell with sticky nav, scrollspy, desktop card metrics"
```

---

### Task 4: Copy module + mount the shell in index.ts (ordered registration)

**Files:**
- Create: `src/options/copy.ts`
- Modify: `src/options/index.ts`, `src/options/index.html`
- Test: `tests/options-shell-mount.test.ts` (create; uses the Task 1 helper)

**Interfaces:**
- Produces: `import { COPY } from './copy.js'`:

```ts
export const COPY = Object.freeze({
  pageTitle: 'Настройки',
  pageSubtitle: 'Генерация, Agency Hub, персоны и аккаунты Fansly — всё в одном месте.',
  nav: Object.freeze({
    hub: 'Agency Hub',
    personas: 'Персоны',
    accounts: 'Аккаунты',
    generation: 'Генерация',
    appearance: 'Вид',
    version: 'Версия',
  }),
  sections: Object.freeze({
    hubTitle: 'Agency Hub',
    hubHint: 'Кернел агентства: генерация, персоны, spenders. Вход — по device token.',
    personasTitle: 'Персоны',
    personasHint: 'Голоса управляются на сервере агентства; здесь — только каталог.',
    accountsTitle: 'Аккаунты',
    accountsHint: 'Fansly-аккаунты, которые видит расширение, и их персоны.',
    generationTitle: 'Генерация',
    generationHint: 'Сколько сообщений диалога уходит в контекст каждой фичи.',
    appearanceTitle: 'Вид',
    appearanceHint: 'Один семейный стиль, светлый и тёмный.',
    versionTitle: 'Версия',
    versionHint: 'Firefox обновляет расширение сам; форсировать — about:addons.',
  }),
});
```

- [ ] **Step 1: Write the failing mount test** in `tests/options-shell-mount.test.ts` (also the Task 1 smoke test):

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';

afterEach(async () => { await unmountOptionsPage(); });

describe('options shell mount', () => {
  it('renders the Russian hero and one nav item per section', async () => {
    const { document } = await mountOptionsPage();
    expect(document.querySelector('h1')?.textContent).toBe('Настройки');
    const navLabels = Array.from(
      document.querySelectorAll('.chatgoose-nav-item'),
      (item) => item.textContent,
    );
    expect(navLabels).toEqual(['Agency Hub', 'Персоны', 'Аккаунты', 'Генерация', 'Вид', 'Версия']);
  });

  it('registers section cards in nav order', async () => {
    const { document } = await mountOptionsPage();
    const ids = Array.from(
      document.querySelectorAll('[data-shell-section]'),
      (card) => (card as HTMLElement).dataset.shellSection,
    );
    expect(ids).toEqual(['hub', 'personas', 'accounts', 'generation', 'appearance', 'version']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/options-shell-mount.test.ts`
Expected: FAIL (old h1, no nav). If the FIRST test fails on mounting rather than assertions, fix the Task 1 helper until the page renders — that is the smoke gate.

- [ ] **Step 3: Modify `index.ts` and `index.html`:**
  1. `index.html`: `<html lang="ru">`, `<title>Настройки ChatGoose</title>`.
  2. Imports: `import { buildShell } from './shell.js'; import { COPY } from './copy.js';` (create `copy.ts` per the interface block).
  3. Hero texts from `COPY.pageTitle`/`COPY.pageSubtitle`.
  4. Build the shell after the hero (`root.append(shell.layout)`, `cleanupTasks.push(() => shell.dispose())`).
  5. **Ordered registration:** do NOT register sections where they are built. Keep all existing section-construction code in place, and at the END of `render()` (after the last section variable exists, right before the trailing awaits) register everything in ONE block — this is the only way the DOM order matches the nav order, because construction order in the file is Appearance → Generation → Hub → …:

```ts
shell.addSection('hub', agencyHubSection);
shell.addSection('personas', personalitiesSection);
shell.addSection('accounts', mappingsSection);
shell.addSection('generation', apiSection);
shell.addSection('appearance', appearanceSection);
shell.addSection('version', versionSection);
```

  Remove every old `root.append(<section>)` call for these sections. (`connectionsSection` still exists in this task — append it after the block with `shell.main.append(connectionsSection)`; it dies in Task 5.)
  6. The new Version card (before the registration block):

```ts
const versionSection = createSection(COPY.sections.versionTitle, COPY.sections.versionHint);
const versionLine = document.createElement('div');
versionLine.className = 'chatgoose-num';
versionLine.style.fontSize = '12px';
versionLine.style.color = 'var(--chatgoose-ink-mid)';
versionLine.textContent = `v ${extensionVersion} · канал: self-hosted feed`;
versionSection.append(versionLine);
```

  (No Changelog button — that is P2, after the anchored page deploys.)

- [ ] **Step 4: Run new + existing suites; update ONLY hero-text assertions if any pin the old English strings**

Run: `pnpm vitest run tests/options-shell-mount.test.ts tests/options-accounts.test.ts tests/options-agency-hub.test.ts tests/options-persona-recovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options/copy.ts src/options/index.ts src/options/index.html tests/options-shell-mount.test.ts
git commit -m "feat(options): mount desktop-parity shell with ordered sections and Russian hero"
```

---

### Task 5: Merge «Connection Status» into «Аккаунты» (preserving mapping-info and newest-wins)

**Files:**
- Modify: `src/options/index.ts`, `src/options/sessions.ts`, `src/options/styles.css`
- Test: extend `tests/options-accounts.test.ts` (using ITS OWN local harness: `loadOptionsPage`, `getSectionByTitle`, and the file's session fixtures)

**Interfaces:**
- Consumes: `createBadge` (Task 2).
- Produces: modified `buildSessionLookup` (newest-wins) + new `formatCaptureStatus`:

```ts
// sessions.ts — replace body: on key collision keep the session with the
// greater lastSeenAt (same rule buildConnectionRows uses today).
export function buildSessionLookup(sessions: SessionSnapshotEntry[]): Map<string, SessionSnapshotEntry>;
export function formatCaptureStatus(session: SessionSnapshotEntry | undefined): string;
// → 'захвачена N мин назад' | 'захвачена N ч назад' | 'захвачена только что' | 'нет сессии'
```

Hard requirements carried from today's page:
- The `[data-role="mapping-info"]` node SURVIVES with its exact semantics (persona availability: label/usable/archived, refreshed by `refreshAccountMappingPersonalityOptions` during catalog refresh). The capture status is an ADDITIONAL line in the identity block — nothing about persona availability moves or rewords beyond the Task 9 translation table.
- `mappingsSection.dataset.sessionHydration` keeps its `loading → ready|failed` transitions; the failure state keeps a visible message (Russian per Task 9: «Не удалось обновить живой статус аккаунтов — показаны маппинги из локального хранилища»).
- The row grid grows to four columns: `auto minmax(0,1fr) minmax(220px,320px) auto` (avatar, identity block, select, info) — the amber badge lives INSIDE the identity block, never as a fifth grid child.

- [ ] **Step 1: Write failing tests** (inside `tests/options-accounts.test.ts`, using the file's own `loadOptionsPage(...)` invocation exactly as its neighboring tests do — copy the nearest test's load call including its state/session fixture shapes):

```ts
it('renders one merged Аккаунты section with capture status and no Connection Status', async () => {
  // fixture: one known account with a connected session — reuse the exact
  // state+sessions shape of the nearest existing "connected" test above.
  await loadOptionsPage(/* same args as that test */);
  const section = getSectionByTitle('Аккаунты');
  expect(section.dataset.sessionHydration).toBe('ready');
  expect(section.textContent).toContain('захвачена');
  expect(section.querySelector('[data-role="mapping-info"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('Connection Status');
});

it('newest session snapshot wins for a duplicated account id', async () => {
  // fixture: two SessionSnapshotEntry rows with the same resolvedAccountId
  // and different lastSeenAt — assert the newer one's data renders.
  await loadOptionsPage(/* two-session fixture */);
  const section = getSectionByTitle('Аккаунты');
  // the OLDER session is disconnected, the NEWER connected → row must say захвачена
  expect(section.textContent).toContain('захвачена');
});

it('unmapped account carries the amber AI badge next to identity', async () => {
  await loadOptionsPage(/* known account, empty accountMappings */);
  const badge = getSectionByTitle('Аккаунты').querySelector('.chatgoose-badge-amber');
  expect(badge?.textContent).toBe('AI отключён');
});
```

  Also update, in the SAME edit, every existing reference to the removed section: the file's post-mount wait/assert on `getSectionByTitle('Connection Status')` re-points to `getSectionByTitle('Аккаунты')` with identical `dataset.sessionHydration` expectations, and the hydration-failure text assertion switches to the Russian failure message above.

- [ ] **Step 2: Run to verify the new tests fail** (`pnpm vitest run tests/options-accounts.test.ts`).

- [ ] **Step 3: Implement.**
  - `sessions.ts`: newest-wins lookup + capture status:

```ts
export function buildSessionLookup(
  sessions: SessionSnapshotEntry[],
): Map<string, SessionSnapshotEntry> {
  const lookup = new Map<string, SessionSnapshotEntry>();
  const put = (key: string, session: SessionSnapshotEntry): void => {
    const existing = lookup.get(key);
    if (!existing || session.lastSeenAt > existing.lastSeenAt) {
      lookup.set(key, session);
    }
  };
  sessions.forEach((session) => {
    put(session.legacyAccountId, session);
    if (session.resolvedAccountId) put(session.resolvedAccountId, session);
  });
  return lookup;
}

export function formatCaptureStatus(session: SessionSnapshotEntry | undefined): string {
  if (!session?.connected) return 'нет сессии';
  const seenAt = session.lastSeenAt;
  if (!Number.isFinite(seenAt)) return 'захвачена только что';
  const minutes = Math.max(0, Math.round((Date.now() - seenAt) / 60_000));
  if (minutes === 0) return 'захвачена только что';
  if (minutes < 60) return `захвачена ${minutes} мин назад`;
  return `захвачена ${Math.round(minutes / 60)} ч назад`;
}
```

    (If `lastSeenAt` on `SessionSnapshotEntry` is not a number on main, adapt the comparison to its actual type — check `src/shared/types.ts`; `buildConnectionRows` already compares it, so mirror that comparison exactly. Delete `buildConnectionRows` once nothing imports it.)
  - `index.ts`: delete `connectionsSection` + `renderConnections`; `hydrateAccountSections` calls only `renderAccountMappings`. In `renderAccountMappings`: section title/hint from `COPY.sections.accounts*`; row grid to four columns (`row.style.gridTemplateColumns = 'auto minmax(0,1fr) minmax(220px,320px) auto'`); prepend the avatar; identity block = heading + meta (existing) + NEW capture line `formatCaptureStatus(session)` + amber badge when `select.value === ''` (`createBadge('AI отключён', 'amber')` appended to the identity block; also append/remove it inside the select's change handler and in `refreshAccountMappingPersonalityOptions` so it tracks mapping changes). The `info` element (`data-role="mapping-info"`) stays exactly where it is, fourth column.
  - Avatar CSS:

```css
.chatgoose-avatar {
  width: 28px; height: 28px; border-radius: 8px; background: var(--chatgoose-bg3);
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  font: 600 10px/1 var(--chatgoose-font); color: var(--chatgoose-ink-mid); letter-spacing: 0.06em;
}
```

- [ ] **Step 4: Run the full options suites**

Run: `pnpm vitest run tests/options-accounts.test.ts tests/options-agency-hub.test.ts tests/options-persona-recovery.test.ts tests/options-shell-mount.test.ts`
Expected: PASS. Persona-availability pins (archived/unavailable mapping tests) must pass WITHOUT edits — if one fails, the merge broke `mapping-info`; fix the merge, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts src/options/sessions.ts src/options/styles.css tests/options-accounts.test.ts
git commit -m "feat(options): merge connection status into Аккаунты with newest-wins and capture copy"
```

---

### Task 6: Agency Hub section — label rows, permission badge, collapsed legacy key, footer

**Files:**
- Modify: `src/options/index.ts` (markup composition ONLY), `src/options/styles.css`
- Test: extend `tests/options-agency-hub.test.ts` (its own `loadOptionsPage`/`getSectionByTitle` harness)

**Interfaces:**
- Consumes: `createLabelRow`, `createBadge` (Task 2).
- Produces: section markup for P2 to build on:

```
section[data-shell-section="hub"]
  ├─ lrow(label) «Адрес хаба»      → agencyHubUrlInput          (unchanged element)
  ├─ lrow(div)   «Вход устройства» → hubSignInBlock             (unchanged elements inside)
  ├─ lrow(div)   «Доступ Firefox»  → [data-hub-permission-badge] + agencyHubPermissionStatus + agencyHubPermissionMeta + Grant button
  ├─ details.chatgoose-hub-legacy  «Legacy chatter key…» → agencyHubKeyRow (unchanged)
  └─ .chatgoose-hub-footer: [data-hub-test-line](status+meta) + Test button
```

Hard requirement: `agencyHubPermissionStatus` STAYS in the DOM — every permission state writes to it and existing tests assert its text. The badge is an addition, not a replacement.

- [ ] **Step 1: Write failing tests** (append to `tests/options-agency-hub.test.ts`, invoking `loadOptionsPage(...)` exactly as the file's neighboring tests do):

```ts
it('renders the hub section as labeled rows with a permission badge', async () => {
  await loadOptionsPage(/* same args as the file's basic render test */);
  const section = getSectionByTitle('Agency Hub');
  const labels = Array.from(section.querySelectorAll('.chatgoose-lrow-label'), (n) => n.textContent);
  expect(labels).toEqual(['Адрес хаба', 'Вход устройства', 'Доступ Firefox']);
  expect(section.querySelector('[data-hub-permission-badge]')).not.toBeNull();
});

it('legacy key lives inside a collapsed details block and permission status text survives', async () => {
  await loadOptionsPage(/* same args */);
  const section = getSectionByTitle('Agency Hub');
  const details = section.querySelector('details.chatgoose-hub-legacy') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')?.textContent).toContain('Legacy chatter key');
  expect(details.querySelector('input[type="password"]')).not.toBeNull();
  // the status node all permission states write to is still rendered:
  expect(section.textContent).toContain('Sync disabled');  // pre-Task-9 English state text
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Re-wrap.** Keep every element variable and every listener registration EXACTLY as-is. Replace only the final `agencyHubSection.append(...)` composition:

```ts
const hubSignInBlock = document.createElement('div');
hubSignInBlock.style.display = 'grid';
hubSignInBlock.style.gap = '7px';
hubSignInBlock.append(hubSignInRow, hubSignInStatus, hubSignInMeta);

const permissionBadge = createBadge('…', 'neutral');
permissionBadge.dataset.hubPermissionBadge = 'true';
const permissionBlock = document.createElement('div');
permissionBlock.style.display = 'grid';
permissionBlock.style.gap = '6px';
const permissionTop = document.createElement('div');
permissionTop.style.display = 'flex';
permissionTop.style.gap = '8px';
permissionTop.style.alignItems = 'center';
permissionTop.append(permissionBadge, agencyHubPermissionButton);
permissionBlock.append(permissionTop, agencyHubPermissionStatus, agencyHubPermissionMeta);

const legacyDetails = document.createElement('details');
legacyDetails.className = 'chatgoose-hub-legacy';
const legacySummary = document.createElement('summary');
legacySummary.textContent = 'Legacy chatter key — на период миграции';
legacyDetails.append(legacySummary, agencyHubKeyRow);

const testLine = document.createElement('div');
testLine.dataset.hubTestLine = 'true';
testLine.append(agencyHubConnectionStatus, agencyHubConnectionMeta);
const hubFooter = document.createElement('div');
hubFooter.className = 'chatgoose-hub-footer';
hubFooter.append(testLine, agencyHubConnectionButton);

agencyHubSection.append(
  createLabelRow('Адрес хаба', agencyHubUrlInput),
  createLabelRow('Вход устройства', hubSignInBlock),
  createLabelRow('Доступ Firefox', permissionBlock),
  legacyDetails,
  hubFooter,
);
```

  In `refreshAgencyHubPermissionState`, ADD badge reflection (keep all existing status/meta writes):

```ts
permissionBadge.textContent = permissionGranted ? 'разрешён' : 'не выдан';
permissionBadge.className = `chatgoose-badge chatgoose-badge-${permissionGranted ? 'green' : 'amber'}`;
```

  CSS:

```css
.chatgoose-hub-footer { display: flex; gap: 10px; align-items: center; border-top: 1px solid var(--chatgoose-line); margin-top: 6px; padding-top: 12px; }
.chatgoose-hub-footer > :first-child { flex: 1; min-width: 0; }
.chatgoose-hub-legacy > summary { cursor: pointer; font-size: 12px; color: var(--chatgoose-ink-low); }
```

- [ ] **Step 4: Run the full options suites** — permission/connection state tests must pass with selector updates ONLY where they located elements by position; text assertions unchanged until Task 9.

Run: `pnpm vitest run tests/options-agency-hub.test.ts tests/options-accounts.test.ts tests/options-persona-recovery.test.ts tests/options-shell-mount.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts src/options/styles.css tests/options-agency-hub.test.ts
git commit -m "feat(options): hub section in label rows with permission badge and collapsed legacy key"
```

---

### Task 7: Theme chips + Generation grid + persistence integration test

**Files:**
- Modify: `src/options/index.ts`, `src/options/styles.css`
- Test: `tests/options-shell-mount.test.ts` (extend)

**Interfaces:**
- Consumes: `createChipGroup`, `createToggle`, `createCap` (Task 2); `mountOptionsPage` (Task 1).
- Produces: `themeSelect` is the chip group's hidden `HTMLSelectElement`; `debugInput` is the toggle's `HTMLInputElement` — SAME variable names, so `settingsFormSignature`, the listener array, and pagehide are untouched.

- [ ] **Step 1: Write failing tests:**

```ts
it('theme renders as chips reflecting the stored value', async () => {
  const { document } = await mountOptionsPage({ settings: { uiTheme: 'dark' } });
  const chips = document.querySelectorAll('[data-shell-section="appearance"] .chatgoose-chip');
  expect(Array.from(chips, (chip) => chip.textContent)).toEqual(['Системная', 'Светлая', 'Тёмная']);
  expect(document.querySelector('.chatgoose-chip-selected')?.textContent).toBe('Тёмная');
});

it('clicking a theme chip persists uiTheme through the central controller', async () => {
  const page = await mountOptionsPage({ settings: { uiTheme: 'light' } });
  const dark = Array.from(
    page.document.querySelectorAll('[data-shell-section="appearance"] .chatgoose-chip'),
  ).find((chip) => chip.textContent === 'Тёмная') as HTMLButtonElement;
  dark.click();
  await page.flushAsync();
  expect(page.getState().settings.uiTheme).toBe('dark');
});

it('debug toggle lives in the Advanced block and persists', async () => {
  const page = await mountOptionsPage();
  const generation = page.document.querySelector('[data-shell-section="generation"]')!;
  expect(generation.querySelector('.chatgoose-cap')?.textContent).toBe('Advanced');
  const toggle = generation.querySelector('.chatgoose-toggle-input') as HTMLInputElement;
  toggle.click();
  await page.flushAsync();
  expect(page.getState().settings.debugMode).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** (identical mechanics to rev 1):
  - Appearance:

```ts
const themeChips = createChipGroup(
  [
    { value: 'system', label: 'Системная' },
    { value: 'light', label: 'Светлая' },
    { value: 'dark', label: 'Тёмная' },
  ],
  state.settings.uiTheme,
);
const themeSelect = themeChips.input;
appearanceSection.append(themeChips.root);
```

  (Delete the old select/options code and its `labeledField`; retitle via `COPY.sections.appearance*`.)
  - Generation:

```ts
const countsGrid = document.createElement('div');
countsGrid.className = 'chatgoose-counts-grid';
const countField = (label: string, input: HTMLInputElement): HTMLElement => {
  input.classList.add('chatgoose-num');
  const wrap = document.createElement('label');
  wrap.className = 'chatgoose-count-field';
  const text = document.createElement('span');
  text.textContent = label;
  wrap.append(text, input);
  return wrap;
};
countsGrid.append(
  countField('Reply + Help', quickInput),
  countField('Ping', pingInput),
  countField('Fix', improveInput),
  countField('Deep — Summary, Review', deepInput),
);
const advanced = document.createElement('div');
advanced.className = 'chatgoose-advanced';
const debugToggle = createToggle('Debug mode', 'окно отладки промпта');
const debugInput = debugToggle.input;
debugInput.checked = state.settings.debugMode;
advanced.append(createCap('Advanced'), debugToggle.root);
apiSection.append(countsGrid, advanced);
```

  (Delete the old `labeledField` count rows, the checkbox `debugInput` construction, and `debugLabel`; keep the variable NAME `debugInput` bound to the toggle's input. Delete the unused `.chatgoose-model-config-grid` CSS block.)
  - CSS:

```css
.chatgoose-counts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; }
.chatgoose-count-field { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12.5px; font-weight: 600; }
.chatgoose-count-field input { width: 74px; text-align: right; }
.chatgoose-advanced { border-top: 1px solid var(--chatgoose-line); margin-top: 14px; padding-top: 11px; display: grid; gap: 9px; }
@media (max-width: 640px) { .chatgoose-counts-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: Run everything**

Run: `pnpm vitest run`
Expected: PASS (no `| tail` — the raw exit code is the gate).

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts src/options/styles.css tests/options-shell-mount.test.ts
git commit -m "feat(options): theme chips and generation grid with persistence coverage"
```

---

### Task 8: Wire the saved-flash into the central save controller

**Files:**
- Modify: `src/options/index.ts`
- Test: `tests/options-shell-mount.test.ts` (extend)

**Interfaces:**
- Consumes: `createSavedFlash` (Task 2).
- Produces: `[data-saved-flash]`; success paths call `showSaved()`, caught save errors ALSO call `showError(...)` (existing `console.error` calls stay).

- [ ] **Step 1: Write failing test:**

```ts
it('flashes Сохранено after a settings change persists', async () => {
  const page = await mountOptionsPage();
  const quick = page.document.querySelector(
    '[data-shell-section="generation"] input',
  ) as HTMLInputElement;
  quick.value = '30';
  quick.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await page.flushAsync();
  const flash = page.document.querySelector('[data-saved-flash]') as HTMLElement;
  expect(flash.hidden).toBe(false);
  expect(flash.textContent).toBe('Сохранено ✓');
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** After the shell mounts in `render()`:

```ts
const savedFlash = createSavedFlash();
savedFlash.root.dataset.savedFlash = 'true';
root.append(savedFlash.root);
```

  Hooks (additive lines only): in `queueSettingsSave`'s `persist` success point (right after `state.settings = mergedSettings;`) add `savedFlash.showSaved();`; in its `.catch` add `savedFlash.showError('настройки не сохранились — повтори');`. In the mapping save handler: success → `savedFlash.showSaved();`, catch → `savedFlash.showError('маппинг не сохранился');`. Pagehide path untouched.

- [ ] **Step 4: Run** `pnpm vitest run tests/options-shell-mount.test.ts tests/options-accounts.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts tests/options-shell-mount.test.ts
git commit -m "feat(options): saved-flash wired to the central save controller"
```

---

### Task 9: Russian copy sweep — every user-visible string on the options surface

**Files:**
- Modify: `src/options/index.ts`, `src/options/sessions.ts`, `src/options/copy.ts`
- Test: update pinned strings in `tests/options-accounts.test.ts`, `tests/options-agency-hub.test.ts`, `tests/options-persona-recovery.test.ts`

**Glossary (terms that stay English):** Hub, Agency Hub, device token, token, chatter key, Spenders, Debug mode, Reply / Fix / Help / Ping / Deep, Fansly, about:addons. Everything else translates.

Translation table (exact target strings; left = current literal in code):

| Current | Russian |
|---|---|
| `Loading Fansly accounts…` | `Загружаю аккаунты Fansly…` |
| `No Fansly accounts detected yet.` | `Аккаунты не обнаружены — открой fansly.com с аккаунтом модели.` |
| `Live account refresh failed. Showing mappings from local storage.` | `Не удалось обновить живой статус аккаунтов — показаны маппинги из локального хранилища.` |
| `Unmapped` | `— не назначена —` |
| `· add instructions first` (unusable persona suffix) | `· недоступна` |
| `archived` (persona status meta, if rendered) | `в архиве` |
| `Account ID: <id>` | `ID аккаунта: <id>` |
| `Model Personalities` (section title) | `Персоны` (from `COPY`) |
| `Global personalities are managed by Agency Hub admins. This extension only reads the catalog and stores account mappings.` | `Голоса управляются на сервере агентства; здесь — только каталог и привязки аккаунтов.` |
| `No server personas are available yet. Check the Agency Hub connection or ask an admin to create one.` | `Персон на сервере ещё нет — проверь подключение к Hub или попроси владельца создать голос.` |
| `Legacy local persona text is preserved unchanged on this device. Export it before removing the extension or clearing browser data.` | `Легаси-тексты персон сохранены на этом устройстве без изменений. Экспортируй их перед удалением расширения или очисткой браузера.` |
| `ChatGoose Persona Recovery` | `Восстановление персон` |
| `The preserved legacy persona snapshot is malformed. Normal Settings and Agency Hub access are disabled so the snapshot cannot be overwritten.` | `Сохранённый снапшот легаси-персон повреждён. Обычные настройки и доступ к Agency Hub отключены, чтобы снапшот нельзя было перезаписать.` |
| `Legacy Persona Recovery` (recovery section title) | `Экспорт легаси-персон` |
| `Agency Hub base URL` | `Адрес хаба` (label row, Task 6) |
| `Sign in & issue device token` | `Войти и выпустить token` |
| `Hub username` / `Hub password` (placeholders) | `Логин хаба` / `Пароль хаба` |
| `Device token active ✓` | `Device token активен ✓` |
| `No device token yet.` | `Device token ещё не выпущен.` |
| `Signing in…` | `Вхожу…` |
| `Sign-in failed: <msg>` | `Вход не удался: <msg>` |
| `Show` / `Hide` | `Показать` / `Скрыть` |
| `Grant Access` / `Reconnect` | `Разрешить доступ` / `Переподключить` |
| `Test Connection` | `Проверить соединение` |
| `Not tested yet.` | `Ещё не проверялось.` |
| `Connection status updating…` | `Статус соединения обновляется…` |
| `Testing connection…` | `Проверяю соединение…` |
| `Connected ✓` | `Соединение OK ✓` |
| `Connection failed: <code>` | `Соединение не удалось: <code>` |
| `Sync disabled: …` family (all permission-state strings) | `Синк отключён: …` (translate each sentence in place, keeping origin patterns and error details verbatim) |
| `Enable debug mode` | (replaced by the Task 7 toggle — `Debug mode` label stays English per glossary) |
| Legacy persona EXPORT button/status strings (`createLegacyPersonaExportControls`) | translate each literal in place, same pattern |
| Future-schema barrier warning text (the v15 message) | `Настройки открыты в более новой версии схемы — эта вкладка больше не сохраняет изменения. Перезагрузи страницу.` (adapt to the existing sentence structure) |

- [ ] **Step 1: Update the pinned strings in all three test files first** (they are the failing tests: every assertion that quotes one of the left-column literals switches to the right column).
- [ ] **Step 2: Run to verify failures** (`pnpm vitest run tests/options-accounts.test.ts tests/options-agency-hub.test.ts tests/options-persona-recovery.test.ts`).
- [ ] **Step 3: Translate the literals in `index.ts` / `sessions.ts`** per the table. Then sweep for leftovers: `grep -nE "textContent = '[A-Z]|placeholder = '[A-Z]|title = '[A-Z]" src/options/*.ts` — every hit must be either in the glossary or translated; extend the table in this plan's PR description for anything the grep uncovers that the table missed.
- [ ] **Step 4: Run the three suites + full run** (`pnpm vitest run`) — PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(options): Russian copy sweep with EN-term glossary"`

---

### Task 10: Local fonts — bundle woff2, drop the Google CDN everywhere

**Files:**
- Create: `assets/fonts/` (12 files + README.md)
- Modify: `src/options/index.html`, `src/popup/index.html`, `src/options/styles.css`, `src/popup/styles.css`, `esbuild.config.mjs`; `src/debug-prompt/*` only per the check below
- Test: `tests/local-fonts.test.ts` (create)

Font inventory (from google-webfonts-helper, `https://gwfh.mranftl.com/fonts`; record the helper's version stamp per family in `assets/fonts/README.md` together with the license — all three families are SIL OFL):

```
hanken-grotesk-latin-400.woff2 / -500 / -600 / -700      (no Cyrillic exists for this family;
                                                          Russian text falls back to system sans — same as today)
source-serif-4-latin-600.woff2 / source-serif-4-cyrillic-600.woff2
ibm-plex-mono-latin-400.woff2 / -500 / -600
ibm-plex-mono-cyrillic-400.woff2 / -500 / -600           (popup mono runs at 600 today — cover it)
```

- [ ] **Step 1: Check debug-prompt first.** `grep -n "googleapis\|Hanken\|Source Serif\|Plex" src/debug-prompt/index.html src/debug-prompt/styles.css` — if the page neither links Google nor names the families, it is OUT of this task (system fonts by design); if it names families, add the same `@font-face` block to its styles.css and (if present) remove its Google links.

- [ ] **Step 2: Write the failing static test** `tests/local-fonts.test.ts` — mirror `tests/release-pages.test.ts`'s file-access pattern (URL-relative `readFileSync`, no `process.cwd`, no `readdirSync` — those are absent from the repo's Node shims):

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const readBytes = (path: string): Buffer => readFileSync(new URL(path, root)) as Buffer;

const PAGES = ['src/options/index.html', 'src/popup/index.html', 'src/debug-prompt/index.html'];
const FONT_FILES = [
  'hanken-grotesk-latin-400.woff2', 'hanken-grotesk-latin-500.woff2',
  'hanken-grotesk-latin-600.woff2', 'hanken-grotesk-latin-700.woff2',
  'source-serif-4-latin-600.woff2', 'source-serif-4-cyrillic-600.woff2',
  'ibm-plex-mono-latin-400.woff2', 'ibm-plex-mono-latin-500.woff2', 'ibm-plex-mono-latin-600.woff2',
  'ibm-plex-mono-cyrillic-400.woff2', 'ibm-plex-mono-cyrillic-500.woff2', 'ibm-plex-mono-cyrillic-600.woff2',
];
const FONT_CSS = ['src/options/styles.css', 'src/popup/styles.css'];

describe('local fonts', () => {
  it('no extension page references an external font host', () => {
    for (const page of PAGES) {
      expect(read(page), page).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
  });

  it('every declared font file exists and is real WOFF2', () => {
    for (const file of FONT_FILES) {
      const bytes = readBytes(`assets/fonts/${file}`);
      expect(bytes.subarray(0, 4).toString('ascii'), file).toBe('wOF2');
    }
  });

  it('each font-bearing stylesheet declares the families and only known files', () => {
    for (const cssPath of FONT_CSS) {
      const css = read(cssPath);
      for (const family of ['Hanken Grotesk', 'Source Serif 4', 'IBM Plex Mono']) {
        expect(css, cssPath).toContain(`font-family: '${family}'`);
      }
      for (const match of css.matchAll(/url\('fonts\/([^']+)'\)/g)) {
        expect(FONT_FILES, `${cssPath} references ${match[1]!}`).toContain(match[1]!);
      }
    }
  });
});
```

  If `readFileSync` overloads in `tests/node-shims.d.ts` lack the no-encoding (Buffer) form, extend the shim with that overload declaration in this task.

- [ ] **Step 3: Run to verify failure** (`pnpm vitest run tests/local-fonts.test.ts`).

- [ ] **Step 4: Implement.** Download + commit the 12 files and `assets/fonts/README.md` (source URL, gwfh version stamp, OFL license note per family). Remove the two Google `<link>` lines (+preconnects) from options and popup HTML. Prepend the `@font-face` block to BOTH `src/options/styles.css` and `src/popup/styles.css`:

```css
@font-face { font-family: 'Hanken Grotesk'; font-style: normal; font-weight: 400; font-display: swap; src: url('fonts/hanken-grotesk-latin-400.woff2') format('woff2'); }
@font-face { font-family: 'Hanken Grotesk'; font-style: normal; font-weight: 500; font-display: swap; src: url('fonts/hanken-grotesk-latin-500.woff2') format('woff2'); }
@font-face { font-family: 'Hanken Grotesk'; font-style: normal; font-weight: 600; font-display: swap; src: url('fonts/hanken-grotesk-latin-600.woff2') format('woff2'); }
@font-face { font-family: 'Hanken Grotesk'; font-style: normal; font-weight: 700; font-display: swap; src: url('fonts/hanken-grotesk-latin-700.woff2') format('woff2'); }
@font-face { font-family: 'Source Serif 4'; font-style: normal; font-weight: 600; font-display: swap; src: url('fonts/source-serif-4-latin-600.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F; }
@font-face { font-family: 'Source Serif 4'; font-style: normal; font-weight: 600; font-display: swap; src: url('fonts/source-serif-4-cyrillic-600.woff2') format('woff2'); unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
@font-face { font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 400; font-display: swap; src: url('fonts/ibm-plex-mono-latin-400.woff2') format('woff2'); unicode-range: U+0000-00FF; }
@font-face { font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 500; font-display: swap; src: url('fonts/ibm-plex-mono-latin-500.woff2') format('woff2'); unicode-range: U+0000-00FF; }
@font-face { font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 600; font-display: swap; src: url('fonts/ibm-plex-mono-latin-600.woff2') format('woff2'); unicode-range: U+0000-00FF; }
@font-face { font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 400; font-display: swap; src: url('fonts/ibm-plex-mono-cyrillic-400.woff2') format('woff2'); unicode-range: U+0400-045F; }
@font-face { font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 500; font-display: swap; src: url('fonts/ibm-plex-mono-cyrillic-500.woff2') format('woff2'); unicode-range: U+0400-045F; }
@font-face { font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 600; font-display: swap; src: url('fonts/ibm-plex-mono-cyrillic-600.woff2') format('woff2'); unicode-range: U+0400-045F; }
```

  In `esbuild.config.mjs` `ensureStaticFiles()`:

```js
await cp(path.join(root, 'assets/fonts'), path.join(outdir, 'fonts'), { recursive: true });
```

  Known dev-mode limitation (accepted, note in the PR): watch mode rebuilds statics only on TS/CSS rebuilds — a font-file-only change needs a manual rebuild.

- [ ] **Step 5: Run tests + build**

Run: `pnpm vitest run tests/local-fonts.test.ts && pnpm build && ls dist/fonts`
Expected: PASS; `dist/fonts` lists 12 files.

- [ ] **Step 6: Manual verify** — load `dist/` via `about:debugging`; DevTools Network on the options page and popup shows zero `googleapis`/`gstatic` requests; the Fonts panel shows Source Serif 4 on headings and IBM Plex Mono on the version pill.

- [ ] **Step 7: Commit**

```bash
git add assets/fonts src/options/index.html src/popup/index.html src/options/styles.css src/popup/styles.css esbuild.config.mjs tests/local-fonts.test.ts tests/node-shims.d.ts
git commit -m "feat: bundle family fonts locally, drop Google Fonts CDN from extension pages"
```

---

### Task 11: Spec §10 amendment, decision log entry, full check, finish

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-options-redesign-design.md` (§10, one bullet)
- Modify: `docs/decisions.md`
- Test: `pnpm check`

- [ ] **Step 1: Amend spec §10** — replace the sentence about splitting `index.ts` into `sections/*.ts` with: "`src/options/index.ts` stays the single orchestrator through P1 (shell/primitives/copy extracted); per-section modules are carved out incrementally in P2 (status/hub) and P3 (personas) as those phases rebuild each section — extracting race-sensitive save wiring with zero behavior change is not worth doing twice."

- [ ] **Step 2: Append the decision entry** to `docs/decisions.md` (verify the next free number in the file at merge time):

```markdown
**E<N> (2026-07-<DD>).** Options P1 shell redesign: the settings page adopts
the desktop SettingsSurface shape (sticky nav + scrollspy + 9px section
cards) and the family control vocabulary (badge/toggle/chips/cap/num,
saved-flash autosave feedback), merges Account Mappings + Connection Status
into one «Аккаунты» section (persona-availability info node and
newest-snapshot-wins preserved), collapses the legacy chatter key behind
<details>, moves the options surface to Russian copy with an English-term
glossary, and bundles the family fonts locally (Google Fonts CDN removed
from options and popup; debug-prompt deliberately stays on system fonts).
Zero behavior change: the single central write controller, custody
discipline (E19), persona preservation/recovery (E36/E37) and the
future-schema barrier move verbatim; storage schema stays v14. Per-section
module extraction is deferred to P2/P3 (spec §10 amended). Spec:
docs/superpowers/specs/2026-07-16-options-redesign-design.md (P1).
```

  Add the matching one-line row to the summary table.

- [ ] **Step 3: Full check**

Run: `pnpm check`
Expected: all green.

- [ ] **Step 4: Manual walkthrough** (fresh temporary profile): nav scrolls + highlights; theme chips switch instantly and survive reload; a count edit flashes «Сохранено ✓»; hub rows render with the permission badge AND the status text; legacy key opens on click; merged Аккаунты shows capture status + mapping select + availability info; dark theme = pure token swap on every new component.

- [ ] **Step 5: Commit + push + Draft PR + toolkit review**

```bash
git add docs/decisions.md docs/superpowers/specs/2026-07-16-options-redesign-design.md
git commit -m "docs: record options P1 shell redesign decision; spec §10 split deferral"
git push -u origin ai/<task-id>-options-redesign-p1
gh pr create --draft --title "Options P1: desktop-parity shell, Russian copy, local fonts" --body "Spec: docs/superpowers/specs/2026-07-16-options-redesign-design.md (P1). No behavior change; no schema change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
~/code/agentic-control-plane/bin/agent review chatgoose --pr <N>
```

---

## Self-Review Notes (rev 3)

- **Codex-review deltas applied:** Task 1 no longer promises a byte-identical harness move (new-tests-only helper; existing suites keep local harnesses; real helper names `loadOptionsPage`/`getSectionByTitle` used in Tasks 5–6); Task 5 preserves `mapping-info` + newest-wins (`buildSessionLookup` upgraded, `buildConnectionRows` retired) + 4-column row; Task 6 keeps `agencyHubPermissionStatus` in the DOM and `createLabelRow` yields a real `<label>` for single form controls; Task 2 tests stub `Event`/`CustomEvent` into the JSDOM realm; Task 7 fixes the deep-merge typing (`settings?: Partial<Settings>`) and adds persistence integration tests for the hidden-control tricks; Task 8 drops `as any`; Task 9 is a full sweep with a translation table + glossary (html lang/title moved to Task 4); Task 10 covers mono 600, Cyrillic 500/600, debug-prompt check, WOFF2 magic-byte + URL-target assertions, shim-safe file access, provenance README; Task 4 registers sections in one ordered block; Task 3 retunes card metrics to the desktop spec; Task 11 amends spec §10 (split deferred) and drops the "all copy" overclaim.
- **Type consistency:** `themeSelect: HTMLSelectElement` (chip group) and `debugInput: HTMLInputElement` (toggle) keep their original names and types at the call sites; `mountOptionsPage` returns `getState(): PersistedState` used by Task 7/8 tests; `formatCaptureStatus` consumed only in Task 5.
- **Deliberately out of P1:** status rows, readiness hero, health/me/quota/spenders data, Changelog button, sign-out, persona catalog rows, changelog.html — P2/P3/parallel track per spec §13.
