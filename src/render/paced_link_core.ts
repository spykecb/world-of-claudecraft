// Deferred-mode link pacing: at most one compile that creates programs per
// frame.
//
// On a Chromium context without KHR_parallel_shader_compile the first-sight
// gates run in deferred mode (link_gate_mode_core.ts): a link is issued from
// the main thread in about 2 ms and the GPU process links it behind the
// command buffer. That process runs commands in order, so links issued in a
// burst make the next frame's draws wait behind every one of them: measured on
// the reference phone, turning the gates on unpaced moved the first turn's
// 343 ms freeze to 398 and 310 ms freezes elsewhere. One link issued ahead of
// its draw hides in the GPU process's spare time; a burst cannot.
//
// The gates already split a root into one queue unit per material group (a
// gate PIECE), so the rule applies per arm compile (compile_arms.ts): a
// compile that creates N programs uses N frames up (link_slot_pacer.ts), and
// the next compile waits until they pass; a compile that hits the program
// cache uses nothing and lets the next one go at once. It deliberately does
// not go object by object: three's compile walks the whole world scene for its
// lights on every call, and a per-object pass over a building's per-structure
// material clones (each a cache hit) paid one world walk per clone, which
// starved the reveal queue past its watchdog on the desktop proxy (300 units
// pending, 23 watchdogs on the first town turn).
//
// Pure and DOM-free (RENDER_PURE_CORES): the host does the GL work.

/** Who is asking: a first-sight gate (a reveal, a swap, a cast) or a bulk
 *  lane (the boot resume units, the cast-VFX and spirit-veil warms, the
 *  atlas preparation). A waiting gate always goes before a waiting bulk
 *  caller, so background warming never delays a reveal toward its watchdog. */
export type LinkLane = 'gate' | 'bulk';

export interface PacedLinkHost {
  /** Pacing applies now (deferred mode, after the world's first reveal, no
   *  arrival cover). */
  paced(): boolean;
  /** This frame already created a program. */
  frameUsed(): boolean;
  /** Resolves when the caller may compile (link_slot_pacer.ts linkSlot). */
  slot(lane: LinkLane): Promise<void>;
  /** A compile created `programs` programs: it uses that many frames up (a
   *  piece whose materials link three variants keeps the next caller back
   *  for three frames, so one compile cannot burst the GPU process). */
  noteLink(programs: number): void;
  /** A caller released by `slot` compiled without linking: let the next go. */
  passSlot(): void;
}

export interface PacedCompileResult<T> {
  /** What the compile returned (three's compileAsync promise). */
  value: T;
  /** Programs it created. */
  created: number;
  /** It waited for a later frame first. */
  waited: boolean;
}

/**
 * Run one compile under the frame rule. `run` issues the compile and reports
 * how many programs it created; unpaced, it runs at once and uses nothing.
 */
export async function pacedCompile<T>(
  host: PacedLinkHost,
  run: () => { value: T; created: number },
  lane: LinkLane = 'gate',
): Promise<PacedCompileResult<T>> {
  if (!host.paced()) {
    const { value, created } = run();
    return { value, created, waited: false };
  }
  const waited = host.frameUsed();
  if (waited) await host.slot(lane);
  let outcome: { value: T; created: number };
  try {
    outcome = run();
  } catch (error) {
    // A released caller that failed still hands the frame on, or every
    // later compile would wait for a report that never comes.
    if (waited) host.passSlot();
    throw error;
  }
  const { value, created } = outcome;
  if (created > 0) host.noteLink(created);
  else if (waited) host.passSlot();
  return { value, created, waited };
}
