import { describe, expect, it, vi } from 'vitest';
import { createMessageSoundPlayer } from '../src/background/message-sound-player.js';
import { MESSAGE_SOUND_TONES } from '../src/shared/message-sound-protocol.js';
import { scheduleTone, TONE_NOTES, type AudioContextLike } from '../src/shared/sound-synth.js';

interface Recorded {
  wave: string;
  frequency: Array<[string, number, number]>;
  gain: Array<[string, number, number]>;
  start: number;
  stop: number;
}

function fakeContext(currentTime = 1) {
  const notes: Recorded[] = [];
  const destination = {} as AudioNode;
  const context: AudioContextLike = {
    currentTime,
    destination,
    createOscillator: () => {
      const note: Recorded = { wave: '', frequency: [], gain: [], start: -1, stop: -1 };
      notes.push(note);
      const oscillator = {
        set type(value: string) {
          note.wave = value;
        },
        frequency: {
          setValueAtTime: (value: number, at: number) => note.frequency.push(['set', value, at]),
          exponentialRampToValueAtTime: (value: number, at: number) => note.frequency.push(['ramp', value, at]),
        },
        connect: () => ({ connect: () => undefined }),
        start: (at: number) => {
          note.start = at;
        },
        stop: (at?: number) => {
          if (at !== undefined) note.stop = at;
        },
      };
      return oscillator as unknown as OscillatorNode;
    },
    createGain: () => {
      // scheduleTone creates each note's gain right after its oscillator.
      const gainNode: { __note?: Recorded; gain: unknown } = {
        __note: notes.at(-1),
        gain: {
          setValueAtTime: (value: number, at: number) => gainNode.__note?.gain.push(['set', value, at]),
          exponentialRampToValueAtTime: (value: number, at: number) => gainNode.__note?.gain.push(['ramp', value, at]),
        },
      };
      return gainNode as unknown as GainNode;
    },
  };
  return { context, notes };
}

describe('scheduleTone (E145)', () => {
  it('reproduces the desktop blip note for note at 0.06', () => {
    // onlyfans-chat apps/desktop/src/renderer/src/lib/sound.ts:19-31
    const { context, notes } = fakeContext(1);
    scheduleTone(context, 'blip', 0.06);
    expect(notes).toHaveLength(1);
    const [note] = notes;
    expect(note!.wave).toBe('sine');
    expect(note!.frequency).toEqual([['set', 880, 1], ['ramp', 1320, 1.08]]);
    expect(note!.gain[0]).toEqual(['set', 0.0001, 1]);
    expect(note!.gain[1]![0]).toBe('ramp');
    expect(note!.gain[1]![1]).toBeCloseTo(0.06, 10);
    expect(note!.gain[1]![2]).toBeCloseTo(1.02, 10);
    expect(note!.gain[2]![1]).toBe(0.0001);
    expect(note!.gain[2]![2]).toBeCloseTo(1.18, 10);
    expect(note!.start).toBe(1);
    expect(note!.stop).toBeCloseTo(1.2, 10);
  });

  it('plays two notes for the double tone and a triangle for the soft one', () => {
    const double = fakeContext(0);
    scheduleTone(double.context, 'double', 0.1);
    expect(double.notes.map((note) => note.start)).toEqual([0, 0.13]);
    const soft = fakeContext(0);
    scheduleTone(soft.context, 'soft', 0.1);
    expect(soft.notes[0]!.wave).toBe('triangle');
    expect(Object.keys(TONE_NOTES).sort()).toEqual([...MESSAGE_SOUND_TONES].sort());
  });

  it('E146: schedules every one of the eight tones, all short, none a copy of the desktop blip', () => {
    expect(MESSAGE_SOUND_TONES).toHaveLength(8);
    const blip = JSON.stringify(TONE_NOTES.blip);
    for (const tone of MESSAGE_SOUND_TONES) {
      const { context, notes } = fakeContext(0);
      scheduleTone(context, tone, 0.06);
      expect(notes.length, tone).toBeGreaterThan(0);
      expect(Math.max(...notes.map((note) => note.stop)), tone).toBeLessThanOrEqual(0.8);
      if (tone !== 'blip') expect(JSON.stringify(TONE_NOTES[tone]), tone).not.toBe(blip);
    }
  });
});

describe('createMessageSoundPlayer (E145)', () => {
  function managedContext(state: string, resume: () => Promise<void>) {
    const { context } = fakeContext(0);
    const managed = {
      ...context,
      createOscillator: context.createOscillator,
      createGain: context.createGain,
      state,
      resume: vi.fn(async () => {
        await resume();
        managed.state = 'running';
      }),
    };
    return managed;
  }

  it('resumes a suspended context before playing', async () => {
    const managed = managedContext('suspended', async () => undefined);
    const player = createMessageSoundPlayer(() => managed);
    expect(await player.prepare()).toBe(true);
    expect(managed.resume).toHaveBeenCalledTimes(1);
    expect(() => player.start('blip', 50)).not.toThrow();
    expect(player.diagnostics()).toEqual({ state: 'running', lastError: null });
  });

  it('reports a context that refuses to run instead of hanging', async () => {
    const managed = managedContext('suspended', async () => {
      throw new Error('NotAllowedError');
    });
    const player = createMessageSoundPlayer(() => managed);
    expect(await player.prepare()).toBe(false);
    expect(player.diagnostics().lastError).toContain('NotAllowedError');
  });

  it('refuses to start before it is prepared', () => {
    const player = createMessageSoundPlayer(() => managedContext('running', async () => undefined));
    expect(() => player.start('blip', 50)).toThrow();
  });
});
