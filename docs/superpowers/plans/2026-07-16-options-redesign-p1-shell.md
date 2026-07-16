# Options Redesign P1 — Shell & Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the options page shell to desktop parity (sticky nav + scrollspy + section cards + family primitives + Russian copy + local fonts) with zero behavior change to settings/save/hub logic.

**Architecture:** Keep `src/options/index.ts` as the single orchestrator and the ONE central write controller; extract only presentation: new DOM primitives in `dom.ts`, a page shell in `shell.ts`, component CSS in `styles.css`. Sections are re-wrapped visually in place — their handlers, save chains, and race guards move verbatim, never rewritten.

**Tech Stack:** Plain TS + DOM (no framework), esbuild (CSS as text, injected `<style>`), vitest + JSDOM (dynamic `await import('../src/options/index.js')` after globals are staged, as in existing options tests).

**Spec:** `docs/superpowers/specs/2026-07-16-options-redesign-design.md` (§3, §6 presentation-only parts, §9, §10; P1 scope from §13.1).

## Global Constraints

- Execution happens in a fresh toolkit worktree: `~/code/agentic-control-plane/bin/agent task chatgoose options-redesign-p1` before the first edit (repo is in repos.yaml; canonical checkout is owner-only).
- `pnpm check` (typecheck + lint + gates + tests + build) green before EVERY commit.
- Storage schema stays at `STORAGE_SCHEMA_VERSION = 14` — this plan adds no migration and no new persisted keys.
- The E37 future-schema barrier, the E36 persona preservation/recovery/export machinery, and the E19 custody discipline (dedicated credential keys, dirty-tracking, serialized saves, pagehide path) move UNCHANGED. Tests pinning them must stay green unweakened.
- One central write controller: no new module reads or writes `browser.storage` — only `index.ts` does, exactly as today.
- No new network calls of any kind in P1 (no Fansly, no hub beyond what the page already does).
- UI copy: Russian with English terms (Hub, device token, Spenders, Reply/Fix/Ping). Exact strings are given per task; do not improvise.
- Family tokens in `src/options/styles.css` `:root` / `.chatgoose-theme-dark` are frozen — extend with component classes only, never edit token values. Dark theme stays a pure variable swap (no per-component dark rules).
- Version identity: do not touch `package.json`/`manifest.json` versions in P1 tasks; release bumps are a separate release step.

## File Structure

```
src/options/
  index.html      (modify: drop Google Fonts links)
  styles.css      (extend: @font-face + component classes)
  dom.ts          (extend: badge/toggle/chips/cap/label-row/saved-flash builders)
  shell.ts        (create: page layout, nav, scrollspy, saved-flash mount)
  copy.ts         (create: all P1 Russian strings, one exported const)
  index.ts        (modify: mount shell, re-wrap sections, merge accounts, wire flash)
src/popup/index.html        (modify: drop Google Fonts links)
src/debug-prompt/index.html (modify only if it links Google Fonts — check)
assets/fonts/*.woff2        (create: committed font binaries)
esbuild.config.mjs          (modify: copy assets/fonts → dist/fonts)
tests/helpers/options-page.ts (create: extracted mount harness)
tests/options-dom.test.ts     (create)
tests/options-shell.test.ts   (create)
tests/local-fonts.test.ts     (create)
docs/decisions.md             (append the P1 entry in the same PR)
```

---

### Task 1: Extract the options-page test harness into a shared helper

**Files:**
- Create: `tests/helpers/options-page.ts`
- Modify: `tests/options-accounts.test.ts` (imports only)
- Test: existing `tests/options-accounts.test.ts`, `tests/options-agency-hub.test.ts`, `tests/options-persona-recovery.test.ts` stay green

**Interfaces:**
- Produces: `mountOptionsPage(overrides?: MountOverrides): Promise<MountedOptionsPage>` where

```ts
export interface MountOverrides {
  state?: Partial<PersistedState>;
  sessions?: SessionSnapshotEntry[];
}
export interface MountedOptionsPage {
  document: Document;
  window: Window & typeof globalThis;
  flushAsync: () => Promise<void>;   // drains microtasks + pending timers
  emitStorageChanges: (changes: Record<string, browser.storage.StorageChange>, areaName?: string) => void;
  getState: () => PersistedState;
}
```

CRITICAL for byte-identical test bodies: the existing test bodies call the
setup's control hooks directly ~37 times (`stallNextStorageSet`,
`releaseFirstStorageSet`, `failNextStorageSet`, `onSnapshotRequest`,
`onStorageRead`, `callOrder`, plus the fixture builders like
`connectedSession`). The helper must re-export ALL of them as named exports
under their existing names, so the test file only swaps its local
declarations for `import { stallNextStorageSet, releaseFirstStorageSet,
failNextStorageSet, setOnSnapshotRequest, setOnStorageRead, callOrder,
connectedSession, flushSessionHydration, getSectionByTitle, … } from
'./helpers/options-page.js'`. Where a hook is a reassignable `let`
(`onSnapshotRequest = () => …`), export a setter (`setOnSnapshotRequest`)
and mechanically rewrite those assignment call sites — that is the ONLY
permitted body edit. Enumerate the exact export list by grepping the file
for every identifier declared in the moved span and used below it.

- [ ] **Step 1: Read the existing setup once.** Open `tests/options-accounts.test.ts` and identify the setup span: JSDOM construction (`dom = new JSDOM(` around line 87), the `browser` global staging (storage.local get/set fakes over `currentState`, `runtime.sendMessage` returning `currentSessions` for `getSessionsSnapshot`, `runtime.getManifest`, permissions stubs, `matchMedia`), and the mount call `await import('../src/options/index.js')` (around line 206). This is a MOVE, not a rewrite: the helper's body is that existing code relocated verbatim, parameterized by `MountOverrides` instead of the file-scoped `currentState`/`currentSessions` variables.

- [ ] **Step 2: Create `tests/helpers/options-page.ts`** exporting `mountOptionsPage`, `MountOverrides`, `MountedOptionsPage`. Body = relocated setup from Step 1. Default state = the file's current default `PersistedState` fixture (schemaVersion 14). Keep `vi.resetModules()` before the dynamic import so each mount gets a fresh module instance. Keep the JSDOM teardown in an exported `unmountOptionsPage()` used by `afterEach`.

- [ ] **Step 3: Rewire `tests/options-accounts.test.ts`** to import the helper and delete the moved lines. Every test body stays byte-identical; only the setup plumbing changes.

- [ ] **Step 4: Run the three options suites**

Run: `pnpm vitest run tests/options-accounts.test.ts tests/options-agency-hub.test.ts tests/options-persona-recovery.test.ts`
Expected: all PASS (agency-hub and persona-recovery are untouched in this task; they keep their own local setups for now).

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/options-page.ts tests/options-accounts.test.ts
git commit -m "test(options): extract shared page-mount harness"
```

---

### Task 2: DOM primitives — badge, cap, toggle, chip group, label row, saved flash

**Files:**
- Modify: `src/options/dom.ts`
- Modify: `src/options/styles.css` (component classes used below)
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
): { root: HTMLDivElement; input: HTMLSelectElement };  // hidden select carries value + fires 'input'/'change'
export function createLabelRow(label: string, control: HTMLElement): HTMLDivElement;
export function createSavedFlash(): {
  root: HTMLDivElement;
  showSaved: () => void;
  showError: (message: string) => void;
};
```

- Consumes: nothing new; sits beside the existing `createSection`/`createButton`/`labeledField`/`debounce`.

- [ ] **Step 1: Write failing tests** in `tests/options-dom.test.ts` (plain JSDOM, no page mount):

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
});
afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

describe('options dom primitives', () => {
  it('createBadge renders tone and mono classes', async () => {
    const { createBadge } = await import('../src/options/dom.js');
    const badge = createBadge('активен', 'green');
    expect(badge.className).toContain('chatgoose-badge');
    expect(badge.className).toContain('chatgoose-badge-green');
    expect(badge.textContent).toBe('активен');
    const mono = createBadge('LIVE', 'green', true);
    expect(mono.className).toContain('chatgoose-badge-mono');
  });

  it('createToggle drives a real checkbox', async () => {
    const { createToggle } = await import('../src/options/dom.js');
    const { root, input } = createToggle('Debug mode', 'окно отладки промпта');
    expect(root.className).toContain('chatgoose-toggle-row');
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
    vi.useRealTimers();
  });

  it('createLabelRow and createCap render the family shapes', async () => {
    const { createCap, createLabelRow } = await import('../src/options/dom.js');
    const cap = createCap('Advanced');
    expect(cap.className).toBe('chatgoose-cap');
    const row = createLabelRow('Адрес хаба', document.createElement('input'));
    expect(row.className).toBe('chatgoose-lrow');
    expect(row.querySelector('.chatgoose-lrow-label')?.textContent).toBe('Адрес хаба');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/options-dom.test.ts`
Expected: FAIL — `createBadge` (etc.) not exported.

- [ ] **Step 3: Implement the primitives** in `src/options/dom.ts`:

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
  // The hidden select is the single source of value: existing save wiring
  // listens to 'input'/'change' on form controls and stays untouched.
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

export function createLabelRow(label: string, control: HTMLElement): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'chatgoose-lrow';
  const labelNode = document.createElement('div');
  labelNode.className = 'chatgoose-lrow-label';
  labelNode.textContent = label;
  const controlWrap = document.createElement('div');
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

- [ ] **Step 4: Add the component CSS** to `src/options/styles.css` (below the existing classes; token values only via `var()`):

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

.chatgoose-cap {
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
  font-weight: 600; color: var(--chatgoose-ink-low);
}
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
.chatgoose-lrow:last-child { border-bottom: 0; }
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

### Task 3: Page shell — layout, sticky nav, scrollspy

**Files:**
- Create: `src/options/shell.ts`
- Modify: `src/options/styles.css` (layout/nav classes)
- Test: `tests/options-shell.test.ts` (create)

**Interfaces:**
- Produces (exported from `src/options/shell.ts`):

```ts
export interface ShellSection { id: string; title: string; }
export interface OptionsShell {
  layout: HTMLDivElement;          // append into #chatgoose-options-root after the hero
  main: HTMLDivElement;            // sections container
  addSection: (id: string, card: HTMLElement) => void;  // tags card with data-shell-section=id
  setActiveNav: (id: string) => void;                   // exported for tests + scroll fallback
  dispose: () => void;                                  // removes observers/listeners
}
export function buildShell(sections: ShellSection[], scrollRoot?: HTMLElement): OptionsShell;
```

- Consumes: nothing from other tasks (pure DOM). `index.ts` consumes it in Task 4.

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
Expected: FAIL — module `src/options/shell.js` not found.

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
      cardsById.get(section.id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      setActiveNav(section.id);
    });
    itemsById.set(section.id, item);
    nav.append(item);
  }

  // Scrollspy: IntersectionObserver when available (real Firefox); the
  // click-driven fallback above is the whole story in JSDOM/tests.
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

  return {
    layout,
    main,
    addSection,
    setActiveNav,
    dispose: () => observer?.disconnect(),
  };
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
```

- [ ] **Step 4: Add layout CSS** to `src/options/styles.css`:

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
.chatgoose-main .chatgoose-section { margin: 0; }
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
git commit -m "feat(options): page shell with sticky nav and scrollspy"
```

---

### Task 4: Russian copy module + mount the shell in index.ts (no section reshaping yet)

**Files:**
- Create: `src/options/copy.ts`
- Modify: `src/options/index.ts` (hero + shell mount + nav registration)
- Test: `tests/options-shell-mount.test.ts` (create, uses the Task 1 helper)

**Interfaces:**
- Produces: `import { COPY } from './copy.js'` — a single frozen object; keys used across P1:

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

- Consumes: `buildShell` from Task 3.

- [ ] **Step 1: Write the failing mount test** in `tests/options-shell-mount.test.ts`:

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

  it('every section card is registered with the shell', async () => {
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
Expected: FAIL — h1 is `ChatGoose Settings`, no `.chatgoose-nav-item` nodes.

- [ ] **Step 3: Modify `src/options/index.ts`:**
  1. Add imports: `import { buildShell } from './shell.js';` and `import { COPY } from './copy.js';` (create `copy.ts` with the exact object above).
  2. Hero: `title.textContent = COPY.pageTitle;` and `subtitle.textContent = COPY.pageSubtitle;`.
  3. Right after the hero is appended, build the shell:

```ts
const shell = buildShell([
  { id: 'hub', title: COPY.nav.hub },
  { id: 'personas', title: COPY.nav.personas },
  { id: 'accounts', title: COPY.nav.accounts },
  { id: 'generation', title: COPY.nav.generation },
  { id: 'appearance', title: COPY.nav.appearance },
  { id: 'version', title: COPY.nav.version },
]);
root.append(shell.layout);
cleanupTasks.push(() => shell.dispose());
```

  4. Replace every `root.append(<sectionEl>)` for the existing sections with `shell.addSection('<id>', <sectionEl>)` in the nav order above. Section internals are untouched in this task; the Appearance section maps to `appearance`, Generation to `generation`, Agency Hub to `hub`, Model Personalities to `personas`, Account Mappings + Connection Status BOTH to the main column for now (`shell.addSection('accounts', mappingsSection)` and `shell.main.append(connectionsSection)` — the real merge is Task 5).
  5. Add the new Version card at the end (data it already has):

```ts
const versionSection = createSection(COPY.sections.versionTitle, COPY.sections.versionHint);
const versionLine = document.createElement('div');
versionLine.className = 'chatgoose-num';
versionLine.style.fontSize = '12px';
versionLine.style.color = 'var(--chatgoose-ink-mid)';
versionLine.textContent = `v ${extensionVersion} · канал: self-hosted feed`;
versionSection.append(versionLine);
shell.addSection('version', versionSection);
```

  (No Changelog button in P1 — it ships in P2 after the anchored page deploys.)

- [ ] **Step 4: Run the new test + all options suites**

Run: `pnpm vitest run tests/options-shell-mount.test.ts tests/options-accounts.test.ts tests/options-agency-hub.test.ts tests/options-persona-recovery.test.ts`
Expected: shell-mount PASS. If an existing suite asserts the old h1/subtitle text, update those literals to the new Russian strings — that is the only permitted change to existing assertions in this task.

- [ ] **Step 5: Commit**

```bash
git add src/options/copy.ts src/options/index.ts tests/options-shell-mount.test.ts tests/options-accounts.test.ts
git commit -m "feat(options): mount desktop-parity shell with Russian copy"
```

---

### Task 5: Merge «Account Mappings» + «Connection Status» into one «Аккаунты» section

**Files:**
- Modify: `src/options/index.ts` (the `renderAccountMappings` / `renderConnections` region)
- Test: extend `tests/options-accounts.test.ts`

**Interfaces:**
- Consumes: `createBadge` (Task 2), existing `buildSessionLookup`/`formatAccountHeading`/`formatAccountMeta` from `src/options/sessions.ts`, existing `saveAccountMapping` flow.
- Produces: one section card `data-shell-section="accounts"`; per-account row markup:

```
div[data-account-mapping-row=<id>]
  ├─ .chatgoose-avatar        (initials from heading)
  ├─ div: heading + status line («захвачена N мин назад» | «нет сессии»)
  ├─ select[data-account-id]  (unchanged semantics, incl. dataset.mappingPending)
  └─ .chatgoose-badge-amber   («AI отключён», only when unmapped)
```

- [ ] **Step 1: Write failing tests** (append to `tests/options-accounts.test.ts`):

```ts
it('renders one merged Аккаунты section with capture status inline', async () => {
  const { document } = await mountOptionsPage({
    sessions: [connectedSession({ accountId: 'acc-1' })],
    state: { knownAccounts: ['acc-1'] },
  });
  await flushSessionHydration();
  const cards = document.querySelectorAll('[data-shell-section="accounts"]');
  expect(cards).toHaveLength(1);
  const row = cards[0]!.querySelector('[data-account-mapping-row="acc-1"]')!;
  expect(row.textContent).toContain('захвачена');
  expect(document.body.textContent).not.toContain('Connection Status');
});

it('unmapped account carries the amber AI badge', async () => {
  const { document } = await mountOptionsPage({
    sessions: [connectedSession({ accountId: 'acc-1' })],
    state: { knownAccounts: ['acc-1'], accountMappings: {} },
  });
  await flushSessionHydration();
  const badge = document.querySelector('[data-account-mapping-row="acc-1"] .chatgoose-badge-amber');
  expect(badge?.textContent).toBe('AI отключён');
});
```

(`connectedSession` and `flushSessionHydration` are the file's existing fixtures/helpers — reuse them exactly as the neighboring tests do.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/options-accounts.test.ts`
Expected: the two new tests FAIL (two separate sections exist; no badge/word «захвачена»).

- [ ] **Step 3: Implement the merge in `index.ts`:**
  - Delete the `connectionsSection` (`createSection('Connection Status')`) and `renderConnections` entirely; `hydrateAccountSections` now calls only `renderAccountMappings`.
  - The merged section INHERITS the hydration lifecycle contract the tests
    pin: `mappingsSection.dataset.sessionHydration` keeps its
    `loading → ready|failed` transitions exactly as today, and the
    hydration-failure state keeps a visible message — the section's existing
    warning becomes the single failure copy: «Не удалось обновить живой
    статус аккаунтов — показаны маппинги из локального хранилища». Existing
    assertions on `getSectionByTitle('Connection Status')` re-point to
    `getSectionByTitle('Аккаунты')` (same `dataset.sessionHydration`
    expectations, failure text updated to the Russian string above) — the
    BEHAVIOR they pin (non-blocking hydration, honest failure) must survive
    unchanged.
  - Retitle the mappings section: `createSection(COPY.sections.accountsTitle, COPY.sections.accountsHint)`.
  - Inside `renderAccountMappings`, per row: prepend an avatar span (`chatgoose-avatar`, initials = first two chars of `formatAccountHeading(...)` uppercased); replace the trailing `info` element with a status line under the heading using session state:

```ts
const status = document.createElement('div');
status.style.fontSize = '11px';
status.style.color = 'var(--chatgoose-ink-mid)';
status.textContent = session?.connected
  ? `захвачена ${formatRelativeMinutes(session.capturedAtMs)}`
  : 'нет сессии';
```

  where `formatRelativeMinutes` is a small pure helper added to `src/options/sessions.ts` (exported, unit-testable):

```ts
export function formatRelativeMinutes(timestampMs: number | null | undefined): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return 'только что';
  const minutes = Math.max(0, Math.round((Date.now() - timestampMs) / 60_000));
  if (minutes === 0) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  return `${hours} ч назад`;
}
```

  Use whatever capture-time field `SessionSnapshotEntry` actually carries (check `src/shared/types.ts` — if only `latestTs` exists, parse that; if none is exposed, render just «захвачена» with no time — do NOT invent a timestamp).
  - When `select.value` is empty append `createBadge('AI отключён', 'amber')` to the row.
  - Add the avatar CSS to `styles.css`:

```css
.chatgoose-avatar {
  width: 28px; height: 28px; border-radius: 8px; background: var(--chatgoose-bg3);
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  font: 600 10px/1 var(--chatgoose-font); color: var(--chatgoose-ink-mid); letter-spacing: 0.06em;
}
```

- [ ] **Step 4: Run the suite; fix ONLY assertions that referenced the deleted Connection Status section**

Run: `pnpm vitest run tests/options-accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts src/options/sessions.ts src/options/styles.css tests/options-accounts.test.ts
git commit -m "feat(options): merge mappings and connection status into one Аккаунты section"
```

---

### Task 6: Agency Hub section — label rows, permission badge, collapsed legacy key, footer

**Files:**
- Modify: `src/options/index.ts` (Agency Hub section markup ONLY — every handler, save chain, permission/test function moves verbatim)
- Test: extend `tests/options-agency-hub.test.ts`

**Interfaces:**
- Consumes: `createLabelRow`, `createBadge` (Task 2); all existing hub logic (`refreshAgencyHubPermissionState`, `runAgencyHubConnectionTest`, `persistAgencyHubSettings`, sign-in flow) — unchanged signatures.
- Produces: section markup contract for P2 (which will add status rows above):

```
section[data-shell-section="hub"]
  ├─ lrow «Адрес хаба»        → agencyHubUrlInput            (unchanged element)
  ├─ lrow «Вход устройства»   → sign-in inputs/button OR signed-in block (unchanged elements)
  ├─ lrow «Доступ Firefox»    → [data-hub-permission-badge] + meta text
  ├─ details.chatgoose-hub-legacy  «Legacy chatter key» → key input + Show toggle (unchanged elements)
  └─ footer: [data-hub-test-line] + Test button
```

- [ ] **Step 1: Write failing tests** (append to `tests/options-agency-hub.test.ts`):

```ts
it('renders the hub section as labeled rows with a permission badge', async () => {
  const { document } = await mountHubPage();  // this file's existing mount helper
  const section = document.querySelector('[data-shell-section="hub"]')!;
  const labels = Array.from(section.querySelectorAll('.chatgoose-lrow-label'), (n) => n.textContent);
  expect(labels).toEqual(['Адрес хаба', 'Вход устройства', 'Доступ Firefox']);
  expect(section.querySelector('[data-hub-permission-badge]')).not.toBeNull();
});

it('legacy key lives inside a collapsed details block', async () => {
  const { document } = await mountHubPage();
  const details = document.querySelector('details.chatgoose-hub-legacy') as HTMLDetailsElement;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')?.textContent).toContain('Legacy chatter key');
  expect(details.querySelector('input[type="password"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/options-agency-hub.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Re-wrap the section.** In `index.ts`, keep every existing element variable (`agencyHubUrlInput`, `agencyHubKeyInput`, `agencyHubKeyRow`, `hubSignIn*`, `agencyHubPermission*`, `agencyHubConnection*`) and every listener registration EXACTLY as they are. Change only the final `agencyHubSection.append(...)` composition to:

```ts
const permissionBadge = createBadge('…', 'neutral');
permissionBadge.dataset.hubPermissionBadge = 'true';
const permissionRow = document.createElement('div');
permissionRow.style.display = 'flex';
permissionRow.style.gap = '8px';
permissionRow.style.alignItems = 'center';
permissionRow.append(permissionBadge, agencyHubPermissionMeta, agencyHubPermissionButton);

const legacyDetails = document.createElement('details');
legacyDetails.className = 'chatgoose-hub-legacy';
const legacySummary = document.createElement('summary');
legacySummary.textContent = 'Legacy chatter key — на период миграции';
legacyDetails.append(legacySummary, agencyHubKeyRow);

const testLine = document.createElement('div');
testLine.dataset.hubTestLine = 'true';
testLine.append(agencyHubConnectionStatus, agencyHubConnectionMeta);
const footer = document.createElement('div');
footer.className = 'chatgoose-hub-footer';
footer.append(testLine, agencyHubConnectionButton);

agencyHubSection.append(
  createLabelRow('Адрес хаба', agencyHubUrlInput),
  createLabelRow('Вход устройства', hubSignInBlock),   // wrap hubSignInRow+status+meta into one div `hubSignInBlock`
  createLabelRow('Доступ Firefox', permissionRow),
  legacyDetails,
  footer,
);
```

  Then teach `refreshAgencyHubPermissionState` to ALSO reflect into the badge (keep the existing status/meta writes so no other assertion breaks):

```ts
permissionBadge.textContent = permissionGranted ? 'разрешён' : 'не выдан';
permissionBadge.className = `chatgoose-badge chatgoose-badge-${permissionGranted ? 'green' : 'amber'}`;
permissionBadge.dataset.hubPermissionBadge = 'true';
```

  Footer CSS in `styles.css`:

```css
.chatgoose-hub-footer { display: flex; gap: 10px; align-items: center; border-top: 1px solid var(--chatgoose-line); margin-top: 6px; padding-top: 12px; }
.chatgoose-hub-footer > :first-child { flex: 1; min-width: 0; }
.chatgoose-hub-legacy > summary { cursor: pointer; font-size: 12px; color: var(--chatgoose-ink-low); }
```

- [ ] **Step 4: Run the FULL options suites** (the hub file pins save-race behavior — nothing may regress)

Run: `pnpm vitest run tests/options-agency-hub.test.ts tests/options-accounts.test.ts tests/options-persona-recovery.test.ts tests/options-shell-mount.test.ts`
Expected: PASS. If a pre-existing hub test located elements by DOM position, update selectors to the new structure — assertions about BEHAVIOR must not change.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts src/options/styles.css tests/options-agency-hub.test.ts
git commit -m "feat(options): hub section in label rows with permission badge and collapsed legacy key"
```

---

### Task 7: Theme chips, Generation grid + Advanced debug toggle

**Files:**
- Modify: `src/options/index.ts` (Appearance + Generation section markup)
- Test: `tests/options-shell-mount.test.ts` (extend)

**Interfaces:**
- Consumes: `createChipGroup`, `createToggle`, `createCap` (Task 2).
- Produces: `themeSelect` variable is now the hidden select returned by `createChipGroup` (same variable name, so the `settingsFormSignature`/listener wiring is untouched); `debugInput` is the checkbox returned by `createToggle`.

- [ ] **Step 1: Write failing tests** (append to `tests/options-shell-mount.test.ts`):

```ts
it('theme renders as chips backed by the settings value', async () => {
  const { document } = await mountOptionsPage({ state: { settings: { uiTheme: 'dark' } } });
  const chips = document.querySelectorAll('[data-shell-section="appearance"] .chatgoose-chip');
  expect(Array.from(chips, (chip) => chip.textContent)).toEqual(['Системная', 'Светлая', 'Тёмная']);
  expect(document.querySelector('.chatgoose-chip-selected')?.textContent).toBe('Тёмная');
});

it('debug mode is a family toggle inside the Advanced block', async () => {
  const { document } = await mountOptionsPage();
  const generation = document.querySelector('[data-shell-section="generation"]')!;
  expect(generation.querySelector('.chatgoose-cap')?.textContent).toBe('Advanced');
  expect(generation.querySelector('.chatgoose-toggle-row .chatgoose-toggle-label')?.textContent).toBe('Debug mode');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/options-shell-mount.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement.**
  - Appearance: replace the `<select>` construction with

```ts
const themeChips = createChipGroup(
  [
    { value: 'system', label: 'Системная' },
    { value: 'light', label: 'Светлая' },
    { value: 'dark', label: 'Тёмная' },
  ],
  state.settings.uiTheme,
);
const themeSelect = themeChips.input;  // same variable name → zero wiring changes below
appearanceSection.append(themeChips.root);
```

  (Delete the old option-building loop and `labeledField('Theme', …)`; keep `themeSelect` in the listener array and `settingsFormSignature` untouched. Retitle the section with `COPY.sections.appearanceTitle/Hint`.)
  - Generation: arrange the four count inputs in a grid and swap the debug checkbox:

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
const debugInput = debugToggle.input;  // same variable name → wiring untouched
debugInput.checked = state.settings.debugMode;
advanced.append(createCap('Advanced'), debugToggle.root);
apiSection.append(countsGrid, advanced);
```

  CSS:

```css
.chatgoose-counts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; }
.chatgoose-count-field { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12.5px; font-weight: 600; }
.chatgoose-count-field input { width: 74px; text-align: right; }
.chatgoose-advanced { border-top: 1px solid var(--chatgoose-line); margin-top: 14px; padding-top: 11px; display: grid; gap: 9px; }
@media (max-width: 640px) { .chatgoose-counts-grid { grid-template-columns: 1fr; } }
```

  (Delete the now-unused `.chatgoose-model-config-grid` CSS block and the old `labeledField(...)` count rows + `debugLabel`.)

- [ ] **Step 4: Run all options suites**

Run: `pnpm vitest run tests/ --silent 2>&1 | tail -20` (full run — count inputs are referenced by save-race tests)
Expected: PASS across the board.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts src/options/styles.css tests/options-shell-mount.test.ts
git commit -m "feat(options): theme chips and generation grid with Advanced debug toggle"
```

---

### Task 8: Wire the saved-flash into the central save controller

**Files:**
- Modify: `src/options/index.ts`
- Test: `tests/options-shell-mount.test.ts` (extend)

**Interfaces:**
- Consumes: `createSavedFlash` (Task 2); the existing `queueSettingsSave` persist path and `saveAccountMapping` handler.
- Produces: `[data-saved-flash]` element; every successful persisted write calls `savedFlash.showSaved()`, every caught save error calls `savedFlash.showError(...)` IN ADDITION to the existing `console.error` — no error handling is replaced.

- [ ] **Step 1: Write failing test:**

```ts
it('flashes Сохранено after a settings save flush', async () => {
  const { document, flushAsync } = await mountOptionsPage();
  const quick = document.querySelector('[data-shell-section="generation"] input') as HTMLInputElement;
  quick.value = '30';
  quick.dispatchEvent(new (document.defaultView as any).Event('change', { bubbles: true }));
  await flushAsync();
  const flash = document.querySelector('[data-saved-flash]') as HTMLElement;
  expect(flash.hidden).toBe(false);
  expect(flash.textContent).toBe('Сохранено ✓');
});
```

- [ ] **Step 2: Run to verify failure** — `[data-saved-flash]` not found.

- [ ] **Step 3: Implement.** In `render()`, after the shell mounts:

```ts
const savedFlash = createSavedFlash();
savedFlash.root.dataset.savedFlash = 'true';
root.append(savedFlash.root);
```

  In `queueSettingsSave`'s `persist` function, after `state.settings = mergedSettings;` (the success point) add `savedFlash.showSaved();`; in its `.catch` add `savedFlash.showError('настройки не сохранились — повтори');` beside the existing `console.error`. Same pattern in the personalities-era mapping handler: `saveAccountMapping` success → `showSaved()`, catch → `showError('маппинг не сохранился')`. Do NOT touch the pagehide path (no UI exists during unload).

- [ ] **Step 4: Run**

Run: `pnpm vitest run tests/options-shell-mount.test.ts tests/options-agency-hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts tests/options-shell-mount.test.ts
git commit -m "feat(options): saved-flash wired to the central save controller"
```

---

### Task 9: Persona section + recovery page — Russian copy pass (presentation minimum for P1)

**Files:**
- Modify: `src/options/index.ts` (strings only in the personas section, recovery hero, empty states, loading strings)
- Test: `tests/options-persona-recovery.test.ts` (update pinned strings)

**Interfaces:**
- Consumes: `COPY` (Task 4).
- Produces: nothing new — P3 does the catalog-row visual; P1 only retitles: section title `COPY.sections.personasTitle`, hint `COPY.sections.personasHint`; empty state «Персон на сервере ещё нет — проверь подключение к Hub или попроси владельца создать голос.»; preservation note «Легаси-тексты персон сохранены на этом устройстве без изменений. Экспортируй их перед удалением расширения или очисткой браузера.»; loading strings «Загружаю аккаунты Fansly…» / «Загружаю статус подключения…».

- [ ] **Step 1: Update the pinned strings in `tests/options-persona-recovery.test.ts`** to the Russian texts above (this is the failing-test step: change assertions first).
- [ ] **Step 2: Run to verify failure** — old English strings still render.
- [ ] **Step 3: Swap the literals in `index.ts`** (section title/hint, empty state, preservation note, loading placeholders). The recovery page (`renderLegacyPersonaRecovery`) copy: title «Восстановление персон», body «Сохранённый снапшот легаси-персон повреждён. Обычные настройки и Agency Hub отключены, чтобы снапшот нельзя было перезаписать.», section title «Экспорт легаси-персон». Recovery page logic and export controls untouched.
- [ ] **Step 4: Run** `pnpm vitest run tests/options-persona-recovery.test.ts` — PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(options): Russian copy for personas, recovery, and loading states"`

---

### Task 10: Local fonts — bundle woff2, drop the Google CDN from all extension pages

**Files:**
- Create: `assets/fonts/` — `hanken-grotesk-latin-400.woff2`, `-500.woff2`, `-600.woff2`, `-700.woff2`; `source-serif-4-latin-600.woff2`, `source-serif-4-cyrillic-600.woff2`; `ibm-plex-mono-latin-400.woff2`, `-500.woff2`, `ibm-plex-mono-cyrillic-400.woff2`
- Modify: `src/options/index.html`, `src/popup/index.html`, `src/debug-prompt/index.html` (if it has the links), `src/options/styles.css`, `src/popup/styles.css` (same @font-face block), `esbuild.config.mjs`
- Test: `tests/local-fonts.test.ts` (create)

**Interfaces:**
- Produces: `dist/fonts/*.woff2`; `@font-face` sources as `url('fonts/<file>.woff2')` — relative to the page URL, valid because the injected `<style>` lives in `dist/options.html`/`dist/popup.html`.

Font sourcing note: download each family's woff2 subsets via google-webfonts-helper (`https://gwfh.mranftl.com/fonts`) — latin subsets for Hanken Grotesk (it has NO Cyrillic; Russian text falls back to the system sans exactly as it does today with the CDN), latin+cyrillic for Source Serif 4 (600) and IBM Plex Mono (400/500). Commit the binaries.

- [ ] **Step 1: Write the failing static test** `tests/local-fonts.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const PAGES = ['src/options/index.html', 'src/popup/index.html', 'src/debug-prompt/index.html'];

describe('local fonts', () => {
  it('no extension page references an external font host', () => {
    for (const page of PAGES) {
      const html = readFileSync(path.join(root, page), 'utf8');
      expect(html, page).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
  });

  it('bundled font files exist and are declared via @font-face', () => {
    const fonts = readdirSync(path.join(root, 'assets/fonts')).filter((f) => f.endsWith('.woff2'));
    expect(fonts.length).toBeGreaterThanOrEqual(8);
    const css = readFileSync(path.join(root, 'src/options/styles.css'), 'utf8');
    for (const family of ['Hanken Grotesk', 'Source Serif 4', 'IBM Plex Mono']) {
      expect(css).toContain(`font-family: '${family}'`);
    }
    expect(css).toMatch(/url\('fonts\//);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `assets/fonts` missing, googleapis links present.
- [ ] **Step 3: Implement.**
  - Download and commit the woff2 files listed above into `assets/fonts/`.
  - Remove the `<link rel="preconnect">` and Google `<link rel="stylesheet">` lines from every page in `PAGES` (check debug-prompt first; if it never had them, drop it from nothing).
  - Prepend to `src/options/styles.css` AND `src/popup/styles.css` (each page injects its own css text):

```css
@font-face { font-family: 'Hanken Grotesk'; font-style: normal; font-weight: 400; font-display: swap; src: url('fonts/hanken-grotesk-latin-400.woff2') format('woff2'); }
@font-face { font-family: 'Hanken Grotesk'; font-style: normal; font-weight: 500; font-display: swap; src: url('fonts/hanken-grotesk-latin-500.woff2') format('woff2'); }
@font-face { font-family: 'Hanken Grotesk'; font-style: normal; font-weight: 600; font-display: swap; src: url('fonts/hanken-grotesk-latin-600.woff2') format('woff2'); }
@font-face { font-family: 'Hanken Grotesk'; font-style: normal; font-weight: 700; font-display: swap; src: url('fonts/hanken-grotesk-latin-700.woff2') format('woff2'); }
@font-face { font-family: 'Source Serif 4'; font-style: normal; font-weight: 600; font-display: swap; src: url('fonts/source-serif-4-latin-600.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F; }
@font-face { font-family: 'Source Serif 4'; font-style: normal; font-weight: 600; font-display: swap; src: url('fonts/source-serif-4-cyrillic-600.woff2') format('woff2'); unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
@font-face { font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 400; font-display: swap; src: url('fonts/ibm-plex-mono-latin-400.woff2') format('woff2'); unicode-range: U+0000-00FF; }
@font-face { font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 400; font-display: swap; src: url('fonts/ibm-plex-mono-cyrillic-400.woff2') format('woff2'); unicode-range: U+0400-045F; }
@font-face { font-family: 'IBM Plex Mono'; font-style: normal; font-weight: 500; font-display: swap; src: url('fonts/ibm-plex-mono-latin-500.woff2') format('woff2'); unicode-range: U+0000-00FF; }
```

  - In `esbuild.config.mjs` `ensureStaticFiles()` add:

```js
await cp(path.join(root, 'assets/fonts'), path.join(outdir, 'fonts'), { recursive: true });
```

- [ ] **Step 4: Run tests + build**

Run: `pnpm vitest run tests/local-fonts.test.ts && pnpm build && ls dist/fonts`
Expected: tests PASS; `dist/fonts` lists the woff2 files.

- [ ] **Step 5: Manual verify** — `about:debugging` → Load Temporary Add-on → `dist/manifest.json`; open the options page; in DevTools Network confirm zero requests to `fonts.googleapis.com`/`gstatic.com` and that serif headings render as Source Serif 4 (fonts panel).

- [ ] **Step 6: Commit**

```bash
git add assets/fonts src/options/index.html src/popup/index.html src/debug-prompt/index.html src/options/styles.css src/popup/styles.css esbuild.config.mjs tests/local-fonts.test.ts
git commit -m "feat: bundle family fonts locally, drop Google Fonts CDN from extension pages"
```

---

### Task 11: Decision log entry + full check + finish

**Files:**
- Modify: `docs/decisions.md` (table row + entry)
- Test: `pnpm check`

- [ ] **Step 1: Append the decision entry** (next free number after the current last one — verify in the file; the text):

```markdown
**E<N> (2026-07-<DD>).** Options P1 shell redesign: the settings page adopts
the desktop SettingsSurface shape (sticky nav + scrollspy + section cards)
and the family control vocabulary (badge/toggle/chips/cap/num, saved-flash
autosave feedback), merges Account Mappings + Connection Status into one
«Аккаунты» section, collapses the legacy chatter key behind <details>,
moves all UI copy to Russian with English terms, and bundles the family
fonts locally (Google Fonts CDN removed from every extension page). Zero
behavior change: the single central write controller, custody discipline
(E19), persona preservation/recovery (E36/E37) and the future-schema
barrier move verbatim; storage schema stays v14. Spec:
docs/superpowers/specs/2026-07-16-options-redesign-design.md (P1).
```

  Add the matching one-line row to the summary table at the top.

- [ ] **Step 2: Full check**

Run: `pnpm check`
Expected: typecheck + lint + gates + tests + build all green.

- [ ] **Step 3: Manual walkthrough** (fresh temporary profile): load `dist/`, open Settings — nav scrolls and highlights; theme chips switch light/dark instantly; a count edit flashes «Сохранено ✓»; hub rows render; legacy key opens on click; dark theme via chips renders every new component correctly (variable swap only).

- [ ] **Step 4: Commit + push + Draft PR + toolkit review** (repo flow):

```bash
git add docs/decisions.md
git commit -m "docs: record options P1 shell redesign decision"
git push -u origin ai/<task-id>-options-redesign-p1
gh pr create --draft --title "Options P1: desktop-parity shell, Russian copy, local fonts" --body "Spec: docs/superpowers/specs/2026-07-16-options-redesign-design.md (P1). No behavior change; no schema change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
~/code/agentic-control-plane/bin/agent review chatgoose --pr <N>
```

---

## Self-Review Notes

- **Spec coverage (P1 slice):** shell+nav+scrollspy (T3/T4), primitives (T2), RU copy (T4/T9), autosave flash (T8), «Аккаунты» merge (T5), legacy-key collapse (T6), theme chips + generation grid (T7), local fonts for all pages (T10), decision entry (T11). Deliberately NOT here (later plans): Статус section, readiness hero, per-page quota, spenders tracker, health/me calls, Changelog button (P2); persona catalog rows, sign-out (P3); changelog.html (parallel track).
- **Type consistency:** `createChipGroup(...).input` is an `HTMLSelectElement` named `themeSelect` at the call site; `createToggle(...).input` is an `HTMLInputElement` named `debugInput` — both preserve the existing listener array types in `index.ts`.
- **Known judgment calls baked in:** the hidden-select chip pattern and hidden-checkbox toggle pattern exist precisely so the save controller wiring (`settingsFormSignature`, listener array, custody dirty-tracking) is not edited at all; if an implementer finds themselves editing `queueSettingsSave` beyond the two flash hooks of T8, they have left the plan.
