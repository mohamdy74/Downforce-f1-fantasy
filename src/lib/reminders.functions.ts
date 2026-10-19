import { createServerFn } from "@tanstack/react-start";

/**
 * @deprecated getPickRoster is dead (0 imports) — use getReminderStats from
 * @/lib/reminder.functions.ts instead. Kept as a thin alias for one release
 * cycle, then delete.
 */
export type PickRoster = {
  raceId: string;
  raceName: string;
  /** players whose top 10 is complete for this race */
  submitted: string[];
  /** players who still have not locked in a complete top 10 */
  missing: string[];
};

export const assertDeadlineOpen = createServerFn({ method: "POST" }).inputValidator((d: { raceId: string; kind: string }) => d).handler(async ({ data }) => { const { supabaseAdmin } = await import("@/integrations/supabase/client.server"); const { data: r } = await supabaseAdmin.from("races").select("race_at, qualifying_at, sprint_at, sprint_qualifying_at").eq("id", data.raceId).maybeSingle(); if (!r) throw new Error("Race not found"); const lockIso = data.kind === "pole" ? (r.qualifying_at ?? r.race_at) : data.kind === "sprint" ? (r.sprint_at ?? r.race_at) : data.kind === "sprint_pole" ? (r.sprint_qualifying_at ?? r.sprint_at ?? r.race_at) : r.race_at; if (new Date(lockIso).getTime() <= Date.now()) throw new Error("Deadline passed on server clock!"); return { ok: true }; });
export const logPredAudit = createServerFn({ method: "POST" }).inputValidator((d: { userId: string; raceId: string; predId: string; action: string; changes: Record<string, unknown> }) => d).handler(async ({ data: d }) => { const { supabaseAdmin } = await import("@/integrations/supabase/client.server"); const { data: ex } = await supabaseAdmin.from("prediction_logs").select("id").eq("user_id", d.userId).eq("race_id", d.raceId).gte("created_at", new Date(Date.now() - 4000).toISOString()).limit(1); if (!ex?.length) await supabaseAdmin.from("prediction_logs").insert({ user_id: d.userId, race_id: d.raceId, prediction_id: d.predId, action: d.action, changes: d.changes as never }); return { ok: true }; });