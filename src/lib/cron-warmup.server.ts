// Server-only /reminders warm-up: the Telegram reminder sweep + the season-sync
// warm-up. Only ever imported from server-function handler code (cron.functions.ts)
// — route files must not import it, because their component ships to the browser
// and the request API below is server-only.
import { cronRequestAuthorized, readServerEnv } from "./env";

export async function runRemindersWarmUp(): Promise<void> {
  if (!readServerEnv("SUPABASE_SERVICE_ROLE_KEY")) return;

  // Only authenticated cron machines (x-cron-secret header) may trigger the
  // warm-up. Real browsers skip this; while CRON_SECRET is unset the warm-up
  // stays open exactly as before.
  let headerSecret: string | null = null;
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    headerSecret = getRequestHeader("x-cron-secret") ?? null;
  } catch {
    headerSecret = null;
  }
  if (!cronRequestAuthorized(headerSecret)) return;

  // The Telegram sweep used to be reachable only at POST /api/cron/reminders,
  // which no scheduler calls (the GitHub workflow pings /reminders). Run it
  // here so the 10-minute ping is the real trigger.
  const { runTelegramReminderSweep } = await import("./telegram.server");
  await runTelegramReminderSweep().catch(() => null);

  // Season sync runs as a queue job: enqueue (dedup coalesces with any active
  // job), then process everything due inline — the cron curl waits long enough
  // (GH workflow --max-time 150) for the job to finish here.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { enqueueJob, processDueJobs } = await import("./job-queue");
  await enqueueJob(supabaseAdmin, {
    type: "season-sync",
    payload: { force: false },
    dedupKey: "season-sync",
    maxAttempts: 5,
    timeoutMs: 60_000,
  }).catch(() => null);
  await processDueJobs(supabaseAdmin, { limit: 3 }).catch(() => 0);
}
