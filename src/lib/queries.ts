import { queryOptions } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

export const SEASON = 2026;
/** Official league start: Round 14 (Spanish Grand Prix) */
export const LEAGUE_START_ROUND = 14;

let clockOffsetMs = 0;
let clockSynced = false;

export async function syncServerClock(): Promise<void> {
  if (clockSynced || typeof window === "undefined") return;
  clockSynced = true;
  try {
    const t0 = Date.now();
    const res = await fetch(window.location.origin, { method: "HEAD", cache: "no-store" });
    const dateHdr = res.headers.get("Date");
    if (dateHdr) {
      const serverMs = new Date(dateHdr).getTime();
      const rtt = Date.now() - t0;
      if (!Number.isNaN(serverMs)) {
        clockOffsetMs = serverMs + rtt / 2 - Date.now();
      }
    }
  } catch {
    // Fallback to device clock
  }
}

export function getTrustedNow(): number {
  return Date.now() + clockOffsetMs;
}

export type Race = {
  id: string;
  season: number;
  round: number;
  name: string;
  circuit: string | null;
  country: string | null;
  locality: string | null;
  race_at: string;
  qualifying_at: string | null;
  has_results: boolean;
  has_sprint: boolean;
  sprint_qualifying_at: string | null;
  sprint_at: string | null;
};

export type Driver = {
  id: string;
  code: string | null;
  full_name: string;
  team: string | null;
  number: number | null;
};

export const racesQuery = queryOptions({
  queryKey: ["races", SEASON],
  staleTime: 15 * 60_000,
  gcTime: 30 * 60_000,
  queryFn: async (): Promise<Race[]> => {
    void syncServerClock();
    const { data, error } = await supabase
      .from("races")
      .select("*")
      .eq("season", SEASON)
      .order("round");
    if (error) throw error;
    return ((data ?? []) as Race[]).map((r) => ({
      ...r,
      // Only treat rounds from R14 (Spanish GP) onwards as scored league rounds
      has_results: r.round >= LEAGUE_START_ROUND ? r.has_results : false,
    }));
  },
});

export const driversQuery = queryOptions({
  queryKey: ["drivers"],
  staleTime: 30 * 60_000,
  gcTime: 60 * 60_000,
  queryFn: async (): Promise<Driver[]> => {
    const { data, error } = await supabase
      .from("drivers")
      .select("id, code, full_name, team, number")
      .eq("active", true)
      .order("full_name");
    if (error) throw error;
    return data as Driver[];
  },
});

export type LeaderboardEntry = {
  userId: string;
  name: string;
  avatar: string | null;
  points: number;
  races: number;
  best: number | null;
  change: number | null;
  byRound: Record<number, number>;
  fahl: boolean;
};

export function computeLeaderboardEntries(
  profiles: Array<{ id: string; display_name: string; avatar_url: string | null }>,
  scores: Array<{ user_id: string; race_id: string; points: number }>,
  raceRows: Array<{ id: string; round: number }>,
): LeaderboardEntry[] {
  const rMap = new Map(raceRows.map((r) => [r.id, r.round]));

  // Identify rounds >= 14 that actually have non-zero scores (ignore all-zero placeholder rounds)
  const activeRounds = new Set<number>();
  for (const s of scores) {
    const rd = rMap.get(s.race_id);
    if (rd != null && rd >= LEAGUE_START_ROUND && s.points !== 0) {
      activeRounds.add(rd);
    }
  }

  const byUser = new Map<string, LeaderboardEntry>();
  for (const p of profiles) {
    byUser.set(p.id, {
      userId: p.id,
      name: p.display_name,
      avatar: p.avatar_url,
      points: 0,
      races: 0,
      best: null,
      change: null,
      byRound: {},
      fahl: false,
    });
  }

  let latestRound = 0;
  for (const s of scores) {
    const entry = byUser.get(s.user_id);
    const rd = rMap.get(s.race_id);
    if (!entry || rd == null || !activeRounds.has(rd)) continue;
    entry.points += s.points;
    entry.races += 1;
    entry.best = entry.best == null ? s.points : Math.max(entry.best, s.points);
    entry.byRound[rd] = s.points;
    if (rd > latestRound) latestRound = rd;
  }

  if (latestRound > 0) {
    const top = Math.max(...[...byUser.values()].map((e) => e.byRound[latestRound] ?? -Infinity));
    for (const e of byUser.values()) {
      if (e.byRound[latestRound] === top) e.fahl = true;
    }
  }

  const sort = (a: LeaderboardEntry, b: LeaderboardEntry) =>
    b.points - a.points || a.name.localeCompare(b.name);
  const list = [...byUser.values()].sort(sort);

  // Rank movement vs. standings before the latest scored race
  if (latestRound > 0) {
    const prevPts = new Map<string, number>();
    for (const s of scores) {
      const rd = rMap.get(s.race_id);
      if (rd == null || !activeRounds.has(rd) || rd === latestRound) continue;
      prevPts.set(s.user_id, (prevPts.get(s.user_id) ?? 0) + s.points);
    }
    const prev = [...list].sort(
      (a, b) =>
        (prevPts.get(b.userId) ?? 0) - (prevPts.get(a.userId) ?? 0) ||
        a.name.localeCompare(b.name),
    );
    const prevRank = new Map(prev.map((e, i) => [e.userId, i]));
    list.forEach((e, i) => (e.change = (prevRank.get(e.userId) ?? i) - i));
  }
  return list;
}

export const leaderboardQuery = queryOptions({
  queryKey: ["leaderboard", SEASON],
  staleTime: 2 * 60_000,
  queryFn: async (): Promise<LeaderboardEntry[]> => {
    const { data: sData } = await supabase.auth.getSession();
    if (!sData.session) return [];

    const [
      { data: scores, error: sErr },
      { data: profiles, error: pErr },
      { data: raceRows, error: rErr },
    ] = await Promise.all([
      supabase.from("scores").select("user_id, race_id, points").limit(50000),
      supabase.from("profiles").select("id, display_name, avatar_url").limit(10000),
      supabase.from("races").select("id, round").eq("season", SEASON).gte("round", LEAGUE_START_ROUND),
    ]);
    if (sErr) throw sErr;
    if (pErr) throw pErr;
    if (rErr) throw rErr;

    return computeLeaderboardEntries(profiles ?? [], scores ?? [], raceRows ?? []);
  },
});

export function nextRace(races: Race[]): Race | null {
  const now = getTrustedNow();
  return races.find((r) => new Date(r.race_at).getTime() > now) ?? null;
}

export function lastRace(races: Race[]): Race | null {
  const done = races.filter((r) => r.has_results && r.round >= LEAGUE_START_ROUND);
  return done.length ? done[done.length - 1]! : null;
}