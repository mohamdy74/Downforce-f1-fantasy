import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";
import { scorePrediction, NO_SUBMISSION_PENALTY, type ResultRow } from "./scoring";
import { scoreSprint, type SprintResultRow } from "./sprintScoring";

export const STEWARD_EMAIL = "mohamdy008@gmail.com";

async function requireSteward(context: { userId: string; claims?: Record<string, unknown> }) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let email = String(context.claims?.["email"] ?? "").toLowerCase();
  if (!email) {
    const { data } = await supabaseAdmin.auth.admin.getUserById(context.userId);
    email = (data.user?.email ?? "").toLowerCase();
  }
  if (email !== STEWARD_EMAIL) {
    throw new Error("Forbidden: FIA Stewards access is restricted to mohamdy008@gmail.com");
  }
  return supabaseAdmin;
}

export const getServerVapidPublicKey = createServerFn({ method: "GET" }).handler(async () => {
  const raw =
    process.env["VAPID_PUBLIC_KEY"] ||
    process.env["VITE_VAPID_PUBLIC_KEY"] ||
    "";
  return {
    publicKey: raw.trim().replace(/^["']+|["']+$/g, "").trim(),
  };
});

export const savePushSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { endpoint: string; p256dh: string; auth: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const prefix = `push_sub:${context.userId}:`;
    const { data: existing } = await supabaseAdmin
      .from("sync_state")
      .select("key")
      .like("key", `${prefix}%`);

    const staleKeys: string[] = [];
    for (const r of existing ?? []) {
      try {
        const parsed = JSON.parse(r.key.slice(prefix.length)) as { endpoint?: string };
        if (parsed.endpoint === data.endpoint) staleKeys.push(r.key);
      } catch {
        staleKeys.push(r.key);
      }
    }
    if (staleKeys.length > 0) {
      await supabaseAdmin.from("sync_state").delete().in("key", staleKeys);
    }

    const key = `${prefix}${JSON.stringify(data)}`;
    await supabaseAdmin
      .from("sync_state")
      .upsert({ key, synced_at: new Date().toISOString() }, { onConflict: "key" });
    return { ok: true };
  });

export const getStewardsDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { raceId: string }) => d)
  .handler(async ({ data, context }) => {
    const sb = await requireSteward(context);
    const [{ data: profiles }, { data: preds }, { data: scores }, { data: results }, { data: subRows }] =
      await Promise.all([
        sb.from("profiles").select("id, display_name, created_at").order("display_name"),
        sb
          .from("predictions")
          .select("id, user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id, updated_at")
          .eq("race_id", data.raceId),
        sb.from("scores").select("user_id, points, breakdown").eq("race_id", data.raceId),
        sb
          .from("race_results")
          .select("driver_id, position, finished, fastest_lap, pole")
          .eq("race_id", data.raceId),
        sb.from("sync_state").select("key").like("key", "push_sub:%"),
      ]);

    const pushUserIds = Array.from(
      new Set(
        (subRows ?? [])
          .map((r) => /^push_sub:([^:]+):/.exec(r.key)?.[1])
          .filter((x): x is string => !!x),
      ),
    );

    return {
      profiles: profiles ?? [],
      preds: preds ?? [],
      scores: scores ?? [],
      results: results ?? [],
      pushUserIds,
    };
  });

export const executeStewardAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    action:
      | "override_score"
      | "remove_penalty"
      | "rename_player"
      | "delete_player"
      | "shift_deadline"
      | "set_exact_deadline"
      | "override_picks"
      | "manual_results"
      | "nudge_missing_push"
      | "test_my_push";
    raceId?: string | undefined;
    userId?: string | undefined;
    points?: number | undefined;
    name?: string | undefined;
    minutes?: number | undefined;
    isoTime?: string | undefined;
    target?: "qualifying" | "race" | undefined;
    pole?: string | null | undefined;
    fl?: string | null | undefined;
    dnf?: string | null | undefined;
    top10?: string[] | undefined;
    dnfs?: string[] | undefined;
    title?: string | undefined;
    body?: string | undefined;
  }) => d)
  .handler(async ({ data: d, context }) => {
    const sb = await requireSteward(context);

    if ((d.action === "override_score" || d.action === "remove_penalty") && d.userId && d.raceId) {
      const pts = d.action === "remove_penalty" ? 0 : (d.points ?? 0);
      const { error } = await sb.from("scores").upsert(
        {
          user_id: d.userId,
          race_id: d.raceId,
          points: pts,
          breakdown: { stewardOverride: true, total: pts } as unknown as Json,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,race_id" },
      );
      if (error) throw new Error(`Database error: ${error.message}`);
      return { ok: true, msg: `Score locked to ${pts} pts (protected from auto-sync overwrite).` };
    }

    if (d.action === "rename_player" && d.userId && d.name) {
      const { error } = await sb.from("profiles").update({ display_name: d.name.trim() }).eq("id", d.userId);
      if (error) throw new Error(`Database error: ${error.message}`);
      return { ok: true, msg: "Player display name updated." };
    }

    if (d.action === "delete_player" && d.userId) {
      await sb.from("scores").delete().eq("user_id", d.userId);
      await sb.from("predictions").delete().eq("user_id", d.userId);
      await sb.from("sprint_predictions").delete().eq("user_id", d.userId);
      const { error } = await sb.from("profiles").delete().eq("id", d.userId);
      if (error) throw new Error(`Database error: ${error.message}`);
      return { ok: true, msg: "Player and associated records removed." };
    }

    if (d.action === "set_exact_deadline" && d.raceId && d.isoTime) {
      const parsed = new Date(d.isoTime);
      if (Number.isNaN(parsed.getTime())) throw new Error("Invalid date/time format");
      const updateData =
        d.target === "qualifying"
          ? { qualifying_at: parsed.toISOString() }
          : { race_at: parsed.toISOString() };
      const { error } = await sb.from("races").update(updateData).eq("id", d.raceId);
      if (error) throw new Error(`Database error: ${error.message}`);
      await sb
        .from("sync_state")
        .upsert({ key: `deadline_override:${d.raceId}`, synced_at: new Date().toISOString() }, { onConflict: "key" });
      return { ok: true, msg: `${d.target === "qualifying" ? "Qualifying" : "Race"} deadline updated & locked!` };
    }

    if (d.action === "shift_deadline" && d.raceId && d.minutes != null) {
      const { data: r } = await sb.from("races").select("race_at, qualifying_at").eq("id", d.raceId).single();
      if (!r) throw new Error("Race not found");
      const cur = (d.target === "qualifying" ? r.qualifying_at : r.race_at) ?? r.race_at;
      const nextIso = new Date(new Date(cur).getTime() + d.minutes * 60_000).toISOString();
      const updateData =
        d.target === "qualifying"
          ? { qualifying_at: nextIso }
          : { race_at: nextIso };
      const { error } = await sb.from("races").update(updateData).eq("id", d.raceId);
      if (error) throw new Error(`Database error: ${error.message}`);
      await sb
        .from("sync_state")
        .upsert({ key: `deadline_override:${d.raceId}`, synced_at: new Date().toISOString() }, { onConflict: "key" });
      return { ok: true, msg: `${d.target === "qualifying" ? "Qualifying" : "Race"} shifted by ${d.minutes > 0 ? "+" : ""}${d.minutes}m & locked.` };
    }

    if (d.action === "override_picks" && d.userId && d.raceId) {
      const { data: existing } = await sb.from("predictions").select("id").eq("user_id", d.userId).eq("race_id", d.raceId).maybeSingle();
      const payload = {
        user_id: d.userId,
        race_id: d.raceId,
        top10: d.top10 ?? [],
        pole_driver_id: d.pole || null,
        fastest_lap_driver_id: d.fl || null,
        dnf_driver_id: d.dnf || null,
        updated_at: new Date().toISOString(),
      };
      let predId = existing?.id ?? d.userId;
      if (existing?.id) {
        const { error } = await sb.from("predictions").update(payload).eq("id", existing.id);
        if (error) throw new Error(`Database error: ${error.message}`);
      } else {
        const { data: ins, error } = await sb.from("predictions").insert(payload).select("id").single();
        if (error) throw new Error(`Database error: ${error.message}`);
        if (ins?.id) predId = ins.id;
      }
      await sb.from("prediction_logs").insert({
        user_id: d.userId,
        race_id: d.raceId,
        prediction_id: predId,
        action: "stewards",
        changes: { pole: d.pole ?? null, fl: d.fl ?? null, dnf: d.dnf ?? null, top10: [[], d.top10 ?? []] } as unknown as Json,
      });
      return { ok: true, msg: "Player picks saved & logged by Stewards." };
    }

    if (d.action === "manual_results" && d.raceId && d.top10 && d.top10.length === 10) {
      const { data: drivers } = await sb.from("drivers").select("id").eq("active", true);
      const dnfSet = new Set(d.dnfs ?? []);
      const rows = (drivers ?? []).map((drv) => {
        const posIdx = d.top10!.indexOf(drv.id);
        const isDnf = dnfSet.has(drv.id);
        return {
          race_id: d.raceId!,
          driver_id: drv.id,
          position: !isDnf && posIdx !== -1 ? posIdx + 1 : null,
          finished: !isDnf,
          status: isDnf ? "Retired" : "Finished",
          pole: drv.id === d.pole,
          fastest_lap: drv.id === d.fl,
        };
      });
      await sb.from("race_results").upsert(rows, { onConflict: "race_id,driver_id" });
      await sb.from("races").update({ has_results: true }).eq("id", d.raceId);

      const { data: raceRow } = await sb.from("races").select("race_at").eq("id", d.raceId).single();
      const [
        { data: profiles },
        { data: preds },
        { data: sprintResults },
        { data: sprintPreds },
        { data: existingScores },
      ] = await Promise.all([
        sb.from("profiles").select("id, created_at"),
        sb.from("predictions").select("user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id").eq("race_id", d.raceId),
        sb.from("sprint_results").select("driver_id, position, finished, pole").eq("race_id", d.raceId),
        sb.from("sprint_predictions").select("user_id, top8, pole_driver_id").eq("race_id", d.raceId),
        sb.from("scores").select("user_id, breakdown").eq("race_id", d.raceId),
      ]);

      const stewardLockedUsers = new Set(
        (existingScores ?? [])
          .filter((s) => {
            const b = s.breakdown as Record<string, unknown> | null;
            return b && b["stewardOverride"] === true;
          })
          .map((s) => s.user_id),
      );

      const byU = new Map((preds ?? []).map((p) => [p.user_id, p]));
      const sprintByU = new Map((sprintPreds ?? []).map((p) => [p.user_id, p]));
      const sprintFor = (uid: string) =>
        sprintResults?.length
          ? scoreSprint(sprintByU.get(uid) ?? null, sprintResults as SprintResultRow[])
          : null;

      const scoreRows: Array<{
        user_id: string;
        race_id: string;
        points: number;
        breakdown: Json;
        updated_at: string;
      }> = [];
      for (const p of profiles ?? []) {
        if (stewardLockedUsers.has(p.id)) continue;
        if (raceRow?.race_at && new Date(p.created_at) > new Date(raceRow.race_at)) continue;

        const sprint = sprintFor(p.id);
        const pr = byU.get(p.id);
        const validTop10 = (pr?.top10 ?? []).filter((x) => x && x !== "__none__");
        if (!pr || validTop10.length < 10) {
          const poleHit = pr?.pole_driver_id && pr.pole_driver_id === d.pole ? 3 : 0;
          const total = NO_SUBMISSION_PENALTY + poleHit + (sprint?.total ?? 0);
          scoreRows.push({
            user_id: p.id,
            race_id: d.raceId!,
            points: total,
            breakdown: { noSubmission: true, pole: poleHit, ...(sprint ? { sprint } : {}), total } as unknown as Json,
            updated_at: new Date().toISOString(),
          });
        } else {
          const b = scorePrediction(
            { top10: validTop10, pole_driver_id: pr.pole_driver_id, fastest_lap_driver_id: pr.fastest_lap_driver_id, dnf_driver_id: pr.dnf_driver_id },
            rows as ResultRow[],
          );
          const total = b.total + (sprint?.total ?? 0);
          scoreRows.push({
            user_id: p.id,
            race_id: d.raceId!,
            points: total,
            breakdown: { ...b, ...(sprint ? { sprint } : {}), total } as unknown as Json,
            updated_at: new Date().toISOString(),
          });
        }
      }
      if (scoreRows.length) await sb.from("scores").upsert(scoreRows, { onConflict: "user_id,race_id" });
      return { ok: true, msg: `Manual results saved & ${scoreRows.length} players scored (including Sprint)!` };
    }

    if (d.action === "test_my_push") {
      const { sendNativeWebPush } = await import("./webpush-native");
      const { data: subRows } = await sb
        .from("sync_state")
        .select("key")
        .like("key", `push_sub:${context.userId}:%`);
      if (!subRows?.length) {
        return {
          ok: false,
          msg: "Your device is not subscribed yet! Allow notifications on this browser and try again.",
        };
      }
      let sent = 0;
      let lastError = "";
      for (const r of subRows) {
        const m = /^push_sub:([^:]+):(.+)$/.exec(r.key);
        if (!m) continue;
        const sub = JSON.parse(m[2]!) as { endpoint: string; p256dh: string; auth: string };
        const res = await sendNativeWebPush(sub, {
          title: "🏎️ Stewards Test Alert",
          body: "Push notifications are 100% working on your device!",
          tag: "dfr-test-" + Date.now(),
          url: "/stewards",
        });
        if (res.ok) {
          sent++;
        } else {
          if (res.error) lastError = res.error;
          if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
            await sb.from("sync_state").delete().eq("key", r.key);
          }
        }
      }
      if (sent === 0) {
        return {
          ok: false,
          msg: lastError
            ? `Test push failed: ${lastError}`
            : "Test push delivered to 0 devices (tap Test My Phone again to re-sync your browser key).",
        };
      }
      return { ok: true, msg: `Test push delivered to ${sent} of your device(s)!` };
    }

    if (d.action === "nudge_missing_push" && d.raceId) {
      const { sendNativeWebPush } = await import("./webpush-native");
      const [{ data: subRows }, { data: preds }, { data: profiles }] = await Promise.all([
        sb.from("sync_state").select("key").like("key", "push_sub:%"),
        sb.from("predictions").select("user_id, top10").eq("race_id", d.raceId),
        sb.from("profiles").select("id, display_name"),
      ]);

      const completedUsers = new Set(
        (preds ?? [])
          .filter((p) => (p.top10 ?? []).filter((x) => x && x !== "__none__").length === 10)
          .map((p) => p.user_id),
      );

      const missingUsers = (profiles ?? []).filter((p) => !completedUsers.has(p.id));
      const payloadObj = {
        title: d.title || "⏰ DOWNFORCE — Picks Reminder!",
        body: d.body || "Lock in your Top 10 before the deadline to avoid the -25 penalty!",
        tag: "dfr-stewards-" + Date.now(),
        url: "/predict",
      };

      const reachedUserIds = new Set<string>();
      const deadKeys: string[] = [];

      const tasks = (subRows ?? []).map(async (r) => {
        const m = /^push_sub:([^:]+):(.+)$/.exec(r.key);
        if (!m) return;
        const uid = m[1]!;
        if (completedUsers.has(uid)) return;
        try {
          const sub = JSON.parse(m[2]!) as { endpoint: string; p256dh: string; auth: string };
          const res = await sendNativeWebPush(sub, payloadObj);
          if (res.ok) {
            reachedUserIds.add(uid);
          } else if (res.status === 404 || res.status === 410) {
            deadKeys.push(r.key);
          }
        } catch (error) {
          console.error("[stewards.functions] Push notification failed:", error);
        }
      });

      await Promise.allSettled(tasks);
      if (deadKeys.length > 0) {
        await sb.from("sync_state").delete().in("key", deadKeys);
      }

      const reachedNames = missingUsers
        .filter((u) => reachedUserIds.has(u.id))
        .map((u) => u.display_name || "Player");
      const unsubscribedNames = missingUsers
        .filter((u) => !reachedUserIds.has(u.id))
        .map((u) => u.display_name || "Player");

      const parts: string[] = [];
      if (reachedNames.length > 0) {
        parts.push(`Sent to: ${reachedNames.join(", ")}`);
      }
      if (unsubscribedNames.length > 0) {
        parts.push(`No Push enabled on phone yet: ${unsubscribedNames.join(", ")}`);
      }
      return {
        ok: true,
        msg: parts.join(" | ") || "All players have already locked in!",
      };
    }

    return { ok: false, msg: "Unknown action" };
  });

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { displayName: string }) => d)
  .handler(async ({ data, context }) => {
    const name = data.displayName.trim().slice(0, 40);
    if (!name) throw new Error("Display name cannot be empty");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ display_name: name })
      .eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true, name };
  });

export const deleteMyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const uid = context.userId;
    await Promise.all([
      supabaseAdmin.from("scores").delete().eq("user_id", uid),
      supabaseAdmin.from("predictions").delete().eq("user_id", uid),
      supabaseAdmin.from("sprint_predictions").delete().eq("user_id", uid),
      supabaseAdmin.from("prediction_logs").delete().eq("user_id", uid),
      supabaseAdmin.from("sync_state").delete().like("key", `push_sub:${uid}:%`),
    ]);
    await supabaseAdmin.from("profiles").delete().eq("id", uid);
    await supabaseAdmin.auth.admin.deleteUser(uid).catch((error) => {
      console.error("[stewards.functions] Failed to delete user:", error);
    });
    return { ok: true };
  });

export const exportLeagueBackup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = await requireSteward(context);
    const [profiles, races, predictions, sprintPredictions, scores, logs] = await Promise.all([
      sb.from("profiles").select("*").order("display_name"),
      sb.from("races").select("*").order("round"),
      sb.from("predictions").select("*"),
      sb.from("sprint_predictions").select("*"),
      sb.from("scores").select("*"),
      sb.from("prediction_logs").select("*").order("created_at", { ascending: false }).limit(500),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      season: 2026,
      profiles: profiles.data ?? [],
      races: races.data ?? [],
      predictions: predictions.data ?? [],
      sprintPredictions: sprintPredictions.data ?? [],
      scores: scores.data ?? [],
      recentLogs: logs.data ?? [],
    };
  });
