import { beforeEach, describe, expect, it } from 'vitest';
import {
  awaitLinkFence,
  GL_SIGNALED,
  GL_SYNC_STATUS,
  LINK_FENCE_MAX_MS,
  LINK_FENCE_POLL_MS,
  type LinkFenceGl,
  type LinkFenceScheduler,
  linkFenceStats,
  resetLinkFenceStatsForTests,
} from '../src/render/link_fence_proof';

/** A manual clock: `advance` runs every timer due by then, in order. */
function clock() {
  let now = 0;
  let timers: Array<{ at: number; cb: () => void }> = [];
  const scheduler: LinkFenceScheduler = {
    setTimeout: (cb, ms) => {
      timers.push({ at: now + ms, cb });
    },
    now: () => now,
  };
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers = timers.slice(1);
      now = next.at;
      next.cb();
      await Promise.resolve();
    }
    now = end;
    await Promise.resolve();
  };
  return { scheduler, advance };
}

/** A fence context: `signal()` flips every live fence; calls are logged. */
function fenceGl() {
  const log: string[] = [];
  let signalled = false;
  let lost = false;
  const gl: LinkFenceGl = {
    fenceSync: () => {
      log.push('fence');
      return { id: 1 };
    },
    getSyncParameter: (_sync, pname) => {
      log.push('status');
      expect(pname).toBe(GL_SYNC_STATUS);
      return signalled ? GL_SIGNALED : 0x9118;
    },
    deleteSync: () => {
      log.push('delete');
    },
    flush: () => {
      log.push('flush');
    },
    isContextLost: () => lost,
  };
  return {
    gl,
    log,
    signal: () => {
      signalled = true;
    },
    lose: () => {
      lost = true;
    },
  };
}

beforeEach(() => resetLinkFenceStatsForTests());

describe('link fence proof', () => {
  it('resolves proved only once the fence signals, and frees it', async () => {
    const c = clock();
    const f = fenceGl();
    let result: { proved: boolean; waitedMs: number } | null = null;
    void awaitLinkFence(f.gl, c.scheduler).then((r) => {
      result = r;
    });
    // issued and flushed synchronously, right behind the compile
    expect(f.log).toEqual(['fence', 'flush']);
    await c.advance(LINK_FENCE_POLL_MS * 5);
    expect(result).toBeNull();
    f.signal();
    await c.advance(LINK_FENCE_POLL_MS);
    expect(result).toEqual({ proved: true, waitedMs: LINK_FENCE_POLL_MS * 6 });
    expect(f.log.at(-1)).toBe('delete');
    expect(linkFenceStats()).toMatchObject({ fences: 1, proved: 1, unproved: 0 });
  });

  it('never polls synchronously: the first status read waits a timer', async () => {
    const c = clock();
    const f = fenceGl();
    f.signal();
    void awaitLinkFence(f.gl, c.scheduler);
    expect(f.log).not.toContain('status');
    await c.advance(LINK_FENCE_POLL_MS);
    expect(f.log).toContain('status');
  });

  it('gives up unproved past the cap instead of parking forever', async () => {
    const c = clock();
    const f = fenceGl();
    let result: { proved: boolean } | null = null;
    void awaitLinkFence(f.gl, c.scheduler).then((r) => {
      result = r;
    });
    await c.advance(LINK_FENCE_MAX_MS - LINK_FENCE_POLL_MS);
    expect(result).toBeNull();
    await c.advance(LINK_FENCE_POLL_MS * 2);
    expect(result).toMatchObject({ proved: false });
    expect(f.log.at(-1)).toBe('delete');
    expect(linkFenceStats().unproved).toBe(1);
  });

  it('resolves unproved at once without fences (WebGL1, a stub)', async () => {
    await expect(awaitLinkFence({}, clock().scheduler)).resolves.toEqual({
      proved: false,
      waitedMs: 0,
    });
    await expect(awaitLinkFence(null, clock().scheduler)).resolves.toMatchObject({ proved: false });
    expect(linkFenceStats().fences).toBe(0);
  });

  it('a context lost while waiting resolves unproved', async () => {
    const c = clock();
    const f = fenceGl();
    let result: { proved: boolean } | null = null;
    void awaitLinkFence(f.gl, c.scheduler).then((r) => {
      result = r;
    });
    f.lose();
    await c.advance(LINK_FENCE_POLL_MS);
    expect(result).toMatchObject({ proved: false });
  });
});
