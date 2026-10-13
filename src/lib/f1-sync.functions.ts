import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import type { Json } from "@/integrations/supabase/types";
import { NO_SUBMISSION_PENALTY, scorePrediction, type ResultRow } from "./scoring";
import { scoreSprint, type SprintResultRow } from "./sprintScoring";

const API = "https://api.jolpi.ca/ergast/f1";
const SEASON = 2026;
const STALE_MS = 2 * 60 * 1000;
// Drivers the league removed from its data entirely (kept inactive in the DB).
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

function toIso(session: { date: string; time?: string | undefined } | undefined): string | null {
  if (!session?.date) return null;
  return new Date(`${session.date}T${session.time ?? "12:00:00Z"}`).toISOString();
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Rate limiting: in-memory store for user sync calls
const userSyncCalls = new Map<string, number>();

export const syncF1Data = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ({ force: !!(input as { force?: boolean } | null)?.force }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Rate limiting: 5 minutes between sync requests per user
    const userId = context.userId;
    const lastCall = userSyncCalls.get(userId) ?? 0;
    const minInterval = data.force ? 15_000 : 2 * 60_000;

    if (Date.now() - lastCall < minInterval) {
      throw new Error("Rate limit: Wait 5 minutes between sync requests.");
    }
    userSyncCalls.set(userId, Date.now());

    const { data: state } = await supabaseAdmin
      .from("sync_state")
      .select("synced_at")
      .eq("key", `season-${SEASON}`)
      .maybeSingle();

    if (!data.force && state?.synced_at) {
      const age = Date.now() - new Date(state.synced_at).getTime();
      if (age < STALE_MS) return { skipped: true as const };
    }

    // ---- Calendar ----
    const calendar = await getJson<{
      MRData: { RaceTable: { Races: ErgastRace[] } };
    }>(`${API}/${SEASON}/races/?format=json&limit=40`);
    const races = calendar?.MRData.RaceTable.Races ?? [];

    if (races.length) {
      await supabaseAdmin.from("races").upsert(
        races.map((r) => ({
          season: Number(r.season),
          round: Number(r.round),
          name: r.raceName,
          circuit: r.Circuit.circuitName,
          country: r.Circuit.Location.country ?? null,
          locality: r.Circuit.Location.locality ?? null,
          race_at: toIso({ date: r.date, time: r.time })!,
          qualifying_at: toIso(r.Qualifying),
          has_sprint: !!r.Sprint,
          sprint_at: toIso(r.Sprint),
          sprint_qualifying_at: toIso(r.SprintQualifying ?? r.SprintShootout),
        })),
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

    // ---- Results (the API caps each page at 100 result rows, so page through) ----
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
        const finished = /finished|lapped|\+\d+ lap/i.test(status);
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

    // ---- Sprint results ----
    await syncSprintResults(roundToId);

    // ---- Fast fallback: official source still empty after the race → use live timing ----
    await openF1Fallback(new Set(racesWithResults.map((r) => Number(r.round))));

    await scoreAllRaces();


    await supabaseAdmin
      .from("sync_state")
      .upsert(
        { key: `season-${SEASON}`, synced_at: new Date().toISOString() },
        { onConflict: "key" },
      );

    return { skipped: false as const, races: races.length, scored: racesWithResults.length };
  });

async function scoreAllRaces() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: races } = await supabaseAdmin
    .from("races")
    .select("id, race_at")
    .eq("season", SEASON)
    .eq("has_results", true);
  if (!races?.length) return;

  const { data: allProfiles } = await supabaseAdmin.from("profiles").select("id, created_at"); for (const race of races) { const profiles = (allProfiles ?? []).filter((p) => new Date(p.created_at) < new Date(race.race_at));
    if (!profiles?.length) continue;
    const { data: results } = await supabaseAdmin
      .from("race_results")
      .select("driver_id, position, finished, fastest_lap, pole")
      .eq("race_id", race.id);
    if (!results?.length) continue;

    const { data: predictions } = await supabaseAdmin
      .from("predictions")
      .select("user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id")
      .eq("race_id", race.id);

    const byUser = new Map((predictions ?? []).map((p) => [p.user_id, p]));

    // Sprint points (top 8 + sprint pole, max 9) are added to the round once the sprint has results.
    const { data: sprintResults } = await supabaseAdmin
      .from("sprint_results")
      .select("driver_id, position, finished, pole")
      .eq("race_id", race.id);
    const { data: sprintPreds } = await supabaseAdmin
      .from("sprint_predictions")
      .select("user_id, top8, pole_driver_id")
      .eq("race_id", race.id);
    const sprintByUser = new Map((sprintPreds ?? []).map((p) => [p.user_id, p]));
    const sprintFor = (userId: string) =>
      sprintResults?.length
        ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults as SprintResultRow[])
        : null;
    const rows: Array<{
      user_id: string;
      race_id: string;
      points: number;
      breakdown: Json;
      updated_at: string;
    }> = [];

    for (const profile of profiles) {
      // Players who joined after the race started are not penalised.
      if (new Date(profile.created_at) > new Date(race.race_at)) continue;

      const sprint = sprintFor(profile.id);
      const prediction = byUser.get(profile.id);
      if (!prediction) {
        rows.push({
          user_id: profile.id,
          race_id: race.id,
          points: NO_SUBMISSION_PENALTY + (sprint?.total ?? 0),
          breakdown: {
            noSubmission: true,
            ...(sprint ? { sprint } : {}),
            total: NO_SUBMISSION_PENALTY + (sprint?.total ?? 0),
          },
          updated_at: new Date().toISOString(),
        });
        continue;
      }

      const breakdown = scorePrediction(
        {
          top10: prediction.top10 ?? [],
          pole_driver_id: prediction.pole_driver_id,
          fastest_lap_driver_id: prediction.fastest_lap_driver_id,
          dnf_driver_id: prediction.dnf_driver_id,
        },
        results as ResultRow[],
      );

      // A pole-only save (top 10 never completed) still counts as a missed race
      // submission — the pole points are kept on top of the penalty.
      const poleOnly = (prediction.top10 ?? []).filter((d) => d && d !== "__none__").length < 10;
      const raceTotal = poleOnly ? NO_SUBMISSION_PENALTY + breakdown.pole : breakdown.total;
      const total = raceTotal + (sprint?.total ?? 0);
      rows.push({
        user_id: profile.id,
        race_id: race.id,
        points: total,
        breakdown: poleOnly
          ? { noSubmission: true, poleOnly: true, pole: breakdown.pole, ...(sprint ? { sprint } : {}), total }
          : { ...breakdown, ...(sprint ? { sprint } : {}), total },
        updated_at: new Date().toISOString(),
      });
    }

    if (rows.length) {
      await supabaseAdmin.from("scores").upsert(rows, { onConflict: "user_id,race_id" });
    }
  }
}

const OPENF1 = "https://api.openf1.org/v1";
const RACE_DONE_MS = 80 * 60 * 1000; // race start + 80m ≈ chequered flag
const FALLBACK_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

type OF1Session = { session_key: number; session_name: string; date_start: string };
type OF1Result = { position: number | null; driver_number: number; dnf?: boolean; dns?: boolean; dsq?: boolean };

/**
 * When the official results feed hasn't published a finished race yet, fill
 * race_results from OpenF1 so scoring happens minutes after the flag. The
 * official feed overwrites these rows (same keys) once it publishes.
 */
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
  SprintResults?: Array<{
    position: string;
    grid: string;
    status: string;
    Driver: { driverId: string };
  }>;
};

/** Official sprint results. A grid of 1 means the driver took sprint pole. */
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
      const finished = /finished|lapped|\+\d+ lap/i.test(status);
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
