import { NO_SUBMISSION_PENALTY, scorePrediction, type ResultRow } from "./scoring";
import { scoreSprint, type SprintResultRow } from "./sprintScoring";
import type { Json } from "@/integrations/supabase/types";

export type ProfileRecord = {
  id: string;
  created_at: string;
};

export type PredictionRecord = {
  user_id: string;
  top10: string[];
  pole_driver_id: string | null;
  fastest_lap_driver_id: string | null;
  dnf_driver_id: string | null;
};

export type SprintPredictionRecord = {
  user_id: string;
  top8: string[];
  pole_driver_id: string | null;
};

export type ScoreRecord = {
  user_id: string;
  breakdown: unknown;
};

export type ScoreUpsertRow = {
  user_id: string;
  race_id: string;
  points: number;
  breakdown: Json;
  updated_at: string;
};

export function filterValidDriverIds(ids: string[] | null | undefined): string[] {
  return (ids ?? []).filter((x) => Boolean(x && x !== "__none__"));
}

export function extractStewardLockedUsers(
  existingScores: ScoreRecord[] | null | undefined,
): Set<string> {
  return new Set(
    (existingScores ?? [])
      .filter((s) => {
        const b = s.breakdown as Record<string, unknown> | null;
        return b && typeof b === "object" && b["stewardOverride"] === true;
      })
      .map((s) => s.user_id),
  );
}

/**
 * Unified race scoring calculator used by both automatic F1 sync (`auto_sync`)
 * and Steward manual result entry (`manual_results`).
 */
export function buildRaceScoreRows(params: {
  raceId: string;
  raceAt: string | null;
  profiles: ProfileRecord[];
  results: ResultRow[];
  predictions: PredictionRecord[];
  sprintResults?: SprintResultRow[] | null | undefined;
  sprintPredictions?: SprintPredictionRecord[] | null | undefined;
  existingScores?: ScoreRecord[] | null | undefined;
  mode: "auto_sync" | "manual_results";
  manualPoleWinner?: string | null | undefined;
}): ScoreUpsertRow[] {
  const {
    raceId,
    raceAt,
    profiles,
    results,
    predictions,
    sprintResults,
    sprintPredictions,
    existingScores,
    mode,
    manualPoleWinner,
  } = params;

  const stewardLockedUsers = extractStewardLockedUsers(existingScores);
  const byUser = new Map(predictions.map((p) => [p.user_id, p]));
  const sprintByUser = new Map((sprintPredictions ?? []).map((p) => [p.user_id, p]));
  const sprintFor = (userId: string) =>
    sprintResults?.length ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults) : null;

  const nowIso = new Date().toISOString();
  const rows: ScoreUpsertRow[] = [];

  for (const profile of profiles) {
    if (stewardLockedUsers.has(profile.id)) continue;
    if (raceAt && new Date(profile.created_at) > new Date(raceAt)) continue;

    const sprint = sprintFor(profile.id);
    const prediction = byUser.get(profile.id);

    if (mode === "auto_sync") {
      if (!prediction) {
        const total = NO_SUBMISSION_PENALTY + (sprint?.total ?? 0);
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: {
            noSubmission: true,
            ...(sprint ? { sprint } : {}),
            total,
          } as unknown as Json,
          updated_at: nowIso,
        });
        continue;
      }

      const validTop10 = filterValidDriverIds(prediction.top10);
      const breakdown = scorePrediction(
        {
          top10: validTop10,
          pole_driver_id: prediction.pole_driver_id,
          fastest_lap_driver_id: prediction.fastest_lap_driver_id,
          dnf_driver_id: prediction.dnf_driver_id,
        },
        results,
      );

      if (validTop10.length < 10) {
        const total = NO_SUBMISSION_PENALTY + breakdown.pole + (sprint?.total ?? 0);
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: {
            ...breakdown,
            top10: 0,
            fastestLap: 0,
            dnf: 0,
            perfect: 0,
            perfectTop10: false,
            perfectWeekend: false,
            noSubmission: true,
            ...(sprint ? { sprint } : {}),
            total,
          } as unknown as Json,
          updated_at: nowIso,
        });
        continue;
      }

      const total = breakdown.total + (sprint?.total ?? 0);
      rows.push({
        user_id: profile.id,
        race_id: raceId,
        points: total,
        breakdown: {
          ...breakdown,
          ...(sprint ? { sprint } : {}),
          total,
        } as unknown as Json,
        updated_at: nowIso,
      });
    } else {
      const validTop10 = filterValidDriverIds(prediction?.top10);
      if (!prediction || validTop10.length < 10) {
        const polePts =
          prediction?.pole_driver_id &&
          manualPoleWinner &&
          prediction.pole_driver_id === manualPoleWinner
            ? 3
            : 0;
        const total = NO_SUBMISSION_PENALTY + polePts + (sprint?.total ?? 0);
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: {
            noSubmission: true,
            top10: 0,
            pole: polePts,
            fastestLap: 0,
            dnf: 0,
            perfect: 0,
            ...(sprint ? { sprint } : {}),
            total,
          } as unknown as Json,
          updated_at: nowIso,
        });
      } else {
        const breakdown = scorePrediction(
          {
            top10: validTop10,
            pole_driver_id: prediction.pole_driver_id,
            fastest_lap_driver_id: prediction.fastest_lap_driver_id,
            dnf_driver_id: prediction.dnf_driver_id,
          },
          results,
        );
        const total = breakdown.total + (sprint?.total ?? 0);
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: {
            ...breakdown,
            ...(sprint ? { sprint } : {}),
            total,
          } as unknown as Json,
          updated_at: nowIso,
        });
      }
    }
  }

  return rows;
}
