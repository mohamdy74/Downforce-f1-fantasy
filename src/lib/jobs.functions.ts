import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { QueueJobStatus } from "./job-queue";

/**
 * Frontend job-status poll. Doubles as the queue's worker trigger for the
 * polled job: if it is still queued/processing, this call claims and runs
 * it (bounded by the job's own timeout) before returning the status — so a
 * user-triggered job starts within one poll interval even without cron.
 */
export const getSyncJobStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ({
    jobId: String((input as { jobId?: unknown } | null)?.jobId ?? ""),
  }))
  .handler(async ({ data }) => {
    if (!data.jobId) throw new Error("Missing jobId");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { processDueJobs } = await import("./job-queue");
    // Try to move this job forward before reporting. A failing job is a
    // status, not a broken poll — never throw for it.
    await processDueJobs(supabaseAdmin, { limit: 1, onlyJobId: data.jobId }).catch(() => 0);
    const { data: job } = await supabaseAdmin
      .from("jobs")
      .select("id, status, attempts, last_error, finished_at, result")
      .eq("id", data.jobId)
      .maybeSingle();
    if (!job) throw new Error("Job not found");
    return {
      jobId: job.id,
      status: job.status as QueueJobStatus,
      attempts: job.attempts,
      lastError: job.last_error,
      finishedAt: job.finished_at,
      result: (job.result ?? null) as { skipped?: boolean; races?: number; scored?: number } | null,
    };
  });
