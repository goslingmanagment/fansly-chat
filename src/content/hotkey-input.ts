// The one hotkey engine of the tab.
//
// The bootstrap (content.js) and the conversation app (content-chat.js) are
// separate bundles, and the app takes over the keydown listener when it starts.
// The engine is stateful — the fresh-press roll-over guard remembers when ⌘/Ctrl
// went down — so both bundles must feed the SAME instance: it lives in a
// realm-global slot, created by whichever bundle asks first, together with the
// keyup / blur / visibility listeners that keep its state honest.

import { createHotkeyEngine, type HotkeyEngine } from '@chatgoose/hotkeys';

import {
  EXTENSION_ACTION,
  detectLabelPlatform,
  type HotkeyAction,
} from '../shared/hotkeys.js';

const ENGINE_SLOT = Symbol.for('chatgoose.hotkeys.engine');

type EngineHost = Record<symbol, HotkeyEngine | undefined>;

export function sharedHotkeyEngine(): HotkeyEngine {
  const host = globalThis as unknown as EngineHost;
  const existing = host[ENGINE_SLOT];
  if (existing) {
    return existing;
  }
  const engine = createHotkeyEngine({ platform: detectLabelPlatform(), client: 'extension' });
  host[ENGINE_SLOT] = engine;
  // Capture on window: the page's own handlers cannot hide a keyup from us.
  window.addEventListener('keyup', (event) => engine.keyup(event), true);
  window.addEventListener('blur', () => engine.reset());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      engine.reset();
    }
  });
  return engine;
}

/**
 * - `action`: run it, unless `repeat` — then only claim the key (auto-repeat
 *   never starts a second run).
 * - `swallow`: a ChatGoose combo that must do nothing now (a retired ⌘⇧D/⌘⇧F
 *   habit, a roll-over after an input-language switch). Claimed only inside
 *   the ChatGoose context, so outside it the browser keeps its own shortcut.
 */
export type ExtensionHotkeyDecision =
  | { kind: 'action'; action: HotkeyAction; repeat: boolean }
  | { kind: 'swallow' };

/** Feed one keydown to the shared engine and translate the verdict. EVERY
 * keydown must pass through here (modifiers included) — the roll-over guard
 * needs to see ⌘/Ctrl go down. `?` (outside text inputs) is the cheatsheet. */
export function resolveHotkeyKeydown(
  event: KeyboardEvent,
  inEditable: boolean,
  engine: HotkeyEngine = sharedHotkeyEngine(),
): ExtensionHotkeyDecision | null {
  const decision = engine.keydown(event);
  if (decision) {
    return decision.kind === 'swallow'
      ? { kind: 'swallow' }
      : { kind: 'action', action: EXTENSION_ACTION[decision.action], repeat: decision.repeat };
  }
  if (
    !inEditable &&
    event.key === '?' &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    return { kind: 'action', action: 'cheatsheet', repeat: event.repeat };
  }
  return null;
}

/** Spenders and the cheatsheet work on every Fansly page; the rest only in a chat. */
export function isGlobalHotkeyAction(action: HotkeyAction): boolean {
  return action === 'spenders-board' || action === 'cheatsheet';
}
