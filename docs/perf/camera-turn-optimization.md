# Camera-turn performance: plan, method and tools

Living runbook for the "the game gets unstable when I rotate the camera" program.
It records what has been measured, how to measure it again, which tools to use for
which question, and the clues any optimization must check. Fixes land later, in
their own PRs, each judged by the method here.

The short version: **iterate on the desktop, give the verdict on a real phone.**
Desktop Chrome in landscape phone emulation at 1.5x CPU reproduces a mid-range
Android phone's main-thread cost per frame. Only the phone shows how long shader
compiles freeze, Android's frame rhythm, the automatic 30 FPS lock, heat and memory.

## 1. What is known (2026-11-11)

Reference phone: Nothing A059, Snapdragon 7s Gen 3 (Chrome reports "Adreno (TM) 810"),
Android 16, Chrome 156, 1080x2392 at DPR 2.625, 120 Hz panel, 11.7 GB RAM.
Reference desktop: RTX 3070, Edge with ANGLE D3D11. Branch `release/v0.46.0`.
Offline world, Low preset unless stated. Numbers are same-machine relative.

| Finding | Evidence |
|---|---|
| Chrome ran the frame loop at 60 Hz on the phone, not 120 Hz, in the first session (2026-11-11). Every session since ran at 90 Hz, likely the phone's adaptive refresh rate; the bench does not pin it, so compare phone runs within one rhythm. | 2026-11-11: nearly every callback interval 16.6 ms, a miss 33.3 ms. From 2026-11-12: drawn-frame gaps in multiples of 11.1 ms (`pace.dt`). |
| In town the phone misses that rhythm on many frames, mixing 16.6 and 33.3 ms gaps (about 40 drawn FPS). Turning makes the unevenness visible. | Drawn frames 39 to 42 per second, gap p99 66 ms while standing and on the first turn. |
| The automatic Frame Rate Limit then locks the phone to 30 FPS for the session and later sessions. | Exactly 150 drawn frames per 5 s window from the second town sweep on; open field locked at 30.0. |
| The first turn toward unseen scenery compiles shaders inside live frames. Worst on the phone, present on the desktop too. | Phone first town turn: worst frame 509 ms, 9 compile hitches, 29 new programs. Desktop Ultra first sweep 806 ms, warm sweeps about 30 ms. |
| On the phone, town keeps linking new programs on later turns and even while standing. | Up to 47 new programs per window after the first sweep, freezes up to 537 ms. |
| Low on the phone is CPU-bound, not GPU-bound. | Render scale 0.85 vs 0.5 (2.9x the pixels) moves FPS by about 5% and renderer time not at all. Main thread about 21 ms per frame (renderer 15.5, of it submit about 10). |
| The quality governor treats one-off compile stalls as sustained load and stays degraded. | Every configuration, the RTX 3070 included, sat in `submit-stall` with render scale at the floor (0.68 to 0.76) or AO off on Ultra, and never recovered during a run. |
| Medium is not viable on this phone. | About 23 drawn FPS standing or turning, 33 ms main thread, 853 MB JS heap (Low: 256 MB), governor ends "floored". |
| The phone was not thermally throttled in any run. | Thermal status 0, skin 27 to 32 C, CPU at most about 50 C, no active cooling device. |

## 2. Clues to check when optimizing

Each clue names where to look. Re-verify against code first: these were true on
`release/v0.46.0`.

1. **The governor's submit-stall rule.** `src/render/render_budget.ts`: any frame with
   a raw submit at or above `SUBMIT_STALL_MS` degrades one rung on the spot, bypassing
   the cooldown, and sets a hold from `SUBMIT_STALL_HOLD_SECONDS` (longest on Low);
   `stallPressure` decays slowly. A shader link at first draw lands inside submit, so
   a one-off compile reads as overload. Candidate: do not count a stall that coincides
   with a program link or texture upload (the profiler already attributes these, see
   `attributeFreezes` in `scripts/profiler/metrics.mjs`), or shorten the hold.
2. **Resolution is the wrong lever on a CPU-bound device.** The dynamic-resolution floor
   is `MIN_DYNAMIC_RENDER_SCALE` (`src/render/dynamic_resolution_core.ts`); the mobile
   start cap is `initialEffectiveRenderScale`. On the phone, shedding resolution costs
   sharpness and buys almost nothing. The governor cannot tell CPU-bound from GPU-bound
   (its own comment says every reading is CPU-side).
3. **First-sight preparation is view-driven.** Reveal gates, prop and town reveals and the
   occluder fade compile when content enters the view (`reveal_gate_core.ts`,
   `town_reveal_core.ts`, `occluder_fade_gate.ts`; see `src/render/CLAUDE.md`, "World-entry
   prewarm" and "GPU work"). A camera can turn at any moment, so nearby content in every
   direction is a candidate for background preparation. The original acceptance bar from
   the player-performance program fits: the program count stays flat during a Low orbit
   (`docs/design/player-performance/brainstorm.md`, Packet 5).
4. **Town is the hot spot.** Most distinct materials and the most reveal keys; most of the
   new programs per sweep and every large freeze were in town, almost none in the open field.
5. **The phone needs program links that the desktop driver hides.** The desktop links a
   similar number of new programs per sweep (46 vs 96 to 111 on the phone) but each costs a
   fraction. The shader warm-up worker is `off` on every GLES backend by measurement
   (`shader_warm_client_core.ts`); do not expect it to help Android.
6. **The Frame Rate Limit decides what "smooth" means on the phone.**
   `src/game/frame_cadence_auto_core.ts` lowers the ceiling to 30 once the display rhythm
   is demonstrably missed, and remembers the verdict (`woc_frame_cadence_auto` in site
   storage, `frame_cadence_auto_memory.ts`). Getting the town frame under 16.6 ms is what
   keeps a phone at 60; anything less ends at the 30 lock.
7. **Where the phone's main thread goes on Low** (open field, warm): sim about 3.7 ms,
   renderer about 15.5 ms (submit about 10, world about 3, entities about 2.3, nameplates
   about 0.6), HUD about 2.1 ms. Submit is the largest single phase on both devices.
8. **Draw calls rise 40 to 60% while turning**, even once everything is ready, on both
   devices. Desktop Low: about 148 to 236 calls.
9. **The nameplate canvas repaints in full on every frame the camera moves**
   (`nameplate_paint_gate_core.ts` skips only unchanged frames), at device pixel ratio up to
   2. Measured cheap on the phone (about 0.6 ms main thread), but its GPU composite cost on a
   phone is unmeasured.
10. **Chrome's on-disk shader cache persists across runs and sessions.** A first run on a phone
    is the first-time player; later runs reuse what it compiled. Compare like with like.
11. **The first revealed frame freezes for about a second.** The game's frame loop starts under
    the loading screen two frames before the entry cover is raised (`src/main.ts`,
    `requestAnimationFrame(frame)` then the first-paint callback that calls
    `settleWorldEntryCover`). On the desktop proxy that first full draw, and the frames as the
    curtain lifts, cost about 1 s; a CPU profile of the 1.5 s after the reveal showed about 1.2 s
    of main-thread work OUTSIDE the game's JavaScript (style, layout and paint: the whole HUD
    becomes visible at once), with almost no shader links or uploads. Players feel this as a
    freeze right after loading. Confirm with a Chrome performance trace before fixing.
12. **The governor (Phase 1) no longer reacts to one-off costs**, so its state now tells the truth:
    "floored" means the frame really is over Low's drop budget (about 23 ms of CPU work against
    22 ms on the desktop proxy). From here the governor cannot help; only cheaper frames can
    (Phase 3).
13. **On a phone without parallel compile, every compile gate is off** (Phase 2, 2026-11-11,
    measured on the reference phone). Its Chrome lacks `KHR_parallel_shader_compile`, and the
    renderer then switches off every gate wholesale (`asyncCompileSupported` false in
    `renderer.ts`: reveal, view, swap and effect gates, the boot compile lanes). The entry prewarm
    links almost nothing (`programs=31->33 compile=none`), and scenery links in the frame it is
    first drawn: 26 live programs on the first town turn (houses, town glow, trees, lamps, an NPC's
    head parts, the ghost fade), up to seven in one 343 ms frame. The desktop never showed this
    because its browser has the extension; `--no-parallel-compile` hides it, and the desktop then
    reproduces the phone (29 new, 24 live, worst 486 ms). Background boot debt (the spirit-veil
    family, 51 programs, `--entry-cpu 4` mimics the phone's slow entry) also drains through the
    windows, but it is gated and minor next to the live links.
    A probe on the phone (salted, never-cached programs): issuing a link costs about 2 ms and no
    hitch, a LINK_STATUS query 1.5 s later about 4 ms (Chrome linked it in its GPU process), the
    same program met first at draw time hitches. So the premise "no extension, no gate" is false
    for Chromium. But simply turning the gates on there (`fix/deferred-link-gates`,
    `link_gate_mode_core.ts`) is not a win, measured on the phone: the first town turn improved
    (worst 343 to 77 ms, live links 23 to 3), the hitches moved to the idle window and the second
    turn (398 and 310 ms), and renderer time rose 2 to 4 ms on every frame (the preparation
    machinery now running), which tipped the open field into the 30 FPS lock. Chrome's GPU process
    runs commands in order, so a gate issuing a whole piece's links at once queues the next
    frame behind all of them; the single-link probe hid in spare GPU time, a batch cannot.
    A version that works would issue at most one link per frame and keep the steady cost off.

## 3. Method

### Which device answers which question

| What is being fixed | Measure on | Judge by |
|---|---|---|
| CPU cost per frame (renderer, submit, sim, HUD) | Desktop, `--target emulation --cpu 1.5` | ms per phase against a stored baseline |
| Shader compiles while turning | Desktop for the count, phone for the freeze length | new programs per sweep; worst drawn gap on the phone |
| Smoothness: the vsync rhythm (60 or 90 Hz) vs the 30 lock, even frames, governor behaviour | Phone over USB | drawn frames per second, drawn-gap median and p99 |
| Heat, memory, Android-only screens and paths | Phone over USB | thermal summary, heap, a clean entry |

Calibration (2026-11-11, Low, warm windows, emulation divided by phone):

| Desktop emulation | sim | renderer | submit | HUD | total |
|---|---|---|---|---|---|
| landscape, CPU 1.5x | 1.03 | 0.93 | 0.91 | 0.89 | **0.94** |
| landscape, CPU 2x | 1.34 | 1.27 | 1.23 | 1.29 | 1.28 |

A second 1.5x run, through `orbit_bench.mjs` itself, gave a total of 1.05, so expect about +/-10%
between runs. A phone run through the same tool with cleared storage reproduced the first-run
findings: a 498 ms worst frame on the first town turn (26 new programs), then the 30 FPS lock.

Re-calibrate (section 5) when the reference phone, the desktop or Chrome changes.

Not useful for performance: the Android Studio emulator. It runs Android on the PC's own
CPU and GPU behind virtualization, so it measures neither device; use it only to check
Android-only flows when no phone is at hand. Portrait emulation is also wrong: the game shows
a rotate prompt over a narrower view while the world keeps rendering under it.

### Metrics that matter

- **Drawn frames per second and drawn-frame gaps** (`drawn` in a result). Never judge a phone
  by the profiler's `fpsMean`: it counts frame-loop callbacks, including the ones the Frame Rate
  Limit skips, so it reads about twice the real rate once the limit is on.
- **Main-thread ms per phase** (`mainSimMs`, `mainRendererMs`, `phaseSubmitMs`, `phaseWorldMs`,
  `phaseEntitiesMs`, `mainHudMs`): the numbers that transfer from desktop to phone.
- **New programs per window and hitch causes** (`newPrograms`, `freezes.byCause`).
- **Governor state** (`poll`: render-scale range and changes, budget levels, shadow and post
  rungs) and the report's `budgetMode` / `budgetReason`.
- **Thermal summary** on phone runs (`thermal`): any active cooling device marks the run as
  throttled.

Discipline: at least 3 repeats per configuration on an idle machine (same-config runs varied
by up to 2x), the same served build on both sides of a comparison, and first-sweep vs warm-sweep
numbers reported separately.

## 4. Tools

### New for this program

| Tool | What it does |
|---|---|
| `node scripts/orbit_bench.mjs run --target desktop\|emulation\|android` | The camera-turn bench: two spots (town, open field), stand still, three identical sweeps, stand still. Writes `tmp/orbit-bench/<label>.json` with the profiler sample, a 100 ms governor poll, a raw per-callback trace and the drawn-frame stats; phone runs add device and thermal summaries. |
| `node scripts/orbit_bench.mjs run ... --walk north` | The streaming bench: instead of the orbit spots, the player walks a route for real (forced click-to-move along road waypoints, `WALK_ROUTES` in `scripts/lib/orbit_bench_core.mjs`). `north` runs from Eastbrook's town through Fenbridge into Thornpeak and back. Per leg: drawn-frame stats, every drawn frame of 100 ms or more with the player's position and the renderer builds inside it (the build ledger, hooked for the run), live links, and which zones became resident or were dropped. Add `--cpu-profile all` for one profile over the whole walk (`<label>.walk.cpuprofile`). |
| `node scripts/orbit_bench.mjs table <result.json>...` | Per-window table: drawn frames per second, gap median, p99 and max, drawn share, phase split, new programs, hitch causes. |
| `node scripts/orbit_bench.mjs calibrate --reference <phone.json> <emu.json>...` | Per-phase cost ratios of emulation runs against a phone run. |
| `node scripts/orbit_bench.mjs build-devmode` / `serve` | A bundled development build (offline world enabled) served on :4173 for the phone and for desktop runs compared against it. |
| `node scripts/orbit_bench.mjs android-setup` / `android-teardown` | Checks the device, tunnels DevTools and the game port over USB, turns "stay awake while charging" on (and off again). |
| `node scripts/orbit_bench.mjs thermal` | Standalone thermal and battery sampler (status, temperatures, active cooling devices, battery level). |
| `scripts/profiler/android_target.mjs` | Reusable phone glue for any Profiler script: adb helpers, Chrome attach, Node-side waits, phone entry helpers, site-storage clear. |
| `scripts/lib/orbit_bench_core.mjs`, `scripts/lib/android_device_parse.mjs` | Pure halves, pinned by `tests/orbit_bench_core.test.ts` and `tests/android_device_parse.test.ts`. |

### Existing tools that apply

| Tool | Use it for |
|---|---|
| `scripts/profile.mjs` (scenarios `play`, `walk`, `freeze`, `tiers`) over `scripts/profiler/` | Hitch attribution on longer routes; `play` includes camera look. |
| `scripts/perf_baseline.mjs` | Average FPS and CPU/GPU per preset with a stored history (`docs/perf/baseline/`); add an orbit scenario here once fixes start (Phase 3). |
| `scripts/perf_hitch.mjs` | Frame-consistency referee for first-draw stalls, GC stutter, heap ratchet. |
| `live_program_hunt.mjs` + the `hunt-live-programs` skill | Naming the programs that link live, online, by owner. |
| `scripts/gpu_hitch_capture.mjs` (`docs/perf/gpu-hitch-capture.md`) | Raw WebGL link timeline for a specific hitch. |
| `shader_harvest.mjs` + `shader_link_bench.mjs` | Price each program's link cost per backend; the bench runs without the game. |
| `?perf` overlay, `__game.renderer.perfStats()` | `gpuPrep` events (`live-program`, `reveal-watchdog`), `renderBudget`, `buildLedger`, `phaseMs`. |
| Fleet perf beacon (`src/game/perf_reporter.ts`, `server/perf_report.ts`) | Production breadth per GPU family; has no camera-turning dimension yet (Phase 0). |

### URL flags and settings that isolate a cause

| Flag | Effect |
|---|---|
| `?gfx=low\|medium\|high\|ultra\|insane` | Force a tier (`--tier` does this). |
| `?governor=off` | Disable the runtime quality governor. |
| `?postshed=off` | Disable the post-chain shed. |
| `?prep=legacy` | Old GPU-prep admission (every unit at once). |
| `?gputimer=1` | GPU-side time per bracket where `EXT_disjoint_timer_query_webgl2` exists (not on Android Chrome). |
| `?shaderwarm=off\|all` | Pin the shader warm-up worker. |
| `?gfxo=<key>:<value>` | Override one `GFX` setting. |
| `?boot=now` | Start the client at once instead of waiting for a tap on the landing page (the bench sets it). |
| `--settings '{"renderScale":0.5}'` | Seed `woc_settings` keys before boot (render scale, preset). |

## 5. Runbook

### Once per machine

```sh
pnpm install --frozen-lockfile
node scripts/orbit_bench.mjs build-devmode       # rebuild after every code change you test
node scripts/orbit_bench.mjs serve               # keep running; serves :4173
```

### Desktop iteration loop (most of the work)

```sh
# baseline before a change, then the same after it; 3 repeats each
node scripts/orbit_bench.mjs run --target emulation --tier low --cpu 1.5 --label base-1
node scripts/orbit_bench.mjs run --target emulation --tier low --cpu 1.5 --label fix-1
node scripts/orbit_bench.mjs table tmp/orbit-bench/base-1.json tmp/orbit-bench/fix-1.json
```

A browser window opens and drives itself; leave it alone and keep the machine idle.
Rebuild (`build-devmode`) and restart `serve` between the baseline and the fix. Judge by
phase milliseconds and new programs per sweep, never by desktop FPS.

### Phone verdict (before and after a fix, and before merge)

1. On the phone: Developer options on, USB debugging on, plug in, tap **Allow** on the
   "Allow USB debugging?" prompt, open Chrome, keep it unlocked and in front.
2. `node scripts/orbit_bench.mjs android-setup` (prints device, Chrome and screen state).
3. `node scripts/orbit_bench.mjs run --target android --tier low --label phone-base-1`
   (entry takes about 1 to 4 minutes over USB; the probe opens and closes its own tab and
   never touches other tabs).
4. `node scripts/orbit_bench.mjs table tmp/orbit-bench/phone-base-1.json`
5. When finished: `node scripts/orbit_bench.mjs android-teardown` (turns stay-awake off).

Read the drawn columns: a fixed town holds about 60 drawn frames per second with a 16.6 ms
median and no gap over 33 ms, and the Frame Rate Limit never engages (`drawn%` stays 100).

### Re-calibrating the desktop proxy

Run the phone once, then emulation at two throttles, and pick the factor whose total is
closest to 1.00:

```sh
node scripts/orbit_bench.mjs run --target android --tier low --label phone-ref
node scripts/orbit_bench.mjs run --target emulation --tier low --cpu 1.5 --label emu-1.5
node scripts/orbit_bench.mjs run --target emulation --tier low --cpu 2 --label emu-2
node scripts/orbit_bench.mjs calibrate --reference tmp/orbit-bench/phone-ref.json tmp/orbit-bench/emu-1.5.json tmp/orbit-bench/emu-2.json
```

Chrome's CPU throttle is not linear (4x measured about 9x on this machine), so always
calibrate rather than guess.

## 6. Traps found while building this

- The offline world is disabled in release builds (`src/game/offline_mode_gate.ts`), and
  `vite build --mode development` alone still compiles it out: `NODE_ENV=development` is what
  makes `import.meta.env.DEV` true (`build-devmode` sets both).
- The Vite dev server's unbundled modules took over 2 minutes to load over USB; use the bundle.
- On a first visit the landing page paints without the client; a scripted click does not start
  it. `?boot=now` does.
- Phone hardware shows the "add to home screen" preflight before character select, and the
  client wires the mode-select buttons late; `installPhoneEntryHelpers` handles both.
- Puppeteer's in-page waits stall over Android DevTools; `installNodeSideWaits` polls from Node.
- A sleeping screen stops requestAnimationFrame and freezes entry on "Loading world..." with no
  error; `android-setup` turns stay-awake on, and a locked screen still blocks it.
- Runs on one origin share site storage: a seeded render scale and the Frame Rate Limit's verdict
  leaked into later runs until the bench started clearing storage per run (`--keep-storage` opts out).
- Portrait emulation shows the rotate prompt over a narrower view; emulation is landscape.
- Run-to-run variance reached 2x on the desktop when another process (a test run) overlapped.
- `gpu_hitch_capture.mjs` and `profiler/cpu_profile_window.mjs` silently did nothing on Windows:
  their entry guard compared `import.meta.url` with `file://${process.argv[1]}`, which never match
  there. Both now compare resolved paths.
- `gpu_hitch_capture.mjs --mode offline` does not enter a bundled build (the early offline click
  is lost); point it at a Vite dev server, where entry works on the desktop.
- Edge occasionally fails to create a WebGL context ("Could not start the renderer"); the bench
  now fails fast on the fatal overlay instead of waiting out its entry timeout, and the run
  loops in this program retry once.
- "Stay awake while charging" keeps the screen on but cannot unlock it: once the phone has
  dozed onto its lock screen (for example between sessions, after `android-teardown`), the run
  fails at "phone is asleep or locked" until someone unlocks it by hand.
- A CPU profile start or stop stalls the phone's main thread 0.5 to 1.5 s, so `--cpu-profile`
  starts mid-settle and stops after the last window; never wrap a measured window with it.
- An unseated RAM module crashed the desktop twice mid-run (Windows logged WHEA fatal hardware
  errors); hardware faults look like flaky benches.
- Building the bench bundle by hand: `NODE_ENV=development` is required (see the first trap);
  without it the build stalls entry silently, with no page error. A release-shaped build
  (no `NODE_ENV`) also asks for content-hashed `/media/` URLs that only
  `build_media_manifest.mjs emit` writes (into `dist/media`), and `vite preview` answers the
  missing files with `index.html` (200, text/html), which the loader reports as "missing file or
  bad GLB". Prefer `orbit_bench.mjs build-devmode --out <dir>`; add `--minify false` by hand
  for a readable profile.
- On 2026-11-13 Edge 157 on this desktop stopped creating WebGL2 contexts at all (fresh profile,
  even on about:blank; "Web page caused context loss and was blocked"), while Chrome 157 on the
  same GPU works. `browser_path_resolve.mjs` prefers Edge on Windows, so set `BROWSER_PATH` to
  Chrome; numbers taken on Edge and on Chrome are not one series.
- `enter_offline_game.mjs` clicked `#btn-offline` once, as soon as it existed; the button is
  static HTML, so on a slower load the click landed before the client wired it and entry waited
  out its whole timeout. It now clicks every 2 s until the select opens.

## 7. Plan

Optimization is a later step; this is the order the evidence supports. Each fix is measured
desktop-first and given a phone verdict before merge.

**Phase 0: instruments (this change, plus follow-ups)**
- Done: the orbit bench on desktop, emulation and phone; the calibrated desktop proxy; thermal
  sampling; the clues above.
- Next: make the profiler count drawn frames (`scripts/profiler/metrics.mjs` `frameStats` reads
  every callback); add a camera-turning vs still dimension and time-per-governor-reason to the
  perf beacon so the fleet shows who is affected; capture baselines on at least one Mali phone
  and one iPhone.

**Phase 1: governor (desktop done 2026-11-11, branch `fix/governor-prep-stall`; phone verdict pending)**
- Done: frames whose span linked a shader program are read with neutral timings (bounded);
  frames under a loading cover, before the world's first reveal (bounded) and for 2 s after a
  reveal are read the same way; every resolution cut is an A/B experiment and is undone (with a
  60 s lockout) when it does not make the frame cheaper (`?resprobe=off` disables it).
- Desktop proxy, 3 interleaved runs each: time in a submit-stall hold 45% to 0%, no submit
  stall recorded at all, FPS and main-thread time unchanged; resolution cuts kept 2, undone 1
  (the desktop GPU makes resolution matter a little even here).
- Acceptance still to check on the phone: `budgetReason` is not `submit-stall` for most of a
  run, and resolution experiments are undone on the CPU-bound phone (render scale not at the
  floor).

**Phase 2: first-sight preparation**
- Prepare nearby content in every direction before the camera turns to it (clue 3), town first
  (clue 4). Acceptance: new programs per warm sweep near zero in town on the desktop; phone
  first-turn worst gap under 100 ms on a cold shader cache.
- Status (2026-11-12): reworked on `fix/deferred-link-gates` (desktop-verified, phone verdict
  pending). Four parts, each answering a measured failure of the first attempt:
  1. Only the FIRST-SIGHT gates run deferred (`compileGatesSupported`); the bulk lanes (zone
     background prewarm, self-spirit warm, whole-scene boot passes) stay off as before
     (`asyncCompileSupported`). The zone prewarm had queued 340 to 460 units ahead of the reveal
     gates (watchdogs) and cost 2 to 4 ms every frame.
  2. One linking compile per frame (`paced_link_core.ts`, `link_slot_pacer.ts`), per gate piece,
     cache hits free; off under the loading screen and any arrival cover. Per-object pacing was
     tried and starved the queue (each compile walks the world scene for its lights).
  3. The boot `programs.compile` submits links in deferred mode (`deferredLinkCompile` in
     `prewarm_policy.ts`), and when the constrained deadline drops it, its resume units run
     through the paced arms: this is what prepares the ungated static scenery (placed batches,
     station props, kit foliage) before the first turn.
  4. A prop band inside the 40 yd reach floor still reveals at once but now requests its compile
     (`prop_cull_core.ts`), so a band behind the camera links before the camera faces it.
  Desktop proxy (`--no-parallel-compile --entry-cpu 4`, 20 s `--settle`, 2 runs each), first
  town turn: live links 24 to 0, worst frame 482 to 536 ms to 127 to 129 ms, p99 237 to 431 ms to
  73 to 83 ms, drawn FPS 40 to 61; steady renderer time unchanged. With the 4 s settle after the
  bench's bare teleport (no arrival cover, everything requested at once): live 24 to 6, worst
  487 to 419 ms, but the second turn gains about 11 paced compile hitches, which the desktop
  overstates (a D3D11 link costs about 100 ms there, 14 to 50 ms on the phone).
  New bench options: `--no-parallel-compile`, `--settle`, the per-window pacer counters (`lg` in
  the poll rows); `tmp/orbit-bench/gate_watch.mjs` samples the gate queue by kind.
  Review round (render-performance-reviewer, 2026-11-12) found that without the extension three
  reports every program ready on its first poll, so the gates' settle and touch trusted links
  still queued in the GPU process. Fixes:
  5. A WebGL2 fence issued right behind each in-world arm compile (`link_fence_proof.ts`); the
     arm settles only on its signal (cap 4 s, unproved on a lost context). The loading screen
     waits on ONE fence behind all of its units instead: a fence per boot unit throttled the
     submission (entry 73 to 210 s on the proxy, 31 fewer programs at entry).
  6. The pacer serves gates before bulk lanes (boot resume units, cast-VFX and spirit-veil
     warms), charges one frame per program a compile made, holds the slot for a released caller,
     drains from a 100 ms timer when frames stop, and is disarmed by each Renderer constructor
     and released on dispose by its owner.
  7. The reach-floor request is not imminent, so the arrival cover never waits on a drawn band.
  `?linkfence=off` runs deferred mode without the fences (A/B only).
  Phone (Adreno 810, Chrome 156, Low, 20 s settle, Frame Rate Limit off via
  `--settings '{"frameRateCap":1}'`, one run each, `p3-phone-*-nocap`): live links town first
  turn 20 to 3, second turn 3 to 1, open field 5 to 0; worst frame town 431 to 122 ms and 266 to
  177 ms, open field 420 to 55 ms; p99 of the first turn 210 to 77 ms; drawn FPS 30.6 to 36.7 on
  the first turn, 2 to 5 lower on the second and third (paced links still draining); steady
  renderer time equal; entry 41 to 50 s. With the Frame Rate Limit on, both fix builds ended in
  the 30 lock and the release run did not, in one run each: the lock is borderline at about
  40 drawn FPS in town either way, which is Phase 3's target, not Phase 2's. Fences on against
  off (`p3-phone-fence`, `p3-phone-nofence`): first turn 188 against 144 ms, later windows 133
  against 177 ms and no 387 ms idle spike with fences; too close for one run each.
  Repeat runs (3 release, 3 fences, 2 no fences, Frame Rate Limit off): fences win. Without them
  live links are also 0, but town p99 is 110 to 144 ms on the turns against 66 to 77 ms, and
  standing shows 88 to 99 ms spikes (the synchronous touch wait the review predicted).
  Per-frame timestamps (`pace.at`, on the program trace's clock) tied the rest to two causes:
  ungated placed-batch street lamps still linking live on the first turn (the background
  remainder drained at about 2 programs a second), and the gale-features tower link landing on
  a 177 ms frame on the second turn.
  8. Only a compile that links issues a fence; a cache hit waits on the newest outstanding fence
     (fences signal in order), or on nothing. A fence per hit had held the reveal queue to 60 to
     100 pieces a second; the desktop proxy queue now empties in about 6 s instead of 14.5 s.
  9. The pacer releases a waiting link in a task after the frame's callbacks, behind its draws,
     and a chain of cache hits in one such task yields after `LINK_SLOT_PASS_BUDGET_MS`.
  Phone, 2 runs (`p3-phone-v8-timed-*`): 0 live links on every turn; first town turn worst 111 ms
  in both, p99 55 to 78 ms; second turn 89 and 199 ms (the tower again in the second run),
  drawn FPS 29 to 33 there against 36 to 39 on release; standing before the turn 66 to 78 ms worst
  (the remainder now drains while standing).
  Entry time is out of scope (decided 2026-11-12): only freezes after loading count.
  Phone CPU profiles (`run ... --cpu-profile all`, one profile per spot, started mid-settle and
  stopped after the last window, because a profile start stalls the phone 0.5 to 1.5 s; read
  with `profiler/cpu_profile_window.mjs`, `pageMs = pace.at + results.ownersT0`): on release the
  long frames are `getProgramParameter` link waits (516 to 860 ms per run). On the fix the
  biggest remaining frame (133 to 216 ms) is `Renderer.ensureZoneFeatures` building the gale
  features group in one frame (67 to 77 ms of JS plus 20 to 23 ms of `collectProgramSources`
  for its compile gate), started by `pumpVisibleZonePrepareQueue` when the turning camera first
  faces that zone; release has the same build. Sampling costs the phone a few FPS, so take
  numbers from unprofiled runs.
  Building the feature groups under the loading screen was proposed next and dropped: it
  covers only the zones near the login point, and every zone reached on foot streams the same
  way (walking, below). Still open: recheck the second turn's drawn FPS (31 against 37).

  Walking (`--walk north`, 2026-11-12). Phone, two runs each, walking out: release 56 to 69
  frames of 100 ms or more, worst 946 to 1112 ms, 83 mid-frame links (the profile: about 1.9 s
  of `getProgramParameter` inside the long frames); the fix 27 to 38, worst 431 to 465 ms, 17
  to 20 links, and every zone's `ensureZoneFeatures` build is a long frame (realm flora 222 ms,
  fen 105, jungle 95, gale 65, Dawnhold 34). No zone was evicted on this walk.
  Regression found: walking into new zones the fix draws about twice the calls of release
  (Thornpeak 730 to 830 against 280 to 350; town equal), median frame 50 against 33 ms on the
  phone. `?linkgate=off` on the same build restores release's counts exactly. Likely path: on
  Low, `LowSceneryBands.cullFar` (`src/render/scenery_bands/session.ts`) caps zone-feature reach
  at 60 yd only while a band baked within 64 yd of the camera is current, else returns the fog
  distance; the band bake waits on a compile gate that queues behind paced links, so it lags
  the walking camera. The bench's per-leg `census` (one frame of draws by scene branch) and
  `featureGroups` (visible and cull-registered) fields are how this was found.
  Regression fixed (2026-11-13, `src/render/scenery_bands/session.ts`), confirmed with a
  temporary band probe (a dev global returning `sceneryDetailSnapshot()` plus a bake log; the
  bench polls it as `bands`/`bandLog` per leg when present, `tmp/orbit-bench/p6_bands.mjs` and
  `p6_stages.mjs` read them). A window covers only within 64 yd of its centre and the next
  starts every 32 yd, so a bake has a few seconds. Causes, in the order the phone exposed them:
  the bands waited for the giant-tree atlas (6 s desktop proxy, 25 to 30 s on the phone for
  Veiled Hollow); a streamed zone restarted the bake in progress; every window minted new band
  materials, so every window took the full paced gate (5 to 8 s during streaming). Now bands
  commit first, the atlas bakes on its own job only when a new zone has giants or the camera
  passes half the sprites' coverage (`giantsCover`, `giantsRebakeDue`), a zone without sprites
  yet stays native on its own, a registration no longer cancels a window, and band materials
  are session-owned so a proven gate is skipped (`compileTargetPrepared`). Phone, walking out:
  frames of 100 ms or more 19 and 19 (fix before 27 to 38, release 56 to 69), drawn 25.3 to
  25.7/s (release 21 to 22), p99 88 to 100 ms, bands active 166 to 175 of 183 polls; walking
  back 4 to 5 long frames. Left: one 5 to 9 s gap near z 500 (the garden zone's new materials
  link for real) and Veiled Hollow drawn natively at Highwatch while its giants bake.
  Next: (1) a per-frame budget for streaming builders, zone features first; (2) spread the
  preparation queue's main-thread work (`collectProgramSources` for compile checks); (3) a
  per-tree giant atlas cache instead of a per-window bake.

  Review rounds (2026-11-13, render-performance-reviewer three times, plus one walk finding),
  all in `src/render/scenery_bands/session.ts` with `near.ts` and `material.ts`, pinned in
  `tests/scenery_bands_ownership.test.ts` (each new test was mutation-checked: it fails with
  its fix undone):
  - Giant coverage is per landmark object. `covers()` no longer needs the sprites; while they
    miss a giant (`giantsShort`: no sprites, the camera past `giantsCover` with
    `GIANTS_COVER_HYSTERESIS_YD`, or `giantsLag`), only that object stays native
    (`SceneryNearSources.update` `exemptObjects`) and its root keeps the native sweep horizon
    (`shortRoots`); the rest of the zone keeps its bands. A slow bake under a far fog had
    turned every band off.
  - `giantsLag` counts only giants of roots the sprites did not collect (`giantRoots`,
    `PreparedGiants.roots`). Counting every giant the sprites lack rebaked them at almost
    every window walking into the gardens (11 bakes against 8 on the walk), because far
    giants enter the 630 yd collection radius well past the fog.
  - Bakes: a failed one retries after `GIANTS_RETRY_MS` doubling to `GIANTS_RETRY_MAX_MS`
    (reset on success), a cancelled one resumes outdoors, one pending past
    `GIANTS_BAKE_TIMEOUT_MS` is abandoned (a generation token, and an abort that rejects its
    awaits so the builder releases its atlas targets), and a GPU queue shutdown stops baking.
    `snapshot()` reports `giantsFailures` and `giantsStopped`.
  - Band materials: replaced when the source's map, alpha cutout or side changed
    (`lowSceneryBandMaterialCurrent`; procedural leaf atlases land late, `tree_gen.ts`), with
    a `BAND_SOURCE_CHECK_MS` check while standing still; the replaced one is disposed with the
    session. Named `scenery-band:low:<source>`. A gate is skipped only for materials of the
    current window or proven by an earlier gate of the same window. Materials a gate relinked
    after the session let go are disposed again.
  - The sweep reads coverage before the band update, so it is refreshed at a window commit
    and a sprite landing, and a landmark whose root the sweep hid counts as not drawn
    (`sourceOwns`). `maxDistance()` clamps the fog far at `fadeEnd`, the fog the bands draw
    under.
  Desktop proxy, walk out (`p7-walk-*`, the build before the last lag fix): frames of 100 ms
  or more 5 to 10 (release 29 and 34), worst 314 to 333 ms (526, 547), p99 55 to 71 ms (75,
  85), mid-frame links 3 (67, 69), drawn FPS equal (39 to 41), walk back 0 (1, 2), Highwatch
  census at the end equal (526 to 540 against 528 to 542). Turns (`p7-turn-*`): first town
  turn worst 91 to 135 ms (415 to 430), p99 46 to 57 ms (400 to 421), steady renderer time
  equal. Same-day A/B of the final build against the pre-review fix build
  (`p8-final-*`, `p8-pre-*`, a slower machine state): frames of 100 ms or more 11 to 17
  against 11 to 18, p99 77 to 81 against 78 to 79 ms, worst 381 to 387 against 364 to 366 ms;
  draws lower between z 480 and 520. A temporary band probe (removed again; `diagLog` plus
  `__bandProbe`, restore it from the bench's `bands`/`bandLog` reader) showed the bands in
  use on every poll.
  Still open: a zone that streams in while a window is preparing is drawn in full until the
  next window holds it (2.5 to 3 s each, the extra draws near z 440 and z 600; present before
  this round), and Veiled Hollow's flora build is the worst walking frame. Phone verdict of
  this round pending (phone away).

  Zone feature builds spread over idle slices (2026-11-13, first builder: Veiled Hollow's
  flora). `buildRealmFlora` was one main-thread call when the zone streamed in (161 ms on the
  desktop proxy, 222 ms on the phone). Node timing showed `placeFlora` was almost all of it,
  and a third of that a dead grid loop (its pushes were retired in the 2026-07 content passes,
  but it still sampled road distance and terrain height per cell); removing it left the
  placements byte-identical on four seeds. The rest is a stepped build:
  `src/render/stepped_build_core.ts` (pure, `runBuildInSlices` over the grass slicer's
  `runSlicedBuild`), `placeFloraSteps` / `buildRealmFloraSteps` yielding per grid column and
  per family, and `src/render/zone_feature_builds.ts`, which prebuilds a biome's stepped
  builders in 6 ms slices on `idleSlot(200)` during a BACKGROUND prepare, beside terrain
  (`prepareZoneAt` runs the feature step as its own task, joined after water), and hands the
  view to the still-synchronous `ensureZoneFeatures` (`timedBuild` now delegates). A gating
  prepare builds in one call as before; a prebuild still in flight then stops and drops its
  result; shutdown stops it and `ensureZoneFeatures` refuses after shutdown. Each slice is a
  ledger record under `zone:features:<name>` (count is slices, max the worst slice). The
  lane must read `buildLedger.record` at call time: the bench wraps it after boot, and a
  captured function hid every zone build from the walks (one run set lost to that, plus a
  second runner that kept going after TaskStop; those runs are in `tmp/orbit-bench/p9-contended/`).
  To make room under the ratchet the cull-group registration moved into
  `zone_feature_sweep.ts` (`zoneFeatureEntriesFor`); renderer.ts ceiling lowered to the new count.
  Desktop proxy, clean interleaved walks (`p10-*`, 3 fix, 2 release): realm flora 19 to 20
  slices, worst 8 to 9 ms (release one 161 ms build); walking out, frames of 100 ms or more
  5 to 6 (release 28 and 29; the band build before this step 5 to 10), worst frame 138 to
  150 ms (release 534 and 571; before this step 314 to 333), p99 51 to 58 ms (74 and 79),
  drawn FPS equal (40 to 42), Highwatch census at the end equal (526 to 536 against 532 to 582).
  What is left near Veiled Hollow is one 103 to 132 ms frame at z 584 that no builder owns.
  Next builders to step, by cost: Fen 55 to 67 ms, Jungle 55 ms, Gale 35 ms (one frame each).
  Not covered: a gating caller that joins an in-flight background prepare still waits for
  the idle slices (they now run beside terrain, so they usually finish first); the phone.

  Second stepped builder, the Willowfen (`buildFenFeaturesSteps`, `fen` in
  `zone_feature_builds.ts` STEPPED). Its placement was mostly ONE call: the zone's scattered
  rocks from `generateDecorationsInBounds` (18 ms in Node), gathered only so the flora keeps
  clear of them. `fenRocksSteps` gathers them in 60 yd x strips (the bounds are inclusive, so
  each strip but the last drops its right edge; the union equals the one-call set,
  `tests/fen_features_stepped.test.ts`); the flora yields per patch column and the build per
  family cell; spots identical on four seeds. Desktop proxy (`p11-*`, 3 fix, 2 release):
  fen 8 to 9 slices, worst 9 to 13 ms (one 55 to 67 ms build before); its long frames near
  z 54 (103 to 116 ms in two of three earlier runs) gone; walking out, frames of 100 ms or
  more 5 to 6 (release 28 and 29), worst 132 to 151 ms (release 532 and 579), p99 51 to 57 ms
  (75), drawn FPS equal. Next by cost: Jungle 53 to 60 ms, Gale 33 to 38 ms.

  Third and fourth stepped builders, Palm Reach and Galecrest (`buildJungleFeaturesSteps`,
  `buildGaleFeaturesSteps`; `tests/jungle_gale_stepped.test.ts` builds both with one-box GLB
  stand-ins and pins the piece count). Desktop proxy (`p12-*`, 3 fix, 1 release): jungle 4 to 5
  slices, worst 22 to 26 ms (52 to 60 ms before); gale 2 slices, worst 25 to 29 ms (33 to 38 ms);
  walking out, frames of 100 ms or more 3 to 5 (5 to 6 before, release 29), worst 135 to 158 ms.
  One piece in each is still over 20 ms, unnamed: the per-slice ledger windows did not line up
  with the profile (a `t` clock mismatch to check in `p12_frames.mjs`).
  A CPU-profiled walk on an UNMINIFIED build (`vite build --minify false`, served on its own
  port; `tmp/orbit-bench/p12_frames.mjs` prints the inclusive top frames per long frame) names
  the rest: z 224 (152 ms) carries 40 ms of `createCharacterVisual` under
  `buildEntityPrewarmGroup`, the zone archetype prewarm building the next zone's creatures inside
  one frame; z 254 (130 ms) is the asset loader `drain` (32 ms) plus one `getProgramParameter`
  wait in the touch lane (24 ms); z 482 and z 584 (109 ms) have no single owner (sync 57 ms,
  render 36 ms). Every long frame also carries 25 to 33 ms of unattributed native time.

  Zone prewarm rigs sliced (`buildZonePrewarmGroups` in `zone_prewarm_groups.ts`, stepped
  `buildEntityPrewarmGroupSteps` / `buildNpcPrewarmGroupSteps`; the idle-slice constants moved
  to `stepped_build_core.ts` `IDLE_SLICE_MS` / `IDLE_SLICE_TIMEOUT_MS` so the prewarm does not
  import every zone builder). A background prewarm builds one rig per idle slice with no
  wall-clock cap; the gating path drains at once under the old 5 s cap. Desktop proxy (`p13-*`,
  3 fix, 1 release): walking out, frames of 100 ms or more 2 to 4 (3 to 5 before, release 31),
  worst 125 to 134 ms (135 to 158 before, release 527); the z 224 frame 135 to 158 to 115 to
  122 ms, the z 584 frame gone. A profiled walk (`p13-prof`) leaves two long frames (z 111 and
  z 255, about 116 ms) with no single owner: `sync` 45 to 58 ms spread over setProgram, matrix
  updates and a traverse. That is the end of the named one-frame builds on this route; what is
  left is Phase 3 territory (per-frame CPU cost), plus the jungle and gale pieces over 20 ms.

  The jungle and gale pieces over 20 ms, stepped (`buildDeckWoodSteps` in `deck_render.ts`
  yields per walkway deck, `reachCoconutSpotsSteps` per palm, the Galecrest beacon stair every
  16 treads; `tests/jungle_gale_stepped.test.ts` pins the exact piece count and each yield is
  mutation-checked). Desktop proxy (`p14-*`, 3 fix, 1 release): jungle worst slice 8 to 10 ms
  (22 to 26 before), gale 11 to 14 ms (25 to 29); walking out, frames of 100 ms or more 3 to 5
  (release 31), worst 121 to 130 ms (release 540), p99 57 to 59 ms (82), 3 live links (66),
  drawn FPS equal (40 against 39). The remaining long frames have no single owner.

**Phase 3: CPU cost on Low**
- Reduce submit and the extra draw calls turning brings into view (clues 7 and 8). Target: the
  phone's town frame under 16.6 ms, so the Frame Rate Limit never engages (clue 6). Measure
  each change on the desktop proxy first.
- Method: a CPU-profiled town run on an unminified development bundle (`--spots town
  --cpu-profile all`), read per drawn frame inside the measured windows with
  `tmp/orbit-bench/p3_frame_cost.mjs` and by caller with `p3_callers.mjs`; `--eval FILE` runs a
  probe in the page after each spot's settle (`probe_matrix_walk.js` counts the matrix walk's
  visits per top-level scene child).
- Idle town frame on the desktop proxy before this phase: about 19.7 ms sampled, of which the
  JS `frame` is 10.7 ms, three's render 5.4 ms and unattributed native time 6.8 ms; the matrix
  walk alone 2.1 ms (9,721 node visits a frame).
- Step 1 (2026-11-13, commits 62ecd134df, c60e0d9616, 786b18eafd):
  1. The zone prewarm grids skip their subtree while hidden (`HiddenSubtreeGroup` in
     `visible_children_group.ts`): 1,653 visits a frame, all recomposed, for creature rigs
     waiting out their background warm-up.
  2. The props root is a `VisibleChildrenGroup({ walkHiddenOnce: true })`: about 800 of its
     1,000 children are distance-culled in town (3,000 nodes); each child is still walked once,
     so one attached hidden gets composed matrices. Readers of a hidden prop's matrices were
     audited: the point-light carriers read only live sources (ancestors visible), the ferry's
     deck query reads the schedule pose, the far-cell bake and the freezes force their own walk.
  3. `lanceGuidanceFor` finds its target in one entity scan instead of two
     (`lanceGuidanceTarget`), every client frame and per player per server broadcast.
  4. `isSubmerged` / `isSwimming` test the water line before sampling the ground (the HUD breath
     bar asks every frame).
  A/B in Chrome (`p3c-base-1` at 46e5f546f5, `p3c-fix-1`; one run each): idle town sampled
  19.7 to 18.4 ms a frame, matrix walk 2.06 to 1.15 ms, `sync` 8.3 to 7.45 ms; over the whole
  profile the walk 3,391 to 2,020 ms, the eye-ward scan 410 to 261 ms, `isSubmerged` 163 to
  31 ms. Idle drawn FPS 49.9 to 55.1 and renderer time 8.4 to 7.4 ms, but one run each.
  Left as designed: `getProgramParameter` in idle frames is the background queue's budgeted
  touch tail draining the boot program debt.
- Draw census (`tmp/orbit-bench/probe_draw_census.js`: one frame of `renderBufferDirect` calls
  by owner; `probe_far_draws.js`: each draw's nearest distance against the scene fog far). Idle
  town on Low drew 175 to 179 calls a frame, and 35 of its 150 drawn objects lay wholly past
  the fog (175 yd), some at 950 yd: content attached with no distance cull at all.
- Step 2 (d536c79ea9): the Mirefen tavern (420 yd from the Eastbrook square) culled only its
  fading shell; the whole tavern root now hides with it (`updateMirefenTavernShell`). Live
  flames outside every hideable (the tavern's hearth and wall fires, the delve braziers) had
  no cull; they now cull by distance against the structure fog plus `PROP_LIVE_CULL_SLACK`
  (`prop_cull_core` `livePropCullTargets` / `updatePropLiveCullables`). 179 to 155 calls.
- Step 3 (acd4a06e61): station props and farm patches were one plain scene group each; they
  now hand the renderer one cull group per 180 yd hub cell or per patch and attach through
  `attachZoneFeature(view, false)` (no band bake; the gated attach links their programs up
  front, so a fog reveal links nothing), like the camp braziers. 155 to 139 calls; draws past
  the fog 35 to 17.
- Step 4 (15b95e501f): the Highwatch guild's hearths (shader flames, 740 yd) join the flame
  cull, with one prewarm twin per flame kind in `buildPropMaterialPrewarmGroup` (a culled fire
  no longer links at entry from across the world). 139 to 130 calls; past the fog 11 objects:
  the sky sprites, the world-boss impostor (by design), the blob shadow batch's world-wide
  bounds, gather nodes just past the fog, and one delve portal's void shader (no prewarm twin
  yet). Walks north past the tavern (`p3c-walk-*`, Chrome, 2 fix against 1 pre-Phase-3): the
  same 3 live links walking out in all three (placed impostors, a points program, the
  Highwatch static batch), long frames 3 to 4 against 2, drawn 41.9 to 42.7 against 40.1. One
  fix walk back linked `night-accents` and `mob-night-glow`: night fell during that run (the
  day/night clock is wall time), not a cull reveal.
- Phase 3 so far, profiled A/B in Chrome (`p3f-base-1/2` at 46e5f546f5 against `p3f-fix-2/3` at
  15b95e501f; `p3f-fix-1` lost to a transient WebGL context failure): idle town sampled 19.4 to
  19.6 ms a frame to 17.4 to 18.0, three's render 5.2 to 5.3 ms to 3.8 to 4.0, matrix walk 1.8 to
  2.0 ms to 1.2, renderer time 8.2 to 8.4 ms to 6.6 to 6.8, median frame 18.5 to 18.8 ms to 15.6
  to 16.4, drawn FPS 52 to 59 to 60. Turning gains less: sampled 21.8 to 20.7 to 20.8 ms, renderer
  8.5 to 9.0 ms to 7.6 to 8.0, since a turn brings about 25 more calls into view (the nearby
  buildings draw per material in near mode, for their camera fade).

**Phase 4: keep it fixed**
- Add the orbit scenario to `perf_baseline.mjs` with a stored history, keep a frozen phone
  baseline beside the desktop ones, and gate on first-sweep worst gap and time spent degraded.
