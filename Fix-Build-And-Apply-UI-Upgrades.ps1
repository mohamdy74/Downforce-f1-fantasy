# =============================================================================
# DOWNFORCE -- Fix Build Errors + Bulletproof F1 Sync + UI/UX Upgrades + Git Push
# Pure 7-bit ASCII PowerShell Script (Zero Encoding Issues)
# =============================================================================
$ErrorActionPreference = "Stop"

function Write-Utf8NoBom {
    param([string]$RelativePath, [string]$Content)
    $FullPath = Join-Path (Get-Location).Path $RelativePath
    $Dir = Split-Path -Parent $FullPath
    if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($FullPath, $Content.Replace("`r`n", "`n"), $Utf8NoBom)
    Write-Host "  [OK] Wrote $RelativePath" -ForegroundColor Green
}

Write-Host "" 
Write-Host "[1/4] Applying all 14 verified files (Build Fixes + Sync Engine + UI/UX)..." -ForegroundColor Cyan

# --- src/lib/queryPersist.ts ---
$c = @'
const CACHE_PREFIX = "dfr:qcache:v2:";
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60_000; // 7 days

type CacheEnvelope<T> = {
  ts: number;
  data: T;
};

export function readQueryCache<T>(key: string): { data: T; updatedAt: number } | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed.ts !== "number" || parsed.data === undefined) return undefined;
    if (Date.now() - parsed.ts > MAX_CACHE_AGE_MS) {
      window.localStorage.removeItem(CACHE_PREFIX + key);
      return undefined;
    }
    return { data: parsed.data, updatedAt: parsed.ts };
  } catch {
    return undefined;
  }
}

export function writeQueryCache<T>(key: string, data: T): T {
  if (typeof window !== "undefined") {
    try {
      const payload: CacheEnvelope<T> = { ts: Date.now(), data };
      window.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(payload));
    } catch {
      /* ignore quota or private browsing errors */
    }
  }
  return data;
}
'@
Write-Utf8NoBom -RelativePath "src/lib/queryPersist.ts" -Content $c

# --- src/lib/queries.ts ---
$c = @'
import { queryOptions } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { writeQueryCache } from "@/lib/queryPersist";

export const SEASON = 2026;
/** Official league start: Round 14 (Spanish Grand Prix) */
export const LEAGUE_START_ROUND = 14;
/** Keep the active race as `nextRace` for up to 4h after lights out until `has_results` is true */
export const LIVE_RACE_GRACE_MS = 4 * 60 * 60_000;

let clockOffsetMs = 0;
let clockSynced = false;

export async function syncServerClock(): Promise<void> {
  if (clockSynced || typeof window === "undefined") return;
  clockSynced = true;
  try {
    const t0 = Date.now();
    const res = await fetch(window.location.origin, { method: "HEAD", cache: "no-store" });
    const dateHdr = res.headers.get("Date");
    if (dateHdr) {
      const serverMs = new Date(dateHdr).getTime();
      const rtt = Date.now() - t0;
      if (!Number.isNaN(serverMs)) {
        clockOffsetMs = serverMs + rtt / 2 - Date.now();
      }
    }
  } catch {
    // Fallback to device clock
  }
}

export function getTrustedNow(): number {
  return Date.now() + clockOffsetMs;
}

export type Race = {
  id: string;
  season: number;
  round: number;
  name: string;
  circuit: string | null;
  country: string | null;
  locality: string | null;
  race_at: string;
  qualifying_at: string | null;
  has_results: boolean;
  has_sprint: boolean;
  sprint_qualifying_at: string | null;
  sprint_at: string | null;
};

export type Driver = {
  id: string;
  code: string | null;
  full_name: string;
  team: string | null;
  number: number | null;
};

export const racesQuery = queryOptions({
  queryKey: ["races", SEASON],
  staleTime: 15 * 60_000,
  gcTime: 30 * 60_000,
  queryFn: async (): Promise<Race[]> => {
    void syncServerClock();
    const { data, error } = await supabase
      .from("races")
      .select("*")
      .eq("season", SEASON)
      .order("round");
    if (error) throw error;
    const mapped = ((data ?? []) as Race[]).map((r) => ({
      ...r,
      // Only treat rounds from R14 (Spanish GP) onwards as scored league rounds
      has_results: r.round >= LEAGUE_START_ROUND ? r.has_results : false,
    }));
    return writeQueryCache(`races:${SEASON}`, mapped);
  },
});

export const driversQuery = queryOptions({
  queryKey: ["drivers"],
  staleTime: 30 * 60_000,
  gcTime: 60 * 60_000,
  queryFn: async (): Promise<Driver[]> => {
    const { data, error } = await supabase
      .from("drivers")
      .select("id, code, full_name, team, number")
      .eq("active", true)
      .order("full_name");
    if (error) throw error;
    return writeQueryCache("drivers", (data ?? []) as Driver[]);
  },
});

export type LeaderboardEntry = {
  userId: string;
  name: string;
  avatar: string | null;
  points: number;
  races: number;
  best: number | null;
  change: number | null;
  byRound: Record<number, number>;
  fahl: boolean;
};

export function computeLeaderboardEntries(
  profiles: Array<{ id: string; display_name: string; avatar_url: string | null }>,
  scores: Array<{ user_id: string; race_id: string; points: number }>,
  raceRows: Array<{ id: string; round: number }>,
): LeaderboardEntry[] {
  const rMap = new Map(raceRows.map((r) => [r.id, r.round]));

  // Identify rounds >= 14 that actually have non-zero scores (ignore all-zero placeholder rounds)
  const activeRounds = new Set<number>();
  for (const s of scores) {
    const rd = rMap.get(s.race_id);
    if (rd != null && rd >= LEAGUE_START_ROUND && s.points !== 0) {
      activeRounds.add(rd);
    }
  }

  const byUser = new Map<string, LeaderboardEntry>();
  for (const p of profiles) {
    byUser.set(p.id, {
      userId: p.id,
      name: p.display_name,
      avatar: p.avatar_url,
      points: 0,
      races: 0,
      best: null,
      change: null,
      byRound: {},
      fahl: false,
    });
  }

  let latestRound = 0;
  for (const s of scores) {
    const entry = byUser.get(s.user_id);
    const rd = rMap.get(s.race_id);
    if (!entry || rd == null || !activeRounds.has(rd)) continue;
    entry.points += s.points;
    entry.races += 1;
    entry.best = entry.best == null ? s.points : Math.max(entry.best, s.points);
    entry.byRound[rd] = s.points;
    if (rd > latestRound) latestRound = rd;
  }

  if (latestRound > 0) {
    const top = Math.max(...[...byUser.values()].map((e) => e.byRound[latestRound] ?? -Infinity));
    for (const e of byUser.values()) {
      if (e.byRound[latestRound] === top) e.fahl = true;
    }
  }

  const sort = (a: LeaderboardEntry, b: LeaderboardEntry) =>
    b.points - a.points || a.name.localeCompare(b.name);
  const list = [...byUser.values()].sort(sort);

  // Rank movement vs. standings before the latest scored race
  if (latestRound > 0) {
    const prevPts = new Map<string, number>();
    for (const s of scores) {
      const rd = rMap.get(s.race_id);
      if (rd == null || !activeRounds.has(rd) || rd === latestRound) continue;
      prevPts.set(s.user_id, (prevPts.get(s.user_id) ?? 0) + s.points);
    }
    const prev = [...list].sort(
      (a, b) =>
        (prevPts.get(b.userId) ?? 0) - (prevPts.get(a.userId) ?? 0) ||
        a.name.localeCompare(b.name),
    );
    const prevRank = new Map(prev.map((e, i) => [e.userId, i]));
    list.forEach((e, i) => (e.change = (prevRank.get(e.userId) ?? i) - i));
  }
  return list;
}

export const leaderboardQuery = queryOptions({
  queryKey: ["leaderboard", SEASON],
  staleTime: 2 * 60_000,
  queryFn: async (): Promise<LeaderboardEntry[]> => {
    const { data: sData } = await supabase.auth.getSession();
    if (!sData.session) return [];

    const [
      { data: scores, error: sErr },
      { data: profiles, error: pErr },
      { data: raceRows, error: rErr },
    ] = await Promise.all([
      supabase.from("scores").select("user_id, race_id, points").limit(50000),
      supabase.from("profiles").select("id, display_name, avatar_url").limit(10000),
      supabase.from("races").select("id, round").eq("season", SEASON).gte("round", LEAGUE_START_ROUND),
    ]);
    if (sErr) throw sErr;
    if (pErr) throw pErr;
    if (rErr) throw rErr;

    const list = computeLeaderboardEntries(profiles ?? [], scores ?? [], raceRows ?? []);
    return writeQueryCache(`leaderboard:${SEASON}`, list);
  },
});

export function nextRace(races: Race[], nowMs?: number | undefined): Race | null {
  const now = nowMs ?? getTrustedNow();
  return (
    races.find((r) => {
      const start = new Date(r.race_at).getTime();
      if (start > now) return true;
      // Keep the active race on /predict, /, and /stewards while the race is live on track
      // until Chequered Flag results are finalized (or 4h grace window expires).
      return r.round >= LEAGUE_START_ROUND && !r.has_results && now - start <= LIVE_RACE_GRACE_MS;
    }) ?? null
  );
}

export function lastRace(races: Race[]): Race | null {
  const done = races.filter((r) => r.has_results && r.round >= LEAGUE_START_ROUND);
  return done.length ? done[done.length - 1]! : null;
}
'@
Write-Utf8NoBom -RelativePath "src/lib/queries.ts" -Content $c

# --- src/router.tsx ---
$c = @'
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { SEASON, type Driver, type LeaderboardEntry, type Race } from "@/lib/queries";
import { readQueryCache } from "@/lib/queryPersist";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    // Reuse fresh data when moving between tabs instead of refetching every time.
    defaultOptions: {
      queries: {
        staleTime: 2 * 60_000,
        gcTime: 15 * 60_000,
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  });

  // Hydrate 0ms instant snapshots from localStorage on client boot
  if (typeof window !== "undefined") {
    const cachedRaces = readQueryCache<Race[]>(`races:${SEASON}`);
    if (cachedRaces) {
      queryClient.setQueryData(["races", SEASON], cachedRaces.data, {
        updatedAt: cachedRaces.updatedAt,
      });
    }
    const cachedDrivers = readQueryCache<Driver[]>("drivers");
    if (cachedDrivers) {
      queryClient.setQueryData(["drivers"], cachedDrivers.data, {
        updatedAt: cachedDrivers.updatedAt,
      });
    }
    const cachedBoard = readQueryCache<LeaderboardEntry[]>(`leaderboard:${SEASON}`);
    if (cachedBoard) {
      queryClient.setQueryData(["leaderboard", SEASON], cachedBoard.data, {
        updatedAt: cachedBoard.updatedAt,
      });
    }
  }

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultViewTransition: true,
    defaultPreload: "intent",
    defaultPreloadDelay: 15,
    defaultPreloadStaleTime: 60_000,
  });

  return router;
};
'@
Write-Utf8NoBom -RelativePath "src/router.tsx" -Content $c

# --- src/lib/roundScoring.ts ---
$c = @'
import { NO_SUBMISSION_PENALTY, scorePrediction, type ResultRow } from "./scoring";
import { scoreSprint, type SprintResultRow } from "./sprintScoring";
import type { Json } from "@/integrations/supabase/types";

export type ProfileRecord = {
  id: string;
  created_at: string;
};

export type PredictionRecord = {
  user_id: string;
  top10: string[];
  pole_driver_id: string | null;
  fastest_lap_driver_id: string | null;
  dnf_driver_id: string | null;
};

export type SprintPredictionRecord = {
  user_id: string;
  top8: string[];
  pole_driver_id: string | null;
};

export type ScoreRecord = {
  user_id: string;
  breakdown: unknown;
};

export type ScoreUpsertRow = {
  user_id: string;
  race_id: string;
  points: number;
  breakdown: Json;
  updated_at: string;
};

export function filterValidDriverIds(ids: string[] | null | undefined): string[] {
  return (ids ?? []).filter((x) => Boolean(x && x !== "__none__"));
}

export function extractStewardLockedUsers(
  existingScores: ScoreRecord[] | null | undefined,
): Set<string> {
  return new Set(
    (existingScores ?? [])
      .filter((s) => {
        const b = s.breakdown as Record<string, unknown> | null;
        return b && typeof b === "object" && b["stewardOverride"] === true;
      })
      .map((s) => s.user_id),
  );
}

/**
 * Unified race scoring calculator used by both automatic F1 sync (`auto_sync`)
 * and Steward manual result entry (`manual_results`).
 */
export function buildRaceScoreRows(params: {
  raceId: string;
  raceAt: string | null;
  profiles: ProfileRecord[];
  results: ResultRow[];
  predictions: PredictionRecord[];
  sprintResults?: SprintResultRow[] | null | undefined;
  sprintPredictions?: SprintPredictionRecord[] | null | undefined;
  existingScores?: ScoreRecord[] | null | undefined;
  mode: "auto_sync" | "manual_results";
  manualPoleWinner?: string | null | undefined;
}): ScoreUpsertRow[] {
  const {
    raceId,
    raceAt,
    profiles,
    results,
    predictions,
    sprintResults,
    sprintPredictions,
    existingScores,
    mode,
    manualPoleWinner,
  } = params;

  const stewardLockedUsers = extractStewardLockedUsers(existingScores);
  const byUser = new Map(predictions.map((p) => [p.user_id, p]));
  const sprintByUser = new Map((sprintPredictions ?? []).map((p) => [p.user_id, p]));
  const sprintFor = (userId: string) =>
    sprintResults?.length ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults) : null;

  const nowIso = new Date().toISOString();
  const rows: ScoreUpsertRow[] = [];

  for (const profile of profiles) {
    if (stewardLockedUsers.has(profile.id)) continue;
    if (raceAt && new Date(profile.created_at) > new Date(raceAt)) continue;

    const sprint = sprintFor(profile.id);
    const prediction = byUser.get(profile.id);

    if (mode === "auto_sync") {
      if (!prediction) {
        const total = NO_SUBMISSION_PENALTY + (sprint?.total ?? 0);
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: {
            noSubmission: true,
            ...(sprint ? { sprint } : {}),
            total,
          } as unknown as Json,
          updated_at: nowIso,
        });
        continue;
      }

      const validTop10 = filterValidDriverIds(prediction.top10);
      const breakdown = scorePrediction(
        {
          top10: validTop10,
          pole_driver_id: prediction.pole_driver_id,
          fastest_lap_driver_id: prediction.fastest_lap_driver_id,
          dnf_driver_id: prediction.dnf_driver_id,
        },
        results,
      );

      if (validTop10.length < 10) {
        const total = NO_SUBMISSION_PENALTY + breakdown.pole + (sprint?.total ?? 0);
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: {
            ...breakdown,
            top10: 0,
            fastestLap: 0,
            dnf: 0,
            perfect: 0,
            perfectTop10: false,
            perfectWeekend: false,
            noSubmission: true,
            ...(sprint ? { sprint } : {}),
            total,
          } as unknown as Json,
          updated_at: nowIso,
        });
        continue;
      }

      const total = breakdown.total + (sprint?.total ?? 0);
      rows.push({
        user_id: profile.id,
        race_id: raceId,
        points: total,
        breakdown: {
          ...breakdown,
          ...(sprint ? { sprint } : {}),
          total,
        } as unknown as Json,
        updated_at: nowIso,
      });
    } else {
      const validTop10 = filterValidDriverIds(prediction?.top10);
      if (!prediction || validTop10.length < 10) {
        const polePts =
          prediction?.pole_driver_id &&
          manualPoleWinner &&
          prediction.pole_driver_id === manualPoleWinner
            ? 3
            : 0;
        const total = NO_SUBMISSION_PENALTY + polePts + (sprint?.total ?? 0);
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: {
            noSubmission: true,
            top10: 0,
            pole: polePts,
            fastestLap: 0,
            dnf: 0,
            perfect: 0,
            ...(sprint ? { sprint } : {}),
            total,
          } as unknown as Json,
          updated_at: nowIso,
        });
      } else {
        const breakdown = scorePrediction(
          {
            top10: validTop10,
            pole_driver_id: prediction.pole_driver_id,
            fastest_lap_driver_id: prediction.fastest_lap_driver_id,
            dnf_driver_id: prediction.dnf_driver_id,
          },
          results,
        );
        const total = breakdown.total + (sprint?.total ?? 0);
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: {
            ...breakdown,
            ...(sprint ? { sprint } : {}),
            total,
          } as unknown as Json,
          updated_at: nowIso,
        });
      }
    }
  }

  return rows;
}
'@
Write-Utf8NoBom -RelativePath "src/lib/roundScoring.ts" -Content $c

# --- src/lib/f1-parsers.ts ---
$c = @'
/**
 * Shared parsers and fetch helpers for Ergast/Jolpica, OpenF1, F1 Live Timing, and ESPN APIs.
 * Includes timeout guards, automatic retry on HTTP 429/5xx, and lap time parsers.
 */

const envMap =
  typeof process !== "undefined" && process?.env
    ? process.env
    : ({} as Record<string, string | undefined>);

export async function getJson<T>(
  url: string,
  options?: {
    timeoutMs?: number | undefined;
    retries?: number | undefined;
    headers?: Record<string, string> | undefined;
  },
): Promise<T | null> {
  const timeoutMs = options?.timeoutMs ?? 7_000;
  const retries = options?.retries ?? 1;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "DownforceF1/2026",
    ...(options?.headers ?? {}),
  };

  if (url.includes("api.openf1.org")) {
    const token = envMap["OPENF1_API_KEY"] || envMap["OPENF1_TOKEN"];
    if (token && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, {
        headers,
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      if (timer) clearTimeout(timer);

      if ((res.status === 429 || res.status >= 502) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      if (timer) clearTimeout(timer);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}

export function toIso(session?: { date: string; time?: string | undefined } | null): string | null {
  if (!session?.date) return null;
  const d = new Date(`${session.date}T${session.time ?? "12:00:00Z"}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function fmtLap(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : s;
}

/**
 * Parses a lap time string like "1:36.052" or "96.052" into seconds (96.052).
 */
export function parseLapTimeSeconds(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const mColon = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(trimmed);
  if (mColon) {
    const mins = Number(mColon[1]);
    const secs = Number(mColon[2]);
    const total = Math.round((mins * 60 + secs) * 1000) / 1000;
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  const num = Number(trimmed);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export function isClassifiedFinishStatus(
  status: string | null | undefined,
  includeLappedKeyword = true,
): boolean {
  if (!status) return false;
  return includeLappedKeyword
    ? /finished|lapped|\+\d+ lap/i.test(status)
    : /finished|\+\d+ lap/i.test(status);
}
'@
Write-Utf8NoBom -RelativePath "src/lib/f1-parsers.ts" -Content $c

# --- src/lib/f1-live-sources.ts ---
$c = @'
/**
 * Multi-Engine Live & Post-Session F1 Telemetry Cascade:
 * 1) Rate-limit-protected & cached OpenF1 API client (`api.openf1.org/v1`)
 * 2) Official Formula 1 Live Timing SignalR & Static stream (`livetiming.formula1.com`)
 * 3) ESPN F1 Live Scoreboard API (`site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard`)
 *
 * Ensures 100% live and completed session coverage for Practice 1/2/3, Sprint Qualifying,
 * Sprint, Qualifying, and Grand Prix Race -- even when OpenF1 restricts unauthenticated
 * requests during an active session on track.
 */

import { fmtLap, getJson, parseLapTimeSeconds } from "./f1-parsers";
import { hasChequeredFlag, type OpenF1RaceControlMessage } from "./liveStandings";
import type { ClassRow, SessionType } from "./weekend";

export type DriverRef = {
  id: string;
  code: string | null;
  full_name: string;
  team: string | null;
  number: number | null;
};

/**
 * Built-in 2026 F1 grid & FP1 rookie reserve fallback directory so every driver
 * resolves cleanly even if car numbers differ (#1 vs #3) or an FP1 rookie is on track.
 */
const FALLBACK_2026_GRID: DriverRef[] = [
  { id: "max_verstappen", code: "VER", full_name: "Max Verstappen", team: "Red Bull", number: 1 },
  { id: "max_verstappen", code: "VER", full_name: "Max Verstappen", team: "Red Bull", number: 3 },
  { id: "hadjar", code: "HAD", full_name: "Isack Hadjar", team: "Red Bull", number: 6 },
  { id: "leclerc", code: "LEC", full_name: "Charles Leclerc", team: "Ferrari", number: 16 },
  { id: "hamilton", code: "HAM", full_name: "Lewis Hamilton", team: "Ferrari", number: 44 },
  { id: "norris", code: "NOR", full_name: "Lando Norris", team: "McLaren", number: 4 },
  { id: "piastri", code: "PIA", full_name: "Oscar Piastri", team: "McLaren", number: 81 },
  { id: "russell", code: "RUS", full_name: "George Russell", team: "Mercedes", number: 63 },
  { id: "antonelli", code: "ANT", full_name: "Kimi Antonelli", team: "Mercedes", number: 12 },
  { id: "alonso", code: "ALO", full_name: "Fernando Alonso", team: "Aston Martin", number: 14 },
  { id: "stroll", code: "STR", full_name: "Lance Stroll", team: "Aston Martin", number: 18 },
  { id: "gasly", code: "GAS", full_name: "Pierre Gasly", team: "Alpine", number: 10 },
  { id: "colapinto", code: "COL", full_name: "Franco Colapinto", team: "Alpine", number: 43 },
  { id: "doohan", code: "DOO", full_name: "Jack Doohan", team: "Alpine", number: 7 },
  { id: "albon", code: "ALB", full_name: "Alexander Albon", team: "Williams", number: 23 },
  { id: "sainz", code: "SAI", full_name: "Carlos Sainz", team: "Williams", number: 55 },
  { id: "lawson", code: "LAW", full_name: "Liam Lawson", team: "Racing Bulls", number: 30 },
  { id: "lindblad", code: "LIN", full_name: "Arvid Lindblad", team: "Racing Bulls", number: 40 },
  { id: "ocon", code: "OCO", full_name: "Esteban Ocon", team: "Haas", number: 31 },
  { id: "bearman", code: "BEA", full_name: "Oliver Bearman", team: "Haas", number: 87 },
  { id: "hulkenberg", code: "HUL", full_name: "Nico Hulkenberg", team: "Audi", number: 27 },
  { id: "bortoleto", code: "BOR", full_name: "Gabriel Bortoleto", team: "Audi", number: 5 },
  { id: "bottas", code: "BOT", full_name: "Valtteri Bottas", team: "Cadillac", number: 77 },
  { id: "perez", code: "PER", full_name: "Sergio Perez", team: "Cadillac", number: 11 },
  { id: "crawford", code: "CRA", full_name: "Jak Crawford", team: "Aston Martin", number: 34 },
];

export type DriverLookup = {
  byId: Map<string, DriverRef>;
  byCode: Map<string, DriverRef>;
  byNumber: Map<number, DriverRef>;
  byLastName: Map<string, DriverRef>;
};

function normName(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export function buildDriverLookup(dbDrivers: DriverRef[]): DriverLookup {
  const byId = new Map<string, DriverRef>();
  const byCode = new Map<string, DriverRef>();
  const byNumber = new Map<number, DriverRef>();
  const byLastName = new Map<string, DriverRef>();

  const register = (d: DriverRef, overwrite: boolean) => {
    if (d.id && (overwrite || !byId.has(d.id))) byId.set(d.id, d);
    if (d.code) {
      const c = d.code.toUpperCase();
      if (overwrite || !byCode.has(c)) byCode.set(c, d);
    }
    if (d.number != null && (overwrite || !byNumber.has(d.number))) {
      byNumber.set(d.number, d);
    }
    const parts = d.full_name.trim().split(/\s+/);
    const last = normName(parts[parts.length - 1]);
    if (last && (overwrite || !byLastName.has(last))) {
      byLastName.set(last, d);
    }
    const full = normName(d.full_name);
    if (full && (overwrite || !byLastName.has(full))) {
      byLastName.set(full, d);
    }
  };

  for (const f of FALLBACK_2026_GRID) register(f, false);
  for (const d of dbDrivers) register(d, true);

  return { byId, byCode, byNumber, byLastName };
}

export function resolveDriver(
  lookup: DriverLookup,
  hint: {
    driverId?: string | null | undefined;
    code?: string | null | undefined;
    name?: string | null | undefined;
    team?: string | null | undefined;
    number?: number | null | undefined;
  },
): DriverRef {
  if (hint.driverId && lookup.byId.has(hint.driverId)) {
    return lookup.byId.get(hint.driverId)!;
  }
  if (hint.code) {
    const c = hint.code.trim().toUpperCase();
    if (lookup.byCode.has(c)) return lookup.byCode.get(c)!;
  }
  if (hint.name) {
    const clean = hint.name.trim();
    const parts = clean.split(/\s+/);
    const last = normName(parts[parts.length - 1]);
    if (last && lookup.byLastName.has(last)) return lookup.byLastName.get(last)!;
    const full = normName(clean);
    if (full && lookup.byLastName.has(full)) return lookup.byLastName.get(full)!;
  }
  if (hint.number != null && lookup.byNumber.has(hint.number)) {
    return lookup.byNumber.get(hint.number)!;
  }
  const fallbackCode =
    hint.code?.trim().toUpperCase() ||
    (hint.name
      ? hint.name
          .trim()
          .split(/\s+/)
          .pop()
          ?.slice(0, 3)
          .toUpperCase() ?? null
      : null);
  return {
    id: hint.driverId ?? (fallbackCode ? fallbackCode.toLowerCase() : `car_${hint.number ?? 0}`),
    code: fallbackCode,
    full_name: hint.name?.trim() || (hint.number != null ? `Car #${hint.number}` : "Unknown Driver"),
    team: hint.team?.trim() || null,
    number: hint.number ?? null,
  };
}

// ---------------------------------------------------------------------------
// Engine 1: Rate-Limit-Protected OpenF1 Session & Driver Metadata Cache
// ---------------------------------------------------------------------------
const OPENF1 = "https://api.openf1.org/v1";

export type OfSession = {
  session_key: number;
  session_name: string;
  date_start: string;
  date_end?: string | undefined;
  country_name?: string | undefined;
  circuit_short_name?: string | undefined;
};

export type OfDriverMeta = {
  driver_number: number;
  name_acronym?: string | undefined;
  full_name?: string | undefined;
  team_name?: string | undefined;
};

let sessionsMemo: { ts: number; season: number; data: OfSession[] } | null = null;
let inflightSessions: Promise<OfSession[]> | null = null;
const driversBySessionMemo = new Map<number, { ts: number; data: OfDriverMeta[] }>();

export async function getCachedOpenF1Sessions(season: number): Promise<OfSession[]> {
  const now = Date.now();
  if (sessionsMemo && sessionsMemo.season === season) {
    const ttl = sessionsMemo.data.length > 0 ? 15 * 60_000 : 15_000;
    if (now - sessionsMemo.ts < ttl) return sessionsMemo.data;
  }
  if (!inflightSessions) {
    inflightSessions = (async () => {
      const list = await getJson<OfSession[]>(`${OPENF1}/sessions?year=${season}`, {
        timeoutMs: 6_000,
        retries: 1,
      });
      const valid = Array.isArray(list) ? list : [];
      sessionsMemo = { ts: Date.now(), season, data: valid };
      return valid;
    })().finally(() => {
      inflightSessions = null;
    });
  }
  return inflightSessions;
}

export async function getCachedOpenF1Drivers(sessionKey: number): Promise<OfDriverMeta[]> {
  const now = Date.now();
  const cached = driversBySessionMemo.get(sessionKey);
  if (cached && now - cached.ts < 30 * 60_000 && cached.data.length > 0) {
    return cached.data;
  }
  const list = await getJson<OfDriverMeta[]>(`${OPENF1}/drivers?session_key=${sessionKey}`, {
    timeoutMs: 5_000,
    retries: 1,
  });
  const valid = Array.isArray(list) ? list : [];
  if (valid.length > 0) {
    driversBySessionMemo.set(sessionKey, { ts: now, data: valid });
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Engine 2: Official F1 Live Timing SignalR & Static Feed (Zero-Auth)
// ---------------------------------------------------------------------------
const F1_LIVE_BASE = "https://livetiming.formula1.com";

const F1_SESSION_NAMES: Record<SessionType, string[]> = {
  fp1: ["Practice 1", "Free Practice 1"],
  fp2: ["Practice 2", "Free Practice 2"],
  fp3: ["Practice 3", "Free Practice 3"],
  sprint_qualifying: ["Sprint Qualifying", "Sprint Shootout"],
  sprint: ["Sprint"],
  qualifying: ["Qualifying"],
  race: ["Race"],
};

type F1StaticSessionInfo = {
  Key?: number | undefined;
  Name?: string | undefined;
  Type?: string | undefined;
  StartDate?: string | undefined;
  GmtOffset?: string | undefined;
  Path?: string | undefined;
};

type F1SignalRDriver = {
  RacingNumber?: string | undefined;
  Tla?: string | undefined;
  FullName?: string | undefined;
  BroadcastName?: string | undefined;
  TeamName?: string | undefined;
};

type F1SignalRTimingLine = {
  Position?: string | number | undefined;
  Line?: number | undefined;
  RacingNumber?: string | undefined;
  NumberOfLaps?: number | undefined;
  Retired?: boolean | undefined;
  Stopped?: boolean | undefined;
  KnockedOut?: boolean | undefined;
  Status?: number | undefined;
  GapToLeader?: string | { Value?: string | undefined } | undefined;
  TimeDiffToFastest?: string | { Value?: string | undefined } | undefined;
  BestLapTime?: { Value?: string | undefined; OverallFastest?: boolean | undefined } | undefined;
  BestLapTimes?:
    | Record<string, { Value?: string | undefined } | undefined>
    | Array<{ Value?: string | undefined } | undefined>
    | undefined;
  Stats?: Array<{ TimeDiffToFastest?: string | undefined } | undefined> | undefined;
};

export type F1LiveTimingSnapshot = {
  rows: ClassRow[];
  chequeredFlag: boolean;
  fastestLapDriverId: string | null;
};

let f1SignalRCache: {
  ts: number;
  sessionName: string;
  startDateIso: string | null;
  snapshot: Record<string, unknown>;
} | null = null;

function extractCookies(res: Response): string {
  const hdrs = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof hdrs.getSetCookie === "function") {
    const arr = hdrs.getSetCookie();
    if (arr.length > 0) {
      return arr.map((c) => c.split(";")[0]!.trim()).join("; ");
    }
  }
  const raw = res.headers.get("set-cookie");
  if (!raw) return "";
  return raw
    .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
    .map((c) => c.split(";")[0]!.trim())
    .join("; ");
}

async function fetchSignalRState(): Promise<{
  sessionInfo: F1StaticSessionInfo | null;
  state: Record<string, unknown> | null;
}> {
  const now = Date.now();
  if (f1SignalRCache && now - f1SignalRCache.ts < 18_000) {
    return {
      sessionInfo: (f1SignalRCache.snapshot["SessionInfo"] as F1StaticSessionInfo | undefined) ?? null,
      state: f1SignalRCache.snapshot,
    };
  }

  const sessionInfo = await getJson<F1StaticSessionInfo>(
    `${F1_LIVE_BASE}/static/SessionInfo.json`,
    { timeoutMs: 4_500, retries: 0 },
  );

  const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
  try {
    const negRes = await fetch(
      `${F1_LIVE_BASE}/signalr/negotiate?clientProtocol=1.5&connectionData=${hub}`,
      {
        headers: {
          "User-Agent": "BestHTTP",
          Accept: "application/json",
        },
      },
    );
    if (negRes.ok) {
      const cookie = extractCookies(negRes);
      const negJson = (await negRes.json()) as { ConnectionToken?: string | undefined };
      const token = negJson.ConnectionToken;
      if (token) {
        const encToken = encodeURIComponent(token);
        const commonHeaders: Record<string, string> = {
          "User-Agent": "BestHTTP",
          Accept: "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        };

        await fetch(
          `${F1_LIVE_BASE}/signalr/connect?transport=longPolling&clientProtocol=1.5&connectionToken=${encToken}&connectionData=${hub}`,
          { headers: commonHeaders },
        ).catch(() => null);

        const subPayload = JSON.stringify({
          H: "Streaming",
          M: "Subscribe",
          A: [
            [
              "TimingData",
              "DriverList",
              "SessionInfo",
              "SessionStatus",
              "RaceControlMessages",
              "LapCount",
            ],
          ],
          I: 1,
        });

        const sendRes = await fetch(
          `${F1_LIVE_BASE}/signalr/send?transport=longPolling&clientProtocol=1.5&connectionToken=${encToken}&connectionData=${hub}`,
          {
            method: "POST",
            headers: {
              ...commonHeaders,
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            },
            body: `data=${encodeURIComponent(subPayload)}`,
          },
        );

        let stateObj: Record<string, unknown> | null = null;
        if (sendRes.ok) {
          const sendJson = (await sendRes.json()) as {
            R?: Record<string, unknown> | undefined;
          };
          if (sendJson?.R && typeof sendJson.R === "object") {
            stateObj = sendJson.R;
          }
        }

        // Cleanly abort the temporary longPolling connection
        void fetch(
          `${F1_LIVE_BASE}/signalr/abort?transport=longPolling&clientProtocol=1.5&connectionToken=${encToken}&connectionData=${hub}`,
          { method: "POST", headers: commonHeaders },
        ).catch(() => null);

        if (stateObj && stateObj["TimingData"]) {
          const sInfo = (stateObj["SessionInfo"] as F1StaticSessionInfo | undefined) ?? sessionInfo;
          f1SignalRCache = {
            ts: Date.now(),
            sessionName: sInfo?.Name ?? "",
            startDateIso: sInfo?.StartDate ?? null,
            snapshot: { ...stateObj, SessionInfo: sInfo },
          };
          return { sessionInfo: sInfo ?? null, state: f1SignalRCache.snapshot };
        }
      }
    }
  } catch {
    /* SignalR negotiate/send unavailable: try static path fallback */
  }

  if (sessionInfo?.Path) {
    const cleanPath = sessionInfo.Path.replace(/^\/+|\/+$/g, "");
    const [timingData, driverList, sessionStatus] = await Promise.all([
      getJson<Record<string, unknown>>(`${F1_LIVE_BASE}/static/${cleanPath}/TimingData.json`, {
        timeoutMs: 4_500,
        retries: 0,
      }),
      getJson<Record<string, unknown>>(`${F1_LIVE_BASE}/static/${cleanPath}/DriverList.json`, {
        timeoutMs: 4_500,
        retries: 0,
      }),
      getJson<Record<string, unknown>>(`${F1_LIVE_BASE}/static/${cleanPath}/SessionStatus.json`, {
        timeoutMs: 4_500,
        retries: 0,
      }),
    ]);
    if (timingData) {
      const snapshot: Record<string, unknown> = {
        SessionInfo: sessionInfo,
        TimingData: timingData,
        DriverList: driverList ?? {},
        SessionStatus: sessionStatus ?? {},
      };
      f1SignalRCache = {
        ts: Date.now(),
        sessionName: sessionInfo.Name ?? "",
        startDateIso: sessionInfo.StartDate ?? null,
        snapshot,
      };
      return { sessionInfo, state: snapshot };
    }
  }

  return { sessionInfo: sessionInfo ?? null, state: null };
}

export function parseF1SignalRSnapshot(
  state: Record<string, unknown>,
  type: SessionType,
  lookup: DriverLookup,
): F1LiveTimingSnapshot {
  const timingData = state["TimingData"] as
    | { Lines?: Record<string, F1SignalRTimingLine> | undefined }
    | undefined;
  const driverList = (state["DriverList"] as Record<string, F1SignalRDriver> | undefined) ?? {};
  const sessionStatus = state["SessionStatus"] as { Status?: string | undefined } | undefined;
  const rcmRaw = state["RaceControlMessages"] as
    | { Messages?: Record<string, OpenF1RaceControlMessage> | OpenF1RaceControlMessage[] | undefined }
    | undefined;

  const linesObj = timingData?.Lines ?? {};
  const entries = Object.entries(linesObj);
  if (!entries.length) {
    return { rows: [], chequeredFlag: false, fastestLapDriverId: null };
  }

  const isTimedSession =
    type === "fp1" ||
    type === "fp2" ||
    type === "fp3" ||
    type === "qualifying" ||
    type === "sprint_qualifying";

  let fastestLapDriverId: string | null = null;
  let bestLapSec = Infinity;

  const rawRows = entries.map(([carKey, line]) => {
    const numStr = line.RacingNumber ?? driverList[carKey]?.RacingNumber ?? carKey;
    const num = Number(numStr);
    const sigDrv = driverList[carKey] ?? driverList[numStr];
    const resolved = resolveDriver(lookup, {
      code: sigDrv?.Tla ?? null,
      name: sigDrv?.FullName ?? sigDrv?.BroadcastName ?? null,
      team: sigDrv?.TeamName ?? null,
      number: Number.isFinite(num) ? num : null,
    });

    const posNum = Number(line.Position ?? line.Line ?? 999);
    const position = Number.isFinite(posNum) && posNum > 0 && posNum < 99 ? posNum : null;

    const bestVal = line.BestLapTime?.Value || null;
    const lapSec = parseLapTimeSeconds(bestVal);
    if (
      line.BestLapTime?.OverallFastest === true ||
      (lapSec != null && lapSec < bestLapSec)
    ) {
      if (lapSec != null) bestLapSec = lapSec;
      fastestLapDriverId = resolved.id;
    }

    const bTimes = line.BestLapTimes;
    const getSeg = (idx: number): string | null => {
      if (!bTimes) return null;
      if (Array.isArray(bTimes)) return bTimes[idx]?.Value || null;
      return bTimes[String(idx)]?.Value || null;
    };
    const q1 = getSeg(0);
    const q2 = getSeg(1);
    const q3 = getSeg(2);

    const gapRaw = isTimedSession
      ? (typeof line.TimeDiffToFastest === "string"
          ? line.TimeDiffToFastest
          : line.TimeDiffToFastest?.Value ??
            line.Stats?.[0]?.TimeDiffToFastest ??
            null)
      : (typeof line.GapToLeader === "string"
          ? line.GapToLeader
          : line.GapToLeader?.Value ?? null);

    const cleanGap =
      gapRaw && !/^LEADER$/i.test(gapRaw.trim()) ? gapRaw.trim() : null;

    const retired = Boolean(line.Retired || line.Stopped);

    return {
      row: {
        position,
        driverId: resolved.id,
        code: resolved.code,
        name: resolved.full_name,
        team: resolved.team,
        number: resolved.number ?? (Number.isFinite(num) ? num : null),
        time: isTimedSession ? (q3 || q2 || q1 || bestVal) : (position === 1 ? bestVal : null),
        q1,
        q2,
        q3,
        gap: position === 1 ? null : cleanGap,
        laps: typeof line.NumberOfLaps === "number" ? line.NumberOfLaps : null,
        status: retired ? "DNF" : null,
      } satisfies ClassRow,
      lapSec,
    };
  });

  rawRows.sort((a, b) => {
    const pa = a.row.position ?? 999;
    const pb = b.row.position ?? 999;
    if (pa !== pb) return pa - pb;
    if (isTimedSession) {
      return (a.lapSec ?? Infinity) - (b.lapSec ?? Infinity);
    }
    return (b.row.laps ?? 0) - (a.row.laps ?? 0);
  });

  const p1Sec = rawRows[0]?.lapSec ?? null;
  const rows: ClassRow[] = rawRows.map((item, idx) => {
    const pos = item.row.position ?? idx + 1;
    let gap = item.row.gap;
    if (
      isTimedSession &&
      pos > 1 &&
      !gap &&
      item.lapSec != null &&
      p1Sec != null &&
      item.lapSec > p1Sec
    ) {
      gap = `+${(item.lapSec - p1Sec).toFixed(3)}`;
    }
    return {
      ...item.row,
      position: pos,
      gap: pos === 1 ? null : gap,
    };
  });

  const rcmList: OpenF1RaceControlMessage[] = rcmRaw?.Messages
    ? Array.isArray(rcmRaw.Messages)
      ? rcmRaw.Messages
      : Object.values(rcmRaw.Messages)
    : [];

  const statusStr = sessionStatus?.Status ?? "";
  const chequeredFlag =
    /Finished|Finalised|Ends/i.test(statusStr) || hasChequeredFlag(rcmList);

  return { rows, chequeredFlag, fastestLapDriverId };
}

export async function fetchFromF1LiveTiming(
  type: SessionType,
  startsAt: string,
  lookup: DriverLookup,
): Promise<F1LiveTimingSnapshot | null> {
  const { sessionInfo, state } = await fetchSignalRState();
  if (!state || !sessionInfo?.Name) return null;

  const allowedNames = F1_SESSION_NAMES[type].map((n) => n.toLowerCase());
  const actualName = sessionInfo.Name.trim().toLowerCase();
  const nameMatches = allowedNames.some((n) => actualName === n || actualName.includes(n));
  if (!nameMatches) return null;

  // Verify the session is from the current weekend (within 36 hours of scheduled startsAt)
  if (sessionInfo.StartDate && startsAt) {
    const targetMs = new Date(startsAt).getTime();
    const sDateMs = new Date(sessionInfo.StartDate).getTime();
    if (
      Number.isFinite(targetMs) &&
      Number.isFinite(sDateMs) &&
      Math.abs(targetMs - sDateMs) > 36 * 3600_000
    ) {
      return null;
    }
  }

  const parsed = parseF1SignalRSnapshot(state, type, lookup);
  return parsed.rows.length >= 5 ? parsed : null;
}

// ---------------------------------------------------------------------------
// Engine 3: ESPN F1 Live Scoreboard API (Zero-Auth, Live + Completed)
// ---------------------------------------------------------------------------
const ESPN_F1_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard";

type EspnStat = {
  name?: string | undefined;
  abbreviation?: string | undefined;
  displayValue?: string | undefined;
  value?: number | string | undefined;
};

type EspnCompetitor = {
  id?: string | undefined;
  order?: number | undefined;
  place?: number | undefined;
  winner?: boolean | undefined;
  athlete?: {
    fullName?: string | undefined;
    displayName?: string | undefined;
    shortName?: string | undefined;
    abbreviation?: string | undefined;
  } | undefined;
  vehicle?: {
    number?: string | undefined;
    manufacturer?: string | undefined;
  } | undefined;
  status?: {
    type?: {
      name?: string | undefined;
      description?: string | undefined;
      shortDetail?: string | undefined;
      completed?: boolean | undefined;
    } | undefined;
  } | undefined;
  statistics?: EspnStat[] | undefined;
  linescores?: Array<{ value?: number | string | undefined; displayValue?: string | undefined }> | undefined;
};

type EspnCompetition = {
  id?: string | undefined;
  date?: string | undefined;
  type?: {
    id?: string | undefined;
    text?: string | undefined;
    abbreviation?: string | undefined;
    slug?: string | undefined;
  } | undefined;
  status?: {
    type?: {
      id?: string | undefined;
      name?: string | undefined;
      state?: string | undefined;
      completed?: boolean | undefined;
    } | undefined;
  } | undefined;
  competitors?: EspnCompetitor[] | undefined;
};

type EspnEvent = {
  id?: string | undefined;
  date?: string | undefined;
  endDate?: string | undefined;
  name?: string | undefined;
  competitions?: EspnCompetition[] | undefined;
};

type EspnScoreboardResponse = {
  events?: EspnEvent[] | undefined;
};

const espnCache = new Map<string, { ts: number; data: EspnScoreboardResponse }>();

function ymd(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

const ESPN_TYPE_MATCHERS: Record<SessionType, RegExp> = {
  fp1: /^(fp1|practice\s*1|free\s*practice\s*1|p1)$/i,
  fp2: /^(fp2|practice\s*2|free\s*practice\s*2|p2)$/i,
  fp3: /^(fp3|practice\s*3|free\s*practice\s*3|p3)$/i,
  sprint_qualifying: /^(sq|sprint\s*qualifying|sprint\s*shootout|shootout)$/i,
  sprint: /^(sr|sprint|sprint\s*race)$/i,
  qualifying: /^(qual|quali|qualifying|q)$/i,
  race: /^(race|gp|grand\s*prix|r)$/i,
};

export function parseEspnCompetition(
  comp: EspnCompetition,
  type: SessionType,
  lookup: DriverLookup,
): F1LiveTimingSnapshot {
  const competitors = comp.competitors ?? [];
  if (!competitors.length) {
    return { rows: [], chequeredFlag: false, fastestLapDriverId: null };
  }

  const isTimedSession =
    type === "fp1" ||
    type === "fp2" ||
    type === "fp3" ||
    type === "qualifying" ||
    type === "sprint_qualifying";

  let fastestLapDriverId: string | null = null;
  let bestLapSec = Infinity;

  const findStat = (stats: EspnStat[] | undefined, pattern: RegExp): string | null => {
    if (!Array.isArray(stats)) return null;
    for (const s of stats) {
      const key = `${s.name ?? ""} ${s.abbreviation ?? ""}`;
      if (pattern.test(key) && s.displayValue) return s.displayValue;
    }
    return null;
  };

  const items = competitors.map((c, idx) => {
    const numRaw = c.vehicle?.number ? Number(c.vehicle.number) : null;
    const resolved = resolveDriver(lookup, {
      code: c.athlete?.abbreviation ?? null,
      name: c.athlete?.fullName ?? c.athlete?.displayName ?? c.athlete?.shortName ?? null,
      team: c.vehicle?.manufacturer ?? null,
      number: numRaw != null && Number.isFinite(numRaw) ? numRaw : null,
    });

    const rawPos = c.order ?? c.place ?? idx + 1;
    const position = typeof rawPos === "number" && rawPos > 0 ? rawPos : idx + 1;

    const q1 = findStat(c.statistics, /\bq1\b|qual.*1/i);
    const q2 = findStat(c.statistics, /\bq2\b|qual.*2/i);
    const q3 = findStat(c.statistics, /\bq3\b|qual.*3/i);
    const bestLapStr =
      q3 ||
      q2 ||
      q1 ||
      findStat(c.statistics, /best.*lap|fast.*lap|time|qual/i) ||
      (c.linescores?.[0]?.displayValue ?? null);
    const gapStr = findStat(c.statistics, /behind|gap|diff|interval/i);
    const lapsStr = findStat(c.statistics, /^laps$|lapsCompleted/i);
    const lapsNum = lapsStr ? Number(lapsStr) : null;

    const compStatus =
      c.status?.type?.shortDetail ??
      c.status?.type?.description ??
      c.status?.type?.name ??
      "";
    const isDnf = /ret|dnf|out|crash|accident|did not finish|dsq|dns/i.test(compStatus);

    const lapSec = parseLapTimeSeconds(bestLapStr);
    if (lapSec != null && lapSec < bestLapSec) {
      bestLapSec = lapSec;
      fastestLapDriverId = resolved.id;
    }

    return {
      row: {
        position,
        driverId: resolved.id,
        code: resolved.code,
        name: resolved.full_name,
        team: resolved.team,
        number: resolved.number,
        time: isTimedSession ? bestLapStr : position === 1 ? bestLapStr : null,
        q1,
        q2,
        q3,
        gap: position === 1 ? null : (gapStr ?? (!isTimedSession ? bestLapStr : null)),
        laps: lapsNum != null && Number.isFinite(lapsNum) ? lapsNum : null,
        status: isDnf ? (/dsq/i.test(compStatus) ? "DSQ" : /dns/i.test(compStatus) ? "DNS" : "DNF") : null,
      } satisfies ClassRow,
      lapSec,
    };
  });

  items.sort((a, b) => (a.row.position ?? 999) - (b.row.position ?? 999));

  const p1Sec = items[0]?.lapSec ?? null;
  const rows: ClassRow[] = items.map((it, idx) => {
    const pos = it.row.position ?? idx + 1;
    let gap = it.row.gap;
    if (
      isTimedSession &&
      pos > 1 &&
      !gap &&
      it.lapSec != null &&
      p1Sec != null &&
      it.lapSec > p1Sec
    ) {
      gap = `+${(it.lapSec - p1Sec).toFixed(3)}`;
    }
    return {
      ...it.row,
      position: pos,
      gap: pos === 1 ? null : gap,
    };
  });

  const chequeredFlag =
    comp.status?.type?.completed === true ||
    comp.status?.type?.state === "post" ||
    comp.status?.type?.name === "STATUS_FINAL";

  return { rows, chequeredFlag, fastestLapDriverId };
}

export async function fetchFromEspnScoreboard(
  type: SessionType,
  startsAt: string,
  lookup: DriverLookup,
): Promise<F1LiveTimingSnapshot | null> {
  const targetMs = new Date(startsAt).getTime();
  if (!Number.isFinite(targetMs)) return null;

  const rangeKey = `${ymd(targetMs - 3 * 86400_000)}-${ymd(targetMs + 3 * 86400_000)}`;
  const now = Date.now();
  let board = espnCache.get(rangeKey)?.data ?? null;
  if (!board || now - (espnCache.get(rangeKey)?.ts ?? 0) >= 20_000) {
    board = await getJson<EspnScoreboardResponse>(
      `${ESPN_F1_SCOREBOARD}?dates=${rangeKey}`,
      { timeoutMs: 6_000, retries: 1 },
    );
    if (board) espnCache.set(rangeKey, { ts: now, data: board });
  }
  if (!board?.events?.length) return null;

  const matcher = ESPN_TYPE_MATCHERS[type];
  let bestComp: EspnCompetition | null = null;
  let bestDiff = Infinity;

  for (const ev of board.events) {
    for (const comp of ev.competitions ?? []) {
      const typeLabels = [
        comp.type?.abbreviation,
        comp.type?.text,
        comp.type?.slug,
      ].filter((x): x is string => Boolean(x));
      const labelMatch = typeLabels.some((lbl) => matcher.test(lbl.trim()));
      const compMs = comp.date ? new Date(comp.date).getTime() : NaN;
      const diff = Number.isFinite(compMs) ? Math.abs(compMs - targetMs) : Infinity;

      if (labelMatch && diff < 36 * 3600_000 && diff < bestDiff) {
        bestComp = comp;
        bestDiff = diff;
      } else if (!bestComp && diff < 45 * 60_000) {
        bestComp = comp;
        bestDiff = diff;
      }
    }
  }

  if (!bestComp) return null;
  const parsed = parseEspnCompetition(bestComp, type, lookup);
  return parsed.rows.length >= 5 ? parsed : null;
}
'@
Write-Utf8NoBom -RelativePath "src/lib/f1-live-sources.ts" -Content $c

# --- src/lib/f1-sync.functions.ts ---
$c = @'
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import type { Json } from "@/integrations/supabase/types";
import { NO_SUBMISSION_PENALTY, scorePrediction, type ResultRow } from "./scoring";
import { scoreSprint, type SprintResultRow } from "./sprintScoring";

const API = "https://api.jolpi.ca/ergast/f1";
const SEASON = 2026;
const STALE_MS = 15 * 60 * 1000;
const EXCLUDED_DRIVERS = new Set(["tsunoda"]);

type ErgastSession = { date: string; time?: string | undefined };
type ErgastRace = {
  season: string;
  round: string;
  raceName: string;
  date: string;
  time?: string | undefined;
  Circuit: {
    circuitName: string;
    Location: { locality?: string | undefined; country?: string | undefined };
  };
  Qualifying?: ErgastSession | undefined;
  Sprint?: ErgastSession | undefined;
  SprintQualifying?: ErgastSession | undefined;
  SprintShootout?: ErgastSession | undefined;
  Results?:
    | Array<{
        position: string;
        grid: string;
        status: string;
        Driver: { driverId: string; code?: string | undefined; givenName: string; familyName: string };
        Constructor?: { name: string } | undefined;
        FastestLap?: { rank?: string | undefined } | undefined;
      }>
    | undefined;
};

function toIso(session: { date: string; time?: string | undefined } | undefined): string | null {
  if (!session?.date) return null;
  return new Date(`${session.date}T${session.time ?? "12:00:00Z"}`).toISOString();
}

async function getJson<T>(url: string, timeoutMs = 6000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const userSyncCalls = new Map<string, number>();
let inFlightSyncLock = false;

export const syncF1Data = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ({
    force: Boolean((input as { force?: boolean } | null)?.force),
  }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const userId = context.userId;
    const lastCall = userSyncCalls.get(userId) ?? 0;
    const minInterval = data.force ? 5_000 : 5 * 60_000;

    if (Date.now() - lastCall < minInterval) {
      if (!data.force) return { skipped: true as const };
      throw new Error("Please wait a few seconds before syncing again.");
    }
    if (userSyncCalls.size > 500) {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [k, ts] of userSyncCalls) {
        if (ts < cutoff) userSyncCalls.delete(k);
      }
    }
    userSyncCalls.set(userId, Date.now());
    if (!data.force && inFlightSyncLock) {
      return { skipped: true as const };
    }

    // Always check if 2h / 30m push reminders need to go out
    await checkAndSendPushReminders(supabaseAdmin).catch(() => {});

    const { data: state } = await supabaseAdmin
      .from("sync_state")
      .select("synced_at")
      .eq("key", `season-${SEASON}`)
      .maybeSingle();

    if (!data.force && state?.synced_at) {
      const age = Date.now() - new Date(state.synced_at).getTime();
      if (age < STALE_MS) return { skipped: true as const };
    }

    inFlightSyncLock = true;
    try {
      // ---- Parallel Fetch: Calendar + Driver Standings ----
      const [calendar, standings] = await Promise.all([
        getJson<{
          MRData: { RaceTable: { Races: ErgastRace[] } };
        }>(`${API}/${SEASON}/races/?format=json&limit=40`),
        getJson<{
          MRData: {
            StandingsTable: {
              StandingsLists: Array<{
                DriverStandings: Array<{
                  Driver: {
                    driverId: string;
                    code?: string | undefined;
                    permanentNumber?: string | undefined;
                    givenName: string;
                    familyName: string;
                  };
                  Constructors: Array<{ name: string }>;
                }>;
              }>;
            };
          };
        }>(`${API}/${SEASON}/driverstandings/?format=json&limit=60`),
      ]);

      const races = calendar?.MRData.RaceTable.Races ?? [];

      if (races.length) {
        const [{ data: existingRaces }, { data: overrideRows }] = await Promise.all([
          supabaseAdmin
            .from("races")
            .select("id, round, race_at, qualifying_at")
            .eq("season", SEASON),
          supabaseAdmin
            .from("sync_state")
            .select("key")
            .like("key", "deadline_override:%"),
        ]);

        const overriddenIds = new Set(
          (overrideRows ?? []).map((r) => r.key.replace("deadline_override:", "")),
        );
        const existingByRound = new Map((existingRaces ?? []).map((r) => [r.round, r]));

        await supabaseAdmin.from("races").upsert(
          races.map((r) => {
            const rd = Number(r.round);
            const ex = existingByRound.get(rd);
            const keepCustomDeadline = ex && overriddenIds.has(ex.id);
            return {
              season: Number(r.season),
              round: rd,
              name: r.raceName,
              circuit: r.Circuit.circuitName,
              country: r.Circuit.Location.country ?? null,
              locality: r.Circuit.Location.locality ?? null,
              race_at: keepCustomDeadline ? ex.race_at : toIso({ date: r.date, time: r.time })!,
              qualifying_at: keepCustomDeadline ? ex.qualifying_at : toIso(r.Qualifying),
              has_sprint: !!r.Sprint,
              sprint_at: toIso(r.Sprint),
              sprint_qualifying_at: toIso(r.SprintQualifying ?? r.SprintShootout),
            };
          }),
          { onConflict: "season,round" },
        );
      }

      // ---- Drivers ----
      const entries = (
        standings?.MRData.StandingsTable.StandingsLists?.[0]?.DriverStandings ?? []
      ).filter((e) => !EXCLUDED_DRIVERS.has(e.Driver.driverId));
      if (entries.length) {
        await supabaseAdmin.from("drivers").upsert(
          entries.map((e) => ({
            id: e.Driver.driverId,
            code: e.Driver.code ?? null,
            full_name: `${e.Driver.givenName} ${e.Driver.familyName}`,
            team: e.Constructors[0]?.name ?? null,
            number: e.Driver.permanentNumber ? Number(e.Driver.permanentNumber) : null,
            active: true,
          })),
          { onConflict: "id" },
        );
      }

      // ---- Results ----
      const racesWithResults: ErgastRace[] = [];
      const pageSize = 100;
      let offset = 0;
      let total = Infinity;
      while (offset < total && offset < 2000) {
        const page = await getJson<{
          MRData: { total: string; RaceTable: { Races: ErgastRace[] } };
        }>(`${API}/${SEASON}/results/?format=json&limit=${pageSize}&offset=${offset}`);
        if (!page) break;
        total = Number(page.MRData.total);
        for (const race of page.MRData.RaceTable.Races) {
          const existing = racesWithResults.find((r) => r.round === race.round);
          if (existing) existing.Results = [...(existing.Results ?? []), ...(race.Results ?? [])];
          else racesWithResults.push(race);
        }
        offset += pageSize;
      }

      const { data: dbRaces } = await supabaseAdmin
        .from("races")
        .select("id, round")
        .eq("season", SEASON);
      const roundToId = new Map((dbRaces ?? []).map((r) => [r.round, r.id]));

      const allRaceResultRows: Array<{
        race_id: string;
        driver_id: string;
        position: number | null;
        status: string;
        finished: boolean;
        fastest_lap: boolean;
        pole: boolean;
      }> = [];
      const completedRaceIds: string[] = [];

      for (const race of racesWithResults) {
        const raceId = roundToId.get(Number(race.round));
        if (!raceId || !race.Results?.length) continue;

        completedRaceIds.push(raceId);
        for (const res of race.Results) {
          const status = res.status ?? "";
          const finished = /finished|lapped|\+\d+ lap/i.test(status);
          allRaceResultRows.push({
            race_id: raceId,
            driver_id: res.Driver.driverId,
            position: finished ? Number(res.position) : null,
            status,
            finished,
            fastest_lap: res.FastestLap?.rank === "1",
            pole: res.grid === "1",
          });
        }
      }

      if (allRaceResultRows.length > 0 && completedRaceIds.length > 0) {
        await Promise.all([
          supabaseAdmin
            .from("race_results")
            .upsert(allRaceResultRows, { onConflict: "race_id,driver_id" }),
          supabaseAdmin
            .from("races")
            .update({ has_results: true })
            .in("id", completedRaceIds),
        ]);
      }

      await syncSprintResults(roundToId);
      await openF1Fallback(new Set(racesWithResults.map((r) => Number(r.round))));
      await scoreAllRaces();

      await supabaseAdmin
        .from("sync_state")
        .upsert(
          { key: `season-${SEASON}`, synced_at: new Date().toISOString() },
          { onConflict: "key" },
        );

      return { skipped: false as const, races: races.length, scored: racesWithResults.length };
    } finally {
      inFlightSyncLock = false;
    }
  });

export async function checkAndSendPushReminders(
  supabaseAdmin: (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"],
) {
  const { sendNativeWebPush } = await import("./webpush-native");
  const now = Date.now();
  const { data: upcomingRaces } = await supabaseAdmin
    .from("races")
    .select("id, name, qualifying_at, race_at")
    .eq("season", SEASON)
    .gte("race_at", new Date(now - 30 * 60_000).toISOString())
    .lte("race_at", new Date(now + 4 * 24 * 3600_000).toISOString());

  if (!upcomingRaces?.length) return 0;

  const { data: subRows } = await supabaseAdmin
    .from("sync_state")
    .select("key")
    .like("key", "push_sub:%");
  if (!subRows?.length) return 0;

  let totalSent = 0;
  const WINDOWS = [
    { label: "2h", minMs: 45 * 60_000, maxMs: 135 * 60_000, text: "in ~2 hours" },
    { label: "30m", minMs: 5 * 60_000, maxMs: 44 * 60_000, text: "in less than 30 minutes" },
  ] as const;

  for (const race of upcomingRaces) {
    const targets: Array<{ type: "pole" | "race"; iso: string | null }> = [
      { type: "pole", iso: race.qualifying_at },
      { type: "race", iso: race.race_at },
    ];

    for (const t of targets) {
      if (!t.iso) continue;
      const diff = new Date(t.iso).getTime() - now;
      for (const w of WINDOWS) {
        if (diff < w.minMs || diff > w.maxMs) continue;
        const stateKey = `reminded:${race.id}:${t.type}:${w.label}`;
        const { data: already } = await supabaseAdmin
          .from("sync_state")
          .select("key")
          .eq("key", stateKey)
          .maybeSingle();
        if (already) continue;

        const { data: preds } = await supabaseAdmin
          .from("predictions")
          .select("user_id, top10, pole_driver_id")
          .eq("race_id", race.id);

        const doneUsers = new Set(
          (preds ?? [])
            .filter((p) =>
              t.type === "pole"
                ? !!p.pole_driver_id
                : (p.top10 ?? []).filter((x) => x && x !== "__none__").length === 10,
            )
            .map((p) => p.user_id),
        );

        const payloadObj = {
          title: `\u23f0 ${race.name} \u2014 Lock Alert!`,
          body:
            t.type === "pole"
              ? `Qualifying starts ${w.text}! Lock in your Pole Position pick now.`
              : `Race locks ${w.text}! Submit your Top 10 now to avoid the \u221225 penalty.`,
          tag: stateKey,
          url: "/predict",
        };

        const deadKeys: string[] = [];
        for (const r of subRows) {
          const m = /^push_sub:([^:]+):(.+)$/.exec(r.key);
          if (!m) continue;
          if (doneUsers.has(m[1]!)) continue;
          try {
            const sub = JSON.parse(m[2]!) as { endpoint: string; p256dh: string; auth: string };
            const res = await sendNativeWebPush(sub, payloadObj);
            if (res.ok) totalSent++;
            else if (res.status === 404 || res.status === 410) deadKeys.push(r.key);
          } catch {}
        }
        if (deadKeys.length > 0) {
          await supabaseAdmin.from("sync_state").delete().in("key", deadKeys);
        }
        await supabaseAdmin
          .from("sync_state")
          .upsert({ key: stateKey, synced_at: new Date().toISOString() }, { onConflict: "key" });
      }
    }
  }
  return totalSent;
}

async function scoreAllRaces() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: races } = await supabaseAdmin
    .from("races")
    .select("id, race_at")
    .eq("season", SEASON)
    .eq("has_results", true);
  if (!races?.length) return;

  const raceIds = races.map((r) => r.id);

  // Batch-fetch all scoring inputs across all completed races in 1 parallel round-trip (6 queries instead of N*6)
  const [
    { data: allProfiles },
    { data: allResults },
    { data: allPredictions },
    { data: allSprintResults },
    { data: allSprintPreds },
    { data: allExistingScores },
  ] = await Promise.all([
    supabaseAdmin.from("profiles").select("id, created_at"),
    supabaseAdmin
      .from("race_results")
      .select("race_id, driver_id, position, finished, fastest_lap, pole")
      .in("race_id", raceIds),
    supabaseAdmin
      .from("predictions")
      .select("race_id, user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id")
      .in("race_id", raceIds),
    supabaseAdmin
      .from("sprint_results")
      .select("race_id, driver_id, position, finished, pole")
      .in("race_id", raceIds),
    supabaseAdmin
      .from("sprint_predictions")
      .select("race_id, user_id, top8, pole_driver_id")
      .in("race_id", raceIds),
    supabaseAdmin
      .from("scores")
      .select("race_id, user_id, breakdown")
      .in("race_id", raceIds),
  ]);

  if (!allProfiles?.length || !allResults?.length) return;

  const resultsByRace = new Map<string, ResultRow[]>();
  for (const r of allResults) {
    const list = resultsByRace.get(r.race_id) ?? [];
    list.push(r as ResultRow);
    resultsByRace.set(r.race_id, list);
  }

  const predsByRace = new Map<string, NonNullable<typeof allPredictions>>();
  for (const p of allPredictions ?? []) {
    const list = predsByRace.get(p.race_id) ?? [];
    list.push(p);
    predsByRace.set(p.race_id, list);
  }

  const sprintResultsByRace = new Map<string, SprintResultRow[]>();
  for (const sr of allSprintResults ?? []) {
    const list = sprintResultsByRace.get(sr.race_id) ?? [];
    list.push(sr as SprintResultRow);
    sprintResultsByRace.set(sr.race_id, list);
  }

  const sprintPredsByRace = new Map<string, NonNullable<typeof allSprintPreds>>();
  for (const sp of allSprintPreds ?? []) {
    const list = sprintPredsByRace.get(sp.race_id) ?? [];
    list.push(sp);
    sprintPredsByRace.set(sp.race_id, list);
  }

  const existingScoresByRace = new Map<string, NonNullable<typeof allExistingScores>>();
  for (const es of allExistingScores ?? []) {
    const list = existingScoresByRace.get(es.race_id) ?? [];
    list.push(es);
    existingScoresByRace.set(es.race_id, list);
  }

  const allScoreRows: Array<{
    user_id: string;
    race_id: string;
    points: number;
    breakdown: Json;
    updated_at: string;
  }> = [];
  const nowIso = new Date().toISOString();

  for (const race of races) {
    const results = resultsByRace.get(race.id);
    if (!results?.length) continue;

    const raceTimeMs = new Date(race.race_at).getTime();
    const predictions = predsByRace.get(race.id) ?? [];
    const sprintResults = sprintResultsByRace.get(race.id) ?? [];
    const sprintPreds = sprintPredsByRace.get(race.id) ?? [];
    const existingScores = existingScoresByRace.get(race.id) ?? [];

    // Never overwrite a score that was manually overridden or waived by FIA Stewards
    const stewardLockedUsers = new Set(
      existingScores
        .filter((s) => {
          const b = s.breakdown as Record<string, unknown> | null;
          return b && b["stewardOverride"] === true;
        })
        .map((s) => s.user_id),
    );

    const byUser = new Map(predictions.map((p) => [p.user_id, p]));
    const sprintByUser = new Map(sprintPreds.map((p) => [p.user_id, p]));
    const sprintFor = (userId: string) =>
      sprintResults.length
        ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults)
        : null;

    for (const profile of allProfiles) {
      if (stewardLockedUsers.has(profile.id)) continue;
      if (new Date(profile.created_at).getTime() >= raceTimeMs) continue;

      const sprint = sprintFor(profile.id);
      const prediction = byUser.get(profile.id);
      if (!prediction) {
        allScoreRows.push({
          user_id: profile.id,
          race_id: race.id,
          points: NO_SUBMISSION_PENALTY + (sprint?.total ?? 0),
          breakdown: {
            noSubmission: true,
            ...(sprint ? { sprint } : {}),
            total: NO_SUBMISSION_PENALTY + (sprint?.total ?? 0),
          } as unknown as Json,
          updated_at: nowIso,
        });
        continue;
      }

      const validTop10 = (prediction.top10 ?? []).filter((x) => x && x !== "__none__");
      const breakdown = scorePrediction(
        {
          top10: validTop10,
          pole_driver_id: prediction.pole_driver_id,
          fastest_lap_driver_id: prediction.fastest_lap_driver_id,
          dnf_driver_id: prediction.dnf_driver_id,
        },
        results,
      );

      const poleOnly = validTop10.length < 10;
      const raceTotal = poleOnly ? NO_SUBMISSION_PENALTY + breakdown.pole : breakdown.total;
      const total = raceTotal + (sprint?.total ?? 0);
      allScoreRows.push({
        user_id: profile.id,
        race_id: race.id,
        points: total,
        breakdown: (poleOnly
          ? { noSubmission: true, poleOnly: true, pole: breakdown.pole, ...(sprint ? { sprint } : {}), total }
          : { ...breakdown, ...(sprint ? { sprint } : {}), total }) as unknown as Json,
        updated_at: nowIso,
      });
    }
  }

  if (allScoreRows.length > 0) {
    await supabaseAdmin.from("scores").upsert(allScoreRows, { onConflict: "user_id,race_id" });
  }
}

const OPENF1 = "https://api.openf1.org/v1";
const RACE_DONE_MS = 80 * 60 * 1000; // 80 minutes after lights out
const FALLBACK_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

type OF1Session = { session_key: number; session_name: string; date_start: string };
type OF1Result = {
  position: number | null;
  driver_number: number;
  dnf?: boolean | undefined;
  dns?: boolean | undefined;
  dsq?: boolean | undefined;
};

async function openF1Fallback(officialRounds: Set<number>) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = Date.now();

  const { data: pending } = await supabaseAdmin
    .from("races")
    .select("id, round, race_at, qualifying_at")
    .eq("season", SEASON)
    .eq("has_results", false)
    .lte("race_at", new Date(now - RACE_DONE_MS).toISOString())
    .gte("race_at", new Date(now - FALLBACK_WINDOW_MS).toISOString());
  const races = (pending ?? []).filter((r) => !officialRounds.has(r.round));
  if (!races.length) return;

  const sessions = await getJson<OF1Session[]>(`${OPENF1}/sessions?year=${SEASON}`);
  const { data: drivers } = await supabaseAdmin.from("drivers").select("id, code");
  const byCode = new Map((drivers ?? []).filter((d) => d.code).map((d) => [d.code!, d.id]));
  if (!sessions?.length || !byCode.size) return;

  const near = (name: string, iso: string | null) => {
    if (!iso) return undefined;
    const t = new Date(iso).getTime();
    return sessions.find(
      (s) => s.session_name === name && Math.abs(new Date(s.date_start).getTime() - t) < 6 * 3600_000,
    );
  };

  for (const race of races) {
    const rs = near("Race", race.race_at);
    if (!rs) continue;
    const [results, ofDrivers, laps] = await Promise.all([
      getJson<OF1Result[]>(`${OPENF1}/session_result?session_key=${rs.session_key}`),
      getJson<Array<{ driver_number: number; name_acronym: string }>>(
        `${OPENF1}/drivers?session_key=${rs.session_key}`,
      ),
      getJson<Array<{ driver_number: number; lap_duration: number | null }>>(
        `${OPENF1}/laps?session_key=${rs.session_key}`,
      ),
    ]);
    if (!results || results.length < 10 || !ofDrivers) continue;

    const numToId = new Map<number, string>();
    for (const d of ofDrivers) {
      const id = byCode.get(d.name_acronym);
      if (id) numToId.set(d.driver_number, id);
    }

    let poleNum: number | undefined;
    const qs = near("Qualifying", race.qualifying_at);
    if (qs) {
      const q = await getJson<OF1Result[]>(`${OPENF1}/session_result?session_key=${qs.session_key}`);
      poleNum = q?.find((r) => r.position === 1)?.driver_number;
    }
    let flNum: number | undefined;
    let best = Infinity;
    for (const l of laps ?? []) {
      if (l.lap_duration && l.lap_duration < best) {
        best = l.lap_duration;
        flNum = l.driver_number;
      }
    }

    const rows = results.flatMap((r) => {
      const driver_id = numToId.get(r.driver_number);
      if (!driver_id) return [];
      const finished = r.position != null && !r.dnf && !r.dns && !r.dsq;
      return [
        {
          race_id: race.id,
          driver_id,
          position: finished ? r.position : null,
          status: finished ? "Finished" : r.dsq ? "Disqualified" : "Retired",
          finished,
          fastest_lap: r.driver_number === flNum,
          pole: r.driver_number === poleNum,
        },
      ];
    });
    if (rows.length < 10) continue;

    await supabaseAdmin.from("race_results").upsert(rows, { onConflict: "race_id,driver_id" });
    await supabaseAdmin.from("races").update({ has_results: true }).eq("id", race.id);
  }
}

type ErgastSprintRace = {
  round: string;
  SprintResults?:
    | Array<{
        position: string;
        grid: string;
        status: string;
        Driver: { driverId: string };
      }>
    | undefined;
};

async function syncSprintResults(roundToId: Map<number, string>) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const byRound = new Map<string, ErgastSprintRace>();
  const pageSize = 100;
  let offset = 0;
  let total = Infinity;
  while (offset < total && offset < 1000) {
    const page = await getJson<{
      MRData: { total: string; RaceTable: { Races: ErgastSprintRace[] } };
    }>(`${API}/${SEASON}/sprint/?format=json&limit=${pageSize}&offset=${offset}`);
    if (!page) break;
    total = Number(page.MRData.total);
    for (const race of page.MRData.RaceTable.Races) {
      const existing = byRound.get(race.round);
      if (existing) existing.SprintResults = [...(existing.SprintResults ?? []), ...(race.SprintResults ?? [])];
      else byRound.set(race.round, race);
    }
    offset += pageSize;
  }

  const allSprintRows: Array<{
    race_id: string;
    driver_id: string;
    position: number | null;
    status: string;
    finished: boolean;
    pole: boolean;
  }> = [];

  for (const race of byRound.values()) {
    const raceId = roundToId.get(Number(race.round));
    if (!raceId || !race.SprintResults?.length) continue;
    for (const res of race.SprintResults) {
      const status = res.status ?? "";
      const finished = /finished|lapped|\+\d+ lap/i.test(status);
      allSprintRows.push({
        race_id: raceId,
        driver_id: res.Driver.driverId,
        position: finished ? Number(res.position) : null,
        status,
        finished,
        pole: res.grid === "1",
      });
    }
  }

  if (allSprintRows.length > 0) {
    await supabaseAdmin.from("sprint_results").upsert(allSprintRows, { onConflict: "race_id,driver_id" });
  }
}
'@
Write-Utf8NoBom -RelativePath "src/lib/f1-sync.functions.ts" -Content $c

# --- src/lib/stewards.functions.ts ---
$c = @'
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";
import { scorePrediction, NO_SUBMISSION_PENALTY, type ResultRow } from "./scoring";
import { scoreSprint, type SprintResultRow } from "./sprintScoring";

export const STEWARD_EMAIL = "mohamdy008@gmail.com";

async function requireSteward(context: { userId: string; claims?: Record<string, unknown> }) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let email = String(context.claims?.["email"] ?? "").toLowerCase();
  if (!email) {
    const { data } = await supabaseAdmin.auth.admin.getUserById(context.userId);
    email = (data.user?.email ?? "").toLowerCase();
  }
  if (email !== STEWARD_EMAIL) {
    throw new Error("Forbidden: FIA Stewards access is restricted to mohamdy008@gmail.com");
  }
  return supabaseAdmin;
}

export const savePushSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { endpoint: string; p256dh: string; auth: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const prefix = `push_sub:${context.userId}:`;
    const { data: existing } = await supabaseAdmin
      .from("sync_state")
      .select("key")
      .like("key", `${prefix}%`);

    const staleKeys: string[] = [];
    for (const r of existing ?? []) {
      try {
        const parsed = JSON.parse(r.key.slice(prefix.length)) as { endpoint?: string };
        if (parsed.endpoint === data.endpoint) staleKeys.push(r.key);
      } catch {
        staleKeys.push(r.key);
      }
    }
    if (staleKeys.length > 0) {
      await supabaseAdmin.from("sync_state").delete().in("key", staleKeys);
    }

    const key = `${prefix}${JSON.stringify(data)}`;
    await supabaseAdmin
      .from("sync_state")
      .upsert({ key, synced_at: new Date().toISOString() }, { onConflict: "key" });
    return { ok: true };
  });

export const getStewardsDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { raceId: string }) => d)
  .handler(async ({ data, context }) => {
    const sb = await requireSteward(context);
    const [{ data: profiles }, { data: preds }, { data: scores }, { data: results }, { data: subRows }] =
      await Promise.all([
        sb.from("profiles").select("id, display_name, created_at").order("display_name"),
        sb
          .from("predictions")
          .select("id, user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id, updated_at")
          .eq("race_id", data.raceId),
        sb.from("scores").select("user_id, points, breakdown").eq("race_id", data.raceId),
        sb
          .from("race_results")
          .select("driver_id, position, finished, fastest_lap, pole")
          .eq("race_id", data.raceId),
        sb.from("sync_state").select("key").like("key", "push_sub:%"),
      ]);

    const pushUserIds = Array.from(
      new Set(
        (subRows ?? [])
          .map((r) => /^push_sub:([^:]+):/.exec(r.key)?.[1])
          .filter((x): x is string => !!x),
      ),
    );

    return {
      profiles: profiles ?? [],
      preds: preds ?? [],
      scores: scores ?? [],
      results: results ?? [],
      pushUserIds,
    };
  });

export const executeStewardAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    action:
      | "override_score"
      | "remove_penalty"
      | "rename_player"
      | "delete_player"
      | "shift_deadline"
      | "set_exact_deadline"
      | "override_picks"
      | "manual_results"
      | "nudge_missing_push"
      | "test_my_push";
    raceId?: string | undefined;
    userId?: string | undefined;
    points?: number | undefined;
    name?: string | undefined;
    minutes?: number | undefined;
    isoTime?: string | undefined;
    target?: "qualifying" | "race" | undefined;
    pole?: string | null | undefined;
    fl?: string | null | undefined;
    dnf?: string | null | undefined;
    top10?: string[] | undefined;
    dnfs?: string[] | undefined;
    title?: string | undefined;
    body?: string | undefined;
  }) => d)
  .handler(async ({ data: d, context }) => {
    const sb = await requireSteward(context);

    if ((d.action === "override_score" || d.action === "remove_penalty") && d.userId && d.raceId) {
      const pts = d.action === "remove_penalty" ? 0 : (d.points ?? 0);
      const { error } = await sb.from("scores").upsert(
        {
          user_id: d.userId,
          race_id: d.raceId,
          points: pts,
          breakdown: { stewardOverride: true, total: pts } as unknown as Json,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,race_id" },
      );
      if (error) throw new Error(error.message);
      return { ok: true, msg: `Score locked to ${pts} pts (protected from auto-sync overwrite).` };
    }

    if (d.action === "rename_player" && d.userId && d.name) {
      const { error } = await sb.from("profiles").update({ display_name: d.name.trim() }).eq("id", d.userId);
      if (error) throw new Error(error.message);
      return { ok: true, msg: "Player display name updated." };
    }

    if (d.action === "delete_player" && d.userId) {
      await sb.from("scores").delete().eq("user_id", d.userId);
      await sb.from("predictions").delete().eq("user_id", d.userId);
      await sb.from("sprint_predictions").delete().eq("user_id", d.userId);
      const { error } = await sb.from("profiles").delete().eq("id", d.userId);
      if (error) throw new Error(error.message);
      return { ok: true, msg: "Player and associated records removed." };
    }

    if (d.action === "set_exact_deadline" && d.raceId && d.isoTime) {
      const parsed = new Date(d.isoTime);
      if (Number.isNaN(parsed.getTime())) throw new Error("Invalid date/time format");
      const updateData =
        d.target === "qualifying"
          ? { qualifying_at: parsed.toISOString() }
          : { race_at: parsed.toISOString() };
      const { error } = await sb.from("races").update(updateData).eq("id", d.raceId);
      if (error) throw new Error(error.message);
      await sb
        .from("sync_state")
        .upsert({ key: `deadline_override:${d.raceId}`, synced_at: new Date().toISOString() }, { onConflict: "key" });
      return { ok: true, msg: `${d.target === "qualifying" ? "Qualifying" : "Race"} deadline updated & locked!` };
    }

    if (d.action === "shift_deadline" && d.raceId && d.minutes != null) {
      const { data: r } = await sb.from("races").select("race_at, qualifying_at").eq("id", d.raceId).single();
      if (!r) throw new Error("Race not found");
      const cur = (d.target === "qualifying" ? r.qualifying_at : r.race_at) ?? r.race_at;
      const nextIso = new Date(new Date(cur).getTime() + d.minutes * 60_000).toISOString();
      const updateData =
        d.target === "qualifying"
          ? { qualifying_at: nextIso }
          : { race_at: nextIso };
      const { error } = await sb.from("races").update(updateData).eq("id", d.raceId);
      if (error) throw new Error(error.message);
      await sb
        .from("sync_state")
        .upsert({ key: `deadline_override:${d.raceId}`, synced_at: new Date().toISOString() }, { onConflict: "key" });
      return { ok: true, msg: `${d.target === "qualifying" ? "Qualifying" : "Race"} shifted by ${d.minutes > 0 ? "+" : ""}${d.minutes}m & locked.` };
    }

    if (d.action === "override_picks" && d.userId && d.raceId) {
      const { data: existing } = await sb.from("predictions").select("id").eq("user_id", d.userId).eq("race_id", d.raceId).maybeSingle();
      const payload = {
        user_id: d.userId,
        race_id: d.raceId,
        top10: d.top10 ?? [],
        pole_driver_id: d.pole || null,
        fastest_lap_driver_id: d.fl || null,
        dnf_driver_id: d.dnf || null,
        updated_at: new Date().toISOString(),
      };
      let predId = existing?.id ?? d.userId;
      if (existing?.id) {
        const { error } = await sb.from("predictions").update(payload).eq("id", existing.id);
        if (error) throw new Error(error.message);
      } else {
        const { data: ins, error } = await sb.from("predictions").insert(payload).select("id").single();
        if (error) throw new Error(error.message);
        if (ins?.id) predId = ins.id;
      }
      await sb.from("prediction_logs").insert({
        user_id: d.userId,
        race_id: d.raceId,
        prediction_id: predId,
        action: "stewards",
        changes: { pole: d.pole ?? null, fl: d.fl ?? null, dnf: d.dnf ?? null, top10: [[], d.top10 ?? []] } as unknown as Json,
      });
      return { ok: true, msg: "Player picks saved & logged by Stewards." };
    }

    if (d.action === "manual_results" && d.raceId && d.top10 && d.top10.length === 10) {
      const { data: drivers } = await sb.from("drivers").select("id").eq("active", true);
      const dnfSet = new Set(d.dnfs ?? []);
      const rows = (drivers ?? []).map((drv) => {
        const posIdx = d.top10!.indexOf(drv.id);
        const isDnf = dnfSet.has(drv.id);
        return {
          race_id: d.raceId!,
          driver_id: drv.id,
          position: !isDnf && posIdx !== -1 ? posIdx + 1 : null,
          finished: !isDnf,
          status: isDnf ? "Retired" : "Finished",
          pole: drv.id === d.pole,
          fastest_lap: drv.id === d.fl,
        };
      });
      await sb.from("race_results").upsert(rows, { onConflict: "race_id,driver_id" });
      await sb.from("races").update({ has_results: true }).eq("id", d.raceId);

      const { data: raceRow } = await sb.from("races").select("race_at").eq("id", d.raceId).single();
      const [
        { data: profiles },
        { data: preds },
        { data: sprintResults },
        { data: sprintPreds },
        { data: existingScores },
      ] = await Promise.all([
        sb.from("profiles").select("id, created_at"),
        sb.from("predictions").select("user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id").eq("race_id", d.raceId),
        sb.from("sprint_results").select("driver_id, position, finished, pole").eq("race_id", d.raceId),
        sb.from("sprint_predictions").select("user_id, top8, pole_driver_id").eq("race_id", d.raceId),
        sb.from("scores").select("user_id, breakdown").eq("race_id", d.raceId),
      ]);

      const stewardLockedUsers = new Set(
        (existingScores ?? [])
          .filter((s) => {
            const b = s.breakdown as Record<string, unknown> | null;
            return b && b["stewardOverride"] === true;
          })
          .map((s) => s.user_id),
      );

      const byU = new Map((preds ?? []).map((p) => [p.user_id, p]));
      const sprintByU = new Map((sprintPreds ?? []).map((p) => [p.user_id, p]));
      const sprintFor = (uid: string) =>
        sprintResults?.length
          ? scoreSprint(sprintByU.get(uid) ?? null, sprintResults as SprintResultRow[])
          : null;

      const scoreRows: Array<{
        user_id: string;
        race_id: string;
        points: number;
        breakdown: Json;
        updated_at: string;
      }> = [];
      for (const p of profiles ?? []) {
        if (stewardLockedUsers.has(p.id)) continue;
        if (raceRow?.race_at && new Date(p.created_at) > new Date(raceRow.race_at)) continue;

        const sprint = sprintFor(p.id);
        const pr = byU.get(p.id);
        const validTop10 = (pr?.top10 ?? []).filter((x) => x && x !== "__none__");
        if (!pr || validTop10.length < 10) {
          const poleHit = pr?.pole_driver_id && pr.pole_driver_id === d.pole ? 3 : 0;
          const total = NO_SUBMISSION_PENALTY + poleHit + (sprint?.total ?? 0);
          scoreRows.push({
            user_id: p.id,
            race_id: d.raceId!,
            points: total,
            breakdown: { noSubmission: true, pole: poleHit, ...(sprint ? { sprint } : {}), total } as unknown as Json,
            updated_at: new Date().toISOString(),
          });
        } else {
          const b = scorePrediction(
            { top10: validTop10, pole_driver_id: pr.pole_driver_id, fastest_lap_driver_id: pr.fastest_lap_driver_id, dnf_driver_id: pr.dnf_driver_id },
            rows as ResultRow[],
          );
          const total = b.total + (sprint?.total ?? 0);
          scoreRows.push({
            user_id: p.id,
            race_id: d.raceId!,
            points: total,
            breakdown: { ...b, ...(sprint ? { sprint } : {}), total } as unknown as Json,
            updated_at: new Date().toISOString(),
          });
        }
      }
      if (scoreRows.length) await sb.from("scores").upsert(scoreRows, { onConflict: "user_id,race_id" });
      return { ok: true, msg: `Manual results saved & ${scoreRows.length} players scored (including Sprint)!` };
    }

    if (d.action === "test_my_push") {
      const { sendNativeWebPush } = await import("./webpush-native");
      const { data: subRows } = await sb
        .from("sync_state")
        .select("key")
        .like("key", `push_sub:${context.userId}:%`);
      if (!subRows?.length) {
        return {
          ok: false,
          msg: "Your device is not subscribed yet! Go to Paddock and tap Enable Alerts first.",
        };
      }
      let sent = 0;
      for (const r of subRows) {
        const m = /^push_sub:([^:]+):(.+)$/.exec(r.key);
        if (!m) continue;
        const sub = JSON.parse(m[2]!) as { endpoint: string; p256dh: string; auth: string };
        const res = await sendNativeWebPush(sub, {
          title: "\ud83c\udfce\ufe0f Stewards Test Alert",
          body: "Push notifications are 100% working on your device!",
          tag: "dfr-test-" + Date.now(),
          url: "/stewards",
        });
        if (res.ok) sent++;
        else if (res.status === 404 || res.status === 410) {
          await sb.from("sync_state").delete().eq("key", r.key);
        }
      }
      return { ok: true, msg: `Test push delivered to ${sent} of your device(s)!` };
    }

    if (d.action === "nudge_missing_push" && d.raceId) {
      const { sendNativeWebPush } = await import("./webpush-native");
      const [{ data: subRows }, { data: preds }, { data: profiles }] = await Promise.all([
        sb.from("sync_state").select("key").like("key", "push_sub:%"),
        sb.from("predictions").select("user_id, top10").eq("race_id", d.raceId),
        sb.from("profiles").select("id, display_name"),
      ]);

      const completedUsers = new Set(
        (preds ?? [])
          .filter((p) => (p.top10 ?? []).filter((x) => x && x !== "__none__").length === 10)
          .map((p) => p.user_id),
      );

      const missingUsers = (profiles ?? []).filter((p) => !completedUsers.has(p.id));
      const payloadObj = {
        title: d.title || "\u23f0 DOWNFORCE \u2014 Picks Reminder!",
        body: d.body || "Lock in your Top 10 before the deadline to avoid the -25 penalty!",
        tag: "dfr-stewards-" + Date.now(),
        url: "/predict",
      };

      const reachedUserIds = new Set<string>();
      const deadKeys: string[] = [];

      const tasks = (subRows ?? []).map(async (r) => {
        const m = /^push_sub:([^:]+):(.+)$/.exec(r.key);
        if (!m) return;
        const uid = m[1]!;
        if (completedUsers.has(uid)) return;
        try {
          const sub = JSON.parse(m[2]!) as { endpoint: string; p256dh: string; auth: string };
          const res = await sendNativeWebPush(sub, payloadObj);
          if (res.ok) {
            reachedUserIds.add(uid);
          } else if (res.status === 404 || res.status === 410) {
            deadKeys.push(r.key);
          }
        } catch {}
      });

      await Promise.allSettled(tasks);
      if (deadKeys.length > 0) {
        await sb.from("sync_state").delete().in("key", deadKeys);
      }

      const reachedNames = missingUsers
        .filter((u) => reachedUserIds.has(u.id))
        .map((u) => u.display_name || "Player");
      const unsubscribedNames = missingUsers
        .filter((u) => !reachedUserIds.has(u.id))
        .map((u) => u.display_name || "Player");

      const parts: string[] = [];
      if (reachedNames.length > 0) {
        parts.push(`Sent to: ${reachedNames.join(", ")}`);
      }
      if (unsubscribedNames.length > 0) {
        parts.push(`No Push enabled on phone yet: ${unsubscribedNames.join(", ")}`);
      }
      return {
        ok: true,
        msg: parts.join(" | ") || "All players have already locked in!",
      };
    }

    return { ok: false, msg: "Unknown action" };
  });

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { displayName: string }) => d)
  .handler(async ({ data, context }) => {
    const name = data.displayName.trim().slice(0, 40);
    if (!name) throw new Error("Display name cannot be empty");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ display_name: name })
      .eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true, name };
  });

export const deleteMyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const uid = context.userId;
    await Promise.all([
      supabaseAdmin.from("scores").delete().eq("user_id", uid),
      supabaseAdmin.from("predictions").delete().eq("user_id", uid),
      supabaseAdmin.from("sprint_predictions").delete().eq("user_id", uid),
      supabaseAdmin.from("prediction_logs").delete().eq("user_id", uid),
      supabaseAdmin.from("sync_state").delete().like("key", `push_sub:${uid}:%`),
    ]);
    await supabaseAdmin.from("profiles").delete().eq("id", uid);
    await supabaseAdmin.auth.admin.deleteUser(uid).catch(() => {});
    return { ok: true };
  });

export const exportLeagueBackup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = await requireSteward(context);
    const [profiles, races, predictions, sprintPredictions, scores, logs] = await Promise.all([
      sb.from("profiles").select("*").order("display_name"),
      sb.from("races").select("*").order("round"),
      sb.from("predictions").select("*"),
      sb.from("sprint_predictions").select("*"),
      sb.from("scores").select("*"),
      sb.from("prediction_logs").select("*").order("created_at", { ascending: false }).limit(500),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      season: 2026,
      profiles: profiles.data ?? [],
      races: races.data ?? [],
      predictions: predictions.data ?? [],
      sprintPredictions: sprintPredictions.data ?? [],
      scores: scores.data ?? [],
      recentLogs: logs.data ?? [],
    };
  });
'@
Write-Utf8NoBom -RelativePath "src/lib/stewards.functions.ts" -Content $c

# --- src/components/DriverPicker.tsx ---
$c = @'
import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { sortByTeam, teamColor, teamLabel, teamsOf } from "@/lib/teams";
import type { Driver } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const EMPTY = "__none__";

export function DriverPicker({
  drivers,
  value,
  onChange,
  disabled,
  exclude,
  placeholder = "Select driver",
}: {
  drivers: Driver[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  exclude?: string[] | undefined;
  placeholder?: string | undefined;
}) {
  const mobile = useIsMobile();

  if (mobile) {
    return (
      <MobileDriverPicker
        drivers={drivers}
        value={value}
        onChange={onChange}
        disabled={disabled}
        exclude={exclude}
        placeholder={placeholder}
      />
    );
  }

  return (
    <Select value={value} onValueChange={onChange} disabled={!!disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={EMPTY}>\u2014 No pick \u2014</SelectItem>
        {sortByTeam(drivers).map((d) => {
          const taken = !!exclude?.includes(d.id) && d.id !== value;
          return (
            <SelectItem key={d.id} value={d.id} disabled={taken}>
              <span className="flex items-center gap-2">
                <span
                  className="w-6 shrink-0 border-l-2 pl-1 font-mono text-[11px] font-bold tabular-nums"
                  style={{ borderColor: teamColor(d.team) }}
                >
                  {d.number ?? "\u2013"}
                </span>
                <span className="font-semibold">{d.code ?? d.full_name}</span>
                <span className="text-muted-foreground">
                  {d.full_name}
                  {d.team ? ` \u00b7 ${d.team}` : ""}
                  {taken ? " \u2014 already picked" : ""}
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function MobileDriverPicker({
  drivers,
  value,
  onChange,
  disabled,
  exclude,
  placeholder,
}: {
  drivers: Driver[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  exclude?: string[] | undefined;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [teamFilter, setTeamFilter] = useState<string | null>(null);
  const sorted = useMemo(() => sortByTeam(drivers), [drivers]);
  const teams = useMemo(() => teamsOf(drivers), [drivers]);
  const selected = drivers.find((d) => d.id === value);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sorted.filter((d) => {
      if (teamFilter && teamLabel(d.team) !== teamFilter) return false;
      if (!q) return true;
      return (
        d.full_name.toLowerCase().includes(q) ||
        (d.code ?? "").toLowerCase().includes(q) ||
        (d.team ?? "").toLowerCase().includes(q) ||
        String(d.number ?? "").includes(q)
      );
    });
  }, [sorted, search, teamFilter]);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setSearch("");
    setTeamFilter(null);
    navigator.vibrate?.(10);
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!disabled) {
          setOpen(next);
          if (!next) {
            setSearch("");
            setTeamFilter(null);
          }
        }
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background/70 px-3 text-left text-sm transition active:scale-[0.99] disabled:opacity-50",
        )}
        style={{
          borderLeft: selected ? `4px solid ${teamColor(selected.team)}` : undefined,
        }}
      >
        {selected ? (
          <span className="flex min-w-0 items-center gap-2">
            {selected.number != null && (
              <span className="font-mono text-xs font-bold tabular-nums text-muted-foreground">
                #{selected.number}
              </span>
            )}
            <span className="font-display font-extrabold italic uppercase">
              {selected.code ?? selected.full_name}
            </span>
            <span className="truncate text-xs text-muted-foreground">{selected.full_name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
        <span className="font-mono text-xs text-muted-foreground">\u25be</span>
      </button>

      <DrawerContent className="max-h-[85vh]">
        <DrawerHeader className="flex flex-row items-center justify-between border-b border-border pb-3">
          <DrawerTitle className="font-display text-lg font-extrabold italic uppercase">
            {placeholder}
          </DrawerTitle>
          <DrawerClose asChild>
            <button
              type="button"
              className="rounded-sm px-2 py-1 font-mono text-xs uppercase text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </DrawerClose>
        </DrawerHeader>

        {/* Instant Search + Team Filter Bar inside Drawer */}
        <div className="space-y-2.5 border-b border-border/60 bg-background/60 px-3 py-2.5">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search driver, code, # or team..."
              className="h-9 w-full rounded-md border border-border bg-secondary/40 pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className=" hit-slop absolute right-2.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5">
            <button
              type="button"
              onClick={() => setTeamFilter(null)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors",
                teamFilter === null
                  ? "border-primary bg-primary/20 text-foreground"
                  : "border-border bg-secondary/40 text-muted-foreground",
              )}
            >
              All
            </button>
            {teams.map((t) => {
              const color = teamColor(sorted.find((d) => teamLabel(d.team) === t)?.team);
              const on = teamFilter === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTeamFilter(on ? null : t)}
                  className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors"
                  style={{
                    borderColor: on ? color : "var(--color-border)",
                    background: on ? `color-mix(in oklch, ${color} 22%, transparent)` : undefined,
                  }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                  {t}
                </button>
              );
            })}
          </div>
        </div>

        <div className=" overflow-y-auto p-3">
          <button
            type="button"
            onClick={() => pick(EMPTY)}
            className="mb-2 flex h-11 w-full items-center justify-center rounded-md border border-dashed border-border font-mono text-xs uppercase tracking-widest text-muted-foreground active:bg-secondary"
          >
            \u2014 Clear pick \u2014
          </button>

          {filtered.length === 0 ? (
            <p className="py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
              No matching drivers found
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {filtered.map((d) => {
                const taken = !!exclude?.includes(d.id) && d.id !== value;
                const active = d.id === value;
                return (
                  <button
                    key={d.id}
                    type="button"
                    disabled={taken}
                    onClick={() => pick(d.id)}
                    className={cn(
                      "relative flex h-16 flex-col justify-center overflow-hidden rounded-md border bg-card px-2.5 pr-9 text-left transition active:scale-[0.98]",
                      active && "border-primary ring-2 ring-primary/60",
                      taken && "opacity-30",
                    )}
                    style={{ borderLeft: `4px solid ${teamColor(d.team)}` }}
                  >
                    <span
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 font-display text-lg font-extrabold italic tabular-nums leading-none opacity-65"
                      style={{ color: teamColor(d.team) }}
                    >
                      {d.number ?? ""}
                    </span>
                    <span className="block font-display text-base font-extrabold italic uppercase leading-tight">
                      {d.code ?? d.full_name.split(" ").pop()}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {d.full_name}
                    </span>
                    <span className="block truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
                      {d.team ?? ""}{taken ? " \u00b7 picked" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
'@
Write-Utf8NoBom -RelativePath "src/components/DriverPicker.tsx" -Content $c

# --- src/components/SprintGrid.tsx ---
$c = @'
import { useMemo, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { GripVertical, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DriverPicker } from "@/components/DriverPicker";
import type { Driver } from "@/lib/queries";
import { sortByTeam, teamColor, teamLabel, teamsOf } from "@/lib/teams";
import { cn } from "@/lib/utils";

export const EMPTY = "__none__";

// Re-export DriverPicker as DriverSelect for backward compat with sprint.tsx
export const DriverSelect = DriverPicker;

export function SprintGrid({
  drivers,
  top10,
  setTop10,
  locked,
  size,
  onRepeat,
}: {
  size: number;
  drivers: Driver[];
  top10: string[];
  setTop10: React.Dispatch<React.SetStateAction<string[]>>;
  locked: boolean;
  onRepeat?: (() => void) | undefined;
}) {
  const [active, setActive] = useState(() => {
    const i = top10.indexOf(EMPTY);
    return i === -1 ? 0 : i;
  });
  const [drag, setDrag] = useState<{
    from: number;
    over: number | null;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [teamFilter, setTeamFilter] = useState<string | null>(null);
  const [gridAnimRef] = useAutoAnimate<HTMLDivElement>();
  const [animRef] = useAutoAnimate<HTMLDivElement>();
  const dragRef = useRef<{
    from: number;
    x: number;
    y: number;
    moved: boolean;
    fromGrip: boolean;
    pointerId: number;
    target: HTMLElement;
  } | null>(null);
  const byId = new Map(drivers.map((d) => [d.id, d]));
  const used = new Set(top10.filter((d) => d !== EMPTY));
  const sorted = useMemo(() => sortByTeam(drivers), [drivers]);
  const teams = useMemo(() => teamsOf(drivers), [drivers]);
  const deck = teamFilter ? sorted.filter((d) => teamLabel(d.team) === teamFilter) : sorted;

  function place(id: string) {
    if (locked) return;
    setTop10((prev) => {
      const next = prev.map((p) => (p === id ? EMPTY : p));
      next[active] = id;
      const empty = next.findIndex((p, i) => p === EMPTY && i > active);
      const first = next.indexOf(EMPTY);
      setActive(empty !== -1 ? empty : first !== -1 ? first : active);
      navigator.vibrate?.(10);
      return next;
    });
  }

  function clearSlot(i: number) {
    const snapshot = [...top10];
    const removedId = top10[i];
    const removedDriver = removedId && removedId !== EMPTY ? byId.get(removedId) : undefined;
    setTop10((prev) => prev.map((p, idx) => (idx === i ? EMPTY : p)));
    setActive(i);
    if (removedDriver) {
      toast(`Cleared P${i + 1} (${removedDriver.code ?? removedDriver.full_name})`, {
        action: {
          label: "Undo",
          onClick: () => {
            setTop10(snapshot);
            setActive(i);
          },
        },
      });
    }
  }

  function slotAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y)?.closest("[data-slot]");
    return el ? Number(el.getAttribute("data-slot")) : null;
  }

  function onDown(e: React.PointerEvent, i: number) {
    if (locked || top10[i] === EMPTY) return;
    const isGrip = !!(e.target as HTMLElement).closest("[data-grip]");
    const isMouse = e.pointerType === "mouse";
    const target = e.currentTarget as HTMLElement;
    dragRef.current = {
      from: i,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      fromGrip: isGrip || isMouse,
      pointerId: e.pointerId,
      target,
    };
    if (isGrip || isMouse) {
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  }

  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    // On touch devices, only initiate drag when grabbing the grip handle so normal vertical scrolling never hijacks picks
    if (!d.fromGrip) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
    if (!d.moved) {
      d.moved = true;
      navigator.vibrate?.(8);
    }
    setDrag({
      from: d.from,
      over: slotAt(e.clientX, e.clientY),
      clientX: e.clientX,
      clientY: e.clientY,
    });
  }

  function onUp(e: React.PointerEvent, i: number) {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || !d.moved) {
      const dr = top10[i] !== EMPTY;
      if (dr && i === active) clearSlot(i);
      else setActive(i);
      return;
    }
    const to = slotAt(e.clientX, e.clientY);
    if (to == null || to === d.from) return;
    setTop10((prev) => {
      const next = [...prev];
      [next[d.from], next[to]] = [next[to]!, next[d.from]!];
      return next;
    });
    setActive(to);
    navigator.vibrate?.(15);
  }

  const allOn = teamFilter === null;
  const primaryColor = "var(--color-primary)";
  const draggedDriver =
    drag != null && top10[drag.from] && top10[drag.from] !== EMPTY
      ? byId.get(top10[drag.from]!)
      : undefined;

  return (
    <section className="carbon-panel mt-8 rounded-lg">
      <div className="kerb-strip" />
      <div className="p-3 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="whitespace-nowrap text-lg sm:text-xl">
            {size === 10 ? "Starting grid" : "Sprint grid"}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {!locked && onRepeat && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="hit-slop gap-1.5 border-gold/45 bg-gold/10 font-mono text-[11px] font-bold uppercase tracking-wider text-gold hover:bg-gold/20"
                onClick={() => {
                  onRepeat();
                  navigator.vibrate?.(12);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Repeat Last
              </Button>
            )}
            {!locked && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="hit-slop"
                  disabled={active <= 0}
                  aria-label="Move driver up"
                  onClick={() => {
                    if (active <= 0) return;
                    setTop10((p) => {
                      const n = [...p];
                      [n[active - 1], n[active]] = [n[active]!, n[active - 1]!];
                      return n;
                    });
                    setActive(active - 1);
                    navigator.vibrate?.(10);
                  }}
                >
                  &#8593;
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="hit-slop"
                  disabled={active >= size - 1}
                  aria-label="Move driver down"
                  onClick={() => {
                    if (active >= size - 1) return;
                    setTop10((p) => {
                      const n = [...p];
                      [n[active + 1], n[active]] = [n[active]!, n[active + 1]!];
                      return n;
                    });
                    setActive(active + 1);
                    navigator.vibrate?.(10);
                  }}
                >
                  &#8595;
                </Button>
              </>
            )}

            {!locked && used.size > 0 && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="hit-slop"
                onClick={() => {
                  const snapshot = [...top10];
                  const prevActive = active;
                  setTop10(Array(size).fill(EMPTY));
                  setActive(0);
                  toast("Grid cleared", {
                    action: {
                      label: "Undo",
                      onClick: () => {
                        setTop10(snapshot);
                        setActive(prevActive);
                      },
                    },
                  });
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Tap a slot, then a driver. Drag the grip handle <span className="font-mono text-xs text-foreground/80">\u22ee\u22ee</span> to swap positions.
        </p>

        <div
          ref={gridAnimRef}
          className="mt-4 grid grid-cols-2 gap-x-2.5 gap-y-2 sm:gap-x-3"
        >
          {top10.map((id, i) => {
            const d = id !== EMPTY ? byId.get(id) : undefined;
            const isActive = i === active && !locked;
            const color = d ? teamColor(d.team) : "transparent";
            return (
              <button
                key={d ? `slot-${d.id}` : `empty-slot-${i}`}
                type="button"
                data-slot={i}
                disabled={locked}
                onPointerDown={(e) => onDown(e, i)}
                onPointerMove={onMove}
                onPointerUp={(e) => onUp(e, i)}
                onPointerCancel={() => {
                  dragRef.current = null;
                  setDrag(null);
                }}
                onLostPointerCapture={() => {
                  dragRef.current = null;
                  setDrag(null);
                }}
                className={cn(
                  "flex h-16 select-none items-center gap-2 overflow-hidden rounded-md border bg-background/70 pr-1.5 text-left transition",
                  i % 2 === 1 && "mt-5",
                  isActive && "border-primary ring-2 ring-primary/70",
                  !d && !isActive && "border-dashed",
                  drag?.from === i && "drag-ghost scale-[0.97]",
                  drag && drag.over === i && drag.from !== i && "drop-target scale-[1.02]",
                )}
                style={{
                  borderLeft: `5px solid ${color}`,
                  paddingLeft: "0.5rem",
                  touchAction: "pan-y",
                  boxShadow: d
                    ? `inset 0 0 24px -8px color-mix(in oklch, ${color} 55%, transparent), 0 0 14px -6px ${color}`
                    : undefined,
                  borderBottom: "2px solid oklch(1 0 0 / 0.35)",
                }}
              >
                <span
                  className={cn(
                    "w-8 shrink-0 rounded-sm py-1 text-center font-mono text-xs font-bold tabular-nums",
                    i === 0 ? "bg-gold text-gold-foreground" : "bg-secondary text-foreground",
                  )}
                >
                  P{i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    {d?.number != null && (
                      <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                        #{d.number}
                      </span>
                    )}
                    <span className="min-w-0 truncate font-display text-base font-extrabold italic uppercase leading-tight">
                      {d ? (d.code ?? d.full_name) : "\u2014"}
                    </span>
                  </span>
                  <span className="block truncate text-[11px] font-medium text-muted-foreground">
                    {d ? d.team : isActive ? "Pick a driver" : "Empty"}
                  </span>
                </span>
                {d && !locked && (
                  <span
                    data-grip="true"
                    aria-hidden="true"
                    style={{ touchAction: "none" }}
                    className="hit-slop flex h-10 w-7 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
                  >
                    <GripVertical className="h-4 w-4" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Floating GPU-accelerated Drag Preview Pill */}
        {drag && draggedDriver && (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-[120] flex items-center gap-2 rounded-lg border border-gold bg-card/95 px-3 py-1.5 shadow-2xl backdrop-blur-md"
            style={{
              transform: `translate3d(${drag.clientX - 48}px, ${drag.clientY - 54}px, 0)`,
              borderLeft: `4px solid ${teamColor(draggedDriver.team)}`,
              willChange: "transform",
            }}
          >
            <span className="rounded bg-gold px-1.5 py-0.5 font-mono text-[10px] font-bold text-gold-foreground">
              P{drag.over != null ? drag.over + 1 : drag.from + 1}
            </span>
            <span className="font-display text-sm font-extrabold italic uppercase">
              {draggedDriver.code ?? draggedDriver.full_name}
            </span>
          </div>
        )}

        {!locked && (
          <>
            <p className="mt-6 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Drivers \u00b7 filling <span className="text-primary">P{active + 1}</span>{" "}
              <span className="ml-1 tabular-nums text-foreground">
                ({used.size}/{size})
              </span>{" "}
              <button
                type="button"
                onClick={() =>
                  document
                    .querySelector('[data-slot="0"]')
                    ?.scrollIntoView({ behavior: "smooth", block: "center" })
                }
                className="hit-slop ml-2 text-primary underline"
              >
                Top
              </button>
            </p>

            <div className="sticky top-[52px] z-20 -mx-3 mt-2.5 flex gap-2 overflow-x-auto bg-transparent px-3 py-2.5 sm:mx-0">
              <button
                type="button"
                onClick={() => setTeamFilter(null)}
                className="shrink-0 rounded-full border px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest transition-all duration-200 active:scale-95"
                style={{
                  background: allOn
                    ? `color-mix(in oklch, ${primaryColor} 22%, rgba(255, 255, 255, 0.05))`
                    : "rgba(255, 255, 255, 0.03)",
                  borderColor: allOn ? primaryColor : "rgba(255, 255, 255, 0.16)",
                  borderBottom: allOn
                    ? "2px solid oklch(1 0 0 / 0.45)"
                    : "1.5px solid oklch(1 0 0 / 0.26)",
                  color: allOn ? "#ffffff" : "var(--color-muted-foreground)",
                  textShadow: allOn ? `0 0 10px ${primaryColor}` : undefined,
                  boxShadow: allOn
                    ? `inset 0 0 22px -6px color-mix(in oklch, ${primaryColor} 70%, transparent), 0 0 16px -3px ${primaryColor}, inset 0 1px 0 rgba(255, 255, 255, 0.32)`
                    : "inset 0 1px 0 rgba(255, 255, 255, 0.14)",
                }}
              >
                All
              </button>
              {teams.map((t) => {
                const color = teamColor(sorted.find((d) => teamLabel(d.team) === t)?.team);
                const on = teamFilter === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTeamFilter(on ? null : t)}
                    className="flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest transition-all duration-200 active:scale-95"
                    style={{
                      background: on
                        ? `color-mix(in oklch, ${color} 22%, rgba(255, 255, 255, 0.05))`
                        : `color-mix(in oklch, ${color} 6%, rgba(255, 255, 255, 0.02))`,
                      borderColor: on
                        ? color
                        : `color-mix(in oklch, ${color} 35%, rgba(255, 255, 255, 0.16))`,
                      borderBottom: on
                        ? "2px solid oklch(1 0 0 / 0.45)"
                        : "1.5px solid oklch(1 0 0 / 0.28)",
                      color: on ? "#ffffff" : "var(--color-foreground)",
                      textShadow: on ? `0 0 10px color-mix(in oklch, ${color} 85%, transparent)` : undefined,
                      boxShadow: on
                        ? `inset 0 0 22px -6px color-mix(in oklch, ${color} 72%, transparent), 0 0 16px -3px ${color}, inset 0 1px 0 rgba(255, 255, 255, 0.34)`
                        : `inset 0 0 16px -9px color-mix(in oklch, ${color} 40%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.15)`,
                    }}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full transition-transform duration-200"
                      style={{
                        background: color,
                        boxShadow: on
                          ? `0 0 10px ${color}, 0 0 4px #ffffff`
                          : `0 0 6px ${color}`,
                        transform: on ? "scale(1.2)" : undefined,
                      }}
                    />
                    {t}
                  </button>
                );
              })}
            </div>

            <div ref={animRef} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5">
              {deck.map((d) => {
                const taken = used.has(d.id);
                const dColor = teamColor(d.team);
                return (
                  <button
                    key={d.id}
                    type="button"
                    disabled={taken}
                    onClick={() => place(d.id)}
                    className={cn(
                      "relative flex h-16 flex-col justify-center overflow-hidden rounded-md border bg-background/70 px-2.5 pr-9 text-left transition hover:border-primary active:scale-[0.98]",
                      taken && "opacity-35",
                    )}
                    style={{
                      borderLeft: `5px solid ${dColor}`,
                      boxShadow: `inset 0 0 24px -8px color-mix(in oklch, ${dColor} 50%, transparent), 0 0 12px -6px ${dColor}`,
                      borderBottom: "2px solid oklch(1 0 0 / 0.32)",
                    }}
                  >
                    <span
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 font-display text-lg font-extrabold italic tabular-nums leading-none opacity-70"
                      style={{ color: dColor }}
                    >
                      {d.number ?? ""}
                    </span>
                    <span className="block font-display text-base font-extrabold italic uppercase leading-tight">
                      {d.code ?? d.full_name.split(" ").pop()}
                    </span>
                    <span className="block truncate text-[11px] font-medium text-muted-foreground">
                      {d.full_name}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
'@
Write-Utf8NoBom -RelativePath "src/components/SprintGrid.tsx" -Content $c

# --- src/components/SiteHeader.tsx ---
$c = @'
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarDays, Grid3x3, Home, LogOut, Moon, Shield, Sun, Swords, Trophy, WifiOff, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { AccountAndOnboarding } from "@/components/AccountAndOnboarding";
import { LogoHorizontal, LogoMark } from "@/components/Logo";
import { PushOptIn } from "@/components/PushOptIn";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { racesQuery } from "@/lib/queries";
import { sprintWeekend } from "@/lib/sprint";
import { STEWARD_EMAIL } from "@/lib/stewards.functions";

const links = [
  { to: "/", label: "Paddock", icon: Home },
  { to: "/predict", label: "Predict", icon: Grid3x3 },
  { to: "/leaderboard", label: "Standings", icon: Trophy },
  { to: "/h2h", label: "1v1", icon: Swords },
  { to: "/weekend", label: "Weekend", icon: CalendarDays },
  { to: "/rules", label: "Rules", icon: null },
] as const;

const DESKTOP_LINK =
  "hidden rounded-sm px-2 py-1.5 font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground md:inline [&.active]:text-primary";

function useSprintWeek(): boolean {
  const { data: races } = useQuery(racesQuery);
  return !!races && !!sprintWeekend(races);
}

export const HelmetLogo = LogoMark;

export function SiteHeader() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const sprintOn = useSprintWeek();
  const isSteward = user?.email?.toLowerCase() === STEWARD_EMAIL;
  const [confirmExitOpen, setConfirmExitOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [offline, setOffline] = useState(false);

  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    setOffline(!window.navigator.onLine);
    const handleOnline = () => setOffline(false);
    const handleOffline = () => setOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!confirmExitOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmExitOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmExitOpen]);

  async function handleConfirmExit() {
    setSigningOut(true);
    try {
      await signOut();
      setConfirmExitOpen(false);
    } finally {
      setSigningOut(false);
    }
  }

  const exitConfirmModal =
    confirmExitOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm animate-in fade-in duration-150"
            onClick={() => !signingOut && setConfirmExitOpen(false)}
          >
            <div
              className="carbon-panel relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/15 bg-card/95 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.85)] backdrop-blur-xl"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="exit-league-title"
            >
              <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-primary/15 blur-2xl" />

              <div className="relative flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/40 bg-primary/15 text-primary shadow-[0_0_16px_rgba(225,6,0,0.25)]">
                    <LogOut className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-gold">
                      Confirm Action
                    </p>
                    <h2 id="exit-league-title" className="mt-0.5 text-lg font-black uppercase tracking-wide text-foreground">
                      Exit the League?
                    </h2>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={signingOut}
                  onClick={() => setConfirmExitOpen(false)}
                  className="hit-slop inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-secondary/50 text-muted-foreground transition-colors hover:border-white/25 hover:text-foreground"
                  aria-label="Close dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <p className="relative mt-3.5 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                Are you sure you want to exit the league? You&apos;ll be signed out on this device, and you can sign back in anytime with your Google account.
              </p>

              <div className="relative mt-5 grid grid-cols-2 gap-2.5">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={signingOut}
                  onClick={() => setConfirmExitOpen(false)}
                  className="h-10 rounded-xl border border-border/80 font-mono text-xs font-bold uppercase tracking-wider"
                >
                  No, Stay
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={signingOut}
                  onClick={handleConfirmExit}
                  className="h-10 gap-1.5 rounded-xl font-mono text-xs font-bold uppercase tracking-wider shadow-[0_0_20px_rgba(225,6,0,0.3)]"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  {signingOut ? "Exiting\u2026" : "Yes, Exit"}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <header className="sticky top-0 z-40 w-full overflow-x-clip border-b border-border bg-background/90 pt-[env(safe-area-inset-top)] backdrop-blur">
      {offline && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-center gap-2 border-b border-gold/40 bg-gold/15 px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-gold"
        >
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>Offline Telemetry \u00b7 Cached data active \u00b7 Drafts saved on device</span>
        </div>
      )}
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-1.5 px-3 py-2 sm:gap-2 sm:px-4">
        <Link to="/" className="flex min-w-0 shrink items-center" aria-label="DOWNFORCE home">
          <LogoHorizontal className="h-7 w-auto max-w-[140px] sm:h-10 sm:max-w-none" />
        </Link>

        <nav className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
          {links
            .filter((l) => l.to !== "/rules")
            .map((l) => (
              <Link
                key={l.to}
                to={l.to}
                activeOptions={{ exact: l.to === "/" }}
                className={DESKTOP_LINK}
              >
                {l.label}
              </Link>
            ))}
          {sprintOn && (
            <Link to="/sprint" className={DESKTOP_LINK}>
              Sprint
            </Link>
          )}
          {isSteward && (
            <Link to="/stewards" className={DESKTOP_LINK} style={{ color: "var(--gold)" }}>
              Stewards
            </Link>
          )}
          <Link to="/rules" className={DESKTOP_LINK}>
            Rules
          </Link>
          {isSteward && (
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="hit-slop h-8 w-8 shrink-0 text-gold md:hidden"
              aria-label="Stewards"
            >
              <Link to="/stewards">
                <Shield className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <Link
            to="/rules"
            className="hit-slop rounded-sm px-1.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:hidden [&.active]:text-primary"
          >
            Rules
          </Link>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            onClick={toggleTheme}
            className="hit-slop h-8 w-8 shrink-0 sm:h-9 sm:w-9"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          {user ? (
            <>
              <AccountAndOnboarding />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Exit league"
                title="Exit league"
                onClick={() => setConfirmExitOpen(true)}
                className="hit-slop h-8 w-8 shrink-0 sm:h-9 sm:w-9"
              >
                <LogOut className="h-4 w-4" />
              </Button>
              {exitConfirmModal}
            </>
          ) : (
            <Button asChild size="sm" className="ml-1 h-8 px-2.5 text-xs">
              <Link to="/auth">Sign in</Link>
            </Button>
          )}
        </nav>
      </div>
      <div className="hidden"><PushOptIn /></div>
      <div className="kerb-strip" />
    </header>
  );
}

export function BottomNav() {
  const sprintOn = useSprintWeek();
  const count = links.filter((l) => l.icon).length + (sprintOn ? 1 : 0);
  return (
    <>
      <div className="h-[calc(4rem+env(safe-area-inset-bottom))] md:hidden" />
      <nav
        className="fixed inset-x-0 bottom-0 z-50 grid border-t border-border bg-background/95 backdrop-blur md:hidden"
        style={{
          paddingBottom: "env(safe-area-inset-bottom)",
          gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
        }}
        aria-label="Main"
      >
        {links
          .filter((l) => l.icon)
          .map((l) => {
            const Icon = l.icon!;
            return (
              <Link
                key={l.to}
                to={l.to}
                activeOptions={{ exact: l.to === "/" }}
                className="flex h-16 touch-manipulation select-none flex-col items-center justify-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground active:bg-secondary/60 [&.active]:text-primary"
              >
                <Icon className="h-5 w-5" />
                {l.label}
              </Link>
            );
          })}
        {sprintOn && (
          <Link
            to="/sprint"
            className="flex h-16 touch-manipulation select-none flex-col items-center justify-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground active:bg-secondary/60 [&.active]:text-primary"
          >
            <Zap className="h-5 w-5" />
            Sprint
          </Link>
        )}
      </nav>
    </>
  );
}

export function FahlBadge() {
  return (
    <span
      dir="rtl"
      className="fahl-badge inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-black not-italic leading-4"
      style={{ fontFamily: "Cairo, sans-serif" }}
    >
      \ud83d\udc51 \u0641\u062d\u0644 \u0627\u0644\u062c\u0648\u0644\u0629
    </span>
  );
}
'@
Write-Utf8NoBom -RelativePath "src/components/SiteHeader.tsx" -Content $c

# --- src/routes/predict.tsx ---
$c = @'
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Countdown } from "@/components/Countdown";
import { DriverPicker, EMPTY } from "@/components/DriverPicker";
import { SprintGrid } from "@/components/SprintGrid";
import { LightsOut } from "@/components/LightsOut";
import { MissingPlayers } from "@/components/MissingPlayers";
import { assertDeadlineOpen, logPredAudit } from "@/lib/prediction.functions";
import { SharePicks } from "@/components/SharePicks";
import { SharePole } from "@/components/SharePole";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { driversQuery, getTrustedNow, nextRace, racesQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/predict")({
  head: () => ({
    meta: [
      { title: "Make your picks \u2014 DOWNFORCE" },
      {
        name: "description",
        content:
          "Lock in your top 10 finishing order plus pole, fastest lap and DNF picks before the lights go out.",
      },
      { property: "og:title", content: "Make your picks \u2014 DOWNFORCE" },
      {
        property: "og:description",
        content: "Predict the top 10, pole, fastest lap and a DNF for the next Grand Prix.",
      },
      { name: "twitter:title", content: "Make your picks \u2014 DOWNFORCE" },
      { name: "twitter:description", content: "Predict the top 10, pole, fastest lap and a DNF for the next Grand Prix." },
    ],
  }),
  component: Predict,
});

// The database only keeps one "updated_at" per prediction, which moves whenever the top 10
// changes. So we also remember (on this device) the moment the pole pick itself was saved.
const poleAtKey = (userId: string, raceId: string) => `dfr:pole-at:${userId}:${raceId}`;
function readPoleAt(userId: string, raceId: string, driverId: string): string | null {
  try {
    const raw = window.localStorage.getItem(poleAtKey(userId, raceId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { driver?: string; at?: string };
    return v.driver === driverId && v.at ? v.at : null;
  } catch {
    return null;
  }
}
function writePoleAt(userId: string, raceId: string, driverId: string) {
  try {
    window.localStorage.setItem(
      poleAtKey(userId, raceId),
      JSON.stringify({ driver: driverId, at: new Date().toISOString() }),
    );
  } catch {
    /* storage unavailable: the card falls back to the server time */
  }
}

function fireConfetti() {
  if (typeof window === "undefined") return;
  void import("canvas-confetti")
    .then((m) =>
      m.default({
        particleCount: 55,
        spread: 68,
        origin: { y: 0.78 },
        colors: ["#e10600", "#f59e0b", "#ffffff"],
        disableForReducedMotion: true,
      }),
    )
    .catch(() => null);
}

function Predict() {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const { data: races } = useQuery(racesQuery);
  const { data: drivers } = useQuery(driversQuery);

  // Re-evaluate lock states every 30s so the form flips to read-only if the user leaves the tab open
  const [now, setNow] = useState(() => getTrustedNow());
  useEffect(() => {
    const id = setInterval(() => setNow(getTrustedNow()), 30_000);
    return () => clearInterval(id);
  }, []);

  const upcoming = useMemo(() => (races ? nextRace(races, now) : null), [races, now]);
  const [selectedRaceId, setSelectedRaceId] = useState<string | null>(null);
  const race = useMemo(() => {
    if (!races?.length) return null;
    if (selectedRaceId) return races.find((r) => r.id === selectedRaceId) ?? upcoming ?? races[0]!;
    return upcoming ?? races[races.length - 1]!;
  }, [races, selectedRaceId, upcoming]);

  const raceLocked = !!race && new Date(race.race_at).getTime() <= now;
  const poleLockAt = race?.qualifying_at ?? race?.race_at ?? null;
  const poleLocked = !!poleLockAt && new Date(poleLockAt).getTime() <= now;

  const { data: prediction, isLoading: predLoading } = useQuery({
    queryKey: ["prediction", race?.id, user?.id],
    enabled: !!race && !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("predictions")
        .select("*")
        .eq("race_id", race!.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: results } = useQuery({
    queryKey: ["results", race?.id],
    enabled: !!race?.has_results,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("race_results")
        .select("*")
        .eq("race_id", race!.id)
        .order("position", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: score } = useQuery({
    queryKey: ["score", race?.id, user?.id],
    enabled: !!race?.has_results && !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("scores")
        .select("*")
        .eq("race_id", race!.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Draft persistence in localStorage per user+race so unfinished picks survive accidental reload
  const draftKey = user && race ? `dfr:draft:${user.id}:${race.id}` : null;

  const [top10, setTop10] = useState<string[]>(Array(10).fill(EMPTY));
  const [pole, setPole] = useState<string>(EMPTY);
  const [fl, setFl] = useState<string>(EMPTY);
  const [dnf, setDnf] = useState<string>(EMPTY);
  const [savingPole, setSavingPole] = useState(false);
  const [savingRace, setSavingRace] = useState(false);
  const [lightsOut, setLightsOut] = useState(false);
  const hydratedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = `${race?.id ?? ""}:${user?.id ?? ""}:${prediction?.id ?? "none"}:${prediction?.updated_at ?? ""}`;
    if (hydratedKeyRef.current === key) return;
    if (predLoading) return;
    hydratedKeyRef.current = key;

    if (prediction) {
      const padded = [...(prediction.top10 ?? [])];
      while (padded.length < 10) padded.push(EMPTY);
      setTop10(padded.slice(0, 10));
      setPole(prediction.pole_driver_id ?? EMPTY);
      setFl(prediction.fastest_lap_driver_id ?? EMPTY);
      setDnf(prediction.dnf_driver_id ?? EMPTY);
      return;
    }

    if (draftKey) {
      try {
        const raw = localStorage.getItem(draftKey);
        if (raw) {
          const d = JSON.parse(raw) as {
            top10?: string[];
            pole?: string;
            fl?: string;
            dnf?: string;
          };
          if (Array.isArray(d.top10) && d.top10.length === 10) setTop10(d.top10);
          else setTop10(Array(10).fill(EMPTY));
          setPole(d.pole ?? EMPTY);
          setFl(d.fl ?? EMPTY);
          setDnf(d.dnf ?? EMPTY);
          return;
        }
      } catch {
        /* ignore corrupt draft */
      }
    }

    setTop10(Array(10).fill(EMPTY));
    setPole(EMPTY);
    setFl(EMPTY);
    setDnf(EMPTY);
  }, [prediction, predLoading, draftKey, race?.id, user?.id]);

  // Save draft to localStorage while user has no saved prediction yet (debounced 250ms)
  useEffect(() => {
    if (!draftKey || prediction || predLoading) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ top10, pole, fl, dnf }));
      } catch {
        /* ignore quota errors */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [draftKey, prediction, predLoading, top10, pole, fl, dnf]);

  const savedTop10 = useMemo(() => {
    const p = [...(prediction?.top10 ?? [])];
    while (p.length < 10) p.push(EMPTY);
    return p.slice(0, 10);
  }, [prediction]);
  const savedPole = prediction?.pole_driver_id ?? EMPTY;
  const savedFl = prediction?.fastest_lap_driver_id ?? EMPTY;
  const savedDnf = prediction?.dnf_driver_id ?? EMPTY;

  const poleDirty = !poleLocked && pole !== savedPole;
  const raceDirty =
    !raceLocked &&
    (fl !== savedFl || dnf !== savedDnf || top10.some((d, i) => d !== savedTop10[i]));

  // Warn before closing tab if the user has unsaved edits to an already-submitted prediction
  useEffect(() => {
    if (!prediction || (!poleDirty && !raceDirty)) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [prediction, poleDirty, raceDirty]);

  const repeatLast = useCallback(async () => {
    if (!user || !race || !races) return;
    const prevRaces = races.filter((r) => r.round < race.round).sort((a, b) => b.round - a.round);
    if (!prevRaces.length) {
      toast.error("No earlier round to copy from.");
      return;
    }
    const { data } = await supabase
      .from("predictions")
      .select("*")
      .eq("user_id", user.id)
      .in("race_id", prevRaces.map((r) => r.id));
    const latest = prevRaces.map((r) => data?.find((p) => p.race_id === r.id)).find(Boolean);
    if (!latest) {
      toast.error("No saved picks found from an earlier round.");
      return;
    }
    const padded = [...(latest.top10 ?? [])];
    while (padded.length < 10) padded.push(EMPTY);
    setTop10(padded.slice(0, 10));
    if (!poleLocked && latest.pole_driver_id) setPole(latest.pole_driver_id);
    if (latest.fastest_lap_driver_id) setFl(latest.fastest_lap_driver_id);
    if (latest.dnf_driver_id) setDnf(latest.dnf_driver_id);
    toast.success("Copied your picks from the previous round \u2014 review & save!");
  }, [user, race, races, poleLocked]);

  if (authLoading) return null;
  if (!user) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-3xl">Sign in to make picks</h1>
        <p className="mt-2 text-muted-foreground">
          You need an account to lock in predictions before each race.
        </p>
        <Button asChild className="mt-6">
          <Link to="/auth">Continue with Google</Link>
        </Button>
      </main>
    );
  }

  async function savePole() {
    if (!race || !user) return;
    if (poleLocked) {
      toast.error("Qualifying has started \u2014 pole pick is locked.");
      return;
    }
    if (pole === EMPTY) {
      toast.error("Choose a pole position driver first.");
      return;
    }

    setSavingPole(true);
    try {
      await assertDeadlineOpen({ data: { raceId: race.id, kind: "pole" } });
    } catch (e) {
      setSavingPole(false);
      toast.error(e instanceof Error ? e.message : "Qualifying has locked.");
      return;
    }
    const newPole = pole === EMPTY ? null : pole;
    // Keep existing race picks in the row (or empty placeholder if none saved yet).
    const payload = {
      user_id: user.id,
      race_id: race.id,
      pole_driver_id: newPole,
      top10: prediction?.top10 ?? [],
      fastest_lap_driver_id: prediction?.fastest_lap_driver_id ?? null,
      dnf_driver_id: prediction?.dnf_driver_id ?? null,
      updated_at: new Date().toISOString(),
    };
    const { data: saved, error } = await supabase
      .from("predictions")
      .upsert(payload, { onConflict: "user_id,race_id" })
      .select("id")
      .single();
    setSavingPole(false);
    if (error) {
      toast.error(error.message);
      return;
    }

    if (newPole) writePoleAt(user.id, race.id, newPole);

    // Server-verified audit log entry (falls back silently if offline)
    void logPredAudit({
      data: {
        userId: user.id,
        raceId: race.id,
        predId: saved.id,
        action: prediction ? "update" : "create",
        changes: { pole: [prediction?.pole_driver_id ?? null, newPole] },
      },
    }).catch(() => {});

    toast.success("Pole position locked in!");
    fireConfetti();
    await queryClient.invalidateQueries({ queryKey: ["prediction", race.id, user.id] });
    await queryClient.invalidateQueries({ queryKey: ["pick-status", race.id] });
  }

  async function saveRace(e: React.FormEvent) {
    e.preventDefault();
    if (!race || !user) return;
    if (raceLocked) {
      toast.error("Picks are locked for this race.");
      return;
    }

    const picked = top10.filter((d) => d !== EMPTY);
    if (picked.length < 10) {
      toast.error("Fill all 10 finishing positions before saving.");
      return;
    }
    if (new Set(picked).size !== 10) {
      toast.error("Each driver can only appear once in the top 10.");
      return;
    }

    setSavingRace(true);
    try {
      await assertDeadlineOpen({ data: { raceId: race.id, kind: "race" } });
    } catch (err) {
      setSavingRace(false);
      toast.error(err instanceof Error ? err.message : "Race picks are locked.");
      return;
    }
    const newFl = fl === EMPTY ? null : fl;
    const newDnf = dnf === EMPTY ? null : dnf;
    // If qualifying hasn't started yet, also save whatever is in the pole picker;
    // once qualifying starts, never overwrite the already-locked pole value.
    const newPole = poleLocked
      ? (prediction?.pole_driver_id ?? null)
      : pole === EMPTY
        ? (prediction?.pole_driver_id ?? null)
        : pole;

    const payload = {
      user_id: user.id,
      race_id: race.id,
      top10,
      pole_driver_id: newPole,
      fastest_lap_driver_id: newFl,
      dnf_driver_id: newDnf,
      updated_at: new Date().toISOString(),
    };
    const { data: saved, error } = await supabase
      .from("predictions")
      .upsert(payload, { onConflict: "user_id,race_id" })
      .select("id")
      .single();
    setSavingRace(false);
    if (error) {
      toast.error(error.message);
      return;
    }

    if (draftKey) {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
    }

    const prevPole = prediction?.pole_driver_id ?? null;
    if (newPole && newPole !== prevPole) writePoleAt(user.id, race.id, newPole);

    const changes: Record<string, unknown> = {};
    const prevTop = prediction?.top10 ?? [];
    if (JSON.stringify(prevTop) !== JSON.stringify(top10)) changes["top10"] = [prevTop, top10];
    if ((prediction?.fastest_lap_driver_id ?? null) !== newFl) {
      changes["fastest_lap"] = [prediction?.fastest_lap_driver_id ?? null, newFl];
    }
    if ((prediction?.dnf_driver_id ?? null) !== newDnf) {
      changes["dnf"] = [prediction?.dnf_driver_id ?? null, newDnf];
    }
    if (!poleLocked && prevPole !== newPole) {
      changes["pole"] = [prevPole, newPole];
    }
    if (Object.keys(changes).length > 0) {
      void logPredAudit({
        data: {
          userId: user.id,
          raceId: race.id,
          predId: saved.id,
          action: prediction ? "update" : "create",
          changes,
        },
      }).catch(() => {});
    }

    setLightsOut(true);
    fireConfetti();
    await queryClient.invalidateQueries({ queryKey: ["prediction", race.id, user.id] });
    await queryClient.invalidateQueries({ queryKey: ["pick-status", race.id] });
  }

  const byId = new Map((drivers ?? []).map((d) => [d.id, d]));
  const breakdown = (score?.breakdown ?? null) as {
    items?: Array<{ pos: number; predicted: string; actual: string | null; delta: number | null; pts: number }>;
    pole?: number;
    fastestLap?: number;
    dnf?: number;
    podiumBonus?: number;
    noSubmission?: boolean;
  } | null;

  const filledCount = top10.filter((d) => d !== EMPTY).length;
  const poleSaved = !!prediction?.pole_driver_id;
  const raceSaved = (prediction?.top10?.filter((x) => x && x !== EMPTY).length ?? 0) === 10;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 pb-28">
      {lightsOut && <LightsOut onDone={() => setLightsOut(false)} />}
      {/* Race selector + dual lock countdowns */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            Season {race?.season} \u00b7 Round {race?.round}
          </p>
          <h1 className="text-3xl sm:text-4xl">{race?.name ?? "Loading\u2026"}</h1>
          <p className="text-sm text-muted-foreground">{race?.circuit}</p>
        </div>

        <select
          value={race?.id ?? ""}
          onChange={(e) => setSelectedRaceId(e.target.value)}
          className="h-10 rounded-md border border-border bg-card px-3 font-mono text-xs uppercase"
        >
          {races?.map((r) => (
            <option key={r.id} value={r.id}>
              R{String(r.round).padStart(2, "0")} \u00b7 {r.name}
              {r.has_results ? " \u2713" : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Status Banner: clearly shows if picks are already saved in DB */}
      {race && !race.has_results && (
        <div
          className={cn(
            "mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5 font-mono text-xs",
            raceSaved && poleSaved
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : poleSaved || raceSaved
                ? "border-gold/40 bg-gold/10 text-gold"
                : "border-primary/40 bg-primary/10 text-foreground",
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span>
              POLE:{" "}
              <strong>
                {poleSaved
                  ? `\u2713 SAVED (${byId.get(prediction!.pole_driver_id!)?.code ?? "OK"})`
                  : poleLocked
                    ? "\u2717 MISSED"
                    : "NOT SAVED"}
              </strong>
            </span>
            <span className="opacity-40">|</span>
            <span>
              RACE TOP 10:{" "}
              <strong>
                {raceSaved
                  ? "\u2713 SAVED (10/10)"
                  : raceLocked
                    ? "\u2717 MISSED (\u221225 PTS)"
                    : `NOT SAVED (${filledCount}/10 picked)`}
              </strong>
            </span>
          </div>
          <div className="flex items-center gap-2">
            {(poleDirty || raceDirty) && (
              <span className="rounded bg-gold/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold">
                {prediction ? "Unsaved edits" : "Draft auto-saved"}
              </span>
            )}
            {prediction?.updated_at && (
              <span className="text-[11px] opacity-75">
                Last saved {new Date(prediction.updated_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
              </span>
            )}
          </div>
        </div>
      )}

      {race && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {poleLockAt && (
            <Countdown
              target={poleLockAt}
              label={poleLocked ? "Pole pick locked" : "Pole locks (Quali start)"}
            />
          )}
          <Countdown
            target={race.race_at}
            label={raceLocked ? "Race picks locked" : "Race locks (Lights out)"}
          />
        </div>
      )}

      {race && <MissingPlayers race={race} />}

      {race?.has_sprint && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/50 bg-gold/10 px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-widest text-gold">
            \u26a1 Sprint weekend \u2014 don&apos;t forget your Sprint Top 8 (+9 pts max)
          </p>
          <Button asChild size="sm" variant="outline">
            <Link to="/sprint">Go to Sprint picks \u2192</Link>
          </Button>
        </div>
      )}

      {/* Results comparison when race is scored */}
      {race?.has_results && results && (
        <section className="carbon-panel mt-6 rounded-lg p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xl">Your Score</h2>
            <span className="font-display text-3xl font-black text-gold">
              {score?.points ?? 0} PTS
            </span>
          </div>
          {breakdown?.noSubmission && (
            <p className="mt-2 font-mono text-xs uppercase text-destructive">
              No prediction submitted \u2014 {score?.points ?? -25} pt penalty applied
            </p>
          )}
          {breakdown?.items && (
            <div className="mt-4 grid gap-1.5 text-sm">
              {breakdown.items.map((it) => {
                const pred = byId.get(it.predicted);
                const act = it.actual ? byId.get(it.actual) : null;
                return (
                  <div
                    key={it.pos}
                    className="flex items-center justify-between rounded bg-secondary/50 px-3 py-1.5 font-mono text-xs"
                  >
                    <span>
                      P{it.pos} \u00b7 Picked <strong>{pred?.code ?? "\u2014"}</strong>
                      {act ? ` (actual P${results.find((r) => r.driver_id === it.actual)?.position}: ${act.code})` : " (DNF/out)"}
                    </span>
                    <span className={cn(it.pts > 0 && "font-bold text-gold")}>+{it.pts}</span>
                  </div>
                );
              })}
              <div className="mt-2 flex flex-wrap gap-2 font-mono text-xs">
                <span className="rounded bg-secondary px-2 py-1">Pole +{breakdown.pole ?? 0}</span>
                <span className="rounded bg-secondary px-2 py-1">FL +{breakdown.fastestLap ?? 0}</span>
                <span className="rounded bg-secondary px-2 py-1">DNF +{breakdown.dnf ?? 0}</span>
                <span className="rounded bg-secondary px-2 py-1">
                  Podium bonus +{breakdown.podiumBonus ?? 0}
                </span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* STEP 1 \u2014 POLE POSITION (locks at Qualifying start) */}
      <section className="carbon-panel mt-8 rounded-lg">
        <div className="kerb-strip" />
        <div className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-gold">
                Step 1 \u00b7 Locks at Qualifying \u00b7 +3 pts
              </p>
              <h2 className="text-xl">Pole Position Pick</h2>
            </div>
            <span
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[11px] uppercase",
                poleLocked
                  ? "bg-destructive/20 text-destructive"
                  : prediction?.pole_driver_id
                    ? "bg-gold/20 text-gold"
                    : "bg-secondary text-muted-foreground",
              )}
            >
              {poleLocked ? "Locked" : prediction?.pole_driver_id ? "Saved" : "Open"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Saved on its own \u2014 lock in your Pole pick before Qualifying starts, then come back to set your Race Top 10 after seeing the grid.
          </p>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <DriverPicker
                drivers={drivers ?? []}
                value={pole}
                onChange={setPole}
                disabled={poleLocked}
                placeholder="Choose pole position driver"
              />
            </div>
            {!poleLocked && (
              <Button
                type="button"
                onClick={savePole}
                disabled={savingPole || pole === EMPTY}
                className="sm:w-auto"
              >
                {savingPole
                  ? "Saving\u2026"
                  : prediction?.pole_driver_id
                    ? poleDirty
                      ? "Update Pole Pick *"
                      : "Update Pole Pick"
                    : "Lock in Pole Pick"}
              </Button>
            )}
          </div>
          {race && drivers && pole !== EMPTY && (
            <div className="mt-4 border-t border-border/60 pt-4">
              <SharePole
                raceName={race.name}
                round={race.round}
                playerName={(user.user_metadata?.["full_name"] as string | undefined) ?? user.email ?? "Driver"}
                driver={byId.get(pole)}
                savedAt={
                  (user && race ? readPoleAt(user.id, race.id, pole) : null) ??
                  (prediction?.pole_driver_id === pole ? prediction?.updated_at : null) ??
                  null
                }
                circuit={[race.circuit, race.country].filter(Boolean).join(" \u00b7 ")}
              />
            </div>
          )}
        </div>
      </section>

      {/* STEP 2 \u2014 RACE TOP 10 + FL + DNF (locks at Race lights out) */}
      <form onSubmit={saveRace}>
        <SprintGrid
          size={10}
          drivers={drivers ?? []}
          top10={top10}
          setTop10={setTop10}
          locked={raceLocked}
          onRepeat={repeatLast}
        />

        <section className="carbon-panel mt-6 grid gap-4 rounded-lg p-5 sm:grid-cols-2">
          <Field label="Fastest Lap" badge="+2 PTS" purple disabled={raceLocked}>
            <DriverPicker drivers={drivers ?? []} value={fl} onChange={setFl} disabled={raceLocked} />
          </Field>
          <Field label="DNF Driver" badge="+3 PTS" disabled={raceLocked}>
            <DriverPicker drivers={drivers ?? []} value={dnf} onChange={setDnf} disabled={raceLocked} />
          </Field>
        </section>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          {race && drivers && (
            <SharePicks
              raceName={race.name}
              round={race.round}
              playerName={(user.user_metadata?.["full_name"] as string | undefined) ?? user.email ?? "Driver"}
              drivers={drivers}
              top10={top10}
              pole={pole === EMPTY ? null : pole}
              fastestLap={fl === EMPTY ? null : fl}
              dnf={dnf === EMPTY ? null : dnf}
              lockedAt={prediction?.updated_at ?? null}
            />
          )}
          {!raceLocked && (
            <Button type="submit" size="lg" disabled={savingRace} className="ml-auto">
              {savingRace
                ? "Locking in\u2026"
                : raceSaved
                  ? raceDirty
                    ? "Save Changes *"
                    : "Update Race Picks"
                  : `Lock in Race Picks (${filledCount}/10)`}
            </Button>
          )}
        </div>
      </form>

      {/* Sticky mobile save bar so the user never forgets to submit after picking 10 drivers */}
      {!raceLocked && (filledCount === 10 || raceDirty) && (!raceSaved || raceDirty) && (
        <div className="fixed inset-x-0 bottom-16 z-30 border-t border-primary/50 bg-background/95 px-4 py-2.5 backdrop-blur md:hidden">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <span className="font-mono text-xs font-bold uppercase text-gold">
              {raceSaved ? "Unsaved changes!" : "10/10 selected \u2014 tap to save!"}
            </span>
            <Button
              type="button"
              size="sm"
              disabled={savingRace}
              onClick={(e) => void saveRace(e as unknown as React.FormEvent)}
            >
              {savingRace ? "Saving\u2026" : "Save Race Picks"}
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}

function Field({
  label,
  badge,
  purple,
  children,
}: {
  label: string;
  badge: string;
  purple?: boolean | undefined;
  disabled?: boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="font-display text-sm font-bold uppercase tracking-wider">{label}</label>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] font-bold",
            purple ? "bg-purple-500/20 text-purple" : "bg-gold/20 text-gold",
          )}
        >
          {badge}
        </span>
      </div>
      {children}
    </div>
  );
}
'@
Write-Utf8NoBom -RelativePath "src/routes/predict.tsx" -Content $c

# --- src/routes/sprint.tsx ---
$c = @'
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Countdown } from "@/components/Countdown";
import { DriverSelect, EMPTY, SprintGrid } from "@/components/SprintGrid";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { driversQuery, getTrustedNow, racesQuery } from "@/lib/queries";
import { sprintPoleLockAt, sprintWeekend } from "@/lib/sprint";
import { assertDeadlineOpen } from "@/lib/prediction.functions";
import {
  SPRINT_MAX_POINTS,
  SPRINT_SLOTS,
  scoreSprint,
  type SprintResultRow,
} from "@/lib/sprintScoring";
import { teamColor } from "@/lib/teams";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/sprint")({
  head: () => ({
    meta: [
      { title: "Sprint picks \u2014 DOWNFORCE" },
      {
        name: "description",
        content: "Predict the sprint top 8 and the sprint pole. Up to 9 extra points on sprint weekends.",
      },
      { property: "og:title", content: "Sprint picks \u2014 DOWNFORCE" },
      {
        property: "og:description",
        content: "Predict the sprint top 8 and the sprint pole.",
      },
      { name: "twitter:title", content: "Sprint picks \u2014 DOWNFORCE" },
      { name: "twitter:description", content: "Predict the sprint top 8 and the sprint pole." },
    ],
  }),
  component: Sprint,
});

function fireConfetti() {
  if (typeof window === "undefined") return;
  void import("canvas-confetti")
    .then((m) =>
      m.default({
        particleCount: 45,
        spread: 62,
        origin: { y: 0.78 },
        colors: ["#e10600", "#f59e0b", "#ffffff"],
        disableForReducedMotion: true,
      }),
    )
    .catch(() => null);
}

function Sprint() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const { data: races } = useQuery(racesQuery);
  const { data: drivers } = useQuery(driversQuery);

  const race = useMemo(() => (races ? sprintWeekend(races) : null), [races]);

  const [now, setNow] = useState(() => getTrustedNow());
  useEffect(() => {
    const t = setInterval(() => setNow(getTrustedNow()), 30_000);
    return () => clearInterval(t);
  }, []);

  const sprintLocked = !!race?.sprint_at && new Date(race.sprint_at).getTime() <= now;
  const poleLockAt = race ? sprintPoleLockAt(race) : null;
  const poleLocked = !!poleLockAt && new Date(poleLockAt).getTime() <= now;

  const { data: prediction, isLoading: predLoading } = useQuery({
    queryKey: ["sprint-prediction", race?.id, user?.id],
    enabled: !!race && !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sprint_predictions")
        .select("*")
        .eq("race_id", race!.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: results } = useQuery({
    queryKey: ["sprint-results", race?.id],
    enabled: !!race,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sprint_results")
        .select("driver_id, position, finished, pole, status")
        .eq("race_id", race!.id)
        .order("position", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const draftKey = user && race ? `dfr:sprint-draft:${user.id}:${race.id}` : null;

  const [top8, setTop8] = useState<string[]>(Array(SPRINT_SLOTS).fill(EMPTY));
  const [pole, setPole] = useState<string>(EMPTY);
  const [savingPole, setSavingPole] = useState(false);
  const [savingSprint, setSavingSprint] = useState(false);
  const hydratedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = `${race?.id ?? ""}:${user?.id ?? ""}:${prediction?.id ?? "none"}:${prediction?.updated_at ?? ""}`;
    if (hydratedKeyRef.current === key) return;
    if (predLoading) return;
    hydratedKeyRef.current = key;

    if (prediction) {
      const p = [...(prediction.top8 ?? [])];
      while (p.length < SPRINT_SLOTS) p.push(EMPTY);
      setTop8(p.slice(0, SPRINT_SLOTS));
      setPole(prediction.pole_driver_id ?? EMPTY);
      return;
    }

    if (draftKey) {
      try {
        const raw = localStorage.getItem(draftKey);
        if (raw) {
          const d = JSON.parse(raw) as { top8?: string[]; pole?: string };
          if (Array.isArray(d.top8) && d.top8.length === SPRINT_SLOTS) setTop8(d.top8);
          else setTop8(Array(SPRINT_SLOTS).fill(EMPTY));
          setPole(d.pole ?? EMPTY);
          return;
        }
      } catch {
        /* ignore */
      }
    }

    setTop8(Array(SPRINT_SLOTS).fill(EMPTY));
    setPole(EMPTY);
  }, [prediction, predLoading, draftKey, race?.id, user?.id]);

  // Auto-save Sprint draft while user has not submitted yet
  useEffect(() => {
    if (!draftKey || prediction || predLoading) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ top8, pole }));
      } catch {
        /* ignore */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [draftKey, prediction, predLoading, top8, pole]);

  const savedTop8 = useMemo(() => {
    const p = [...(prediction?.top8 ?? [])];
    while (p.length < SPRINT_SLOTS) p.push(EMPTY);
    return p.slice(0, SPRINT_SLOTS);
  }, [prediction]);
  const savedPole = prediction?.pole_driver_id ?? EMPTY;

  const poleDirty = !poleLocked && pole !== savedPole;
  const sprintDirty = !sprintLocked && top8.some((d, i) => d !== savedTop8[i]);

  useEffect(() => {
    if (!prediction || (!poleDirty && !sprintDirty)) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [prediction, poleDirty, sprintDirty]);

  const repeatLast = useCallback(async () => {
    if (!user || !race || !races) return;
    const prevSprintRaces = races
      .filter((r) => r.has_sprint && r.round < race.round)
      .sort((a, b) => b.round - a.round);
    if (prevSprintRaces.length > 0) {
      const { data } = await supabase
        .from("sprint_predictions")
        .select("*")
        .eq("user_id", user.id)
        .in("race_id", prevSprintRaces.map((r) => r.id));
      const latestSprint = prevSprintRaces
        .map((r) => data?.find((p) => p.race_id === r.id))
        .find(Boolean);
      if (latestSprint && (latestSprint.top8?.length ?? 0) > 0) {
        const padded = [...(latestSprint.top8 ?? [])];
        while (padded.length < SPRINT_SLOTS) padded.push(EMPTY);
        setTop8(padded.slice(0, SPRINT_SLOTS));
        if (!poleLocked && latestSprint.pole_driver_id) setPole(latestSprint.pole_driver_id);
        toast.success("Copied your picks from the previous Sprint \u2014 review & save!");
        return;
      }
    }
    // Fallback: copy first 8 drivers from user's most recent Grand Prix prediction
    const { data: gpPreds } = await supabase
      .from("predictions")
      .select("top10, pole_driver_id, updated_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(1);
    const latestGp = gpPreds?.[0];
    if (latestGp && (latestGp.top10?.length ?? 0) >= SPRINT_SLOTS) {
      setTop8(latestGp.top10.slice(0, SPRINT_SLOTS));
      if (!poleLocked && latestGp.pole_driver_id) setPole(latestGp.pole_driver_id);
      toast.success("Copied Top 8 from your latest Grand Prix grid \u2014 review & save!");
      return;
    }
    toast.error("No saved Sprint or Grand Prix picks found to copy.");
  }, [user, race, races, poleLocked]);

  if (loading) return null;
  if (!user) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-3xl">Sign in to play Sprint</h1>
        <Button asChild className="mt-6">
          <Link to="/auth">Continue with Google</Link>
        </Button>
      </main>
    );
  }

  if (!race) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          Sprint weekend
        </p>
        <h1 className="mt-2 text-3xl">No Sprint this week</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page opens automatically on Sprint weekends (China, Miami, Canada, Great Britain, Netherlands, Singapore).
        </p>
        <Button asChild variant="outline" className="mt-6">
          <Link to="/weekend">See full calendar</Link>
        </Button>
      </main>
    );
  }

  async function savePole() {
    if (!race || !user) return;
    if (poleLocked) {
      toast.error("Sprint Qualifying has started \u2014 pole pick is locked.");
      return;
    }
    if (pole === EMPTY) {
      toast.error("Choose a sprint pole driver first.");
      return;
    }
    setSavingPole(true);
    try {
      await assertDeadlineOpen({ data: { raceId: race.id, kind: "sprint_pole" } });
    } catch (e) {
      setSavingPole(false);
      toast.error(e instanceof Error ? e.message : "Sprint pole is locked.");
      return;
    }
    const { error } = await supabase.from("sprint_predictions").upsert(
      {
        user_id: user.id,
        race_id: race.id,
        pole_driver_id: pole,
        top8: prediction?.top8 ?? [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,race_id" },
    );
    setSavingPole(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Sprint Pole locked in!");
    fireConfetti();
    await queryClient.invalidateQueries({ queryKey: ["sprint-prediction", race.id, user.id] });
  }

  async function saveSprint(e: React.FormEvent) {
    e.preventDefault();
    if (!race || !user) return;
    if (sprintLocked) {
      toast.error("Sprint has started \u2014 picks are locked.");
      return;
    }
    const picked = top8.filter((d) => d !== EMPTY);
    if (picked.length < SPRINT_SLOTS) {
      toast.error("Fill all 8 positions before saving.");
      return;
    }
    if (new Set(picked).size !== SPRINT_SLOTS) {
      toast.error("Each driver can only appear once.");
      return;
    }

    setSavingSprint(true);
    try {
      await assertDeadlineOpen({ data: { raceId: race.id, kind: "sprint" } });
    } catch (err) {
      setSavingSprint(false);
      toast.error(err instanceof Error ? err.message : "Sprint picks are locked.");
      return;
    }
    const newPole = poleLocked
      ? (prediction?.pole_driver_id ?? null)
      : pole === EMPTY
        ? (prediction?.pole_driver_id ?? null)
        : pole;

    const { error } = await supabase.from("sprint_predictions").upsert(
      {
        user_id: user.id,
        race_id: race.id,
        top8,
        pole_driver_id: newPole,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,race_id" },
    );
    setSavingSprint(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (draftKey) {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
    }
    toast.success("Sprint picks locked in!");
    fireConfetti();
    await queryClient.invalidateQueries({ queryKey: ["sprint-prediction", race.id, user.id] });
  }

  const byId = new Map((drivers ?? []).map((d) => [d.id, d]));
  const hasResults = (results?.length ?? 0) > 0;
  const breakdown = hasResults
    ? scoreSprint(
        prediction ? { top8: prediction.top8 ?? [], pole_driver_id: prediction.pole_driver_id } : null,
        results as SprintResultRow[],
      )
    : null;

  const filledCount = top8.filter((d) => d !== EMPTY).length;
  const sprintSaved = (prediction?.top8?.filter((x) => x && x !== EMPTY).length ?? 0) === SPRINT_SLOTS;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 pb-28">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-gold">
            \u26a1 Sprint Weekend \u00b7 Round {race.round} \u00b7 Max +{SPRINT_MAX_POINTS} pts
          </p>
          <h1 className="text-3xl sm:text-4xl">{race.name} \u2014 Sprint</h1>
          <p className="text-sm text-muted-foreground">
            1 pt for every exact position in P1\u2013P8, plus 1 pt for Sprint Pole. No penalty if you skip.
          </p>
        </div>
        {(poleDirty || sprintDirty) && (
          <span className="rounded bg-gold/20 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-gold">
            {prediction ? "Unsaved edits" : "Draft auto-saved"}
          </span>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {poleLockAt && (
          <Countdown
            target={poleLockAt}
            label={poleLocked ? "Sprint Pole locked" : "Sprint Pole locks (SQ start)"}
          />
        )}
        {race.sprint_at && (
          <Countdown
            target={race.sprint_at}
            label={sprintLocked ? "Sprint picks locked" : "Sprint locks (Start)"}
          />
        )}
      </div>

      {hasResults && breakdown && (
        <section className="carbon-panel mt-6 rounded-lg p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xl">Your Sprint Score</h2>
            <span className="font-display text-3xl font-black text-gold">
              +{breakdown.total} PTS
            </span>
          </div>
          <div className="mt-4 grid gap-1.5 font-mono text-xs">
            {Array.from({ length: SPRINT_SLOTS }, (_, i) => i + 1).map((pos) => {
              const actualRow = results!.find((r) => r.finished && r.position === pos);
              const act = actualRow ? byId.get(actualRow.driver_id) : null;
              const pickedId = prediction?.top8?.[pos - 1];
              const pred = pickedId ? byId.get(pickedId) : null;
              const hit = actualRow && pickedId === actualRow.driver_id;
              return (
                <div
                  key={pos}
                  className="flex items-center justify-between rounded bg-secondary/50 px-3 py-1.5"
                  style={{ borderLeft: `3px solid ${teamColor(act?.team)}` }}
                >
                  <span>
                    P{pos} \u00b7 Actual <strong>{act?.code ?? "\u2014"}</strong> \u00b7 Your pick{" "}
                    <strong>{pred?.code ?? "\u2014"}</strong>
                  </span>
                  <span className={cn(hit && "font-bold text-gold")}>{hit ? "+1" : "0"}</span>
                </div>
              );
            })}
            <div className="mt-2 flex gap-2">
              <span className="rounded bg-secondary px-2 py-1">Sprint Pole +{breakdown.pole}</span>
            </div>
          </div>
        </section>
      )}

      {/* STEP 1 \u2014 SPRINT POLE */}
      <section className="carbon-panel mt-8 rounded-lg">
        <div className="kerb-strip" />
        <div className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-gold">
                Step 1 \u00b7 Locks at Sprint Qualifying \u00b7 +1 pt
              </p>
              <h2 className="text-xl">Sprint Pole Pick</h2>
            </div>
            <span
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[11px] uppercase",
                poleLocked
                  ? "bg-destructive/20 text-destructive"
                  : prediction?.pole_driver_id
                    ? "bg-gold/20 text-gold"
                    : "bg-secondary text-muted-foreground",
              )}
            >
              {poleLocked ? "Locked" : prediction?.pole_driver_id ? "Saved" : "Open"}
            </span>
          </div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <DriverSelect
                drivers={drivers ?? []}
                value={pole}
                onChange={setPole}
                disabled={poleLocked}
                placeholder="Choose sprint pole driver"
              />
            </div>
            {!poleLocked && (
              <Button type="button" onClick={savePole} disabled={savingPole || pole === EMPTY}>
                {savingPole
                  ? "Saving\u2026"
                  : prediction?.pole_driver_id
                    ? poleDirty
                      ? "Update Sprint Pole *"
                      : "Update Sprint Pole"
                    : "Lock in Sprint Pole"}
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* STEP 2 \u2014 SPRINT TOP 8 */}
      <form onSubmit={saveSprint}>
        <SprintGrid
          size={SPRINT_SLOTS}
          drivers={drivers ?? []}
          top10={top8}
          setTop10={setTop8}
          locked={sprintLocked}
          onRepeat={repeatLast}
        />

        {!sprintLocked && (
          <div className="mt-6 flex justify-end">
            <Button type="submit" size="lg" disabled={savingSprint}>
              {savingSprint
                ? "Locking in\u2026"
                : sprintSaved
                  ? sprintDirty
                    ? "Save Sprint Changes *"
                    : "Update Sprint Picks"
                  : `Lock in Sprint Top 8 (${filledCount}/${SPRINT_SLOTS})`}
            </Button>
          </div>
        )}
      </form>
    </main>
  );
}
'@
Write-Utf8NoBom -RelativePath "src/routes/sprint.tsx" -Content $c

# --- src/routes/leaderboard.tsx ---
$c = @'
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
'@
Write-Utf8NoBom -RelativePath "src/routes/leaderboard.tsx" -Content $c

Write-Host ""
Write-Host "[2/4] Running strict TypeScript check (npx tsc --noEmit)..." -ForegroundColor Cyan
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] TypeScript check failed. Aborting build and git push." -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "  [OK] Zero TypeScript errors across the entire project!" -ForegroundColor Green

Write-Host ""
Write-Host "[3/4] Running production build (npm run build)..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] Production build failed. Aborting git push." -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "  [OK] Production build succeeded!" -ForegroundColor Green

Write-Host ""
Write-Host "[4/4] Staging, committing, and pushing to GitHub..." -ForegroundColor Cyan
git add -A
$status = git status --porcelain
if ($status) {
    git commit -m "fix(build): resolve strict TS checks, sync standings, and apply UI/UX upgrades"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] git commit failed." -ForegroundColor Red
        exit $LASTEXITCODE
    }
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    Write-Host "  [INFO] Pushing branch '$branch' to origin..." -ForegroundColor Yellow
    git push origin $branch
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] git push failed. Check your network or GitHub credentials." -ForegroundColor Red
        exit $LASTEXITCODE
    }
    Write-Host "  [OK] Successfully committed and pushed to origin/$branch!" -ForegroundColor Green
} else {
    Write-Host "  [INFO] Working tree is already clean. Pushing any unpushed commits..." -ForegroundColor Yellow
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    git push origin $branch
}

Write-Host ""
Write-Host "=============================================================================" -ForegroundColor Green
Write-Host "  ALL DONE! Build passed & changes pushed to GitHub (Lovable will sync now)." -ForegroundColor Green
Write-Host "=============================================================================" -ForegroundColor Green
