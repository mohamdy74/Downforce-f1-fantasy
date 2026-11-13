// Pure Telegram reminder + iCalendar helpers: no Supabase, no server-only
// imports, so both route handlers and any future caller can share them.

export type SessionType = "gp" | "sprint";
export type ReminderWindowKey = "24h" | "3h" | "30m";

export type ReminderWindow = {
  readonly key: ReminderWindowKey;
  readonly minMin: number;
  readonly maxMin: number;
  readonly label: string;
};

/** Inclusive bands, measured in whole minutes remaining until the lock. */
export const REMINDER_WINDOWS: readonly ReminderWindow[] = [
  { key: "24h", minMin: 1380, maxMin: 1440, label: "in about 24 hours" },
  { key: "3h", minMin: 150, maxMin: 180, label: "in about 3 hours" },
  { key: "30m", minMin: 5, maxMin: 30, label: "in under 30 minutes" },
];

export function activeWindowKey(minsLeft: number): ReminderWindowKey | null {
  for (const w of REMINDER_WINDOWS) {
    if (minsLeft >= w.minMin && minsLeft <= w.maxMin) return w.key;
  }
  return null;
}

export function windowLabel(key: ReminderWindowKey): string {
  return REMINDER_WINDOWS.find((w) => w.key === key)?.label ?? "";
}

export function sessionLabel(session: SessionType): string {
  return session === "sprint" ? "Sprint" : "Grand Prix";
}

export function buildReminderMessage(input: {
  raceName: string;
  session: SessionType;
  minsLeft: number;
}): string {
  const window = activeWindowKey(input.minsLeft);
  const when = window ? windowLabel(window) : "soon";
  const picks = input.session === "sprint" ? "top 8" : "top 10";
  return `${sessionLabel(input.session)} picks for ${input.raceName} lock ${when} — submit your ${picks} before the deadline or take the -25 penalty.`;
}

/** Inline keyboard so the reminder is one tap from the picks page. */
export function reminderKeyboard(appUrl: string) {
  return { inline_keyboard: [[{ text: "Make my picks", url: `${appUrl}/predict` }]] };
}

export type IcsRace = {
  id: string;
  round: number;
  name: string;
  circuit: string | null;
  locality: string | null;
  country: string | null;
  race_at: string;
  qualifying_at: string | null;
  has_sprint: boolean;
  sprint_at: string | null;
};

export function icsUtcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** RFC 5545 TEXT escaping. */
export function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

const encoder = new TextEncoder();
const OCTET_LIMIT = 75;
const FOLD_ROOM = 73; // continuation lines start with one space

/** RFC 5545 §3.1 line folding, measured in UTF-8 octets. */
function foldLine(line: string): string {
  if (encoder.encode(line).length <= OCTET_LIMIT) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const room = parts.length === 0 ? OCTET_LIMIT : FOLD_ROOM;
    if (bytes + size > room && current) {
      parts.push(current);
      current = ch;
      bytes = size;
    } else {
      current += ch;
      bytes += size;
    }
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

/**
 * Whole-season feed: every race of the season (past and future) gets its
 * events, so a fresh subscribe always shows the complete calendar. One VEVENT
 * per (race, session); UIDs are derived from the season/round/session so a
 * schedule refresh updates the same events in a subscriber's calendar instead
 * of duplicating them. Each event carries 1-hour and 30-minute alarms.
 */
export function buildCalendarIcs(input: {
  races: IcsRace[];
  season: number;
  appUrl: string;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const stamp = icsUtcStamp(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DOWNFORCE//Fantasy Racing League//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:DOWNFORCE F1 Fantasy",
    "X-WR-TIMEZONE:Africa/Cairo",
  ];

  for (const race of input.races) {
    const sessions: Array<{ type: SessionType; at: string }> = [{ type: "gp", at: race.race_at }];
    if (race.has_sprint && race.sprint_at) sessions.push({ type: "sprint", at: race.sprint_at });

    for (const session of sessions) {
      const start = new Date(session.at);
      // Every race of the season stays in the feed (only unparseable dates are
      // skipped), so a fresh subscribe shows the complete calendar.
      if (Number.isNaN(start.getTime())) continue;
      const end = new Date(start.getTime() + 30 * 60_000);
      const place = [race.circuit, race.locality, race.country].filter(Boolean).join(", ");
      const summary = icsEscape(
        `DOWNFORCE - ${race.name} - ${sessionLabel(session.type)} picks lock`,
      );
      const description = icsEscape(
        `${place ? `${place} - ` : ""}lock your picks: ${input.appUrl}/predict`,
      );
      lines.push(
        "BEGIN:VEVENT",
        `UID:downforce-${input.season}-r${race.round}-${session.type}@downforce`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsUtcStamp(start)}`,
        `DTEND:${icsUtcStamp(end)}`,
        `SUMMARY:${summary}`,
        `DESCRIPTION:${description}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT1H",
        "ACTION:DISPLAY",
        `DESCRIPTION:${summary}`,
        "END:VALARM",
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        `DESCRIPTION:${summary}`,
        "END:VALARM",
        "END:VEVENT",
      );
    }
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

