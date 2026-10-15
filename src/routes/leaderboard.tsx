import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react"; import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";

import { FahlBadge } from "@/components/SiteHeader";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { syncF1Data } from "@/lib/f1-sync.functions";
import { leaderboardQuery, racesQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "League standings — DOWNFORCE" },
      {
        name: "description",
        content: "Live DOWNFORCE prediction league standings for the season.",
      },
      { property: "og:title", content: "League standings — DOWNFORCE" },
      {
        property: "og:description",
        content: "See who is leading the DOWNFORCE prediction league.",
      },
      { name: "twitter:title", content: "League standings — DOWNFORCE" },
      { name: "twitter:description", content: "See who is leading the DOWNFORCE prediction league." },
    ],
  }),
  component: Leaderboard,
});

function Leaderboard() {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const { data: board, isLoading } = useQuery({
    ...leaderboardQuery,
    enabled: !!user,
  });
  const { data: races } = useQuery(racesQuery);

  const [open, setOpen] = useState<string | null>(null); const [listRef] = useAutoAnimate<HTMLDivElement>();
  const [syncing, setSyncing] = useState(false);
  const scored = board?.[0]?.races || (races?.filter((r) => r.has_results).length ?? 0);

  async function handleForceSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      await syncF1Data({ data: { force: true } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["races"] }),
        queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
      ]);
      toast.success("Standings and race results synced!");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not sync right now.");
    } finally {
      setSyncing(false);
    }
  }

  if (authLoading) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <p className="text-sm text-muted-foreground">Loading standings…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-3xl">Sign in to view standings</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Join the league to see player rankings and round-by-round points.
        </p>
        <Button asChild className="mt-6">
          <Link to="/auth">Continue with Google</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">League standings</h1>
          <p className="mt-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {scored} race{scored === 1 ? "" : "s"} scored
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={syncing}
          onClick={handleForceSync}
          className="shrink-0 gap-1.5"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
          {syncing ? "Syncing…" : "Sync results"}
        </Button>
      </div>

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

      <div ref={listRef} className="mt-8 space-y-2">
        {isLoading && <p className="text-sm text-muted-foreground">Loading timing tower…</p>}
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
                "tower-row flex w-full text-left items-center gap-3 rounded-md px-3 py-3",
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
                  {entry.races} scored · best {entry.best ?? 0} | avg {entry.races ? (entry.points / entry.races).toFixed(1) : 0}
                </p>
              </div>
              {entry.change != null && entry.change !== 0 && (
                <span
                  className={cn(
                    "font-mono text-xs font-bold",
                    entry.change > 0 ? "text-gold" : "text-primary",
                  )}
                >
                  {entry.change > 0 ? `▲${entry.change}` : `▼${-entry.change}`}
                </span>
              )}
              <span className="font-mono text-xl font-bold tabular-nums">{entry.points}</span>
            </button>
            {open === entry.userId && (
              <div className="carbon-panel mt-1 grid grid-cols-4 gap-1 rounded-md p-2 sm:grid-cols-6"><div className="col-span-full mb-1 flex flex-wrap gap-1.5 font-mono text-[10px] uppercase"><span className="rounded bg-secondary px-2 py-0.5">Avg {entry.races ? (entry.points / entry.races).toFixed(1) : 0} pts</span><span className="rounded bg-secondary px-2 py-0.5">Best {entry.best ?? 0} pts</span>{index === 0 && <span className="rounded bg-gold/20 text-gold px-2 py-0.5">Leader</span>}{(entry.best ?? 0) >= 25 && <span className="rounded bg-primary/20 text-primary px-2 py-0.5">Pro Scorer</span>}</div>
                {(races ?? []).filter((r) => r.has_results && (board ?? []).some((e) => e.byRound[r.round] !== undefined)).map((r) => (
                  <div key={r.id} className="rounded-sm bg-muted/60 px-1 py-1 text-center">
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">R{r.round}</p>
                    <p className="font-mono text-sm font-bold tabular-nums">{entry.byRound[r.round] ?? "–"}</p>
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
