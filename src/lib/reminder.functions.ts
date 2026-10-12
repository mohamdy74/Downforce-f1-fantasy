import { createServerFn } from "@tanstack/start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getReminderStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { raceId: string }) => input)
  .handler(async ({ data: { raceId } }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Fetch all predictions for this race using admin client (bypasses RLS)
    const { data: preds } = await supabaseAdmin
      .from("predictions")
      .select("user_id, top10")
      .eq("race_id", raceId);

    // Filter for complete predictions (10 drivers selected)
    const submittedIds = (preds ?? [])
      .filter((p) => (p.top10 ?? []).filter(Boolean).length === 10)
      .map((p) => p.user_id);

    // Fetch all profiles
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name");

    // Find users who haven't submitted complete predictions
    const missing = (profiles ?? []).filter((p) => !submittedIds.includes(p.id));

    return {
      submitted: submittedIds.length,
      missing: missing.map((m) => ({ id: m.id, display_name: m.display_name })),
      total: (profiles ?? []).length,
    };
  });
