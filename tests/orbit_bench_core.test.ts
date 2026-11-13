import { describe, expect, it } from 'vitest';
import {
  calibrationRatios,
  DEFAULT_SPOTS,
  DEFAULT_WINDOWS_SPEC,
  drawnFrameStats,
  drawnIntervals,
  drawnShare,
  formatCalibration,
  formatRunTable,
  mainThreadMs,
  parseWindows,
  pathLength,
  percentile,
  pollUntil,
  summarizePoll,
  WALK_ROUTES,
  WARM_WINDOWS,
  walkLongFrames,
} from '../scripts/lib/orbit_bench_core.mjs';

// A 60 Hz loop where the renderer draws on every callback.
function unlimitedTrace(frames: number) {
  return {
    dt: Array.from({ length: frames }, () => 16.6),
    calls: Array.from({ length: frames }, (_, i) => 1000 + i * 100),
  };
}

// A 60 Hz loop under a 30 FPS Frame Rate Limit: the counter moves every other callback.
function limitedTrace(frames: number) {
  return {
    dt: Array.from({ length: frames }, () => 16.6),
    calls: Array.from({ length: frames }, (_, i) => 1000 + Math.floor(i / 2) * 100),
  };
}

describe('parseWindows', () => {
  it('parses the default sweep into five windows in order', () => {
    expect(parseWindows(DEFAULT_WINDOWS_SPEC)).toEqual([
      { name: 'idle', look: 0 },
      { name: 'orbit1', look: 0.5 },
      { name: 'orbit2', look: 0.5 },
      { name: 'orbit3', look: 0.5 },
      { name: 'idle2', look: 0 },
    ]);
  });

  it('rejects a missing look, a non-number, an extra field and an out-of-range look', () => {
    expect(() => parseWindows('idle')).toThrow(/name:look/);
    expect(() => parseWindows('idle:fast')).toThrow(/name:look/);
    expect(() => parseWindows('idle:0:1')).toThrow(/name:look/);
    expect(() => parseWindows('orbit:1.5')).toThrow(/\[-1, 1\]/);
    expect(() => parseWindows('')).toThrow(/empty/);
  });

  it('accepts a negative look (turning the other way)', () => {
    expect(parseWindows('left:-0.5')).toEqual([{ name: 'left', look: -0.5 }]);
  });
});

describe('drawn frames vs loop callbacks', () => {
  it('reports 60 drawn frames per second when every callback draws', () => {
    const stats = drawnFrameStats(unlimitedTrace(301));
    expect(stats.drawnPerSec).toBeCloseTo(60.2, 1);
    expect(stats.medianMs).toBe(16.6);
    expect(drawnShare(unlimitedTrace(301))).toBe(1);
  });

  it('reports 30 drawn frames per second under a 30 FPS limit, not the 60 Hz loop rate', () => {
    const trace = limitedTrace(301);
    const stats = drawnFrameStats(trace);
    expect(stats.drawnPerSec).toBeCloseTo(30.1, 1);
    expect(stats.medianMs).toBe(33.2);
    expect(drawnShare(trace)).toBe(0.5);
  });

  it('folds skipped callbacks into the next drawn interval and drops the first partial one', () => {
    // callbacks: draw, skip, skip, draw, draw  (calls move at index 0->? only where values change)
    const pace = { dt: [10, 16, 16, 16, 16, 16], calls: [0, 1, 1, 1, 2, 3] };
    // drawn at i=1 (16, dropped as the first), i=4 (16+16+16=48), i=5 (16)
    expect(drawnIntervals(pace)).toEqual([48, 16]);
    const stats = drawnFrameStats(pace);
    expect(stats.maxMs).toBe(48);
    expect(stats.over40).toBe(1);
    expect(stats.over50).toBe(0);
  });

  it('handles an empty or missing trace without throwing', () => {
    expect(drawnIntervals({ dt: [], calls: [] })).toEqual([]);
    const stats = drawnFrameStats({ dt: [], calls: [] });
    expect(stats.frames).toBe(0);
    expect(stats.drawnPerSec).toBeNull();
    expect(drawnShare({ dt: [1], calls: [1] })).toBeNull();
  });
});

describe('percentile', () => {
  it('uses nearest rank on the lower side and does not mutate the input', () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 0.5)).toBe(3);
    expect(percentile(values, 0.99)).toBe(5);
    expect(percentile(values, 0)).toBe(1);
    expect(values).toEqual([5, 1, 4, 2, 3]);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
});

describe('summarizePoll', () => {
  it('counts render-scale moves, distinct budget levels and program growth', () => {
    const summary = summarizePoll([
      { ers: 1, lv: { grass: 1 }, sh: 0, post: 'full', programs: 100 },
      { ers: 0.9, lv: { grass: 1 }, sh: 1, post: 'full', programs: 104 },
      { ers: 0.9, lv: { grass: 0.5 }, sh: 2, post: 'full', programs: 109 },
      { ers: 0.68, lv: { grass: 0.5 }, sh: 2, post: 'full', programs: 109 },
    ]);
    expect(summary.renderScale).toEqual([0.68, 1]);
    expect(summary.renderScaleChanges).toBe(2);
    expect(summary.budgetLevelSets).toBe(2);
    expect(summary.shadowSteps).toEqual(['0', '1', '2']);
    expect(summary.postRungs).toEqual(['"full"']);
    expect(summary.programsGrowth).toBe(9);
  });

  it('reports the time share of each governor reason', () => {
    const summary = summarizePoll([
      { ers: 1, reason: 'submit-stall', programs: 1 },
      { ers: 1, reason: 'submit-stall', programs: 1 },
      { ers: 1, reason: 'stable', programs: 1 },
      { ers: 1, programs: 1 },
    ]);
    expect(summary.reasons).toEqual({ 'submit-stall': 0.5, stable: 0.25, unknown: 0.25 });
  });

  it('is safe on an empty poll', () => {
    const summary = summarizePoll([]);
    expect(summary.renderScale).toBeNull();
    expect(summary.renderScaleChanges).toBe(0);
    expect(summary.programsGrowth).toBe(0);
  });
});

function run(label: string, scale: Record<string, number>) {
  const report = (base: number) => ({
    mainSimMs: 4 * base * (scale.sim ?? 1),
    mainRendererMs: 15 * base * (scale.renderer ?? 1),
    phaseSubmitMs: 10 * base * (scale.submit ?? 1),
    phaseWorldMs: 3 * base * (scale.world ?? 1),
    phaseEntitiesMs: 2.5 * base * (scale.entities ?? 1),
    mainHudMs: 2 * base * (scale.hud ?? 1),
  });
  return {
    label,
    spots: ['town', 'open'].map((spot, s) => ({
      spot,
      windows: ['idle', 'orbit1', 'orbit2', 'orbit3', 'idle2'].map((window) => ({
        window,
        // the first sweep is deliberately wild: it must not enter the warm comparison
        report: report(window === 'orbit1' ? 10 : 1 + s * 0.1),
      })),
    })),
  };
}

describe('calibrationRatios', () => {
  it('returns 1.00 for a run identical to the reference', () => {
    const ratios = calibrationRatios(run('phone', {}), run('emu', {}));
    expect(ratios.renderer).toBeCloseTo(1, 6);
    expect(ratios.total).toBeCloseTo(1, 6);
    expect(ratios.windows).toBe(6);
  });

  it('reports each phase scale independently', () => {
    const ratios = calibrationRatios(
      run('phone', {}),
      run('emu', { renderer: 1.5, hud: 0.8, sim: 1.25 }),
    );
    expect(ratios.renderer).toBeCloseTo(1.5, 6);
    expect(ratios.hud).toBeCloseTo(0.8, 6);
    expect(ratios.sim).toBeCloseTo(1.25, 6);
    expect(ratios.submit).toBeCloseTo(1, 6);
  });

  it('compares only warm windows, so a wild first sweep in one run cannot skew it', () => {
    const emu = run('emu', {});
    for (const spot of emu.spots) {
      const first = spot.windows.find((w) => w.window === 'orbit1');
      if (first) first.report.mainRendererMs *= 50;
    }
    expect(calibrationRatios(run('phone', {}), emu).renderer).toBeCloseTo(1, 6);
    expect(WARM_WINDOWS).not.toContain('orbit1');
  });

  it('weights the total by the summed main thread, not a phase average', () => {
    const report = { mainSimMs: 4, mainRendererMs: 15, mainHudMs: 2, phaseSubmitMs: 99 };
    expect(mainThreadMs(report)).toBe(21);
  });
});

describe('formatting', () => {
  it('prints the drawn rate and the hitch causes for each window', () => {
    const text = formatRunTable({
      label: 'phone-low',
      env: {
        tier: 'low',
        drawingBuffer: { width: 1348, height: 608, cssWidth: 911, cssHeight: 411 },
      },
      spots: [
        {
          spot: 'open',
          windows: [
            {
              window: 'orbit2',
              pace: limitedTrace(301),
              report: { mainSimMs: 3.6, mainRendererMs: 15.5, phaseSubmitMs: 10.4, mainHudMs: 2.1 },
              newPrograms: 3,
              freezes: { byCause: { 'shader-compile': 2 } },
            },
          ],
        },
      ],
    });
    expect(text).toContain('phone-low');
    expect(text).toContain('1348x608');
    expect(text).toMatch(/open\s+orbit2\s+30\.1\s+33\.2/);
    expect(text).toContain('"shader-compile":2');
  });

  it('prints one calibration row per run', () => {
    const ratios = calibrationRatios(run('phone', {}), run('emu', { renderer: 0.93 }));
    const text = formatCalibration('phone', [{ label: 'emulation-cpu1.5', ratios }]);
    expect(text).toContain('reference: phone');
    expect(text).toMatch(/emulation-cpu1\.5\s+1\.00\s+0\.93/);
  });
});

describe('pollUntil', () => {
  it('resolves once the check answers truthy, treating a throw as not yet', async () => {
    let calls = 0;
    const ok = await pollUntil(
      () => {
        calls++;
        if (calls === 1) throw new Error('navigating');
        return calls >= 3;
      },
      { timeoutMs: 1000, intervalMs: 1, sleep: async () => {}, now: () => 0 },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('times out with the configured deadline', async () => {
    let t = 0;
    await expect(
      pollUntil(() => false, {
        timeoutMs: 100,
        intervalMs: 50,
        sleep: async (ms) => {
          t += ms;
        },
        now: () => t,
      }),
    ).rejects.toThrow(/timed out after 100 ms/);
  });
});

describe('bench spots', () => {
  it('keeps the town and open-field spots the recorded baselines were taken at', () => {
    expect(DEFAULT_SPOTS.map((s) => [s.name, s.x, s.z])).toEqual([
      ['town', 0, -14],
      ['open', 0, 60],
    ]);
  });
});

describe('walk routes', () => {
  it('measures a polyline from the start point through every waypoint', () => {
    expect(pathLength({ x: 0, z: 0 }, [{ x: 3, z: 4 }, { x: 3, z: 10 }])).toBe(11);
    expect(pathLength({ x: 1, z: 1 }, [])).toBe(0);
  });

  it('north crosses into Thornpeak at z 540 and walks back to the start', () => {
    const { start, legs } = WALK_ROUTES.north;
    expect(legs.map((l) => l.name)).toEqual(['walkout', 'walkback']);
    const out = legs[0].path;
    expect(out[0].z).toBeLessThan(180);
    expect(out[out.length - 1].z).toBeGreaterThan(540);
    const back = legs[1].path;
    expect(back[back.length - 1]).toEqual({ x: start.x, z: start.z });
    expect(back[0]).toEqual(out[out.length - 2]);
  });
});

describe('walkLongFrames', () => {
  // Five callbacks: a 120 ms drawn gap at index 2, then a skipped callback
  // (calls unchanged) whose 60 ms folds into the next drawn frame (60 + 50).
  const pace = {
    dt: [16, 16, 120, 60, 50],
    calls: [10, 20, 30, 30, 40],
    at: [100, 116, 236, 296, 346],
    x: [0, 1, 2, 3, 4],
    z: [5, 6, 7, 8, 9],
  };

  it('reports drawn gaps over the threshold, folding skipped callbacks, with the position', () => {
    const frames = walkLongFrames(pace, [], { overMs: 100 });
    expect(frames).toEqual([
      { at: 236, ms: 120, x: 2, z: 7, builds: [] },
      { at: 346, ms: 110, x: 4, z: 9, builds: [] },
    ]);
  });

  it('attaches the builds that overlap the gap or end just after it, and no others', () => {
    const builds = [
      { kind: 'zone:features:buildGaleFeatures', ms: 70, t: 150 }, // inside the first gap
      { kind: 'view:mount', ms: 5, t: 250 }, // starts 14 ms after the first gap: within slack
      { kind: 'view:far', ms: 3, t: 50 }, // ended before either gap
      { kind: 'view:late', ms: 2, t: 400 }, // after both gaps plus slack
    ];
    const [first, second] = walkLongFrames(pace, builds, { overMs: 100, slackMs: 20 });
    expect(first.builds).toEqual([
      { kind: 'zone:features:buildGaleFeatures', ms: 70 },
      { kind: 'view:mount', ms: 5 },
    ]);
    expect(second.builds).toEqual([{ kind: 'view:mount', ms: 5 }]);
  });

  it('is empty for a smooth leg or no trace', () => {
    expect(walkLongFrames({ dt: [16, 16], calls: [1, 2], at: [0, 16] }, [])).toEqual([]);
    expect(walkLongFrames(undefined, undefined)).toEqual([]);
  });
});
