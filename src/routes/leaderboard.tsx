import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";

import { FahlBadge } from "@/components/SiteHeader";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { syncF1Data } from "@/lib/f1-sync.functions";
import { driversQuery, leaderboardQuery, racesQuery, SEASON, type Driver } from "@/lib/queries";
import { writeQueryCache } from "@/lib/queryPersist";
import { teamColor, teamLabel, teamRank } from "@/lib/teams";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Standings — DOWNFORCE" },
      {
        name: "description",
        content:
          "Live DOWNFORCE prediction league standings, official F1 Drivers & Constructors rankings, and season stats.",
      },
      { property: "og:title", content: "Standings — DOWNFORCE" },
      {
        property: "og:description",
        content: "See who is leading the DOWNFORCE league and the official 2026 F1 Championship.",
      },
      { name: "twitter:title", content: "Standings — DOWNFORCE" },
      {
        name: "twitter:description",
        content: "See who is leading the DOWNFORCE league and the official 2026 F1 Championship.",
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
    points: number;
  }[];
};

type F1StandingsPayload = {
  roundsCompleted: number;
  drivers: DriverStandingItem[];
  constructors: ConstructorStandingItem[];
};

// Official 2026 F1 Championship standings snapshot after Round 18 (Austin GP)
// SOURCE: https://www.formula1.com/en/results/2026/drivers
// ATOMIC VALIDATION: Never overwrite verified Austin data with stale cache
// NOTE: Yuki Tsunoda is included (was excluded in previous version)
const OFFICIAL_2026_DRIVERS_SNAPSHOT: Record<
  string,
  {
    code: string;
    fullName: string;
    team: string;
    number: number;
    points: number;
    wins: number;
    podiums: number;
    poles: number;
    fastestLaps: number;
    top10: number;
    dnfs: number;
    bestFinish: number;
  }
> = {
  // TOP 3 - Championship contenders
  ANT: {
    code: "ANT",
    fullName: "Andrea Kimi Antonelli",
    team: "Mercedes",
    number: 12,
    points: 365,
    wins: 9,
    podiums: 15,
    poles: 7,
    fastestLaps: 7,
    top10: 16,
    dnfs: 1,
    bestFinish: 1,
  },
  RUS: {
    code: "RUS",
    fullName: "George Russell",
    team: "Mercedes",
    number: 63,
    points: 242,
    wins: 3,
    podiums: 8,
    poles: 5,
    fastestLaps: 2,
    top10: 14,
    dnfs: 3,
    bestFinish: 1,
  },
  HAM: {
    code: "HAM",
    fullName: "Lewis Hamilton",
    team: "Ferrari",
    number: 44,
    points: 241,
    wins: 1,
    podiums: 6,
    poles: 0,
    fastestLaps: 1,
    top10: 17,
    dnfs: 1,
    bestFinish: 1,
  },

  // 4-6 - Midfield leaders
  VER: {
    code: "VER",
    fullName: "Max Verstappen",
    team: "Red Bull Racing",
    number: 3,
    points: 236,
    wins: 2,
    podiums: 10,
    poles: 2,
    fastestLaps: 2,
    top10: 14,
    dnfs: 4,
    bestFinish: 1,
  },
  LEC: {
    code: "LEC",
    fullName: "Charles Leclerc",
    team: "Ferrari",
    number: 16,
    points: 233,
    wins: 1,
    podiums: 6,
    poles: 0,
    fastestLaps: 4,
    top10: 15,
    dnfs: 3,
    bestFinish: 1,
  },
  NOR: {
    code: "NOR",
    fullName: "Lando Norris",
    team: "McLaren",
    number: 1,
    points: 211,
    wins: 2,
    podiums: 5,
    poles: 3,
    fastestLaps: 2,
    top10: 14,
    dnfs: 3,
    bestFinish: 1,
  },

  // 7-10 - Rising stars
  PIA: {
    code: "PIA",
    fullName: "Oscar Piastri",
    team: "McLaren",
    number: 81,
    points: 144,
    wins: 0,
    podiums: 2,
    poles: 0,
    fastestLaps: 0,
    top10: 12,
    dnfs: 1,
    bestFinish: 2,
  },
  HAD: {
    code: "HAD",
    fullName: "Isack Hadjar",
    team: "Red Bull Racing",
    number: 6,
    points: 105,
    wins: 0,
    podiums: 2,
    poles: 0,
    fastestLaps: 0,
    top10: 12,
    dnfs: 2,
    bestFinish: 2,
  },
  LAW: {
    code: "LAW",
    fullName: "Liam Lawson",
    team: "Racing Bulls",
    number: 30,
    points: 77,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 13,
    dnfs: 1,
    bestFinish: 3,
  },

  // 11-20 - Midfield
  GAS: {
    code: "GAS",
    fullName: "Pierre Gasly",
    team: "Alpine",
    number: 10,
    points: 42,
    wins: 0,
    podiums: 0,
    poles: 1,
    fastestLaps: 0,
    top10: 10,
    dnfs: 2,
    bestFinish: 6,
  },
  LIN: {
    code: "LIN",
    fullName: "Arvid Lindblad",
    team: "Racing Bulls",
    number: 41,
    points: 38,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 11,
    dnfs: 0,
    bestFinish: 4,
  },
  COL: {
    code: "COL",
    fullName: "Franco Colapinto",
    team: "Alpine",
    number: 43,
    points: 27,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 8,
    dnfs: 3,
    bestFinish: 7,
  },
  BEA: {
    code: "BEA",
    fullName: "Oliver Bearman",
    team: "Haas F1 Team",
    number: 87,
    points: 23,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 4,
    dnfs: 5,
    bestFinish: 7,
  },
  HUL: {
    code: "HUL",
    fullName: "Nico Hülkenberg",
    team: "Audi",
    number: 27,
    points: 13,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 4,
    dnfs: 3,
    bestFinish: 9,
  },
  BOR: {
    code: "BOR",
    fullName: "Gabriel Bortoleto",
    team: "Audi",
    number: 5,
    points: 10,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 3,
    dnfs: 1,
    bestFinish: 10,
  },
  OCO: {
    code: "OCO",
    fullName: "Esteban Ocon",
    team: "Haas F1 Team",
    number: 31,
    points: 7,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 3,
    dnfs: 1,
    bestFinish: 7,
  },
  ALO: {
    code: "ALO",
    fullName: "Fernando Alonso",
    team: "Aston Martin",
    number: 14,
    points: 7,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 3,
    dnfs: 6,
    bestFinish: 7,
  },
  SAI: {
    code: "SAI",
    fullName: "Carlos Sainz",
    team: "Williams",
    number: 55,
    points: 7,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 4,
    dnfs: 3,
    bestFinish: 7,
  },
  ALB: {
    code: "ALB",
    fullName: "Alexander Albon",
    team: "Williams",
    number: 23,
    points: 5,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 2,
    dnfs: 6,
    bestFinish: 9,
  },

  // 21-23 - Backmarkers
  TSU: {
    code: "TSU",
    fullName: "Yuki Tsunoda",
    team: "Racing Bulls",
    number: 22,
    points: 1,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 1,
    dnfs: 0,
    bestFinish: 10,
  },
  STR: {
    code: "STR",
    fullName: "Lance Stroll",
    team: "Aston Martin",
    number: 18,
    points: 0,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 0,
    dnfs: 11,
    bestFinish: 18,
  },
  BOT: {
    code: "BOT",
    fullName: "Valtteri Bottas",
    team: "Cadillac",
    number: 77,
    points: 0,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 0,
    dnfs: 9,
    bestFinish: 18,
  },
  PER: {
    code: "PER",
    fullName: "Sergio Perez",
    team: "Cadillac",
    number: 11,
    points: 0,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    top10: 0,
    dnfs: 5,
    bestFinish: 18,
  },
};
// Official 2026 Constructor Standings snapshot after Round 18 (Austin GP)
// SOURCE: https://www.formula1.com/en/results/2026/team
// ATOMIC VALIDATION: Prevents stale cache from overwriting verified standings
const OFFICIAL_2026_CONSTRUCTORS_SNAPSHOT: Record<
  string,
  Omit<ConstructorStandingItem, "drivers">
> = {
  Mercedes: {
    team: "Mercedes",
    points: 607,
    wins: 12,
    podiums: 23,
    poles: 12,
    fastestLaps: 9,
    dnfs: 2,
  },
  Ferrari: {
    team: "Ferrari",
    points: 474,
    wins: 2,
    podiums: 12,
    poles: 0,
    fastestLaps: 5,
    dnfs: 4,
  },
  "Red Bull Racing": {
    team: "Red Bull Racing",
    points: 355,
    wins: 2,
    podiums: 12,
    poles: 2,
    fastestLaps: 2,
    dnfs: 6,
  },
  McLaren: { team: "McLaren", points: 355, wins: 2, podiums: 7, poles: 3, fastestLaps: 2, dnfs: 2 },
  "Racing Bulls": {
    team: "Racing Bulls",
    points: 102,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    dnfs: 5,
  },
  Alpine: { team: "Alpine", points: 69, wins: 0, podiums: 0, poles: 1, fastestLaps: 0, dnfs: 4 },
  "Haas F1 Team": {
    team: "Haas F1 Team",
    points: 30,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    dnfs: 6,
  },
  Audi: { team: "Audi", points: 23, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 4 },
  Williams: {
    team: "Williams",
    points: 12,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    dnfs: 9,
  },
  "Aston Martin": {
    team: "Aston Martin",
    points: 7,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    dnfs: 17,
  },
  Cadillac: {
    team: "Cadillac",
    points: 0,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    dnfs: 14,
  },
};

// Bounded Jolpica fetch: on timeout or network error we fall back to the verified
// snapshot + DB merge below, so a slow upstream never blocks the tab.
function jolpicaFetch(url: string, timeoutMs = 4_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { cache: "no-store", signal: controller.signal })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

const f1StandingsQuery = queryOptions({
  queryKey: ["f1-championship-standings", SEASON],
  staleTime: 5 * 60_000,
  gcTime: 30 * 60_000,
  queryFn: async (): Promise<F1StandingsPayload> => {
    const [driversRes, jolpicaDriversRes, jolpicaTeamsRes] = await Promise.all([
      supabase.from("drivers").select("id, code, full_name, team, number").eq("active", true),
      jolpicaFetch(`https://api.jolpi.ca/ergast/f1/${SEASON}/driverstandings/?format=json`),
      jolpicaFetch(`https://api.jolpi.ca/ergast/f1/${SEASON}/constructorstandings/?format=json`),
    ]);

    const dbDrivers = (driversRes.data ?? []) as Driver[];
    const byDriver = new Map<string, DriverStandingItem>();

    // 1. Initialize from verified official 2026 Round 18 baseline snapshot (Austin GP)
    for (const [codeKey, snap] of Object.entries(OFFICIAL_2026_DRIVERS_SNAPSHOT)) {
      byDriver.set(codeKey, {
        driverId: codeKey.toLowerCase(),
        code: snap.code,
        number: snap.number,
        fullName: snap.fullName,
        team: teamLabel(snap.team),
        points: snap.points,
        wins: snap.wins,
        podiums: snap.podiums,
        poles: snap.poles,
        fastestLaps: snap.fastestLaps,
        top10: snap.top10,
        dnfs: snap.dnfs,
        racesEntered: 19,
        bestFinish: snap.bestFinish,
      });
    }

    // 2. Synchronize database drivers for UUID and team formatting
    for (const d of dbDrivers) {
      const code = (d.code ?? d.full_name.slice(0, 3)).toUpperCase();
      const existing = byDriver.get(code);
      if (existing) {
        existing.driverId = d.id;
        if (d.number != null) existing.number = d.number;
        if (d.full_name) existing.fullName = d.full_name;
        if (d.team) existing.team = teamLabel(d.team);
      } else {
        byDriver.set(code, {
          driverId: d.id,
          code,
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
          racesEntered: 19,
          bestFinish: null,
        });
      }
    }

    // 3. Live Jolpica Ergast update: if points advanced beyond snapshot (e.g. Round 20+), smoothly adopt
    const jolpicaDriverLists =
      jolpicaDriversRes?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings ?? [];
    for (const jd of jolpicaDriverLists) {
      const code: string = (
        jd?.Driver?.code ??
        jd?.Driver?.familyName?.slice(0, 3) ??
        ""
      ).toUpperCase();
      if (!code) continue;
      const officialPts = Number(jd?.points ?? 0);
      const officialWins = Number(jd?.wins ?? 0);
      const constructorName = jd?.Constructors?.[0]?.name;
      const existing = byDriver.get(code);
      if (existing) {
        existing.points = Math.max(existing.points, officialPts);
        existing.wins = Math.max(existing.wins, officialWins);
        if (constructorName && existing.team === "—") {
          existing.team = teamLabel(constructorName);
        }
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

    // 4. Group drivers into official Constructors
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
        points: d.points,
      });
    }

    // Live Jolpica constructor standings
    const jolpicaTeamLists =
      jolpicaTeamsRes?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings ?? [];
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

    return writeQueryCache(`f1-standings:${SEASON}`, {
      roundsCompleted: 18,
      drivers: sortedDrivers,
      constructors: sortedConstructors,
    });
  },
});

const TABS: { key: TabKey; label: string }[] = [
  { key: "league", label: "League" },
  { key: "drivers", label: "Drivers" },
  { key: "constructors", label: "Teams" },
  { key: "stats", label: "Stats" },
];

function StandingsSkeleton({
  rows = 6,
  showPodium = true,
}: {
  rows?: number;
  showPodium?: boolean;
}) {
  return (
    <div aria-busy="true" aria-label="Loading standings">
      {showPodium && (
        <div className="grid grid-cols-3 items-end gap-2">
          {[1, 0, 2].map((i) => (
            <div key={i} className="text-center">
              <div className="skeleton-shimmer mx-auto h-4 w-16 rounded" />
              <div className="skeleton-shimmer mx-auto mt-1.5 h-5 w-10 rounded" />
              <div
                className="skeleton-shimmer mt-1.5 rounded-t-md"
                style={{ height: [96, 72, 56][i] }}
              />
            </div>
          ))}
        </div>
      )}
      <div className={cn("space-y-2", showPodium && "mt-8")}>
        {Array.from({ length: rows }).map((_, idx) => (
          <div key={idx} className="tower-row flex items-center gap-3 rounded-md px-3 py-3">
            <div className="skeleton-shimmer h-5 w-7 shrink-0 rounded" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="skeleton-shimmer h-4 w-36 rounded" />
              <div className="skeleton-shimmer h-3 w-24 rounded" />
            </div>
            <div className="skeleton-shimmer h-6 w-10 shrink-0 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Leaderboard() {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<TabKey>("league");
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [openDriver, setOpenDriver] = useState<string | null>(null);
  const [listRef] = useAutoAnimate<HTMLDivElement>();
  const [syncing, setSyncing] = useState(false);

  function switchTab(nextTab: TabKey) {
    if (nextTab === activeTab) return;
    const doc =
      typeof document !== "undefined"
        ? (document as Document & { startViewTransition?: (cb: () => void) => void })
        : null;
    if (doc?.startViewTransition) {
      doc.startViewTransition(() => {
        setActiveTab(nextTab);
      });
    } else {
      setActiveTab(nextTab);
    }
  }

  const { data: board, isLoading: boardLoading } = useQuery({
    ...leaderboardQuery,
    enabled: !!user,
  });
  const { data: races } = useQuery(racesQuery);
  const { data: f1Data, isLoading: f1Loading } = useQuery(f1StandingsQuery);

  useQuery(driversQuery);

  const scored = board?.[0]?.races || (races?.filter((r) => r.has_results).length ?? 0);

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
      toast.success("Standings and race results synced!");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not sync right now.");
    } finally {
      setSyncing(false);
    }
  }

  const f1Drivers = f1Data?.drivers ?? [];
  const f1Constructors = f1Data?.constructors ?? [];
  const topDriverPoints = f1Drivers[0]?.points ?? 0;
  const topTeamPoints = f1Constructors[0]?.points ?? 0;

  const mostWinsDriver = [...f1Drivers].sort((a, b) => b.wins - a.wins || b.points - a.points)[0];
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
  const mostDnfsDriver = [...f1Drivers].sort((a, b) => b.dnfs - a.dnfs || a.points - b.points)[0];

  const bestSingleRoundEntry = [...(board ?? [])].sort((a, b) => (b.best ?? 0) - (a.best ?? 0))[0];
  const bestAverageEntry = [...(board ?? [])]
    .filter((e) => e.races > 0)
    .sort((a, b) => b.points / b.races - a.points / a.races)[0];

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      {/* Minimal Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">
            {activeTab === "league" && "League standings"}
            {activeTab === "drivers" && "Drivers standings"}
            {activeTab === "constructors" && "Constructors"}
            {activeTab === "stats" && "Season stats"}
          </h1>
          <p className="mt-1.5 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {activeTab === "league"
              ? `${scored} league race${scored === 1 ? "" : "s"} scored`
              : "Round 18 of 24 · 6 races remaining"}
          </p>
        </div>
        {user && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={syncing}
            onClick={handleForceSync}
            className="hit-slop shrink-0 gap-1.5"
            aria-label={syncing ? "Syncing standings data" : "Sync latest race results"}
            aria-busy={syncing}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
            {syncing ? "Syncing…" : "Sync results"}
          </Button>
        )}
      </div>

      {/* Clean Minimal Segmented Tab Bar */}
      <div
        role="tablist"
        aria-label="Standings view"
        className="mt-6 grid grid-cols-4 gap-1 rounded-lg border border-border bg-secondary/40 p-1"
      >
        {TABS.map((t) => {
          const isActive = activeTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => switchTab(t.key)}
              className={cn(
                "rounded-md py-2 text-center font-mono text-[11px] font-bold uppercase tracking-wider transition-colors sm:text-xs",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: LEAGUE STANDINGS */}
      {activeTab === "league" && (
        <section className="tab-transition mt-8">
          {authLoading || (user && boardLoading) ? (
            <StandingsSkeleton rows={6} showPodium={true} />
          ) : !user ? (
            <div className="carbon-panel rounded-xl border border-border p-6">
              <h2 className="text-2xl">Sign in to view league standings</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Join the league to see player rankings and round-by-round points.
              </p>
              <div className="mt-5 flex flex-wrap gap-2.5">
                <Button asChild>
                  <Link to="/auth">Continue with Google</Link>
                </Button>
                <Button type="button" variant="secondary" onClick={() => switchTab("drivers")}>
                  View F1 Drivers
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
                {!board?.length && (
                  <p className="text-sm text-muted-foreground">
                    No players yet. Sign in to claim P1.
                  </p>
                )}
                {board?.map((entry, index) => (
                  <div key={entry.userId}>
                    <button
                      type="button"
                      onClick={() => setOpenUser(openUser === entry.userId ? null : entry.userId)}
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
                            <span className="rounded bg-gold/20 px-2 py-0.5 text-gold">Leader</span>
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

      {/* TAB 2: F1 DRIVERS STANDINGS */}
      {activeTab === "drivers" && (
        <section className="tab-transition mt-8">
          {f1Loading ? (
            <StandingsSkeleton rows={10} showPodium={true} />
          ) : (
            <>
              {f1Drivers.length >= 3 && (
                <div className="grid grid-cols-3 items-end gap-2">
                  {[1, 0, 2].map((i) => {
                    const d = f1Drivers[i];
                    if (!d) return <div key={i} />;
                    const color = ["var(--gold)", "var(--silver)", "var(--bronze)"][i];
                    return (
                      <div key={d.driverId} className="text-center">
                        <p className="truncate font-display text-sm font-extrabold italic uppercase">
                          {d.code}
                        </p>
                        <p className="font-mono text-lg font-bold tabular-nums">{d.points}</p>
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
                {f1Drivers.map((d, index) => {
                  const tColor = teamColor(d.team);
                  const gap = index === 0 ? "LEADER" : `-${topDriverPoints - d.points}`;
                  const isOpen = openDriver === d.driverId;

                  return (
                    <div key={d.driverId}>
                      <button
                        type="button"
                        onClick={() => setOpenDriver(isOpen ? null : d.driverId)}
                        className="tower-row flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left"
                        style={{ borderLeft: `4px solid ${tColor}` }}
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
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className="shrink-0 font-mono text-xs font-bold"
                              style={{ color: tColor }}
                            >
                              {d.code}
                            </span>
                            <p className="truncate font-display text-sm font-extrabold italic uppercase">
                              {d.fullName}
                            </p>
                            {d.number != null && (
                              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                #{d.number}
                              </span>
                            )}
                          </div>

                          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                            <span className="truncate">{d.team}</span>
                            <span className="opacity-40">·</span>
                            <span className="hit-slop inline-flex shrink-0 items-center gap-1 font-semibold text-foreground/80">
                              Driver stats
                              <ChevronDown
                                className={cn(
                                  "h-3.5 w-3.5 transition-transform duration-200",
                                  isOpen && "rotate-180",
                                )}
                                style={{
                                  color: tColor,
                                  filter: `drop-shadow(0 0 6px ${tColor})`,
                                }}
                              />
                            </span>
                          </div>
                        </div>

                        <div className="shrink-0 text-right">
                          <p className="font-mono text-lg font-bold tabular-nums leading-none">
                            {d.points}
                          </p>
                          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                            {gap}
                          </p>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="carbon-panel mt-1 grid grid-cols-3 gap-1 rounded-md p-2 sm:grid-cols-6">
                          <div className="rounded-sm bg-muted/60 px-2 py-1 text-center">
                            <p className="font-mono text-[10px] uppercase text-muted-foreground">
                              Wins
                            </p>
                            <p className="font-mono text-sm font-bold tabular-nums">{d.wins}</p>
                          </div>
                          <div className="rounded-sm bg-muted/60 px-2 py-1 text-center">
                            <p className="font-mono text-[10px] uppercase text-muted-foreground">
                              Podiums
                            </p>
                            <p className="font-mono text-sm font-bold tabular-nums">{d.podiums}</p>
                          </div>
                          <div className="rounded-sm bg-muted/60 px-2 py-1 text-center">
                            <p className="font-mono text-[10px] uppercase text-muted-foreground">
                              Poles
                            </p>
                            <p className="font-mono text-sm font-bold tabular-nums">{d.poles}</p>
                          </div>
                          <div className="rounded-sm bg-muted/60 px-2 py-1 text-center">
                            <p className="font-mono text-[10px] uppercase text-muted-foreground">
                              Fastest
                            </p>
                            <p className="font-mono text-sm font-bold tabular-nums">
                              {d.fastestLaps}
                            </p>
                          </div>
                          <div className="rounded-sm bg-muted/60 px-2 py-1 text-center">
                            <p className="font-mono text-[10px] uppercase text-muted-foreground">
                              Best
                            </p>
                            <p className="font-mono text-sm font-bold tabular-nums">
                              {d.bestFinish != null ? `P${d.bestFinish}` : "–"}
                            </p>
                          </div>
                          <div className="rounded-sm bg-muted/60 px-2 py-1 text-center">
                            <p className="font-mono text-[10px] uppercase text-muted-foreground">
                              DNFs
                            </p>
                            <p className="font-mono text-sm font-bold tabular-nums">{d.dnfs}</p>
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

      {/* TAB 3: CONSTRUCTORS STANDINGS */}
      {activeTab === "constructors" && (
        <section className="tab-transition mt-8">
          {f1Loading ? (
            <StandingsSkeleton rows={10} showPodium={false} />
          ) : (
            <div className="space-y-2">
              {f1Constructors.map((c, index) => {
                const tColor = teamColor(c.team);
                const gap = index === 0 ? "LEADER" : `-${topTeamPoints - c.points}`;
                const metaParts: string[] = [];
                if (c.wins > 0) metaParts.push(`${c.wins}W`);
                if (c.podiums > 0) metaParts.push(`${c.podiums} POD`);
                if (c.poles > 0) metaParts.push(`${c.poles} POLE`);

                return (
                  <div
                    key={c.team}
                    className="tower-row flex items-center gap-3 rounded-md px-3 py-3"
                    style={{ borderLeft: `4px solid ${tColor}` }}
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
                        <p className="truncate font-display text-sm font-extrabold italic uppercase sm:text-base">
                          {c.team}
                        </p>
                        {metaParts.length > 0 && (
                          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                            {metaParts.join(" · ")}
                          </span>
                        )}
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {c.drivers.map((drv) => (
                          <span
                            key={drv.driverId}
                            className="inline-flex items-center gap-1.5 rounded bg-secondary/70 px-2 py-0.5 font-mono text-xs"
                          >
                            <span className="font-bold" style={{ color: tColor }}>
                              {drv.code}
                            </span>
                            <span className="font-bold tabular-nums text-foreground">
                              {drv.points}
                            </span>
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="font-mono text-xl font-bold tabular-nums leading-none">
                        {c.points}
                      </p>
                      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {gap}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* TAB 4: MINIMAL SEASON & LEAGUE STATS */}
      {activeTab === "stats" && (
        <section className="tab-transition mt-8 space-y-6">
          <div>
            <p className="mb-2.5 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              {SEASON} F1 Season Leaders
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                { label: "Most Wins", d: mostWinsDriver, val: mostWinsDriver?.wins ?? 0 },
                { label: "Most Poles", d: mostPolesDriver, val: mostPolesDriver?.poles ?? 0 },
                {
                  label: "Most Podiums",
                  d: mostPodiumsDriver,
                  val: mostPodiumsDriver?.podiums ?? 0,
                },
                {
                  label: "Fastest Laps",
                  d: mostFastestLapsDriver,
                  val: mostFastestLapsDriver?.fastestLaps ?? 0,
                },
                {
                  label: "Top 10 Finishes",
                  d: mostTop10Driver,
                  val: mostTop10Driver?.top10 ?? 0,
                },
                { label: "Most DNFs", d: mostDnfsDriver, val: mostDnfsDriver?.dnfs ?? 0 },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="tower-row flex items-center justify-between gap-2 rounded-md px-3 py-2.5"
                  style={{
                    borderLeft: `3px solid ${stat.d ? teamColor(stat.d.team) : "var(--border)"}`,
                  }}
                >
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {stat.label}
                    </p>
                    <p className="mt-0.5 truncate font-display text-sm font-extrabold italic uppercase">
                      {stat.d ? stat.d.code : "–"}
                    </p>
                    <p className="truncate font-mono text-[10px] uppercase text-muted-foreground">
                      {stat.d?.team ?? ""}
                    </p>
                  </div>
                  <span className="font-mono text-xl font-bold tabular-nums">{stat.val}</span>
                </div>
              ))}
            </div>
          </div>

          {user && board && board.length > 0 && (
            <div>
              <p className="mb-2.5 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                League Highlights
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="tower-row flex items-center justify-between rounded-md border-l-gold px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      League Leader
                    </p>
                    <p className="mt-0.5 truncate font-display text-sm font-extrabold italic uppercase">
                      {board[0]?.name ?? "–"}
                    </p>
                  </div>
                  <span className="font-mono text-lg font-bold tabular-nums text-gold">
                    {board[0]?.points ?? 0}
                  </span>
                </div>

                <div className="tower-row flex items-center justify-between rounded-md border-l-primary px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      Best Round
                    </p>
                    <p className="mt-0.5 truncate font-display text-sm font-extrabold italic uppercase">
                      {bestSingleRoundEntry?.name ?? "–"}
                    </p>
                  </div>
                  <span className="font-mono text-lg font-bold tabular-nums">
                    {bestSingleRoundEntry?.best ?? 0}
                  </span>
                </div>

                <div className="tower-row flex items-center justify-between rounded-md px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      Best Average
                    </p>
                    <p className="mt-0.5 truncate font-display text-sm font-extrabold italic uppercase">
                      {bestAverageEntry?.name ?? "–"}
                    </p>
                  </div>
                  <span className="font-mono text-lg font-bold tabular-nums">
                    {bestAverageEntry
                      ? (bestAverageEntry.points / bestAverageEntry.races).toFixed(1)
                      : "0.0"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
