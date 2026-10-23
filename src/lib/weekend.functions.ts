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