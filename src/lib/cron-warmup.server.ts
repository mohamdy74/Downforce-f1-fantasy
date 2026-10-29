// Server-only /reminders warm-up: the cron sweep + season sync.
// Lives in a .server.ts module because it imports the server-only
// @tanstack/react-start/server request API, which client-graph files (route
// files ship their component to the browser) may not import directly.
import { getRequestHeader } from "@tanstack/react-start/server";

import { cronRequestAuthorized, readServerEnv } from "./env";

export async function runRemindersWarmUp(): Promise<void> {
  if (!readServerEnv("SUPABASE_SERVICE_ROLE_KEY")) return;

  // Only authenticated cron machines (x-cron-secret header) may trigger the
  // server-side reminder sweep + season sync. Real browsers skip this and run
  // BackgroundSync client-side instead; while CRON_SECRET is unset the warm-up
  // stays open exactly as before.
  let headerSecret: string | null = null;
  try {
    headerSecret = getRequestHeader("x-cron-secret") ?? null;
  } catch {
    headerSecret = null;
  }
  if (!cronRequestAuthorized(headerSecret)) return;

  const { checkAndSendRaceReminders } = await import("./push.functions");
  await checkAndSendRaceReminders({ data: {} }).catch(() => null);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { runSeasonSync } = await import("./f1-sync.functions");
  void runSeasonSync(supabaseAdmin, { force: false }).catch(() => null);
}
