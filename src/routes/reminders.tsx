import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { ReminderList } from "@/components/ReminderList";
import { getReminderStats } from "@/lib/reminder.functions";
import { racesQuery, nextRace } from "@/lib/queries";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/reminders")({
  head: () => ({
    meta: [
      { title: "Reminders — DOWNFORCE" },
      {
        name: "description",
        content: "Who hasn't submitted picks and reminders for the next race.",
      },
    ],
  }),
  loader: async () => {
    // Cron warm-up (sweep + season sync) runs inside a server function, whose
    // handler compiles server-only — that is the only place the server-only
    // request API may be imported from (route files ship to the browser).
    if (typeof process === "undefined") return;
    const { runRemindersCronWarmUp } = await import("@/lib/push.functions");
    await runRemindersCronWarmUp({ data: {} }).catch(() => null);
  },
  component: Reminders,
});

function Reminders() {
  const { user } = useAuth();
  const { data: races } = useQuery(racesQuery);

  const race = races ? nextRace(races) : null;

  // Server-style query: only counts + names, NO prediction contents exposed.
  // RLS hides other players' predictions until their race starts, so the old
  // client-side count always returned 0/1 — use the authenticated server
  // function for true league-wide stats.
  const { data, isLoading } = useQuery({
    queryKey: ["submission-status", race?.id],
    enabled: !!race && !!user,
    queryFn: async () => {
      const stats = await getReminderStats({ data: { raceId: race!.id } });
      return {
        raceId: race!.id,
        raceName: race!.name,
        round: race!.round,
        raceAt: race!.race_at,
        submittedCount: stats.submitted,
        totalCount: stats.total,
        missingCount: stats.missing.length,
        hasSubmitted: !stats.missing.some((m) => m.id === user?.id),
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
      ) : (
        data && (
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
              <p className="font-mono text-2xl font-bold">
                {data.hasSubmitted ? "✓ Done" : "✗ Missing"}
              </p>
            </div>
          </div>
        )
      )}

      <ReminderList />
    </main>
  );
}
