import { describe, expect, it } from 'vitest';
import { type LinkLane, type PacedLinkHost, pacedCompile } from '../src/render/paced_link_core';

/** A fake frame rule: a link of N programs uses N frames up, `slot` waits
 *  until they pass, and lanes and `passSlot` calls are recorded. */
function fakeHost(opts: { paced?: () => boolean } = {}) {
  let frame = 0;
  let debt = 0;
  let passes = 0;
  const lanes: LinkLane[] = [];
  const host: PacedLinkHost = {
    paced: opts.paced ?? (() => true),
    frameUsed: () => debt > 0,
    slot: async (lane) => {
      lanes.push(lane);
      while (debt > 0) {
        frame++;
        debt--;
      }
    },
    noteLink: (programs) => {
      debt = programs;
    },
    passSlot: () => {
      passes++;
    },
  };
  return { host, frame: () => frame, passes: () => passes, lanes };
}

/** Run compiles that create `programs[i]` each, logging `i@frame`. */
async function run(host: PacedLinkHost, frame: () => number, programs: number[]) {
  const log: string[] = [];
  for (const [i, created] of programs.entries()) {
    await pacedCompile(host, () => {
      log.push(`${i}@${frame()}`);
      return { value: i, created };
    });
  }
  return log;
}

describe('paced link core', () => {
  it('at most one compile that creates programs per frame', async () => {
    const f = fakeHost();
    expect(await run(f.host, f.frame, [1, 1, 1])).toEqual(['0@0', '1@1', '2@2']);
  });

  it('cache hits flow through in the same frame and use nothing', async () => {
    const f = fakeHost();
    // a building's pieces: one new program, then its material clones (hits)
    expect(await run(f.host, f.frame, [0, 0, 1, 0, 0, 1])).toEqual([
      '0@0',
      '1@0',
      '2@0',
      '3@1',
      '4@1',
      '5@1',
    ]);
  });

  it('a caller that waited and then hit the cache passes the frame on', async () => {
    const f = fakeHost();
    await run(f.host, f.frame, [1, 0]);
    expect(f.passes()).toBe(1);
  });

  it('a compile that links several variants uses one frame per program', async () => {
    // three variants in one piece keep the next caller back three frames, so
    // one compile cannot burst the GPU process
    const f = fakeHost();
    expect(await run(f.host, f.frame, [3, 2, 1])).toEqual(['0@0', '1@3', '2@5']);
  });

  it('waits in the lane it was given (gates before bulk)', async () => {
    const f = fakeHost();
    await pacedCompile(f.host, () => ({ value: 0, created: 1 }));
    await pacedCompile(f.host, () => ({ value: 1, created: 1 }), 'bulk');
    await pacedCompile(f.host, () => ({ value: 2, created: 0 }));
    expect(f.lanes).toEqual(['bulk', 'gate']);
  });

  it('a released caller whose compile throws still passes the frame on', async () => {
    const f = fakeHost();
    await pacedCompile(f.host, () => ({ value: 0, created: 1 }));
    await expect(
      pacedCompile(f.host, () => {
        throw new Error('lost context');
      }),
    ).rejects.toThrow('lost context');
    expect(f.passes()).toBe(1);
  });

  it('unpaced (the loading screen, an arrival cover) never waits', async () => {
    const f = fakeHost({ paced: () => false });
    expect(await run(f.host, f.frame, [1, 1, 1])).toEqual(['0@0', '1@0', '2@0']);
  });

  it('returns what the compile returned, with its program count', async () => {
    const f = fakeHost();
    const r = await pacedCompile(f.host, () => ({ value: 'promise', created: 2 }));
    expect(r).toEqual({ value: 'promise', created: 2, waited: false });
  });
});
