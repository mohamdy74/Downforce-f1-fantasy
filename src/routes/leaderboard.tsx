import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { FahlBadge } from "@/components/SiteHeader";
import { useAuth } from "@/hooks/useAuth";
import { LEAGUE_START_ROUND, leaderboardQuery, racesQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "League standings â€” DOWNFORCE" },
      {
        name: "description",
        content: "Live DOWNFORCE prediction league standings for the season.",
      },
      { property: "og:title", content: "League standings â€” DOWNFORCE" },
      {
        property: "og:description",
        content: "See who is leading the DOWNFORCE prediction league.",
      },
      { name: "twitter:title", content: "League standings â€” DOWNFORCE" },
      { name: "twitter:description", content: "See who is leading the DOWNFORCE prediction league." },
    ],
  }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(racesQuery).catch(() => null),
      context.queryClient.ensureQueryData(leaderboardQuery).catch(() => null),
    ]);
  },
  component: Leaderboard,
});

function Leaderboard() {
  const { data: board, isLoading } = useQuery(leaderboardQuery);
  const { data: races } = useQuery(racesQuery);
  const { user } = useAuth();

  const [open, setOpen] = useState<string | null>(null);
  const scoredRaces = (races ?? []).filter(
    (r) =>
      r.round >= LEAGUE_START_ROUND &&
      r.has_results &&
      (board ?? []).some((e) => (e.byRound[r.round] ?? 0) !== 0),
  );
  const scored = scoredRaces.length;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl">League standings</h1>
      <p className="mt-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {scored} race{scored === 1 ? "" : "s"} scored
      </p>

      {board && board.length > 0 && (
        <div className="mt-8 grid grid-cols-3 items-end gap-2">
          {[1, 0, 2].map((i) => {
            const e = board[i];
            if (!e) return <div key={i} />;
            const color = ["var(--gold)", "var(--silver)", "var(--bronze)"][i];
            return (
              <div key={e.userId} className="text-center">
                <p className="truncate font-display text-sm font-extrabold italic uppercase">
                  {e.name}
                </p>
                <p className="font-mono text-lg font-bold tabular-nums">{e.points}</p>
                <div
                  className="mt-1 flex items-start justify-center rounded-t-md pt-2 font-display text-2xl font-extrabold italic text-background"
                  style={{ background: color, height: [96, 72, 56][i] }}
                >
                  {i + 1}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-8 space-y-2">
        {isLoading && (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((k) => (
              <div key={k} className="carbon-panel h-16 animate-pulse rounded-md" />
            ))}
          </div>
        )}
        {!isLoading && !board?.length && (
          <p className="text-sm text-muted-foreground">
            No players yet. Sign in to claim P1.
          </p>
        )}
        {board?.map((entry, index) => (
          <div key={entry.userId}>
            <button
              type="button"
              onClick={() => setOpen(open === entry.userId ? null : entry.userId)}
              className={cn(
                "tower-row flex w-full items-center gap-3 rounded-md px-3 py-3 text-left",
                index === 0 && "border-l-gold",
                index > 0 && index < 3 && "border-l-primary",
                entry.userId === user?.id && "ring-1 ring-primary/60",
              )}
            >
              <span
                className={cn(
                  "w-8 shrink-0 text-center font-mono text-lg font-bold tabular-nums",
                  index === 0 && "text-gold",
                )}
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate font-display text-sm font-extrabold italic uppercase">
                    {entry.name}
                  </p>
                  {entry.fahl && <FahlBadge />}
                </div>
                <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  {entry.races} scored Â· best {entry.best ?? 0}
                </p>
              </div>
              {entry.change != null && entry.change !== 0 && (
                <span
                  className={cn(
                    "font-mono text-xs font-bold",
                    entry.change > 0 ? "text-gold" : "text-primary",
                  )}
                >
                  {entry.change > 0 ? `â–²${entry.change}` : `â–¼${-entry.change}`}
                </span>
              )}
              <span className="font-mono text-xl font-bold tabular-nums">{entry.points}</span>
            </button>
            {open === entry.userId && (
              <div className="carbon-panel mt-1 grid grid-cols-4 gap-1 rounded-md p-2 sm:grid-cols-6">
                {scoredRaces.map((r) => (
                  <div key={r.id} className="rounded-sm bg-muted/60 px-1 py-1 text-center">
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">R{r.round}</p>
                    <p className="font-mono text-sm font-bold tabular-nums">{entry.byRound[r.round] ?? "â€“"}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}