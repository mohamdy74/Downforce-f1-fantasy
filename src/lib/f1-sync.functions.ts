import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { type ResultRow } from "./scoring";
import {
  buildRaceScoreRows,
  type ProfileRecord,
  type PredictionRecord,
  type SprintPredictionRecord,
  type ScoreRecord,
} from "./roundScoring";
import { type SprintResultRow } from "./sprintScoring";
import { getJson, toIso, isClassifiedFinishStatus } from "./f1-parsers";
import {
  buildDriverLookup,
  fetchFromEspnScoreboard,
  fetchFromF1LiveTiming,
  getCachedOpenF1Drivers,
  getCachedOpenF1Sessions,
  resolveDriver,
  type DriverRef,
} from "./f1-live-sources";
import { isCompleteTop10, parsePushSubscriptionKey } from "./push-keys";
import {
  buildLiveOrderFromPositions,
  hasChequeredFlag,
  type OpenF1LapEntry,
  type OpenF1PositionEntry,
  type OpenF1RaceControlMessage,
} from "./liveStandings";
import { buildReminderPayload, computeActiveReminders } from "./reminder-windows";
import { requireSteward } from "./stewards.functions";

const API = "https://api.jolpi.ca/ergast/f1";
const SEASON = 2026;
const STALE_MS = 5 * 60 * 1000; // non-force syncs skip while season data is younger than this
const EXCLUDED_DRIVERS = new Set();

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
        Driver: {
          driverId: string;
          code?: string | undefined;
          givenName: string;
          familyName: string;
        };
        Constructor?: { name: string } | undefined;
        FastestLap?: { rank?: string | undefined } | undefined;
      }>
    | undefined;
};

const userSyncCalls = new Map<string, number>();
let inFlightSyncLock = false;

export const syncF1Data = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ({
    force: Boolean((input as { force?: boolean | undefined } | null)?.force),
  }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Force syncs run the full season pipeline against upstream APIs — reserve them
    // for the steward. Regular player-triggered syncs stay on the cooldown below.
    if (data.force) {
      await requireSteward(context);
    }

    const userId = context.userId;
    const lastCall = userSyncCalls.get(userId) ?? 0;
    const minInterval = data.force ? 1_000 : 10 * 1000;

    if (Date.now() - lastCall < minInterval) {
      if (!data.force) return { skipped: true as const };
      throw new Error("Please wait a few seconds before syncing again.");
    }
    if (userSyncCalls.size > 500) {
      const cutoff = Date.now() - 5 * 60_000;
      for (const [k, ts] of userSyncCalls) {
        if (ts < cutoff) userSyncCalls.delete(k);
      }
    }
    userSyncCalls.set(userId, Date.now());

    // Fast path: a non-force sync while the season data is still fresh never
    // touches the queue — same freshness window runSeasonSync used inline.
    if (!data.force) {
      const { data: state } = await supabaseAdmin
        .from("sync_state")
        .select("synced_at")
        .eq("key", `season-${SEASON}`)
        .maybeSingle();
      const age = state?.synced_at ? Date.now() - new Date(state.synced_at).getTime() : Infinity;
      if (age < STALE_MS) return { accepted: false as const, skipped: true as const, jobId: null };
    }

    // The heavy season pipeline runs as a background job now: enqueue (the
    // active-dedup unique index coalesces with any running sync and replaces
    // the old in-memory in-flight lock) and return immediately with the job
    // id. The RPC transport answers HTTP 200; `accepted` is the 202 semantic.
    const { enqueueJob } = await import("./job-queue");
    const { jobId, created } = await enqueueJob(supabaseAdmin, {
      type: "season-sync",
      payload: { force: data.force },
      dedupKey: "season-sync",
      createdBy: userId,
      maxAttempts: 5,
      timeoutMs: 60_000,
    });
    return { accepted: true as const, skipped: false as const, jobId, created };
  });

/**
 * Shared season sync used by the authenticated `syncF1Data` server function and
 * the /reminders cron warm-up. Non-force calls respect the STALE_MS freshness
 * window and the in-flight lock, so background and cron syncs never hammer the
 * external F1 APIs. Returns `skipped: true` without heavy work when the season
 * data is already fresh.
 */
export async function runSeasonSync(
  supabaseAdmin: (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"],
  opts: { force: boolean },
): Promise<{ skipped: boolean; races: number; scored: number }> {
  if (!opts.force && inFlightSyncLock) {
    return { skipped: true, races: 0, scored: 0 };
  }

  const { data: state } = await supabaseAdmin
    .from("sync_state")
    .select("synced_at")
    .eq("key", `season-${SEASON}`)
    .maybeSingle();

  if (!opts.force && state?.synced_at) {
    const age = Date.now() - new Date(state.synced_at).getTime();
    if (age < STALE_MS) return { skipped: true, races: 0, scored: 0 };
  }

  inFlightSyncLock = true;
  try {
    // ---- Calendar + Drivers standings (independent upstream calls, fetched in parallel) ----
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

    // ---- Drivers (pure CPU from the standings — built here so the write can
    // run in parallel with the races upsert below) ----
    const entries = (
      standings?.MRData.StandingsTable.StandingsLists?.[0]?.DriverStandings ?? []
    ).filter((e) => !EXCLUDED_DRIVERS.has(e.Driver.driverId));
    const driverRows = entries.map((e) => ({
      id: e.Driver.driverId,
      code: e.Driver.code ?? null,
      full_name: `${e.Driver.givenName} ${e.Driver.familyName}`,
      team: e.Constructors[0]?.name ?? null,
      number: e.Driver.permanentNumber ? Number(e.Driver.permanentNumber) : null,
      active: true,
    }));

    if (races.length) {
      const [{ data: existingRaces }, { data: overrideRows }] = await Promise.all([
        supabaseAdmin
          .from("races")
          .select("id, round, race_at, qualifying_at")
          .eq("season", SEASON),
        supabaseAdmin.from("sync_state").select("key").like("key", "deadline_override:%"),
      ]);

      const overriddenIds = new Set(
        (overrideRows ?? []).map((r) => r.key.replace("deadline_override:", "")),
      );
      const existingByRound = new Map((existingRaces ?? []).map((r) => [r.round, r]));

      // Races and drivers upserts hit different tables and depend only on the
      // calendar/standings fetched above — write both together.
      await Promise.all([
        supabaseAdmin.from("races").upsert(
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
        ),
        driverRows.length
          ? supabaseAdmin.from("drivers").upsert(driverRows, { onConflict: "id" })
          : Promise.resolve(null),
      ]);
    } else if (driverRows.length) {
      await supabaseAdmin.from("drivers").upsert(driverRows, { onConflict: "id" });
    }

    // ---- Results (targeted: only fetch rounds that can have new data) ----
    const { data: dbRaces } = await supabaseAdmin
      .from("races")
      .select("id, round, has_results, race_at, has_sprint")
      .eq("season", SEASON);
    const roundToId = new Map((dbRaces ?? []).map((r) => [r.round, r.id]));
    const nowMs = Date.now();
    const pendingRounds = (dbRaces ?? [])
      .filter((r) => !r.has_results && new Date(r.race_at).getTime() < nowMs)
      .map((r) => Number(r.round));
    const completedRounds = (dbRaces ?? [])
      .filter((r) => r.has_results)
      .map((r) => Number(r.round));
    const lastCompletedRound = completedRounds.length ? Math.max(...completedRounds) : 0;
    const targetRounds = new Set<number>(pendingRounds);
    if (lastCompletedRound > 0) targetRounds.add(lastCompletedRound);
    const sprintTargetRounds = (dbRaces ?? [])
      .filter((r) => r.has_sprint && targetRounds.has(Number(r.round)))
      .map((r) => Number(r.round));

    const racesWithResults: ErgastRace[] = [];
    const pageSize = 100;
    const mergeRace = (race: ErgastRace) => {
      const existing = racesWithResults.find((r) => r.round === race.round);
      if (existing) existing.Results = [...(existing.Results ?? []), ...(race.Results ?? [])];
      else racesWithResults.push(race);
    };

    if (pendingRounds.length > 3) {
      // First sync / big backfill: paginate the whole season, remaining pages in parallel
      const page0 = await getJson<{
        MRData: { total: string; RaceTable: { Races: ErgastRace[] } };
      }>(`${API}/${SEASON}/results/?format=json&limit=${pageSize}&offset=0`);
      if (page0) {
        const total = Number(page0.MRData.total);
        const pageCount = Math.min(Math.ceil(total / pageSize), 20);
        const rest = await Promise.all(
          Array.from({ length: Math.max(pageCount - 1, 0) }, (_, i) =>
            getJson<{
              MRData: { total: string; RaceTable: { Races: ErgastRace[] } };
            }>(
              `${API}/${SEASON}/results/?format=json&limit=${pageSize}&offset=${(i + 1) * pageSize}`,
            ),
          ),
        );
        for (const race of page0.MRData.RaceTable.Races) mergeRace(race);
        for (const page of rest)
          for (const race of page?.MRData.RaceTable.Races ?? []) mergeRace(race);
      }
    } else {
      // Steady state: one small per-round request for each round that could have new data
      const pages = await Promise.all(
        Array.from(targetRounds, (round) =>
          getJson<{
            MRData: { RaceTable: { Races: ErgastRace[] } };
          }>(`${API}/${SEASON}/${round}/results/?format=json&limit=${pageSize}`),
        ),
      );
      for (const page of pages)
        for (const race of page?.MRData.RaceTable.Races ?? []) mergeRace(race);
    }

    // Batched writes: 2 round trips instead of 2 per stored race
    const allResultRows: Array<{
      race_id: string;
      driver_id: string;
      position: number | null;
      status: string;
      finished: boolean;
      fastest_lap: boolean;
      pole: boolean;
    }> = [];
    const roundsWithFreshResults: number[] = [];
    for (const race of racesWithResults) {
      const raceId = roundToId.get(Number(race.round));
      if (!raceId || !race.Results?.length) continue;
      for (const res of race.Results) {
        const status = res.status ?? "";
        const finished = isClassifiedFinishStatus(status, true);
        allResultRows.push({
          race_id: raceId,
          driver_id: res.Driver.driverId,
          position: finished ? Number(res.position) : null,
          status,
          finished,
          fastest_lap: res.FastestLap?.rank === "1",
          pole: res.grid === "1",
        });
      }
      roundsWithFreshResults.push(Number(race.round));
    }
    if (allResultRows.length) {
      await supabaseAdmin
        .from("race_results")
        .upsert(allResultRows, { onConflict: "race_id,driver_id" });
    }
    if (roundsWithFreshResults.length) {
      const ids = roundsWithFreshResults
        .map((rd) => roundToId.get(rd))
        .filter((x): x is string => !!x);
      await supabaseAdmin.from("races").update({ has_results: true }).in("id", ids);
    }

    // Sprint results and the openF1 fallback touch different tables and depend
    // only on the rounds already resolved above — run them together.
    const [, fallbackFinalized] = await Promise.all([
      syncSprintResults(roundToId, sprintTargetRounds),
      openF1Fallback(new Set(racesWithResults.map((r) => Number(r.round)))),
    ]);
    const scoreTargets = new Set<string>();
    for (const round of targetRounds) {
      const id = roundToId.get(round);
      if (id) scoreTargets.add(id);
    }
    for (const id of fallbackFinalized) scoreTargets.add(id);
    await scoreAllRaces(scoreTargets);

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
}

export async function checkAndSendPushReminders(
  supabaseAdmin: (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"],
) {
  const now = Date.now();
  // The upcoming-races window and the push-subscription keys are independent
  // reads — fetch them together.
  const [{ data: upcomingRaces }, { data: subRows }] = await Promise.all([
    supabaseAdmin
      .from("races")
      .select("id, name, qualifying_at, race_at")
      .eq("season", SEASON)
      .gte("race_at", new Date(now - 30 * 60_000).toISOString())
      .lte("race_at", new Date(now + 4 * 24 * 3600_000).toISOString()),
    supabaseAdmin.from("sync_state").select("key").like("key", "push_sub:%"),
  ]);

  if (!upcomingRaces?.length) return 0;
  if (!subRows?.length) return 0;

  let totalSent = 0;

  // The pure reminder-windows module owns the bands and payload copy, so this
  // sweep only handles dedup, batching and dead-subscription cleanup.
  const entries = computeActiveReminders(upcomingRaces, now);
  if (!entries.length) return 0;

  // One sweep-wide read of dedup state and submissions instead of a pair of
  // queries per reminder window (query count constant, not 2 per window).
  const sweepRaceIds = [...new Set(entries.map((e) => e.race.id))];
  const [{ data: remindedRows }, { data: sweepPreds }] = await Promise.all([
    supabaseAdmin.from("sync_state").select("key").like("key", "reminded:%"),
    supabaseAdmin
      .from("predictions")
      .select("race_id, user_id, top10, pole_driver_id")
      .in("race_id", sweepRaceIds),
  ]);
  const remindedKeys = new Set((remindedRows ?? []).map((r) => r.key));
  type SweepPred = NonNullable<typeof sweepPreds>[number];
  const predsByRace = new Map<string, SweepPred[]>();
  for (const p of sweepPreds ?? []) {
    const arr = predsByRace.get(p.race_id) ?? [];
    arr.push(p);
    predsByRace.set(p.race_id, arr);
  }

  const deadKeys: string[] = [];
  const dedupWrites: Array<{ key: string; synced_at: string }> = [];

  for (const entry of entries) {
    const { race, type: t, window: w } = entry;

    // Per-user dedup (replaces the old per-race global window key) so players
    // who enable push mid-window still get their reminder and a partially
    // failed sweep retries on the next pass.
    const keyPrefix = `reminded:${race.id}:${t}:${w.label}:`;
    const preds = predsByRace.get(race.id) ?? [];
    const doneUsers = new Set(
      preds
        .filter((p) => (t === "pole" ? !!p.pole_driver_id : isCompleteTop10(p.top10)))
        .map((p) => p.user_id),
    );

    const payloadObj = buildReminderPayload(entry);

    const { sendNativeWebPush } = await import("./webpush-native");
    const pendingSubs = subRows.flatMap((r) => {
      const parsed = parsePushSubscriptionKey(r.key);
      if (!parsed || doneUsers.has(parsed.userId)) return [];
      if (remindedKeys.has(keyPrefix + parsed.userId)) return [];
      return [parsed];
    });
    const BATCH_SIZE = 25;
    const newlyNotified = new Set<string>();
    for (let i = 0; i < pendingSubs.length; i += BATCH_SIZE) {
      const batch = pendingSubs.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        batch.map(async (sub) => {
          try {
            const res = await sendNativeWebPush(sub, payloadObj);
            if (res.ok) {
              totalSent++;
              newlyNotified.add(sub.userId);
            } else if (
              res.status === 401 ||
              res.status === 403 ||
              res.status === 404 ||
              res.status === 410
            ) {
              deadKeys.push(sub.rawKey);
            }
          } catch (error) {
            console.error("[f1-sync.functions] Push notification failed:", error);
          }
        }),
      );
    }
    const stamp = new Date().toISOString();
    for (const uid of newlyNotified) {
      dedupWrites.push({ key: keyPrefix + uid, synced_at: stamp });
    }
  }

  if (deadKeys.length > 0) {
    await supabaseAdmin.from("sync_state").delete().in("key", deadKeys);
  }
  if (dedupWrites.length > 0) {
    await supabaseAdmin.from("sync_state").upsert(dedupWrites, { onConflict: "key" });
  }
  return totalSent;
}
async function scoreAllRaces(targetRaceIds?: Set<string>) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // The races read and the (optional) already-scored read are independent —
  // fetch both together instead of serially.
  const [racesRes, scoredRes] = await Promise.all([
    supabaseAdmin.from("races").select("id, race_at").eq("season", SEASON).eq("has_results", true),
    targetRaceIds ? supabaseAdmin.from("scores").select("race_id") : Promise.resolve(null),
  ]);
  const races = racesRes.data;
  if (!races?.length) return;

  // Score only races whose results may have changed this sync (or that were
  // never scored). Untouched rounds keep their stored scores — which also
  // guarantees Steward manual score overrides are never clobbered.
  let toScore = races;
  if (targetRaceIds) {
    const scoredIds = new Set(
      ((scoredRes?.data ?? []) as { race_id: string }[]).map((r) => r.race_id as string),
    );
    toScore = races.filter((r) => targetRaceIds.has(r.id) || !scoredIds.has(r.id));
  }
  if (!toScore.length) return;

  // Bulk fetch: one query per table for ALL target races (instead of six
  // queries per race), then group rows by race in memory. Query count is
  // constant instead of growing with the number of races being scored.
  const scoreRaceIds = toScore.map((r) => r.id);
  let latestRaceAt = toScore[0]!.race_at;
  for (const r of toScore) {
    if (r.race_at > latestRaceAt) latestRaceAt = r.race_at;
  }
  const [
    { data: profileRows },
    { data: resultRows },
    { data: predRows },
    { data: sprintResultRows },
    { data: sprintPredRows },
    { data: existingScoreRows },
  ] = await Promise.all([
    supabaseAdmin.from("profiles").select("id, created_at").lt("created_at", latestRaceAt),
    supabaseAdmin
      .from("race_results")
      .select("race_id, driver_id, position, finished, fastest_lap, pole")
      .in("race_id", scoreRaceIds),
    supabaseAdmin
      .from("predictions")
      .select("race_id, user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id")
      .in("race_id", scoreRaceIds),
    supabaseAdmin
      .from("sprint_results")
      .select("race_id, driver_id, position, finished, pole")
      .in("race_id", scoreRaceIds),
    supabaseAdmin
      .from("sprint_predictions")
      .select("race_id, user_id, top8, pole_driver_id")
      .in("race_id", scoreRaceIds),
    supabaseAdmin.from("scores").select("race_id, user_id, breakdown").in("race_id", scoreRaceIds),
  ]);

  const groupByRace = <T extends { race_id: string }>(rows: T[] | null) => {
    const grouped = new Map<string, T[]>();
    for (const row of rows ?? []) {
      const arr = grouped.get(row.race_id) ?? [];
      arr.push(row);
      grouped.set(row.race_id, arr);
    }
    return grouped;
  };
  const resultsByRace = groupByRace(resultRows);
  const predsByRaceS = groupByRace(predRows);
  const sprintResultsByRace = groupByRace(sprintResultRows);
  const sprintPredsByRace = groupByRace(sprintPredRows);
  const existingScoresByRace = groupByRace(existingScoreRows);
  const allProfiles = (profileRows ?? []) as ProfileRecord[];

  const allScoreRows: ReturnType<typeof buildRaceScoreRows> = [];
  for (const race of toScore) {
    const raceProfiles = allProfiles.filter((p) => p.created_at < race.race_at);
    const raceResults = resultsByRace.get(race.id);
    if (!raceProfiles.length || !raceResults?.length) continue;

    const racePreds = predsByRaceS.get(race.id) ?? [];
    const raceSprintResults = sprintResultsByRace.get(race.id) ?? [];
    const raceSprintPreds = sprintPredsByRace.get(race.id) ?? [];
    const raceExistingScores = existingScoresByRace.get(race.id) ?? [];

    const rows = buildRaceScoreRows({
      raceId: race.id,
      raceAt: race.race_at,
      profiles: raceProfiles,
      results: raceResults as unknown as ResultRow[],
      predictions: racePreds as unknown as PredictionRecord[],
      sprintResults: raceSprintResults as unknown as SprintResultRow[],
      sprintPredictions: raceSprintPreds as unknown as SprintPredictionRecord[],
      existingScores: raceExistingScores as unknown as ScoreRecord[],
      mode: "auto_sync",
    });

    allScoreRows.push(...rows);
  }

  if (allScoreRows.length) {
    await supabaseAdmin.from("scores").upsert(allScoreRows, { onConflict: "user_id,race_id" });
  }
}

const OPENF1 = "https://api.openf1.org/v1";
const RACE_MIN_START_MS = 40 * 60 * 1000;
const RACE_MAX_DONE_MS = 180 * 60 * 1000;
const FALLBACK_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

type OF1Result = {
  position: number | null;
  driver_number: number;
  dnf?: boolean | undefined;
  dns?: boolean | undefined;
  dsq?: boolean | undefined;
};

async function openF1Fallback(officialRounds: Set<number>): Promise<Set<string>> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = Date.now();
  const finalized = new Set<string>();

  const { data: pending } = await supabaseAdmin
    .from("races")
    .select("id, round, race_at, qualifying_at")
    .eq("season", SEASON)
    .eq("has_results", false)
    .lte("race_at", new Date(now - RACE_MIN_START_MS).toISOString())
    .gte("race_at", new Date(now - FALLBACK_WINDOW_MS).toISOString());
  const races = (pending ?? []).filter((r) => !officialRounds.has(r.round));
  if (!races.length) return finalized;

  const { data: drivers } = await supabaseAdmin
    .from("drivers")
    .select("id, code, full_name, team, number");
  const lookup = buildDriverLookup((drivers ?? []) as DriverRef[]);
  const sessions = await getCachedOpenF1Sessions(SEASON);

  const near = (name: string, iso: string | null) => {
    if (!iso || !sessions.length) return undefined;
    const t = new Date(iso).getTime();
    return sessions.find(
      (s) =>
        s.session_name === name && Math.abs(new Date(s.date_start).getTime() - t) < 12 * 3600_000,
    );
  };

  // One query for every candidate race's cached qualifying classification
  // instead of one maybeSingle() per race (query count no longer grows with
  // the number of pending races).
  const fallbackRaceIds = races.map((r) => r.id);
  const { data: qSessions } = await supabaseAdmin
    .from("weekend_sessions")
    .select("race_id, classification")
    .eq("session_type", "qualifying")
    .in("race_id", fallbackRaceIds);
  const poleByRace = new Map<string, string>();
  for (const qSess of qSessions ?? []) {
    if (!Array.isArray(qSess.classification)) continue;
    const p1 = (
      qSess.classification as Array<{
        position?: number | undefined;
        driverId?: string | undefined;
        code?: string | undefined;
        name?: string | undefined;
        number?: number | undefined;
      }>
    ).find((r) => r.position === 1);
    if (!p1) continue;
    const d = resolveDriver(lookup, {
      driverId: p1.driverId,
      code: p1.code,
      name: p1.name,
      number: p1.number,
    });
    if (lookup.byId.has(d.id)) poleByRace.set(qSess.race_id, d.id);
  }

  const finalizeRows: Array<{
    race_id: string;
    driver_id: string;
    position: number | null;
    status: string;
    finished: boolean;
    fastest_lap: boolean;
    pole: boolean;
  }> = [];
  const finalizedRaceIds: string[] = [];

  for (const race of races) {
    const poleDriverId = poleByRace.get(race.id);
    const raceElapsedMs = now - new Date(race.race_at).getTime();
    let finalRows: Array<{
      race_id: string;
      driver_id: string;
      position: number | null;
      status: string;
      finished: boolean;
      fastest_lap: boolean;
      pole: boolean;
    }> = [];

    const rs = near("Race", race.race_at);
    if (rs) {
      const [rawResults, ofDrivers, laps, raceControl] = await Promise.all([
        getJson<OF1Result[]>(`${OPENF1}/session_result?session_key=${rs.session_key}`),
        getCachedOpenF1Drivers(rs.session_key),
        getJson<OpenF1LapEntry[]>(`${OPENF1}/laps?session_key=${rs.session_key}`),
        getJson<OpenF1RaceControlMessage[]>(`${OPENF1}/race_control?session_key=${rs.session_key}`),
      ]);
      const isFinished = hasChequeredFlag(raceControl) || raceElapsedMs >= RACE_MAX_DONE_MS;
      if (isFinished) {
        let results: OF1Result[] = Array.isArray(rawResults) ? rawResults : [];
        if (results.filter((r) => r.position != null).length < 10) {
          const positions = await getJson<OpenF1PositionEntry[]>(
            `${OPENF1}/position?session_key=${rs.session_key}`,
          );
          const synth = buildLiveOrderFromPositions(positions, laps, raceControl);
          if (synth.length >= 10) results = synth;
        }
        if (results.length >= 10) {
          const ofDrvByNum = new Map(ofDrivers.map((d) => [d.driver_number, d]));
          let flNum: number | undefined;
          let best = Infinity;
          for (const l of laps ?? []) {
            if (l.lap_duration && l.lap_duration > 0 && l.lap_duration < best) {
              best = l.lap_duration;
              flNum = l.driver_number;
            }
          }
          finalRows = results.flatMap((r) => {
            const ofMeta = ofDrvByNum.get(r.driver_number);
            const d = resolveDriver(lookup, {
              code: ofMeta?.name_acronym,
              name: ofMeta?.full_name,
              number: r.driver_number,
            });
            if (!lookup.byId.has(d.id)) return [];
            const finished = r.position != null && !r.dnf && !r.dns && !r.dsq;
            return [
              {
                race_id: race.id,
                driver_id: d.id,
                position: finished ? r.position : null,
                status: finished ? "Finished" : r.dsq ? "Disqualified" : "Retired",
                finished,
                fastest_lap: r.driver_number === flNum,
                pole: poleDriverId ? d.id === poleDriverId : false,
              },
            ];
          });
        }
      }
    }

    if (finalRows.length < 10) {
      const [f1Snap, espnSnap] = await Promise.all([
        fetchFromF1LiveTiming("race", race.race_at, lookup),
        fetchFromEspnScoreboard("race", race.race_at, lookup),
      ]);
      const chosen =
        f1Snap &&
        (f1Snap.chequeredFlag || raceElapsedMs >= RACE_MAX_DONE_MS) &&
        f1Snap.rows.length >= 10
          ? f1Snap
          : espnSnap &&
              (espnSnap.chequeredFlag || raceElapsedMs >= RACE_MAX_DONE_MS) &&
              espnSnap.rows.length >= 10
            ? espnSnap
            : null;
      if (chosen) {
        finalRows = chosen.rows
          .filter((r) => r.driverId && lookup.byId.has(r.driverId))
          .map((r) => {
            const finished = !r.status && r.position != null;
            return {
              race_id: race.id,
              driver_id: r.driverId!,
              position: finished ? r.position : null,
              status: finished ? "Finished" : "Retired",
              finished,
              fastest_lap: chosen.fastestLapDriverId
                ? r.driverId === chosen.fastestLapDriverId
                : false,
              pole: poleDriverId ? r.driverId === poleDriverId : false,
            };
          });
      }
    }

    if (finalRows.length >= 10) {
      finalizeRows.push(...finalRows);
      finalizedRaceIds.push(race.id);
      finalized.add(race.id);
    }
  }

  // Batched finalize writes: one upsert + one flag update for ALL finalized
  // races instead of two queries per race.
  if (finalizeRows.length) {
    await supabaseAdmin
      .from("race_results")
      .upsert(finalizeRows, { onConflict: "race_id,driver_id" });
    await supabaseAdmin.from("races").update({ has_results: true }).in("id", finalizedRaceIds);
  }
  return finalized;
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

async function syncSprintResults(roundToId: Map<number, string>, sprintTargetRounds: number[]) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const byRound = new Map<string, ErgastSprintRace>();
  if (!sprintTargetRounds.length) return;
  // Steady state: one small per-round request per sprint weekend in the target set
  const pages = await Promise.all(
    sprintTargetRounds.map((round) =>
      getJson<{
        MRData: { RaceTable: { Races: ErgastSprintRace[] } };
      }>(`${API}/${SEASON}/${round}/sprint/?format=json&limit=100`),
    ),
  );
  for (const page of pages) {
    for (const race of page?.MRData.RaceTable.Races ?? []) {
      const existing = byRound.get(race.round);
      if (existing)
        existing.SprintResults = [...(existing.SprintResults ?? []), ...(race.SprintResults ?? [])];
      else byRound.set(race.round, race);
    }
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
