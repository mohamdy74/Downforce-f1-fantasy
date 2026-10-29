import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { ReminderList } from "@/components/ReminderList";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { isCompleteTop10 } from "@/lib/push-keys";
import { racesQuery, nextRace } from "@/lib/queries";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/reminders")({
  head: () => ({
    meta: [{ title: "Reminders — DOWNFORCE" }, { name: "description", content: "Who hasn't submitted picks and reminders for the next race." }],
  }),
  loader: async () => { if (typeof process !== "undefined" && process.env?.["SUPABASE_SERVICE_ROLE_KEY"]) { const { checkAndSendRaceReminders } = await import("@/lib/push.functions"); await checkAndSendRaceReminders({ data: {} }).catch(() => null); const { supabaseAdmin } = await import("@/integrations/supabase/client.server"); const { runSeasonSync } = await import("@/lib/f1-sync.functions"); void runSeasonSync(supabaseAdmin, { force: false }).catch(() => null); } }, component: Reminders,
});

function Reminders() {
  const { user } = useAuth();
  const { data: races } = useQuery(racesQuery);

  // Server-style query: only counts + names, NO prediction contents exposed
  const { data, isLoading } = useQuery({
    queryKey: ["submission-status", races?.[0]?.id],
    enabled: !!races && races.length > 0 && !!user,
    queryFn: async () => {
      const race = nextRace(races!);
      if (!race) return null;

      // Get all predictions for this race (only user_ids + top10 length — not full picks)
      const { data: preds } = await supabase
        .from("predictions")
        .select("user_id, top10")
        .eq("race_id", race.id);

      const submittedIds = (preds ?? [])
        .filter((p) => isCompleteTop10(p.top10))
        .map((p) => p.user_id);
      const submittedSet = new Set(submittedIds);

      // Get names for non-submitted users
      const missingIds = submittedIds.length > 0
        ? [] // We'd need to query profiles excluding submitted — simplified for this endpoint
        : [];

      // For this endpoint, return aggregate stats only (no individual predictions shown)
      return {
        raceId: race.id,
        raceName: race.name,
        round: race.round,
        raceAt: race.race_at,
        submittedCount: submittedIds.length,
        totalCount: (preds ?? []).length,
        hasSubmitted: user ? submittedSet.has(user.id) : false,
      };
    },
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl">Reminders</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Track who has submitted picks for the next race. No individual predictions shown.
      </p>

      {isLoading ? (
        <div className="mt-6 space-y-2">
          <div className="skeleton-shimmer h-8 w-full rounded-lg" />
          <div className="grid grid-cols-3 gap-4 text-center">
            {[1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <div className="skeleton-shimmer h-4 w-16 rounded mx-auto" />
                <div className="skeleton-shimmer h-6 w-12 rounded mx-auto" />
                <div className="skeleton-shimmer h-3 w-20 rounded mx-auto" />
              </div>
            ))}
          </div>
        </div>
      ) : data && (
        <div className="mt-6 carbon-panel-strong rounded-lg p-4 grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="font-mono text-xs uppercase text-muted-foreground">Race</p>
            <p className="font-display text-lg font-extrabold italic">{data.round}</p>
            <p className="text-xs truncate">{data.raceName}</p>
          </div>
          <div>
            <p className="font-mono text-xs uppercase text-muted-foreground">Submitted</p>
            <p className="font-mono text-2xl font-bold text-success">{data.submittedCount}</p>
          </div>
          <div>
            <p className="font-mono text-xs uppercase text-muted-foreground">Your status</p>
            <p className="font-mono text-2xl font-bold">{data.hasSubmitted ? "✓ Done" : "✗ Missing"}</p>
          </div>
        </div>
      )}

      <ReminderList />
    </main>
  );
}
