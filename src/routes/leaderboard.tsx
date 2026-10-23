import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Radio, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";

import { FahlBadge } from "@/components/SiteHeader";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { syncF1Data } from "@/lib/f1-sync.functions";
import { computeVirtualStandings, type VirtualLeaderboardEntry } from "@/lib/liveStandings";
import { getTrustedNow, lastRace, LEAGUE_START_ROUND, leaderboardQuery, racesQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { getLiveRaceTelemetry, type LiveRaceTelemetryPayload } from "@/lib/weekend.functions";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "League standings \u2014 DOWNFORCE" },
      {
        name: "description",
        content: "Live DOWNFORCE prediction league standings for the season.",
      },
      { property: "og:title", content: "League standings \u2014 DOWNFORCE" },
      {
        property: "og:description",
        content: "See who is leading the DOWNFORCE prediction league.",
      },
      { name: "twitter:title", content: "League standings \u2014 DOWNFORCE" },
      { name: "twitter:description", content: "See who is leading the DOWNFORCE prediction league." },
    ],
  }),
  component: Leaderboard,
});

const LIVE_WINDOW_MS = 4 * 60 * 60_000; // 4 hours after lights out

function Leaderboard() {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const { data: board, isLoading } = useQuery({
    ...leaderboardQuery,
    enabled: !!user,
  });
  const { data: races } = useQuery(racesQuery);

  const [open, setOpen] = useState<string | null>(null);
  const [listRef] = useAutoAnimate<HTMLDivElement>();
  const [syncing, setSyncing] = useState(false);
  const [viewMode, setViewMode] = useState<"live" | "official">("live");
  const [previewLive, setPreviewLive] = useState(false);

  // Detect if a race from R14+ is currently live on track (started within last 4h and not yet officially scored)
  const activeLiveRace = useMemo(() => {
    const now = getTrustedNow();
    return (
      (races ?? []).find((r) => {
        if (r.round < LEAGUE_START_ROUND || r.has_results) return false;
        const start = new Date(r.race_at).getTime();
        return now >= start && now - start <= LIVE_WINDOW_MS;
      }) ?? null
    );
  }, [races]);

  // For "Test Live Mode" outside an active race window, use the most recent scored round
  const previewRace = useMemo(() => (races ? lastRace(races) : null), [races]);
  const targetLiveRace = activeLiveRace ?? (previewLive ? previewRace : null);

  // Poll shared server live race telemetry every 25s ONLY when a race is live and tab is focused
  const liveTelemetryQ = useQuery<LiveRaceTelemetryPayload>({
    queryKey: ["live-race-telemetry", activeLiveRace?.id],
    enabled: !!user && !!activeLiveRace,
    staleTime: 20_000,
    refetchInterval: (q) => (q.state.data?.state === "official" ? false : 25_000),
    refetchIntervalInBackground: false,
    queryFn: async () => getLiveRaceTelemetry({ data: { raceId: activeLiveRace!.id } }),
  });

  // Instant Chequered Flag Finalizer: when telemetry transitions to finalized/official, refresh official leaderboard!
  useEffect(() => {
    if (liveTelemetryQ.data?.finalizedNow || liveTelemetryQ.data?.state === "official") {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["races"] }),
        queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
      ]);
      if (liveTelemetryQ.data?.finalizedNow) {
        toast.success(`Chequered Flag! ${liveTelemetryQ.data.raceName} official points finalized!`);
      }
    }
  }, [
    liveTelemetryQ.data?.finalizedNow,
    liveTelemetryQ.data?.state,
    liveTelemetryQ.data?.raceName,
    queryClient,
  ]);

  const hasLiveTelemetry =
    (!!activeLiveRace &&
      ((liveTelemetryQ.data?.results.length ?? 0) >= 10 ||
        Object.keys(liveTelemetryQ.data?.liveScores ?? {}).length > 0)) ||
    (previewLive && !!previewRace);

  const virtualBoard = useMemo<VirtualLeaderboardEntry[] | null>(() => {
    if (!hasLiveTelemetry || !board || !targetLiveRace) return null;

    if (activeLiveRace && liveTelemetryQ.data) {
      return computeVirtualStandings({
        officialBoard: board,
        raceId: activeLiveRace.id,
        round: activeLiveRace.round,
        raceAt: activeLiveRace.race_at,
        liveResults: liveTelemetryQ.data.results,
        precomputedScores: liveTelemetryQ.data.liveScores,
      });
    }

    // Preview mode: replay the latest scored round as a live telemetry simulation
    const simScores: Record<string, number> = {};
    for (const e of board) {
      simScores[e.userId] = e.byRound[targetLiveRace.round] ?? 0;
    }
    return computeVirtualStandings({
      officialBoard: board,
      raceId: targetLiveRace.id,
      round: targetLiveRace.round,
      raceAt: targetLiveRace.race_at,
      precomputedScores: simScores,
    });
  }, [hasLiveTelemetry, board, targetLiveRace, activeLiveRace, liveTelemetryQ.data]);

  const isShowingVirtual = hasLiveTelemetry && viewMode === "live" && !!virtualBoard;
  const displayBoard: Array<VirtualLeaderboardEntry | NonNullable<typeof board>[number]> =
    isShowingVirtual ? virtualBoard! : (board ?? []);

  const scored =
    displayBoard[0]?.races ||
    (races?.filter(
      (r) =>
        r.round >= LEAGUE_START_ROUND &&
        r.has_results &&
        displayBoard.some((e) => (e.byRound[r.round] ?? 0) !== 0),
    ).length ?? 0);

  async function handleForceSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      await syncF1Data({ data: { force: true } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["races"] }),
        queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
        ...(activeLiveRace
          ? [queryClient.invalidateQueries({ queryKey: ["live-race-telemetry", activeLiveRace.id] })]
          : []),
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
        <p className="text-sm text-muted-foreground">Loading standings...</p>
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">League standings</h1>
          <p className="mt-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {scored} race{scored === 1 ? "" : "s"} scored
            {isShowingVirtual && targetLiveRace ? ` \u00B7 + R${targetLiveRace.round} LIVE` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!activeLiveRace && previewRace && (
            <Button
              type="button"
              variant={previewLive ? "default" : "outline"}
              size="sm"
              onClick={() => {
                const next = !previewLive;
                setPreviewLive(next);
                setViewMode("live");
                if (next) {
                  toast.info(`Simulating Live Virtual Standings using R${previewRace.round} (${previewRace.name})`);
                }
              }}
              className="shrink-0 gap-1.5"
            >
              <Play className="h-3.5 w-3.5" />
              {previewLive ? "Exit Live Preview" : "Test Live Mode"}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={syncing}
            onClick={handleForceSync}
            className="shrink-0 gap-1.5"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
            {syncing ? "Syncing\u2026" : "Sync results"}
          </Button>
        </div>
      </div>

      {targetLiveRace && (
        <div className="carbon-panel mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/50 bg-primary/10 px-3.5 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
            </span>
            <div>
              <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-primary">
                <Radio className="mr-1 inline h-3.5 w-3.5" />
                {previewLive && !activeLiveRace ? "Live Preview Simulation \u00B7 " : "Live Virtual Standings \u00B7 "}
                R{targetLiveRace.round} {targetLiveRace.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {previewLive && !activeLiveRace
                  ? "Previewing how live round badges (+PTS LIVE) and rank deltas (\u25B2/\u25BC) appear during Sunday's race"
                  : hasLiveTelemetry
                    ? "Real-time virtual points & rank deltas (<1ms client calc \u00B7 auto-locks on Chequered Flag)"
                    : "Waiting for live OpenF1 track classification\u2026"}
              </p>
            </div>
          </div>

          {hasLiveTelemetry && (
            <div className="flex rounded-full border border-border/80 bg-background/60 p-0.5 font-mono text-[10px] font-bold uppercase">
              <button
                type="button"
                onClick={() => setViewMode("live")}
                className={cn(
                  "rounded-full px-2.5 py-1 transition",
                  viewMode === "live" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                )}
              >
                Live Virtual
              </button>
              <button
                type="button"
                onClick={() => setViewMode("official")}
                className={cn(
                  "rounded-full px-2.5 py-1 transition",
                  viewMode === "official" ? "bg-secondary text-foreground" : "text-muted-foreground",
                )}
              >
                Before R{targetLiveRace.round}
              </button>
            </div>
          )}
        </div>
      )}

      {displayBoard.length > 0 && (
        <div className="mt-8 grid grid-cols-3 items-end gap-2">
          {[1, 0, 2].map((i) => {
            const e = displayBoard[i];
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
        {isLoading && <p className="text-sm text-muted-foreground">Loading timing tower...</p>}
        {!isLoading && !displayBoard.length && (
          <p className="text-sm text-muted-foreground">
            No players yet. Sign in to claim P1.
          </p>
        )}
        {displayBoard.map((entry, index) => {
          const vEntry = "liveRoundPoints" in entry ? (entry as VirtualLeaderboardEntry) : null;
          return (
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
                    {`${entry.races} scored \u00B7 best ${entry.best ?? 0} | avg ${entry.races ? (entry.points / entry.races).toFixed(1) : 0}`}
                  </p>
                </div>
                {isShowingVirtual && vEntry && (
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold tabular-nums",
                      vEntry.liveRoundPoints >= 0
                        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                        : "border-primary/40 bg-primary/15 text-primary",
                    )}
                  >
                    {vEntry.liveRoundPoints >= 0 ? `+${vEntry.liveRoundPoints}` : vEntry.liveRoundPoints} LIVE
                  </span>
                )}
                {entry.change != null && entry.change !== 0 && (
                  <span
                    className={cn(
                      "font-mono text-xs font-bold",
                      entry.change > 0 ? "text-gold" : "text-primary",
                    )}
                  >
                    {entry.change > 0 ? `\u25B2${entry.change}` : `\u25BC${-entry.change}`}
                  </span>
                )}
                <span className="font-mono text-xl font-bold tabular-nums">{entry.points}</span>
              </button>
              {open === entry.userId && (
                <div className="carbon-panel mt-1 grid grid-cols-4 gap-1 rounded-md p-2 sm:grid-cols-6">
                  <div className="col-span-full mb-1 flex flex-wrap gap-1.5 font-mono text-[10px] uppercase">
                    <span className="rounded bg-secondary px-2 py-0.5">
                      Avg {entry.races ? (entry.points / entry.races).toFixed(1) : 0} pts
                    </span>
                    <span className="rounded bg-secondary px-2 py-0.5">Best {entry.best ?? 0} pts</span>
                    {index === 0 && <span className="rounded bg-gold/20 text-gold px-2 py-0.5">Leader</span>}
                    {(entry.best ?? 0) >= 25 && (
                      <span className="rounded bg-primary/20 text-primary px-2 py-0.5">Pro Scorer</span>
                    )}
                  </div>
                  {(races ?? [])
                    .filter(
                      (r) =>
                        r.round >= LEAGUE_START_ROUND &&
                        (r.has_results || (isShowingVirtual && r.id === targetLiveRace?.id)) &&
                        displayBoard.some((e) => (e.byRound[r.round] ?? 0) !== 0),
                    )
                    .map((r) => (
                      <div
                        key={r.id}
                        className={cn(
                          "rounded-sm px-1 py-1 text-center",
                          isShowingVirtual && r.id === targetLiveRace?.id
                            ? "border border-primary/50 bg-primary/15"
                            : "bg-muted/60",
                        )}
                      >
                        <p className="font-mono text-[10px] uppercase text-muted-foreground">
                          R{r.round}
                          {isShowingVirtual && r.id === targetLiveRace?.id ? " \u2022" : ""}
                        </p>
                        <p className="font-mono text-sm font-bold tabular-nums">
                          {entry.byRound[r.round] ?? "\u2013"}
                        </p>
                      </div>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}