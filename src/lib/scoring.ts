export const POSITION_POINTS: Record<number, number> = {
  0: 3,
  1: 2,
  2: 1,
  3: -1,
  4: -2,
};

export const NO_SUBMISSION_PENALTY = -25;

export function positionPoints(diff: number): number {
  return diff in POSITION_POINTS ? POSITION_POINTS[diff]! : -3;
}

export type ResultRow = {
  driver_id: string;
  position: number | null;
  finished: boolean;
  fastest_lap: boolean;
  pole: boolean;
};

export type PredictionInput = {
  top10: string[];
  pole_driver_id: string | null;
  fastest_lap_driver_id: string | null;
  dnf_driver_id: string | null;
};

export type Breakdown = {
  top10: number;
  pole: number;
  fastestLap: number;
  dnf: number;
  perfect: number;
  perfectTop10: boolean;
  perfectWeekend: boolean;
  total: number;
};

export function scorePrediction(prediction: PredictionInput, results: ResultRow[]): Breakdown {
  const finishPosition = new Map<string, number>();
  for (const r of results) {
    if (r.finished && r.position != null) finishPosition.set(r.driver_id, r.position);
  }
  const poleDriver = results.find((r) => r.pole)?.driver_id ?? null;
  const fastestLapDriver = results.find((r) => r.fastest_lap)?.driver_id ?? null;
  const dnfDrivers = new Set(results.filter((r) => !r.finished).map((r) => r.driver_id));

  let top10 = 0;
  let exactCount = 0;
  prediction.top10.slice(0, 10).forEach((driverId, index) => {
    const predicted = index + 1;
    const actual = finishPosition.get(driverId);
    const diff = actual == null ? 99 : Math.abs(actual - predicted);
    if (diff === 0) exactCount += 1;
    top10 += positionPoints(diff);
  });

  const poleCorrect = !!prediction.pole_driver_id && prediction.pole_driver_id === poleDriver;
  const flCorrect =
    !!prediction.fastest_lap_driver_id && prediction.fastest_lap_driver_id === fastestLapDriver;
  const dnfCorrect = !!prediction.dnf_driver_id && dnfDrivers.has(prediction.dnf_driver_id);

  const pole = poleCorrect ? 3 : 0;
  const fastestLap = flCorrect ? 3 : 0;
  const dnf = dnfCorrect ? 1 : 0;

  const perfectTop10 = prediction.top10.length === 10 && exactCount === 10;
  const perfectWeekend = perfectTop10 && poleCorrect && flCorrect && dnfCorrect;
  const perfect = perfectWeekend ? 15 : perfectTop10 ? 10 : 0;

  const total = top10 + pole + fastestLap + dnf + perfect;
  return { top10, pole, fastestLap, dnf, perfect, perfectTop10, perfectWeekend, total };
}
