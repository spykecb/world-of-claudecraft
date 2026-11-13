// The frame's single link for deferred-mode gates (paced_link_core.ts).
//
// A compile that creates a program uses the frame up: later compiles wait for
// the next animation frame, one caller released at a time, in arrival order.
// A compile that hits the program cache uses nothing, so the next caller goes
// at once. The frame loop runs requestAnimationFrame only while the frame is
// used up or a caller waits, so a session with nothing to link pays nothing
// per frame.
//
// Pacing starts disarmed: under the loading screen there is no frame to
// protect, and the boot compile lanes must issue in bulk. The renderer arms it
// at the world's first reveal (`armLinkPacing`), and it stands down again
// while an arrival cover is up.

import { arrivalCoverActive } from './arrival_cover';
import type { LinkLane } from './paced_link_core';

/** A hidden tab (or a host that never ticks animation frames) still drains:
 *  each frame step also runs from a timer this long after it was scheduled. */
export const LINK_SLOT_FALLBACK_MS = 100;
/** Cache hits passed along in one release task stop here and wait for the next
 *  frame, so a long run of hits never becomes one long task. */
export const LINK_SLOT_PASS_BUDGET_MS = 4;

let enabled = false;
let armed = false;
/** Frames still owed by the last linking compile (one per program it made). */
let debt = 0;
/** A waiter was released and has not reported yet: nobody else may start. */
let reserved = false;
let stepPending = false;
/** When the current release task began (performance.now), or null. */
let releaseTaskStart: number | null = null;
const gateWaiters: Array<() => void> = [];
const bulkWaiters: Array<() => void> = [];
let links = 0;
let waits = 0;

/** The renderer's link-gate mode is deferred (link_gate_mode_core.ts). Every
 *  Renderer constructor calls it, so it also disarms: a second renderer in
 *  the page boots its own loading screen unpaced. */
export function setLinkPacingEnabled(on: boolean): void {
  enabled = on;
  armed = false;
  flush();
}

/** The world revealed: pace from now on. */
export function armLinkPacing(): void {
  armed = true;
}

export function linkPacingActive(): boolean {
  return enabled && armed && !arrivalCoverActive();
}

function waiting(): number {
  return gateWaiters.length + bulkWaiters.length;
}

function flush(): void {
  debt = 0;
  reserved = false;
  releaseTaskStart = null;
  while (gateWaiters.length > 0) gateWaiters.shift()?.();
  while (bulkWaiters.length > 0) bulkWaiters.shift()?.();
}

/** Release the highest-priority waiter, holding the slot for it. */
function releaseNext(): void {
  const next = gateWaiters.shift() ?? bulkWaiters.shift();
  if (!next) return;
  reserved = true;
  next();
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Release the next waiter in a task of its own AFTER the frame: a frame step
 *  runs inside the animation-frame callbacks, ahead of (or among) the frame's
 *  own draws, and a link issued there makes the GPU process link it in front
 *  of that frame's commands. Issued after them, it links in the gap before the
 *  next frame. The slot is held meanwhile, so no fresh caller slips in. */
function releaseAfterFrame(): void {
  reserved = true;
  setTimeout(() => {
    reserved = false;
    if (!linkPacingActive()) {
      flush();
      return;
    }
    // Cleared at the next frame step: every cache hit the chain passes along
    // from here on is timed against this task's start.
    releaseTaskStart = clock();
    releaseNext();
    if (waiting() > 0 || debt > 0) schedule();
  }, 0);
}

function step(): void {
  stepPending = false;
  releaseTaskStart = null;
  if (!linkPacingActive()) {
    flush();
    return;
  }
  if (debt > 0) debt--;
  if (debt === 0 && !reserved && waiting() > 0) {
    releaseAfterFrame();
    return;
  }
  if (debt > 0 || waiting() > 0) schedule();
}

function schedule(): void {
  if (stepPending) return;
  if (typeof requestAnimationFrame !== 'function') {
    flush();
    return;
  }
  stepPending = true;
  // Whichever comes first runs the step; the other is a no-op.
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    step();
  };
  requestAnimationFrame(once);
  setTimeout(once, LINK_SLOT_FALLBACK_MS);
}

/** This frame is used up (or a released caller holds it): the next compile
 *  must wait. */
export function linkFrameUsed(): boolean {
  return (debt > 0 || reserved || waiting() > 0) && linkPacingActive();
}

/** Resolves when the caller may compile: a later frame, or sooner when a
 *  caller ahead of it compiled without linking. Gates go before bulk lanes. */
export function linkSlot(lane: LinkLane = 'gate'): Promise<void> {
  if (!linkPacingActive()) return Promise.resolve();
  waits++;
  return new Promise((resolve) => {
    (lane === 'gate' ? gateWaiters : bulkWaiters).push(resolve);
    if (debt === 0 && !reserved && !stepPending) releaseNext();
    else schedule();
  });
}

/** A compile created `programs` programs: it uses that many frames up. */
export function noteLink(programs = 1): void {
  links++;
  reserved = false;
  if (!linkPacingActive()) return;
  debt = Math.max(debt, Math.max(1, Math.floor(programs)));
  schedule();
}

/** A caller released by `linkSlot` compiled without linking (or failed):
 *  pass the frame on to the next caller at once. */
export function passLinkSlot(): void {
  reserved = false;
  if (debt !== 0) return;
  if (releaseTaskStart !== null && clock() - releaseTaskStart > LINK_SLOT_PASS_BUDGET_MS) {
    schedule();
    return;
  }
  releaseNext();
}

/** Counters for perfStats (renderer_perf_stats.ts). */
export function linkPacingStats(): {
  active: boolean;
  waiting: number;
  links: number;
  waits: number;
} {
  return { active: linkPacingActive(), waiting: waiting(), links, waits };
}

/** Test seam: back to the module's initial state. */
export function resetLinkPacingForTests(): void {
  enabled = false;
  armed = false;
  stepPending = false;
  flush();
  links = 0;
  waits = 0;
}
