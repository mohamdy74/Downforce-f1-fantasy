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
  const { checkAndSendPushReminders, runSeasonSync } = await import("./f1-sync.functions");
  await checkAndSendPushReminders(supabaseAdmin).catch(() => null);
  void runSeasonSync(supabaseAdmin, { force: false }).catch(() => null);
}
