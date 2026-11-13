// Camera-turn (orbit) bench: stand still, sweep the camera three identical times,
// stand still again, at a town spot and an open-field spot, and record what each
// window costs and what a player actually sees. Runs on the desktop, in calibrated
// phone emulation, or on a real Android phone over USB. Runbook and findings:
// docs/perf/camera-turn-optimization.md. Pure halves: scripts/lib/orbit_bench_core.mjs
// (tests/orbit_bench_core.test.ts); phone glue: scripts/profiler/android_target.mjs.
//
//   node scripts/orbit_bench.mjs run --target desktop|emulation|android [options]
//   node scripts/orbit_bench.mjs table <result.json>...
//   node scripts/orbit_bench.mjs calibrate --reference <phone.json> <emulation.json>...
//   node scripts/orbit_bench.mjs build-devmode [--out dir]
//   node scripts/orbit_bench.mjs serve [--dir dir] [--port 4173]
//   node scripts/orbit_bench.mjs android-setup [--port 4173]
//   node scripts/orbit_bench.mjs android-teardown [--port 4173]
//   node scripts/orbit_bench.mjs thermal [--every 3] [--out file.jsonl]
//
// run options:
//   --target     desktop (1600x900), emulation (915x412 landscape phone, DPR 2.625,
//                mobile UA, touch) or android (the phone's own Chrome over adb)
//   --tier       low|medium|high|ultra|insane (default: the device's own pick)
//   --cpu N      Chrome CPU throttle (emulation: 1.5 matches a Snapdragon 7s Gen 3 phone)
//   --entry-cpu N  a different throttle during world entry only (default --cpu): 4 makes
//                the prewarm drop what the phone's slower entry drops
//   --windows    name:look,... (default idle:0,orbit1:0.5,orbit2:0.5,orbit3:0.5,idle2:0)
//   --ms N       sample window length (default 5000)
//   --query S    extra URL flags, for example '&governor=off'
//   --settings J woc_settings keys merged before boot, for example '{"renderScale":0.5}'
//   --keep-storage  keep the origin's site storage (default: cleared before the run)
//   --no-parallel-compile  hide KHR_parallel_shader_compile (the reference phone's Chrome
//                lacks it), so the desktop runs the phone's code path
//   --settle MS  stand this long after each teleport (default 4000)
//   --spots S    comma list of spot names to run (default every spot: town,open)
//   --cpu-profile W  any value (for example all) records one 1 kHz main-thread CPU
//                profile per spot, from mid-settle to after its last window, written
//                next to the result as <label>.<spot>.cpuprofile; results.ownersT0 maps pace.at to
//                the page clock (pageMs = at + ownersT0) for cpu_profile_window.mjs
//   --walk R     walk route R instead of the orbit spots (routes: WALK_ROUTES in
//                lib/orbit_bench_core.mjs, for example north): each leg is walked for real
//                with click-to-move and reported per leg, with every drawn frame of 100 ms
//                or more, where the player was, and the renderer builds inside it
//   --eval FILE  a JS expression evaluated in the page after each spot's settle, kept as
//                the spot's `eval` (one-off probes: scene node counts, snapshots)
//   --label S    result name (default <target>-<tier>); --out path (default tmp/orbit-bench/<label>.json)
//   GAME_URL     the served game (default http://localhost:4173, the `serve` subcommand)
//
// The offline world is disabled in release builds (src/game/offline_mode_gate.ts), and
// the Vite dev server's unbundled modules are too slow over USB, so phone runs load a
// bundled DEVELOPMENT build: `build-devmode` then `serve`. Use the same served build for
// the desktop runs you compare against it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBattery, parseThermalService } from './lib/android_device_parse.mjs';
import {
  calibrationRatios,
  DEFAULT_SPOTS,
  DEFAULT_WINDOWS_SPEC,
  drawnFrameStats,
  pathLength,
  WALK_ROUTES,
  walkLongFrames,
  formatCalibration,
  formatRunTable,
  parseWindows,
  summarizePoll,
} from './lib/orbit_bench_core.mjs';
import {
  adbShell,
  androidDeviceState,
  clearSiteStorage,
  connectAndroidChrome,
  installNodeSideWaits,
  installPhoneEntryHelpers,
  keepAwake,
  screenState,
  setupAndroidTunnels,
  teardownAndroidTunnels,
  waitForUsableScreen,
} from './profiler/android_target.mjs';
import { Profiler } from './profiler/harness.mjs';
import { startCpuProfile, stopCpuProfile } from './gpu_hitch_capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'orbit-bench');
const DEVMODE_DIR = path.join(OUT_DIR, 'devmode-dist');
const DEFAULT_PORT = 4173;
const EMULATED_PHONE = Object.freeze({
  width: 915,
  height: 412,
  dpr: 2.625,
  ua: 'Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
});

const [command, ...rest] = process.argv.slice(2);
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));
function opt(name, fallback) {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = rest[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readRun = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function viteBin() {
  return path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
}

function runChild(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function buildDevmode() {
  const out = path.resolve(String(opt('out', DEVMODE_DIR)));
  // NODE_ENV=development is what makes import.meta.env.DEV true in a bundled build;
  // --mode development alone leaves it false and the offline world stays disabled.
  console.log(`building a development-mode bundle into ${out}`);
  return runChild([viteBin(), 'build', '--mode', 'development', '--outDir', out, '--emptyOutDir'], {
    NODE_ENV: 'development',
  });
}

async function serve() {
  const dir = path.resolve(String(opt('dir', DEVMODE_DIR)));
  const port = String(opt('port', DEFAULT_PORT));
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    console.error(`no build at ${dir}: run "node scripts/orbit_bench.mjs build-devmode" first`);
    return 1;
  }
  console.log(`serving ${dir} on http://127.0.0.1:${port} (Ctrl+C to stop)`);
  return runChild([
    viteBin(),
    'preview',
    '--outDir',
    dir,
    '--port',
    port,
    '--strictPort',
    '--host',
    '127.0.0.1',
  ]);
}

function deviceSummary() {
  const prop = (k) => adbShell(`getprop ${k}`).trim();
  const chrome =
    /versionName=(\S+)/.exec(adbShell('dumpsys package com.android.chrome'))?.[1] ?? '?';
  return {
    manufacturer: prop('ro.product.manufacturer'),
    model: prop('ro.product.model'),
    android: prop('ro.build.version.release'),
    soc: prop('ro.soc.model'),
    chrome,
    display: adbShell('wm size')
      .trim()
      .replace(/^Physical size:\s*/, ''),
  };
}

async function androidSetup() {
  const port = Number(opt('port', DEFAULT_PORT));
  const state = androidDeviceState();
  if (!state.ok) {
    console.error(state.reason);
    return 1;
  }
  setupAndroidTunnels(port);
  keepAwake(true);
  const info = deviceSummary();
  let devtools = 'unreachable: open Chrome on the phone';
  try {
    const res = await fetch('http://127.0.0.1:9222/json/version');
    devtools = (await res.json()).Browser;
  } catch {
    /* Chrome not running yet */
  }
  console.log(
    JSON.stringify(
      { ...info, devtools, gamePortOnPhone: `localhost:${port}`, screen: screenState() },
      null,
      2,
    ),
  );
  console.log('stay-awake on USB is ON; run android-teardown when finished to turn it off.');
  return 0;
}

function androidTeardown() {
  const port = Number(opt('port', DEFAULT_PORT));
  teardownAndroidTunnels(port);
  keepAwake(false);
  console.log('tunnels removed; stay-awake on USB is OFF.');
  return 0;
}

function thermalSample() {
  const thermal = parseThermalService(adbShell('dumpsys thermalservice'));
  const battery = parseBattery(adbShell('dumpsys battery'));
  return { t: Date.now(), ...thermal, battery };
}

async function thermalLoop() {
  const every = Number(opt('every', 3)) * 1000;
  const out = String(opt('out', path.join(OUT_DIR, 'thermal.jsonl')));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  console.log(`sampling every ${every / 1000}s into ${out} (Ctrl+C to stop)`);
  for (;;) {
    const s = thermalSample();
    fs.appendFileSync(out, `${JSON.stringify(s)}\n`);
    const cooling = Object.keys(s.activeCooling).join(',') || 'none';
    console.log(
      `${new Date(s.t).toLocaleTimeString()} status ${s.status} skin ${s.temps.skin ?? '?'}C ` +
        `cpu ${s.temps.CPU7 ?? '?'}C gpu ${s.temps.GPU0 ?? '?'}C battery ${s.battery.level ?? '?'}% throttling ${cooling}`,
    );
    await sleep(every);
  }
}

function summarizeThermal(samples) {
  if (!samples.length) return null;
  const range = (pick) => {
    const v = samples.map(pick).filter(Number.isFinite);
    return v.length ? [Math.min(...v), Math.max(...v)] : null;
  };
  return {
    samples: samples.length,
    statuses: [...new Set(samples.map((s) => s.status))],
    skinC: range((s) => s.temps.skin),
    cpuC: range((s) =>
      Math.max(
        ...Object.entries(s.temps)
          .filter(([k]) => /^CPU/.test(k))
          .map(([, v]) => v),
      ),
    ),
    gpuC: range((s) =>
      Math.max(
        ...Object.entries(s.temps)
          .filter(([k]) => /^GPU/.test(k))
          .map(([, v]) => v),
      ),
    ),
    batteryLevel: range((s) => s.battery.level),
    throttled: samples.some((s) => Object.keys(s.activeCooling).length > 0),
  };
}

async function run() {
  const target = String(opt('target', 'desktop'));
  if (!['desktop', 'emulation', 'android'].includes(target)) {
    console.error('--target must be desktop, emulation or android');
    return 1;
  }
  const tierOpt = opt('tier', undefined);
  const tier = typeof tierOpt === 'string' ? tierOpt : undefined;
  const cpu = Number(opt('cpu', 1));
  const entryCpu = Number(opt('entry-cpu', cpu));
  // How long to stand after each teleport before the first window. The bench
  // jumps without the game's arrival cover, so everything in view is requested
  // at once: 4 s measures that worst case, a longer settle the player who
  // arrived and stood a while.
  const settleMs = Number(opt('settle', 4000));
  const ms = Number(opt('ms', 5000));
  const windows = parseWindows(String(opt('windows', DEFAULT_WINDOWS_SPEC)));
  const query = typeof opt('query') === 'string' ? opt('query') : '';
  const settings = typeof opt('settings') === 'string' ? JSON.parse(opt('settings')) : null;
  const label = String(opt('label', `${target}-${tier ?? 'auto'}${cpu > 1 ? `-cpu${cpu}` : ''}`));
  const out = path.resolve(String(opt('out', path.join(OUT_DIR, `${label}.json`))));
  const gameUrl = process.env.GAME_URL ?? `http://localhost:${DEFAULT_PORT}`;

  const phone = target === 'android';
  const emulated = target === 'emulation';
  const p = new Profiler({
    gameUrl,
    dpr: emulated ? EMULATED_PHONE.dpr : 1,
    width: emulated ? EMULATED_PHONE.width : 1600,
    height: emulated ? EMULATED_PHONE.height : 900,
  });

  const thermal = [];
  let thermalTimer = null;
  if (phone) {
    const state = androidDeviceState();
    if (!state.ok) throw new Error(state.reason);
    console.log('waiting for the phone to be awake and unlocked (Chrome in front)...');
    if (!(await waitForUsableScreen(120000))) {
      throw new Error(
        'phone is asleep or locked: run android-setup, unlock the phone and keep Chrome in front',
      );
    }
    const conn = await connectAndroidChrome();
    p.browser = conn.browser;
    p.page = conn.page;
    thermalTimer = setInterval(() => thermal.push(thermalSample()), 3000);
  } else {
    await p.launch();
  }
  const cdp = await p.page.createCDPSession();
  if (emulated) {
    await p.page.setViewport({
      width: EMULATED_PHONE.width,
      height: EMULATED_PHONE.height,
      deviceScaleFactor: EMULATED_PHONE.dpr,
      isMobile: true,
      hasTouch: true,
    });
    // Phones play in landscape: portrait shows a rotate overlay over a narrower view
    // (the world keeps rendering under it, so a portrait run measures the wrong scene).
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: EMULATED_PHONE.width,
      height: EMULATED_PHONE.height,
      deviceScaleFactor: EMULATED_PHONE.dpr,
      mobile: true,
      screenOrientation: { type: 'landscapePrimary', angle: 90 },
    });
    await p.page.setUserAgent(EMULATED_PHONE.ua);
  }
  // --entry-cpu throttles harder during world entry only, so the 3 s prewarm
  // budget drops what a slower device's entry drops (the phone entered in 52 s
  // against the 1.5x proxy's 31 s), then the windows run at --cpu.
  if (entryCpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: entryCpu });
  if (!opt('keep-storage', false)) {
    await clearSiteStorage(cdp, new URL(gameUrl).origin).catch((e) =>
      console.log(`storage clear failed: ${e.message}`),
    );
  }
  // Phone emulation and a throttled CPU hit the same entry snags as a real phone.
  installNodeSideWaits(p.page);
  await installPhoneEntryHelpers(p.page);
  // --no-parallel-compile hides KHR_parallel_shader_compile from the page, so a
  // desktop browser takes the code path of a phone whose Chrome lacks it (the
  // Snapdragon 7s Gen 3 reference phone does): every compile gate is off there.
  if (opt('no-parallel-compile', false)) {
    await p.page.evaluateOnNewDocument(() => {
      const NAME = 'KHR_parallel_shader_compile';
      for (const Ctx of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
        if (!Ctx) continue;
        const getExtension = Ctx.prototype.getExtension;
        Ctx.prototype.getExtension = function (name) {
          return name === NAME ? null : getExtension.call(this, name);
        };
        const supported = Ctx.prototype.getSupportedExtensions;
        Ctx.prototype.getSupportedExtensions = function () {
          return (supported.call(this) ?? []).filter((n) => n !== NAME);
        };
      }
    });
  }
  if (settings) {
    await p.page.evaluateOnNewDocument((extra) => {
      try {
        const cur = JSON.parse(localStorage.getItem('woc_settings') ?? '{}');
        localStorage.setItem('woc_settings', JSON.stringify({ ...cur, ...extra }));
      } catch {
        /* storage unavailable */
      }
    }, settings);
  }

  // The renderer's own entry diagnostics ("[entry-guard] ..." lines: the prewarm
  // outcome, its parallel-compile verdict, what resumes in the background).
  const entryGuard = [];
  p.page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[entry-guard]') && entryGuard.length < 200) entryGuard.push(text);
  });
  const t0 = Date.now();
  // boot=now starts the client at once instead of waiting for a real tap on the landing page.
  // Fail fast when the game shows its fatal overlay (for example "Could not start
  // the renderer" when the browser cannot create a WebGL context): otherwise the
  // entry wait polls for a world that never appears until its long timeout.
  let entering = true;
  const fatal = (async () => {
    while (entering) {
      const text = await p.page
        .evaluate(() => {
          const el = document.querySelector('#fatal-overlay, .fatal-overlay');
          return el && getComputedStyle(el).display !== 'none' ? (el.textContent ?? '').trim() : '';
        })
        .catch(() => '');
      if (text)
        throw new Error(`the game reported a fatal error during entry: ${text.slice(0, 160)}`);
      await sleep(2000);
    }
  })();
  try {
    await Promise.race([
      p.enter({
        mode: 'offline',
        tier,
        extraQuery: `&boot=now${query}`,
        gameBootTimeoutMs: 900000,
        selectorTimeoutMs: 900000,
      }),
      fatal,
    ]);
  } finally {
    entering = false;
  }
  fatal.catch(() => {});
  const entrySeconds = Math.round((Date.now() - t0) / 100) / 10;
  if (entryCpu !== cpu)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Math.max(1, cpu) });
  console.log(`[${label}] entered the world in ${entrySeconds}s`);
  const env = await p.page.evaluate(() => {
    const s = window.__game.renderer.perfStats();
    const pw = s.prewarm ?? null;
    let resume = null;
    try {
      resume = pw?.resume ?? null;
    } catch {
      /* a getter that throws must not fail the run */
    }
    return {
      // What the world-entry prewarm got done before its deadline: on a slower
      // device the dropped entries resume as background debt during the first
      // windows, which is the first thing to rule out when those windows link.
      prewarm: pw
        ? {
            elapsedMs: pw.elapsedMs,
            maxMs: pw.maxMs,
            compileMode: pw.compileMode,
            compileMs: pw.compileMs,
            programsBefore: pw.programsBefore,
            programsAfter: pw.programsAfter,
            manifestPlanned: pw.manifestPlanned,
            manifestSkipped: pw.manifestSkipped,
            partial: pw.partialEntryIds,
            timedOut: pw.timedOutEntryIds,
            failed: pw.failedEntryIds,
            resume: resume ? JSON.parse(JSON.stringify(resume)) : null,
          }
        : null,
      parallelCompile: !!window.__game.renderer.webgl
        ?.getContext?.()
        ?.getExtension?.('KHR_parallel_shader_compile'),
      tier: s.tier,
      glRenderer: s.glRenderer,
      pixelRatio: s.pixelRatio,
      drawingBuffer: s.drawingBuffer,
      autoGovernor: s.autoGovernor,
      features: s.qualityBuckets.features,
      ua: navigator.userAgent,
      dpr: devicePixelRatio,
    };
  });
  console.log(
    `[${label}] ${env.tier} on ${env.glRenderer}, buffer ${env.drawingBuffer?.width}x${env.drawingBuffer?.height}`,
  );

  // Run-long governor trace from world entry on (every 250 ms), so the entry
  // phase, which the windows never see, is on record too.
  await p.page.evaluate(() => {
    const trace = { rows: [], t0: performance.now() };
    window.__orbitGovernor = trace;
    trace.id = setInterval(() => {
      const s = window.__game.renderer.perfStats();
      const b = s.renderBudget ?? {};
      trace.rows.push({
        t: Math.round(performance.now() - trace.t0),
        reason: b.reason,
        mode: b.mode,
        hold: b.stallHoldSeconds,
        lastStallMs: b.lastSubmitStallMs,
        stalls: b.recentSubmitStalls,
        prep: b.preparationFrames ?? null,
        covered: b.coveredFrames ?? null,
        resProbe: b.resolutionProbe ?? null,
        resKept: b.resolutionCutsKept ?? null,
        resReverted: b.resolutionCutsReverted ?? null,
        resGainMs: b.resolutionLastGainMs ?? null,
        emaMs: b.frameMsEma,
        submitEmaMs: b.submitMsEma,
        rs: s.effectiveRenderScale,
        programs: s.programs,
      });
    }, 250);
  });

  // Run-long program-owner trace (every 100 ms from world entry on): each program
  // that links, named by its owner, tagged with the phase the run was in (entry,
  // a spot's settle, a window). Three keeps the programs a material draws with in
  // its per-material properties, so one scene walk on a poll that saw a link
  // names the material, its object chain and its render category (the rule
  // live_program_hunt.mjs uses); a program with no owner was linked on a stand-in
  // outside the scene, which is the background prewarm lanes. Live (ungated)
  // links and gate give-ups come from the gpu-prep event feed.
  await p.page.evaluate(() => {
    const trace = { owners: [], live: [], t0: performance.now() };
    window.__orbitOwners = trace;
    window.__orbitPhase = 'entry';
    const renderer = window.__game.renderer;
    const gl = renderer.webgl;
    let lastId = -1;
    const seen = new Set();
    trace.id = setInterval(() => {
      const t = Math.round(performance.now() - trace.t0);
      const phase = window.__orbitPhase;
      const fresh = [];
      for (const p of gl?.info?.programs ?? []) {
        if (typeof p.id === 'number' && p.id > lastId) fresh.push(p);
      }
      if (fresh.length) {
        lastId = Math.max(...fresh.map((p) => p.id));
        const wanted = new Map(
          fresh.map((p) => [
            p.id,
            { t, phase, id: p.id, name: p.name ?? '', key: p.cacheKey ?? '', owner: '' },
          ]),
        );
        const props = gl.properties;
        renderer.scene?.traverse((obj) => {
          const mats = Array.isArray(obj.material)
            ? obj.material
            : obj.material
              ? [obj.material]
              : [];
          for (const mat of mats) {
            const pr = props.get(mat);
            const cands = [pr?.currentProgram, ...(pr?.programs?.values?.() ?? [])];
            for (const program of cands) {
              const entry = program ? wanted.get(program.id) : null;
              if (!entry || entry.owner) continue;
              let category = '';
              const chain = [];
              for (let node = obj; node; node = node.parent) {
                if (!category && node.userData?.renderCategory)
                  category = node.userData.renderCategory;
                if (chain.length < 4 && node.name) chain.push(node.name);
              }
              entry.owner = `${category || '?'}:${chain.join('<') || obj.type}:${mat.name || mat.type}`;
              entry.visible = obj.visible;
            }
          }
        });
        for (const e of wanted.values()) trace.owners.push(e);
      }
      for (const e of renderer.perfStats().gpuPrep?.events?.events ?? []) {
        const id = `${e.kind}|${e.key}|${e.atMs}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (e.kind === 'live-program' || /watchdog|timeout/.test(e.kind))
          trace.live.push({ t, phase, kind: e.kind, key: e.key, atMs: e.atMs });
      }
    }, 100);
  });
  const results = {
    label,
    target,
    cpuThrottle: cpu,
    entryCpuThrottle: entryCpu,
    query,
    settings,
    gameUrl,
    entrySeconds,
    device: phone ? deviceSummary() : null,
    env,
    spots: [],
  };
  const cpuProfileWindows =
    typeof opt('cpu-profile') === 'string' ? String(opt('cpu-profile')).split(',') : [];
  results.ownersT0 = await p.page.evaluate(() => window.__orbitOwners?.t0 ?? null);
  const walkName = typeof opt('walk') === 'string' ? String(opt('walk')) : null;
  const walkRoute = walkName ? WALK_ROUTES[walkName] : null;
  if (walkName && !walkRoute) {
    throw new Error(`unknown --walk route ${walkName} (known: ${Object.keys(WALK_ROUTES).join(', ')})`);
  }
  // A walk run measures the walk only, unless --spots asks for spots too.
  const spotNames =
    typeof opt('spots') === 'string' ? String(opt('spots')).split(',') : walkRoute ? [] : null;
  for (const spot of DEFAULT_SPOTS.filter((x) => !spotNames || spotNames.includes(x.name))) {
    await p.page.evaluate((n) => {
      window.__orbitPhase = `${n}:settle`;
    }, spot.name);
    await p.teleport(spot.x, spot.z, spot.f);
    // The CPU profile's start and stop each stall the phone's main thread for
    // hundreds of ms, so both stay outside the measured windows: start half way
    // through the settle, stop after the spot's last window.
    let profiled = null;
    if (cpuProfileWindows.length > 0) {
      await sleep(settleMs / 2);
      profiled = await startCpuProfile(p.page);
      await sleep(settleMs / 2);
    } else {
      await sleep(settleMs); // settle after the teleport
    }
    const spotResult = { spot: spot.name, windows: [] };
    // --eval FILE: an expression evaluated in the page once the spot has
    // settled (a one-off probe: node counts, a snapshot), kept as spotResult.eval.
    if (typeof opt('eval') === 'string') {
      const source = fs.readFileSync(String(opt('eval')), 'utf8');
      spotResult.eval = await p.page.evaluate(source).catch((e) => ({ error: String(e) }));
    }
    for (const w of windows) {
      await p.page.evaluate((n) => {
        window.__orbitPhase = n;
      }, `${spot.name}:${w.name}`);
      await p.page.evaluate((x) => {
        const input = window.__game.input;
        input.setTouchLook(x !== 0);
        input.setTouchLookVector({ x, y: 0 });
      }, w.look);
      // 100 ms governor poll + a raw per-callback trace: interval, sim ticks advanced
      // (sim.time moves 0.05 s per 20 Hz tick) and the cumulative draw-call counter,
      // which only moves on callbacks the renderer actually drew on.
      await p.page.evaluate(() => {
        const poll = { rows: [] };
        window.__orbitPoll = poll;
        poll.id = setInterval(() => {
          const s = window.__game.renderer.perfStats();
          poll.rows.push({
            ers: s.effectiveRenderScale,
            lv: s.renderBudget?.levels ?? null,
            sh: s.shadowExtentStep,
            post: s.postShedRung,
            programs: s.programs,
            reason: s.renderBudget?.reason ?? null,
            mode: s.renderBudget?.mode ?? null,
            // deferred link-gate pacing (fix builds only): links, waits, waiting
            lg: s.linkGate ?? null,
          });
        }, 100);
        const pace = { dt: [], ticks: [], calls: [], at: [], run: true };
        window.__orbitPace = pace;
        const sim = window.__game.sim ?? window.__game.world;
        const info = window.__game.renderer?.webgl?.info?.render;
        let last = performance.now();
        let lastT = sim?.time ?? 0;
        const frame = (now) => {
          if (!pace.run) return;
          pace.dt.push(Math.round((now - last) * 100) / 100);
          last = now;
          const t = sim?.time ?? 0;
          pace.ticks.push(Math.round((t - lastT) / 0.05));
          lastT = t;
          pace.calls.push(info?.calls ?? -1);
          // On the program trace's clock, so a long gap lines up with the
          // programs created around it (programOwners[].t).
          pace.at.push(Math.round(now - (window.__orbitOwners?.t0 ?? 0)));
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      const s = await p.sample({ ms, label: `${spot.name}:${w.name}` });
      const { rows, pace, owners, live } = await p.page.evaluate((n) => {
        clearInterval(window.__orbitPoll.id);
        window.__orbitPace.run = false;
        const { dt, ticks, calls, at } = window.__orbitPace;
        const tr = window.__orbitOwners;
        return {
          rows: window.__orbitPoll.rows,
          pace: { dt, ticks, calls, at },
          owners: tr.owners.filter((o) => o.phase === n),
          live: tr.live.filter((o) => o.phase === n),
        };
      }, `${spot.name}:${w.name}`);
      await p.page.evaluate(() => {
        window.__game.input.setTouchLookVector({ x: 0, y: 0 });
        window.__game.input.setTouchLook(false);
      });
      const row = {
        window: w.name,
        look: w.look,
        newPrograms: (s.newPrograms ?? []).length,
        programOwners: owners,
        livePrograms: live,
        freezes: {
          worstMs: s.freezes?.worstMs,
          count: s.freezes?.hitchCount,
          byCause: s.freezes?.byCause,
        },
        loopFrames: s.frame, // the profiler's view: counts skipped limiter callbacks too
        drawn: drawnFrameStats(pace),
        poll: summarizePoll(rows),
        report: s,
        pace,
      };
      spotResult.windows.push(row);
      const d = row.drawn;
      console.log(
        `[${label}] ${spot.name.padEnd(5)} ${w.name.padEnd(7)} drawn/s ${d.drawnPerSec} median ${d.medianMs}ms ` +
          `p99 ${d.p99Ms}ms max ${d.maxMs}ms | renderer ${s.mainRendererMs}ms | new shaders ${row.newPrograms} ` +
          `${JSON.stringify(row.freezes.byCause ?? {})}`,
      );
    }
    if (profiled) {
      await stopCpuProfile(profiled, p.page, out.replace(/\.json$/, `.${spot.name}.cpuprofile`));
    }
    results.spots.push(spotResult);
  }
  // Walk legs (--walk ROUTE): the player walks each leg for real (forced
  // click-to-move along the leg's waypoints) while the bench records every
  // callback with the player's position, and the renderer's build ledger
  // (zone features, views) on the program trace's clock, so a long frame can
  // be matched to the streaming build that ran inside it.
  if (walkRoute) {
    results.walk = { route: walkName, legs: [] };
    await p.page.evaluate(() => {
      window.__orbitPhase = 'walk:settle';
    });
    await p.teleport(walkRoute.start.x, walkRoute.start.z, walkRoute.start.f);
    let profiled = null;
    if (cpuProfileWindows.length > 0) {
      await sleep(settleMs / 2);
      profiled = await startCpuProfile(p.page);
      await sleep(settleMs / 2);
    } else {
      await sleep(settleMs);
    }
    await p.page.evaluate(() => {
      const builds = [];
      window.__orbitBuilds = builds;
      const ledger = window.__game.renderer?.buildLedger;
      if (ledger && !ledger.__orbitWrapped) {
        const record = ledger.record;
        ledger.record = function (kind, ms, atMs) {
          builds.push({
            kind,
            ms: Math.round(ms * 10) / 10,
            t: Math.round(atMs - (window.__orbitOwners?.t0 ?? 0)),
            phase: window.__orbitPhase,
          });
          return record.call(this, kind, ms, atMs);
        };
        ledger.__orbitWrapped = true;
      }
    });
    for (const leg of walkRoute.legs) {
      const phase = `walk:${leg.name}`;
      const from = await p.page.evaluate(() => {
        const pos = (window.__game.sim ?? window.__game.world).player.pos;
        return { x: pos.x, z: pos.z };
      });
      const lengthYd = pathLength(from, leg.path);
      const zonesBefore = await p.page.evaluate(() => [
        ...(window.__game.renderer?.preparedZones ?? []),
      ]);
      await p.page.evaluate(
        (phase, path) => {
          window.__orbitPhase = phase;
          const pace = { dt: [], calls: [], at: [], x: [], z: [], fog: [], run: true };
          const scene = window.__game.renderer?.scene;
          window.__orbitPace = pace;
          const sim = window.__game.sim ?? window.__game.world;
          const info = window.__game.renderer?.webgl?.info?.render;
          let last = performance.now();
          const frame = (now) => {
            if (!pace.run) return;
            pace.dt.push(Math.round((now - last) * 100) / 100);
            last = now;
            pace.calls.push(info?.calls ?? -1);
            pace.at.push(Math.round(now - (window.__orbitOwners?.t0 ?? 0)));
            pace.x.push(Math.round(sim.player.pos.x * 10) / 10);
            pace.z.push(Math.round(sim.player.pos.z * 10) / 10);
            pace.fog.push(Math.round(scene?.fog?.far ?? -1));
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
          const goal = path[path.length - 1];
          window.__game.input.setClickMoveTarget(goal, 1, null, path, false, true);
        },
        phase,
        leg.path,
      );
      // Arrived, stuck (under 2 yd of progress in 8 s) or out of time (twice
      // the running time plus 15 s): the window ends on whichever comes first.
      const goal = leg.path[leg.path.length - 1];
      const startedAt = Date.now();
      const capMs = (lengthYd / 7) * 2000 + 15000;
      let outcome = 'timeout';
      let lastProgress = { at: Date.now(), x: from.x, z: from.z };
      // Low scenery band state every poll, when the build exposes the
      // diagnostic `__bandProbe` hook (the scenery_detail snapshot).
      const bands = [];
      const until = async () => {
        while (Date.now() - startedAt < capMs) {
          await sleep(500);
          const pos = await p.page.evaluate(() => {
            const pp = (window.__game.sim ?? window.__game.world).player.pos;
            const b = window.__bandProbe?.();
            const band = b
              ? { active: b.active, pending: b.pending, stage: b.stage, at: b.at, uncovered: b.uncoveredFoliage }
              : null;
            return { x: pp.x, z: pp.z, band };
          });
          if (pos.band) bands.push({ t: Date.now() - startedAt, x: Math.round(pos.x), z: Math.round(pos.z), ...pos.band });
          if (Math.hypot(pos.x - goal.x, pos.z - goal.z) < 3) {
            outcome = 'arrived';
            return;
          }
          if (Math.hypot(pos.x - lastProgress.x, pos.z - lastProgress.z) >= 2) {
            lastProgress = { at: Date.now(), ...pos };
          } else if (Date.now() - lastProgress.at > 8000) {
            outcome = `stuck at ${pos.x.toFixed(0)},${pos.z.toFixed(0)}`;
            return;
          }
        }
      };
      const s = await p.sample({ label: phase, until });
      const trace = await p.page.evaluate((n) => {
        window.__orbitPace.run = false;
        window.__game.input.clearClickMove();
        const { dt, calls, at, x, z, fog } = window.__orbitPace;
        const tr = window.__orbitOwners;
        return {
          pace: { dt, calls, at, x, z, fog },
          builds: window.__orbitBuilds.filter((b) => b.phase === n),
          owners: tr.owners.filter((o) => o.phase === n),
          live: tr.live.filter((o) => o.phase === n),
        };
      }, phase);
      // One-frame draw census at the leg's end: every renderBufferDirect call of
      // the next frame, counted by render target (screen or offscreen) and the
      // drawn object's top two scene ancestors plus material type, so a draw-call
      // difference between builds names its owner.
      const census = await p.page.evaluate(
        () =>
          new Promise((resolve) => {
            const webgl = window.__game.renderer?.webgl;
            if (!webgl?.renderBufferDirect) return resolve(null);
            const original = webgl.renderBufferDirect;
            const counts = new Map();
            webgl.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
              const chain = [];
              for (let o = object; o && o.parent; o = o.parent) chain.push(o.name || o.type);
              const top = chain.reverse().slice(0, 2).join('<');
              const target = webgl.getRenderTarget() ? 'offscreen' : 'screen';
              const key = `${target} | ${top} | ${material?.type ?? '?'}`;
              counts.set(key, (counts.get(key) ?? 0) + 1);
              return original.apply(this, arguments);
            };
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                webgl.renderBufferDirect = original;
                resolve(
                  [...counts]
                    .sort((a, b) => b[1] - a[1])
                    .map(([key, calls]) => ({ key, calls })),
                );
              }),
            );
          }),
      );
      // Zone feature groups: visible, and registered with the fog-cull sweep?
      const featureGroups = await p.page.evaluate(() => {
        const r = window.__game.renderer;
        const entries = r?.zoneFeatureGroups ?? [];
        const registered = new Set(entries.map((e) => e.group));
        const out = [];
        for (const child of r?.scene?.children ?? []) {
          if (!/features|flora/.test(child.name ?? '')) continue;
          const cullChildren = entries.filter((e) => e.group === child || e.group.parent === child);
          out.push({
            name: child.name,
            visible: child.visible,
            registered: registered.has(child) || cullChildren.length > 0,
            culledVisible: cullChildren.filter((e) => e.group.visible).length,
            culledTotal: cullChildren.length,
          });
        }
        return out;
      });
      const zonesAfter = await p.page.evaluate(() => [
        ...(window.__game.renderer?.preparedZones ?? []),
      ]);
      const bandLog = await p.page.evaluate(() => window.__bandProbe?.()?.diagLog ?? null);
      const row = {
        leg: leg.name,
        outcome,
        bands,
        bandLog,
        census,
        featureGroups,
        zonesBefore,
        zonesNew: zonesAfter.filter((id) => !zonesBefore.includes(id)),
        zonesDropped: zonesBefore.filter((id) => !zonesAfter.includes(id)),
        lengthYd: Math.round(lengthYd),
        seconds: Math.round((Date.now() - startedAt) / 100) / 10,
        drawn: drawnFrameStats(trace.pace),
        longFrames: walkLongFrames(trace.pace, trace.builds),
        builds: trace.builds,
        programOwners: trace.owners,
        livePrograms: trace.live,
        newPrograms: (s.newPrograms ?? []).length,
        freezes: {
          worstMs: s.freezes?.worstMs,
          count: s.freezes?.hitchCount,
          byCause: s.freezes?.byCause,
        },
        report: s,
        pace: trace.pace,
      };
      results.walk.legs.push(row);
      const d = row.drawn;
      const slowBuilds = trace.builds.filter((b) => b.ms >= 16);
      console.log(
        `[${label}] walk ${leg.name.padEnd(8)} ${outcome} in ${row.seconds}s | drawn/s ${d.drawnPerSec} ` +
          `median ${d.medianMs}ms p99 ${d.p99Ms}ms max ${d.maxMs}ms | frames>=100ms ${row.longFrames.length} ` +
          `| live ${trace.live.length} | zones +${row.zonesNew.join(',') || '-'} -${row.zonesDropped.join(',') || '-'} | builds>=16ms ${slowBuilds.map((b) => `${b.kind}:${Math.round(b.ms)}`).join(' ')}`,
      );
    }
    if (profiled) {
      await stopCpuProfile(profiled, p.page, out.replace(/\.json$/, '.walk.cpuprofile'));
    }
  }
  results.governorTrace = await p.page.evaluate(() => {
    clearInterval(window.__orbitGovernor.id);
    return window.__orbitGovernor.rows;
  });
  // Every program the run linked, by phase (the windows carry their own slice).
  results.programTrace = await p.page.evaluate(() => {
    clearInterval(window.__orbitOwners.id);
    const { owners, live } = window.__orbitOwners;
    return { owners, live };
  });
  results.entryGuard = entryGuard;
  if (thermalTimer) clearInterval(thermalTimer);
  results.thermal = summarizeThermal(thermal);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`[${label}] wrote ${out}`);
  if (results.thermal) console.log(`[${label}] thermal ${JSON.stringify(results.thermal)}`);
  if (phone) await p.page.close().catch(() => {});
  else await p.browser.close().catch(() => {});
  return 0;
}

function table() {
  if (!positional.length) {
    console.error('usage: node scripts/orbit_bench.mjs table <result.json>...');
    return 1;
  }
  for (const f of positional) console.log(`${formatRunTable(readRun(f))}\n`);
  return 0;
}

function calibrate() {
  const refFile = opt('reference');
  if (typeof refFile !== 'string' || !positional.length) {
    console.error(
      'usage: node scripts/orbit_bench.mjs calibrate --reference <phone.json> <emulation.json>...',
    );
    return 1;
  }
  const reference = readRun(refFile);
  const rows = positional
    .filter((f) => path.resolve(f) !== path.resolve(refFile))
    .map((f) => {
      const emu = readRun(f);
      return { label: emu.label ?? f, ratios: calibrationRatios(reference, emu) };
    });
  console.log(formatCalibration(reference.label ?? refFile, rows));
  return 0;
}

const COMMANDS = {
  run,
  table,
  calibrate,
  'build-devmode': buildDevmode,
  serve,
  'android-setup': androidSetup,
  'android-teardown': androidTeardown,
  thermal: thermalLoop,
};

const handler = COMMANDS[command];
if (!handler) {
  console.error(
    `usage: node scripts/orbit_bench.mjs <${Object.keys(COMMANDS).join('|')}> (see the header for options)`,
  );
  process.exit(1);
}
Promise.resolve(handler())
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
