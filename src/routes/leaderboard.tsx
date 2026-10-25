import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Award,
  BarChart3,
  Flame,
  Flag,
  Gauge,
  Lock,
  RefreshCw,
  Shield,
  Sparkles,
  Trophy,
  Users,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";

import { FahlBadge } from "@/components/SiteHeader";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { syncF1Data } from "@/lib/f1-sync.functions";
import {
  driversQuery,
  leaderboardQuery,
  racesQuery,
  SEASON,
  type Driver,
} from "@/lib/queries";
import { teamColor, teamLabel, teamRank } from "@/lib/teams";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Standings & Telemetry — DOWNFORCE" },
      {
        name: "description",
        content:
          "Live DOWNFORCE prediction league standings, official F1 Drivers & Constructors Championship rankings, and season statistics.",
      },
      { property: "og:title", content: "Standings & Telemetry — DOWNFORCE" },
      {
        property: "og:description",
        content:
          "See who is leading the DOWNFORCE league and the official 2026 F1 World Championship.",
      },
      { name: "twitter:title", content: "Standings & Telemetry — DOWNFORCE" },
      {
        name: "twitter:description",
        content:
          "See who is leading the DOWNFORCE league and the official 2026 F1 World Championship.",
      },
    ],
  }),
  component: Leaderboard,
});

type TabKey = "league" | "drivers" | "constructors" | "stats";

type DriverStandingItem = {
  driverId: string;
  code: string;
  number: number | null;
  fullName: string;
  team: string;
  points: number;
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  top10: number;
  dnfs: number;
  racesEntered: number;
  bestFinish: number | null;
};

type ConstructorStandingItem = {
  team: string;
  points: number;
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  dnfs: number;
  drivers: {
    driverId: string;
    code: string;
    number: number | null;
    fullName: string;
    points: number;
  }[];
};

type F1StandingsPayload = {
  roundsCompleted: number;
  drivers: DriverStandingItem[];
  constructors: ConstructorStandingItem[];
};

const FIA_RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

const f1StandingsQuery = queryOptions({
  queryKey: ["f1-championship-standings", SEASON],
  staleTime: 10 * 60_000,
  gcTime: 30 * 60_000,
  queryFn: async (): Promise<F1StandingsPayload> => {
    // 1. Fetch local drivers, races, and race_results in parallel with Jolpica official standings
    const [driversRes, racesRes, resultsRes, jolpicaDriversRes, jolpicaTeamsRes] =
      await Promise.all([
        supabase
          .from("drivers")
          .select("id, code, full_name, team, number")
          .eq("active", true),
        supabase
          .from("races")
          .select("id, round, has_results")
          .eq("season", SEASON),
        supabase
          .from("race_results")
          .select("race_id, driver_id, position, pole, fastest_lap, finished, status"),
        fetch(`https://api.jolpi.ca/ergast/f1/${SEASON}/driverstandings/?format=json`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(
          `https://api.jolpi.ca/ergast/f1/${SEASON}/constructorstandings/?format=json`,
        )
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);

    const dbDrivers = (driversRes.data ?? []) as Driver[];
    const seasonRaces = racesRes.data ?? [];
    const seasonRaceIds = new Set(seasonRaces.map((r) => r.id));
    const roundsCompleted = seasonRaces.filter((r) => r.has_results).length;

    const seasonResults = (resultsRes.data ?? []).filter((r) =>
      seasonRaceIds.has(r.race_id),
    );

    const byDriver = new Map<string, DriverStandingItem>();

    for (const d of dbDrivers) {
      byDriver.set(d.id, {
        driverId: d.id,
        code: d.code ?? d.full_name.slice(0, 3).toUpperCase(),
        number: d.number,
        fullName: d.full_name,
        team: teamLabel(d.team),
        points: 0,
        wins: 0,
        podiums: 0,
        poles: 0,
        fastestLaps: 0,
        top10: 0,
        dnfs: 0,
        racesEntered: 0,
        bestFinish: null,
      });
    }

    // Aggregate telemetry from Supabase race_results (poles, podiums, fastest laps, DNFs, fallback points)
    const computedPoints = new Map<string, number>();
    for (const row of seasonResults) {
      let item = byDriver.get(row.driver_id);
      if (!item) {
        item = {
          driverId: row.driver_id,
          code: row.driver_id.slice(0, 3).toUpperCase(),
          number: null,
          fullName: row.driver_id.replace(/_/g, " "),
          team: "—",
          points: 0,
          wins: 0,
          podiums: 0,
          poles: 0,
          fastestLaps: 0,
          top10: 0,
          dnfs: 0,
          racesEntered: 0,
          bestFinish: null,
        };
        byDriver.set(row.driver_id, item);
      }

      item.racesEntered += 1;
      if (row.pole) item.poles += 1;
      if (row.fastest_lap) item.fastestLaps += 1;
      if (!row.finished) item.dnfs += 1;

      if (row.position != null) {
        if (row.position === 1) item.wins += 1;
        if (row.position <= 3) item.podiums += 1;
        if (row.position <= 10) {
          item.top10 += 1;
          const pts = FIA_RACE_POINTS[row.position - 1] ?? 0;
          computedPoints.set(
            row.driver_id,
            (computedPoints.get(row.driver_id) ?? 0) + pts,
          );
        }
        item.bestFinish =
          item.bestFinish == null
            ? row.position
            : Math.min(item.bestFinish, row.position);
      }
    }

    // Apply fallback points first
    for (const [driverId, pts] of computedPoints.entries()) {
      const d = byDriver.get(driverId);
      if (d) d.points = pts;
    }

    // Overlay official Jolpica Driver Standings (includes Sprint points and official tie-breakers)
    const jolpicaDriverLists =
      jolpicaDriversRes?.MRData?.StandingsTable?.StandingsLists?.[0]
        ?.DriverStandings ?? [];
    for (const jd of jolpicaDriverLists) {
      const id: string | undefined = jd?.Driver?.driverId;
      if (!id) continue;
      const officialPts = Number(jd?.points ?? 0);
      const officialWins = Number(jd?.wins ?? 0);
      const constructorName = jd?.Constructors?.[0]?.name;
      const existing = byDriver.get(id);
      if (existing) {
        existing.points = Math.max(existing.points, officialPts);
        existing.wins = Math.max(existing.wins, officialWins);
        if (constructorName && existing.team === "—") {
          existing.team = teamLabel(constructorName);
        }
      } else {
        byDriver.set(id, {
          driverId: id,
          code:
            jd?.Driver?.code ??
            String(jd?.Driver?.familyName ?? id)
              .slice(0, 3)
              .toUpperCase(),
          number: jd?.Driver?.permanentNumber
            ? Number(jd.Driver.permanentNumber)
            : null,
          fullName: `${jd?.Driver?.givenName ?? ""} ${jd?.Driver?.familyName ?? ""}`.trim(),
          team: teamLabel(constructorName),
          points: officialPts,
          wins: officialWins,
          podiums: officialWins,
          poles: 0,
          fastestLaps: 0,
          top10: officialPts > 0 ? 1 : 0,
          dnfs: 0,
          racesEntered: roundsCompleted,
          bestFinish: officialWins > 0 ? 1 : null,
        });
      }
    }

    const sortedDrivers = [...byDriver.values()].sort(
      (a, b) =>
        b.points - a.points ||
        b.wins - a.wins ||
        b.podiums - a.podiums ||
        (a.bestFinish ?? 99) - (b.bestFinish ?? 99) ||
        teamRank(a.team) - teamRank(b.team) ||
        (a.number ?? 999) - (b.number ?? 999),
    );

    // Build Constructor Standings
    const byTeam = new Map<string, ConstructorStandingItem>();
    for (const d of sortedDrivers) {
      if (!d.team || d.team === "—") continue;
      let t = byTeam.get(d.team);
      if (!t) {
        t = {
          team: d.team,
          points: 0,
          wins: 0,
          podiums: 0,
          poles: 0,
          fastestLaps: 0,
          dnfs: 0,
          drivers: [],
        };
        byTeam.set(d.team, t);
      }
      t.points += d.points;
      t.wins += d.wins;
      t.podiums += d.podiums;
      t.poles += d.poles;
      t.fastestLaps += d.fastestLaps;
      t.dnfs += d.dnfs;
      t.drivers.push({
        driverId: d.driverId,
        code: d.code,
        number: d.number,
        fullName: d.fullName,
        points: d.points,
      });
    }

    // Overlay official Jolpica Constructor Standings if available
    const jolpicaTeamLists =
      jolpicaTeamsRes?.MRData?.StandingsTable?.StandingsLists?.[0]
        ?.ConstructorStandings ?? [];
    for (const jt of jolpicaTeamLists) {
      const cName = teamLabel(jt?.Constructor?.name);
      if (!cName || cName === "—") continue;
      const officialPts = Number(jt?.points ?? 0);
      const officialWins = Number(jt?.wins ?? 0);
      const existing = byTeam.get(cName);
      if (existing) {
        existing.points = Math.max(existing.points, officialPts);
        existing.wins = Math.max(existing.wins, officialWins);
      }
    }

    const sortedConstructors = [...byTeam.values()].sort(
      (a, b) =>
        b.points - a.points ||
        b.wins - a.wins ||
        b.podiums - a.podiums ||
        teamRank(a.team) - teamRank(b.team),
    );

    return {
      roundsCompleted,
      drivers: sortedDrivers,
      constructors: sortedConstructors,
    };
  },
});

function Leaderboard() {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<TabKey>("league");
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [openDriver, setOpenDriver] = useState<string | null>(null);
  const [listRef] = useAutoAnimate<HTMLDivElement>();
  const [syncing, setSyncing] = useState(false);

  const { data: board, isLoading: boardLoading } = useQuery({
    ...leaderboardQuery,
    enabled: !!user,
  });
  const { data: races } = useQuery(racesQuery);
  const { data: f1Data, isLoading: f1Loading } = useQuery({
    ...f1StandingsQuery,
    enabled: true,
  });

  useQuery(driversQuery);

  const scored =
    board?.[0]?.races || (races?.filter((r) => r.has_results).length ?? 0);

  async function handleForceSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      await syncF1Data({ data: { force: true } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["races"] }),
        queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
        queryClient.invalidateQueries({
          queryKey: ["f1-championship-standings"],
        }),
      ]);
      toast.success("Standings and official F1 telemetry synced!");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not sync right now.");
    } finally {
      setSyncing(false);
    }
  }

  const tabs: { key: TabKey; label: string; shortLabel: string; icon: typeof Trophy }[] = [
    { key: "league", label: "League", shortLabel: "League", icon: Trophy },
    { key: "drivers", label: "F1 Drivers", shortLabel: "Drivers", icon: Gauge },
    { key: "constructors", label: "Constructors", shortLabel: "Teams", icon: Shield },
    { key: "stats", label: "Season Stats", shortLabel: "Stats", icon: BarChart3 },
  ];

  // Season leader helpers for Stats tab
  const f1Drivers = f1Data?.drivers ?? [];
  const f1Constructors = f1Data?.constructors ?? [];
  const topDriverPoints = f1Drivers[0]?.points ?? 0;
  const topTeamPoints = f1Constructors[0]?.points ?? 0;
  const totalTeamPoints = Math.max(
    1,
    f1Constructors.reduce((acc, c) => acc + c.points, 0),
  );

  const mostWinsDriver = [...f1Drivers].sort(
    (a, b) => b.wins - a.wins || b.points - a.points,
  )[0];
  const mostPolesDriver = [...f1Drivers].sort(
    (a, b) => b.poles - a.poles || b.points - a.points,
  )[0];
  const mostPodiumsDriver = [...f1Drivers].sort(
    (a, b) => b.podiums - a.podiums || b.points - a.points,
  )[0];
  const mostFastestLapsDriver = [...f1Drivers].sort(
    (a, b) => b.fastestLaps - a.fastestLaps || b.points - a.points,
  )[0];
  const mostTop10Driver = [...f1Drivers].sort(
    (a, b) => b.top10 - a.top10 || b.points - a.points,
  )[0];
  const mostDnfsDriver = [...f1Drivers].sort(
    (a, b) => b.dnfs - a.dnfs || a.points - b.points,
  )[0];

  // League stats
  const bestSingleRoundEntry = [...(board ?? [])].sort(
    (a, b) => (b.best ?? 0) - (a.best ?? 0),
  )[0];
  const bestAverageEntry = [...(board ?? [])]
    .filter((e) => e.races > 0)
    .sort((a, b) => b.points / b.races - a.points / a.races)[0];
  const fahlEntries = (board ?? []).filter((e) => e.fahl);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
            <Sparkles className="h-3 w-3" />
            {SEASON} Championship Hub
          </div>
          <h1 className="mt-2 text-3xl">
            {activeTab === "league" && "League Standings"}
            {activeTab === "drivers" && "Drivers' Championship"}
            {activeTab === "constructors" && "Constructors' Championship"}
            {activeTab === "stats" && "Season & League Telemetry"}
          </h1>
          <p className="mt-1.5 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {scored} race{scored === 1 ? "" : "s"} scored · Official FIA & League Data
          </p>
        </div>
        {user && (
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
        )}
      </div>

      {/* Segmented Glass Navigation Tabs */}
      <div
        role="tablist"
        aria-label="Standings categories"
        className="mt-6 grid grid-cols-4 gap-1.5 rounded-xl border border-white/10 bg-black/40 p-1.5 backdrop-blur-xl"
      >
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(t.key)}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-2.5 font-display text-xs font-extrabold uppercase tracking-wider transition-all sm:text-sm",
                isActive
                  ? "bg-primary text-primary-foreground shadow-[0_0_20px_rgba(225,6,0,0.4)]"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">{t.label}</span>
              <span className="sm:hidden">{t.shortLabel}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: DOWNFORCE PREDICTION LEAGUE */}
      {activeTab === "league" && (
        <section className="mt-8">
          {authLoading ? (
            <p className="text-sm text-muted-foreground">Loading league standings…</p>
          ) : !user ? (
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/45 p-6 shadow-2xl backdrop-blur-xl sm:p-8">
              <div className="pointer-events-none absolute -top-24 -right-24 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-widest text-primary">
                <Lock className="h-3.5 w-3.5" />
                Prediction League Access
              </div>
              <h2 className="mt-4 font-display text-2xl font-extrabold italic uppercase tracking-wide sm:text-3xl">
                Sign in to view League Standings
              </h2>
              <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                Join the DOWNFORCE league to see player rankings, round-by-round point
                breakdowns, and who holds the Fahl El-Gawla crown. You can still browse
                official{" "}
                <button
                  type="button"
                  onClick={() => setActiveTab("drivers")}
                  className="font-semibold text-foreground underline decoration-primary underline-offset-4"
                >
                  F1 Drivers
                </button>{" "}
                and{" "}
                <button
                  type="button"
                  onClick={() => setActiveTab("constructors")}
                  className="font-semibold text-foreground underline decoration-primary underline-offset-4"
                >
                  Constructors
                </button>{" "}
                tabs anytime!
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button asChild size="lg" className="font-display font-bold uppercase tracking-wider">
                  <Link to="/auth">Continue with Google</Link>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  onClick={() => setActiveTab("drivers")}
                >
                  Explore F1 Drivers Standings
                </Button>
              </div>
            </div>
          ) : (
            <>
              {board && board.length > 0 && (
                <div className="grid grid-cols-3 items-end gap-2">
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
                {boardLoading && (
                  <p className="text-sm text-muted-foreground">Loading timing tower…</p>
                )}
                {!boardLoading && !board?.length && (
                  <p className="text-sm text-muted-foreground">
                    No players yet. Lock in a prediction to claim P1.
                  </p>
                )}
                {board?.map((entry, index) => (
                  <div key={entry.userId}>
                    <button
                      type="button"
                      onClick={() =>
                        setOpenUser(openUser === entry.userId ? null : entry.userId)
                      }
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
                          {entry.races} scored · best {entry.best ?? 0} | avg{" "}
                          {entry.races ? (entry.points / entry.races).toFixed(1) : 0}
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
                      <span className="font-mono text-xl font-bold tabular-nums">
                        {entry.points}
                      </span>
                    </button>
                    {openUser === entry.userId && (
                      <div className="carbon-panel mt-1 grid grid-cols-4 gap-1 rounded-md p-2 sm:grid-cols-6">
                        <div className="col-span-full mb-1 flex flex-wrap gap-1.5 font-mono text-[10px] uppercase">
                          <span className="rounded bg-secondary px-2 py-0.5">
                            Avg {entry.races ? (entry.points / entry.races).toFixed(1) : 0} pts
                          </span>
                          <span className="rounded bg-secondary px-2 py-0.5">
                            Best {entry.best ?? 0} pts
                          </span>
                          {index === 0 && (
                            <span className="rounded bg-gold/20 px-2 py-0.5 text-gold">
                              Leader
                            </span>
                          )}
                          {(entry.best ?? 0) >= 25 && (
                            <span className="rounded bg-primary/20 px-2 py-0.5 text-primary">
                              Pro Scorer
                            </span>
                          )}
                        </div>
                        {(races ?? [])
                          .filter(
                            (r) =>
                              r.has_results &&
                              (board ?? []).some((e) => e.byRound[r.round] !== undefined),
                          )
                          .map((r) => (
                            <div
                              key={r.id}
                              className="rounded-sm bg-muted/60 px-1 py-1 text-center"
                            >
                              <p className="font-mono text-[10px] uppercase text-muted-foreground">
                                R{r.round}
                              </p>
                              <p className="font-mono text-sm font-bold tabular-nums">
                                {entry.byRound[r.round] ?? "–"}
                              </p>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* TAB 2: OFFICIAL F1 DRIVERS' CHAMPIONSHIP */}
      {activeTab === "drivers" && (
        <section className="mt-8">
          {f1Loading ? (
            <p className="text-sm text-muted-foreground">
              Loading official FIA Driver Standings…
            </p>
          ) : (
            <>
              {/* Top 3 Drivers Podium */}
              {f1Drivers.length >= 3 && (
                <div className="grid grid-cols-3 items-end gap-2.5">
                  {[1, 0, 2].map((i) => {
                    const d = f1Drivers[i];
                    if (!d) return <div key={i} />;
                    const tColor = teamColor(d.team);
                    const heights = [104, 80, 64];
                    return (
                      <div key={d.driverId} className="text-center">
                        <div className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/40 px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: tColor }}
                          />
                          {d.team}
                        </div>
                        <p className="mt-1 truncate font-display text-sm font-extrabold italic uppercase sm:text-base">
                          {d.fullName}
                        </p>
                        <p className="font-mono text-lg font-bold tabular-nums">
                          {d.points}{" "}
                          <span className="text-[10px] font-normal uppercase text-muted-foreground">
                            pts
                          </span>
                        </p>
                        <div
                          className="mt-1.5 flex flex-col items-center justify-between rounded-t-lg border-t-2 pt-2 pb-1.5 font-display text-2xl font-extrabold italic text-foreground"
                          style={{
                            borderColor: tColor,
                            background: `linear-gradient(180deg, color-mix(in srgb, ${tColor} 28%, transparent), rgba(15,18,26,0.85))`,
                            height: heights[i],
                          }}
                        >
                          <span>P{i + 1}</span>
                          <span className="font-mono text-[10px] font-semibold not-italic uppercase tracking-widest text-muted-foreground">
                            {d.wins} {d.wins === 1 ? "win" : "wins"} · {d.podiums} pod
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 22-Driver Timing Tower */}
              <div className="mt-8 space-y-2">
                {f1Drivers.map((d, index) => {
                  const tColor = teamColor(d.team);
                  const gap = index === 0 ? "LEADER" : `-${topDriverPoints - d.points}`;
                  const isOpen = openDriver === d.driverId;
                  return (
                    <div key={d.driverId}>
                      <button
                        type="button"
                        onClick={() =>
                          setOpenDriver(isOpen ? null : d.driverId)
                        }
                        className={cn(
                          "tower-row flex w-full items-center gap-3 rounded-md px-3 py-3 text-left transition-all",
                          isOpen && "ring-1 ring-white/25",
                        )}
                        style={{
                          borderLeft: `4px solid ${tColor}`,
                        }}
                      >
                        <span
                          className={cn(
                            "w-7 shrink-0 text-center font-mono text-base font-bold tabular-nums",
                            index === 0 && "text-gold",
                          )}
                        >
                          {index + 1}
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-wider">
                              {d.code}
                            </span>
                            <p className="truncate font-display text-sm font-extrabold italic uppercase sm:text-base">
                              {d.fullName}
                            </p>
                            {d.number != null && (
                              <span
                                className="font-mono text-xs font-extrabold italic"
                                style={{ color: tColor }}
                              >
                                #{d.number}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                            <span className="font-semibold text-foreground/80">
                              {d.team}
                            </span>
                            {d.wins > 0 && (
                              <span className="text-gold">
                                🏆 {d.wins}W
                              </span>
                            )}
                            {d.podiums > 0 && <span>🍾 {d.podiums} POD</span>}
                            {d.poles > 0 && <span>⚡ {d.poles} POLE</span>}
                            {d.fastestLaps > 0 && (
                              <span className="text-purple-400">
                                ⏱ {d.fastestLaps} FL
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="font-mono text-xl font-bold tabular-nums leading-none">
                            {d.points}
                          </div>
                          <div className="mt-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                            {gap}
                          </div>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="carbon-panel mt-1 rounded-md border border-white/10 p-3">
                          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                            <div className="rounded bg-secondary/70 p-2 text-center">
                              <p className="font-mono text-[10px] uppercase text-muted-foreground">
                                Wins
                              </p>
                              <p className="font-mono text-base font-bold text-gold">
                                {d.wins}
                              </p>
                            </div>
                            <div className="rounded bg-secondary/70 p-2 text-center">
                              <p className="font-mono text-[10px] uppercase text-muted-foreground">
                                Podiums
                              </p>
                              <p className="font-mono text-base font-bold">
                                {d.podiums}
                              </p>
                            </div>
                            <div className="rounded bg-secondary/70 p-2 text-center">
                              <p className="font-mono text-[10px] uppercase text-muted-foreground">
                                Poles
                              </p>
                              <p className="font-mono text-base font-bold">
                                {d.poles}
                              </p>
                            </div>
                            <div className="rounded bg-secondary/70 p-2 text-center">
                              <p className="font-mono text-[10px] uppercase text-muted-foreground">
                                Fastest Laps
                              </p>
                              <p className="font-mono text-base font-bold text-purple-400">
                                {d.fastestLaps}
                              </p>
                            </div>
                            <div className="rounded bg-secondary/70 p-2 text-center">
                              <p className="font-mono text-[10px] uppercase text-muted-foreground">
                                Best Finish
                              </p>
                              <p className="font-mono text-base font-bold">
                                {d.bestFinish != null ? `P${d.bestFinish}` : "—"}
                              </p>
                            </div>
                            <div className="rounded bg-secondary/70 p-2 text-center">
                              <p className="font-mono text-[10px] uppercase text-muted-foreground">
                                DNFs
                              </p>
                              <p className="font-mono text-base font-bold text-primary">
                                {d.dnfs}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      )}

      {/* TAB 3: OFFICIAL F1 CONSTRUCTORS' CHAMPIONSHIP */}
      {activeTab === "constructors" && (
        <section className="mt-8">
          {f1Loading ? (
            <p className="text-sm text-muted-foreground">
              Loading official FIA Constructor Standings…
            </p>
          ) : (
            <div className="space-y-3">
              {f1Constructors.map((c, index) => {
                const tColor = teamColor(c.team);
                const pct =
                  topTeamPoints > 0
                    ? Math.max(4, Math.round((c.points / topTeamPoints) * 100))
                    : 4;
                const gap =
                  index === 0 ? "LEADER" : `-${topTeamPoints - c.points} PTS`;

                return (
                  <div
                    key={c.team}
                    className="tower-row rounded-lg border border-white/10 p-4"
                    style={{
                      borderLeft: `5px solid ${tColor}`,
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span
                          className={cn(
                            "w-7 text-center font-mono text-xl font-bold tabular-nums",
                            index === 0 && "text-gold",
                          )}
                        >
                          {index + 1}
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-display text-lg font-extrabold italic uppercase tracking-wide">
                              {c.team}
                            </h3>
                            {c.wins > 0 && (
                              <span className="rounded-full bg-gold/15 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-gold">
                                🏆 {c.wins} {c.wins === 1 ? "Win" : "Wins"}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                            <span>{c.podiums} Podiums</span>
                            <span>·</span>
                            <span>{c.poles} Poles</span>
                            <span>·</span>
                            <span>{c.fastestLaps} Fastest Laps</span>
                          </div>
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="font-mono text-2xl font-bold tabular-nums leading-none">
                          {c.points}
                        </div>
                        <div className="mt-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                          {gap}
                        </div>
                      </div>
                    </div>

                    {/* Points Share Bar */}
                    <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${pct}%`,
                          background: tColor,
                        }}
                      />
                    </div>

                    {/* Team Driver Pair Contribution Pills */}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {c.drivers.map((drv) => (
                        <div
                          key={drv.driverId}
                          className="flex items-center justify-between rounded-md border border-white/5 bg-black/35 px-2.5 py-1.5"
                        >
                          <div className="flex items-center gap-1.5 truncate">
                            <span
                              className="font-mono text-xs font-bold"
                              style={{ color: tColor }}
                            >
                              {drv.code}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                              {drv.fullName}
                            </span>
                          </div>
                          <span className="font-mono text-xs font-bold tabular-nums">
                            {drv.points} pts
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* TAB 4: SEASON & LEAGUE TELEMETRY STATS */}
      {activeTab === "stats" && (
        <section className="mt-8 space-y-8">
          {/* F1 Season Telemetry Leaders */}
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Flag className="h-4 w-4 text-primary" />
              <h2 className="font-display text-lg font-extrabold italic uppercase tracking-wider">
                {SEASON} FIA Formula 1 Season Leaders
              </h2>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* Most Wins */}
              <div className="carbon-panel rounded-xl border border-white/10 p-4">
                <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  <span>🏆 Grand Prix Wins Leader</span>
                  <Trophy className="h-4 w-4 text-gold" />
                </div>
                {mostWinsDriver ? (
                  <div className="mt-2 flex items-baseline justify-between">
                    <div>
                      <p className="font-display text-lg font-extrabold italic uppercase">
                        {mostWinsDriver.fullName}
                      </p>
                      <p
                        className="font-mono text-xs font-semibold uppercase"
                        style={{ color: teamColor(mostWinsDriver.team) }}
                      >
                        {mostWinsDriver.team}
                      </p>
                    </div>
                    <span className="font-mono text-2xl font-extrabold text-gold tabular-nums">
                      {mostWinsDriver.wins}
                    </span>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No races scored yet</p>
                )}
              </div>

              {/* Most Poles */}
              <div className="carbon-panel rounded-xl border border-white/10 p-4">
                <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  <span>⚡ Qualifying Pole King</span>
                  <Zap className="h-4 w-4 text-primary" />
                </div>
                {mostPolesDriver ? (
                  <div className="mt-2 flex items-baseline justify-between">
                    <div>
                      <p className="font-display text-lg font-extrabold italic uppercase">
                        {mostPolesDriver.fullName}
                      </p>
                      <p
                        className="font-mono text-xs font-semibold uppercase"
                        style={{ color: teamColor(mostPolesDriver.team) }}
                      >
                        {mostPolesDriver.team}
                      </p>
                    </div>
                    <span className="font-mono text-2xl font-extrabold tabular-nums">
                      {mostPolesDriver.poles}
                    </span>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No poles recorded yet</p>
                )}
              </div>

              {/* Most Podiums */}
              <div className="carbon-panel rounded-xl border border-white/10 p-4">
                <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  <span>🍾 Podium Finishes Leader</span>
                  <Award className="h-4 w-4 text-gold" />
                </div>
                {mostPodiumsDriver ? (
                  <div className="mt-2 flex items-baseline justify-between">
                    <div>
                      <p className="font-display text-lg font-extrabold italic uppercase">
                        {mostPodiumsDriver.fullName}
                      </p>
                      <p
                        className="font-mono text-xs font-semibold uppercase"
                        style={{ color: teamColor(mostPodiumsDriver.team) }}
                      >
                        {mostPodiumsDriver.team}
                      </p>
                    </div>
                    <span className="font-mono text-2xl font-extrabold tabular-nums">
                      {mostPodiumsDriver.podiums}
                    </span>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No podiums yet</p>
                )}
              </div>

              {/* Fastest Laps */}
              <div className="carbon-panel rounded-xl border border-white/10 p-4">
                <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  <span>⏱ Fastest Lap Awards</span>
                  <Gauge className="h-4 w-4 text-purple-400" />
                </div>
                {mostFastestLapsDriver ? (
                  <div className="mt-2 flex items-baseline justify-between">
                    <div>
                      <p className="font-display text-lg font-extrabold italic uppercase">
                        {mostFastestLapsDriver.fullName}
                      </p>
                      <p
                        className="font-mono text-xs font-semibold uppercase"
                        style={{ color: teamColor(mostFastestLapsDriver.team) }}
                      >
                        {mostFastestLapsDriver.team}
                      </p>
                    </div>
                    <span className="font-mono text-2xl font-extrabold text-purple-400 tabular-nums">
                      {mostFastestLapsDriver.fastestLaps}
                    </span>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No fastest laps yet</p>
                )}
              </div>

              {/* Most Top-10 Finishes */}
              <div className="carbon-panel rounded-xl border border-white/10 p-4">
                <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  <span>🎯 Points Finishes (Top 10)</span>
                  <BarChart3 className="h-4 w-4 text-emerald-400" />
                </div>
                {mostTop10Driver ? (
                  <div className="mt-2 flex items-baseline justify-between">
                    <div>
                      <p className="font-display text-lg font-extrabold italic uppercase">
                        {mostTop10Driver.fullName}
                      </p>
                      <p
                        className="font-mono text-xs font-semibold uppercase"
                        style={{ color: teamColor(mostTop10Driver.team) }}
                      >
                        {mostTop10Driver.team}
                      </p>
                    </div>
                    <span className="font-mono text-2xl font-extrabold text-emerald-400 tabular-nums">
                      {mostTop10Driver.top10}
                    </span>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No finishes yet</p>
                )}
              </div>

              {/* Most DNFs */}
              <div className="carbon-panel rounded-xl border border-white/10 p-4">
                <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  <span>💥 Most Retirements (DNF)</span>
                  <Flame className="h-4 w-4 text-primary" />
                </div>
                {mostDnfsDriver ? (
                  <div className="mt-2 flex items-baseline justify-between">
                    <div>
                      <p className="font-display text-lg font-extrabold italic uppercase">
                        {mostDnfsDriver.fullName}
                      </p>
                      <p
                        className="font-mono text-xs font-semibold uppercase"
                        style={{ color: teamColor(mostDnfsDriver.team) }}
                      >
                        {mostDnfsDriver.team}
                      </p>
                    </div>
                    <span className="font-mono text-2xl font-extrabold text-primary tabular-nums">
                      {mostDnfsDriver.dnfs}
                    </span>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">0 DNFs recorded</p>
                )}
              </div>
            </div>
          </div>

          {/* Constructor Points Share Breakdown */}
          {f1Constructors.length > 0 && (
            <div className="carbon-panel rounded-xl border border-white/10 p-4">
              <h3 className="font-display text-sm font-extrabold italic uppercase tracking-wider text-muted-foreground">
                Constructor Championship Points Share
              </h3>
              <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-black/50">
                {f1Constructors
                  .filter((c) => c.points > 0)
                  .map((c) => (
                    <div
                      key={c.team}
                      title={`${c.team}: ${c.points} pts`}
                      style={{
                        width: `${(c.points / totalTeamPoints) * 100}%`,
                        background: teamColor(c.team),
                      }}
                    />
                  ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-3">
                {f1Constructors.slice(0, 6).map((c) => (
                  <div key={c.team} className="flex items-center gap-1.5 text-xs">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: teamColor(c.team) }}
                    />
                    <span className="font-semibold">{c.team}</span>
                    <span className="font-mono text-muted-foreground">
                      {Math.round((c.points / totalTeamPoints) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* DOWNFORCE League Records */}
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Users className="h-4 w-4 text-gold" />
              <h2 className="font-display text-lg font-extrabold italic uppercase tracking-wider">
                DOWNFORCE Prediction League Records
              </h2>
            </div>

            {!user ? (
              <p className="text-sm text-muted-foreground">
                Sign in to view DOWNFORCE prediction league player records.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="carbon-panel rounded-xl border border-white/10 p-4">
                  <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    👑 League Leader
                  </p>
                  <p className="mt-1 truncate font-display text-lg font-extrabold italic uppercase text-gold">
                    {board?.[0]?.name ?? "—"}
                  </p>
                  <p className="font-mono text-sm font-bold">
                    {board?.[0]?.points ?? 0} pts
                  </p>
                </div>

                <div className="carbon-panel rounded-xl border border-white/10 p-4">
                  <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    🚀 Best Single Round
                  </p>
                  <p className="mt-1 truncate font-display text-lg font-extrabold italic uppercase">
                    {bestSingleRoundEntry?.name ?? "—"}
                  </p>
                  <p className="font-mono text-sm font-bold text-primary">
                    {bestSingleRoundEntry?.best ?? 0} pts in 1 race
                  </p>
                </div>

                <div className="carbon-panel rounded-xl border border-white/10 p-4">
                  <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    📈 Highest Average
                  </p>
                  <p className="mt-1 truncate font-display text-lg font-extrabold italic uppercase">
                    {bestAverageEntry?.name ?? "—"}
                  </p>
                  <p className="font-mono text-sm font-bold">
                    {bestAverageEntry
                      ? (bestAverageEntry.points / bestAverageEntry.races).toFixed(1)
                      : "0.0"}{" "}
                    pts / race
                  </p>
                  {fahlEntries.length > 0 && (
                    <p className="mt-1 font-mono text-[10px] text-gold">
                      🔥 Fahl: {fahlEntries.map((e) => e.name).join(", ")}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
