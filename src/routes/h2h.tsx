import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react"; import { useAutoAnimate } from "@formkit/auto-animate/react";

import { FahlBadge } from "@/components/SiteHeader";
import { useAuth } from "@/hooks/useAuth";
import { leaderboardQuery, racesQuery } from "@/lib/queries";
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
  component: H2H,
});

function H2H() {
  const { data: board = [] } = useQuery(leaderboardQuery);
  const { data: races = [] } = useQuery(racesQuery);
  const { user } = useAuth();
  const [a, setA] = useState("");
  const [b, setB] = useState(""); const [h2hRef] = useAutoAnimate<HTMLDivElement>();

  useEffect(() => {
    if (!board.length || a) return;
    const me = board.find((e) => e.userId === user?.id) ?? board[0]!;
    setA(me.userId);
    setB(board.find((e) => e.userId !== me.userId)?.userId ?? "");
  }, [board, user, a]);

  const pa = board.find((e) => e.userId === a);
  const pb = board.find((e) => e.userId === b);
  const rounds = races.filter((r) => r.has_results);
  let wa = 0, wb = 0;
  for (const r of rounds) {
    const x = pa?.byRound[r.round] ?? 0, y = pb?.byRound[r.round] ?? 0;
    if (x > y) wa++; else if (y > x) wb++;
  }

  // A player can never be compared with himself: picking one side moves the
  // other side to a different player automatically.
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
  }: {
    v: string;
    set: (s: string) => void;
    taken: string;
  }) => (
    <select
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
          <div className="sticky top-[52px] z-20 -mx-4 mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2 bg-background/95 px-4 py-2 backdrop-blur">
            <Pick v={a} set={pickA} taken={b} />
            <span className="font-display text-xl font-black italic text-primary">VS</span>
            <Pick v={b} set={pickB} taken={a} />
          </div>
          <div className="carbon-panel mt-4 grid grid-cols-3 rounded-lg p-4 text-center">
            <Stat label="Wins" l={wa} r={wb} />
            <Stat label="Points" l={pa?.points ?? 0} r={pb?.points ?? 0} />
            <Stat label="Best" l={pa?.best ?? 0} r={pb?.best ?? 0} />
          </div>
          <div className="mt-2 flex justify-between">
            <span>{pa?.fahl && <FahlBadge />}</span>
            <span>{pb?.fahl && <FahlBadge />}</span>
          </div>
          <div ref={h2hRef} className="mt-4 space-y-1.5">
            {rounds.length === 0 && (
              <p className="text-sm text-muted-foreground">No races scored yet.</p>
            )}
            {rounds.map((r) => {
              const x = pa?.byRound[r.round] ?? 0, y = pb?.byRound[r.round] ?? 0;
              return (
                <div key={r.id} className="tower-row grid grid-cols-[3rem_1fr_3rem] items-center rounded-md px-3 py-2">
                  <span className={cn("font-mono text-lg font-bold tabular-nums", x > y && "text-gold")}>{x}</span>
                  <span className="truncate text-center font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                    R{r.round} · {r.name.replace(" Grand Prix", " GP")}
                  </span>
                  <span className={cn("text-right font-mono text-lg font-bold tabular-nums", y > x && "text-gold")}>{y}</span>
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
