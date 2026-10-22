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
      { title: "Head-to-head battles — DOWNFORCE" },
      { name: "description", content: "Compare any two players race by race in the DOWNFORCE league." },
      { property: "og:title", content: "Head-to-head battles — DOWNFORCE" },
      { property: "og:description", content: "Who wins the rivalry? Race-by-race 1v1 comparison." },
      { name: "twitter:title", content: "Head-to-head battles — DOWNFORCE" },
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
      className="carbon-panel h-11 sm:h-12 w-full min-w-0 rounded-lg px-2.5 font-display text-xs sm:text-sm font-extrabold italic uppercase text-foreground backdrop-blur-md focus:outline-none focus:ring-1 focus:ring-primary/50"
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
          <div className="sticky top-[calc(3rem+env(safe-area-inset-top))] sm:top-[60px] z-30 mt-4 py-1.5 backdrop-blur-md">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <Pick v={a} set={pickA} taken={b} label="Select first player" />
              <span className="font-display text-base sm:text-xl font-black italic text-primary shrink-0">
                VS
              </span>
              <Pick v={b} set={pickB} taken={a} label="Select second player" />
            </div>
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:gap-4">
            <PlayerStatsCard
              wins={wa}
              points={ptsA}
              best={bestA ?? 0}
              oppWins={wb}
              oppPoints={ptsB}
              oppBest={bestB ?? 0}
            />
            <PlayerStatsCard
              wins={wb}
              points={ptsB}
              best={bestB ?? 0}
              oppWins={wa}
              oppPoints={ptsA}
              oppBest={bestA ?? 0}
            />
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
                    R{r.round} · {r.name.replace(" Grand Prix", " GP")}
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

function PlayerStatsCard({
  wins,
  points,
  best,
  oppWins,
  oppPoints,
  oppBest,
}: {
  wins: number;
  points: number;
  best: number;
  oppWins: number;
  oppPoints: number;
  oppBest: number;
}) {
  return (
    <div className="carbon-panel grid grid-cols-3 divide-x divide-white/10 rounded-lg py-3 px-1 text-center">
      <div>
        <p className="font-mono text-[9px] sm:text-[10px] uppercase tracking-wider text-muted-foreground">
          Wins
        </p>
        <p className={cn("mt-0.5 font-mono text-xl sm:text-2xl font-bold tabular-nums", wins > oppWins && "text-gold")}>
          {wins}
        </p>
      </div>
      <div>
        <p className="font-mono text-[9px] sm:text-[10px] uppercase tracking-wider text-muted-foreground">
          Points
        </p>
        <p className={cn("mt-0.5 font-mono text-xl sm:text-2xl font-bold tabular-nums", points > oppPoints && "text-gold")}>
          {points}
        </p>
      </div>
      <div>
        <p className="font-mono text-[9px] sm:text-[10px] uppercase tracking-wider text-muted-foreground">
          Best
        </p>
        <p className={cn("mt-0.5 font-mono text-xl sm:text-2xl font-bold tabular-nums", best > oppBest && "text-gold")}>
          {best}
        </p>
      </div>
    </div>
  );
}