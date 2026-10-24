import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";

import { Countdown } from "@/components/Countdown";
import { supabase } from "@/integrations/supabase/client";
import { driversQuery, getTrustedNow, racesQuery, type Driver, type Race } from "@/lib/queries";
import { teamColor } from "@/lib/teams";
import {
  SESSION_LABEL,
  SESSION_MINUTES,
  type ClassRow,
  type ScheduleItem,
  type SessionPayload,
  type SessionType,
} from "@/lib/weekend";
import {
  getLiveRaceTelemetry,
  getWeekendSchedule,
  getWeekendSession,
  type LiveRaceTelemetryPayload,
} from "@/lib/weekend.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/weekend")({
  head: () => ({
    meta: [
      { title: "Race weekend \u2014 DOWNFORCE" },
      {
        name: "description",
        content:
          "Session schedule, practice, qualifying and race classification for the current Grand Prix weekend.",
      },
      { property: "og:title", content: "Race weekend \u2014 DOWNFORCE" },
      {
        property: "og:description",
        content: "Follow the Grand Prix weekend: schedule, practice, qualifying and race result.",
      },
      { name: "twitter:title", content: "Race weekend \u2014 DOWNFORCE" },
      {
        name: "twitter:description",
        content: "Follow the Grand Prix weekend: schedule, practice, qualifying and race result.",
      },
    ],
  }),
  component: Weekend,
});

type Tab = "schedule" | "practice" | "qualifying" | "race";
const TABS: { id: Tab; label: string }[] = [
  { id: "schedule", label: "Schedule" },
  { id: "practice", label: "Practice" },
  { id: "qualifying", label: "Qualifying" },
  { id: "race", label: "Race" },
];
const GROUPS: Record<Exclude<Tab, "schedule">, SessionType[]> = {
  practice: ["fp1", "fp2", "fp3"],
  qualifying: ["sprint_qualifying", "qualifying"],
  race: ["sprint", "race"],
};

type QualiSegment = "q1" | "q2" | "q3";
const QUALI_SEGMENTS: { id: QualiSegment; label: string; limit: number; cutoff: number | null }[] = [
  { id: "q1", label: "Q1", limit: 22, cutoff: 16 },
  { id: "q2", label: "Q2", limit: 16, cutoff: 10 },
  { id: "q3", label: "Q3", limit: 10, cutoff: null },
];

type Status = "upcoming" | "live" | "completed";
const MIN = 60_000;
const STAY_MS = 18 * 60 * MIN; // keep showing a weekend until 18h after the race starts

function statusOf(startIso: string, type: SessionType, now: number): Status {
  const start = new Date(startIso).getTime();
  if (now < start) return "upcoming";
  return now < start + SESSION_MINUTES[type] * MIN ? "live" : "completed";
}

/** null on the server and first render, so times never mismatch between server and browser. */
function useNow(ms = 15_000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(getTrustedNow());
    const t = setInterval(() => setNow(getTrustedNow()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function currentWeekend(races: Race[], now: number): Race | null {
  if (!races.length) return null;
  return (
    races.find((r) => new Date(r.race_at).getTime() + STAY_MS >= now) ?? races[races.length - 1]!
  );
}

function localTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    timeZone: "Africa/Cairo",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_STYLE: Record<Status, { label: string; color: string }> = {
  upcoming: { label: "Upcoming", color: "var(--gold)" },
  live: { label: "Live", color: "var(--color-primary)" },
  completed: { label: "Completed", color: "var(--track-green)" },
};

/**
 * Parses a lap time string like "1:34.035" or "94.035" into seconds (94.035).
 */
function parseLapSec(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (m) {
    const mins = Number(m[1]);
    const secs = Number(m[2]);
    const total = Math.round((mins * 60 + secs) * 1000) / 1000;
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  const num = Number(s);
  return Number.isFinite(num) && num > 0 ? Math.round(num * 1000) / 1000 : null;
}

type QualiDisplayRow = {
  row: ClassRow;
  position: number;
  time: string | null;
  sec: number | null;
  gapToLeader: string | null;
  gapToAhead: string | null;
};

/**
 * Builds the per-segment classification for Qualifying / Sprint Qualifying:
 * - Q1: 22 drivers sorted by their Q1 lap time ascending
 * - Q2: 16 drivers sorted by their Q2 lap time ascending
 * - Q3: 10 drivers sorted by their Q3 lap time ascending
 * Computes both Gap to P1 Leader (+X.XXX) and Interval to the car ahead (INT +X.XXX).
 */
function buildQualifyingSegmentRows(
  rows: ClassRow[],
  segment: QualiSegment,
  gridDrivers?: Driver[] | undefined,
): QualiDisplayRow[] {
  const hasAnySplits = rows.some((r) => Boolean(r.q1 || r.q2 || r.q3));

  // Ensure Q1 has up to 22 drivers even if an upstream feed omitted DNS drivers
  let pool: ClassRow[] = [...rows];
  if (segment === "q1" && pool.length < 22 && gridDrivers?.length) {
    for (const d of gridDrivers) {
      if (pool.length >= 22) break;
      const exists = pool.some(
        (r) =>
          (r.driverId && r.driverId === d.id) ||
          (r.code && d.code && r.code.toUpperCase() === d.code.toUpperCase()) ||
          (r.number != null && d.number != null && r.number === d.number),
      );
      if (!exists) {
        pool.push({
          position: pool.length + 1,
          driverId: d.id,
          code: d.code,
          name: d.full_name,
          team: d.team,
          number: d.number,
          time: null,
          q1: null,
          q2: null,
          q3: null,
          gap: null,
          laps: null,
          status: "DNS",
        });
      }
    }
  }

  const getSegTime = (r: ClassRow, seg: QualiSegment): string | null => {
    if (seg === "q1") {
      return r.q1?.trim() || (!hasAnySplits || (!r.q2 && !r.q3) ? (r.time?.trim() ?? null) : null);
    }
    if (seg === "q2") {
      return r.q2?.trim() || (!hasAnySplits ? (r.time?.trim() ?? null) : null);
    }
    return r.q3?.trim() || (!hasAnySplits ? (r.time?.trim() ?? null) : null);
  };

  const limit = segment === "q1" ? 22 : segment === "q2" ? 16 : 10;

  let candidates: ClassRow[];
  if (segment === "q1") {
    candidates = pool.slice(0, 22);
  } else if (segment === "q2") {
    const withQ2 = pool.filter((r) => parseLapSec(getSegTime(r, "q2")) != null);
    if (withQ2.length >= 16) {
      candidates = withQ2.slice(0, 16);
    } else {
      const chosen = new Set(withQ2);
      const rest = pool
        .filter((r) => !chosen.has(r))
        .sort((a, b) => {
          const pa = a.position ?? 999;
          const pb = b.position ?? 999;
          if (pa !== pb) return pa - pb;
          const qa = parseLapSec(a.q1) ?? Infinity;
          const qb = parseLapSec(b.q1) ?? Infinity;
          return qa - qb;
        });
      candidates = [...withQ2, ...rest].slice(0, 16);
    }
  } else {
    const withQ3 = pool.filter((r) => parseLapSec(getSegTime(r, "q3")) != null);
    if (withQ3.length >= 10) {
      candidates = withQ3.slice(0, 10);
    } else {
      const chosen = new Set(withQ3);
      const rest = pool
        .filter((r) => !chosen.has(r))
        .sort((a, b) => {
          const pa = a.position ?? 999;
          const pb = b.position ?? 999;
          if (pa !== pb) return pa - pb;
          const qa = parseLapSec(a.q2) ?? parseLapSec(a.q1) ?? Infinity;
          const qb = parseLapSec(b.q2) ?? parseLapSec(b.q1) ?? Infinity;
          return qa - qb;
        });
      candidates = [...withQ3, ...rest].slice(0, 10);
    }
  }

  const decorated = candidates.map((row, idx) => {
    const time = getSegTime(row, segment);
    const sec = parseLapSec(time);
    return { row, time, sec, origPos: row.position ?? idx + 1 };
  });

  decorated.sort((a, b) => {
    if (a.sec != null && b.sec != null && a.sec !== b.sec) {
      return a.sec - b.sec;
    }
    if (a.sec != null && b.sec == null) return -1;
    if (a.sec == null && b.sec != null) return 1;
    return a.origPos - b.origPos;
  });

  const sliced = decorated.slice(0, limit);
  const leaderSec = sliced[0]?.sec ?? null;

  return sliced.map((item, idx) => {
    const prevSec = idx > 0 ? (sliced[idx - 1]?.sec ?? null) : null;
    const gapToLeader =
      idx > 0 && item.sec != null && leaderSec != null
        ? `+${Math.max(0, item.sec - leaderSec).toFixed(3)}`
        : null;
    const gapToAhead =
      idx > 0 && item.sec != null && prevSec != null
        ? `+${Math.max(0, item.sec - prevSec).toFixed(3)}`
        : gapToLeader;

    return {
      row: item.row,
      position: idx + 1,
      time: item.time,
      sec: item.sec,
      gapToLeader,
      gapToAhead,
    };
  });
}

/**
 * Checks whether a session's rows have complete timing data (actual lap times
 * and, for Qualifying / Sprint Qualifying, Q1/Q2/Q3 splits).
 * Position-only snapshots are never locked into localStorage or infinite staleTime.
 */
function hasCompleteTiming(rows: ClassRow[] | null | undefined, type: SessionType): boolean {
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
    return rows.filter((r) => Boolean(r.time) || Boolean(r.gap) || r.laps != null).length >= 5;
  }
  return withTime >= 5;
}

// ---- small local cache for finished sessions with COMPLETE timing ----
const legacyCacheKey = (raceId: string, type: string) => `dfr:session:${raceId}:${type}`;
const cacheKey = (raceId: string, type: string) => `dfr:session:v3:${raceId}:${type}`;

function readCache(raceId: string, type: SessionType): SessionPayload | undefined {
  try {
    // Purge legacy v1/v2 cache keys that may have stored position-only rows without lap times
    window.localStorage.removeItem(legacyCacheKey(raceId, type));
    const raw = window.localStorage.getItem(cacheKey(raceId, type));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as SessionPayload;
    if (parsed.state !== "ready" || !hasCompleteTiming(parsed.rows, type)) {
      window.localStorage.removeItem(cacheKey(raceId, type));
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function writeCache(raceId: string, type: SessionType, payload: SessionPayload) {
  try {
    if (payload.state === "ready" && hasCompleteTiming(payload.rows, type)) {
      window.localStorage.setItem(cacheKey(raceId, type), JSON.stringify(payload));
    } else {
      window.localStorage.removeItem(cacheKey(raceId, type));
    }
  } catch {
    /* storage unavailable: ignore */
  }
}

function Weekend() {
  const now = useNow();
  const { data: races, isLoading } = useQuery(racesQuery);
  const [tab, setTab] = useState<Tab>("schedule");
  const [rId, setRId] = useState<string | null>(null);
  const [tabRef] = useAutoAnimate<HTMLDivElement>();

  if (isLoading || now === null || !races) {
    return (
      <Shell>
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="mt-6 h-40 animate-pulse rounded-lg bg-muted/60" />
      </Shell>
    );
  }

  const defRace = currentWeekend(races, now);
  const race = races.find((r) => r.id === rId) ?? defRace;
  if (!race) {
    return (
      <Shell>
        <h1 className="text-3xl">Race weekend</h1>
        <p className="mt-3 text-sm text-muted-foreground">No races on the calendar yet.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {races
          .filter((r) => r.has_results || r.id === defRace?.id)
          .slice(-6)
          .reverse()
          .map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRId(r.id)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 font-mono text-xs font-bold",
                r.id === race.id
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border text-muted-foreground",
              )}
            >
              R{r.round}
            </button>
          ))}
      </div>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-primary">
        Round {race.round}
      </p>
      <h1 className="mt-1 text-3xl">{race.name}</h1>
      <p className="text-sm text-muted-foreground">
        {race.circuit}
        {race.locality ? ` \u00B7 ${race.locality}` : ""}
        {race.country ? `, ${race.country}` : ""}
      </p>

      <div role="tablist" aria-label="Weekend sections" className="mt-5 grid grid-cols-4 gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "min-h-11 touch-manipulation rounded-md border px-1 font-mono text-[11px] font-bold uppercase tracking-wider transition",
              tab === t.id
                ? "border-primary bg-primary/15 text-primary"
                : "border-border text-muted-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div ref={tabRef} className="mt-4">
        <WeekendBody race={race} now={now} tab={tab} />
      </div>
    </Shell>
  );
}

function WeekendBody({ race, now, tab }: { race: Race; now: number; tab: Tab }) {
  const schedQ = useQuery({
    queryKey: ["weekend-schedule", race.id],
    staleTime: 30 * MIN,
    retry: 1,
    queryFn: async () => (await getWeekendSchedule({ data: { raceId: race.id } })).sessions,
  });
  const fallback: ScheduleItem[] = [
    ...(race.qualifying_at ? [{ type: "qualifying" as const, startsAt: race.qualifying_at }] : []),
    { type: "race" as const, startsAt: race.race_at },
  ];
  const sessions = schedQ.data && schedQ.data.length ? schedQ.data : fallback;

  if (tab === "schedule") return <Schedule sessions={sessions} now={now} />;
  return <SessionPane key={tab} race={race} sessions={sessions} group={tab} now={now} />;
}

function Schedule({ sessions, now }: { sessions: ScheduleItem[]; now: number }) {
  const items = sessions.map((s) => ({ ...s, status: statusOf(s.startsAt, s.type, now) }));
  const next = items.find((s) => s.status !== "completed");

  return (
    <div className="space-y-2">
      {items.map((s) => {
        const st = STATUS_STYLE[s.status];
        return (
          <div
            key={s.type}
            className="tower-row flex items-center justify-between gap-3 rounded-md px-3 py-3"
            style={{ borderLeftColor: st.color }}
          >
            <div className="min-w-0">
              <p className="font-display text-base font-extrabold italic uppercase">{SESSION_LABEL[s.type]}</p>
              <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                {localTime(s.startsAt)}
              </p>
            </div>
            <span
              className="shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest"
              style={{ borderColor: st.color, color: st.color }}
            >
              {st.label}
            </span>
          </div>
        );
      })}
      {next && (
        <div className="pt-2">
          <Countdown target={next.startsAt} label={`${SESSION_LABEL[next.type]} starts in`} />
        </div>
      )}
    </div>
  );
}

function SessionPane({
  race,
  sessions,
  group,
  now,
}: {
  race: Race;
  sessions: ScheduleItem[];
  group: Exclude<Tab, "schedule">;
  now: number;
}) {
  const available = GROUPS[group]
    .map((t) => sessions.find((s) => s.type === t))
    .filter((s): s is ScheduleItem => !!s);

  const [picked, setPicked] = useState<SessionType | null>(null);

  if (!available.length) {
    return (
      <Empty
        text={
          group === "practice"
            ? "No practice sessions are listed for this weekend yet."
            : "No sessions of this kind are listed for this weekend."
        }
      />
    );
  }

  // Default to the most recent session that has already started.
  const started = available.filter((s) => new Date(s.startsAt).getTime() <= now);
  const selected = available.find((s) => s.type === picked) ?? started[started.length - 1] ?? available[0]!;

  return (
    <div className="space-y-3">
      {available.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {available.map((s) => (
            <button
              key={s.type}
              type="button"
              onClick={() => setPicked(s.type)}
              className={cn(
                "min-h-9 touch-manipulation rounded-full border px-3 font-mono text-[11px] font-bold uppercase tracking-wider",
                s.type === selected.type
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground",
              )}
            >
              {SESSION_LABEL[s.type]}
            </button>
          ))}
        </div>
      )}
      {selected.type === "race" ? (
        <RaceResults race={race} now={now} />
      ) : (
        <SessionResults key={selected.type} raceId={race.id} type={selected.type} startsAt={selected.startsAt} now={now} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- sessions

function SessionResults({
  raceId,
  type,
  startsAt,
  now,
}: {
  raceId: string;
  type: SessionType;
  startsAt: string;
  now: number;
}) {
  const q = useQuery({
    queryKey: ["weekend-session", raceId, type],
    retry: 1,
    initialData: () => readCache(raceId, type),
    staleTime: (query) =>
      query.state.data?.state === "ready" && hasCompleteTiming(query.state.data?.rows, type)
        ? Number.POSITIVE_INFINITY
        : 15_000,
    refetchInterval: (query) =>
      query.state.data?.state === "ready" && hasCompleteTiming(query.state.data?.rows, type)
        ? false
        : 20_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const r = await getWeekendSession({ data: { raceId, sessionType: type } });
      writeCache(raceId, type, r);
      return r;
    },
  });

  if (q.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-muted/60" />;
  if (q.isError && !q.data) {
    return (
      <Empty
        text="Couldn't load this session right now. Tap below to retry."
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
      />
    );
  }

  const data = q.data;
  const state = data?.state ?? statusLikeState(startsAt, type, now);

  if (state === "upcoming") return <Empty text={`${SESSION_LABEL[type]} starts ${localTime(startsAt)}.`} />;
  if (state === "live" && (!data || !data.rows.length))
    return (
      <Empty
        text={`${SESSION_LABEL[type]} is live on track. Fetching live telemetry classification...`}
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
      />
    );
  if (state === "pending" || !data || !data.rows.length)
    return (
      <Empty
        text={`Syncing ${SESSION_LABEL[type]} classification...`}
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
      />
    );

  const isTimingComplete = hasCompleteTiming(data.rows, type);

  return (
    <div className="space-y-2.5">
      {!isTimingComplete && (
        <div className="carbon-panel flex items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2">
          <div className="flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-primary">
            <span className="h-2 w-2 animate-ping rounded-full bg-primary" />
            <span>
              {type === "qualifying" || type === "sprint_qualifying"
                ? "Syncing Q1 / Q2 / Q3 lap times..."
                : "Syncing official lap times..."}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
            className="shrink-0 rounded border border-primary/40 bg-primary/15 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-primary transition hover:bg-primary/25 disabled:opacity-50"
          >
            {q.isFetching ? "Syncing..." : "Refresh timing"}
          </button>
        </div>
      )}
      <ClassTable rows={data.rows} type={type} />
    </div>
  );
}

function statusLikeState(startsAt: string, type: SessionType, now: number): SessionPayload["state"] {
  const s = statusOf(startsAt, type, now);
  return s === "upcoming" ? "upcoming" : s === "live" ? "live" : "pending";
}

function ClassTable({ rows, type }: { rows: ClassRow[]; type: SessionType }) {
  const quali = type === "qualifying" || type === "sprint_qualifying";
  const { data: gridDrivers } = useQuery(driversQuery);
  const [pickedSeg, setPickedSeg] = useState<QualiSegment | null>(null);

  if (quali) {
    const hasQ3 = rows.some((r) => parseLapSec(r.q3) != null);
    const hasQ2 = rows.some((r) => parseLapSec(r.q2) != null);
    const defaultSeg: QualiSegment = hasQ3 ? "q3" : hasQ2 ? "q2" : "q1";
    const activeSeg: QualiSegment = pickedSeg ?? defaultSeg;
    const segMeta = QUALI_SEGMENTS.find((s) => s.id === activeSeg) ?? QUALI_SEGMENTS[0]!;
    const qRows = buildQualifyingSegmentRows(rows, activeSeg, gridDrivers);

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {QUALI_SEGMENTS.map((seg) => (
            <button
              key={seg.id}
              type="button"
              onClick={() => setPickedSeg(seg.id)}
              className={cn(
                "min-h-9 touch-manipulation rounded-full border px-4 font-mono text-[11px] font-bold uppercase tracking-wider",
                seg.id === activeSeg
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground",
              )}
            >
              {seg.label}
            </button>
          ))}
        </div>

        <div className="space-y-1">
          {qRows.map((item, i) => {
            const r = item.row;
            const sub =
              item.position > 1 && item.gapToLeader
                ? [item.gapToLeader, item.gapToAhead ? `INT ${item.gapToAhead}` : null]
                    .filter(Boolean)
                    .join(" \u00B7 ")
                : null;
            return (
              <div
                key={`${activeSeg}-${r.driverId ?? r.number ?? i}`}
                className={cn(
                  "tower-row flex items-center gap-3 rounded-md px-3 py-2",
                  segMeta.cutoff != null &&
                    i === segMeta.cutoff &&
                    "mt-3 border-t-2 border-dashed border-primary/40",
                )}
                style={{ borderLeftColor: teamColor(r.team) }}
              >
                <span
                  className={cn(
                    "w-8 shrink-0 text-center font-mono text-sm font-bold tabular-nums",
                    item.position === 1 && "text-gold",
                  )}
                >
                  {item.position}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-sm font-extrabold italic uppercase">
                    {r.code ?? r.name ?? (r.number != null ? `#${r.number}` : "\u2014")}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {[r.name, r.team].filter(Boolean).join(" \u00B7 ")}
                  </span>
                  {sub && (
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {sub}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right font-mono text-sm font-bold tabular-nums">
                  {item.time ? (
                    item.time
                  ) : r.status ? (
                    <span className="text-primary">{r.status}</span>
                  ) : (
                    "\u2014"
                  )}
                </span>
              </div>
            );
          })}
          {segMeta.cutoff != null && qRows.length > segMeta.cutoff && (
            <p className="pt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {`Dashed line = top ${segMeta.cutoff}`}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {rows.map((r, i) => {
        const sub = [r.gap, r.laps != null ? `${r.laps} laps` : null].filter(Boolean).join(" \u00B7 ");
        return (
          <div
            key={`${r.driverId ?? r.number ?? i}`}
            className="tower-row flex items-center gap-3 rounded-md px-3 py-2"
            style={{ borderLeftColor: teamColor(r.team) }}
          >
            <span
              className={cn(
                "w-8 shrink-0 text-center font-mono text-sm font-bold tabular-nums",
                r.position === 1 && "text-gold",
              )}
            >
              {r.position ?? "\u2013"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-display text-sm font-extrabold italic uppercase">
                {r.code ?? r.name ?? (r.number != null ? `#${r.number}` : "\u2014")}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {[r.name, r.team].filter(Boolean).join(" \u00B7 ")}
              </span>
              {sub && <span className="block truncate font-mono text-[10px] text-muted-foreground">{sub}</span>}
            </span>
            <span className="shrink-0 text-right font-mono text-sm font-bold tabular-nums">
              {r.status ? <span className="text-primary">{r.status}</span> : (r.time ?? "\u2014")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------- race

type ResultRow = {
  driver_id: string;
  position: number | null;
  finished: boolean;
  fastest_lap: boolean;
  pole: boolean;
};

function RaceResults({ race, now }: { race: Race; now: number }) {
  const queryClient = useQueryClient();
  const { data: drivers } = useQuery(driversQuery);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["weekend-results", race.id],
    staleTime: 5 * MIN,
    queryFn: async (): Promise<ResultRow[]> => {
      const { data, error } = await supabase
        .from("race_results")
        .select("driver_id, position, finished, fastest_lap, pole")
        .eq("race_id", race.id)
        .order("position", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as ResultRow[];
    },
  });

  const startMs = new Date(race.race_at).getTime();
  const isRaceWindow = !race.has_results && now >= startMs && now - startMs <= 4 * 60 * MIN;

  const liveQ = useQuery<LiveRaceTelemetryPayload>({
    queryKey: ["live-race-telemetry", race.id],
    enabled: isRaceWindow,
    staleTime: 20_000,
    refetchInterval: (q) => (q.state.data?.state === "official" ? false : 25_000),
    refetchIntervalInBackground: false,
    queryFn: async () => getLiveRaceTelemetry({ data: { raceId: race.id } }),
  });

  useEffect(() => {
    if (liveQ.data?.finalizedNow || liveQ.data?.state === "official") {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["weekend-results", race.id] }),
        queryClient.invalidateQueries({ queryKey: ["races"] }),
      ]);
    }
  }, [liveQ.data?.finalizedNow, liveQ.data?.state, race.id, queryClient]);

  const byId = new Map((drivers ?? []).map((d) => [d.id, d]));
  const dbRows: ResultRow[] = data ?? [];
  const hasOfficial = race.has_results && dbRows.length > 0;
  const liveRows: ResultRow[] = liveQ.data?.results ?? [];
  const isShowingLive = !hasOfficial && liveRows.length > 0;
  const rows: ResultRow[] = hasOfficial ? dbRows : liveRows;

  if (isLoading) return <div className="h-40 animate-pulse rounded-lg bg-muted/60" />;
  if (isError && !rows.length) return <Empty text="Couldn't load results right now. Try again in a moment." />;

  if (!hasOfficial && !isShowingLive) {
    const st = statusOf(race.race_at, "race", now);
    return (
      <Empty
        text={
          st === "upcoming"
            ? "The race hasn't started. Picks lock when the lights go out."
            : st === "live"
              ? "The race is live on track. Fetching live telemetry classification..."
              : "Waiting for the official classification."
        }
      />
    );
  }

  const classified = rows.filter((r: ResultRow) => r.finished && r.position != null);
  const dnfs = rows.filter((r: ResultRow) => !r.finished);
  const winner = classified[0];
  const pole = rows.find((r: ResultRow) => r.pole);
  const fl = rows.find((r: ResultRow) => r.fastest_lap);

  return (
    <div className="space-y-4">
      {isShowingLive && (
        <div className="carbon-panel flex items-center gap-2 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-primary">
          <span className="h-2 w-2 animate-ping rounded-full bg-primary" />
          {"Live Grand Prix Telemetry \u00B7 Auto-updating every 25s"}
        </div>
      )}
      <div className="carbon-panel grid grid-cols-2 gap-3 rounded-lg p-4 sm:grid-cols-4">
        <Fact label={isShowingLive ? "Leader" : "Winner"} d={winner && byId.get(winner.driver_id)} />
        <Fact label="Pole" d={pole && byId.get(pole.driver_id)} />
        <Fact label="Fastest lap" d={fl && byId.get(fl.driver_id)} purple />
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">DNFs</p>
          <p className="font-display text-lg font-extrabold italic">{dnfs.length}</p>
        </div>
      </div>

      <div className="space-y-1">
        {classified.map((r: ResultRow) => {
          const d = byId.get(r.driver_id);
          return (
            <div
              key={r.driver_id}
              className="tower-row flex items-center gap-3 rounded-md px-3 py-2"
              style={{ borderLeftColor: teamColor(d?.team ?? null) }}
            >
              <span className="w-8 shrink-0 text-center font-mono text-sm font-bold tabular-nums">{r.position}</span>
              <DriverName d={d} fallback={r.driver_id} />
              <span className="ml-auto flex shrink-0 gap-1 font-mono text-[10px] font-bold uppercase">
                {r.pole && <span className="rounded bg-gold px-1.5 py-0.5 text-gold-foreground">Pole</span>}
                {r.fastest_lap && <span className="rounded bg-secondary px-1.5 py-0.5 text-purple">FL</span>}
              </span>
            </div>
          );
        })}
        {dnfs.map((r: ResultRow) => {
          const d = byId.get(r.driver_id);
          return (
            <div
              key={r.driver_id}
              className="tower-row flex items-center gap-3 rounded-md px-3 py-2 opacity-70"
              style={{ borderLeftColor: teamColor(d?.team ?? null) }}
            >
              <span className="w-8 shrink-0 text-center font-mono text-sm font-bold text-primary">DNF</span>
              <DriverName d={d} fallback={r.driver_id} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DriverName({ d, fallback }: { d?: Driver | undefined; fallback: string }) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-display text-sm font-extrabold italic uppercase">
        {d ? (d.code ?? d.full_name) : fallback}
      </span>
      {d && (
        <span className="block truncate text-[11px] text-muted-foreground">
          {d.full_name}
          {d.team ? ` \u00B7 ${d.team}` : ""}
        </span>
      )}
    </span>
  );
}

function Fact({ label, d, purple }: { label: string; d?: Driver | undefined; purple?: boolean | undefined }) {
  return (
    <div>
      <p className={cn("font-mono text-[10px] uppercase tracking-widest", purple ? "text-purple" : "text-muted-foreground")}>
        {label}
      </p>
      <p className="font-display text-lg font-extrabold italic uppercase">{d ? (d.code ?? d.full_name) : "\u2014"}</p>
    </div>
  );
}

function Empty({
  text,
  onRetry,
  retrying,
}: {
  text: string;
  onRetry?: (() => void) | undefined;
  retrying?: boolean | undefined;
}) {
  return (
    <div className="carbon-panel flex flex-col items-start justify-between gap-3 rounded-lg p-5 sm:flex-row sm:items-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="shrink-0 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-primary transition hover:bg-primary/20 disabled:opacity-50"
        >
          {retrying ? "Refreshing..." : "Refresh timing"}
        </button>
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-3xl px-4 pb-24 pt-10">{children}</main>;
}