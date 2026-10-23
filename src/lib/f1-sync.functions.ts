import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { type ResultRow } from "./scoring";
import { buildRaceScoreRows, type ProfileRecord, type PredictionRecord, type SprintPredictionRecord, type ScoreRecord } from "./roundScoring";
import { type SprintResultRow } from "./sprintScoring";
import { getJson, toIso, isClassifiedFinishStatus } from "./f1-parsers";
import { isCompleteTop10, parsePushSubscriptionKey } from "./push-keys";
import { hasChequeredFlag, type OpenF1RaceControlMessage } from "./liveStandings";

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
  time?: string;
  Circuit: {
    circuitName: string;
    Location: { locality?: string; country?: string };
  };
  Qualifying?: ErgastSession;
  Sprint?: ErgastSession;
  SprintQualifying?: ErgastSession;
  SprintShootout?: ErgastSession;
  Results?: Array<{
    position: string;
    grid: string;
    status: string;
    Driver: { driverId: string; code?: string; givenName: string; familyName: string };
    Constructor?: { name: string };
    FastestLap?: { rank?: string };
  }>;
};


const userSyncCalls = new Map<string, number>();
let inFlightSyncLock = false;

// NOTE: savePushSubscription duplicate removed (0 imports) — single source is
// savePushSubscription in @/lib/stewards.functions.ts.

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
    // ---- Calendar (preserving Steward custom deadline overrides!) ----
    const calendar = await getJson<{
      MRData: { RaceTable: { Races: ErgastRace[] } };
    }>(`${API}/${SEASON}/races/?format=json&limit=40`);
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
    const standings = await getJson<{
      MRData: {
        StandingsTable: {
          StandingsLists: Array<{
            DriverStandings: Array<{
              Driver: {
                driverId: string;
                code?: string;
                permanentNumber?: string;
                givenName: string;
                familyName: string;
              };
              Constructors: Array<{ name: string }>;
            }>;
          }>;
        };
      };
    }>(`${API}/${SEASON}/driverstandings/?format=json&limit=60`);

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

    for (const race of racesWithResults) {
      const raceId = roundToId.get(Number(race.round));
      if (!raceId || !race.Results?.length) continue;

      const rows = race.Results.map((res) => {
        const status = res.status ?? "";
        const finished = isClassifiedFinishStatus(status, true);
        return {
          race_id: raceId,
          driver_id: res.Driver.driverId,
          position: finished ? Number(res.position) : null,
          status,
          finished,
          fastest_lap: res.FastestLap?.rank === "1",
          pole: res.grid === "1",
        };
      });

      await supabaseAdmin
        .from("race_results")
        .upsert(rows, { onConflict: "race_id,driver_id" });
      await supabaseAdmin.from("races").update({ has_results: true }).eq("id", raceId);
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
    } finally { inFlightSyncLock = false; }
  });

export async function checkAndSendPushReminders(
  supabaseAdmin: (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"],
) {
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
                : isCompleteTop10(p.top10),
            )
            .map((p) => p.user_id),
        );

        const payloadObj = {
          title: `⏰ ${race.name} — Lock Alert!`,
          body:
            t.type === "pole"
              ? `Qualifying starts ${w.text}! Lock in your Pole Position pick now.`
              : `Race locks ${w.text}! Submit your Top 10 now to avoid the −25 penalty.`,
          tag: stateKey,
          url: "/predict",
        };

        const { sendNativeWebPush } = await import("./webpush-native");
        const deadKeys: string[] = [];
        const pendingSubs = subRows.flatMap((r) => {
          const parsed = parsePushSubscriptionKey(r.key);
          return parsed && !doneUsers.has(parsed.userId) ? [parsed] : [];
        });
        const BATCH_SIZE = 25;
        for (let i = 0; i < pendingSubs.length; i += BATCH_SIZE) {
          const batch = pendingSubs.slice(i, i + BATCH_SIZE);
          await Promise.allSettled(
            batch.map(async (sub) => {
              try {
                const res = await sendNativeWebPush(sub, payloadObj);
                if (res.ok) totalSent++;
                else if (res.status === 404 || res.status === 410) deadKeys.push(sub.rawKey);
              } catch {}
            }),
          );
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

  for (const race of races) {
    const [
      { data: profiles },
      { data: results },
      { data: predictions },
      { data: sprintResults },
      { data: sprintPreds },
      { data: existingScores },
    ] = await Promise.all([
      supabaseAdmin.from("profiles").select("id, created_at").lt("created_at", race.race_at),
      supabaseAdmin
        .from("race_results")
        .select("driver_id, position, finished, fastest_lap, pole")
        .eq("race_id", race.id),
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

    if (!profiles?.length || !results?.length) continue;

    const rows = buildRaceScoreRows({
      raceId: race.id,
      raceAt: race.race_at,
      profiles: (profiles ?? []) as ProfileRecord[],
      results: results as ResultRow[],
      predictions: (predictions ?? []) as PredictionRecord[],
      sprintResults: (sprintResults ?? []) as SprintResultRow[],
      sprintPredictions: (sprintPreds ?? []) as SprintPredictionRecord[],
      existingScores: (existingScores ?? []) as ScoreRecord[],
      mode: "auto_sync",
    });

    if (rows.length) {
      await supabaseAdmin.from("scores").upsert(rows, { onConflict: "user_id,race_id" });
    }
  }
}

const OPENF1 = "https://api.openf1.org/v1";
const RACE_MIN_START_MS = 40 * 60 * 1000; // Check Race Control from 40m after lights out
const RACE_MAX_DONE_MS = 180 * 60 * 1000; // 3h hard ceiling if race_control feed is empty
const FALLBACK_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

type OF1Session = { session_key: number; session_name: string; date_start: string };
type OF1Result = { position: number | null; driver_number: number; dnf?: boolean; dns?: boolean; dsq?: boolean };

async function openF1Fallback(officialRounds: Set<number>) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = Date.now();

  const { data: pending } = await supabaseAdmin
    .from("races")
    .select("id, round, race_at, qualifying_at")
    .eq("season", SEASON)
    .eq("has_results", false)
    .lte("race_at", new Date(now - RACE_MIN_START_MS).toISOString())
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
  SprintResults?: Array<{
    position: string;
    grid: string;
    status: string;
    Driver: { driverId: string };
  }>;
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

  for (const race of byRound.values()) {
    const raceId = roundToId.get(Number(race.round));
    if (!raceId || !race.SprintResults?.length) continue;
    const rows = race.SprintResults.map((res) => {
      const status = res.status ?? "";
      const finished = isClassifiedFinishStatus(status, true);
      return {
        race_id: raceId,
        driver_id: res.Driver.driverId,
        position: finished ? Number(res.position) : null,
        status,
        finished,
        pole: res.grid === "1",
      };
    });
    await supabaseAdmin.from("sprint_results").upsert(rows, { onConflict: "race_id,driver_id" });
  }
}
