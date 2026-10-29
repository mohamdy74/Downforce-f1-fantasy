import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { driversQuery, getTrustedNow, LEAGUE_START_ROUND, racesQuery, type Race } from "@/lib/queries";
import { positionPoints, scorePrediction } from "@/lib/scoring";
import { teamColor } from "@/lib/teams";
import { cn } from "@/lib/utils";
import { getLiveRaceTelemetry, type LiveRaceTelemetryPayload } from "@/lib/weekend.functions";

export const Route = createFileRoute("/paddock")({
  head: () => ({
    meta: [
      { title: "Paddock Reveal & Race Debrief \u2014 DOWNFORCE" },
      {
        name: "description",
        content: "See every player's picks once the grid locks, and a colour-coded debrief of where points were won and lost.",
      },
      { property: "og:title", content: "Paddock Reveal & Race Debrief \u2014 DOWNFORCE" },
      { property: "og:description", content: "Everyone's picks revealed after lock, with a post-race points debrief." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Paddock Reveal & Race Debrief \u2014 DOWNFORCE" },
      { name: "twitter:description", content: "Everyone's picks revealed after lock, with a post-race points debrief." },
    ],
  }),
  component: Paddock,
});

type Pred = {
  user_id: string;
  top10: string[];
  pole_driver_id: string | null;
  fastest_lap_driver_id: string | null;
  dnf_driver_id: string | null;
};

const LIVE_WINDOW_MS = 4 * 60 * 60_000;

function Paddock() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const { data: races } = useQuery(racesQuery);
  const { data: drivers } = useQuery(driversQuery);

  const locked = useMemo(
    () => (races ?? []).filter((r) => r.round >= LEAGUE_START_ROUND && new Date(r.race_at).getTime() <= getTrustedNow()),
    [races],
  );
  const [raceId, setRaceId] = useState<string | null>(null);
  const [padRef] = useAutoAnimate<HTMLDivElement>();
  const race: Race | undefined =
    locked.find((r) => r.id === raceId) ?? locked[locked.length - 1];

  const isRaceLiveCandidate = useMemo(() => {
    if (!race || race.has_results) return false;
    const elapsed = getTrustedNow() - new Date(race.race_at).getTime();
    return elapsed >= 0 && elapsed <= LIVE_WINDOW_MS;
  }, [race]);

  const liveTelemetryQ = useQuery<LiveRaceTelemetryPayload>({
    queryKey: ["live-race-telemetry", race?.id],
    enabled: !!user && !!race && isRaceLiveCandidate,
    staleTime: 20_000,
    refetchInterval: (q) => (q.state.data?.state === "official" ? false : 25_000),
    refetchIntervalInBackground: false,
    queryFn: async () => getLiveRaceTelemetry({ data: { raceId: race!.id } }),
  });

  const { data } = useQuery({
    queryKey: ["paddock", race?.id, user?.id],
    enabled: !!race && !!user,
    queryFn: async () => {
      const [preds, profiles, results, scores] = await Promise.all([
        supabase
          .from("predictions")
          .select("user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id")
          .eq("race_id", race!.id),
        supabase.from("profiles").select("id, display_name"),
        supabase
          .from("race_results")
          .select("driver_id, position, finished, fastest_lap, pole")
          .eq("race_id", race!.id),
        supabase.from("scores").select("user_id, points").eq("race_id", race!.id),
      ]);
      const logs = await supabase
        .from("prediction_logs")
        .select("user_id, action, changes, created_at")
        .eq("race_id", race!.id)
        .order("created_at");
      const logMap = new Map<string, { action: string; changes: unknown; created_at: string }[]>();
      for (const l of logs.data ?? []) {
        const arr = logMap.get(l.user_id) ?? [];
        arr.push(l);
        logMap.set(l.user_id, arr);
      }
      return {
        preds: (preds.data ?? []) as Pred[],
        names: new Map((profiles.data ?? []).map((p) => [p.id, p.display_name])),
        results: results.data ?? [],
        points: new Map((scores.data ?? []).map((s) => [s.user_id, s.points])),
        logs: logMap,
      };
    },
  });

  useEffect(() => {
    if (liveTelemetryQ.data?.finalizedNow || liveTelemetryQ.data?.state === "official") {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["races"] }),
        queryClient.invalidateQueries({ queryKey: ["paddock", race?.id] }),
        queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
      ]);
      if (liveTelemetryQ.data?.finalizedNow) {
        toast.success(`Chequered Flag! ${liveTelemetryQ.data.raceName} official scores locked!`);
      }
    }
  }, [
    liveTelemetryQ.data?.finalizedNow,
    liveTelemetryQ.data?.state,
    liveTelemetryQ.data?.raceName,
    race?.id,
    queryClient,
  ]);

  if (loading) return <main className="mx-auto max-w-3xl px-4 py-16">Loading...</main>;
  if (!user)
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-3xl">Sign in to see the paddock</h1>
        <Button asChild className="mt-6">
          <Link to="/auth">Continue with Google</Link>
        </Button>
      </main>
    );

  const byId = new Map((drivers ?? []).map((d) => [d.id, d]));
  const activeResults =
    (data?.results?.length ?? 0) > 0
      ? data!.results
      : (liveTelemetryQ.data?.results ?? []);
  const isLiveScoring =
    !(data?.results?.length) && (liveTelemetryQ.data?.results.length ?? 0) >= 10;

  const finish = new Map<string, number>();
  const dnfs = new Set<string>();
  let poleId: string | null = null;
  let flId: string | null = null;
  for (const r of activeResults) {
    if (r.finished && r.position != null) finish.set(r.driver_id, r.position);
    if (!r.finished) dnfs.add(r.driver_id);
    if (r.pole) poleId = r.driver_id;
    if (r.fastest_lap) flId = r.driver_id;
  }
  const hasResults = (!!race?.has_results && (data?.results.length ?? 0) > 0) || isLiveScoring;

  const computedPoints = new Map<string, number>();
  for (const p of data?.preds ?? []) {
    const dbPt = data?.points.get(p.user_id);
    const serverLivePt = liveTelemetryQ.data?.liveScores?.[p.user_id];
    if (dbPt != null && !isLiveScoring) {
      computedPoints.set(p.user_id, dbPt);
    } else if (isLiveScoring && serverLivePt != null) {
      // Uses exact server live score (includes Sprint points, Pole-only save, and Steward waivers)
      computedPoints.set(p.user_id, serverLivePt);
    } else if (hasResults && activeResults.length >= 10) {
      const validTop10 = (p.top10 ?? []).filter((x) => x && x !== "__none__");
      const b = scorePrediction(
        {
          top10: validTop10,
          pole_driver_id: p.pole_driver_id,
          fastest_lap_driver_id: p.fastest_lap_driver_id,
          dnf_driver_id: p.dnf_driver_id,
        },
        activeResults,
      );
      computedPoints.set(p.user_id, validTop10.length < 10 ? -25 + b.pole : b.total);
    }
  }

  const sorted = [...(data?.preds ?? [])].sort(
    (a, b) => (computedPoints.get(b.user_id) ?? 0) - (computedPoints.get(a.user_id) ?? 0),
  );

  return (
    <main className="mx-auto max-w-3xl px-4 pb-28 pt-10">
      <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-primary">
        {isLiveScoring ? "Live Telemetry Debrief" : hasResults ? "Race debrief" : "Paddock reveal"}
      </p>
      <h1 className="mt-1 text-3xl">{race ? race.name : "No locked race yet"}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {isLiveScoring
          ? "Live virtual points updating every 25s from OpenF1 telemetry \u2014 finalizes automatically at the Chequered Flag"
          : hasResults
            ? "Green = exact position, gold = close, red = points lost"
            : "Picks are revealed once the grid locks \u2014 see what the group chose"}
      </p>

      {locked.length > 1 && (
        <div className="mt-4 flex gap-2 overflow-x-auto py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {locked
            .slice()
            .reverse()
            .map((r) => (
              <button
                key={r.id}
                onClick={() => setRaceId(r.id)}
                className={cn(
                  "carbon-panel shrink-0 rounded-full border px-3.5 py-1.5 font-mono text-xs font-semibold transition-colors",
                  r.id === race?.id
                    ? "border-primary bg-primary/15 text-primary shadow-[0_0_12px_rgba(225,6,0,0.25)]"
                    : "border-border/70 text-muted-foreground hover:text-foreground",
                )}
              >
                R{r.round}
              </button>
            ))}
        </div>
      )}

      {race && sorted.length === 0 && (
        <p className="mt-8 text-sm text-muted-foreground">No one submitted picks for this race.</p>
      )}

      <div ref={padRef} className="mt-6 space-y-4">
        {sorted.length > 0 && (() => {
          const m = (a: (string | null | undefined)[]) => {
            const c = new Map<string, number>();
            for (const x of a) if (x) c.set(x, (c.get(x) ?? 0) + 1);
            return [...c.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
          };
          const c1 = m(sorted.map((p) => p.top10?.[0]));
          const cp = m(sorted.map((p) => p.pole_driver_id));
          const cd = m(sorted.map((p) => p.dnf_driver_id));
          return (
            <div className="carbon-panel grid grid-cols-3 gap-2 rounded-lg border border-gold/40 p-2.5 text-center font-mono text-xs">
              <div>
                <span className="block text-[10px] text-muted-foreground">CROWD P1</span>
                <b className="text-gold">{c1 ? (byId.get(c1)?.code ?? c1) : "-"}</b>
              </div>
              <div>
                <span className="block text-[10px] text-muted-foreground">CROWD POLE</span>
                <b className="text-primary">{cp ? (byId.get(cp)?.code ?? cp) : "-"}</b>
              </div>
              <div>
                <span className="block text-[10px] text-muted-foreground">CROWD DNF</span>
                <b>{cd ? (byId.get(cd)?.code ?? cd) : "-"}</b>
              </div>
            </div>
          );
        })()}
        {sorted.map((p) => {
          const pts = computedPoints.get(p.user_id);
          return (
            <section key={p.user_id} className="carbon-panel rounded-lg p-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg">
                  {data?.names.get(p.user_id) ?? "Driver"}
                  {p.user_id === user.id && <span className="ml-2 text-xs text-primary">YOU</span>}
                </h2>
                {hasResults && pts != null && (
                  <span className="font-display text-2xl font-black text-gold">
                    {pts} pts{isLiveScoring ? " (LIVE)" : ""}
                  </span>
                )}
              </div>
              <ol className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                {p.top10.map((id, i) => {
                  const d = byId.get(id);
                  const actual = finish.get(id);
                  const diff = actual == null ? 99 : Math.abs(actual - (i + 1));
                  const pt = positionPoints(diff);
                  return (
                    <li
                      key={i}
                      className={cn(
                        "flex items-center gap-1.5 rounded-sm border-l-4 px-2 py-1 text-sm",
                        !hasResults && "bg-muted/40",
                        hasResults && diff === 0 && "bg-success/20",
                        hasResults && pt > 0 && diff !== 0 && "bg-gold/15",
                        hasResults && pt <= 0 && "bg-destructive/15",
                      )}
                      style={{ borderColor: teamColor(d?.team ?? null) }}
                    >
                      <span className="w-6 font-mono text-[11px] text-muted-foreground">P{i + 1}</span>
                      <span className="font-semibold">{d?.code ?? id}</span>
                      {hasResults && (
                        <span className="ml-auto font-mono text-xs">
                          {`${actual ? `P${actual}` : "DNF"} \u00B7 ${pt > 0 ? `+${pt}` : pt}`}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
              <div className="mt-2 grid grid-cols-3 gap-1 text-center text-xs">
                <BonusChip label="Pole" code={byId.get(p.pole_driver_id ?? "")?.code} hit={hasResults ? p.pole_driver_id === poleId : null} pts={3} />
                <BonusChip label="FL" code={byId.get(p.fastest_lap_driver_id ?? "")?.code} hit={hasResults ? p.fastest_lap_driver_id === flId : null} pts={3} />
                <BonusChip label="DNF" code={byId.get(p.dnf_driver_id ?? "")?.code} hit={hasResults ? !!p.dnf_driver_id && dnfs.has(p.dnf_driver_id) : null} pts={1} />
              </div>
              <AuditTrail entries={data?.logs.get(p.user_id) ?? []} code={(id) => byId.get(id)?.code ?? id} />
            </section>
          );
        })}
      </div>
    </main>
  );
}

function BonusChip({ label, code, hit, pts }: { label: string; code?: string | null | undefined; hit: boolean | null; pts: number }) {
  return (
    <div
      className={cn(
        "rounded-sm py-1",
        hit === null && "bg-muted/40",
        hit === true && "bg-success/20",
        hit === false && "bg-muted/20 text-muted-foreground",
      )}
    >
      <span className="text-muted-foreground">{label}</span> <b>{code ?? "\u2014"}</b>
      {hit && <span className="ml-1 text-success">+{pts}</span>}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = { locked: "Locked picks", edited: "Edited picks", pole: "Pole pick" };

function AuditTrail({
  entries,
  code,
}: {
  entries: { action: string; changes: unknown; created_at: string }[];
  code: (id: string) => string;
}) {
  if (!entries.length) return null;
  const fmt = (t: string) =>
    new Date(t).toLocaleString("en-GB", {
      timeZone: "Africa/Cairo",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  const describe = (c: unknown): string => {
    const ch = (c ?? {}) as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, label] of [["pole", "Pole"], ["fl", "FL"], ["dnf", "DNF"]] as const) {
      const v = ch[k];
      if (Array.isArray(v)) parts.push(`${label} ${v[0] ? code(String(v[0])) : "\u2014"}\u2192${v[1] ? code(String(v[1])) : "\u2014"}`);
      else if (typeof v === "string") parts.push(`${label} ${code(v)}`);
    }
    if (Array.isArray(ch["top10"]) && Array.isArray((ch["top10"] as unknown[])[0])) parts.push("top 10 changed");
    return parts.join(" \u00B7 ");
  };
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">
        {`${entries.length} change${entries.length > 1 ? "s" : ""} \u00B7 last ${fmt(entries[entries.length - 1]!.created_at)} (Cairo)`}
      </summary>
      <ul className="mt-1 space-y-0.5 font-mono">
        {entries.map((e, i) => (
          <li key={i}>
            {`${fmt(e.created_at)} \u2014 ${ACTION_LABEL[e.action] ?? e.action} ${describe(e.changes)}`}
          </li>
        ))}
      </ul>
    </details>
  );
}