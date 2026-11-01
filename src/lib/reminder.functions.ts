import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isCompleteTop10 } from "@/lib/push-keys";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type PaginatedResult } from "@/lib/pagination";

export interface ReminderStatsResult {
  submitted: number;
  missing: Array<{ id: string; display_name: string }>;
  total: number;
}

export interface PaginatedReminderStatsResult {
  submitted: number;
  missing: Array<{ id: string; display_name: string }>;
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

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
      throw new Error(
        `Unable to load predictions: ${predictionsError instanceof Error ? predictionsError.message : String(predictionsError)}`,
      );
    }

    const submittedIds = (preds ?? [])
      .filter((p) => isCompleteTop10(p.top10))
      .map((p) => p.user_id);

    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, display_name");

    if (profilesError) {
      throw new Error(
        `Unable to load profiles: ${profilesError instanceof Error ? profilesError.message : String(profilesError)}`,
      );
    }

    const missing = (profiles ?? []).filter((profile) => !submittedIds.includes(profile.id));

    return {
      submitted: submittedIds.length,
      missing: missing.map((member) => ({ id: member.id, display_name: member.display_name })),
      total: (profiles ?? []).length,
    } as ReminderStatsResult;
  });

// Paginated version for large leagues
export const getReminderStatsPaginated = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { raceId: string; limit?: number; cursor?: string | null }) => ({
    raceId: typeof input.raceId === "string" ? input.raceId.trim() : "",
    limit: input.limit,
    cursor: input.cursor ?? null,
  }))
  .handler(async ({ data: { raceId, limit, cursor } }): Promise<PaginatedReminderStatsResult> => {
    const normalizedRaceId = raceId;
    if (!normalizedRaceId) {
      return { submitted: 0, missing: [], total: 0, nextCursor: null, hasMore: false };
    }

    const { supabaseAdmin: supabase } = await import("@/integrations/supabase/client.server");
    
    // Normalize pagination options
    const effectiveLimit = Math.min(
      Math.max(1, limit ?? DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE
    );

    // Returns only submission counts and missing player names (never exposes pick contents).
    const { data: preds, error: predictionsError } = await supabase
      .from("predictions")
      .select("user_id, top10")
      .eq("race_id", normalizedRaceId);

    if (predictionsError) {
      throw new Error(
        `Unable to load predictions: ${predictionsError instanceof Error ? predictionsError.message : String(predictionsError)}`,
      );
    }

    const submittedIds = (preds ?? [])
      .filter((p) => isCompleteTop10(p.top10))
      .map((p) => p.user_id);

    // Fetch profiles with pagination
    const query = supabase
      .from("profiles")
      .select("id, display_name")
      .order("display_name", { ascending: true })
      .limit(effectiveLimit + 1); // +1 to check if there are more
    
    if (cursor) {
      query.gt("display_name", cursor);
    }

    const { data: profiles, error: profilesError } = await query;

    if (profilesError) {
      throw new Error(
        `Unable to load profiles: ${profilesError instanceof Error ? profilesError.message : String(profilesError)}`,
      );
    }

    const missing = (profiles ?? []).filter((profile) => !submittedIds.includes(profile.id));
    const hasMore = (profiles ?? []).length > effectiveLimit;
    const resultProfiles = hasMore ? (profiles ?? []).slice(0, -1) : (profiles ?? []);
    const nextCursor = hasMore ? resultProfiles[resultProfiles.length - 1]?.display_name ?? null : null;

    return {
      submitted: submittedIds.length,
      missing: missing.map((member) => ({ id: member.id, display_name: member.display_name })),
      total: submittedIds.length + missing.length,
      nextCursor,
      hasMore,
    };
  });
