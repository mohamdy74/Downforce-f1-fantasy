// Server-only /reminders warm-up: the cron sweep + season sync. Only ever
// imported from server-function handler code (push.functions.ts) — route files
// must not import it, because their component ships to the browser and the
// request API below is server-only.
import { cronRequestAuthorized, readServerEnv } from "./env";

export async function runRemindersWarmUp(): Promise<void> {
  if (!readServerEnv("SUPABASE_SERVICE_ROLE_KEY")) return;

  // Only authenticated cron machines (x-cron-secret header) may trigger the
  // server-side reminder sweep + season sync. Real browsers skip this and run
  // BackgroundSync client-side instead; while CRON_SECRET is unset the warm-up
  // stays open exactly as before.
  let headerSecret: string | null = null;
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    headerSecret = getRequestHeader("x-cron-secret") ?? null;
  } catch {
    headerSecret = null;
  }
  if (!cronRequestAuthorized(headerSecret)) return;

  // Sweep directly instead of round-tripping through the public server
  // function: the header was already validated above, and this keeps working
  // even once checkAndSendRaceReminders starts enforcing x-cron-secret.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { checkAndSendPushReminders } = await import("./f1-sync.functions");
  const { enqueueJob, processDueJobs } = await import("./job-queue");
  await checkAndSendPushReminders(supabaseAdmin).catch(() => null);
  // Season sync runs as a queue job now: enqueue (dedup coalesces with any
  // active job), then process everything due inline — the cron curl waits
  // long enough (GH workflow --max-time 150) for the job to finish here.
  await enqueueJob(supabaseAdmin, {
    type: "season-sync",
    payload: { force: false },
    dedupKey: "season-sync",
    maxAttempts: 5,
    timeoutMs: 60_000,
  }).catch(() => null);
  await processDueJobs(supabaseAdmin, { limit: 3 }).catch(() => 0);
}
