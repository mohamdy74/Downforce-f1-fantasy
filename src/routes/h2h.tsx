import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { FahlBadge } from "@/components/SiteHeader";
import { useAuth } from "@/hooks/useAuth";
import { LEAGUE_START_ROUND, leaderboardQuery, racesQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/h2h")({
  head: () => ({
    meta: [
      { title: "Head-to-head battles â€” DOWNFORCE" },
      { name: "description", content: "Compare any two players race by race in the DOWNFORCE league." },
      { property: "og:title", content: "Head-to-head battles â€” DOWNFORCE" },
      { property: "og:description", content: "Who wins the rivalry? Race-by-race 1v1 comparison." },
      { name: "twitter:title", content: "Head-to-head battles â€” DOWNFORCE" },
      { name: "twitter:description", content: "Who wins the rivalry? Race-by-race 1v1 comparison." },
    ],
  }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(racesQuery).catch(() => null),
      context.queryClient.ensureQueryData(leaderboardQuery).catch(() => null),
    ]);
  },
  component: H2H,
});

function H2H() {
  const { data: board = [] } = useQuery(leaderboardQuery);
  const { data: races = [] } = useQuery(racesQuery);
  const { user } = useAuth();
  const [a, setA] = useState("");
  const [b, setB] = useState("");

  useEffect(() => {
    if (!board.length || a) return;
    const me = board.find((e) => e.userId === user?.id) ?? board[0]!;
    setA(me.userId);
    setB(board.find((e) => e.userId !== me.userId)?.userId ?? "");
  }, [board, user, a]);

  const pa = board.find((e) => e.userId === a);
  const pb = board.find((e) => e.userId === b);

  const rounds = races
    .filter(
      (r) =>
        r.round >= LEAGUE_START_ROUND &&
        r.has_results &&
        board.some((e) => (e.byRound[r.round] ?? 0) !== 0),
    )
    .slice()
    .sort((x, y) => y.round - x.round);

  let wa = 0;
  let wb = 0;
  let ptsA = 0;
  let ptsB = 0;
  let bestA: number | null = null;
  let bestB: number | null = null;

  for (const r of rounds) {
    const x = pa?.byRound[r.round] ?? 0;
    const y = pb?.byRound[r.round] ?? 0;
    ptsA += x;
    ptsB += y;
    bestA = bestA == null ? x : Math.max(bestA, x);
    bestB = bestB == null ? y : Math.max(bestB, y);
    if (x > y) wa++;
    else if (y > x) wb++;
  }

  const other = (id: string) => board.find((e) => e.userId !== id)?.userId ?? "";
  const pickA = (id: string) => {
    setA(id);
    if (id === b) setB(other(id));
  };
  const pickB = (id: string) => {
    setB(id);
    if (id === a) setA(other(id));
  };

  const Pick = ({
    v,
    set,
    taken,
    label,
  }: {
    v: string;
    set: (s: string) => void;
    taken: string;
    label: string;
  }) => (
    <select
      aria-label={label}
      value={v}
      onChange={(e) => set(e.target.value)}
      className="h-12 w-full min-w-0 rounded-md border border-input bg-card px-2 font-display text-sm font-extrabold italic uppercase"
    >
      {board.map((e) => (
        <option key={e.userId} value={e.userId} disabled={e.userId === taken}>
          {e.name}
        </option>
      ))}
    </select>
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl">Head-to-head</h1>
      {board.length < 2 ? (
        <p className="mt-6 text-sm text-muted-foreground">Need at least two players for a battle.</p>
      ) : (
        <>
          <div className="sticky top-[calc(3rem+env(safe-area-inset-top))] sm:top-[60px] z-30 -mx-4 mt-4 border-b border-border/70 bg-background/95 px-4 py-2.5 backdrop-blur-md shadow-md">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <Pick v={a} set={pickA} taken={b} label="Select first player" />
              <span className="font-display text-xl font-black italic text-primary">VS</span>
              <Pick v={b} set={pickB} taken={a} label="Select second player" />
            </div>
          </div>

          <div className="carbon-panel mt-4 grid grid-cols-3 rounded-lg p-4 text-center">
            <Stat label="Wins" l={wa} r={wb} />
            <Stat label="Points" l={ptsA} r={ptsB} />
            <Stat label="Best" l={bestA ?? 0} r={bestB ?? 0} />
          </div>

          <div className="mt-2 flex justify-between">
            <span>{pa?.fahl && <FahlBadge />}</span>
            <span>{pb?.fahl && <FahlBadge />}</span>
          </div>

          <div className="mt-4 space-y-1.5">
            {rounds.length === 0 && (
              <p className="text-sm text-muted-foreground">No races scored yet.</p>
            )}
            {rounds.map((r) => {
              const x = pa?.byRound[r.round] ?? 0;
              const y = pb?.byRound[r.round] ?? 0;
              return (
                <div
                  key={r.id}
                  className="tower-row grid grid-cols-[3rem_1fr_3rem] items-center rounded-md px-3 py-2.5"
                >
                  <span className={cn("font-mono text-lg font-bold tabular-nums", x > y && "text-gold")}>
                    {x}
                  </span>
                  <span className="truncate text-center font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                    R{r.round} Â· {r.name.replace(" Grand Prix", " GP")}
                  </span>
                  <span className={cn("text-right font-mono text-lg font-bold tabular-nums", y > x && "text-gold")}>
                    {y}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}

function Stat({ label, l, r }: { label: string; l: number; r: number }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="font-mono text-2xl font-bold tabular-nums">
        <span className={cn(l > r && "text-gold")}>{l}</span>
        <span className="text-muted-foreground"> : </span>
        <span className={cn(r > l && "text-gold")}>{r}</span>
      </p>
    </div>
  );
}