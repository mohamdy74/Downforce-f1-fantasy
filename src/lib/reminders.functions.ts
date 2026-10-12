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
  .inputValidator((input: { raceId: string; accessToken: string }) => input)
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
        .filter((p) => (p.top10 ?? []).filter(Boolean).length === 10)
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
