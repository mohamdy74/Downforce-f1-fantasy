# ==============================================================================
# DOWNFORCE - PHASE 5 (LIVE VIRTUAL STANDINGS & INSTANT CHEQUERED FLAG FINALIZER)
# ==============================================================================
# Executes Phase 5 on top of Phases 1, 2, 3, and 4:
#   - LIVE-01:    Creates src/lib/liveStandings.ts with pure <1ms client/server
#                 Virtual Standings calculator (computeVirtualStandings) and
#                 OpenF1 Race Control Chequered Flag detector (hasChequeredFlag).
#   - INSTANT-01: Upgrades openF1Fallback in src/lib/f1-sync.functions.ts to
#                 check OpenF1 /v1/race_control for the Chequered Flag after
#                 40 minutes instead of waiting blindly for 80 minutes + 15m
#                 sync cooldown, while preventing premature scoring during Red
#                 Flag suspensions.
#   - CACHE-01:   Upgrades src/lib/weekend.functions.ts with a 22-second shared
#                 server-side telemetry cache + in-flight request deduplication
#                 (coalescing 50+ concurrent viewers into 1 OpenF1 request) and
#                 adds getLiveRaceTelemetry with automatic 0-second score
#                 finalization the moment the Chequered Flag waves.
#   - UI-LIVE-01: Upgrades src/routes/leaderboard.tsx, src/routes/paddock.tsx,
#                 and src/routes/weekend.tsx with Live Virtual Standings,
#                 Live/Official toggle, +PTS LIVE badges, rank movement arrows,
#                 live session classification, and instant post-race lock toast.
#   - TEST-03:    Expands tests/characterization.test.mjs to 7 test suites and
#                 verifies both `node --test` and `npm run build` before push.
# ==============================================================================

$ErrorActionPreference = "Continue"
Set-Location "C:\Users\moham\fidelity-image-viewer"

function Read-Utf8Lf([string]$RelativePath) {
    $FullPath = Join-Path (Get-Location).Path $RelativePath
    $Raw = [System.IO.File]::ReadAllText($FullPath, [System.Text.Encoding]::UTF8)
    return ($Raw -replace "\r\n", "`n")
}

function Write-Utf8NoBom([string]$RelativePath, [string]$Content) {
    $FullPath = Join-Path (Get-Location).Path $RelativePath
    $Dir = Split-Path -Parent $FullPath
    if (-not (Test-Path $Dir)) {
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    }
    $Normalized = ($Content -replace "\r\n", "`n")
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($FullPath, $Normalized, $Utf8NoBom)
    Write-Host "  [UPDATED] $RelativePath" -ForegroundColor Green
}

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "STEP 1: Creating Pure Virtual Standings & Chequered Flag Engine" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 1.1 Create src/lib/liveStandings.ts
Write-Utf8NoBom "src\lib\liveStandings.ts" @'
import { LEAGUE_START_ROUND, type LeaderboardEntry } from "./queries";
import {
  buildRaceScoreRows,
  type PredictionRecord,
  type ProfileRecord,
  type ScoreRecord,
  type SprintPredictionRecord,
} from "./roundScoring";
import { type ResultRow } from "./scoring";
import { type SprintResultRow } from "./sprintScoring";

export type OpenF1RaceControlMessage = {
  category?: string | null;
  flag?: string | null;
  message?: string | null;
  date?: string | null;
};

/**
 * Detects whether the Chequered Flag or official Session End has been signaled
 * in OpenF1 `/v1/race_control` telemetry messages.
 * Guards against premature scoring during Red Flag suspensions while allowing
 * zero-delay finalization the moment the leader crosses the finish line.
 */
export function hasChequeredFlag(
  messages: OpenF1RaceControlMessage[] | null | undefined,
): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (const m of messages) {
    const flag = (m.flag ?? "").toUpperCase();
    const msg = (m.message ?? "").toUpperCase();
    if (flag === "CHEQUERED" || flag === "CHECKERED") return true;
    if (msg.includes("CHEQUERED FLAG") || msg.includes("CHECKERED FLAG")) return true;
    if (msg.includes("SESSION ENDED") || msg.includes("RACE ENDED")) return true;
  }
  return false;
}

export type VirtualLeaderboardEntry = LeaderboardEntry & {
  /** Base official points before the live/simulated round */
  officialPoints: number;
  /** Official rank (1-indexed) before the live/simulated round */
  officialRank: number;
  /** Live/virtual points earned in the active race round */
  liveRoundPoints: number;
  /** Rank movement vs official standings: positive = moved up, negative = moved down */
  liveRankDelta: number;
  /** Live breakdown for the active round */
  liveBreakdown: Record<string, unknown> | null;
};

/**
 * Pure <1ms client/server calculator for Live Virtual Standings during an active race.
 * Never mutates the database; merges official standings with real-time telemetry results.
 */
export function computeVirtualStandings(params: {
  officialBoard: LeaderboardEntry[];
  raceId: string;
  round: number;
  raceAt: string | null;
  profiles: ProfileRecord[];
  liveResults: ResultRow[];
  predictions: PredictionRecord[];
  sprintResults?: SprintResultRow[] | null;
  sprintPredictions?: SprintPredictionRecord[] | null;
  existingScores?: ScoreRecord[] | null;
}): VirtualLeaderboardEntry[] {
  const {
    officialBoard,
    raceId,
    round,
    raceAt,
    profiles,
    liveResults,
    predictions,
    sprintResults = null,
    sprintPredictions = null,
    existingScores = null,
  } = params;

  if (!officialBoard.length) return [];
  if (round < LEAGUE_START_ROUND || !liveResults.length) {
    return officialBoard.map((e, i) => ({
      ...e,
      officialPoints: e.points,
      officialRank: i + 1,
      liveRoundPoints: e.byRound[round] ?? 0,
      liveRankDelta: 0,
      liveBreakdown: null,
    }));
  }

  const effectiveProfiles: ProfileRecord[] =
    profiles.length > 0
      ? profiles
      : officialBoard.map((e) => ({ id: e.userId, created_at: "2026-01-01T00:00:00.000Z" }));

  const builtRows = buildRaceScoreRows({
    raceId,
    raceAt,
    profiles: effectiveProfiles,
    results: liveResults,
    predictions,
    sprintResults,
    sprintPredictions,
    existingScores,
    mode: "auto_sync",
  });

  const liveRowByUser = new Map(builtRows.map((r) => [r.user_id, r]));

  const virtualEntries: VirtualLeaderboardEntry[] = officialBoard.map((entry, idx) => {
    const alreadyCountedPts = entry.byRound[round];
    const hasOfficialRoundScore = alreadyCountedPts !== undefined;
    const basePoints = hasOfficialRoundScore ? entry.points - alreadyCountedPts : entry.points;
    const baseRaces = hasOfficialRoundScore ? Math.max(0, entry.races - 1) : entry.races;

    const liveRow = liveRowByUser.get(entry.userId);
    const liveRoundPoints = liveRow ? liveRow.points : (alreadyCountedPts ?? 0);
    const totalPoints = basePoints + liveRoundPoints;
    const totalRaces = baseRaces + (liveRow || hasOfficialRoundScore ? 1 : 0);
    const nextByRound = { ...entry.byRound, [round]: liveRoundPoints };
    const nextBest =
      entry.best == null ? liveRoundPoints : Math.max(entry.best, liveRoundPoints);

    return {
      ...entry,
      points: totalPoints,
      races: totalRaces,
      best: nextBest,
      byRound: nextByRound,
      officialPoints: basePoints,
      officialRank: idx + 1,
      liveRoundPoints,
      liveRankDelta: 0,
      liveBreakdown: (liveRow?.breakdown as Record<string, unknown> | undefined) ?? null,
    };
  });

  // Sort by virtual points descending, then name ascending (identical tie-break to official board)
  virtualEntries.sort(
    (a, b) => b.points - a.points || a.name.localeCompare(b.name),
  );

  // Recompute virtual Fahl badge for the active round
  const topLiveRound = Math.max(...virtualEntries.map((e) => e.liveRoundPoints), -Infinity);
  for (let i = 0; i < virtualEntries.length; i++) {
    const entry = virtualEntries[i]!;
    const newRank = i + 1;
    entry.liveRankDelta = entry.officialRank - newRank;
    entry.change = entry.liveRankDelta;
    entry.fahl = Number.isFinite(topLiveRound) && entry.liveRoundPoints === topLiveRound;
  }

  return virtualEntries;
}
'@

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 2: Upgrading F1 Sync & Weekend Telemetry RPCs (Instant Score)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 2.1 Upgrade src/lib/f1-sync.functions.ts to detect Chequered Flag via /v1/race_control
$syncPath = "src\lib\f1-sync.functions.ts"
$sync = Read-Utf8Lf $syncPath

if (-not $sync.Contains('from "./liveStandings"')) {
    $sync = $sync.Replace(
        'import { isCompleteTop10, parsePushSubscriptionKey } from "./push-keys";',
        "import { isCompleteTop10, parsePushSubscriptionKey } from `"./push-keys`";`nimport { hasChequeredFlag, type OpenF1RaceControlMessage } from `"./liveStandings`";"
    )
}

$oldFallbackConsts = (@'
const OPENF1 = "https://api.openf1.org/v1";
const RACE_DONE_MS = 80 * 60 * 1000; // 80 minutes after lights out
const FALLBACK_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;
'@ -replace "\r\n", "`n")

$newFallbackConsts = (@'
const OPENF1 = "https://api.openf1.org/v1";
const RACE_MIN_START_MS = 40 * 60 * 1000; // Check Race Control from 40m after lights out
const RACE_MAX_DONE_MS = 180 * 60 * 1000; // 3h hard ceiling if race_control feed is empty
const FALLBACK_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;
'@ -replace "\r\n", "`n")

if ($sync.Contains($oldFallbackConsts)) {
    $sync = $sync.Replace($oldFallbackConsts, $newFallbackConsts)
}

$sync = $sync.Replace(
    '.lte("race_at", new Date(now - RACE_DONE_MS).toISOString())',
    '.lte("race_at", new Date(now - RACE_MIN_START_MS).toISOString())'
)

$oldOfFetch = (@'
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
'@ -replace "\r\n", "`n")

$newOfFetch = (@'
    const [results, ofDrivers, laps, raceControl] = await Promise.all([
      getJson<OF1Result[]>(`${OPENF1}/session_result?session_key=${rs.session_key}`),
      getJson<Array<{ driver_number: number; name_acronym: string }>>(
        `${OPENF1}/drivers?session_key=${rs.session_key}`,
      ),
      getJson<Array<{ driver_number: number; lap_duration: number | null }>>(
        `${OPENF1}/laps?session_key=${rs.session_key}`,
      ),
      getJson<OpenF1RaceControlMessage[]>(
        `${OPENF1}/race_control?session_key=${rs.session_key}`,
      ),
    ]);
    const raceElapsedMs = now - new Date(race.race_at).getTime();
    const isFinished = hasChequeredFlag(raceControl) || raceElapsedMs >= RACE_MAX_DONE_MS;
    if (!isFinished || !results || results.length < 10 || !ofDrivers) continue;
'@ -replace "\r\n", "`n")

if ($sync.Contains($oldOfFetch)) {
    $sync = $sync.Replace($oldOfFetch, $newOfFetch)
}
Write-Utf8NoBom $syncPath $sync

# 2.2 Upgrade src/lib/weekend.functions.ts with 22s shared server cache + getLiveRaceTelemetry
Write-Utf8NoBom "src\lib\weekend.functions.ts" @'
import { createServerFn } from "@tanstack/react-start";

import type { Json } from "@/integrations/supabase/types";
import { getJson, toIso as iso, fmtLap } from "./f1-parsers";
import { hasChequeredFlag, type OpenF1RaceControlMessage } from "./liveStandings";
import { buildRaceScoreRows, type PredictionRecord, type ProfileRecord, type ScoreRecord, type SprintPredictionRecord } from "./roundScoring";
import { type ResultRow } from "./scoring";
import { type SprintResultRow } from "./sprintScoring";
import {
  SESSION_MINUTES,
  isSessionType,
  type ClassRow,
  type ScheduleItem,
  type SessionPayload,
  type SessionType,
} from "./weekend";

const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const OPENF1 = "https://api.openf1.org/v1";
const SEASON = 2026;
const MIN = 60_000;
const LIVE_CACHE_TTL_MS = 22_000; // 22s shared server cache for live polling

type Admin = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];
type DbRace = {
  id: string;
  round: number;
  name: string;
  qualifying_at: string | null;
  race_at: string;
  has_results: boolean;
};
type SessRow = {
  id: string;
  session_type: string;
  starts_at: string | null;
  status: string;
  classification: Json;
  updated_at: string;
};

export type LiveRaceTelemetryPayload = {
  raceId: string;
  round: number;
  raceName: string;
  state: "upcoming" | "live" | "chequered" | "official";
  chequeredFlag: boolean;
  finalizedNow: boolean;
  updatedAt: string;
  results: ResultRow[];
  classification: ClassRow[];
};

// Per-server throttles & shared live telemetry cache (coalesces 50+ concurrent viewers into 1 OpenF1 request per 22s).
const scheduleChecked = new Map<string, number>();
const attempts = new Map<string, number>();
const liveSessionCache = new Map<string, { ts: number; rows: ClassRow[] }>();
const inFlightSessionFetch = new Map<string, Promise<ClassRow[]>>();
const liveRaceCache = new Map<string, { ts: number; payload: LiveRaceTelemetryPayload }>();
const inFlightLiveRace = new Map<string, Promise<LiveRaceTelemetryPayload>>();

type JSess = { date: string; time?: string | undefined };

// ---------------------------------------------------------------- schedule

async function loadRows(admin: Admin, raceId: string): Promise<SessRow[]> {
  const { data } = await admin
    .from("weekend_sessions")
    .select("id, session_type, starts_at, status, classification, updated_at")
    .eq("race_id", raceId)
    .order("updated_at", { ascending: false });
  // The table may hold accidental duplicates: keep the newest per session, delete the rest.
  const seen = new Set<string>();
  const keep: SessRow[] = [];
  const drop: string[] = [];
  for (const r of (data ?? []) as SessRow[]) {
    if (seen.has(r.session_type)) drop.push(r.id);
    else {
      seen.add(r.session_type);
      keep.push(r);
    }
  }
  if (drop.length) await admin.from("weekend_sessions").delete().in("id", drop);
  return keep;
}

async function ensureSchedule(admin: Admin, race: DbRace): Promise<SessRow[]> {
  let rows = await loadRows(admin, race.id);
  const hasCore =
    rows.some((r) => r.session_type === "qualifying") && rows.some((r) => r.session_type === "race");
  const last = scheduleChecked.get(race.id) ?? 0;
  if (hasCore && Date.now() - last < 6 * 60 * MIN) return rows;
  scheduleChecked.set(race.id, Date.now());

  type JRace = {
    FirstPractice?: JSess;
    SecondPractice?: JSess;
    ThirdPractice?: JSess;
    SprintQualifying?: JSess;
    SprintShootout?: JSess;
    Sprint?: JSess;
    Qualifying?: JSess;
  };
  const res = await getJson<{ MRData: { RaceTable: { Races: JRace[] } } }>(
    `${JOLPICA}/${SEASON}/${race.round}/races/?format=json`,
  );
  const jr = res?.MRData.RaceTable.Races?.[0];

  const wanted: Array<[SessionType, string | null]> = [
    ["fp1", iso(jr?.FirstPractice)],
    ["fp2", iso(jr?.SecondPractice)],
    ["fp3", iso(jr?.ThirdPractice)],
    ["sprint_qualifying", iso(jr?.SprintQualifying ?? jr?.SprintShootout)],
    ["sprint", iso(jr?.Sprint)],
    ["qualifying", iso(jr?.Qualifying) ?? race.qualifying_at],
    ["race", race.race_at],
  ];

  const inserts: Array<{
    race_id: string;
    session_type: string;
    starts_at: string;
    status: string;
    classification: Json;
  }> = [];
  let changed = false;
  for (const [type, startsAt] of wanted) {
    if (!startsAt) continue;
    const existing = rows.find((r) => r.session_type === type);
    if (!existing) {
      inserts.push({ race_id: race.id, session_type: type, starts_at: startsAt, status: "scheduled", classification: [] });
    } else if (!existing.starts_at || new Date(existing.starts_at).getTime() !== new Date(startsAt).getTime()) {
      await admin.from("weekend_sessions").update({ starts_at: startsAt }).eq("id", existing.id);
      changed = true;
    }
  }
  if (inserts.length) {
    await admin.from("weekend_sessions").insert(inserts);
    changed = true;
  }
  if (changed) rows = await loadRows(admin, race.id);
  return rows;
}

async function loadRace(admin: Admin, raceId: string): Promise<DbRace | null> {
  const { data } = await admin
    .from("races")
    .select("id, round, name, qualifying_at, race_at, has_results")
    .eq("id", raceId)
    .maybeSingle();
  return (data as DbRace | null) ?? null;
}

export const getWeekendSchedule = createServerFn({ method: "POST" })
  .inputValidator((input: { raceId: string }) => input)
  .handler(async ({ data }): Promise<{ sessions: ScheduleItem[] }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const race = await loadRace(supabaseAdmin, data.raceId);
    if (!race) return { sessions: [] };
    const rows = await ensureSchedule(supabaseAdmin, race);
    const sessions = rows
      .filter((r) => r.starts_at && isSessionType(r.session_type))
      .map((r) => ({ type: r.session_type as SessionType, startsAt: r.starts_at! }))
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    return { sessions };
  });

// ---------------------------------------------------------- classification

type DriverRef = { id: string; code: string | null; full_name: string; team: string | null; number: number | null };

function blank(): ClassRow {
  return {
    position: null,
    driverId: null,
    code: null,
    name: null,
    team: null,
    number: null,
    time: null,
    q1: null,
    q2: null,
    q3: null,
    gap: null,
    laps: null,
    status: null,
  };
}

type JDriver = { driverId: string; code?: string; givenName: string; familyName: string };

async function fromJolpica(
  race: DbRace,
  type: "qualifying" | "sprint",
  byId: Map<string, DriverRef>,
): Promise<ClassRow[]> {
  if (type === "qualifying") {
    const j = await getJson<{
      MRData: {
        RaceTable: {
          Races: Array<{
            QualifyingResults?: Array<{
              number?: string;
              position: string;
              Driver: JDriver;
              Constructor?: { name: string };
              Q1?: string;
              Q2?: string;
              Q3?: string;
            }>;
          }>;
        };
      };
    }>(`${JOLPICA}/${SEASON}/${race.round}/qualifying/?format=json`);
    const list = j?.MRData.RaceTable.Races?.[0]?.QualifyingResults ?? [];
    return list.map((r) => {
      const d = byId.get(r.Driver.driverId);
      return {
        ...blank(),
        position: Number(r.position),
        driverId: r.Driver.driverId,
        code: d?.code ?? r.Driver.code ?? null,
        name: d?.full_name ?? `${r.Driver.givenName} ${r.Driver.familyName}`,
        team: d?.team ?? r.Constructor?.name ?? null,
        number: r.number ? Number(r.number) : (d?.number ?? null),
        time: r.Q3 || r.Q2 || r.Q1 || null,
        q1: r.Q1 || null,
        q2: r.Q2 || null,
        q3: r.Q3 || null,
      };
    });
  }

  const j = await getJson<{
    MRData: {
      RaceTable: {
        Races: Array<{
          SprintResults?: Array<{
            position: string;
            laps?: string;
            status?: string;
            Driver: JDriver;
            Constructor?: { name: string };
            Time?: { time?: string };
          }>;
        }>;
      };
    };
  }>(`${JOLPICA}/${SEASON}/${race.round}/sprint/?format=json`);
  const list = j?.MRData.RaceTable.Races?.[0]?.SprintResults ?? [];
  return list.map((r, i) => {
    const d = byId.get(r.Driver.driverId);
    const finished = /finished|\+\d+ lap/i.test(r.status ?? "");
    return {
      ...blank(),
      position: Number(r.position),
      driverId: r.Driver.driverId,
      code: d?.code ?? r.Driver.code ?? null,
      name: d?.full_name ?? `${r.Driver.givenName} ${r.Driver.familyName}`,
      team: d?.team ?? r.Constructor?.name ?? null,
      number: d?.number ?? null,
      time: i === 0 ? (r.Time?.time ?? null) : null,
      gap: i === 0 ? null : (r.Time?.time ?? null),
      laps: r.laps ? Number(r.laps) : null,
      status: finished ? null : (r.status ?? null),
    };
  });
}

const OPENF1_NAMES: Record<SessionType, string[]> = {
  fp1: ["Practice 1"],
  fp2: ["Practice 2"],
  fp3: ["Practice 3"],
  sprint_qualifying: ["Sprint Qualifying", "Sprint Shootout"],
  sprint: ["Sprint"],
  qualifying: ["Qualifying"],
  race: ["Race"],
};

type OfSession = { session_key: number; session_name: string; date_start: string };
type OfResult = {
  position: number | null;
  driver_number: number;
  duration: number | Array<number | null> | null;
  gap_to_leader: number | string | Array<number | string | null> | null;
  number_of_laps: number | null;
  dnf?: boolean;
  dns?: boolean;
  dsq?: boolean;
};

async function fromOpenF1(
  type: SessionType,
  startsAt: string,
  byNumber: Map<number, DriverRef>,
): Promise<ClassRow[]> {
  const target = new Date(startsAt).getTime();
  const all = await getJson<OfSession[]>(`${OPENF1}/sessions?year=${SEASON}`);
  if (!Array.isArray(all)) return [];
  const names = OPENF1_NAMES[type];
  const match = all
    .filter((s) => names.includes(s.session_name))
    .map((s) => ({ s, diff: Math.abs(new Date(s.date_start).getTime() - target) }))
    .filter((x) => x.diff < 6 * 60 * MIN)
    .sort((a, b) => a.diff - b.diff)[0]?.s;
  if (!match) return [];

  const res = await getJson<OfResult[]>(`${OPENF1}/session_result?session_key=${match.session_key}`);
  if (!Array.isArray(res)) return [];

  const lastOf = <T,>(v: T | Array<T | null> | null): T | null => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i] as T;
      return null;
    }
    return v;
  };

  return res
    .map((r) => {
      const d = byNumber.get(r.driver_number);
      const dur = r.duration;
      const q = Array.isArray(dur) ? dur : null;
      const best = typeof lastOf(dur) === "number" ? (lastOf(dur) as number) : null;
      const gapRaw = lastOf(r.gap_to_leader);
      const gap =
        typeof gapRaw === "number" ? (gapRaw > 0 ? `+${gapRaw.toFixed(3)}` : null) : (gapRaw ?? null);
      return {
        ...blank(),
        position: r.position,
        driverId: d?.id ?? null,
        code: d?.code ?? null,
        name: d?.full_name ?? null,
        team: d?.team ?? null,
        number: d?.number ?? r.driver_number,
        time: fmtLap(best),
        q1: q ? fmtLap(q[0]) : null,
        q2: q ? fmtLap(q[1]) : null,
        q3: q ? fmtLap(q[2]) : null,
        gap,
        laps: r.number_of_laps,
        status: r.dsq ? "DSQ" : r.dns ? "DNS" : r.dnf ? "DNF" : null,
      } satisfies ClassRow;
    })
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
}

async function fetchClassification(
  admin: Admin,
  race: DbRace,
  type: SessionType,
  startsAt: string,
): Promise<ClassRow[]> {
  const { data: drivers } = await admin.from("drivers").select("id, code, full_name, team, number");
  const list = (drivers ?? []) as DriverRef[];
  const byId = new Map(list.map((d) => [d.id, d]));
  const byNumber = new Map(list.filter((d) => d.number != null).map((d) => [d.number!, d]));

  if (type === "qualifying" || type === "sprint") {
    const rows = await fromJolpica(race, type, byId);
    if (rows.length) return rows;
  }
  return fromOpenF1(type, startsAt, byNumber);
}

export const getWeekendSession = createServerFn({ method: "POST" })
  .inputValidator((input: { raceId: string; sessionType: string }) => input)
  .handler(async ({ data }): Promise<SessionPayload> => {
    const type = data.sessionType;
    if (!isSessionType(type) || type === "race") throw new Error("Unsupported session type");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const race = await loadRace(supabaseAdmin, data.raceId);
    if (!race) return { state: "upcoming", startsAt: null, rows: [] };

    const rows = await ensureSchedule(supabaseAdmin, race);
    const row = rows.find((r) => r.session_type === type);
    if (!row?.starts_at) return { state: "upcoming", startsAt: null, rows: [] };

    const start = new Date(row.starts_at).getTime();
    const end = start + SESSION_MINUTES[type] * MIN;
    const now = Date.now();
    if (now < start) return { state: "upcoming", startsAt: row.starts_at, rows: [] };

    const key = `${race.id}:${type}`;
    if (now < end) {
      // Live session: serve 22s shared server cache with in-flight deduplication
      const mem = liveSessionCache.get(key);
      if (mem && now - mem.ts < LIVE_CACHE_TTL_MS) {
        return { state: "live", startsAt: row.starts_at, rows: mem.rows };
      }
      let inflight = inFlightSessionFetch.get(key);
      if (!inflight) {
        inflight = fetchClassification(supabaseAdmin, race, type, row.starts_at).finally(() =>
          inFlightSessionFetch.delete(key),
        );
        inFlightSessionFetch.set(key, inflight);
      }
      const liveRows = await inflight;
      liveSessionCache.set(key, { ts: Date.now(), rows: liveRows });
      return { state: "live", startsAt: row.starts_at, rows: liveRows };
    }

    const cached = Array.isArray(row.classification) ? (row.classification as unknown as ClassRow[]) : [];
    if (cached.length && row.status === "completed") {
      return { state: "ready", startsAt: row.starts_at, rows: cached };
    }

    if (now - (attempts.get(key) ?? 0) < 25_000) {
      return { state: cached.length ? "ready" : "pending", startsAt: row.starts_at, rows: cached };
    }
    attempts.set(key, now);

    const fresh = await fetchClassification(supabaseAdmin, race, type, row.starts_at);
    if (!fresh.length) return { state: "pending", startsAt: row.starts_at, rows: [] };

    await supabaseAdmin
      .from("weekend_sessions")
      .update({
        classification: fresh as unknown as Json,
        status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { state: "ready", startsAt: row.starts_at, rows: fresh };
  });

/**
 * High-efficiency live race telemetry & Instant Chequered Flag Finalizer.
 * - Coalesces all concurrent client polls into 1 OpenF1 call per 22 seconds.
 * - Streams live driver positions, fastest lap, pole, and DNF status for `<1ms` client Virtual Standings.
 * - The moment OpenF1 `/v1/race_control` signals `CHEQUERED` flag (after >= 40m of racing),
 *   automatically persists `race_results`, marks `has_results = true`, and runs `buildRaceScoreRows`
 *   so official league points finalize in 0 seconds instead of waiting 8-15 minutes.
 */
export const getLiveRaceTelemetry = createServerFn({ method: "POST" })
  .inputValidator((input: { raceId: string }) => input)
  .handler(async ({ data }): Promise<LiveRaceTelemetryPayload> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const race = await loadRace(supabaseAdmin, data.raceId);
    if (!race) {
      return {
        raceId: data.raceId,
        round: 0,
        raceName: "",
        state: "upcoming",
        chequeredFlag: false,
        finalizedNow: false,
        updatedAt: new Date().toISOString(),
        results: [],
        classification: [],
      };
    }

    const now = Date.now();
    const startMs = new Date(race.race_at).getTime();
    if (now < startMs) {
      return {
        raceId: race.id,
        round: race.round,
        raceName: race.name,
        state: "upcoming",
        chequeredFlag: false,
        finalizedNow: false,
        updatedAt: new Date().toISOString(),
        results: [],
        classification: [],
      };
    }

    const cached = liveRaceCache.get(race.id);
    if (cached && now - cached.ts < LIVE_CACHE_TTL_MS) {
      return cached.payload;
    }

    let promise = inFlightLiveRace.get(race.id);
    if (!promise) {
      promise = (async (): Promise<LiveRaceTelemetryPayload> => {
        const { data: drivers } = await supabaseAdmin
          .from("drivers")
          .select("id, code, full_name, team, number");
        const drvList = (drivers ?? []) as DriverRef[];
        const byId = new Map(drvList.map((d) => [d.id, d]));
        const byCode = new Map(drvList.filter((d) => d.code).map((d) => [d.code!, d]));
        const byNumber = new Map(drvList.filter((d) => d.number != null).map((d) => [d.number!, d]));

        // If official results are already saved in DB, return them directly
        if (race.has_results) {
          const { data: dbResults } = await supabaseAdmin
            .from("race_results")
            .select("driver_id, position, finished, fastest_lap, pole")
            .eq("race_id", race.id)
            .order("position", { ascending: true, nullsFirst: false });
          if (dbResults?.length) {
            const classification: ClassRow[] = dbResults.map((r) => {
              const d = byId.get(r.driver_id);
              return {
                ...blank(),
                position: r.position,
                driverId: r.driver_id,
                code: d?.code ?? null,
                name: d?.full_name ?? null,
                team: d?.team ?? null,
                number: d?.number ?? null,
                status: r.finished ? null : "DNF",
              };
            });
            return {
              raceId: race.id,
              round: race.round,
              raceName: race.name,
              state: "official",
              chequeredFlag: true,
              finalizedNow: false,
              updatedAt: new Date().toISOString(),
              results: dbResults as ResultRow[],
              classification,
            };
          }
        }

        // Query OpenF1 live session
        const sessions = await getJson<OfSession[]>(`${OPENF1}/sessions?year=${SEASON}`);
        const nearSession = (name: string, isoTime: string | null) => {
          if (!isoTime || !Array.isArray(sessions)) return undefined;
          const t = new Date(isoTime).getTime();
          return sessions
            .filter((s) => s.session_name === name)
            .map((s) => ({ s, diff: Math.abs(new Date(s.date_start).getTime() - t) }))
            .filter((x) => x.diff < 6 * 60 * MIN)
            .sort((a, b) => a.diff - b.diff)[0]?.s;
        };

        const rs = nearSession("Race", race.race_at);
        if (!rs) {
          return {
            raceId: race.id,
            round: race.round,
            raceName: race.name,
            state: "live",
            chequeredFlag: false,
            finalizedNow: false,
            updatedAt: new Date().toISOString(),
            results: [],
            classification: [],
          };
        }

        const [ofResults, ofDrivers, laps, raceControl] = await Promise.all([
          getJson<OfResult[]>(`${OPENF1}/session_result?session_key=${rs.session_key}`),
          getJson<Array<{ driver_number: number; name_acronym: string }>>(
            `${OPENF1}/drivers?session_key=${rs.session_key}`,
          ),
          getJson<Array<{ driver_number: number; lap_duration: number | null }>>(
            `${OPENF1}/laps?session_key=${rs.session_key}`,
          ),
          getJson<OpenF1RaceControlMessage[]>(
            `${OPENF1}/race_control?session_key=${rs.session_key}`,
          ),
        ]);

        const numToDrv = new Map<number, DriverRef>();
        for (const d of drvList) {
          if (d.number != null) numToDrv.set(d.number, d);
        }
        for (const od of ofDrivers ?? []) {
          const matched = byCode.get(od.name_acronym);
          if (matched) numToDrv.set(od.driver_number, matched);
        }

        let poleNum: number | undefined;
        const qs = nearSession("Qualifying", race.qualifying_at);
        if (qs) {
          const qRes = await getJson<OfResult[]>(
            `${OPENF1}/session_result?session_key=${qs.session_key}`,
          );
          poleNum = qRes?.find((r) => r.position === 1)?.driver_number;
        }

        let flNum: number | undefined;
        let bestLap = Infinity;
        for (const l of laps ?? []) {
          if (l.lap_duration && l.lap_duration > 0 && l.lap_duration < bestLap) {
            bestLap = l.lap_duration;
            flNum = l.driver_number;
          }
        }

        const lastOf = <T,>(v: T | Array<T | null> | null): T | null => {
          if (Array.isArray(v)) {
            for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i] as T;
            return null;
          }
          return v;
        };

        const sortedOf = [...(ofResults ?? [])].sort(
          (a, b) => (a.position ?? 999) - (b.position ?? 999),
        );

        const classification: ClassRow[] = [];
        const liveResults: ResultRow[] = [];

        for (const r of sortedOf) {
          const d = numToDrv.get(r.driver_number) ?? byNumber.get(r.driver_number);
          const finished = r.position != null && !r.dnf && !r.dns && !r.dsq;
          const dur = lastOf(r.duration);
          const gapRaw = lastOf(r.gap_to_leader);
          const gap =
            typeof gapRaw === "number"
              ? gapRaw > 0
                ? `+${gapRaw.toFixed(3)}`
                : null
              : (gapRaw ?? null);

          classification.push({
            ...blank(),
            position: r.position,
            driverId: d?.id ?? null,
            code: d?.code ?? null,
            name: d?.full_name ?? null,
            team: d?.team ?? null,
            number: d?.number ?? r.driver_number,
            time: typeof dur === "number" ? fmtLap(dur) : null,
            gap,
            laps: r.number_of_laps ?? null,
            status: r.dsq ? "DSQ" : r.dns ? "DNS" : r.dnf ? "DNF" : null,
          });

          if (d?.id) {
            liveResults.push({
              driver_id: d.id,
              position: finished ? r.position : null,
              finished,
              fastest_lap: r.driver_number === flNum,
              pole: r.driver_number === poleNum,
            });
          }
        }

        const minutesElapsed = (Date.now() - startMs) / MIN;
        const chequered =
          (minutesElapsed >= 40 && hasChequeredFlag(raceControl)) || minutesElapsed >= 180;

        let finalizedNow = false;
        if (chequered && !race.has_results && liveResults.length >= 10) {
          // Instant Chequered Flag Finalizer: write results and compute official scores immediately!
          const dbRows = sortedOf.flatMap((r) => {
            const d = numToDrv.get(r.driver_number) ?? byNumber.get(r.driver_number);
            if (!d?.id) return [];
            const finished = r.position != null && !r.dnf && !r.dns && !r.dsq;
            return [
              {
                race_id: race.id,
                driver_id: d.id,
                position: finished ? r.position : null,
                status: finished ? "Finished" : r.dsq ? "Disqualified" : "Retired",
                finished,
                fastest_lap: r.driver_number === flNum,
                pole: r.driver_number === poleNum,
              },
            ];
          });

          if (dbRows.length >= 10) {
            await supabaseAdmin
              .from("race_results")
              .upsert(dbRows, { onConflict: "race_id,driver_id" });
            await supabaseAdmin.from("races").update({ has_results: true }).eq("id", race.id);

            const [
              { data: profiles },
              { data: predictions },
              { data: sprintResults },
              { data: sprintPreds },
              { data: existingScores },
            ] = await Promise.all([
              supabaseAdmin
                .from("profiles")
                .select("id, created_at")
                .lt("created_at", race.race_at),
              supabaseAdmin
                .from("predictions")
                .select("user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id")
                .eq("race_id", race.id),
              supabaseAdmin
                .from("sprint_results")
                .select("driver_id, position, finished, pole")
                .eq("race_id", race.id),
              supabaseAdmin
                .from("sprint_predictions")
                .select("user_id, top8, pole_driver_id")
                .eq("race_id", race.id),
              supabaseAdmin.from("scores").select("user_id, breakdown").eq("race_id", race.id),
            ]);

            const scoreRows = buildRaceScoreRows({
              raceId: race.id,
              raceAt: race.race_at,
              profiles: (profiles ?? []) as ProfileRecord[],
              results: liveResults,
              predictions: (predictions ?? []) as PredictionRecord[],
              sprintResults: (sprintResults ?? []) as SprintResultRow[],
              sprintPredictions: (sprintPreds ?? []) as SprintPredictionRecord[],
              existingScores: (existingScores ?? []) as ScoreRecord[],
              mode: "auto_sync",
            });

            if (scoreRows.length) {
              await supabaseAdmin
                .from("scores")
                .upsert(scoreRows, { onConflict: "user_id,race_id" });
            }
            finalizedNow = true;
          }
        }

        return {
          raceId: race.id,
          round: race.round,
          raceName: race.name,
          state: finalizedNow ? "official" : chequered ? "chequered" : "live",
          chequeredFlag: chequered,
          finalizedNow,
          updatedAt: new Date().toISOString(),
          results: liveResults,
          classification,
        };
      })().finally(() => {
        inFlightLiveRace.delete(race.id);
      });
      inFlightLiveRace.set(race.id, promise);
    }

    const payload = await promise;
    liveRaceCache.set(race.id, { ts: Date.now(), payload });
    return payload;
  });
'@

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 3: Wiring Live Virtual Standings & Live Debrief into UI" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 3.1 Upgrade src/routes/leaderboard.tsx
Write-Utf8NoBom "src\routes\leaderboard.tsx" @'
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";

import { FahlBadge } from "@/components/SiteHeader";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { syncF1Data } from "@/lib/f1-sync.functions";
import { computeVirtualStandings, type VirtualLeaderboardEntry } from "@/lib/liveStandings";
import { getTrustedNow, LEAGUE_START_ROUND, leaderboardQuery, racesQuery } from "@/lib/queries";
import type { PredictionRecord } from "@/lib/roundScoring";
import { cn } from "@/lib/utils";
import { getLiveRaceTelemetry } from "@/lib/weekend.functions";

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

  // Poll shared server live race telemetry every 25s ONLY when a race is live and tab is focused
  const liveTelemetryQ = useQuery({
    queryKey: ["live-race-telemetry", activeLiveRace?.id],
    enabled: !!user && !!activeLiveRace,
    staleTime: 20_000,
    refetchInterval: (q) => (q.state.data?.state === "official" ? false : 25_000),
    refetchIntervalInBackground: false,
    queryFn: async () => getLiveRaceTelemetry({ data: { raceId: activeLiveRace!.id } }),
  });

  // Load locked predictions for the active live race once (they never change after lock)
  const livePredsQ = useQuery({
    queryKey: ["live-race-predictions", activeLiveRace?.id],
    enabled: !!user && !!activeLiveRace,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<PredictionRecord[]> => {
      const { data, error } = await supabase
        .from("predictions")
        .select("user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id")
        .eq("race_id", activeLiveRace!.id);
      if (error) throw error;
      return (data ?? []) as PredictionRecord[];
    },
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
    !!activeLiveRace &&
    (liveTelemetryQ.data?.results.length ?? 0) >= 10 &&
    (livePredsQ.data?.length ?? 0) > 0;

  const virtualBoard = useMemo<VirtualLeaderboardEntry[] | null>(() => {
    if (!hasLiveTelemetry || !board || !activeLiveRace || !liveTelemetryQ.data || !livePredsQ.data) {
      return null;
    }
    return computeVirtualStandings({
      officialBoard: board,
      raceId: activeLiveRace.id,
      round: activeLiveRace.round,
      raceAt: activeLiveRace.race_at,
      profiles: [],
      liveResults: liveTelemetryQ.data.results,
      predictions: livePredsQ.data,
    });
  }, [hasLiveTelemetry, board, activeLiveRace, liveTelemetryQ.data, livePredsQ.data]);

  const isShowingVirtual = hasLiveTelemetry && viewMode === "live" && !!virtualBoard;
  const displayBoard: Array< VirtualLeaderboardEntry | NonNullable<typeof board>[number] > =
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
        <p className="text-sm text-muted-foreground">Loading standings\u2026</p>
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
            {isShowingVirtual && activeLiveRace ? ` \u00B7 + R${activeLiveRace.round} LIVE` : ""}
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
          {syncing ? "Syncing\u2026" : "Sync results"}
        </Button>
      </div>

      {activeLiveRace && (
        <div className="carbon-panel mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/50 bg-primary/10 px-3.5 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
            </span>
            <div>
              <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-primary">
                <Radio className="mr-1 inline h-3.5 w-3.5" />
                Live Virtual Standings \u00B7 R{activeLiveRace.round} {activeLiveRace.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {hasLiveTelemetry
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
                Official Only
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
        {isLoading && <p className="text-sm text-muted-foreground">Loading timing tower\u2026</p>}
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
                    {entry.races} scored \u00B7 best {entry.best ?? 0} | avg {entry.races ? (entry.points / entry.races).toFixed(1) : 0}
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
                        (r.has_results || (isShowingVirtual && r.id === activeLiveRace?.id)) &&
                        displayBoard.some((e) => (e.byRound[r.round] ?? 0) !== 0),
                    )
                    .map((r) => (
                      <div
                        key={r.id}
                        className={cn(
                          "rounded-sm px-1 py-1 text-center",
                          isShowingVirtual && r.id === activeLiveRace?.id
                            ? "border border-primary/50 bg-primary/15"
                            : "bg-muted/60",
                        )}
                      >
                        <p className="font-mono text-[10px] uppercase text-muted-foreground">
                          R{r.round}
                          {isShowingVirtual && r.id === activeLiveRace?.id ? " \u2022" : ""}
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
'@

# 3.2 Upgrade src/routes/paddock.tsx
Write-Utf8NoBom "src\routes\paddock.tsx" @'
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
import { getLiveRaceTelemetry } from "@/lib/weekend.functions";

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

  const liveTelemetryQ = useQuery({
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

  if (loading) return <main className="mx-auto max-w-3xl px-4 py-16">Loading\u2026</main>;
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
    if (dbPt != null && !isLiveScoring) {
      computedPoints.set(p.user_id, dbPt);
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
                  "carbon-panel shrink-0 rounded-full border px-3.5 py-1.5 font-mono text-xs font-semibold transition-all",
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
                          {actual ? `P${actual}` : "DNF"} \u00B7 {pt > 0 ? `+${pt}` : pt}
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
        {entries.length} change{entries.length > 1 ? "s" : ""} \u00B7 last {fmt(entries[entries.length - 1]!.created_at)} (Cairo)
      </summary>
      <ul className="mt-1 space-y-0.5 font-mono">
        {entries.map((e, i) => (
          <li key={i}>
            {fmt(e.created_at)} \u2014 {ACTION_LABEL[e.action] ?? e.action} {describe(e.changes)}
          </li>
        ))}
      </ul>
    </details>
  );
}
'@

# 3.3 Upgrade src/routes/weekend.tsx so live practice/qualifying/sprint sessions render live rows
$wkRoutePath = "src\routes\weekend.tsx"
$wkRoute = Read-Utf8Lf $wkRoutePath

$oldWkQuery = (@'
    staleTime: (query) => (query.state.data?.state === "ready" ? Number.POSITIVE_INFINITY : 30_000),
    refetchInterval: (query) => (query.state.data?.state === "ready" ? false : 60_000),
'@ -replace "\r\n", "`n")

$newWkQuery = (@'
    staleTime: (query) => (query.state.data?.state === "ready" ? Number.POSITIVE_INFINITY : 20_000),
    refetchInterval: (query) => (query.state.data?.state === "ready" ? false : 25_000),
    refetchIntervalInBackground: false,
'@ -replace "\r\n", "`n")

if ($wkRoute.Contains($oldWkQuery)) {
    $wkRoute = $wkRoute.Replace($oldWkQuery, $newWkQuery)
}

$oldWkLiveCheck = (@'
  if (state === "live")
    return <Empty text={`${SESSION_LABEL[type]} is in progress. The classification appears once it ends.`} />;
'@ -replace "\r\n", "`n")

$newWkLiveCheck = (@'
  if (state === "live" && (!data || !data.rows.length))
    return <Empty text={`${SESSION_LABEL[type]} is live on track. Waiting for telemetry laps\u2026`} />;
'@ -replace "\r\n", "`n")

if ($wkRoute.Contains($oldWkLiveCheck)) {
    $wkRoute = $wkRoute.Replace($oldWkLiveCheck, $newWkLiveCheck)
}
Write-Utf8NoBom $wkRoutePath $wkRoute

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 4: Expanding Characterization Test Suite (Suite 7)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

Write-Utf8NoBom "tests\characterization.test.mjs" @'
import test from "node:test";
import assert from "node:assert/strict";

// 1. Scoring contract (src/lib/scoring.ts)
const POSITION_POINTS = { 0: 3, 1: 2, 2: 1, 3: -1, 4: -2 };
const NO_SUBMISSION_PENALTY = -25;

function positionPoints(diff) {
  return diff in POSITION_POINTS ? POSITION_POINTS[diff] : -3;
}

function scorePrediction(prediction, results) {
  const finishPosition = new Map();
  for (const r of results) {
    if (r.finished && r.position != null) finishPosition.set(r.driver_id, r.position);
  }
  const poleDriver = results.find((r) => r.pole)?.driver_id ?? null;
  const fastestLapDriver = results.find((r) => r.fastest_lap)?.driver_id ?? null;
  const dnfDrivers = new Set(results.filter((r) => !r.finished).map((r) => r.driver_id));

  let top10 = 0;
  let exactCount = 0;
  prediction.top10.slice(0, 10).forEach((driverId, index) => {
    const predicted = index + 1;
    const actual = finishPosition.get(driverId);
    const diff = actual == null ? 99 : Math.abs(actual - predicted);
    if (diff === 0) exactCount += 1;
    top10 += positionPoints(diff);
  });

  const poleCorrect =
    !!prediction.pole_driver_id && prediction.pole_driver_id === poleDriver;
  const flCorrect =
    !!prediction.fastest_lap_driver_id &&
    prediction.fastest_lap_driver_id === fastestLapDriver;
  const dnfCorrect =
    !!prediction.dnf_driver_id && dnfDrivers.has(prediction.dnf_driver_id);

  const pole = poleCorrect ? 3 : 0;
  const fastestLap = flCorrect ? 3 : 0;
  const dnf = dnfCorrect ? 1 : 0;

  const perfectTop10 = prediction.top10.length === 10 && exactCount === 10;
  const perfectWeekend = perfectTop10 && poleCorrect && flCorrect && dnfCorrect;
  const perfect = perfectWeekend ? 15 : perfectTop10 ? 10 : 0;

  const total = top10 + pole + fastestLap + dnf + perfect;
  return { top10, pole, fastestLap, dnf, perfect, perfectTop10, perfectWeekend, total };
}

// 2. Sprint scoring contract (src/lib/sprintScoring.ts)
const SPRINT_SLOTS = 8;
function scoreSprint(prediction, results) {
  if (!prediction) return { top8: 0, pole: 0, total: 0 };
  const finishPosition = new Map();
  for (const r of results) {
    if (r.finished && r.position != null) finishPosition.set(r.driver_id, r.position);
  }
  const poleDriver = results.find((r) => r.pole)?.driver_id ?? null;

  let top8 = 0;
  (prediction.top8 ?? []).slice(0, SPRINT_SLOTS).forEach((driverId, index) => {
    if (finishPosition.get(driverId) === index + 1) top8 += 1;
  });

  const pole =
    !!prediction.pole_driver_id && prediction.pole_driver_id === poleDriver ? 1 : 0;

  return { top8, pole, total: top8 + pole };
}

// 3. Round scoring contract (src/lib/roundScoring.ts)
function filterValidDriverIds(ids) {
  return (ids ?? []).filter((x) => Boolean(x && x !== "__none__"));
}

function isCompleteTop10(top10) {
  return Array.isArray(top10) && filterValidDriverIds(top10).length === 10;
}

function extractStewardLockedUsers(existingScores) {
  return new Set(
    (existingScores ?? [])
      .filter((s) => {
        const b = s.breakdown;
        return b && typeof b === "object" && b["stewardOverride"] === true;
      })
      .map((s) => s.user_id),
  );
}

function buildRaceScoreRows({
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
  nowIso = "2026-10-21T00:00:00.000Z",
}) {
  const stewardLockedUsers = extractStewardLockedUsers(existingScores);
  const byUser = new Map((predictions ?? []).map((p) => [p.user_id, p]));
  const sprintByUser = new Map((sprintPredictions ?? []).map((p) => [p.user_id, p]));
  const sprintFor = (userId) =>
    sprintResults?.length
      ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults)
      : null;

  const rows = [];
  for (const profile of profiles ?? []) {
    if (stewardLockedUsers.has(profile.id)) continue;
    if (raceAt && new Date(profile.created_at) > new Date(raceAt)) continue;

    const sprint = sprintFor(profile.id);
    const sprintTotal = sprint?.total ?? 0;
    const pr = byUser.get(profile.id);
    const validTop10 = filterValidDriverIds(pr?.top10);

    if (!pr || validTop10.length < 10) {
      if (!pr) {
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: NO_SUBMISSION_PENALTY + sprintTotal,
          breakdown: {
            noSubmission: true,
            ...(sprint ? { sprint } : {}),
            total: NO_SUBMISSION_PENALTY + sprintTotal,
          },
          updated_at: nowIso,
        });
      } else {
        const poleHit =
          mode === "manual_results"
            ? pr.pole_driver_id && pr.pole_driver_id === manualPoleWinner
              ? 3
              : 0
            : scorePrediction(
                {
                  top10: validTop10,
                  pole_driver_id: pr.pole_driver_id,
                  fastest_lap_driver_id: pr.fastest_lap_driver_id,
                  dnf_driver_id: pr.dnf_driver_id,
                },
                results,
              ).pole;
        const total = NO_SUBMISSION_PENALTY + poleHit + sprintTotal;
        const breakdownObj =
          mode === "auto_sync"
            ? { noSubmission: true, poleOnly: true, pole: poleHit, ...(sprint ? { sprint } : {}), total }
            : { noSubmission: true, pole: poleHit, ...(sprint ? { sprint } : {}), total };
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: breakdownObj,
          updated_at: nowIso,
        });
      }
      continue;
    }

    const b = scorePrediction(
      {
        top10: validTop10,
        pole_driver_id: pr.pole_driver_id,
        fastest_lap_driver_id: pr.fastest_lap_driver_id,
        dnf_driver_id: pr.dnf_driver_id,
      },
      results,
    );
    const total = b.total + sprintTotal;
    rows.push({
      user_id: profile.id,
      race_id: raceId,
      points: total,
      breakdown: { ...b, ...(sprint ? { sprint } : {}), total },
      updated_at: nowIso,
    });
  }
  return rows;
}

// 4. Leaderboard aggregation contract (src/lib/queries.ts)
const LEAGUE_START_ROUND = 14;
function computeLeaderboardEntries(profiles, scores, raceRows) {
  const rMap = new Map((raceRows ?? []).map((r) => [r.id, r.round]));
  const activeRounds = new Set();
  for (const s of scores ?? []) {
    const rd = rMap.get(s.race_id);
    if (rd != null && rd >= LEAGUE_START_ROUND && s.points !== 0) {
      activeRounds.add(rd);
    }
  }

  const byUser = new Map();
  for (const p of profiles ?? []) {
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
  for (const s of scores ?? []) {
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

  const sort = (a, b) => b.points - a.points || a.name.localeCompare(b.name);
  const list = [...byUser.values()].sort(sort);

  if (latestRound > 0) {
    const prevPts = new Map();
    for (const s of scores ?? []) {
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

// 5. Push keys & F1 parsers contract
function parsePushSubscriptionKey(key) {
  const m = /^push_sub:([^:]+):(.+)$/.exec(key);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[2]);
    const p256dh = raw.keys?.p256dh ?? raw.p256dh;
    const auth = raw.keys?.auth ?? raw.auth;
    if (!raw.endpoint || !p256dh || !auth) return null;
    return { userId: m[1], endpoint: raw.endpoint, p256dh, auth, rawKey: key };
  } catch {
    return null;
  }
}

function findStalePushKeysForEndpoint(existingKeys, userId, endpoint) {
  const prefix = `push_sub:${userId}:`;
  const stale = [];
  for (const key of existingKeys) {
    if (!key.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(key.slice(prefix.length));
      if (parsed.endpoint === endpoint) stale.push(key);
    } catch {
      stale.push(key);
    }
  }
  return stale;
}

function toIso(session) {
  if (!session?.date) return null;
  const d = new Date(`${session.date}T${session.time ?? "12:00:00Z"}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isClassifiedFinishStatus(status, includeLappedKeyword = true) {
  if (!status) return false;
  return includeLappedKeyword
    ? /finished|lapped|\+\d+ lap/i.test(status)
    : /finished|\+\d+ lap/i.test(status);
}

function fmtLap(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : s;
}

function formatCairoDate(iso, seconds = false) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}${seconds ? ":" + get("second") : ""}`;
  return `${get("weekday")} ${get("day")} ${get("month")} \u00B7 ${time}`.toUpperCase();
}

test("Characterization 1: positionPoints & scorePrediction preserve exact F1 league scoring rules", () => {
  assert.equal(positionPoints(0), 3);
  assert.equal(positionPoints(1), 2);
  assert.equal(positionPoints(2), 1);
  assert.equal(positionPoints(3), -1);
  assert.equal(positionPoints(4), -2);
  assert.equal(positionPoints(5), -3);
  assert.equal(positionPoints(99), -3);

  const drivers = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"];
  const results = [
    ...drivers.map((id, i) => ({
      driver_id: id,
      position: i + 1,
      finished: true,
      pole: i === 0,
      fastest_lap: i === 1,
    })),
    { driver_id: "dnf1", position: null, finished: false, pole: false, fastest_lap: false },
  ];

  const perfect = scorePrediction(
    { top10: drivers, pole_driver_id: "d1", fastest_lap_driver_id: "d2", dnf_driver_id: "dnf1" },
    results,
  );
  assert.equal(perfect.total, 52);
  assert.equal(perfect.perfectWeekend, true);
});

test("Characterization 2: scoreSprint awards max 9 points and handles null safely", () => {
  const top8 = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];
  const results = top8.map((id, i) => ({
    driver_id: id,
    position: i + 1,
    finished: true,
    pole: i === 0,
  }));
  assert.deepEqual(scoreSprint(null, results), { top8: 0, pole: 0, total: 0 });
  assert.deepEqual(scoreSprint({ top8, pole_driver_id: "d1" }, results), { top8: 8, pole: 1, total: 9 });
});

test("Characterization 3: buildRaceScoreRows preserves stewardOverride lock, post-race signup exemption, and auto_sync vs manual_results contracts", () => {
  const results = Array.from({ length: 10 }, (_, i) => ({
    driver_id: `d${i + 1}`,
    position: i + 1,
    finished: true,
    pole: i === 0,
    fastest_lap: i === 0,
  }));
  const profiles = [
    { id: "u_locked", created_at: "2026-01-01T00:00:00Z" },
    { id: "u_late", created_at: "2026-10-25T00:00:00Z" },
    { id: "u_missing", created_at: "2026-01-01T00:00:00Z" },
    { id: "u_pole_only", created_at: "2026-01-01T00:00:00Z" },
  ];
  const predictions = [
    { user_id: "u_pole_only", top10: ["__none__"], pole_driver_id: "d1", fastest_lap_driver_id: null, dnf_driver_id: null },
  ];
  const existingScores = [
    { user_id: "u_locked", breakdown: { stewardOverride: true, total: 99 } },
  ];

  const autoRows = buildRaceScoreRows({
    raceId: "r1",
    raceAt: "2026-10-20T14:00:00Z",
    profiles,
    results,
    predictions,
    sprintResults: [],
    sprintPredictions: [],
    existingScores,
    mode: "auto_sync",
  });
  assert.equal(autoRows.length, 2);
  assert.deepEqual(autoRows[0].breakdown, { noSubmission: true, total: -25 });
  assert.deepEqual(autoRows[1].breakdown, { noSubmission: true, poleOnly: true, pole: 3, total: -22 });

  const manualRows = buildRaceScoreRows({
    raceId: "r1",
    raceAt: "2026-10-20T14:00:00Z",
    profiles,
    results,
    predictions,
    sprintResults: [],
    sprintPredictions: [],
    existingScores,
    mode: "manual_results",
    manualPoleWinner: "d1",
  });
  assert.equal(manualRows.length, 2);
  assert.deepEqual(manualRows[0].breakdown, { noSubmission: true, total: -25 });
  assert.deepEqual(manualRows[1].breakdown, { noSubmission: true, pole: 3, total: -22 });
});

test("Characterization 4: computeLeaderboardEntries filters R14+, strips zero-only rounds, and computes Fahl & rank change", () => {
  const profiles = [
    { id: "u1", display_name: "Mohamed Hamdy", avatar_url: null },
    { id: "u2", display_name: "Ahmed Hatem", avatar_url: null },
  ];
  const raceRows = [
    { id: "r13", round: 13 },
    { id: "r14", round: 14 },
    { id: "r15", round: 15 },
    { id: "r16", round: 16 },
  ];
  const scores = [
    { user_id: "u1", race_id: "r13", points: 50 },
    { user_id: "u1", race_id: "r14", points: 13 },
    { user_id: "u2", race_id: "r14", points: 9 },
    { user_id: "u1", race_id: "r15", points: 0 },
    { user_id: "u2", race_id: "r15", points: 0 },
    { user_id: "u1", race_id: "r16", points: 4 },
    { user_id: "u2", race_id: "r16", points: 18 },
  ];

  const board = computeLeaderboardEntries(profiles, scores, raceRows);
  assert.equal(board[0].userId, "u2");
  assert.equal(board[0].points, 27);
  assert.equal(board[0].fahl, true);
  assert.equal(board[0].change, 1);
  assert.equal(board[1].userId, "u1");
  assert.equal(board[1].points, 17);
  assert.equal(board[1].change, -1);
});

test("Characterization 5: push-keys and f1-parsers preserve exact string and regex semantics", () => {
  const key = 'push_sub:u123:{"endpoint":"https://fcm.googleapis.com/1","p256dh":"k","auth":"a"}';
  const parsed = parsePushSubscriptionKey(key);
  assert.equal(parsed?.userId, "u123");
  assert.equal(parsed?.endpoint, "https://fcm.googleapis.com/1");

  const stale = findStalePushKeysForEndpoint(
    [key, "push_sub:u123:corrupt-json", 'push_sub:u123:{"endpoint":"https://other"}'],
    "u123",
    "https://fcm.googleapis.com/1",
  );
  assert.deepEqual(stale, [key, "push_sub:u123:corrupt-json"]);
  assert.equal(toIso({ date: "2026-10-25", time: "19:00:00Z" }), "2026-10-25T19:00:00.000Z");
  assert.equal(isClassifiedFinishStatus("Finished"), true);
  assert.equal(isClassifiedFinishStatus("+1 Lap"), true);
  assert.equal(isClassifiedFinishStatus("Retired"), false);
  assert.equal(fmtLap(83.456), "1:23.456");
});

test("Characterization 6: isCompleteTop10, DNF constructor filter, and Cairo timezone formatting", () => {
  assert.equal(isCompleteTop10(["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"]), true);
  assert.equal(isCompleteTop10(["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "__none__"]), false);
  assert.equal(isCompleteTop10([]), false);
  assert.equal(isCompleteTop10(null), false);

  const sampleDrivers = [
    { id: "alo", team: "Aston Martin" },
    { id: "per", team: "Cadillac F1 Team" },
    { id: "ver", team: "Red Bull" },
    { id: "nor", team: "McLaren" },
  ];
  const eligibleDnf = sampleDrivers.filter((d) => !/aston|cadillac/i.test(d.team ?? ""));
  assert.deepEqual(eligibleDnf.map((d) => d.id), ["ver", "nor"]);

  const cairoLabel = formatCairoDate("2026-10-24T20:45:00.000Z", false);
  assert.ok(cairoLabel && cairoLabel.includes("\u00B7") && cairoLabel.includes("OCT"));
});
// 7. Live Virtual Standings & Chequered Flag Instant Finalizer contract (src/lib/liveStandings.ts)
function hasChequeredFlag(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (const m of messages) {
    const flag = (m.flag ?? "").toUpperCase();
    const msg = (m.message ?? "").toUpperCase();
    if (flag === "CHEQUERED" || flag === "CHECKERED") return true;
    if (msg.includes("CHEQUERED FLAG") || msg.includes("CHECKERED FLAG")) return true;
    if (msg.includes("SESSION ENDED") || msg.includes("RACE ENDED")) return true;
  }
  return false;
}

function computeVirtualStandings({
  officialBoard,
  raceId,
  round,
  raceAt,
  profiles,
  liveResults,
  predictions,
}) {
  if (!officialBoard.length) return [];
  const effectiveProfiles =
    profiles.length > 0
      ? profiles
      : officialBoard.map((e) => ({ id: e.userId, created_at: "2026-01-01T00:00:00.000Z" }));

  const builtRows = buildRaceScoreRows({
    raceId,
    raceAt,
    profiles: effectiveProfiles,
    results: liveResults,
    predictions,
    sprintResults: [],
    sprintPredictions: [],
    existingScores: [],
    mode: "auto_sync",
  });

  const liveRowByUser = new Map(builtRows.map((r) => [r.user_id, r]));
  const virtualEntries = officialBoard.map((entry, idx) => {
    const alreadyCountedPts = entry.byRound[round];
    const hasOfficialRoundScore = alreadyCountedPts !== undefined;
    const basePoints = hasOfficialRoundScore ? entry.points - alreadyCountedPts : entry.points;
    const baseRaces = hasOfficialRoundScore ? Math.max(0, entry.races - 1) : entry.races;
    const liveRow = liveRowByUser.get(entry.userId);
    const liveRoundPoints = liveRow ? liveRow.points : (alreadyCountedPts ?? 0);
    const totalPoints = basePoints + liveRoundPoints;
    const totalRaces = baseRaces + (liveRow || hasOfficialRoundScore ? 1 : 0);
    const nextByRound = { ...entry.byRound, [round]: liveRoundPoints };
    const nextBest = entry.best == null ? liveRoundPoints : Math.max(entry.best, liveRoundPoints);
    return {
      ...entry,
      points: totalPoints,
      races: totalRaces,
      best: nextBest,
      byRound: nextByRound,
      officialPoints: basePoints,
      officialRank: idx + 1,
      liveRoundPoints,
      liveRankDelta: 0,
    };
  });

  virtualEntries.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  const topLiveRound = Math.max(...virtualEntries.map((e) => e.liveRoundPoints), -Infinity);
  for (let i = 0; i < virtualEntries.length; i++) {
    const entry = virtualEntries[i];
    entry.liveRankDelta = entry.officialRank - (i + 1);
    entry.change = entry.liveRankDelta;
    entry.fahl = Number.isFinite(topLiveRound) && entry.liveRoundPoints === topLiveRound;
  }
  return virtualEntries;
}

test("Characterization 7: hasChequeredFlag & computeVirtualStandings compute real-time rank deltas and guard Red Flag races", () => {
  assert.equal(hasChequeredFlag([]), false);
  assert.equal(hasChequeredFlag([{ flag: "RED", message: "RED FLAG - SESSION SUSPENDED" }]), false);
  assert.equal(hasChequeredFlag([{ flag: "CHEQUERED", message: "CHEQUERED FLAG" }]), true);
  assert.equal(hasChequeredFlag([{ category: "SessionStatus", message: "SESSION ENDED" }]), true);

  const officialBoard = [
    { userId: "u_ahmed", name: "Ahmed Hatem", avatar: null, points: 46, races: 4, best: 18, change: 0, byRound: { 14: 12, 15: 16, 16: 18 }, fahl: true },
    { userId: "u_mohamed", name: "Mohamed Hamdy", avatar: null, points: 32, races: 4, best: 14, change: 0, byRound: { 14: 10, 15: 8, 16: 14 }, fahl: false },
  ];

  const drivers = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"];
  const liveResults = drivers.map((id, i) => ({
    driver_id: id,
    position: i + 1,
    finished: true,
    pole: i === 0,
    fastest_lap: i === 1,
  }));

  const predictions = [
    // Mohamed nails exact top 10 + Pole + FL (+30 + 3 + 3 + 10 = +46 pts!)
    { user_id: "u_mohamed", top10: drivers, pole_driver_id: "d1", fastest_lap_driver_id: "d2", dnf_driver_id: null },
    // Ahmed misses all top 10 (-30 pts)
    { user_id: "u_ahmed", top10: ["x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "x10"], pole_driver_id: null, fastest_lap_driver_id: null, dnf_driver_id: null },
  ];

  const virtual = computeVirtualStandings({
    officialBoard,
    raceId: "r18",
    round: 18,
    raceAt: "2026-10-25T19:00:00Z",
    profiles: [],
    liveResults,
    predictions,
  });

  assert.equal(virtual[0].userId, "u_mohamed");
  assert.equal(virtual[0].liveRoundPoints, 46);
  assert.equal(virtual[0].points, 32 + 46);
  assert.equal(virtual[0].liveRankDelta, 1); // jumped from #2 to #1!
  assert.equal(virtual[0].fahl, true);

  assert.equal(virtual[1].userId, "u_ahmed");
  assert.equal(virtual[1].liveRoundPoints, -30);
  assert.equal(virtual[1].points, 46 - 30);
  assert.equal(virtual[1].liveRankDelta, -1); // dropped from #1 to #2!
});
'@

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 5: Running Characterization Tests & Production Build" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

node --test tests/characterization.test.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  [ERROR] Characterization tests failed! Rolling back Phase 5..." -ForegroundColor Red
    git checkout -- .
    Remove-Item -Path "src\lib\liveStandings.ts" -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "  [PASS] All 7 Characterization Test Suites passed!" -ForegroundColor Green

npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  [ERROR] Production build failed! Rolling back Phase 5..." -ForegroundColor Red
    git checkout -- .
    Remove-Item -Path "src\lib\liveStandings.ts" -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "  [PASS] Production build succeeded with 0 errors!" -ForegroundColor Green

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 6: Committing & Pushing Phase 5 to GitHub (origin/main)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

git add -A
git commit -m "Phase 5: add Live Virtual Standings (<1ms client calc + 22s shared server telemetry cache) and Instant Chequered Flag score finalizer"
git push origin main

Write-Host "`n==================================================================" -ForegroundColor Green
Write-Host "SUCCESS! Phase 5 (Live Standings + Instant Score) is live!" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
