import { createServerFn } from "@tanstack/react-start";

import type { Json } from "@/integrations/supabase/types";
import { getJson, toIso as iso, fmtLap, parseLapTimeSeconds } from "./f1-parsers";
import {
  buildDriverLookup,
  fetchFromEspnScoreboard,
  fetchFromF1LiveTiming,
  getCachedOpenF1Drivers,
  getCachedOpenF1Sessions,
  resolveDriver,
  type DriverLookup,
  type DriverRef,
  type OfSession,
} from "./f1-live-sources";
import {
  buildLiveOrderFromPositions,
  buildTimedSessionOrderFromLaps,
  hasChequeredFlag,
  type OpenF1LapEntry,
  type OpenF1PositionEntry,
  type OpenF1RaceControlMessage,
} from "./liveStandings";
import {
  buildRaceScoreRows,
  type PredictionRecord,
  type ProfileRecord,
  type ScoreRecord,
  type SprintPredictionRecord,
} from "./roundScoring";
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
const LIVE_CACHE_TTL_MS = 20_000; // 20s shared server cache for live polling

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

/**
 * 100% JSON-serializable payload for TanStack Start `ValidateSerializableMapped<T>`.
 * Maps `liveScores` as `Record<string, number>` (userId -> total live round points).
 */
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
  liveScores: Record<string, number>;
};

const scheduleChecked = new Map<string, number>();
const attempts = new Map<string, number>();
const liveSessionCache = new Map<string, { ts: number; rows: ClassRow[] }>();
const inFlightSessionFetch = new Map<string, Promise<ClassRow[]>>();
const liveRaceCache = new Map<string, { ts: number; payload: LiveRaceTelemetryPayload }>();
const inFlightLiveRace = new Map<string, Promise<LiveRaceTelemetryPayload>>();
const cachedPoleByRace = new Map<string, string>(); // raceId -> driver_id

type JSess = { date: string; time?: string | undefined };

/**
 * Verifies that a session classification not only has driver positions (>= 5 rows),
 * but ALSO has actual lap times (`time`) and, for Qualifying / Sprint Qualifying,
 * `Q1 / Q2 / Q3` segment splits. Prevents position-only snapshots from locking
 * the DB or browser cache before full timing telemetry arrives.
 */
export function hasCompleteTimingData(
  rows: ClassRow[] | null | undefined,
  type: SessionType,
): boolean {
  if (!Array.isArray(rows) || rows.length < 5) return false;
  const withTime = rows.filter((r) => Boolean(r.time && r.time.trim())).length;
  if (type === "fp1" || type === "fp2" || type === "fp3") {
    return withTime >= 5;
  }
  if (type === "qualifying" || type === "sprint_qualifying") {
    const withSplits = rows.filter(
      (r) => Boolean(r.q1) && (Boolean(r.q2) || Boolean(r.q3)),
    ).length;
    return withTime >= 5 && withSplits >= 5;
  }
  if (type === "sprint") {
    const withSprintInfo = rows.filter(
      (r) => Boolean(r.time) || Boolean(r.gap) || r.laps != null,
    ).length;
    return withSprintInfo >= 5;
  }
  return withTime >= 5;
}

/**
 * Merges timing fields (`time`, `q1`, `q2`, `q3`, `gap`, `laps`) from fallback engine rows
 * into the primary classification order so that if one API provides official positions
 * and another provides lap times / Q-splits, the combined result has both.
 */
export function mergeClassRows(
  primary: ClassRow[],
  type: SessionType,
  ...fallbacks: ClassRow[][]
): ClassRow[] {
  if (!primary.length) {
    for (const fb of fallbacks) {
      if (fb.length > 0) return fb;
    }
    return [];
  }

  const isTimedSession =
    type === "fp1" ||
    type === "fp2" ||
    type === "fp3" ||
    type === "qualifying" ||
    type === "sprint_qualifying";

  const findMatch = (target: ClassRow, pool: ClassRow[]): ClassRow | undefined => {
    if (target.driverId) {
      const m = pool.find((x) => x.driverId === target.driverId);
      if (m) return m;
    }
    if (target.code) {
      const c = target.code.toUpperCase();
      const m = pool.find((x) => x.code?.toUpperCase() === c);
      if (m) return m;
    }
    if (target.number != null) {
      const m = pool.find((x) => x.number === target.number);
      if (m) return m;
    }
    return undefined;
  };

  const merged = primary.map((row) => {
    let time = row.time;
    let q1 = row.q1;
    let q2 = row.q2;
    let q3 = row.q3;
    let gap = row.gap;
    let laps = row.laps;
    let status = row.status;

    for (const fb of fallbacks) {
      if (!fb.length) continue;
      const m = findMatch(row, fb);
      if (!m) continue;
      if (!q1 && m.q1) q1 = m.q1;
      if (!q2 && m.q2) q2 = m.q2;
      if (!q3 && m.q3) q3 = m.q3;
      if (!time && m.time) time = m.time;
      if (!gap && m.gap) gap = m.gap;
      if (laps == null && m.laps != null) laps = m.laps;
      if (!status && m.status) status = m.status;
    }

    if (isTimedSession && !time) {
      time = q3 || q2 || q1 || null;
    }

    return {
      ...row,
      time,
      q1,
      q2,
      q3,
      gap,
      laps,
      status,
    };
  });

  if (isTimedSession && merged.length > 1) {
    const p1Sec = parseLapTimeSeconds(merged[0]?.time);
    if (p1Sec != null) {
      return merged.map((r, idx) => {
        if (idx === 0 || r.position === 1) return { ...r, gap: null };
        if (r.gap) return r;
        const rSec = parseLapTimeSeconds(r.time);
        const computedGap =
          rSec != null && rSec > p1Sec ? `+${(rSec - p1Sec).toFixed(3)}` : null;
        return { ...r, gap: computedGap };
      });
    }
  }

  return merged;
}

// ---------------------------------------------------------------- schedule

async function loadRows(admin: Admin, raceId: string): Promise<SessRow[]> {
  const { data } = await admin
    .from("weekend_sessions")
    .select("id, session_type, starts_at, status, classification, updated_at")
    .eq("race_id", raceId)
    .order("updated_at", { ascending: false });
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
    FirstPractice?: JSess | undefined;
    SecondPractice?: JSess | undefined;
    ThirdPractice?: JSess | undefined;
    SprintQualifying?: JSess | undefined;
    SprintShootout?: JSess | undefined;
    Sprint?: JSess | undefined;
    Qualifying?: JSess | undefined;
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
      inserts.push({
        race_id: race.id,
        session_type: type,
        starts_at: startsAt,
        status: "scheduled",
        classification: [],
      });
    } else if (
      !existing.starts_at ||
      new Date(existing.starts_at).getTime() !== new Date(startsAt).getTime()
    ) {
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

/**
 * Proactively archives completed sessions (FP1/FP2/FP3/SQ/Sprint/Qualifying)
 * into `weekend_sessions` in the background, and automatically upgrades any
 * previously saved position-only rows once full lap times & Q1/Q2/Q3 splits arrive.
 */
async function backfillCompletedSessions(admin: Admin, race: DbRace, rows: SessRow[]) {
  const now = Date.now();
  for (const row of rows) {
    if (!row.starts_at || !isSessionType(row.session_type) || row.session_type === "race") continue;
    const type = row.session_type as SessionType;
    const end = new Date(row.starts_at).getTime() + SESSION_MINUTES[type] * MIN;
    const cached = Array.isArray(row.classification)
      ? (row.classification as unknown as ClassRow[])
      : [];
    const cachedComplete = hasCompleteTimingData(cached, type);

    if (now >= end && (row.status !== "completed" || !cachedComplete)) {
      const key = `backfill:${race.id}:${type}`;
      if (now - (attempts.get(key) ?? 0) < 25_000) continue;
      attempts.set(key, now);
      try {
        const fresh = await fetchClassification(admin, race, type, row.starts_at);
        const merged = cached.length >= 5 ? mergeClassRows(fresh, type, cached) : fresh;
        if (merged.length >= 5) {
          const isComplete = hasCompleteTimingData(merged, type);
          await admin
            .from("weekend_sessions")
            .update({
              classification: merged as unknown as Json,
              status: isComplete ? "completed" : "live",
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
        }
      } catch {
        /* ignore background backfill error */
      }
    }
  }
}

export const getWeekendSchedule = createServerFn({ method: "POST" })
  .inputValidator((input: { raceId: string }) => input)
  .handler(async ({ data }): Promise<{ sessions: ScheduleItem[] }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const race = await loadRace(supabaseAdmin, data.raceId);
    if (!race) return { sessions: [] };
    const rows = await ensureSchedule(supabaseAdmin, race);
    void backfillCompletedSessions(supabaseAdmin, race, rows);
    const sessions = rows
      .filter((r) => r.starts_at && isSessionType(r.session_type))
      .map((r) => ({ type: r.session_type as SessionType, startsAt: r.starts_at! }))
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    return { sessions };
  });

// ---------------------------------------------------------- classification

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

type JDriver = { driverId: string; code?: string | undefined; givenName: string; familyName: string };

async function fromJolpica(
  race: DbRace,
  type: "qualifying" | "sprint" | "race",
  lookup: DriverLookup,
): Promise<ClassRow[]> {
  if (type === "qualifying") {
    const j = await getJson<{
      MRData: {
        RaceTable: {
          Races: Array<{
            QualifyingResults?: Array<{
              number?: string | undefined;
              position: string;
              Driver: JDriver;
              Constructor?: { name: string } | undefined;
              Q1?: string | undefined;
              Q2?: string | undefined;
              Q3?: string | undefined;
            }> | undefined;
          }>;
        };
      };
    }>(`${JOLPICA}/${SEASON}/${race.round}/qualifying/?format=json`);
    const list = j?.MRData.RaceTable.Races?.[0]?.QualifyingResults ?? [];
    const rows = list.map((r) => {
      const d = resolveDriver(lookup, {
        driverId: r.Driver.driverId,
        code: r.Driver.code,
        name: `${r.Driver.givenName} ${r.Driver.familyName}`,
        team: r.Constructor?.name,
        number: r.number ? Number(r.number) : null,
      });
      return {
        ...blank(),
        position: Number(r.position),
        driverId: d.id,
        code: d.code,
        name: d.full_name,
        team: d.team ?? r.Constructor?.name ?? null,
        number: r.number ? Number(r.number) : d.number,
        time: r.Q3 || r.Q2 || r.Q1 || null,
        q1: r.Q1 || null,
        q2: r.Q2 || null,
        q3: r.Q3 || null,
      } satisfies ClassRow;
    });
    return mergeClassRows(rows, "qualifying");
  }

  const endpoint = type === "sprint" ? "sprint" : "results";
  const j = await getJson<{
    MRData: {
      RaceTable: {
        Races: Array<{
          SprintResults?: Array<{
            position: string;
            laps?: string | undefined;
            status?: string | undefined;
            Driver: JDriver;
            Constructor?: { name: string } | undefined;
            Time?: { time?: string | undefined } | undefined;
          }> | undefined;
          Results?: Array<{
            position: string;
            laps?: string | undefined;
            status?: string | undefined;
            Driver: JDriver;
            Constructor?: { name: string } | undefined;
            Time?: { time?: string | undefined } | undefined;
          }> | undefined;
        }>;
      };
    };
  }>(`${JOLPICA}/${SEASON}/${race.round}/${endpoint}/?format=json`);
  const raceObj = j?.MRData.RaceTable.Races?.[0];
  const list = (type === "sprint" ? raceObj?.SprintResults : raceObj?.Results) ?? [];
  return list.map((r, i) => {
    const d = resolveDriver(lookup, {
      driverId: r.Driver.driverId,
      code: r.Driver.code,
      name: `${r.Driver.givenName} ${r.Driver.familyName}`,
      team: r.Constructor?.name,
    });
    const finished = /finished|\+\d+ lap/i.test(r.status ?? "");
    return {
      ...blank(),
      position: Number(r.position),
      driverId: d.id,
      code: d.code,
      name: d.full_name,
      team: d.team ?? r.Constructor?.name ?? null,
      number: d.number,
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

type OfResult = {
  position: number | null;
  driver_number: number;
  duration: number | Array<number | null> | null;
  gap_to_leader: number | string | Array<number | string | null> | null;
  number_of_laps: number | null;
  dnf?: boolean | undefined;
  dns?: boolean | undefined;
  dsq?: boolean | undefined;
};

async function fromOpenF1(
  type: SessionType,
  startsAt: string,
  lookup: DriverLookup,
): Promise<ClassRow[]> {
  const target = new Date(startsAt).getTime();
  const all = await getCachedOpenF1Sessions(SEASON);
  if (!all.length) return [];
  const names = OPENF1_NAMES[type];
  const match = all
    .filter((s) => names.includes(s.session_name))
    .map((s) => ({ s, diff: Math.abs(new Date(s.date_start).getTime() - target) }))
    .filter((x) => x.diff < 12 * 60 * MIN)
    .sort((a, b) => a.diff - b.diff)[0]?.s;
  if (!match) return [];

  const [rawRes, ofDrivers] = await Promise.all([
    getJson<OfResult[]>(`${OPENF1}/session_result?session_key=${match.session_key}`),
    getCachedOpenF1Drivers(match.session_key),
  ]);

  const ofDrvByNum = new Map(ofDrivers.map((d) => [d.driver_number, d]));
  const isTimedSession =
    type === "fp1" ||
    type === "fp2" ||
    type === "fp3" ||
    type === "qualifying" ||
    type === "sprint_qualifying";
  const isQuali = type === "qualifying" || type === "sprint_qualifying";

  const hasValidDuration = (d: number | Array<number | null> | null): boolean => {
    if (typeof d === "number") return Number.isFinite(d) && d > 0;
    if (Array.isArray(d)) return d.some((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
    return false;
  };

  let res: OfResult[] = Array.isArray(rawRes) ? rawRes : [];
  const hasPositions = res.filter((r) => r.position != null).length >= 5;
  const hasTimes = res.filter((r) => hasValidDuration(r.duration)).length >= 5;
  const hasQualiSplits =
    !isQuali ||
    res.filter(
      (r) =>
        Array.isArray(r.duration) &&
        r.duration.filter((x) => typeof x === "number" && x > 0).length >= 2,
    ).length >= 5;

  // Fetch /v1/laps whenever positions, lap times, or Q1/Q2/Q3 splits are missing!
  if (!hasPositions || (isTimedSession && (!hasTimes || !hasQualiSplits))) {
    const [laps, positions, raceControl] = await Promise.all([
      getJson<OpenF1LapEntry[]>(`${OPENF1}/laps?session_key=${match.session_key}`, {
        timeoutMs: 9_000,
        retries: 1,
      }),
      !hasPositions
        ? getJson<OpenF1PositionEntry[]>(`${OPENF1}/position?session_key=${match.session_key}`)
        : Promise.resolve(null),
      isQuali
        ? getJson<OpenF1RaceControlMessage[]>(
            `${OPENF1}/race_control?session_key=${match.session_key}`,
          )
        : Promise.resolve(null),
    ]);

    const synth = isTimedSession
      ? buildTimedSessionOrderFromLaps(laps, positions, {
          isQualifying: isQuali,
          isSprintQualifying: type === "sprint_qualifying",
          sessionStartIso: match.date_start ?? startsAt,
          raceControl,
        })
      : buildLiveOrderFromPositions(positions, laps, null);

    if (!hasPositions && synth.length > 0) {
      res = synth;
    } else if (hasPositions && synth.length > 0) {
      // Merge synthesized lap times & Q1/Q2/Q3 splits into the official /v1/session_result positions!
      const synthByNum = new Map(synth.map((s) => [s.driver_number, s]));
      res = res.map((r) => {
        const s = synthByNum.get(r.driver_number);
        if (!s) return r;
        let mergedDur = r.duration;
        if (!hasValidDuration(mergedDur)) {
          mergedDur = s.duration;
        } else if (isQuali && Array.isArray(s.duration)) {
          const origArr = Array.isArray(r.duration) ? r.duration : [r.duration, null, null];
          mergedDur = [
            origArr[0] ?? s.duration[0] ?? null,
            origArr[1] ?? s.duration[1] ?? null,
            origArr[2] ?? s.duration[2] ?? null,
          ];
        }
        return {
          ...r,
          duration: mergedDur,
          gap_to_leader: r.gap_to_leader ?? s.gap_to_leader,
          number_of_laps: r.number_of_laps ?? s.number_of_laps,
        };
      });
    }
  }

  if (!res.length) return [];

  const lastOf = <T,>(v: T | Array<T | null> | null): T | null => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i] as T;
      return null;
    }
    return v;
  };

  const rows = res
    .map((r) => {
      const ofMeta = ofDrvByNum.get(r.driver_number);
      const d = resolveDriver(lookup, {
        code: ofMeta?.name_acronym,
        name: ofMeta?.full_name,
        team: ofMeta?.team_name,
        number: r.driver_number,
      });
      const dur = r.duration;
      const q = Array.isArray(dur) ? dur : null;
      const best = typeof lastOf(dur) === "number" ? (lastOf(dur) as number) : null;
      const gapRaw = lastOf(r.gap_to_leader);
      const gap =
        typeof gapRaw === "number" ? (gapRaw > 0 ? `+${gapRaw.toFixed(3)}` : null) : (gapRaw ?? null);
      return {
        ...blank(),
        position: r.position,
        driverId: d.id,
        code: d.code,
        name: d.full_name,
        team: d.team,
        number: d.number ?? r.driver_number,
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

  return mergeClassRows(rows, type);
}

/**
 * 4-Engine Classification Cascade + Cross-Engine Timing Merger for Practice 1/2/3,
 * Sprint Qualifying, Sprint, and Qualifying:
 * 1) Jolpica F1 (official Qualifying Q1/Q2/Q3 & Sprint classifications)
 * 2) OpenF1 (session_result + timed laps & Q1/Q2/Q3 synthesizer + position synthesizer)
 * 3) Official F1 Live Timing SignalR & Static stream (zero-auth live & post-session feed)
 * 4) ESPN F1 Live Scoreboard API (zero-auth live & completed weekend feed)
 *
 * Automatically merges lap times & Q1/Q2/Q3 splits across all engines so position-only
 * responses are enriched with full lap times whenever available.
 */
async function fetchClassification(
  admin: Admin,
  race: DbRace,
  type: SessionType,
  startsAt: string,
): Promise<ClassRow[]> {
  const { data: drivers } = await admin.from("drivers").select("id, code, full_name, team, number");
  const lookup = buildDriverLookup((drivers ?? []) as DriverRef[]);

  let jRows: ClassRow[] = [];
  if (type === "qualifying" || type === "sprint") {
    jRows = await fromJolpica(race, type, lookup);
    if (hasCompleteTimingData(jRows, type)) return jRows;
  }

  const ofRows = await fromOpenF1(type, startsAt, lookup);
  if (hasCompleteTimingData(ofRows, type)) {
    return jRows.length >= 5 ? mergeClassRows(jRows, type, ofRows) : ofRows;
  }

  const [f1Live, espnLive] = await Promise.all([
    fetchFromF1LiveTiming(type, startsAt, lookup),
    fetchFromEspnScoreboard(type, startsAt, lookup),
  ]);

  const f1Rows = f1Live?.rows ?? [];
  const espnRows = espnLive?.rows ?? [];

  // Pick the best primary ordering (preferring sources with complete timing, then >= 5 positions)
  const candidates = [jRows, ofRows, f1Rows, espnRows].filter((c) => c.length >= 5);
  if (!candidates.length) {
    return ofRows.length > 0 ? ofRows : f1Rows.length > 0 ? f1Rows : espnRows;
  }

  const completeCandidate = candidates.find((c) => hasCompleteTimingData(c, type));
  const primary = completeCandidate ?? candidates[0]!;
  return mergeClassRows(primary, type, jRows, ofRows, f1Rows, espnRows);
}

/**
 * Resolves the Pole Position driver_id for a race using:
 * 1) In-memory cache,
 * 2) Saturday's saved Qualifying session in `weekend_sessions`,
 * 3) Jolpica Qualifying API,
 * 4) OpenF1 / ESPN Qualifying results.
 */
async function resolvePoleDriverId(
  admin: Admin,
  race: DbRace,
  sessions: OfSession[] | null,
  lookup: DriverLookup,
): Promise<string | null> {
  const memo = cachedPoleByRace.get(race.id);
  if (memo) return memo;

  // 1) Check weekend_sessions qualifying classification in DB
  const { data: qSess } = await admin
    .from("weekend_sessions")
    .select("classification")
    .eq("race_id", race.id)
    .eq("session_type", "qualifying")
    .maybeSingle();
  if (qSess && Array.isArray(qSess.classification)) {
    const p1 = (qSess.classification as unknown as ClassRow[]).find((r) => r.position === 1);
    if (p1?.driverId && lookup.byId.has(p1.driverId)) {
      cachedPoleByRace.set(race.id, p1.driverId);
      return p1.driverId;
    }
    if (p1) {
      const d = resolveDriver(lookup, {
        driverId: p1.driverId,
        code: p1.code,
        name: p1.name,
        number: p1.number,
      });
      if (lookup.byId.has(d.id)) {
        cachedPoleByRace.set(race.id, d.id);
        return d.id;
      }
    }
  }

  // 2) Check Jolpica Qualifying
  const jRows = await fromJolpica(race, "qualifying", lookup);
  const jP1 = jRows.find((r) => r.position === 1);
  if (jP1?.driverId && lookup.byId.has(jP1.driverId)) {
    cachedPoleByRace.set(race.id, jP1.driverId);
    return jP1.driverId;
  }

  // 3) Check OpenF1 or ESPN Qualifying
  if (race.qualifying_at) {
    if (Array.isArray(sessions) && sessions.length) {
      const qt = new Date(race.qualifying_at).getTime();
      const qs = sessions
        .filter((s) => s.session_name === "Qualifying")
        .map((s) => ({ s, diff: Math.abs(new Date(s.date_start).getTime() - qt) }))
        .filter((x) => x.diff < 12 * 60 * MIN)
        .sort((a, b) => a.diff - b.diff)[0]?.s;
      if (qs) {
        const qRes = await getJson<OfResult[]>(
          `${OPENF1}/session_result?session_key=${qs.session_key}`,
        );
        const poleNum = qRes?.find((r) => r.position === 1)?.driver_number;
        if (poleNum != null) {
          const d = resolveDriver(lookup, { number: poleNum });
          if (lookup.byId.has(d.id)) {
            cachedPoleByRace.set(race.id, d.id);
            return d.id;
          }
        }
      }
    }
    const espnQ = await fetchFromEspnScoreboard("qualifying", race.qualifying_at, lookup);
    const espnP1 = espnQ?.rows.find((r) => r.position === 1);
    if (espnP1?.driverId && lookup.byId.has(espnP1.driverId)) {
      cachedPoleByRace.set(race.id, espnP1.driverId);
      return espnP1.driverId;
    }
  }

  return null;
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

    const cached = Array.isArray(row.classification)
      ? (row.classification as unknown as ClassRow[])
      : [];
    const key = `${race.id}:${type}`;

    if (now < end) {
      // Live session: serve 20s shared server cache with in-flight deduplication
      const mem = liveSessionCache.get(key);
      if (mem && mem.rows.length > 0 && now - mem.ts < LIVE_CACHE_TTL_MS) {
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
      const effectiveRows =
        liveRows.length > 0
          ? cached.length > 0
            ? mergeClassRows(liveRows, type, cached)
            : liveRows
          : mem?.rows.length
            ? mem.rows
            : cached;

      if (effectiveRows.length > 0) {
        liveSessionCache.set(key, { ts: Date.now(), rows: effectiveRows });
      }
      // Persist latest live classification snapshot to DB so it survives after session ends
      if (effectiveRows.length >= 5) {
        void supabaseAdmin
          .from("weekend_sessions")
          .update({
            classification: effectiveRows as unknown as Json,
            status: "live",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      }
      return { state: "live", startsAt: row.starts_at, rows: effectiveRows };
    }

    // Post-session: only serve from DB without re-fetching if it has COMPLETE timing data
    const cachedIsComplete = hasCompleteTimingData(cached, type);
    if (cachedIsComplete && row.status === "completed") {
      return { state: "ready", startsAt: row.starts_at, rows: cached };
    }

    if (now - (attempts.get(key) ?? 0) < 12_000 && cachedIsComplete) {
      return { state: "ready", startsAt: row.starts_at, rows: cached };
    }
    attempts.set(key, now);

    const fresh = await fetchClassification(supabaseAdmin, race, type, row.starts_at);
    const merged =
      fresh.length >= 5
        ? cached.length >= 5
          ? mergeClassRows(fresh, type, cached)
          : fresh
        : cached.length >= 5
          ? mergeClassRows(cached, type, fresh)
          : fresh;

    if (!merged.length) {
      return { state: "pending", startsAt: row.starts_at, rows: [] };
    }

    const isComplete = hasCompleteTimingData(merged, type);
    await supabaseAdmin
      .from("weekend_sessions")
      .update({
        classification: merged as unknown as Json,
        status: isComplete ? "completed" : "live",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    return { state: "ready", startsAt: row.starts_at, rows: merged };
  });

/**
 * High-efficiency live race telemetry & Instant Chequered Flag Finalizer.
 * - Uses 4-Engine Multi-Source Cascade (OpenF1 -> F1 Live Timing SignalR -> ESPN -> Jolpica)
 *   so Sunday's Race works live and finalizes in 0s even if OpenF1 restricts live access.
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
        liveScores: {},
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
        liveScores: {},
      };
    }

    const cached = liveRaceCache.get(race.id);
    if (cached && cached.payload.results.length >= 10 && now - cached.ts < LIVE_CACHE_TTL_MS) {
      return cached.payload;
    }

    let promise = inFlightLiveRace.get(race.id);
    if (!promise) {
      promise = (async (): Promise<LiveRaceTelemetryPayload> => {
        const { data: drivers } = await supabaseAdmin
          .from("drivers")
          .select("id, code, full_name, team, number");
        const drvList = (drivers ?? []) as DriverRef[];
        const lookup = buildDriverLookup(drvList);

        // If official results are already saved in DB, return them directly
        if (race.has_results) {
          const [{ data: dbResults }, { data: dbScores }] = await Promise.all([
            supabaseAdmin
              .from("race_results")
              .select("driver_id, position, finished, fastest_lap, pole")
              .eq("race_id", race.id)
              .order("position", { ascending: true, nullsFirst: false }),
            supabaseAdmin
              .from("scores")
              .select("user_id, points")
              .eq("race_id", race.id),
          ]);
          if (dbResults?.length) {
            const classification: ClassRow[] = dbResults.map((r) => {
              const d = lookup.byId.get(r.driver_id);
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
            const liveScores: Record<string, number> = {};
            for (const s of dbScores ?? []) {
              liveScores[s.user_id] = s.points;
            }
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
              liveScores,
            };
          }
        }

        const sessions = await getCachedOpenF1Sessions(SEASON);
        const poleDriverId = await resolvePoleDriverId(supabaseAdmin, race, sessions, lookup);

        let classification: ClassRow[] = [];
        let liveResults: ResultRow[] = [];
        let externalChequered = false;

        // 1) Try OpenF1 Race session
        const rs = sessions
          .filter((s) => s.session_name === "Race")
          .map((s) => ({ s, diff: Math.abs(new Date(s.date_start).getTime() - startMs) }))
          .filter((x) => x.diff < 12 * 60 * MIN)
          .sort((a, b) => a.diff - b.diff)[0]?.s;

        if (rs) {
          const [rawOfResults, ofDrivers, laps, raceControl] = await Promise.all([
            getJson<OfResult[]>(`${OPENF1}/session_result?session_key=${rs.session_key}`),
            getCachedOpenF1Drivers(rs.session_key),
            getJson<OpenF1LapEntry[]>(`${OPENF1}/laps?session_key=${rs.session_key}`),
            getJson<OpenF1RaceControlMessage[]>(
              `${OPENF1}/race_control?session_key=${rs.session_key}`,
            ),
          ]);

          let ofResults: OfResult[] = Array.isArray(rawOfResults) ? rawOfResults : [];
          if (ofResults.filter((r) => r.position != null).length < 10) {
            const positions = await getJson<OpenF1PositionEntry[]>(
              `${OPENF1}/position?session_key=${rs.session_key}`,
            );
            const synth = buildLiveOrderFromPositions(positions, laps, raceControl);
            if (synth.length >= 10) ofResults = synth;
          }

          if (ofResults.length >= 10) {
            const ofDrvByNum = new Map(ofDrivers.map((d) => [d.driver_number, d]));
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

            const sortedOf = [...ofResults].sort(
              (a, b) => (a.position ?? 999) - (b.position ?? 999),
            );

            for (const r of sortedOf) {
              const ofMeta = ofDrvByNum.get(r.driver_number);
              const d = resolveDriver(lookup, {
                code: ofMeta?.name_acronym,
                name: ofMeta?.full_name,
                team: ofMeta?.team_name,
                number: r.driver_number,
              });
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
                driverId: d.id,
                code: d.code,
                name: d.full_name,
                team: d.team,
                number: d.number ?? r.driver_number,
                time: typeof dur === "number" ? fmtLap(dur) : null,
                gap,
                laps: r.number_of_laps ?? null,
                status: r.dsq ? "DSQ" : r.dns ? "DNS" : r.dnf ? "DNF" : null,
              });

              if (lookup.byId.has(d.id)) {
                liveResults.push({
                  driver_id: d.id,
                  position: finished ? r.position : null,
                  finished,
                  fastest_lap: r.driver_number === flNum,
                  pole: poleDriverId ? d.id === poleDriverId : false,
                });
              }
            }

            if (hasChequeredFlag(raceControl)) externalChequered = true;
          }
        }

        // 2) Multi-Engine Fallback (Official F1 Live Timing SignalR + ESPN Scoreboard + Jolpica)
        if (liveResults.length < 10) {
          const [f1Snap, espnSnap] = await Promise.all([
            fetchFromF1LiveTiming("race", race.race_at, lookup),
            fetchFromEspnScoreboard("race", race.race_at, lookup),
          ]);
          const chosen =
            f1Snap && f1Snap.rows.length >= 10
              ? f1Snap
              : espnSnap && espnSnap.rows.length >= 10
                ? espnSnap
                : null;

          if (chosen) {
            classification = chosen.rows;
            externalChequered = chosen.chequeredFlag;
            liveResults = chosen.rows
              .filter((r) => r.driverId && lookup.byId.has(r.driverId))
              .map((r) => {
                const finished = !r.status && r.position != null;
                return {
                  driver_id: r.driverId!,
                  position: finished ? r.position : null,
                  finished,
                  fastest_lap: chosen.fastestLapDriverId
                    ? r.driverId === chosen.fastestLapDriverId
                    : false,
                  pole: poleDriverId ? r.driverId === poleDriverId : false,
                };
              });
          } else {
            const jRaceRows = await fromJolpica(race, "race", lookup);
            if (jRaceRows.length >= 10) {
              classification = jRaceRows;
              externalChequered = true;
              liveResults = jRaceRows
                .filter((r) => r.driverId && lookup.byId.has(r.driverId))
                .map((r) => {
                  const finished = !r.status && r.position != null;
                  return {
                    driver_id: r.driverId!,
                    position: finished ? r.position : null,
                    finished,
                    fastest_lap: false,
                    pole: poleDriverId ? r.driverId === poleDriverId : false,
                  };
                });
            }
          }
        }

        const minutesElapsed = (Date.now() - startMs) / MIN;
        const chequered =
          (minutesElapsed >= 40 && externalChequered) || minutesElapsed >= 180;

        const liveScores: Record<string, number> = {};
        let finalizedNow = false;

        if (liveResults.length >= 10) {
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
            supabaseAdmin.from("scores").select("user_id, points, breakdown").eq("race_id", race.id),
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

          for (const ex of (existingScores ?? []) as Array<{
            user_id: string;
            points: number;
            breakdown: unknown;
          }>) {
            const bd = (ex.breakdown as Record<string, unknown> | null) ?? {};
            if (bd["stewardOverride"] === true) {
              liveScores[ex.user_id] = ex.points;
            }
          }
          for (const row of scoreRows) {
            liveScores[row.user_id] = row.points;
          }

          if (chequered && !race.has_results) {
            const dbRows = liveResults.map((r) => ({
              race_id: race.id,
              driver_id: r.driver_id,
              position: r.finished ? r.position : null,
              status: r.finished ? "Finished" : "Retired",
              finished: r.finished,
              fastest_lap: r.fastest_lap,
              pole: r.pole,
            }));

            if (dbRows.length >= 10) {
              await supabaseAdmin
                .from("race_results")
                .upsert(dbRows, { onConflict: "race_id,driver_id" });
              await supabaseAdmin.from("races").update({ has_results: true }).eq("id", race.id);

              if (scoreRows.length) {
                await supabaseAdmin
                  .from("scores")
                  .upsert(scoreRows, { onConflict: "user_id,race_id" });
              }
              finalizedNow = true;
            }
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
          liveScores,
        };
      })().finally(() => {
        inFlightLiveRace.delete(race.id);
      });
      inFlightLiveRace.set(race.id, promise);
    }

    const payload = await promise;
    if (payload.results.length >= 10) {
      liveRaceCache.set(race.id, { ts: Date.now(), payload });
    }
    return payload;
  });