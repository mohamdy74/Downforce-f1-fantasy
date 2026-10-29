/** Sprint scoring: 1 point per exact position in the sprint top 8 + 1 for sprint pole = 9 max. */
export const SPRINT_SLOTS = 8;
export const SPRINT_MAX_POINTS = SPRINT_SLOTS + 1;

export type SprintResultRow = {
  driver_id: string;
  position: number | null;
  finished: boolean;
  pole: boolean;
};

export type SprintPredictionInput = {
  top8: string[];
  pole_driver_id: string | null;
};

export type SprintBreakdown = {
  top8: number;
  pole: number;
  total: number;
};

export function scoreSprint(
  prediction: SprintPredictionInput | null,
  results: SprintResultRow[],
): SprintBreakdown {
  if (!prediction) return { top8: 0, pole: 0, total: 0 };

  const finishPosition = new Map<string, number>();
  for (const r of results) {
    if (r.finished && r.position != null) finishPosition.set(r.driver_id, r.position);
  }
  const poleDriver = results.find((r) => r.pole)?.driver_id ?? null;

  let top8 = 0;
  (prediction.top8 ?? []).slice(0, SPRINT_SLOTS).forEach((driverId, index) => {
    if (finishPosition.get(driverId) === index + 1) top8 += 1;
  });

  const pole = !!prediction.pole_driver_id && prediction.pole_driver_id === poleDriver ? 1 : 0;

  return { top8, pole, total: top8 + pole };
}
