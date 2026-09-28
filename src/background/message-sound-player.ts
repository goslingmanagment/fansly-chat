// E145: the background page's one AudioContext. Firefox blocks audible
// autoplay in a tab until the chatter interacts with it
// (`media.autoplay.default = 1`) but exempts extension background pages
// (`media.autoplay.allow-extension-background-pages = true`), so the sound is
// played here, never in the Fansly tab.

import type { MessageSoundTone } from '../shared/message-sound-protocol.js';
import { volumeToGain } from '../shared/message-sound.js';
import { scheduleTone, type AudioContextLike, type PlayingTone } from '../shared/sound-synth.js';

const RESUME_TIMEOUT_MS = 1_500;

interface ManagedAudioContext extends AudioContextLike {
  readonly state: string;
  resume(): Promise<void>;
}

export interface MessageSoundPlayer {
  /** Resume (or recreate) the context; false when audio is unavailable. */
  prepare(): Promise<boolean>;
  /** Synchronous: schedules the tone on a prepared context. Throws on failure. */
  start(tone: MessageSoundTone, volume: number): PlayingTone;
  diagnostics(): { state: string | null; lastError: string | null };
}

export function createMessageSoundPlayer(
  createContext: () => ManagedAudioContext = () => new AudioContext() as unknown as ManagedAudioContext,
): MessageSoundPlayer {
  let context: ManagedAudioContext | null = null;
  let lastError: string | null = null;
  const remember = (error: unknown): void => {
    lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  };

  return {
    async prepare() {
      try {
        if (context === null || context.state === 'closed') context = createContext();
        if (context.state !== 'running') {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            context.resume(),
            new Promise<void>((_, reject) => {
              timer = setTimeout(() => reject(new Error('AudioContext.resume timed out')), RESUME_TIMEOUT_MS);
            }),
          ]).finally(() => clearTimeout(timer));
        }
        if (context.state !== 'running') {
          throw new Error(`AudioContext is ${context.state}`);
        }
        return true;
      } catch (error) {
        remember(error);
        return false;
      }
    },
    start(tone, volume) {
      if (context === null) throw new Error('AudioContext is not prepared');
      try {
        return scheduleTone(context, tone, volumeToGain(volume));
      } catch (error) {
        remember(error);
        throw error;
      }
    },
    diagnostics() {
      return { state: context?.state ?? null, lastError };
    },
  };
}
