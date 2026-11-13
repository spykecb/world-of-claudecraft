import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setArrivalCover } from '../src/render/arrival_cover';
import {
  armLinkPacing,
  LINK_SLOT_FALLBACK_MS,
  LINK_SLOT_PASS_BUDGET_MS,
  linkFrameUsed,
  linkPacingActive,
  linkPacingStats,
  linkSlot,
  noteLink,
  passLinkSlot,
  resetLinkPacingForTests,
  setLinkPacingEnabled,
} from '../src/render/link_slot_pacer';

let rafQueue: Array<() => void> = [];
const frame = async (): Promise<void> => {
  const run = rafQueue;
  rafQueue = [];
  for (const cb of run) cb();
  // the release task the pacer posts after the frame's callbacks
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
};
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  resetLinkPacingForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetLinkPacingForTests();
});

function arm(): void {
  setLinkPacingEnabled(true);
  armLinkPacing();
}

describe('link slot pacer', () => {
  it('is inactive until enabled AND armed at the first reveal', async () => {
    setLinkPacingEnabled(true);
    expect(linkPacingActive()).toBe(false);
    // unarmed (the loading screen): a link uses nothing and a slot is free at once
    noteLink();
    expect(linkFrameUsed()).toBe(false);
    let got = false;
    await linkSlot().then(() => {
      got = true;
    });
    expect(got).toBe(true);
    armLinkPacing();
    expect(linkPacingActive()).toBe(true);
  });

  it('a link uses the frame up; the next frame releases one waiter', async () => {
    arm();
    noteLink();
    expect(linkFrameUsed()).toBe(true);
    const order: number[] = [];
    for (let i = 0; i < 3; i++) void linkSlot().then(() => order.push(i));
    await flushMicrotasks();
    expect(order).toEqual([]);
    await frame();
    expect(order).toEqual([0]);
    // the released caller holds the frame until it reports, and two still wait
    expect(linkFrameUsed()).toBe(true);
    expect(linkPacingStats().waiting).toBe(2);
  });

  it('a released caller that linked nothing passes the frame on at once', async () => {
    arm();
    noteLink();
    const order: number[] = [];
    void linkSlot().then(() => {
      order.push(0);
      passLinkSlot(); // its compile was a cache hit
    });
    void linkSlot().then(() => {
      order.push(1);
      noteLink(); // this one linked
    });
    void linkSlot().then(() => order.push(2));
    await frame();
    await flushMicrotasks();
    expect(order).toEqual([0, 1]);
    await frame();
    expect(order).toEqual([0, 1, 2]);
  });

  it('runs no frame loop when nothing linked and nobody waits', async () => {
    arm();
    expect(rafQueue.length).toBe(0);
    noteLink();
    expect(rafQueue.length).toBe(1);
    await frame();
    expect(rafQueue.length).toBe(0);
    expect(linkFrameUsed()).toBe(false);
  });

  it('stands down under an arrival cover and releases everyone waiting', async () => {
    arm();
    noteLink();
    const done: number[] = [];
    for (let i = 0; i < 3; i++) void linkSlot().then(() => done.push(i));
    setArrivalCover(true);
    try {
      expect(linkPacingActive()).toBe(false);
      expect(linkFrameUsed()).toBe(false);
      await frame();
      expect(done).toEqual([0, 1, 2]);
    } finally {
      setArrivalCover(false);
    }
  });

  it('disabling releases every waiter', async () => {
    arm();
    noteLink();
    let got = false;
    void linkSlot().then(() => {
      got = true;
    });
    setLinkPacingEnabled(false);
    await flushMicrotasks();
    expect(got).toBe(true);
    expect(linkPacingStats().waits).toBe(1);
  });

  it('a waiting gate goes before every waiting bulk caller', async () => {
    arm();
    noteLink();
    const order: string[] = [];
    void linkSlot('bulk').then(() => {
      order.push('bulk');
      noteLink();
    });
    void linkSlot('gate').then(() => {
      order.push('gate');
      noteLink();
    });
    await frame();
    expect(order).toEqual(['gate']);
    await frame();
    expect(order).toEqual(['gate', 'bulk']);
  });

  it('a link of N programs keeps the next caller back N frames', async () => {
    arm();
    noteLink(3);
    let got = false;
    void linkSlot().then(() => {
      got = true;
    });
    await frame();
    await frame();
    expect(got).toBe(false);
    await frame();
    expect(got).toBe(true);
  });

  it('a released caller holds the frame: a fresh caller cannot slip in first', async () => {
    arm();
    noteLink();
    void linkSlot();
    await frame(); // released, has not reported yet
    expect(linkFrameUsed()).toBe(true);
    passLinkSlot();
    expect(linkFrameUsed()).toBe(false);
  });

  it('drains from a timer when animation frames stop (a hidden tab)', async () => {
    arm();
    noteLink();
    let got = false;
    void linkSlot().then(() => {
      got = true;
    });
    // no frame() call: rAF never fires
    await vi.advanceTimersByTimeAsync(LINK_SLOT_FALLBACK_MS + 1);
    expect(got).toBe(true);
  });

  it('enabling again (a new renderer) disarms: its loading screen runs unpaced', () => {
    arm();
    expect(linkPacingActive()).toBe(true);
    setLinkPacingEnabled(true);
    expect(linkPacingActive()).toBe(false);
  });

  it('releases a waiter in a task AFTER the frame callbacks, not inside them', async () => {
    arm();
    noteLink();
    let got = false;
    void linkSlot().then(() => {
      got = true;
    });
    const run = rafQueue;
    rafQueue = [];
    for (const cb of run) cb();
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toBe(false); // still inside the frame: the draws go first
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toBe(true);
  });

  it('a long run of cache hits in one release task yields to the next frame', async () => {
    arm();
    noteLink();
    let now = 0;
    vi.stubGlobal('performance', { now: () => now });
    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      void linkSlot().then(() => {
        order.push(i);
        now += LINK_SLOT_PASS_BUDGET_MS + 1; // each hit costs past the budget
        passLinkSlot();
      });
    }
    await frame();
    await Promise.resolve();
    expect(order).toEqual([0]);
    await frame();
    await Promise.resolve();
    expect(order).toEqual([0, 1]);
  });
});
