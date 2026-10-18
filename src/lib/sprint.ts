import type { Race } from "@/lib/queries";
import { toEpochMs } from "@/lib/queries";

/** The sprint tab stays visible until a day and a half after the Grand Prix starts. */
const GRACE_MS = 36 * 3600_000;

export function isSprintWeek(race: Race): boolean {
  return !!race.has_sprint && !!race.sprint_at;
}

/** The current/next race weekend, but only if it is a sprint weekend. */
export function sprintWeekend(races: Race[]): Race | null {
  const now = Date.now();
  const current = races.find((r) => toEpochMs(r.race_at) + GRACE_MS > now) ?? null;
  return current && isSprintWeek(current) ? current : null;
}

/** Sprint pole closes when sprint qualifying starts (or at the sprint if that time is unknown). */
export function sprintPoleLockAt(race: Race): string | null {
  return race.sprint_qualifying_at ?? race.sprint_at;
}
