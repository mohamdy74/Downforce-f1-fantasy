import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isCompleteTop10 } from "@/lib/push-keys";

export const getReminderStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { raceId: string }) => input)
  .handler(async ({ data: { raceId } }) => {
    const normalizedRaceId = typeof raceId === "string" ? raceId.trim() : "";
    if (!normalizedRaceId) {
      return { submitted: 0, missing: [], total: 0 };
    }

    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");

    // Returns only submission counts and missing player names (never exposes pick contents).
    const { data: preds, error: predictionsError } = await supabase
      .from("predictions")
      .select("user_id, top10")
      .eq("race_id", normalizedRaceId);

    if (predictionsError) {
      throw new Error(`Unable to load predictions: ${predictionsError.message}`);
    }

    const submittedIds = (preds ?? [])
      .filter((p) => isCompleteTop10(p.top10))
      .map((p) => p.user_id);

    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, display_name");

    if (profilesError) {
      throw new Error(`Unable to load profiles: ${profilesError.message}`);
    }

    const missing = (profiles ?? []).filter((profile) => !submittedIds.includes(profile.id));

    return {
      submitted: submittedIds.length,
      missing: missing.map((member) => ({ id: member.id, display_name: member.display_name })),
      total: (profiles ?? []).length,
    };
  });