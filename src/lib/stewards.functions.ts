import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { scorePrediction, NO_SUBMISSION_PENALTY, type ResultRow } from "./scoring";
import { sendNativeWebPush } from "./webpush-native";

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

export const getStewardsDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { raceId: string }) => d)
  .handler(async ({ data, context }) => {
    const sb = await requireSteward(context);
    const [{ data: profiles }, { data: preds }, { data: scores }, { data: results }] = await Promise.all([
      sb.from("profiles").select("id, display_name, created_at").order("display_name"),
      sb.from("predictions").select("id, user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id, updated_at").eq("race_id", data.raceId),
      sb.from("scores").select("user_id, points, breakdown").eq("race_id", data.raceId),
      sb.from("race_results").select("driver_id, position, finished, fastest_lap, pole").eq("race_id", data.raceId),
    ]);
    return {
      profiles: profiles ?? [],
      preds: preds ?? [],
      scores: scores ?? [],
      results: results ?? [],
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
      | "nudge_missing_push";
    raceId?: string;
    userId?: string;
    points?: number;
    name?: string;
    minutes?: number;
    isoTime?: string;
    target?: "qualifying" | "race";
    pole?: string | null;
    fl?: string | null;
    dnf?: string | null;
    top10?: string[];
    dnfs?: string[];
    title?: string;
    body?: string;
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
          breakdown: { stewardOverride: true, total: pts },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,race_id" },
      );
      if (error) throw new Error(error.message);
      return { ok: true, msg: `Score set to ${pts} pts.` };
    }

    if (d.action === "rename_player" && d.userId && d.name) {
      const { error } = await sb.from("profiles").update({ display_name: d.name.trim() }).eq("id", d.userId);
      if (error) throw new Error(error.message);
      return { ok: true, msg: "Player display name updated." };
    }

    if (d.action === "delete_player" && d.userId) {
      await sb.from("scores").delete().eq("user_id", d.userId);
      await sb.from("predictions").delete().eq("user_id", d.userId);
      await sb.from("sprint_predictions").delete().eq("user_id", d.userId);
      const { error } = await sb.from("profiles").delete().eq("id", d.userId);
      if (error) throw new Error(error.message);
      return { ok: true, msg: "Player and associated records removed." };
    }

    if (d.action === "set_exact_deadline" && d.raceId && d.isoTime) {
      const col = d.target === "qualifying" ? "qualifying_at" : "race_at";
      const parsed = new Date(d.isoTime);
      if (Number.isNaN(parsed.getTime())) throw new Error("Invalid date/time format");
      const { error } = await sb.from("races").update({ [col]: parsed.toISOString() }).eq("id", d.raceId);
      if (error) throw new Error(error.message);
      return { ok: true, msg: `${d.target === "qualifying" ? "Qualifying" : "Race"} deadline updated!` };
    }

    if (d.action === "shift_deadline" && d.raceId && d.minutes != null) {
      const { data: r } = await sb.from("races").select("race_at, qualifying_at").eq("id", d.raceId).single();
      if (!r) throw new Error("Race not found");
      const col = d.target === "qualifying" ? "qualifying_at" : "race_at";
      const cur = (d.target === "qualifying" ? r.qualifying_at : r.race_at) ?? r.race_at;
      const nextIso = new Date(new Date(cur).getTime() + d.minutes * 60_000).toISOString();
      const { error } = await sb.from("races").update({ [col]: nextIso }).eq("id", d.raceId);
      if (error) throw new Error(error.message);
      return { ok: true, msg: `${d.target === "qualifying" ? "Qualifying" : "Race"} shifted by ${d.minutes > 0 ? "+" : ""}${d.minutes}m.` };
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
        if (error) throw new Error(error.message);
      } else {
        const { data: ins, error } = await sb.from("predictions").insert(payload).select("id").single();
        if (error) throw new Error(error.message);
        if (ins?.id) predId = ins.id;
      }
      await sb.from("prediction_logs").insert({
        user_id: d.userId,
        race_id: d.raceId,
        prediction_id: predId,
        action: "stewards",
        changes: { pole: d.pole ?? null, fl: d.fl ?? null, dnf: d.dnf ?? null, top10: [[], d.top10 ?? []] },
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
      const [{ data: profiles }, { data: preds }] = await Promise.all([
        sb.from("profiles").select("id, created_at"),
        sb.from("predictions").select("user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id").eq("race_id", d.raceId),
      ]);
      const byU = new Map((preds ?? []).map((p) => [p.user_id, p]));
      const scoreRows = [];
      for (const p of profiles ?? []) {
        if (raceRow?.race_at && new Date(p.created_at) > new Date(raceRow.race_at)) continue;
        const pr = byU.get(p.id);
        const validTop10 = (pr?.top10 ?? []).filter((x) => x && x !== "__none__");
        if (!pr || validTop10.length < 10) {
          const poleHit = pr?.pole_driver_id && pr.pole_driver_id === d.pole ? 3 : 0;
          const total = NO_SUBMISSION_PENALTY + poleHit;
          scoreRows.push({
            user_id: p.id,
            race_id: d.raceId!,
            points: total,
            breakdown: { noSubmission: true, pole: poleHit, total },
            updated_at: new Date().toISOString(),
          });
        } else {
          const b = scorePrediction(
            { top10: pr.top10, pole_driver_id: pr.pole_driver_id, fastest_lap_driver_id: pr.fastest_lap_driver_id, dnf_driver_id: pr.dnf_driver_id },
            rows as ResultRow[],
          );
          scoreRows.push({
            user_id: p.id,
            race_id: d.raceId!,
            points: b.total,
            breakdown: b,
            updated_at: new Date().toISOString(),
          });
        }
      }
      if (scoreRows.length) await sb.from("scores").upsert(scoreRows, { onConflict: "user_id,race_id" });
      return { ok: true, msg: `Manual results saved & ${scoreRows.length} players scored!` };
    }

    if (d.action === "nudge_missing_push" && d.raceId) {
      const [{ data: subRows }, { data: preds }] = await Promise.all([
        sb.from("sync_state").select("key").like("key", "push_sub:%"),
        sb.from("predictions").select("user_id, top10").eq("race_id", d.raceId),
      ]);
      const completedUsers = new Set(
        (preds ?? [])
          .filter((p) => (p.top10 ?? []).filter((x) => x && x !== "__none__").length === 10)
          .map((p) => p.user_id),
      );

      let sent = 0;
      const payloadObj = {
        title: d.title || "⏰ DOWNFORCE — Picks Reminder!",
        body: d.body || "Lock in your Top 10 before the deadline to avoid the -25 penalty!",
        tag: "dfr-stewards-" + Date.now(),
        url: "/predict",
      };

      for (const r of subRows ?? []) {
        const m = /^push_sub:([^:]+):(.+)$/.exec(r.key);
        if (!m) continue;
        if (completedUsers.has(m[1]!)) continue;
        try {
          const sub = JSON.parse(m[2]!) as { endpoint: string; p256dh: string; auth: string };
          const ok = await sendNativeWebPush(sub, payloadObj);
          if (ok) sent++;
        } catch {
          // ignore invalid/expired subscription
        }
      }
      return {
        ok: true,
        msg: sent > 0
          ? `Push alert sent to ${sent} missing player device(s)!`
          : "No subscribed devices found for missing players yet (players need to tap the Bell icon once).",
      };
    }

    return { ok: false, msg: "Unknown action" };
  });
