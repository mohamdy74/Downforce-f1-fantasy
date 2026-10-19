import { createServerFn } from "@tanstack/react-start";

import { VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY } from "@/lib/push-keys";

// NOTE: getVapidPublicKey (dead, 0 imports) removed — clients import
// VAPID_PUBLIC_KEY from @/lib/push-keys instead.
// NOTE: savePushSubscription duplicate removed — single source is
// savePushSubscription in @/lib/stewards.functions.ts.

export const checkAndSendRaceReminders = createServerFn({ method: "POST" })
  .inputValidator((input: { forceWindow?: "2h" | "30m" | null } | undefined) => ({
    forceWindow: input?.forceWindow ?? null,
  }))
  .handler(async ({ data }) => {
    const pub = VAPID_PUBLIC_KEY;
    const priv = VAPID_PRIVATE_KEY;
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

    const [{ data: sLogs }, { data: sSubs }] = await Promise.all([supabaseAdmin.from("sync_state").select("key").like("key", "push_log:" + race.id + ":" + windowTag + ":%"), supabaseAdmin.from("sync_state").select("key").like("key", "push_sub:%")]); const sentSet = new Set((sLogs ?? []).map((r) => r.key.split(":").pop()!)); const targetSubs = (sSubs ?? []).flatMap((r) => { const m = /^push_sub:([^:]+):(.+)$/.exec(r.key); return !m || completedUsers.has(m[1]!) || sentSet.has(m[1]!) ? [] : [{ user_id: m[1]!, ...JSON.parse(m[2]!) }]; }); if (!targetSubs.length) return { sent: 0, windowTag, reason: "No pending un-notified users" };

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

    if (newlyNotified.size > 0) { await supabaseAdmin.from("sync_state").upsert(Array.from(newlyNotified).map((uid) => ({ key: "push_log:" + race.id + ":" + windowTag + ":" + uid, synced_at: new Date().toISOString() })), { onConflict: "key" }); } return { sent, windowTag, raceName: race.name };
  });
