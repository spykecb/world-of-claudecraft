// Real-phone (and phone-emulation) glue for the profiler: attach to Chrome on an
// Android device over adb, and make the shared offline entry flow work on a phone.
// Used by scripts/orbit_bench.mjs; any Profiler-based script can reuse it.
//
// Every workaround here exists because a real phone broke the desktop-only flow:
// - Puppeteer's in-page wait tasks (waitForSelector / waitForFunction) stall over
//   the Android DevTools socket while the phone's main thread is busy: a selector
//   stayed visible for minutes and the wait never resolved. installNodeSideWaits
//   swaps both for short evaluates polled from Node.
// - Phone hardware shows the "add to home screen" preflight (#mobile-preflight)
//   BEFORE the offline character select, which scripts/enter_offline_game.mjs only
//   expects after Enter World.
// - The client attaches the mode-select handlers long after the static
//   #btn-offline trigger exists, so the entry script's one early click is lost.
// - A sleeping screen stops requestAnimationFrame, which freezes world entry on
//   "Loading world..." for good; keepAwake holds the screen on while on USB power.
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { parseKeyguardShowing, parseWakefulness } from '../lib/android_device_parse.mjs';
import { pollUntil } from '../lib/orbit_bench_core.mjs';

/** The local port adb forwards to Chrome's DevTools socket on the phone. */
export const ANDROID_DEVTOOLS_PORT = 9222;

/** Run `adb <args>` and return stdout; throws with adb's message on failure. */
export function adb(args, { timeoutMs = 15000 } = {}) {
  return execFileSync('adb', args, { encoding: 'utf8', timeout: timeoutMs });
}

/** `adb shell <cmd>` that never throws (a missed sample must not end a run). */
export function adbShell(cmd, { timeoutMs = 5000 } = {}) {
  try {
    return adb(['shell', cmd], { timeoutMs });
  } catch {
    return '';
  }
}

/** Exactly one authorized device, or a readable reason why not. */
export function androidDeviceState() {
  const out = adb(['devices']);
  const rows = out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/));
  if (rows.length === 0)
    return { ok: false, reason: 'no device: plug the phone in and enable USB debugging' };
  if (rows.length > 1)
    return { ok: false, reason: 'more than one device attached: unplug the others' };
  const [serial, state] = rows[0];
  if (state === 'unauthorized') {
    return {
      ok: false,
      reason: 'device unauthorized: tap Allow on the "Allow USB debugging?" prompt',
    };
  }
  if (state !== 'device') return { ok: false, reason: `device state is ${state}` };
  return { ok: true, serial };
}

/**
 * Point the phone at this machine: forward Chrome's DevTools socket to
 * localhost:ANDROID_DEVTOOLS_PORT and reverse the game port, so the phone's
 * localhost:<gamePort> reaches the PC's server over the cable (no Wi-Fi needed).
 */
export function setupAndroidTunnels(gamePort) {
  adb(['forward', `tcp:${ANDROID_DEVTOOLS_PORT}`, 'localabstract:chrome_devtools_remote']);
  adb(['reverse', `tcp:${gamePort}`, `tcp:${gamePort}`]);
}

export function teardownAndroidTunnels(gamePort) {
  try {
    adb(['forward', '--remove', `tcp:${ANDROID_DEVTOOLS_PORT}`]);
  } catch {
    /* not set */
  }
  try {
    adb(['reverse', '--remove', `tcp:${gamePort}`]);
  } catch {
    /* not set */
  }
}

/** Developer option "stay awake while charging": true holds the screen on while on USB. */
export function keepAwake(on) {
  adb(['shell', 'svc', 'power', 'stayon', on ? 'usb' : 'false']);
  if (on) adbShell('input keyevent KEYCODE_WAKEUP');
}

/** Screen state (Awake, Asleep, Dozing, Dreaming) and whether the lock screen is up.
 *  Filtered on the phone: the full dumps are large enough to miss the read timeout. */
export function screenState() {
  return {
    wakefulness: parseWakefulness(adbShell('dumpsys power | grep mWakefulness=')),
    locked: parseKeyguardShowing(adbShell('dumpsys window | grep isKeyguardShowing')),
  };
}

/** Attach to the phone's Chrome and open a fresh, foreground tab. */
export async function connectAndroidChrome({ protocolTimeoutMs = 900000 } = {}) {
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${ANDROID_DEVTOOLS_PORT}`,
    defaultViewport: null, // keep the device's own viewport and pixel ratio
    protocolTimeout: protocolTimeoutMs, // a phone can be busy for minutes during world entry
  });
  const page = await browser.newPage();
  await page.bringToFront().catch(() => {});
  page.on('dialog', (d) => void d.accept().catch(() => {}));
  return { browser, page };
}

/** Replace puppeteer's in-page waits on `page` with Node-side polling (see header). */
export function installNodeSideWaits(page) {
  page.waitForSelector = (selector, opts = {}) =>
    pollUntil(
      () =>
        page.evaluate(
          (sel, visible) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            if (!visible) return true;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          },
          selector,
          !!opts.visible,
        ),
      { timeoutMs: opts.timeout ?? 30000, intervalMs: 500 },
    );
  page.waitForFunction = (fn, opts = {}, ...args) =>
    pollUntil(() => page.evaluate(fn, ...args), {
      timeoutMs: opts.timeout ?? 30000,
      intervalMs: typeof opts.polling === 'number' ? opts.polling : 500,
    });
}

/** Tap through the phone-only entry snags (see header) on every navigation of `page`. */
export async function installPhoneEntryHelpers(page) {
  await page.evaluateOnNewDocument(() => {
    setInterval(() => {
      const prompt = document.getElementById('mobile-preflight');
      if (prompt?.classList.contains('visible')) {
        document.getElementById('mobile-preflight-continue')?.click();
      }
    }, 500);
    const retry = setInterval(() => {
      const mode = document.getElementById('mode-select');
      const offline = document.getElementById('offline-select');
      if (offline && getComputedStyle(offline).display !== 'none') {
        clearInterval(retry);
        return;
      }
      if (mode && getComputedStyle(mode).display !== 'none') {
        document.getElementById('btn-offline')?.click();
      }
    }, 2000);
  });
}

/**
 * Clear the game origin's site storage before a run (settings, the Frame Rate
 * Limit's remembered verdict, caches), so one run's choices never leak into the
 * next. Chrome's compiled-shader cache is not site storage and survives, which is
 * the state a returning player has.
 */
export async function clearSiteStorage(cdp, origin) {
  await cdp.send('Storage.clearDataForOrigin', {
    origin,
    storageTypes: 'local_storage,indexeddb,websql,cache_storage,service_workers',
  });
}

/** Wait until the phone screen is awake AND unlocked, so Chrome is visible and rAF
 *  runs; false after the timeout. */
export async function waitForUsableScreen(timeoutMs = 60000) {
  try {
    await pollUntil(
      () => {
        const s = screenState();
        return s.wakefulness === 'Awake' && s.locked === false;
      },
      { timeoutMs, intervalMs: 2000 },
    );
    return true;
  } catch {
    return false;
  }
}
