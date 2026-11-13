// Deferred-mode link proof: a WebGL2 fence issued right after a compile, and
// polled until it signals.
//
// Without KHR_parallel_shader_compile three seeds every program's readiness to
// true (WebGLProgram.isReady), so compileAsync resolves on its first 10 ms poll
// while the link is still queued in the GPU process. Every proof the gates
// build on that answer (the variant settle, markProgramReady, the touch tail's
// getUniforms) would then treat a program still linking as linked, and the
// touch's synchronous ACTIVE_UNIFORMS round trip would block the main thread
// behind the link and every link queued ahead of it.
//
// A Chromium context runs its commands in order in the GPU process, and a
// context that does not expose the extension links inside that ordered stream.
// So a fence inserted after the compile signals only once the link before it
// has run: the signal is the proof three cannot give here. Its status read is
// a non-blocking client-side query (WebGL updates it between tasks), polled
// from a timer, never from the draw path.
//
// Fail-soft: a context without fences (WebGL1, a stub), a lost context, or a
// fence that never signals within LINK_FENCE_MAX_MS resolves unproved, which
// is exactly the behaviour before this proof existed.

export const GL_SYNC_GPU_COMMANDS_COMPLETE = 0x9117;
export const GL_SYNC_STATUS = 0x9114;
export const GL_SIGNALED = 0x9119;

/** First poll delay, and the spacing of every later poll. */
export const LINK_FENCE_POLL_MS = 8;
/** Give up waiting and resolve unproved (a wedged driver must not park a
 *  gate forever; the gate's own watchdog is the backstop past this). */
export const LINK_FENCE_MAX_MS = 4000;

/** The slice of a WebGL2 context the proof needs. */
export interface LinkFenceGl {
  fenceSync?(condition: number, flags: number): unknown;
  getSyncParameter?(sync: never, pname: number): unknown;
  deleteSync?(sync: never): void;
  flush?(): void;
  isContextLost?(): boolean;
}

export interface LinkFenceScheduler {
  setTimeout(cb: () => void, ms: number): unknown;
  now(): number;
}

const defaultScheduler: LinkFenceScheduler = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  now: () => performance.now(),
};

export interface LinkFenceResult {
  /** The fence signalled: every command before it, the link included, ran. */
  proved: boolean;
  waitedMs: number;
}

const stats = { fences: 0, proved: 0, unproved: 0, maxWaitMs: 0 };

/** Counters for perfStats (renderer_perf_stats.ts linkGate.fence). */
export function linkFenceStats(): {
  fences: number;
  proved: number;
  unproved: number;
  maxWaitMs: number;
} {
  return { ...stats, maxWaitMs: Math.round(stats.maxWaitMs) };
}

/** Test seam. */
export function resetLinkFenceStatsForTests(): void {
  stats.fences = 0;
  stats.proved = 0;
  stats.unproved = 0;
  stats.maxWaitMs = 0;
}

function finish(result: LinkFenceResult): LinkFenceResult {
  if (result.proved) stats.proved++;
  else stats.unproved++;
  if (result.waitedMs > stats.maxWaitMs) stats.maxWaitMs = result.waitedMs;
  return result;
}

/**
 * Issue a fence behind everything submitted so far and resolve once it
 * signals. Call it synchronously right after the compile is issued, so the
 * fence lands directly behind that compile's links.
 */
export function awaitLinkFence(
  gl: LinkFenceGl | null | undefined,
  scheduler: LinkFenceScheduler = defaultScheduler,
): Promise<LinkFenceResult> {
  if (!gl || typeof gl.fenceSync !== 'function' || typeof gl.getSyncParameter !== 'function') {
    return Promise.resolve({ proved: false, waitedMs: 0 });
  }
  let sync: unknown = null;
  try {
    if (gl.isContextLost?.()) return Promise.resolve({ proved: false, waitedMs: 0 });
    sync = gl.fenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    // Submit the fence now, so the GPU process reaches it without waiting for
    // the task's end-of-frame flush.
    gl.flush?.();
  } catch {
    sync = null;
  }
  if (!sync) return Promise.resolve({ proved: false, waitedMs: 0 });
  stats.fences++;
  const start = scheduler.now();
  const release = (): void => {
    try {
      gl.deleteSync?.(sync as never);
    } catch {
      // a context on its way out: nothing to free
    }
  };
  return new Promise((resolve) => {
    const poll = (): void => {
      const waitedMs = scheduler.now() - start;
      let signalled = false;
      try {
        if (gl.isContextLost?.()) {
          release();
          resolve(finish({ proved: false, waitedMs }));
          return;
        }
        signalled = gl.getSyncParameter?.(sync as never, GL_SYNC_STATUS) === GL_SIGNALED;
      } catch {
        release();
        resolve(finish({ proved: false, waitedMs }));
        return;
      }
      if (signalled) {
        release();
        resolve(finish({ proved: true, waitedMs }));
        return;
      }
      if (waitedMs >= LINK_FENCE_MAX_MS) {
        release();
        resolve(finish({ proved: false, waitedMs }));
        return;
      }
      scheduler.setTimeout(poll, LINK_FENCE_POLL_MS);
    };
    scheduler.setTimeout(poll, LINK_FENCE_POLL_MS);
  });
}
