// E145: synthesized notification sounds — no audio files, no network.
// `blip` at gain 0.06 is the desktop app's `playNotificationBlip` note for
// note (onlyfans-chat apps/desktop/src/renderer/src/lib/sound.ts).

import type { MessageSoundTone } from './message-sound-protocol.js';

export interface ToneNote {
  wave: OscillatorType;
  /** Seconds after the tone starts. */
  offset: number;
  startHz: number;
  endHz: number;
  /** Seconds (from the note's start) for the pitch glide; 0 = steady. */
  glide: number;
  attack: number;
  /** Seconds (from the note's start) where the gain is back at the floor. */
  release: number;
  stop: number;
}

const GAIN_FLOOR = 0.0001;

export const TONE_NOTES: Readonly<Record<MessageSoundTone, readonly ToneNote[]>> = {
  blip: [
    { wave: 'sine', offset: 0, startHz: 880, endHz: 1320, glide: 0.08, attack: 0.02, release: 0.18, stop: 0.2 },
  ],
  double: [
    { wave: 'sine', offset: 0, startHz: 1320, endHz: 1320, glide: 0, attack: 0.01, release: 0.06, stop: 0.07 },
    { wave: 'sine', offset: 0.13, startHz: 1320, endHz: 1320, glide: 0, attack: 0.01, release: 0.06, stop: 0.07 },
  ],
  soft: [
    { wave: 'triangle', offset: 0, startHz: 660, endHz: 990, glide: 0.12, attack: 0.03, release: 0.35, stop: 0.37 },
  ],
};

/** The slice of Web Audio a tone needs — a fake in tests. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNode;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
}

export interface PlayingTone {
  stop(): void;
}

/** Schedule every note of `tone` at `peakGain`, starting now. Throws if the
 * context refuses a node — the caller reports that as an audio error. */
export function scheduleTone(
  context: AudioContextLike,
  tone: MessageSoundTone,
  peakGain: number,
): PlayingTone {
  const oscillators: OscillatorNode[] = [];
  const t0 = context.currentTime;
  for (const note of TONE_NOTES[tone]) {
    const start = t0 + note.offset;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = note.wave;
    oscillator.frequency.setValueAtTime(note.startHz, start);
    if (note.glide > 0 && note.endHz !== note.startHz) {
      oscillator.frequency.exponentialRampToValueAtTime(note.endHz, start + note.glide);
    }
    gain.gain.setValueAtTime(GAIN_FLOOR, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(GAIN_FLOOR, peakGain), start + note.attack);
    gain.gain.exponentialRampToValueAtTime(GAIN_FLOOR, start + note.release);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + note.stop);
    oscillators.push(oscillator);
  }
  return {
    stop: () => {
      for (const oscillator of oscillators) {
        try {
          oscillator.stop();
        } catch {
          // already stopped
        }
      }
    },
  };
}
