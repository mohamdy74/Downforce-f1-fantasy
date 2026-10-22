import type { Json } from "@/integrations/supabase/types";
import { NO_SUBMISSION_PENALTY, scorePrediction, type ResultRow } from "./scoring";
import { scoreSprint, type SprintResultRow } from "./sprintScoring";

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
  breakdown: Json;
};

export type BuiltScoreRow = {
  user_id: string;
  race_id: string;
  points: number;
  breakdown: Json;
  updated_at: string;
};

/**
 * Single source of truth for round race-scoring across auto-sync and stewards manual entry.
 * Preserves the exact breakdown contracts:
 * - auto_sync sets `poleOnly: true` on incomplete top10 rows
 * - manual_results omits `poleOnly: true` on incomplete top10 rows
 * - both respect stewardOverride lock and skip post-race registrations
 */
export function buildRaceScoreRows(params: {
  raceId: string;
  raceAt: string | null;
  profiles: ProfileRecord[];
  results: ResultRow[];
  predictions: PredictionRecord[];
  sprintResults: SprintResultRow[] | null;
  sprintPredictions: SprintPredictionRecord[] | null;
  existingScores: ScoreRecord[] | null;
  mode: "auto_sync" | "manual_results";
  manualPoleWinner?: string | null;
}): BuiltScoreRow[] {
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

  if (!profiles.length || !results.length) return [];

  // Identify scores protected by FIA Stewards (never overwrite)
  const stewardLockedUsers = new Set(
    (existingScores ?? [])
      .filter((s) => {
        const b = s.breakdown as Record<string, unknown> | null;
        return b && b["stewardOverride"] === true;
      })
      .map((s) => s.user_id),
  );

  const byUser = new Map(predictions.map((p) => [p.user_id, p]));
  const sprintByUser = new Map((sprintPredictions ?? []).map((p) => [p.user_id, p]));

  const sprintFor = (userId: string) =>
    sprintResults?.length
      ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults)
      : null;

  const rows: BuiltScoreRow[] = [];
  const nowIso = new Date().toISOString();

  for (const profile of profiles) {
    if (stewardLockedUsers.has(profile.id)) continue;
    if (raceAt && new Date(profile.created_at) > new Date(raceAt)) continue;

    const sprint = sprintFor(profile.id);
    const sprintTotal = sprint?.total ?? 0;
    const pr = byUser.get(profile.id);
    const validTop10 = (pr?.top10 ?? []).filter((x) => x && x !== "__none__");

    if (!pr || validTop10.length < 10) {
      if (!pr) {
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: NO_SUBMISSION_PENALTY + sprintTotal,
          breakdown: {
            noSubmission: true,
            ...(sprint ? { sprint } : {}),
            total: NO_SUBMISSION_PENALTY + sprintTotal,
          },
          updated_at: nowIso,
        });
      } else {
        const poleHit =
          mode === "manual_results"
            ? pr.pole_driver_id && pr.pole_driver_id === manualPoleWinner
              ? 3
              : 0
            : scorePrediction(
                {
                  top10: validTop10,
                  pole_driver_id: pr.pole_driver_id,
                  fastest_lap_driver_id: pr.fastest_lap_driver_id,
                  dnf_driver_id: pr.dnf_driver_id,
                },
                results,
              ).pole;

        const total = NO_SUBMISSION_PENALTY + poleHit + sprintTotal;
        const breakdownObj =
          mode === "auto_sync"
            ? {
                noSubmission: true,
                poleOnly: true,
                pole: poleHit,
                ...(sprint ? { sprint } : {}),
                total,
              }
            : {
                noSubmission: true,
                pole: poleHit,
                ...(sprint ? { sprint } : {}),
                total,
              };

        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: breakdownObj,
          updated_at: nowIso,
        });
      }
      continue;
    }

    const b = scorePrediction(
      {
        top10: validTop10,
        pole_driver_id: pr.pole_driver_id,
        fastest_lap_driver_id: pr.fastest_lap_driver_id,
        dnf_driver_id: pr.dnf_driver_id,
      },
      results,
    );

    const total = b.total + sprintTotal;
    rows.push({
      user_id: profile.id,
      race_id: raceId,
      points: total,
      breakdown: { ...b, ...(sprint ? { sprint } : {}), total },
      updated_at: nowIso,
    });
  }

  return rows;
}