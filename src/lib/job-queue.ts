/**
 * Durable DB-backed job queue (the `jobs` table). Lovable hosts the app on
 * serverless workers, so there is no long-lived worker process or Redis to
 * plug into — Supabase IS the broker. Jobs are claimed atomically (a
 * conditional UPDATE that only lands while the row is still queued), retried
 * with exponential backoff, and marked dead when attempts run out.
 *
 * Worker triggers: getSyncJobStatus (claims + runs the polled job inline)
 * and the cron warm-up (processes everything due). A `processing` row whose
 * poller died mid-run is reclaimed after PROCESSING_STALE_MS.
 */
import type { Json } from "@/integrations/supabase/types";

type SupabaseAdmin = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];

export type QueueJobStatus = "queued" | "processing" | "succeeded" | "failed" | "dead";

const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 10 * 60_000;
const PROCESSING_STALE_MS = 3 * 60_000;

type ClaimedJob = {
  id: string;
  type: string;
  payload: Json;
  attempts: number;
  max_attempts: number;
  timeout_ms: number;
};

type JobHandler = (
  supabaseAdmin: SupabaseAdmin,
  payload: Record<string, unknown>,
) => Promise<unknown>;

const JOB_HANDLERS: Record<string, JobHandler> = {
  // Season sync is idempotent end to end: every write is an upsert keyed by a
  // natural key (season+round, driver id, race_id+driver_id, user+race), so
  // a retry after a timeout can never double-write or corrupt data.
  "season-sync": async (supabaseAdmin, payload) => {
    const { runSeasonSync } = await import("./f1-sync.functions");
    return runSeasonSync(supabaseAdmin, { force: Boolean(payload.force) });
  },
};

export async function enqueueJob(
  supabaseAdmin: SupabaseAdmin,
  job: {
    type: string;
    payload?: Record<string, unknown>;
    dedupKey?: string | null;
    createdBy?: string | null;
    maxAttempts?: number;
    timeoutMs?: number;
  },
): Promise<{ jobId: string; created: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("jobs")
    .insert({
      type: job.type,
      payload: (job.payload ?? {}) as Json,
      dedup_key: job.dedupKey ?? null,
      created_by: job.createdBy ?? null,
      max_attempts: job.maxAttempts ?? 5,
      timeout_ms: job.timeoutMs ?? 60_000,
    })
    .select("id")
    .single();
  if (!error && data) return { jobId: data.id, created: true };
  // 23505: an active job with the same (type, dedup_key) already exists —
  // coalesce onto it instead of queueing a duplicate.
  if (error && (error as { code?: string }).code === "23505" && job.dedupKey) {
    const { data: existing } = await supabaseAdmin
      .from("jobs")
      .select("id")
      .eq("type", job.type)
      .eq("dedup_key", job.dedupKey)
      .in("status", ["queued", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return { jobId: existing.id, created: false };
  }
  throw new Error(error?.message ?? "Failed to enqueue job");
}

async function claimNextJob(
  supabaseAdmin: SupabaseAdmin,
  targetId?: string,
): Promise<ClaimedJob | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let query = supabaseAdmin.from("jobs").select("id, attempts");
    if (targetId) query = query.eq("id", targetId);
    const { data: due } = await query
      .eq("status", "queued")
      .lte("run_after", new Date().toISOString())
      .order("run_after", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!due) return null;
    // Atomic claim: the update only lands while the row is still queued, so
    // two concurrent pollers can never both win the same job.
    const { data: claimed } = await supabaseAdmin
      .from("jobs")
      .update({
        status: "processing",
        started_at: new Date().toISOString(),
        attempts: (due.attempts ?? 0) + 1,
      })
      .eq("id", due.id)
      .eq("status", "queued")
      .select("id, type, payload, attempts, max_attempts, timeout_ms")
      .maybeSingle();
    if (claimed) {
      return {
        id: claimed.id,
        type: claimed.type,
        payload: claimed.payload,
        attempts: claimed.attempts,
        max_attempts: claimed.max_attempts,
        timeout_ms: claimed.timeout_ms,
      };
    }
  }
  return null;
}

async function finishJob(
  supabaseAdmin: SupabaseAdmin,
  job: ClaimedJob,
  ok: boolean,
  outcome: { result?: unknown; error?: string },
): Promise<void> {
  const nowIso = new Date().toISOString();
  if (ok) {
    await supabaseAdmin
      .from("jobs")
      .update({
        status: "succeeded",
        finished_at: nowIso,
        result: (outcome.result ?? null) as Json,
        last_error: null,
      })
      .eq("id", job.id);
    return;
  }
  const dead = job.attempts >= job.max_attempts;
  const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (job.attempts - 1), BACKOFF_CAP_MS);
  await supabaseAdmin
    .from("jobs")
    .update({
      status: dead ? "dead" : "queued",
      finished_at: dead ? nowIso : null,
      last_error: (outcome.error ?? "unknown error").slice(0, 500),
      run_after: new Date(Date.now() + backoffMs).toISOString(),
    })
    .eq("id", job.id);
}

export async function processDueJobs(
  supabaseAdmin: SupabaseAdmin,
  opts: { limit?: number; onlyJobId?: string } = {},
): Promise<number> {
  const limit = opts.limit ?? 3;
  // Reclaim jobs whose worker died mid-run (poll request aborted / isolate
  // evicted): after the stale window they go back to the queue for a retry.
  await supabaseAdmin
    .from("jobs")
    .update({ status: "queued", started_at: null })
    .eq("status", "processing")
    .lt("started_at", new Date(Date.now() - PROCESSING_STALE_MS).toISOString());
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const job = await claimNextJob(supabaseAdmin, opts.onlyJobId);
    if (!job) break;
    const handler = JOB_HANDLERS[job.type];
    if (!handler) {
      await finishJob(supabaseAdmin, job, false, {
        error: `No handler registered for job type "${job.type}"`,
      });
      processed++;
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const payload = (job.payload ?? {}) as unknown as Record<string, unknown>;
      const work = handler(supabaseAdmin, payload);
      // A late rejection (after the timeout already won the race) must not
      // become an unhandled rejection.
      void work.catch(() => undefined);
      const result = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Job "${job.type}" timed out after ${job.timeout_ms}ms`)),
            job.timeout_ms,
          );
        }),
      ]);
      await finishJob(supabaseAdmin, job, true, { result });
    } catch (err) {
      await finishJob(supabaseAdmin, job, false, {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    processed++;
  }
  return processed;
}
