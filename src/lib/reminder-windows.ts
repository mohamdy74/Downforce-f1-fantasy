// Pure reminder scheduling core — no Supabase, no server imports. Kept in a
// dedicated module so tests (and any future caller) can compute the exact
// reminder plan and payload copy without pulling in the f1-sync server graph.

export type ReminderTargetType = "pole" | "race";

export type ReminderWindow = {
  readonly label: "2h" | "30m";
  readonly minMs: number;
  readonly maxMs: number;
  readonly text: string;
};

/** Consolidated reminder bands: 2h = 45-135m ahead, 30m = 5-44m ahead. */
export const REMINDER_WINDOWS: readonly ReminderWindow[] = [
  { label: "2h", minMs: 45 * 60_000, maxMs: 135 * 60_000, text: "in ~2 hours" },
  { label: "30m", minMs: 5 * 60_000, maxMs: 44 * 60_000, text: "in less than 30 minutes" },
];

export type ReminderRace = {
  id: string;
  name: string;
  qualifying_at: string | null;
  race_at: string | null;
};

export type ReminderPlanEntry = {
  race: ReminderRace;
  type: ReminderTargetType;
  window: ReminderWindow;
};

/** For each upcoming race, which (target, window) bands are open at `now`. */
export function computeActiveReminders(races: ReminderRace[], now: number): ReminderPlanEntry[] {
  const entries: ReminderPlanEntry[] = [];
  for (const race of races) {
    const targets: Array<{ type: ReminderTargetType; iso: string | null }> = [
      { type: "pole", iso: race.qualifying_at },
      { type: "race", iso: race.race_at },
    ];

    for (const t of targets) {
      if (!t.iso) continue;
      const diff = new Date(t.iso).getTime() - now;
      for (const window of REMINDER_WINDOWS) {
        if (diff < window.minMs || diff > window.maxMs) continue;
        entries.push({ race, type: t.type, window });
      }
    }
  }
  return entries;
}

/** Push payload for one plan entry — "Final Call!" only for the race 30m band. */
export function buildReminderPayload(entry: ReminderPlanEntry) {
  const { race, type: t, window: w } = entry;
  return {
    title:
      t === "race" && w.label === "30m"
        ? `\u{1F6A8} ${race.name} \u2014 Final Call!`
        : `\u23F0 ${race.name} \u2014 Lock Alert!`,
    body:
      t === "pole"
        ? `Qualifying starts ${w.text}! Lock in your Pole Position pick now.`
        : w.label === "30m"
          ? `Final call! Race locks ${w.text} \u2014 lock in your Top 10 now before the \u221225 penalty!`
          : `Race locks ${w.text}! You haven't submitted your picks \u2014 lock in your Top 10 now to avoid the \u221225 penalty.`,
    tag: `downforce-${race.id}-${t}-${w.label}`,
    url: "/predict",
  };
}
