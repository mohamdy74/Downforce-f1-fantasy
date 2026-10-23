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
  category?: string | null | undefined;
  flag?: string | null | undefined;
  message?: string | null | undefined;
  date?: string | null | undefined;
};

export type OpenF1PositionEntry = {
  driver_number: number;
  position: number;
  date?: string | null | undefined;
};

export type OpenF1LapEntry = {
  driver_number: number;
  lap_number?: number | null | undefined;
  lap_duration?: number | null | undefined;
};

export type SynthesizedOpenF1Result = {
  position: number | null;
  driver_number: number;
  duration: number | null;
  gap_to_leader: string | null;
  number_of_laps: number | null;
  dnf: boolean;
  dns: boolean;
  dsq: boolean;
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

/**
 * Synthesizes a live classification table from OpenF1 `/v1/position`, `/v1/laps`,
 * and `/v1/race_control` streams whenever `/v1/session_result` is not yet populated mid-race.
 */
export function buildLiveOrderFromPositions(
  positions: OpenF1PositionEntry[] | null | undefined,
  laps?: OpenF1LapEntry[] | null | undefined,
  raceControl?: OpenF1RaceControlMessage[] | null | undefined,
): SynthesizedOpenF1Result[] {
  if (!Array.isArray(positions) || positions.length === 0) return [];

  const latestPos = new Map<number, { position: number; dateMs: number; idx: number }>();
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;
    if (typeof p.driver_number !== "number" || typeof p.position !== "number" || p.position <= 0) {
      continue;
    }
    const dateMs = p.date ? new Date(p.date).getTime() : 0;
    const prev = latestPos.get(p.driver_number);
    if (!prev || (dateMs > 0 && dateMs >= prev.dateMs) || (dateMs === 0 && i >= prev.idx)) {
      latestPos.set(p.driver_number, { position: p.position, dateMs, idx: i });
    }
  }

  if (latestPos.size === 0) return [];

  const maxLapByDriver = new Map<number, number>();
  const bestLapByDriver = new Map<number, number>();
  for (const l of laps ?? []) {
    if (typeof l.driver_number !== "number") continue;
    if (typeof l.lap_number === "number" && l.lap_number > (maxLapByDriver.get(l.driver_number) ?? 0)) {
      maxLapByDriver.set(l.driver_number, l.lap_number);
    }
    if (
      typeof l.lap_duration === "number" &&
      l.lap_duration > 0 &&
      l.lap_duration < (bestLapByDriver.get(l.driver_number) ?? Infinity)
    ) {
      bestLapByDriver.set(l.driver_number, l.lap_duration);
    }
  }

  const leaderMaxLap = Math.max(0, ...maxLapByDriver.values());

  const retiredNums = new Set<number>();
  for (const m of raceControl ?? []) {
    const msg = (m.message ?? "").toUpperCase();
    const match = msg.match(/\bCAR\s+(\d+)\b/);
    if (
      match &&
      (msg.includes("RETIRED") ||
        msg.includes("OUT OF THE RACE") ||
        msg.includes("STOPPED ON TRACK") ||
        msg.includes("WILL NOT RESUME"))
    ) {
      retiredNums.add(Number(match[1]));
    }
  }

  const sorted = [...latestPos.entries()].sort(
    (a, b) => a[1].position - b[1].position || a[0] - b[0],
  );

  return sorted.map(([driver_number, info], idx) => {
    const drvLaps = maxLapByDriver.get(driver_number) ?? null;
    const isLapsRetired =
      leaderMaxLap >= 6 && drvLaps != null && leaderMaxLap - drvLaps >= 4 && info.position >= 15;
    const dnf = retiredNums.has(driver_number) || isLapsRetired;
    return {
      position: idx + 1,
      driver_number,
      duration: bestLapByDriver.get(driver_number) ?? null,
      gap_to_leader: null,
      number_of_laps: drvLaps,
      dnf,
      dns: false,
      dsq: false,
    };
  });
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
};

/**
 * Pure <1ms client/server calculator for Live Virtual Standings during an active race.
 * Never mutates the database; merges official standings with real-time telemetry results
 * or server-precomputed round scores (including Sprint points and Steward overrides).
 */
export function computeVirtualStandings(params: {
  officialBoard: LeaderboardEntry[];
  raceId: string;
  round: number;
  raceAt: string | null;
  profiles?: ProfileRecord[] | undefined;
  liveResults?: ResultRow[] | undefined;
  predictions?: PredictionRecord[] | undefined;
  sprintResults?: SprintResultRow[] | null | undefined;
  sprintPredictions?: SprintPredictionRecord[] | null | undefined;
  existingScores?: ScoreRecord[] | null | undefined;
  precomputedScores?: Record<string, number> | null | undefined;
}): VirtualLeaderboardEntry[] {
  const {
    officialBoard,
    raceId,
    round,
    raceAt,
    profiles = [],
    liveResults = [],
    predictions = [],
    sprintResults = null,
    sprintPredictions = null,
    existingScores = null,
    precomputedScores = null,
  } = params;

  if (!officialBoard.length) return [];
  const hasPrecomputed = !!precomputedScores && Object.keys(precomputedScores).length > 0;
  if (round < LEAGUE_START_ROUND || (!hasPrecomputed && !liveResults.length)) {
    return officialBoard.map((e, i) => ({
      ...e,
      officialPoints: e.points,
      officialRank: i + 1,
      liveRoundPoints: e.byRound[round] ?? 0,
      liveRankDelta: 0,
    }));
  }

  const livePtsByUser = new Map<string, number>();

  if (hasPrecomputed) {
    for (const [uid, val] of Object.entries(precomputedScores!)) {
      if (typeof val === "number") {
        livePtsByUser.set(uid, val);
      } else if (val && typeof (val as { points?: unknown }).points === "number") {
        livePtsByUser.set(uid, (val as { points: number }).points);
      }
    }
  } else {
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
    for (const r of builtRows) {
      livePtsByUser.set(r.user_id, r.points);
    }
  }

  // Compute each player's base points prior to `round` so rank deltas are exact
  // both during an un-scored live race and when previewing on a completed round.
  const baseBoard = officialBoard.map((entry) => {
    const alreadyCountedPts = entry.byRound[round];
    const hasOfficialRoundScore = alreadyCountedPts !== undefined;
    const basePoints = hasOfficialRoundScore ? entry.points - alreadyCountedPts : entry.points;
    const baseRaces = hasOfficialRoundScore ? Math.max(0, entry.races - 1) : entry.races;
    return { entry, alreadyCountedPts, hasOfficialRoundScore, basePoints, baseRaces };
  });

  const baseOrder = [...baseBoard].sort(
    (a, b) => b.basePoints - a.basePoints || a.entry.name.localeCompare(b.entry.name),
  );
  const baseRankByUser = new Map(baseOrder.map((b, i) => [b.entry.userId, i + 1]));

  const virtualEntries: VirtualLeaderboardEntry[] = baseBoard.map(
    ({ entry, alreadyCountedPts, hasOfficialRoundScore, basePoints, baseRaces }, idx) => {
      const hasLiveRow = livePtsByUser.has(entry.userId);
      const liveRoundPoints = hasLiveRow
        ? livePtsByUser.get(entry.userId)!
        : (alreadyCountedPts ?? 0);
      const totalPoints = basePoints + liveRoundPoints;
      const totalRaces = baseRaces + (hasLiveRow || hasOfficialRoundScore ? 1 : 0);
      const nextByRound = { ...entry.byRound, [round]: liveRoundPoints };
      const otherRoundPts = Object.entries(entry.byRound)
        .filter(([r]) => Number(r) !== round)
        .map(([, pts]) => pts);
      const nextBest = Math.max(...otherRoundPts, liveRoundPoints);

      return {
        ...entry,
        points: totalPoints,
        races: totalRaces,
        best: nextBest,
        byRound: nextByRound,
        officialPoints: basePoints,
        officialRank: baseRankByUser.get(entry.userId) ?? idx + 1,
        liveRoundPoints,
        liveRankDelta: 0,
      };
    },
  );

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