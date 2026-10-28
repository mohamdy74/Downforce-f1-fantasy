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
      { title: "Standings \u2014 DOWNFORCE" },
      {
        name: "description",
        content:
          "Live DOWNFORCE prediction league standings, official F1 Drivers & Constructors rankings, and season stats.",
      },
      { property: "og:title", content: "Standings \u2014 DOWNFORCE" },
      {
        property: "og:description",
        content:
          "See who is leading the DOWNFORCE league and the official 2026 F1 Championship.",
      },
      { name: "twitter:title", content: "Standings \u2014 DOWNFORCE" },
      {
        name: "twitter:description",
        content:
          "See who is leading the DOWNFORCE league and the official 2026 F1 Championship.",
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
  officialRank: number;
};

type ConstructorStandingItem = {
  team: string;
  points: number;
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  dnfs: number;
  officialRank: number;
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

// Verified official 2026 FIA Formula 1 World Drivers' Championship standings after the United States GP (5 races remaining)
const OFFICIAL_2026_DRIVERS_SNAPSHOT: Record<
  string,
  {
    officialRank: number;
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
  ANT: { officialRank: 1, code: "ANT", fullName: "Andrea Kimi Antonelli", team: "Mercedes", number: 12, points: 365, wins: 9, podiums: 15, poles: 7, fastestLaps: 7, top10: 16, dnfs: 1, bestFinish: 1 },
  RUS: { officialRank: 2, code: "RUS", fullName: "George Russell", team: "Mercedes", number: 63, points: 242, wins: 3, podiums: 8, poles: 5, fastestLaps: 2, top10: 14, dnfs: 3, bestFinish: 1 },
  HAM: { officialRank: 3, code: "HAM", fullName: "Lewis Hamilton", team: "Ferrari", number: 44, points: 241, wins: 1, podiums: 6, poles: 0, fastestLaps: 1, top10: 17, dnfs: 1, bestFinish: 1 },
  VER: { officialRank: 4, code: "VER", fullName: "Max Verstappen", team: "Red Bull Racing", number: 3, points: 236, wins: 2, podiums: 10, poles: 2, fastestLaps: 2, top10: 14, dnfs: 4, bestFinish: 1 },
  LEC: { officialRank: 5, code: "LEC", fullName: "Charles Leclerc", team: "Ferrari", number: 16, points: 233, wins: 1, podiums: 6, poles: 0, fastestLaps: 4, top10: 15, dnfs: 3, bestFinish: 1 },
  NOR: { officialRank: 6, code: "NOR", fullName: "Lando Norris", team: "McLaren", number: 1, points: 211, wins: 2, podiums: 5, poles: 3, fastestLaps: 2, top10: 14, dnfs: 3, bestFinish: 1 },
  PIA: { officialRank: 7, code: "PIA", fullName: "Oscar Piastri", team: "McLaren", number: 81, points: 144, wins: 0, podiums: 2, poles: 0, fastestLaps: 0, top10: 12, dnfs: 1, bestFinish: 2 },
  HAD: { officialRank: 8, code: "HAD", fullName: "Isack Hadjar", team: "Red Bull Racing", number: 6, points: 105, wins: 0, podiums: 2, poles: 0, fastestLaps: 0, top10: 12, dnfs: 2, bestFinish: 3 },
  LAW: { officialRank: 9, code: "LAW", fullName: "Liam Lawson", team: "Racing Bulls", number: 30, points: 77, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 13, dnfs: 1, bestFinish: 5 },
  GAS: { officialRank: 10, code: "GAS", fullName: "Pierre Gasly", team: "Alpine", number: 10, points: 42, wins: 0, podiums: 0, poles: 1, fastestLaps: 0, top10: 10, dnfs: 2, bestFinish: 6 },
  LIN: { officialRank: 11, code: "LIN", fullName: "Arvid Lindblad", team: "Racing Bulls", number: 41, points: 38, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 11, dnfs: 0, bestFinish: 6 },
  COL: { officialRank: 12, code: "COL", fullName: "Franco Colapinto", team: "Alpine", number: 43, points: 27, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 8, dnfs: 3, bestFinish: 6 },
  BEA: { officialRank: 13, code: "BEA", fullName: "Oliver Bearman", team: "Haas", number: 87, points: 23, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 4, dnfs: 5, bestFinish: 5 },
  HUL: { officialRank: 14, code: "HUL", fullName: "Nico H\u00fclkenberg", team: "Audi Revolut", number: 27, points: 13, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 4, dnfs: 3, bestFinish: 8 },
  BOR: { officialRank: 15, code: "BOR", fullName: "Gabriel Bortoleto", team: "Audi Revolut", number: 5, points: 10, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 3, dnfs: 1, bestFinish: 8 },
  OCO: { officialRank: 16, code: "OCO", fullName: "Esteban Ocon", team: "Haas", number: 31, points: 7, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 3, dnfs: 1, bestFinish: 8 },
  ALO: { officialRank: 17, code: "ALO", fullName: "Fernando Alonso", team: "Aston Martin", number: 14, points: 7, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 3, dnfs: 6, bestFinish: 8 },
  SAI: { officialRank: 18, code: "SAI", fullName: "Carlos Sainz", team: "Williams", number: 55, points: 7, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 4, dnfs: 3, bestFinish: 9 },
  ALB: { officialRank: 19, code: "ALB", fullName: "Alexander Albon", team: "Williams", number: 23, points: 5, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 2, dnfs: 7, bestFinish: 8 },
  STR: { officialRank: 20, code: "STR", fullName: "Lance Stroll", team: "Aston Martin", number: 18, points: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 0, dnfs: 12, bestFinish: 12 },
  BOT: { officialRank: 21, code: "BOT", fullName: "Valtteri Bottas", team: "Cadillac", number: 77, points: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 0, dnfs: 9, bestFinish: 13 },
  PER: { officialRank: 22, code: "PER", fullName: "Sergio Perez", team: "Cadillac", number: 11, points: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, top10: 0, dnfs: 5, bestFinish: 14 },
};

// Verified official 2026 FIA Formula 1 World Constructors' Championship standings after the United States GP
// Accounts for mid-season driver substitutions (Lawson 14 pts at Red Bull in R12-R14; Tsunoda 1 pt at Racing Bulls)
const OFFICIAL_2026_CONSTRUCTORS_SNAPSHOT: Record<
  string,
  {
    officialRank: number;
    points: number;
    wins: number;
    podiums: number;
    poles: number;
    fastestLaps: number;
    dnfs: number;
  }
> = {
  Mercedes: { officialRank: 1, points: 607, wins: 12, podiums: 23, poles: 12, fastestLaps: 9, dnfs: 4 },
  Ferrari: { officialRank: 2, points: 474, wins: 2, podiums: 12, poles: 0, fastestLaps: 5, dnfs: 4 },
  "Red Bull": { officialRank: 3, points: 355, wins: 2, podiums: 12, poles: 2, fastestLaps: 2, dnfs: 6 },
  McLaren: { officialRank: 4, points: 355, wins: 2, podiums: 7, poles: 3, fastestLaps: 2, dnfs: 4 },
  "Racing Bulls": { officialRank: 5, points: 102, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 1 },
  Alpine: { officialRank: 6, points: 69, wins: 0, podiums: 0, poles: 1, fastestLaps: 0, dnfs: 5 },
  Haas: { officialRank: 7, points: 30, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 6 },
  Audi: { officialRank: 8, points: 23, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 4 },
  Williams: { officialRank: 9, points: 12, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 10 },
  "Aston Martin": { officialRank: 10, points: 7, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 18 },
  Cadillac: { officialRank: 11, points: 0, wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 14 },
};

const TOTAL_2026_F1_ROUNDS = 23;
const SNAPSHOT_COMPLETED_ROUNDS = 18;

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 3500): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildBaselineF1Standings(): F1StandingsPayload {
  const drivers: DriverStandingItem[] = Object.entries(OFFICIAL_2026_DRIVERS_SNAPSHOT)
    .map(([codeKey, snap]) => ({
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
      racesEntered: SNAPSHOT_COMPLETED_ROUNDS,
      bestFinish: snap.bestFinish,
      officialRank: snap.officialRank,
    }))
    .sort((a, b) => a.officialRank - b.officialRank);

  const byTeam = new Map<string, ConstructorStandingItem>();
  for (const [teamKey, cSnap] of Object.entries(OFFICIAL_2026_CONSTRUCTORS_SNAPSHOT)) {
    byTeam.set(teamKey, {
      team: teamKey,
      points: cSnap.points,
      wins: cSnap.wins,
      podiums: cSnap.podiums,
      poles: cSnap.poles,
      fastestLaps: cSnap.fastestLaps,
      dnfs: cSnap.dnfs,
      officialRank: cSnap.officialRank,
      drivers: [],
    });
  }
  for (const d of drivers) {
    const t = byTeam.get(d.team);
    if (t) {
      t.drivers.push({
        driverId: d.driverId,
        code: d.code,
        number: d.number,
        points: d.points,
      });
    }
  }
  const constructors = [...byTeam.values()].sort((a, b) => a.officialRank - b.officialRank);

  return {
    roundsCompleted: SNAPSHOT_COMPLETED_ROUNDS,
    drivers,
    constructors,
  };
}

const INITIAL_F1_STANDINGS_PAYLOAD = buildBaselineF1Standings();

type JolpicaStandingsResponse = {
  MRData?: {
    StandingsTable?: {
      StandingsLists?: Array<{
        round?: string;
        DriverStandings?: Array<{
          points?: string;
          wins?: string;
          Driver?: {
            driverId?: string;
            code?: string;
            familyName?: string;
          };
          Constructors?: Array<{ name?: string }>;
        }>;
        ConstructorStandings?: Array<{
          points?: string;
          wins?: string;
          Constructor?: { name?: string };
        }>;
      }>;
    };
  };
};

const f1StandingsQuery = queryOptions({
  queryKey: ["f1-championship-standings", SEASON],
  staleTime: 5 * 60_000,
  gcTime: 30 * 60_000,
  initialData: INITIAL_F1_STANDINGS_PAYLOAD,
  queryFn: async (): Promise<F1StandingsPayload> => {
    const [driversRes, jolpicaDriversRes, jolpicaTeamsRes] = await Promise.all([
      supabase
        .from("drivers")
        .select("id, code, full_name, team, number")
        .eq("active", true),
      fetchJsonWithTimeout<JolpicaStandingsResponse>(
        `https://api.jolpi.ca/ergast/f1/${SEASON}/driverstandings/?format=json&_t=${Date.now()}`,
        3500,
      ),
      fetchJsonWithTimeout<JolpicaStandingsResponse>(
        `https://api.jolpi.ca/ergast/f1/${SEASON}/constructorstandings/?format=json&_t=${Date.now()}`,
        3500,
      ),
    ]);

    const dbDrivers = (driversRes.data ?? []) as Driver[];
    const byDriver = new Map<string, DriverStandingItem>();

    // 1. Initialize from verified official 2026 United States GP (Round 18) snapshot
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
        racesEntered: SNAPSHOT_COMPLETED_ROUNDS,
        bestFinish: snap.bestFinish,
        officialRank: snap.officialRank,
      });
    }

    // 2. Attach canonical database driverId without overwriting verified snapshot fields or injecting duplicates
    for (const d of dbDrivers) {
      const code = d.code?.trim().toUpperCase();
      if (!code) continue;
      const existing = byDriver.get(code);
      if (existing) {
        existing.driverId = d.id;
      }
    }

    // 3. Atomic 3-Condition Gate for future rounds (only applies when Round 19+ is officially published)
    const driverStandingsList =
      jolpicaDriversRes?.MRData?.StandingsTable?.StandingsLists?.[0];
    const jolpicaDriverRound = Number(driverStandingsList?.round ?? 0);
    const jolpicaDriverLists = driverStandingsList?.DriverStandings ?? [];
    const jolpicaLeaderPts = Math.max(
      0,
      ...jolpicaDriverLists.map((jd) => Number(jd?.points ?? 0)),
    );

    let effectiveRounds = SNAPSHOT_COMPLETED_ROUNDS;

    if (
      jolpicaDriverRound > SNAPSHOT_COMPLETED_ROUNDS &&
      jolpicaDriverRound <= TOTAL_2026_F1_ROUNDS &&
      jolpicaDriverLists.length >= 20 &&
      jolpicaLeaderPts >= 365
    ) {
      effectiveRounds = jolpicaDriverRound;
      const maxPossibleGain = (jolpicaDriverRound - SNAPSHOT_COMPLETED_ROUNDS) * 34;

      for (const jd of jolpicaDriverLists) {
        const code = (jd?.Driver?.code ?? "").trim().toUpperCase();
        if (!code) continue;
        const existing = byDriver.get(code);
        const snap = OFFICIAL_2026_DRIVERS_SNAPSHOT[code];
        if (!existing || !snap) continue;

        const officialPts = Number(jd?.points ?? 0);
        const officialWins = Number(jd?.wins ?? 0);
        const ptsDelta = officialPts - snap.points;
        const winsDelta = officialWins - snap.wins;

        if (ptsDelta >= 0 && ptsDelta <= maxPossibleGain) {
          existing.points = officialPts;
        }
        if (winsDelta >= 0 && winsDelta <= jolpicaDriverRound - SNAPSHOT_COMPLETED_ROUNDS) {
          existing.wins = officialWins;
          if (winsDelta > 0) {
            existing.podiums = Math.max(existing.podiums, snap.podiums + winsDelta);
          }
        }
        existing.racesEntered = jolpicaDriverRound;
      }
    }

    const sortedDrivers = [...byDriver.values()].sort(
      (a, b) =>
        b.points - a.points ||
        b.wins - a.wins ||
        b.podiums - a.podiums ||
        (a.bestFinish ?? 99) - (b.bestFinish ?? 99) ||
        a.officialRank - b.officialRank ||
        teamRank(a.team) - teamRank(b.team) ||
        (a.number ?? 999) - (b.number ?? 999),
    );

    // 4. Build official Constructors from snapshot + attach current roster drivers
    const byTeam = new Map<string, ConstructorStandingItem>();
    for (const [teamKey, cSnap] of Object.entries(OFFICIAL_2026_CONSTRUCTORS_SNAPSHOT)) {
      byTeam.set(teamKey, {
        team: teamKey,
        points: cSnap.points,
        wins: cSnap.wins,
        podiums: cSnap.podiums,
        poles: cSnap.poles,
        fastestLaps: cSnap.fastestLaps,
        dnfs: cSnap.dnfs,
        officialRank: cSnap.officialRank,
        drivers: [],
      });
    }

    for (const d of sortedDrivers) {
      if (!d.team || d.team === "\u2014") continue;
      const t = byTeam.get(d.team);
      if (!t) continue;

      const snapDriverPts = OFFICIAL_2026_DRIVERS_SNAPSHOT[d.code]?.points ?? 0;
      const snapDriverWins = OFFICIAL_2026_DRIVERS_SNAPSHOT[d.code]?.wins ?? 0;
      if (d.points > snapDriverPts) {
        t.points += d.points - snapDriverPts;
      }
      if (d.wins > snapDriverWins) {
        t.wins += d.wins - snapDriverWins;
      }
      t.drivers.push({
        driverId: d.driverId,
        code: d.code,
        number: d.number,
        points: d.points,
      });
    }

    // 5. Atomic 3-Condition Gate for future constructor rounds (Round 19+)
    const teamStandingsList =
      jolpicaTeamsRes?.MRData?.StandingsTable?.StandingsLists?.[0];
    const jolpicaTeamRound = Number(teamStandingsList?.round ?? 0);
    const jolpicaTeamLists = teamStandingsList?.ConstructorStandings ?? [];
    const jolpicaTopTeamPts = Math.max(
      0,
      ...jolpicaTeamLists.map((jt) => Number(jt?.points ?? 0)),
    );

    if (
      jolpicaTeamRound > SNAPSHOT_COMPLETED_ROUNDS &&
      jolpicaTeamRound <= TOTAL_2026_F1_ROUNDS &&
      jolpicaTeamLists.length >= 10 &&
      jolpicaTopTeamPts >= 607
    ) {
      const maxTeamGain = (jolpicaTeamRound - SNAPSHOT_COMPLETED_ROUNDS) * 60;
      for (const jt of jolpicaTeamLists) {
        const cName = teamLabel(jt?.Constructor?.name);
        if (!cName || cName === "\u2014") continue;
        const existing = byTeam.get(cName);
        const snap = OFFICIAL_2026_CONSTRUCTORS_SNAPSHOT[cName];
        if (!existing || !snap) continue;

        const officialPts = Number(jt?.points ?? 0);
        const officialWins = Number(jt?.wins ?? 0);
        if (officialPts >= snap.points && officialPts - snap.points <= maxTeamGain) {
          existing.points = Math.max(existing.points, officialPts);
        }
        if (officialWins >= snap.wins) {
          existing.wins = Math.max(existing.wins, officialWins);
        }
      }
    }

    const sortedConstructors = [...byTeam.values()].sort(
      (a, b) =>
        b.points - a.points ||
        b.wins - a.wins ||
        b.podiums - a.podiums ||
        a.officialRank - b.officialRank ||
        teamRank(a.team) - teamRank(b.team),
    );

    return {
      roundsCompleted: effectiveRounds,
      drivers: sortedDrivers,
      constructors: sortedConstructors,
    };
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
          <div
            key={idx}
            className="tower-row flex items-center gap-3 rounded-md px-3 py-3"
          >
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
    const doc = typeof document !== "undefined" ? (document as Document & { startViewTransition?: (cb: () => void) => void }) : null;
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

  const scored =
    board?.[0]?.races || (races?.filter((r) => r.has_results).length ?? 0);

  async function handleForceSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      try {
        await syncF1Data({ data: { force: true } });
      } catch (innerErr) {
        const msg = innerErr instanceof Error ? innerErr.message : "";
        if (!msg.toLowerCase().includes("wait a few seconds")) {
          throw innerErr;
        }
      }
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

  const bestSingleRoundEntry = [...(board ?? [])].sort(
    (a, b) => (b.best ?? 0) - (a.best ?? 0),
  )[0];
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
              : `${f1Data?.roundsCompleted ?? 18} races completed \u00b7 ${Math.max(0, TOTAL_2026_F1_ROUNDS - (f1Data?.roundsCompleted ?? 18))} races remaining`}
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
          >
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
            {syncing ? "Syncing\u2026" : "Sync results"}
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
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => switchTab("drivers")}
                >
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
                          {entry.races} scored \u00b7 best {entry.best ?? 0} | avg{" "}
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
                          {entry.change > 0 ? `\u25b2${entry.change}` : `\u25bc${-entry.change}`}
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
                                {entry.byRound[r.round] ?? "\u2013"}
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
                            <span className="opacity-40">\u00b7</span>
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
                            <p className="font-mono text-sm font-bold tabular-nums">
                              {d.wins}
                            </p>
                          </div>
                          <div className="rounded-sm bg-muted/60 px-2 py-1 text-center">
                            <p className="font-mono text-[10px] uppercase text-muted-foreground">
                              Podiums
                            </p>
                            <p className="font-mono text-sm font-bold tabular-nums">
                              {d.podiums}
                            </p>
                          </div>
                          <div className="rounded-sm bg-muted/60 px-2 py-1 text-center">
                            <p className="font-mono text-[10px] uppercase text-muted-foreground">
                              Poles
                            </p>
                            <p className="font-mono text-sm font-bold tabular-nums">
                              {d.poles}
                            </p>
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
                              {d.bestFinish != null ? `P${d.bestFinish}` : "\u2013"}
                            </p>
                          </div>
                          <div className="rounded-sm bg-muted/60 px-2 py-1 text-center">
                            <p className="font-mono text-[10px] uppercase text-muted-foreground">
                              DNFs
                            </p>
                            <p className="font-mono text-sm font-bold tabular-nums">
                              {d.dnfs}
                            </p>
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
                            {metaParts.join(" \u00b7 ")}
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
                      {stat.d ? stat.d.code : "\u2013"}
                    </p>
                    <p className="truncate font-mono text-[10px] uppercase text-muted-foreground">
                      {stat.d?.team ?? ""}
                    </p>
                  </div>
                  <span className="font-mono text-xl font-bold tabular-nums">
                    {stat.val}
                  </span>
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
                      {board[0]?.name ?? "\u2013"}
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
                      {bestSingleRoundEntry?.name ?? "\u2013"}
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
                      {bestAverageEntry?.name ?? "\u2013"}
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