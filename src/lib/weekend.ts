/** Shared (client + server safe) types and constants for the race-weekend screen. */

export type SessionType =
  "fp1" | "fp2" | "fp3" | "sprint_qualifying" | "sprint" | "qualifying" | "race";

export const SESSION_TYPES: SessionType[] = [
  "fp1",
  "fp2",
  "fp3",
  "sprint_qualifying",
  "sprint",
  "qualifying",
  "race",
];

export const SESSION_LABEL: Record<SessionType, string> = {
  fp1: "Practice 1",
  fp2: "Practice 2",
  fp3: "Practice 3",
  sprint_qualifying: "Sprint Qualifying",
  sprint: "Sprint",
  qualifying: "Qualifying",
  race: "Grand Prix",
};

/** Approximate length, used to tell "live" from "finished". */
export const SESSION_MINUTES: Record<SessionType, number> = {
  fp1: 60,
  fp2: 60,
  fp3: 60,
  sprint_qualifying: 45,
  sprint: 45,
  qualifying: 60,
  race: 120,
};

export function isSessionType(v: string): v is SessionType {
  return (SESSION_TYPES as string[]).includes(v);
}

export type ClassRow = {
  position: number | null;
  driverId: string | null;
  code: string | null;
  name: string | null;
  team: string | null;
  number: number | null;
  /** Best lap (practice), best qualifying lap, or race time. */
  time: string | null;
  q1: string | null;
  q2: string | null;
  q3: string | null;
  gap: string | null;
  laps: number | null;
  /** DNF / DNS / DSQ or the source's status text. */
  status: string | null;
};

export type SessionPayload = {
  state: "upcoming" | "live" | "pending" | "ready";
  startsAt: string | null;
  rows: ClassRow[];
};

export type ScheduleItem = { type: SessionType; startsAt: string };
