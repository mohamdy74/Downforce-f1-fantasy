import { createServerFn } from "@tanstack/react-start";

export const getServerVapidPublicKey = createServerFn({ method: "POST" })
  .inputValidator((input: Record<string, unknown> | undefined) => input ?? {})
  .handler(async () => {
    const { resolveServerVapidKeys } = await import("./webpush-native");
    const { publicKey } = await resolveServerVapidKeys();
    return {
      publicKey,
    };
  });

export const runRemindersCronWarmUp = createServerFn({ method: "POST" })
  .inputValidator((input: Record<string, unknown> | undefined) => input ?? {})
  .handler(async () => {
    // Cron-warm-up entry for the /reminders loader: reminder sweep + season
    // sync, gated by the optional CRON_SECRET. Server-function handler code
    // compiles server-only, so it may import the server-only warm-up module
    // (route files must not — their component ships to the browser).
    const { runRemindersWarmUp } = await import("./cron-warmup.server");
    await runRemindersWarmUp();
    return { ok: true as const };
  });

export const checkAndSendRaceReminders = createServerFn({ method: "POST" })
  .inputValidator((input: { forceWindow?: "2h" | "30m" | null | undefined } | undefined) => ({
    forceWindow: input?.forceWindow ?? null,
  }))
  .handler(async () => {
    // Public entry shared by the /reminders cron warm-up and BackgroundSync.
    // Once CRON_SECRET is configured in Lovable Secrets AND the service-role
    // cron path is live, only requests carrying the matching x-cron-secret
    // header may trigger the sweep; until then it stays open (soft gate).
    let headerSecret: string | null = null;
    try {
      const { getRequestHeader } = await import("@tanstack/react-start/server");
      headerSecret = getRequestHeader("x-cron-secret") ?? null;
    } catch {
      headerSecret = null;
    }
    const { raceRemindersSweepAuthorized } = await import("./env");
    if (!raceRemindersSweepAuthorized(headerSecret)) {
      throw new Error("Unauthorized: missing or invalid x-cron-secret header");
    }
    // Single consolidated reminder sweep: windows, pole/race targets, and
    // per-user dedup live in f1-sync.functions.checkAndSendPushReminders.
    // This server function stays the public entry used by BackgroundSync.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { checkAndSendPushReminders } = await import("./f1-sync.functions");
    const sent = await checkAndSendPushReminders(supabaseAdmin);
    return { sent };
  });
