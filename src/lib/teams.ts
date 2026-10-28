// Maps a constructor name to a CSS team-color token defined in styles.css.
// Order here is also the official display order used across the app.
const TEAMS: [RegExp, string, string][] = [
  [/ferrari/i, "--team-ferrari", "Ferrari"],
  [/mclaren/i, "--team-mclaren", "McLaren"],
  [/mercedes/i, "--team-mercedes", "Mercedes"],
  [/red bull/i, "--team-redbull", "Red Bull"],
  [/aston/i, "--team-aston", "Aston Martin"],
  [/williams/i, "--team-williams", "Williams"],
  [/alpine/i, "--team-alpine", "Alpine"],
  [/(rb f1|racing bulls|visa|^rb$)/i, "--team-rb", "Racing Bulls"],
  [/(sauber|audi|kick)/i, "--team-audi", "Audi"],
  [/haas/i, "--team-haas", "Haas F1 Team"],
  [/cadillac/i, "--team-cadillac", "Cadillac"],
];

function match(team: string | null | undefined) {
  return team ? TEAMS.find(([re]) => re.test(team)) : undefined;
}

export function teamColor(team: string | null | undefined): string {
  const hit = match(team);
  return `var(${hit ? hit[1] : "--color-muted-foreground"})`;
}

/** Canonical short label for a constructor, e.g. "Scuderia Ferrari" -> "Ferrari". */
export function teamLabel(team: string | null | undefined): string {
  return match(team)?.[2] ?? (team ?? "—");
}

export function teamRank(team: string | null | undefined): number {
  const hit = match(team);
  return hit ? TEAMS.indexOf(hit) : TEAMS.length;
}

/** Sorts drivers by official team order, then by driver number inside a team. */
export function sortByTeam<T extends { team: string | null; number: number | null }>(
  drivers: T[],
): T[] {
  return [...drivers].sort(
    (a, b) =>
      teamRank(a.team) - teamRank(b.team) ||
      (a.number ?? 999) - (b.number ?? 999),
  );
}

/** Teams present in a driver list, in official order. */
export function teamsOf<T extends { team: string | null; number: number | null }>(
  drivers: T[],
): string[] {
  const seen: string[] = [];
  for (const d of sortByTeam(drivers)) {
    const label = teamLabel(d.team);
    if (d.team && !seen.includes(label)) seen.push(label);
  }
  return seen;
}
