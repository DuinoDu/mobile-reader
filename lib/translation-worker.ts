import "server-only";

import {
  claimNextTranslationJob,
  completeTranslationJob,
  failOrRequeueTranslationJob,
  nextQueuedTranslationDelayMs,
  recoverStuckTranslationJobs,
  updateTranslationJobProgress,
} from "@/lib/db";
import {
  TranslationNotConfiguredError,
  translateHtmlToChinese,
} from "@/lib/translate";

/**
 * In-process translation worker.
 *
 * Jobs live in the `translation_jobs` table (the durable queue). This module is
 * just the drain loop: claim → translate → persist, with retry/backoff handled
 * in the DB layer. It is a process-wide singleton (kept on globalThis so Next's
 * dev HMR doesn't spawn duplicates) and is safe to "ensure" from any request.
 *
 * Durability: on first start we reclaim leases left "running" by a previous
 * process (crash/restart), so no job is lost. While draining we sequentially
 * process all immediately-runnable jobs; when only backed-off jobs remain we
 * schedule a single wake-up timer instead of busy-looping.
 */

const LEASE_MS = 120_000;
const MAX_WAKE_DELAY_MS = 60_000;

interface WorkerState {
  recovered: boolean;
  draining: boolean;
  wakeTimer: ReturnType<typeof setTimeout> | null;
}

const globalForWorker = globalThis as unknown as {
  __mrTranslationWorker?: WorkerState;
};

function state(): WorkerState {
  if (!globalForWorker.__mrTranslationWorker) {
    globalForWorker.__mrTranslationWorker = {
      recovered: false,
      draining: false,
      wakeTimer: null,
    };
  }
  return globalForWorker.__mrTranslationWorker;
}

/** Idempotently start (or nudge) the worker. Call after enqueuing a job. */
export function ensureTranslationWorker(): void {
  const s = state();
  if (!s.recovered) {
    s.recovered = true;
    try {
      recoverStuckTranslationJobs();
    } catch {
      // best-effort; a later claim will still pick jobs up
    }
  }
  kick();
}

function kick(): void {
  const s = state();
  if (s.wakeTimer) {
    clearTimeout(s.wakeTimer);
    s.wakeTimer = null;
  }
  if (s.draining) return;
  s.draining = true;
  void drain().finally(() => {
    s.draining = false;
  });
}

async function drain(): Promise<void> {
  for (;;) {
    let claimed: ReturnType<typeof claimNextTranslationJob>;
    try {
      claimed = claimNextTranslationJob(LEASE_MS);
    } catch {
      claimed = null;
    }
    if (!claimed) {
      scheduleWake();
      return;
    }
    await processJob(claimed.job.id, claimed.html);
  }
}

/** When only backed-off jobs remain, wake once when the soonest becomes due. */
function scheduleWake(): void {
  const s = state();
  let delay: number | null = null;
  try {
    delay = nextQueuedTranslationDelayMs();
  } catch {
    delay = null;
  }
  if (delay == null) return;
  const wait = Math.min(Math.max(delay, 500), MAX_WAKE_DELAY_MS);
  if (s.wakeTimer) clearTimeout(s.wakeTimer);
  s.wakeTimer = setTimeout(() => {
    s.wakeTimer = null;
    kick();
  }, wait);
  // Don't keep the event loop alive just for the queue.
  s.wakeTimer.unref?.();
}

async function processJob(jobId: string, html: string): Promise<void> {
  try {
    const { html: zh, total, done, truncated } = await translateHtmlToChinese(
      html,
      (d, t) => {
        try {
          updateTranslationJobProgress(jobId, d, t, LEASE_MS);
        } catch {
          // heartbeat failures are non-fatal
        }
      }
    );

    if (total === 0) {
      // Nothing translatable (e.g. all code/images) — not a failure.
      completeTranslationJob(jobId, {
        htmlZh: null,
        total: 0,
        done: 0,
        docStatus: "none",
      });
      return;
    }

    if (done === 0) {
      // Had text but every batch failed — transient; let backoff retry.
      failOrRequeueTranslationJob(jobId, "no_segments_translated");
      return;
    }

    const docStatus = done >= total && !truncated ? "translated" : "partial";
    completeTranslationJob(jobId, { htmlZh: zh, total, done, docStatus });
  } catch (error) {
    if (error instanceof TranslationNotConfiguredError) {
      failOrRequeueTranslationJob(jobId, "deepseek_not_configured", true);
    } else {
      failOrRequeueTranslationJob(
        jobId,
        error instanceof Error ? error.message : "translation_error"
      );
    }
  }
}
