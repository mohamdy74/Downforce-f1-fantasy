import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getVapidPublicKey = createServerFn({ method: "GET" }).handler(async () => {
  const pub = process.env["VITE_VAPID_PUBLIC_KEY"] || process.env["VAPID_PUBLIC_KEY"] || "";
  return { publicKey: pub };
});

export const savePushSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { endpoint: string; p256dh: string; auth: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const sb = supabaseAdmin as unknown as {
      from: (table: string) => {
        upsert: (row: Record<string, unknown>, opts?: { onConflict?: string }) => Promise<{ error: { message: string } | null }>;
      };
    };

    const { error } = await sb.from("push_subscriptions").upsert(
      {
        user_id: context.userId,
        endpoint: data.endpoint,
        p256dh: data.p256dh,
        auth: data.auth,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,endpoint" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const checkAndSendRaceReminders = createServerFn({ method: "POST" })
  .inputValidator((input: { forceWindow?: "2h" | "30m" | null } | undefined) => ({
    forceWindow: input?.forceWindow ?? null,
  }))
  .handler(async ({ data }) => {
    const pub = process.env["VITE_VAPID_PUBLIC_KEY"] || process.env["VAPID_PUBLIC_KEY"] || "";
    const priv = process.env["VAPID_PRIVATE_KEY"] || "";
    if (!pub || !priv) return { sent: 0, reason: "VAPID keys not configured" };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const now = Date.now();
    const in3Hours = new Date(now + 3 * 3600_000).toISOString();
    const nowIso = new Date(now).toISOString();

    const { data: upcomingRaces } = await supabaseAdmin
      .from("races")
      .select("id, name, round, race_at")
      .gt("race_at", nowIso)
      .lte("race_at", in3Hours)
      .order("race_at", { ascending: true })
      .limit(1);

    const race = upcomingRaces?.[0];
    if (!race) return { sent: 0, reason: "No race starting within 3 hours" };

    const minsLeft = (new Date(race.race_at).getTime() - now) / 60_000;

    // Determine active reminder window:
    // - "2h" window: between 125 and 95 minutes before race start
    // - "30m" window: between 35 and 10 minutes before race start
    let windowTag: "2h" | "30m" | null = data.forceWindow;
    if (!windowTag) {
      if (minsLeft <= 125 && minsLeft >= 95) windowTag = "2h";
      else if (minsLeft <= 35 && minsLeft >= 10) windowTag = "30m";
    }
    if (!windowTag) return { sent: 0, minsLeft: Math.round(minsLeft), reason: "Outside 2h and 30m windows" };

    // Find users who ALREADY submitted all 10 picks for this race
    const { data: preds } = await supabaseAdmin
      .from("predictions")
      .select("user_id, top10")
      .eq("race_id", race.id);

    const completedUsers = new Set(
      (preds ?? [])
        .filter((p) => (p.top10 ?? []).filter(Boolean).length === 10)
        .map((p) => p.user_id),
    );

    const rawSb = supabaseAdmin as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (c: string, v: string) => {
            eq: (c2: string, v2: string) => Promise<{ data: Array<Record<string, string>> | null }>;
          };
        };
        insert: (rows: Array<Record<string, unknown>>) => Promise<unknown>;
      };
    };

    // Check who was already notified in this specific window ("2h" or "30m")
    const { data: alreadySent } = await rawSb
      .from("push_notifications_log")
      .select("user_id")
      .eq("race_id", race.id)
      .eq("window_tag", windowTag);

    const alreadyNotifiedUsers = new Set((alreadySent ?? []).map((r) => r["user_id"]!));

    // Load all push subscriptions
    const { data: allSubs } = await (supabaseAdmin as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: Array<{ user_id: string; endpoint: string; p256dh: string; auth: string }> | null }> };
    }).from("push_subscriptions").select("user_id, endpoint, p256dh, auth");

    const targetSubs = (allSubs ?? []).filter(
      (s) => !completedUsers.has(s.user_id) && !alreadyNotifiedUsers.has(s.user_id),
    );

    if (!targetSubs.length) return { sent: 0, windowTag, reason: "No pending un-notified users" };

    const webpush = await import(/* @vite-ignore */ "web-" + "push");
    webpush.default.setVapidDetails("mailto:admin@downforce.app", pub, priv);

    const payload = JSON.stringify({
      title:
        windowTag === "30m"
          ? `🚨 30 mins left — ${race.name}!`
          : `⏰ 2 hours to ${race.name}!`,
      body:
        windowTag === "30m"
          ? "Final call! You still haven't locked in your Top 10. Tap here now before picks lock (-25 pts)!"
          : "You haven't submitted your picks yet. Tap to open Predict and lock in your Top 10!",
      tag: `downforce-${race.id}-${windowTag}`,
      url: "/predict",
    });

    let sent = 0;
    const newlyNotified = new Set<string>();
    for (const sub of targetSubs) {
      try {
        await webpush.default.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
        sent++;
        newlyNotified.add(sub.user_id);
      } catch {
        // Subscription expired or invalid
      }
    }

    if (newlyNotified.size > 0) {
      await rawSb.from("push_notifications_log").insert(
        Array.from(newlyNotified).map((uid) => ({
          race_id: race.id,
          user_id: uid,
          window_tag: windowTag,
        })),
      );
    }

    return { sent, windowTag, raceName: race.name };
  });
