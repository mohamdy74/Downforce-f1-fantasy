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

export const checkAndSendRaceReminders = createServerFn({ method: "POST" })
  .inputValidator((input: { forceWindow?: "2h" | "30m" | null | undefined } | undefined) => ({
    forceWindow: input?.forceWindow ?? null,
  }))
  .handler(async () => {
    // Single consolidated reminder sweep: windows, pole/race targets, and
    // per-user dedup live in f1-sync.functions.checkAndSendPushReminders.
    // This server function stays the public entry used by the /reminders
    // cron warm-up and BackgroundSync.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { checkAndSendPushReminders } = await import("./f1-sync.functions");
    const sent = await checkAndSendPushReminders(supabaseAdmin);
    return { sent };
  });
