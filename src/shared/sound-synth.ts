// E145: synthesized notification sounds — no audio files, no network.
// `blip` at gain 0.06 is the OnlyFans desktop app's `playNotificationBlip`, note for
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
  // E146: Fansly's own sounds — none of them shares the desktop blip's glide.
  /** Two bright notes a sixth apart (C6 → A6), the second ringing longer. */
  chime: [
    { wave: 'sine', offset: 0, startHz: 1047, endHz: 1047, glide: 0, attack: 0.01, release: 0.16, stop: 0.18 },
    { wave: 'sine', offset: 0.11, startHz: 1760, endHz: 1760, glide: 0, attack: 0.01, release: 0.3, stop: 0.32 },
  ],
  /** A falling water drop. */
  drop: [
    { wave: 'sine', offset: 0, startHz: 1400, endHz: 520, glide: 0.1, attack: 0.005, release: 0.16, stop: 0.18 },
  ],
  /** One high bell with a long tail. */
  bell: [
    { wave: 'sine', offset: 0, startHz: 1568, endHz: 1568, glide: 0, attack: 0.005, release: 0.7, stop: 0.72 },
    { wave: 'sine', offset: 0, startHz: 3136, endHz: 3136, glide: 0, attack: 0.005, release: 0.25, stop: 0.27 },
  ],
  /** A quick rising major arpeggio (A5 · C♯6 · E6). */
  arpeggio: [
    { wave: 'triangle', offset: 0, startHz: 880, endHz: 880, glide: 0, attack: 0.008, release: 0.07, stop: 0.08 },
    { wave: 'triangle', offset: 0.07, startHz: 1109, endHz: 1109, glide: 0, attack: 0.008, release: 0.07, stop: 0.08 },
    { wave: 'triangle', offset: 0.14, startHz: 1319, endHz: 1319, glide: 0, attack: 0.008, release: 0.16, stop: 0.18 },
  ],
  /** Two soft low knocks. */
  knock: [
    { wave: 'triangle', offset: 0, startHz: 330, endHz: 220, glide: 0.05, attack: 0.004, release: 0.08, stop: 0.09 },
    { wave: 'triangle', offset: 0.14, startHz: 330, endHz: 220, glide: 0.05, attack: 0.004, release: 0.08, stop: 0.09 },
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
