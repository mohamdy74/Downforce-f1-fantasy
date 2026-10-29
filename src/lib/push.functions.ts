import { createServerFn } from "@tanstack/react-start";

import { isCompleteTop10, parsePushSubscriptionKey } from "@/lib/push-keys";

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
  .handler(async ({ data }) => {
    const { resolveServerVapidKeys, sendNativeWebPush } = await import("./webpush-native");
    const { publicKey: pub, privateKey: priv } = await resolveServerVapidKeys();
    if (!pub || !priv) {
      console.error("[WebPush] VAPID keys not configured on server.");
      return { sent: 0, reason: "VAPID keys not configured" };
    }

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

    let windowTag: "2h" | "30m" | null = data.forceWindow;
    if (!windowTag) {
      if (minsLeft <= 125 && minsLeft >= 95) windowTag = "2h";
      else if (minsLeft <= 35 && minsLeft >= 10) windowTag = "30m";
    }
    if (!windowTag) return { sent: 0, minsLeft: Math.round(minsLeft), reason: "Outside 2h and 30m windows" };

    const { data: preds } = await supabaseAdmin
      .from("predictions")
      .select("user_id, top10")
      .eq("race_id", race.id);

    const completedUsers = new Set(
      (preds ?? [])
        .filter((p) => isCompleteTop10(p.top10))
        .map((p) => p.user_id),
    );

    const [{ data: sLogs }, { data: sSubs }] = await Promise.all([
      supabaseAdmin.from("sync_state").select("key").like("key", "push_log:" + race.id + ":" + windowTag + ":%"),
      supabaseAdmin.from("sync_state").select("key").like("key", "push_sub:%"),
    ]);
    const sentSet = new Set((sLogs ?? []).map((r) => r.key.split(":").pop()!));
    const targetSubs = (sSubs ?? []).flatMap((r) => {
      const parsed = parsePushSubscriptionKey(r.key);
      if (!parsed || completedUsers.has(parsed.userId) || sentSet.has(parsed.userId)) return [];
      return [parsed];
    });
    if (!targetSubs.length) return { sent: 0, windowTag, reason: "No pending un-notified users" };

    const payloadObj = {
      title:
        windowTag === "30m"
          ? `ðŸš¨ 30 mins left â€” ${race.name}!`
          : `â° 2 hours to ${race.name}!`,
      body:
        windowTag === "30m"
          ? "Final call! You still haven't locked in your Top 10. Tap here now before picks lock (-25 pts)!"
          : "You haven't submitted your picks yet. Tap to open Predict and lock in your Top 10!",
      tag: `downforce-${race.id}-${windowTag}`,
      url: "/predict",
    };

    let sent = 0;
    const newlyNotified = new Set<string>();
    const expiredKeys: string[] = [];
    for (const sub of targetSubs) {
      const res = await sendNativeWebPush(
        {
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
        payloadObj,
      );
      if (res.ok) {
        sent++;
        newlyNotified.add(sub.userId);
      } else if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
        expiredKeys.push(sub.rawKey);
      }
    }

    if (expiredKeys.length > 0) {
      await supabaseAdmin.from("sync_state").delete().in("key", expiredKeys);
    }

    if (newlyNotified.size > 0) {
      await supabaseAdmin.from("sync_state").upsert(
        Array.from(newlyNotified).map((uid) => ({
          key: "push_log:" + race.id + ":" + windowTag + ":" + uid,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "key" },
      );
    }
    return { sent, windowTag, raceName: race.name };
  });
