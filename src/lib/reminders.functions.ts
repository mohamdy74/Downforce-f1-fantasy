import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createServerFn } from "@tanstack/react-start";

export type PickRoster = {
  raceId: string;
  raceName: string;
  /** players whose top 10 is complete for this race */
  submitted: string[];
  /** players who still have not locked in a complete top 10 */
  missing: string[];
};

/**
 * Who has (and who has not) locked in picks for a race. Returns names only, never the picks.
 * Needs a signed-in player: the browser sends its access token and the server checks it.
 */
export const getPickRoster = createServerFn({ method: "POST" })
  .validator((input: { raceId: string; accessToken: string }) => input)
  .handler(async ({ data }): Promise<PickRoster> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: who, error: authError } = await supabaseAdmin.auth.getUser(data.accessToken);
    if (authError || !who?.user) throw new Error("Please sign in again.");

    const { data: race } = await supabaseAdmin
      .from("races")
      .select("id, name, race_at")
      .eq("id", data.raceId)
      .maybeSingle();
    if (!race) return { raceId: data.raceId, raceName: "", submitted: [], missing: [] };

    const [profiles, predictions] = await Promise.all([
      supabaseAdmin.from("profiles").select("id, display_name, created_at"),
      supabaseAdmin.from("predictions").select("user_id, top10").eq("race_id", race.id),
    ]);

    const complete = new Set(
      (predictions.data ?? [])
        .filter((p) => (p.top10 ?? []).filter((x) => x && x !== "__none__").length === 10)
        .map((p) => p.user_id),
    );
    // Same rule as the scoring: players who joined after the race started are not expected to pick.
    const eligible = (profiles.data ?? []).filter(
      (p) => new Date(p.created_at).getTime() <= new Date(race.race_at).getTime(),
    );

    return {
      raceId: race.id,
      raceName: race.name,
      submitted: eligible.filter((p) => complete.has(p.id)).map((p) => p.display_name),
      missing: eligible.filter((p) => !complete.has(p.id)).map((p) => p.display_name),
    };
  });

export const assertDeadlineOpen = createServerFn({ method: "POST" }).validator((d: { raceId: string; kind: string }) => d).handler(async ({ data }) => { const { supabaseAdmin } = await import("@/integrations/supabase/client.server"); const { data: r } = await supabaseAdmin.from("races").select("race_at, qualifying_at, sprint_at, sprint_qualifying_at").eq("id", data.raceId).maybeSingle(); if (!r) throw new Error("Race not found"); const lockIso = data.kind === "pole" ? (r.qualifying_at ?? r.race_at) : data.kind === "sprint" ? (r.sprint_at ?? r.race_at) : data.kind === "sprint_pole" ? (r.sprint_qualifying_at ?? r.sprint_at ?? r.race_at) : r.race_at; if (new Date(lockIso).getTime() <= Date.now()) throw new Error("Deadline passed on server clock!"); return { ok: true }; });
export const logPredAudit = createServerFn({ method: "POST" }).validator((d: { userId: string; raceId: string; predId: string; action: string; changes: Record<string, unknown> }) => d).handler(async ({ data: d }) => { const { supabaseAdmin } = await import("@/integrations/supabase/client.server"); const { data: ex } = await supabaseAdmin.from("prediction_logs").select("id").eq("user_id", d.userId).eq("race_id", d.raceId).gte("created_at", new Date(Date.now() - 4000).toISOString()).limit(1); if (!ex?.length) await supabaseAdmin.from("prediction_logs").insert({ user_id: d.userId, race_id: d.raceId, prediction_id: d.predId, action: d.action, changes: d.changes as never }); return { ok: true }; });

export const getReminderStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { raceId: string }) => input)
  .handler(async ({ data: { raceId }, context }) => {
    const normalizedRaceId = typeof raceId === "string" ? raceId.trim() : "";
    if (!normalizedRaceId) {
      return { submitted: 0, missing: [] as { id: string; display_name: string }[], total: 0, submittedIds: [] as string[] };
    }

    const { supabase } = context;
    const [{ data: preds, error: predictionsError }, { data: profiles, error: profilesError }] =
      await Promise.all([
        supabase.from("predictions").select("user_id, top10").eq("race_id", normalizedRaceId),
        supabase.from("profiles").select("id, display_name"),
      ]);

    if (predictionsError) throw new Error(`Unable to load predictions: ${predictionsError.message}`);
    if (profilesError) throw new Error(`Unable to load profiles: ${profilesError.message}`);

    const submittedIds = (preds ?? [])
      .filter((p) => Array.isArray(p.top10) && p.top10.filter((x) => typeof x === "string" && x.length > 0 && x !== "__none__").length === 10)
      .map((p) => p.user_id);

    const missing = (profiles ?? []).filter((profile) => !submittedIds.includes(profile.id));

    return {
      submitted: submittedIds.length,
      missing: missing.map((member) => ({ id: member.id, display_name: member.display_name })),
      total: (profiles ?? []).length,
      submittedIds,
    };
  });
