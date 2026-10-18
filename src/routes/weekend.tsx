import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react"; import { useAutoAnimate } from "@formkit/auto-animate/react";

import { Countdown } from "@/components/Countdown";
import { supabase } from "@/integrations/supabase/client";
import { driversQuery, racesQuery, toEpochMs, type Driver, type Race } from "@/lib/queries";
import { teamColor } from "@/lib/teams";
import {
  SESSION_LABEL,
  SESSION_MINUTES,
  type ClassRow,
  type ScheduleItem,
  type SessionPayload,
  type SessionType,
} from "@/lib/weekend";
import { getWeekendSchedule, getWeekendSession } from "@/lib/weekend.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/weekend")({
  head: () => ({
    meta: [
      { title: "Race weekend — DOWNFORCE" },
      {
        name: "description",
        content:
          "Session schedule, practice, qualifying and race classification for the current Grand Prix weekend.",
      },
      { property: "og:title", content: "Race weekend — DOWNFORCE" },
      {
        property: "og:description",
        content: "Follow the Grand Prix weekend: schedule, practice, qualifying and race result.",
      },
      { name: "twitter:title", content: "Race weekend — DOWNFORCE" },
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

type Status = "upcoming" | "live" | "completed";
const MIN = 60_000;
const STAY_MS = 18 * 60 * MIN; // keep showing a weekend until 3 days after the race starts

function statusOf(startIso: string, type: SessionType, now: number): Status {
  const start = toEpochMs(startIso);
  if (now < start) return "upcoming";
  return now < start + SESSION_MINUTES[type] * MIN ? "live" : "completed";
}

/** null on the server and first render, so times never mismatch between server and browser. */
function useNow(ms = 15_000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function currentWeekend(races: Race[], now: number): Race | null {
  if (!races.length) return null;
  return (
    races.find((r) => toEpochMs(r.race_at) + STAY_MS >= now) ?? races[races.length - 1]!
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

// ---- small local cache for finished sessions (they never change) ----
const cacheKey = (raceId: string, type: string) => `dfr:session:${raceId}:${type}`;
function readCache(raceId: string, type: string): SessionPayload | undefined {
  try {
    const raw = window.localStorage.getItem(cacheKey(raceId, type));
    return raw ? (JSON.parse(raw) as SessionPayload) : undefined;
  } catch {
    return undefined;
  }
}
function writeCache(raceId: string, type: string, payload: SessionPayload) {
  try {
    window.localStorage.setItem(cacheKey(raceId, type), JSON.stringify(payload));
  } catch {
    /* storage unavailable: ignore */
  }
}

function Weekend() {
  const now = useNow();
  const { data: races, isLoading } = useQuery(racesQuery);
  const [tab, setTab] = useState<Tab>("schedule"); const [rId, setRId] = useState<string | null>(null); const [tabRef] = useAutoAnimate<HTMLDivElement>();

  if (isLoading || now === null || !races) {
    return (
      <Shell>
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="mt-6 h-40 animate-pulse rounded-lg bg-muted/60" />
      </Shell>
    );
  }

  const defRace = currentWeekend(races, now); const race = races.find((r) => r.id === rId) ?? defRace;
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
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">{races.filter((r) => r.has_results || r.id === defRace?.id).slice(-6).reverse().map((r) => (<button key={r.id} type="button" onClick={() => setRId(r.id)} className={cn("shrink-0 rounded-full border px-3 py-1 font-mono text-xs font-bold", r.id === race.id ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground")}>R{r.round}</button>))}</div><p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-primary">
        Round {race.round}
      </p>
      <h1 className="mt-1 text-3xl">{race.name}</h1>
      <p className="text-sm text-muted-foreground">
        {race.circuit}
        {race.locality ? ` · ${race.locality}` : ""}
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
  // The full session list (practice, sprint, ...) comes from the server; until it
  // arrives (or if it fails) we show what the races table already knows.
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
  const started = available.filter((s) => toEpochMs(s.startsAt) <= now);
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
    staleTime: (query) => (query.state.data?.state === "ready" ? Number.POSITIVE_INFINITY : 30_000),
    refetchInterval: (query) => (query.state.data?.state === "ready" ? false : 60_000),
    queryFn: async () => {
      const r = await getWeekendSession({ data: { raceId, sessionType: type } });
      if (r.state === "ready") writeCache(raceId, type, r);
      return r;
    },
  });

  if (q.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-muted/60" />;
  if (q.isError && !q.data) {
    return <Empty text="Couldn't load this session right now. Pull to refresh or try again in a moment." />;
  }

  const data = q.data;
  const state = data?.state ?? statusLikeState(startsAt, type, now);

  if (state === "upcoming") return <Empty text={`${SESSION_LABEL[type]} starts ${localTime(startsAt)}.`} />;
  if (state === "live")
    return <Empty text={`${SESSION_LABEL[type]} is in progress. The classification appears once it ends.`} />;
  if (state === "pending" || !data || !data.rows.length)
    return <Empty text="Waiting for the official classification…" />;

  return <ClassTable rows={data.rows} type={type} />;
}

function statusLikeState(startsAt: string, type: SessionType, now: number): SessionPayload["state"] {
  const s = statusOf(startsAt, type, now);
  return s === "upcoming" ? "upcoming" : s === "live" ? "live" : "pending";
}

function ClassTable({ rows, type }: { rows: ClassRow[]; type: SessionType }) {
  const quali = type === "qualifying" || type === "sprint_qualifying";
  return (
    <div className="space-y-1">
      {rows.map((r, i) => {
        const sub = quali
          ? [r.q1 && `Q1 ${r.q1}`, r.q2 && `Q2 ${r.q2}`, r.q3 && `Q3 ${r.q3}`].filter(Boolean).join(" · ")
          : [r.gap, r.laps != null ? `${r.laps} laps` : null].filter(Boolean).join(" · ");
        return (
          <div
            key={`${r.driverId ?? r.number ?? i}`}
            className={cn(
              "tower-row flex items-center gap-3 rounded-md px-3 py-2",
              quali && i === 10 && "mt-3 border-t-2 border-dashed border-primary/40",
            )}
            style={{ borderLeftColor: teamColor(r.team) }}
          >
            <span
              className={cn(
                "w-8 shrink-0 text-center font-mono text-sm font-bold tabular-nums",
                r.position === 1 && "text-gold",
              )}
            >
              {r.position ?? "–"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-display text-sm font-extrabold italic uppercase">
                {r.code ?? r.name ?? (r.number != null ? `#${r.number}` : "—")}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {[r.name, r.team].filter(Boolean).join(" · ")}
              </span>
              {sub && <span className="block truncate font-mono text-[10px] text-muted-foreground">{sub}</span>}
            </span>
            <span className="shrink-0 text-right font-mono text-sm font-bold tabular-nums">
              {r.status ? <span className="text-primary">{r.status}</span> : (r.time ?? "—")}
            </span>
          </div>
        );
      })}
      {quali && rows.length > 10 && (
        <p className="pt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Dashed line = top 10
        </p>
      )}
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

  const byId = new Map((drivers ?? []).map((d) => [d.id, d]));
  const rows = data ?? [];
  const hasResults = race.has_results && rows.length > 0;

  if (isLoading) return <div className="h-40 animate-pulse rounded-lg bg-muted/60" />;
  if (isError) return <Empty text="Couldn't load results right now. Try again in a moment." />;

  if (!hasResults) {
    const st = statusOf(race.race_at, "race", now);
    return (
      <Empty
        text={
          st === "upcoming"
            ? "The race hasn't started. Picks lock when the lights go out."
            : st === "live"
              ? "The race is in progress. The classification appears after the chequered flag."
              : "Waiting for the official classification."
        }
      />
    );
  }

  const classified = rows.filter((r) => r.finished && r.position != null);
  const dnfs = rows.filter((r) => !r.finished);
  const winner = classified[0];
  const pole = rows.find((r) => r.pole);
  const fl = rows.find((r) => r.fastest_lap);

  return (
    <div className="space-y-4">
      <div className="carbon-panel grid grid-cols-2 gap-3 rounded-lg p-4 sm:grid-cols-4">
        <Fact label="Winner" d={winner && byId.get(winner.driver_id)} />
        <Fact label="Pole" d={pole && byId.get(pole.driver_id)} />
        <Fact label="Fastest lap" d={fl && byId.get(fl.driver_id)} purple />
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">DNFs</p>
          <p className="font-display text-lg font-extrabold italic">{dnfs.length}</p>
        </div>
      </div>

      <div className="space-y-1">
        {classified.map((r) => {
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
        {dnfs.map((r) => {
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
          {d.team ? ` · ${d.team}` : ""}
        </span>
      )}
    </span>
  );
}

function Fact({ label, d, purple }: { label: string; d?: Driver | undefined; purple?: boolean }) {
  return (
    <div>
      <p className={cn("font-mono text-[10px] uppercase tracking-widest", purple ? "text-purple" : "text-muted-foreground")}>
        {label}
      </p>
      <p className="font-display text-lg font-extrabold italic uppercase">{d ? (d.code ?? d.full_name) : "—"}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="carbon-panel rounded-lg p-5 text-sm text-muted-foreground">{text}</p>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-3xl px-4 pb-24 pt-10">{children}</main>;
}
