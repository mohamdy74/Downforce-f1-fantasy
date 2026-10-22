import { createServerFn } from "@tanstack/react-start";

import type { Json } from "@/integrations/supabase/types";
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

type Admin = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];
type DbRace = { id: string; round: number; qualifying_at: string | null; race_at: string };
type SessRow = {
  id: string;
  session_type: string;
  starts_at: string | null;
  status: string;
  classification: Json;
  updated_at: string;
};

// Per-server throttles (best effort; each worker instance keeps its own).
const scheduleChecked = new Map<string, number>();
const attempts = new Map<string, number>();

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type JSess = { date: string; time?: string | undefined };
function iso(s: JSess | undefined): string | null {
  if (!s?.date) return null;
  const d = new Date(`${s.date}T${s.time ?? "12:00:00Z"}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fmtLap(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : s;
}

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
    .select("id, round, qualifying_at, race_at")
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
    .filter((x) => x.diff < 3 * 60 * MIN)
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
    if (now < end) return { state: "live", startsAt: row.starts_at, rows: [] };

    const cached = Array.isArray(row.classification) ? (row.classification as unknown as ClassRow[]) : [];
    if (cached.length && row.status === "completed") {
      return { state: "ready", startsAt: row.starts_at, rows: cached };
    }

    const key = `${race.id}:${type}`;
    if (now - (attempts.get(key) ?? 0) < 60_000) {
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
