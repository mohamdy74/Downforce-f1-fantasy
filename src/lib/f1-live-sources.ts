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
  {
    id: "verstappen",
    code: "VER",
    full_name: "Max Verstappen",
    team: "Red Bull Racing",
    number: 1,
  },
  { id: "hadjar", code: "HAD", full_name: "Isack Hadjar", team: "Red Bull Racing", number: 6 },
  { id: "leclerc", code: "LEC", full_name: "Charles Leclerc", team: "Ferrari", number: 16 },
  { id: "hamilton", code: "HAM", full_name: "Lewis Hamilton", team: "Ferrari", number: 44 },
  { id: "norris", code: "NOR", full_name: "Lando Norris", team: "McLaren", number: 4 },
  { id: "piastri", code: "PIA", full_name: "Oscar Piastri", team: "McLaren", number: 81 },
  { id: "russell", code: "RUS", full_name: "George Russell", team: "Mercedes", number: 63 },
  {
    id: "antonelli",
    code: "ANT",
    full_name: "Andrea Kimi Antonelli",
    team: "Mercedes",
    number: 12,
  },
  { id: "alonso", code: "ALO", full_name: "Fernando Alonso", team: "Aston Martin", number: 14 },
  { id: "stroll", code: "STR", full_name: "Lance Stroll", team: "Aston Martin", number: 18 },
  { id: "gasly", code: "GAS", full_name: "Pierre Gasly", team: "Alpine", number: 10 },
  { id: "colapinto", code: "COL", full_name: "Franco Colapinto", team: "Alpine", number: 43 },
  { id: "doohan", code: "DOO", full_name: "Jack Doohan", team: "Alpine", number: 7 },
  { id: "albon", code: "ALB", full_name: "Alexander Albon", team: "Williams", number: 23 },
  { id: "sainz", code: "SAI", full_name: "Carlos Sainz", team: "Williams", number: 55 },
  { id: "lawson", code: "LAW", full_name: "Liam Lawson", team: "Racing Bulls", number: 30 },
  { id: "lindblad", code: "LIN", full_name: "Arvid Lindblad", team: "Racing Bulls", number: 41 },
  { id: "ocon", code: "OCO", full_name: "Esteban Ocon", team: "Haas F1 Team", number: 31 },
  { id: "bearman", code: "BEA", full_name: "Oliver Bearman", team: "Haas F1 Team", number: 87 },
  { id: "hulkenberg", code: "HUL", full_name: "Nico Hulkenberg", team: "Audi", number: 27 },
  { id: "bortoleto", code: "BOR", full_name: "Gabriel Bortoleto", team: "Audi", number: 5 },
  { id: "bottas", code: "BOT", full_name: "Valtteri Bottas", team: "Cadillac", number: 77 },
  { id: "perez", code: "PER", full_name: "Sergio Perez", team: "Cadillac", number: 11 },
  { id: "crawford", code: "CRA", full_name: "Jak Crawford", team: "Aston Martin", number: 34 },
  { id: "tsunoda", code: "TSU", full_name: "Yuki Tsunoda", team: "Racing Bulls", number: 22 },
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
    (hint.name ? (hint.name.trim().split(/\s+/).pop()?.slice(0, 3).toUpperCase() ?? null) : null);
  return {
    id: hint.driverId ?? (fallbackCode ? fallbackCode.toLowerCase() : `car_${hint.number ?? 0}`),
    code: fallbackCode,
    full_name:
      hint.name?.trim() || (hint.number != null ? `Car #${hint.number}` : "Unknown Driver"),
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
      sessionInfo:
        (f1SignalRCache.snapshot["SessionInfo"] as F1StaticSessionInfo | undefined) ?? null,
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
    { Lines?: Record<string, F1SignalRTimingLine> | undefined } | undefined;
  const driverList = (state["DriverList"] as Record<string, F1SignalRDriver> | undefined) ?? {};
  const sessionStatus = state["SessionStatus"] as { Status?: string | undefined } | undefined;
  const rcmRaw = state["RaceControlMessages"] as
    | {
        Messages?:
          Record<string, OpenF1RaceControlMessage> | OpenF1RaceControlMessage[] | undefined;
      }
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
    if (line.BestLapTime?.OverallFastest === true || (lapSec != null && lapSec < bestLapSec)) {
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
      ? typeof line.TimeDiffToFastest === "string"
        ? line.TimeDiffToFastest
        : (line.TimeDiffToFastest?.Value ?? line.Stats?.[0]?.TimeDiffToFastest ?? null)
      : typeof line.GapToLeader === "string"
        ? line.GapToLeader
        : (line.GapToLeader?.Value ?? null);

    const cleanGap = gapRaw && !/^LEADER$/i.test(gapRaw.trim()) ? gapRaw.trim() : null;

    const retired = Boolean(line.Retired || line.Stopped);

    return {
      row: {
        position,
        driverId: resolved.id,
        code: resolved.code,
        name: resolved.full_name,
        team: resolved.team,
        number: resolved.number ?? (Number.isFinite(num) ? num : null),
        time: isTimedSession ? q3 || q2 || q1 || bestVal : position === 1 ? bestVal : null,
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
  const chequeredFlag = /Finished|Finalised|Ends/i.test(statusStr) || hasChequeredFlag(rcmList);

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
  athlete?:
    | {
        fullName?: string | undefined;
        displayName?: string | undefined;
        shortName?: string | undefined;
        abbreviation?: string | undefined;
      }
    | undefined;
  vehicle?:
    | {
        number?: string | undefined;
        manufacturer?: string | undefined;
      }
    | undefined;
  status?:
    | {
        type?:
          | {
              name?: string | undefined;
              description?: string | undefined;
              shortDetail?: string | undefined;
              completed?: boolean | undefined;
            }
          | undefined;
      }
    | undefined;
  statistics?: EspnStat[] | undefined;
  linescores?:
    Array<{ value?: number | string | undefined; displayValue?: string | undefined }> | undefined;
};

type EspnCompetition = {
  id?: string | undefined;
  date?: string | undefined;
  type?:
    | {
        id?: string | undefined;
        text?: string | undefined;
        abbreviation?: string | undefined;
        slug?: string | undefined;
      }
    | undefined;
  status?:
    | {
        type?:
          | {
              id?: string | undefined;
              name?: string | undefined;
              state?: string | undefined;
              completed?: boolean | undefined;
            }
          | undefined;
      }
    | undefined;
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
      c.status?.type?.shortDetail ?? c.status?.type?.description ?? c.status?.type?.name ?? "";
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
        status: isDnf
          ? /dsq/i.test(compStatus)
            ? "DSQ"
            : /dns/i.test(compStatus)
              ? "DNS"
              : "DNF"
          : null,
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
    board = await getJson<EspnScoreboardResponse>(`${ESPN_F1_SCOREBOARD}?dates=${rangeKey}`, {
      timeoutMs: 6_000,
      retries: 1,
    });
    if (board) espnCache.set(rangeKey, { ts: now, data: board });
  }
  if (!board?.events?.length) return null;

  const matcher = ESPN_TYPE_MATCHERS[type];
  let bestComp: EspnCompetition | null = null;
  let bestDiff = Infinity;

  for (const ev of board.events) {
    for (const comp of ev.competitions ?? []) {
      const typeLabels = [comp.type?.abbreviation, comp.type?.text, comp.type?.slug].filter(
        (x): x is string => Boolean(x),
      );
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
