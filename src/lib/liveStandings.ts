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
  date_start?: string | null | undefined;
  is_pit_out_lap?: boolean | null | undefined;
};

export type SynthesizedOpenF1Result = {
  position: number | null;
  driver_number: number;
  duration: number | Array<number | null> | null;
  gap_to_leader: string | null;
  number_of_laps: number | null;
  dnf: boolean;
  dns: boolean;
  dsq: boolean;
};

/**
 * Detects whether the Chequered Flag or official Session End has been signaled
 * in OpenF1 `/v1/race_control` telemetry messages.
 */
export function hasChequeredFlag(messages: OpenF1RaceControlMessage[] | null | undefined): boolean {
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
 * Infers the [q1EndMs, q2EndMs] segment boundary timestamps for Qualifying or Sprint Qualifying
 * using:
 * 1) OpenF1 `/v1/race_control` CHEQUERED flag / session segment end events,
 * 2) Natural inter-segment track breaks (>= 4.5 min with zero flying laps started across all cars),
 * 3) Fallback standard session clock offsets from `sessionStartIso` (or first timed lap).
 */
export function inferQualifyingSegmentBounds(
  laps: OpenF1LapEntry[] | null | undefined,
  raceControl?: OpenF1RaceControlMessage[] | null | undefined,
  sessionStartIso?: string | null | undefined,
  isSprintQualifying = false,
): [number, number] | null {
  const timedLapStarts: number[] = [];
  for (const l of laps ?? []) {
    if (
      typeof l.lap_duration === "number" &&
      Number.isFinite(l.lap_duration) &&
      l.lap_duration > 20 &&
      l.lap_duration < 300 &&
      l.date_start
    ) {
      const ms = new Date(l.date_start).getTime();
      if (Number.isFinite(ms) && ms > 0) timedLapStarts.push(ms);
    }
  }
  timedLapStarts.sort((a, b) => a - b);

  // 1) Check race_control for Chequered Flag / Qualifying segment end messages
  const chequeredMs: number[] = [];
  for (const m of raceControl ?? []) {
    if (!m.date) continue;
    const ms = new Date(m.date).getTime();
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const flag = (m.flag ?? "").toUpperCase();
    const msg = (m.message ?? "").toUpperCase();
    const isCheq =
      flag === "CHEQUERED" ||
      flag === "CHECKERED" ||
      msg.includes("CHEQUERED FLAG") ||
      msg.includes("CHECKERED FLAG") ||
      /Q[123]\s+ENDED|SHOOTOUT.*ENDED/i.test(msg);
    if (isCheq) {
      const prev = chequeredMs[chequeredMs.length - 1];
      // Deduplicate consecutive messages within 6 minutes of the same segment end
      if (prev == null || ms - prev >= 6 * 60_000) {
        chequeredMs.push(ms);
      }
    }
  }

  if (chequeredMs.length >= 2) {
    // Allow 95s grace after Chequered Flag for cars finishing their flying lap started before 0:00
    return [chequeredMs[0]! + 95_000, chequeredMs[1]! + 95_000];
  }

  // 2) Detect natural inter-segment breaks (>= 4.5 minutes between flying lap starts)
  if (timedLapStarts.length >= 10) {
    const firstLapMs = timedLapStarts[0]!;
    const minQ1DurationMs = (isSprintQualifying ? 8 : 11) * 60_000;
    const minBreakMs = 4.2 * 60_000; // 4m12s minimum gap between Q1->Q2 and Q2->Q3 flying laps

    const breaks: Array<{ gapMs: number; afterLapMs: number; beforeLapMs: number }> = [];
    for (let i = 1; i < timedLapStarts.length; i++) {
      const prev = timedLapStarts[i - 1]!;
      const curr = timedLapStarts[i]!;
      const gap = curr - prev;
      if (gap >= minBreakMs && prev - firstLapMs >= minQ1DurationMs) {
        breaks.push({ gapMs: gap, afterLapMs: prev, beforeLapMs: curr });
      }
    }

    if (breaks.length >= 2) {
      // Take the first two valid inter-segment breaks
      const b1 = breaks[0]!;
      const b2 = breaks.find((b) => b.afterLapMs - b1.beforeLapMs >= 6 * 60_000) ?? breaks[1]!;
      return [
        Math.floor((b1.afterLapMs + b1.beforeLapMs) / 2),
        Math.floor((b2.afterLapMs + b2.beforeLapMs) / 2),
      ];
    }
    if (breaks.length === 1 && chequeredMs.length === 1) {
      const c1 = chequeredMs[0]! + 95_000;
      const b1 = Math.floor((breaks[0]!.afterLapMs + breaks[0]!.beforeLapMs) / 2);
      if (Math.abs(c1 - b1) >= 8 * 60_000) {
        return c1 < b1 ? [c1, b1] : [b1, c1];
      }
    }
    if (breaks.length === 1) {
      const b1 = Math.floor((breaks[0]!.afterLapMs + breaks[0]!.beforeLapMs) / 2);
      const q2WindowMs = (isSprintQualifying ? 16 : 22) * 60_000;
      return [b1, b1 + q2WindowMs];
    }
  }

  // 3) Fallback to session start clock offsets
  const anchorMs =
    (sessionStartIso ? new Date(sessionStartIso).getTime() : NaN) ||
    (timedLapStarts[0] ? timedLapStarts[0] - 2 * 60_000 : NaN);
  if (Number.isFinite(anchorMs) && anchorMs > 0) {
    const q1End = anchorMs + (isSprintQualifying ? 15 : 21) * 60_000;
    const q2End = anchorMs + (isSprintQualifying ? 30 : 44) * 60_000;
    return [q1End, q2End];
  }

  return null;
}

/**
 * Synthesizes a timed classification table for Practice (FP1/FP2/FP3) and Qualifying
 * (Sprint Qualifying / Qualifying) directly from `/v1/laps` (and optional `/v1/position`),
 * ranking drivers by their fastest `lap_duration` ascending (or Q3/Q2/Q1 progression)
 * and computing exact gaps to P1 plus `[q1, q2, q3]` splits for Qualifying.
 */
export function buildTimedSessionOrderFromLaps(
  laps: OpenF1LapEntry[] | null | undefined,
  positions?: OpenF1PositionEntry[] | null | undefined,
  options?:
    | {
        isQualifying?: boolean | undefined;
        isSprintQualifying?: boolean | undefined;
        sessionStartIso?: string | null | undefined;
        raceControl?: OpenF1RaceControlMessage[] | null | undefined;
      }
    | undefined,
): SynthesizedOpenF1Result[] {
  const isQualifying = Boolean(options?.isQualifying);
  const segBounds = isQualifying
    ? inferQualifyingSegmentBounds(
        laps,
        options?.raceControl,
        options?.sessionStartIso,
        Boolean(options?.isSprintQualifying),
      )
    : null;

  const maxLapByDriver = new Map<number, number>();
  const bestLapByDriver = new Map<number, number>();
  const q1ByDriver = new Map<number, number>();
  const q2ByDriver = new Map<number, number>();
  const q3ByDriver = new Map<number, number>();
  const allDriverNums = new Set<number>();

  for (const l of laps ?? []) {
    if (typeof l.driver_number !== "number" || l.driver_number <= 0) continue;
    allDriverNums.add(l.driver_number);
    if (
      typeof l.lap_number === "number" &&
      l.lap_number > (maxLapByDriver.get(l.driver_number) ?? 0)
    ) {
      maxLapByDriver.set(l.driver_number, l.lap_number);
    }
    if (
      typeof l.lap_duration === "number" &&
      Number.isFinite(l.lap_duration) &&
      l.lap_duration > 20 &&
      l.lap_duration < 300
    ) {
      const prev = bestLapByDriver.get(l.driver_number) ?? Infinity;
      if (l.lap_duration < prev) {
        bestLapByDriver.set(l.driver_number, l.lap_duration);
      }

      if (isQualifying) {
        const lapMs = l.date_start ? new Date(l.date_start).getTime() : NaN;
        if (segBounds && Number.isFinite(lapMs) && lapMs > 0) {
          const [q1End, q2End] = segBounds;
          if (lapMs <= q1End) {
            if (l.lap_duration < (q1ByDriver.get(l.driver_number) ?? Infinity)) {
              q1ByDriver.set(l.driver_number, l.lap_duration);
            }
          } else if (lapMs <= q2End) {
            if (l.lap_duration < (q2ByDriver.get(l.driver_number) ?? Infinity)) {
              q2ByDriver.set(l.driver_number, l.lap_duration);
            }
          } else {
            if (l.lap_duration < (q3ByDriver.get(l.driver_number) ?? Infinity)) {
              q3ByDriver.set(l.driver_number, l.lap_duration);
            }
          }
        } else {
          // No timestamp on lap: store in q1 so it still displays as a valid qualifying time
          if (l.lap_duration < (q1ByDriver.get(l.driver_number) ?? Infinity)) {
            q1ByDriver.set(l.driver_number, l.lap_duration);
          }
        }
      }
    }
  }

  // Keep only the latest position per driver from /v1/position
  const posHint = new Map<number, { position: number; dateMs: number; idx: number }>();
  if (Array.isArray(positions)) {
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i]!;
      if (typeof p.driver_number !== "number" || p.driver_number <= 0) continue;
      allDriverNums.add(p.driver_number);
      if (typeof p.position === "number" && p.position > 0) {
        const dateMs = p.date ? new Date(p.date).getTime() : 0;
        const prev = posHint.get(p.driver_number);
        if (!prev || (dateMs > 0 && dateMs >= prev.dateMs) || (dateMs === 0 && i >= prev.idx)) {
          posHint.set(p.driver_number, { position: p.position, dateMs, idx: i });
        }
      }
    }
  }

  if (allDriverNums.size === 0) return [];

  const sorted = [...allDriverNums].sort((a, b) => {
    if (isQualifying) {
      // If /v1/position has a full classification and we have segment splits,
      // sort by Q3 -> Q2 -> Q1 progression first, with posHint tie-breaking
      const q3a = q3ByDriver.get(a);
      const q3b = q3ByDriver.get(b);
      if (q3a != null || q3b != null) {
        if (q3a != null && q3b != null && q3a !== q3b) return q3a - q3b;
        if (q3a != null) return -1;
        if (q3b != null) return 1;
      }
      const q2a = q2ByDriver.get(a);
      const q2b = q2ByDriver.get(b);
      if (q2a != null || q2b != null) {
        if (q2a != null && q2b != null && q2a !== q2b) return q2a - q2b;
        if (q2a != null) return -1;
        if (q2b != null) return 1;
      }
      const q1a = q1ByDriver.get(a);
      const q1b = q1ByDriver.get(b);
      if (q1a != null || q1b != null) {
        if (q1a != null && q1b != null && q1a !== q1b) return q1a - q1b;
        if (q1a != null) return -1;
        if (q1b != null) return 1;
      }
    }

    const ba = bestLapByDriver.get(a) ?? Infinity;
    const bb = bestLapByDriver.get(b) ?? Infinity;
    if (ba !== bb) return ba - bb;
    const pa = posHint.get(a)?.position ?? 999;
    const pb = posHint.get(b)?.position ?? 999;
    if (pa !== pb) return pa - pb;
    const la = maxLapByDriver.get(a) ?? 0;
    const lb = maxLapByDriver.get(b) ?? 0;
    return lb - la || a - b;
  });

  const getDriverHeadlineSec = (num: number): number | null => {
    if (isQualifying) {
      return (
        q3ByDriver.get(num) ??
        q2ByDriver.get(num) ??
        q1ByDriver.get(num) ??
        bestLapByDriver.get(num) ??
        null
      );
    }
    return bestLapByDriver.get(num) ?? null;
  };

  const leaderBest = getDriverHeadlineSec(sorted[0]!) ?? null;

  return sorted.map((driver_number, idx) => {
    const headline = getDriverHeadlineSec(driver_number);
    const gap =
      idx > 0 && headline != null && leaderBest != null && headline > leaderBest
        ? `+${(headline - leaderBest).toFixed(3)}`
        : null;

    const q1 = q1ByDriver.get(driver_number) ?? (!isQualifying ? null : headline);
    const q2 = q2ByDriver.get(driver_number) ?? null;
    const q3 = q3ByDriver.get(driver_number) ?? null;

    return {
      position: idx + 1,
      driver_number,
      duration: isQualifying ? [q1, q2, q3] : headline,
      gap_to_leader: gap,
      number_of_laps: maxLapByDriver.get(driver_number) ?? null,
      dnf: false,
      dns: false,
      dsq: false,
    };
  });
}

/**
 * Synthesizes a live classification table from OpenF1 `/v1/position`, `/v1/laps`,
 * and `/v1/race_control` streams whenever `/v1/session_result` is not yet populated mid-race.
 * Also falls back to `/v1/laps` if `/v1/position` is empty or unavailable.
 */
export function buildLiveOrderFromPositions(
  positions: OpenF1PositionEntry[] | null | undefined,
  laps?: OpenF1LapEntry[] | null | undefined,
  raceControl?: OpenF1RaceControlMessage[] | null | undefined,
): SynthesizedOpenF1Result[] {
  const maxLapByDriver = new Map<number, number>();
  const bestLapByDriver = new Map<number, number>();
  const cumTimeByDriver = new Map<number, number>();

  for (const l of laps ?? []) {
    if (typeof l.driver_number !== "number" || l.driver_number <= 0) continue;
    if (
      typeof l.lap_number === "number" &&
      l.lap_number > (maxLapByDriver.get(l.driver_number) ?? 0)
    ) {
      maxLapByDriver.set(l.driver_number, l.lap_number);
    }
    if (typeof l.lap_duration === "number" && l.lap_duration > 0) {
      cumTimeByDriver.set(
        l.driver_number,
        (cumTimeByDriver.get(l.driver_number) ?? 0) + l.lap_duration,
      );
      if (l.lap_duration < (bestLapByDriver.get(l.driver_number) ?? Infinity)) {
        bestLapByDriver.set(l.driver_number, l.lap_duration);
      }
    }
  }

  const latestPos = new Map<number, { position: number; dateMs: number; idx: number }>();
  if (Array.isArray(positions)) {
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i]!;
      if (
        typeof p.driver_number !== "number" ||
        typeof p.position !== "number" ||
        p.position <= 0
      ) {
        continue;
      }
      const dateMs = p.date ? new Date(p.date).getTime() : 0;
      const prev = latestPos.get(p.driver_number);
      if (!prev || (dateMs > 0 && dateMs >= prev.dateMs) || (dateMs === 0 && i >= prev.idx)) {
        latestPos.set(p.driver_number, { position: p.position, dateMs, idx: i });
      }
    }
  }

  // Fallback if /v1/position is empty but /v1/laps has lap entries
  if (latestPos.size === 0 && maxLapByDriver.size > 0) {
    const byLaps = [...maxLapByDriver.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const ca = cumTimeByDriver.get(a[0]) ?? Infinity;
      const cb = cumTimeByDriver.get(b[0]) ?? Infinity;
      return ca - cb || a[0] - b[0];
    });
    byLaps.forEach(([num], i) => {
      latestPos.set(num, { position: i + 1, dateMs: 0, idx: i });
    });
  }

  if (latestPos.size === 0) return [];

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
      const totalPoints =
        hasLiveRow || hasOfficialRoundScore ? basePoints + liveRoundPoints : entry.points;
      const totalRaces = hasLiveRow || hasOfficialRoundScore ? baseRaces + 1 : entry.races;
      const newByRound = { ...entry.byRound, [round]: liveRoundPoints };
      const best = Math.max(entry.best ?? 0, liveRoundPoints);

      return {
        ...entry,
        points: totalPoints,
        races: totalRaces,
        best,
        byRound: newByRound,
        officialPoints: basePoints,
        officialRank: baseRankByUser.get(entry.userId) ?? idx + 1,
        liveRoundPoints,
        liveRankDelta: 0,
      };
    },
  );

  virtualEntries.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  return virtualEntries.map((v, newIdx) => {
    const newRank = newIdx + 1;
    const delta = v.officialRank - newRank;
    return {
      ...v,
      change: delta,
      liveRankDelta: delta,
    };
  });
}
