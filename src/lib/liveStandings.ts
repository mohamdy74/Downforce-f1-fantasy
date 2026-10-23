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
  category?: string | null;
  flag?: string | null;
  message?: string | null;
  date?: string | null;
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

export type VirtualLeaderboardEntry = LeaderboardEntry & {
  /** Base official points before the live/simulated round */
  officialPoints: number;
  /** Official rank (1-indexed) before the live/simulated round */
  officialRank: number;
  /** Live/virtual points earned in the active race round */
  liveRoundPoints: number;
  /** Rank movement vs official standings: positive = moved up, negative = moved down */
  liveRankDelta: number;
  /** Live breakdown for the active round */
  liveBreakdown: Record<string, unknown> | null;
};

/**
 * Pure <1ms client/server calculator for Live Virtual Standings during an active race.
 * Never mutates the database; merges official standings with real-time telemetry results.
 */
export function computeVirtualStandings(params: {
  officialBoard: LeaderboardEntry[];
  raceId: string;
  round: number;
  raceAt: string | null;
  profiles: ProfileRecord[];
  liveResults: ResultRow[];
  predictions: PredictionRecord[];
  sprintResults?: SprintResultRow[] | null;
  sprintPredictions?: SprintPredictionRecord[] | null;
  existingScores?: ScoreRecord[] | null;
}): VirtualLeaderboardEntry[] {
  const {
    officialBoard,
    raceId,
    round,
    raceAt,
    profiles,
    liveResults,
    predictions,
    sprintResults = null,
    sprintPredictions = null,
    existingScores = null,
  } = params;

  if (!officialBoard.length) return [];
  if (round < LEAGUE_START_ROUND || !liveResults.length) {
    return officialBoard.map((e, i) => ({
      ...e,
      officialPoints: e.points,
      officialRank: i + 1,
      liveRoundPoints: e.byRound[round] ?? 0,
      liveRankDelta: 0,
      liveBreakdown: null,
    }));
  }

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

  const liveRowByUser = new Map(builtRows.map((r) => [r.user_id, r]));

  const virtualEntries: VirtualLeaderboardEntry[] = officialBoard.map((entry, idx) => {
    const alreadyCountedPts = entry.byRound[round];
    const hasOfficialRoundScore = alreadyCountedPts !== undefined;
    const basePoints = hasOfficialRoundScore ? entry.points - alreadyCountedPts : entry.points;
    const baseRaces = hasOfficialRoundScore ? Math.max(0, entry.races - 1) : entry.races;

    const liveRow = liveRowByUser.get(entry.userId);
    const liveRoundPoints = liveRow ? liveRow.points : (alreadyCountedPts ?? 0);
    const totalPoints = basePoints + liveRoundPoints;
    const totalRaces = baseRaces + (liveRow || hasOfficialRoundScore ? 1 : 0);
    const nextByRound = { ...entry.byRound, [round]: liveRoundPoints };
    const nextBest =
      entry.best == null ? liveRoundPoints : Math.max(entry.best, liveRoundPoints);

    return {
      ...entry,
      points: totalPoints,
      races: totalRaces,
      best: nextBest,
      byRound: nextByRound,
      officialPoints: basePoints,
      officialRank: idx + 1,
      liveRoundPoints,
      liveRankDelta: 0,
      liveBreakdown: (liveRow?.breakdown as Record<string, unknown> | undefined) ?? null,
    };
  });

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