import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { ReminderList } from "@/components/ReminderList";
import { racesQuery, nextRace } from "@/lib/queries";
import { getReminderStats } from "@/lib/reminders.functions";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/reminders")({
  head: () => ({
    meta: [{ title: "Reminders â€” DOWNFORCE" }, { name: "description", content: "Who hasn't submitted picks and reminders for the next race." }],
  }),
  component: Reminders,
});

function Reminders() {
  const { user } = useAuth();
  const { data: races } = useQuery(racesQuery);
  const race = races ? nextRace(races) : null;

  const { data: stats } = useQuery({
    queryKey: ["missing-preds", race?.id],
    enabled: !!race,
    staleTime: 2 * 60_000,
    queryFn: () => getReminderStats({ data: { raceId: race!.id } }),
  });

  const hasSubmitted = !!(user && stats?.submittedIds?.includes(user.id));

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl">Reminders</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Track who has submitted picks for the next race. No individual predictions shown.
      </p>

      {race && stats && (
        <div className="mt-6 carbon-panel-strong rounded-lg p-4 grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="font-mono text-xs uppercase text-muted-foreground">Race</p>
            <p className="font-display text-lg font-extrabold italic">{race.round}</p>
            <p className="text-xs truncate">{race.name}</p>
          </div>
          <div>
            <p className="font-mono text-xs uppercase text-muted-foreground">Submitted</p>
            <p className="font-mono text-2xl font-bold text-success">{stats.submitted}</p>
          </div>
          <div>
            <p className="font-mono text-xs uppercase text-muted-foreground">Your status</p>
            <p className="font-mono text-2xl font-bold">{hasSubmitted ? "âœ“ Done" : "âœ— Missing"}</p>
          </div>
        </div>
      )}

      <ReminderList />
    </main>
  );
}