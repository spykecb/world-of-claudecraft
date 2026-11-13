// Pure halves of scripts/orbit_bench.mjs, the camera-turn (orbit) bench. No I/O, no
// puppeteer: tests/orbit_bench_core.test.ts drives every function with hand-built
// traces. The bench itself, the device glue and the CLI live in the entry script
// and scripts/profiler/android_target.mjs.
//
// Why "drawn" frames and not the profiler's frameStats: the automatic Frame Rate
// Limit (src/game/frame_cadence_auto_core.ts) skips whole frame-loop callbacks once
// it engages, and frameStats counts every callback, so on a limited device it reads
// about twice the real rate. A drawn frame is a loop frame on which the renderer's
// cumulative draw-call counter moved.

/** The two fixed bench spots (offline world coordinates) and their facing. */
export const DEFAULT_SPOTS = Object.freeze([
  Object.freeze({ name: 'town', x: 0, z: -14, f: 0 }),
  Object.freeze({ name: 'open', x: 0, z: 60, f: Math.PI }),
]);

/** Stand still, three identical sweeps, stand still again: the repeat is what
 *  separates a first-sight cost (cold shaders and uploads) from a steady one. */
export const DEFAULT_WINDOWS_SPEC = 'idle:0,orbit1:0.5,orbit2:0.5,orbit3:0.5,idle2:0';

/** Windows after the first sweep: first-sight compiles no longer dominate. */
export const WARM_WINDOWS = Object.freeze(['orbit2', 'orbit3', 'idle2']);

/** The main-thread phases the calibration compares (report field, short name). */
export const PHASES = Object.freeze([
  Object.freeze(['mainSimMs', 'sim']),
  Object.freeze(['mainRendererMs', 'renderer']),
  Object.freeze(['phaseSubmitMs', 'submit']),
  Object.freeze(['phaseWorldMs', 'world']),
  Object.freeze(['phaseEntitiesMs', 'entities']),
  Object.freeze(['mainHudMs', 'hud']),
]);

/**
 * Parse a window spec "name:look,name:look" where look is the touch-look x in
 * [-1, 1] (0 stands still, 0.5 is a comfortable thumb drag, 1 is full deflection).
 * Throws on a malformed entry so a typo never silently measures the wrong thing.
 */
export function parseWindows(spec) {
  const text = String(spec ?? '').trim();
  if (!text) throw new Error('empty window spec');
  return text.split(',').map((part) => {
    const [name, lookText, extra] = part.split(':').map((s) => s.trim());
    const look = Number(lookText);
    if (!name || extra !== undefined || lookText === undefined || !Number.isFinite(look)) {
      throw new Error(`bad window "${part}": expected name:look, for example orbit1:0.5`);
    }
    if (look < -1 || look > 1) throw new Error(`window "${name}": look must be in [-1, 1]`);
    return { name, look };
  });
}

/** Sorted-copy percentile, nearest-rank on the lower side; NaN for an empty list. */
export function percentile(values, q) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function median(values) {
  return percentile(values, 0.5);
}

/**
 * Fold the 100 ms governor poll of one window: render-scale range and how often it
 * moved, how many distinct budget-level sets were seen, shadow and post rungs, and
 * shader-program growth.
 */
export function summarizePoll(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const uniq = (k) => [...new Set(list.map((r) => JSON.stringify(r[k])))];
  const range = (k) => {
    const nums = list.map((r) => r[k]).filter((v) => typeof v === 'number');
    return nums.length ? [Math.min(...nums), Math.max(...nums)] : null;
  };
  let renderScaleChanges = 0;
  for (let i = 1; i < list.length; i++) if (list[i].ers !== list[i - 1].ers) renderScaleChanges++;
  return {
    renderScale: range('ers'),
    renderScaleChanges,
    budgetLevelSets: uniq('lv').length,
    shadowSteps: uniq('sh'),
    postRungs: uniq('post'),
    programs: range('programs'),
    programsGrowth: list.length ? list[list.length - 1].programs - list[0].programs : 0,
    reasons: shareOf(list, 'reason'),
  };
}

/** Share of poll rows per value of one field, for example the governor reason. */
export function shareOf(rows, key) {
  const counts = {};
  for (const r of rows) {
    const k = String(r[key] ?? 'unknown');
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const out = {};
  for (const [k, n] of Object.entries(counts)) out[k] = Math.round((100 * n) / rows.length) / 100;
  return out;
}

/**
 * Intervals between DRAWN frames, from the raw per-callback trace
 * { dt: ms since previous callback, calls: cumulative draw calls }. A skipped
 * callback (calls unchanged) folds its time into the next drawn frame's interval.
 * The first drawn interval is dropped: it straddles the window start.
 */
export function drawnIntervals(pace) {
  const dt = pace?.dt ?? [];
  const calls = pace?.calls ?? [];
  const out = [];
  let acc = 0;
  for (let i = 1; i < dt.length; i++) {
    acc += dt[i];
    if (calls[i] !== calls[i - 1]) {
      out.push(acc);
      acc = 0;
    }
  }
  return out.slice(1);
}

/** What a player sees in one window: drawn frames per second and the gap percentiles. */
export function drawnFrameStats(pace) {
  const iv = drawnIntervals(pace);
  const totalMs = iv.reduce((a, b) => a + b, 0);
  const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  return {
    frames: iv.length,
    drawnPerSec: totalMs > 0 ? round((1000 * iv.length) / totalMs) : null,
    medianMs: round(median(iv)),
    p95Ms: round(percentile(iv, 0.95)),
    p99Ms: round(percentile(iv, 0.99)),
    maxMs: iv.length ? round(Math.max(...iv)) : null,
    over40: iv.filter((v) => v > 40).length,
    over50: iv.filter((v) => v > 50).length,
  };
}

/** Share of loop callbacks the renderer actually drew on (1 = no frame limit active). */
export function drawnShare(pace) {
  const calls = pace?.calls ?? [];
  if (calls.length < 2) return null;
  let moved = 0;
  for (let i = 1; i < calls.length; i++) if (calls[i] !== calls[i - 1]) moved++;
  return Math.round((100 * moved) / (calls.length - 1)) / 100;
}

function reportsByKey(run) {
  const map = new Map();
  for (const spot of run?.spots ?? []) {
    for (const w of spot.windows ?? []) map.set(`${spot.spot}:${w.window}`, w.report ?? {});
  }
  return map;
}

/** Main-thread ms per frame: sim + renderer + HUD. */
export function mainThreadMs(report) {
  return (report?.mainSimMs ?? 0) + (report?.mainRendererMs ?? 0) + (report?.mainHudMs ?? 0);
}

/**
 * Calibrate an emulation run against a reference (phone) run: for each phase, the
 * median over matched warm windows of emu / reference. 1.00 means the emulation costs
 * what the reference does. `total` uses mainThreadMs.
 */
export function calibrationRatios(reference, emulation, warm = WARM_WINDOWS) {
  const ref = reportsByKey(reference);
  const emu = reportsByKey(emulation);
  const keys = [...emu.keys()].filter((k) => warm.includes(k.split(':')[1]) && ref.has(k));
  const ratio = (pick) =>
    median(
      keys
        .map((k) => pick(emu.get(k)) / pick(ref.get(k)))
        .filter((v) => Number.isFinite(v) && v > 0),
    );
  const out = { windows: keys.length };
  for (const [field, name] of PHASES) out[name] = ratio((r) => r[field]);
  out.total = ratio(mainThreadMs);
  return out;
}

const fmt = (v, width, digits = 1) =>
  (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '-').padStart(width);

/** One run as text: per window, the loop view, the drawn view and the phase split. */
export function formatRunTable(run) {
  const env = run?.env ?? {};
  const db = env.drawingBuffer ?? {};
  const lines = [
    `== ${run?.label ?? '?'}  tier ${env.tier ?? '?'}  buffer ${db.width ?? '?'}x${db.height ?? '?'}  ` +
      `page ${db.cssWidth ?? '?'}x${db.cssHeight ?? '?'}  cpu x${run?.cpuThrottle ?? 1}  ${String(env.glRenderer ?? '').slice(0, 60)}`,
    'spot  window   drawn/s  med ms  p99 ms  max ms  drawn% |  sim  rend  subm   hud | new shaders  hitch causes',
  ];
  for (const spot of run?.spots ?? []) {
    for (const w of spot.windows ?? []) {
      const d = w.pace ? drawnFrameStats(w.pace) : null;
      const share = w.pace ? drawnShare(w.pace) : null;
      const r = w.report ?? {};
      lines.push(
        [
          String(spot.spot).padEnd(5),
          String(w.window).padEnd(7),
          fmt(d?.drawnPerSec, 7),
          fmt(d?.medianMs, 7),
          fmt(d?.p99Ms, 7),
          fmt(d?.maxMs, 7),
          fmt(share === null ? null : share * 100, 7, 0),
          '|',
          fmt(r.mainSimMs, 4),
          fmt(r.mainRendererMs, 5),
          fmt(r.phaseSubmitMs, 5),
          fmt(r.mainHudMs, 5),
          '|',
          String(w.newPrograms ?? '-').padStart(11),
          ` ${JSON.stringify(w.freezes?.byCause ?? {})}`,
        ].join(' '),
      );
    }
  }
  return lines.join('\n');
}

/** Calibration result as text, one row per emulation run. */
export function formatCalibration(referenceLabel, rows) {
  const names = PHASES.map(([, n]) => n);
  const lines = [
    `reference: ${referenceLabel} (1.00 = same main-thread cost as the reference)`,
    `${'run'.padEnd(28)}${names.map((n) => n.padStart(9)).join('')}    total  windows`,
  ];
  for (const { label, ratios } of rows) {
    lines.push(
      `${String(label).padEnd(28)}${names.map((n) => fmt(ratios[n], 9, 2)).join('')}${fmt(ratios.total, 9, 2)}  ${String(ratios.windows).padStart(7)}`,
    );
  }
  return lines.join('\n');
}

/**
 * Poll an async check until it answers truthy or the deadline passes. Used in place
 * of puppeteer's in-page wait tasks, which stall over the Android DevTools socket
 * while a phone's main thread is busy. A throwing check (navigation in flight) counts
 * as "not yet". `sleep` and `now` are injectable for tests.
 */
export async function pollUntil(check, { timeoutMs = 30000, intervalMs = 500, sleep, now } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = now ?? (() => Date.now());
  const deadline = clock() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = Boolean(await check());
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (clock() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await wait(intervalMs);
  }
}

/** Walk routes (offline world coordinates). Each leg is a click-to-move path the
 *  player walks for real; the bench measures the frames while the streaming
 *  horizon pulls in zones that were out of reach at the start. `north` follows
 *  the road from Eastbrook's town through Mirefen Marsh (Fenbridge, whose zone
 *  the town's horizon already prepares) across the z 540 border into Thornpeak
 *  (Highwatch), which it does not, then walks back the same way: the return
 *  re-crosses both borders and, on a memory-constrained device, can rebuild an
 *  evicted zone. */
const NORTH_OUT = Object.freeze([
  { x: 2, z: -4 },
  { x: -8, z: 30 },
  { x: -15, z: 55 },
  { x: -2, z: 78 },
  { x: 0, z: 130 },
  { x: 0, z: 180 },
  { x: -8, z: 240 },
  { x: 0, z: 272 },
  { x: 0, z: 298 },
  { x: 0, z: 320 },
  { x: 10, z: 450 },
  { x: 0, z: 540 },
  { x: 0, z: 600 },
  { x: 0, z: 660 },
]);
export const WALK_ROUTES = Object.freeze({
  north: Object.freeze({
    start: Object.freeze({ x: 0, z: -14, f: 0 }),
    legs: Object.freeze([
      Object.freeze({ name: 'walkout', path: NORTH_OUT }),
      Object.freeze({
        name: 'walkback',
        path: Object.freeze([...NORTH_OUT.slice(0, -1).reverse(), { x: 0, z: -14 }]),
      }),
    ]),
  }),
});

/** Length of a polyline walked from `from` through every point of `path`. */
export function pathLength(from, path) {
  let total = 0;
  let prev = from;
  for (const point of path) {
    total += Math.hypot(point.x - prev.x, point.z - prev.z);
    prev = point;
  }
  return total;
}

/**
 * The frames of one walk leg worth naming: every DRAWN frame gap of `overMs` or
 * more, with where the player was when it ended and the builds the renderer's
 * ledger recorded inside it (or ending within `slackMs` after it, since a build
 * logged at its end belongs to the frame it stalled). `pace` carries per-callback
 * dt, at (program-trace clock), calls, x and z; `builds` is [{ kind, ms, t }] on
 * the same clock, t being the build's start.
 */
export function walkLongFrames(pace, builds, { overMs = 100, slackMs = 20 } = {}) {
  const out = [];
  const { dt = [], at = [], calls = [], x = [], z = [] } = pace ?? {};
  let gap = 0;
  for (let i = 0; i < dt.length; i++) {
    gap += dt[i];
    const drawn = i === 0 || calls[i] !== calls[i - 1];
    if (!drawn) continue;
    if (gap >= overMs) {
      const end = at[i];
      const start = end - gap;
      out.push({
        at: end,
        ms: Math.round(gap * 10) / 10,
        x: x[i] ?? null,
        z: z[i] ?? null,
        builds: (builds ?? [])
          .filter((b) => b.t + b.ms >= start && b.t <= end + slackMs)
          .map((b) => ({ kind: b.kind, ms: Math.round(b.ms) })),
      });
    }
    gap = 0;
  }
  return out;
}
