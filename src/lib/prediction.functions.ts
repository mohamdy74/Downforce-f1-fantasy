import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Prediction save-side guards: asserts a prediction deadline is still open and
 * writes authenticated prediction audit-log rows.
 */

export const assertDeadlineOpen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { raceId: string; kind: string }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: r } = await supabaseAdmin
      .from("races")
      .select("race_at, qualifying_at, sprint_at, sprint_qualifying_at")
      .eq("id", data.raceId)
      .maybeSingle();
    if (!r) throw new Error("Race not found");

    const lockIso =
      data.kind === "pole"
        ? (r.qualifying_at ?? r.race_at)
        : data.kind === "sprint"
          ? (r.sprint_at ?? r.race_at)
          : data.kind === "sprint_pole"
            ? (r.sprint_qualifying_at ?? r.sprint_at ?? r.race_at)
            : r.race_at;

    if (new Date(lockIso).getTime() <= Date.now())
      throw new Error("Deadline passed on server clock!");

    return { ok: true };
  });

export const logPredAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      userId: string;
      raceId: string;
      predId: string;
      action: string;
      changes: Record<string, unknown>;
    }) => d,
  )
  .handler(async ({ data: d, context }) => {
    const verifiedUserId = context.userId;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // De-duplicate rapid duplicate saves (e.g. double-clicks within 4s).
    const { data: ex } = await supabaseAdmin
      .from("prediction_logs")
      .select("id")
      .eq("user_id", verifiedUserId)
      .eq("race_id", d.raceId)
      .gte("created_at", new Date(Date.now() - 4000).toISOString())
      .limit(1);

    if (!ex?.length)
      await supabaseAdmin.from("prediction_logs").insert({
        user_id: verifiedUserId,
        race_id: d.raceId,
        prediction_id: d.predId === d.userId ? verifiedUserId : d.predId,
        action: d.action,
        changes: d.changes as never,
      });

    return { ok: true };
  });
