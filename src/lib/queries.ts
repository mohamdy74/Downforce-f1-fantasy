import { queryOptions } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

export const SEASON = 2026;

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
    const { data, error } = await supabase
      .from("races")
      .select("*")
      .eq("season", SEASON)
      .order("round");
    if (error) throw error;
    return data as Race[];
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

export const leaderboardQuery = queryOptions({
  queryKey: ["leaderboard", SEASON],
  staleTime: 2 * 60_000,
  queryFn: async (): Promise<LeaderboardEntry[]> => {
    const { data: sData } = await supabase.auth.getSession();
    if (!sData.session) return [];

    const [
      { data: scores, error: sErr },
      { data: profiles, error: pErr },
      { data: raceRows },
    ] = await Promise.all([
      supabase.from("scores").select("user_id, race_id, points").limit(50000),
      supabase.from("profiles").select("id, display_name, avatar_url").limit(10000),
      supabase.from("races").select("id, round").eq("season", SEASON),
    ]);
    if (sErr) throw sErr;
    if (pErr) throw pErr;

    const byUser = new Map<string, LeaderboardEntry>();
    for (const p of profiles ?? []) {
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
    for (const s of scores ?? []) {
      if (!(raceRows ?? []).some((r) => r.id === s.race_id)) continue; const entry = byUser.get(s.user_id);
      if (!entry) continue;
      entry.points += s.points;
      entry.races += 1;
      entry.best = entry.best == null ? s.points : Math.max(entry.best, s.points);
    }

    const rMap = new Map((raceRows ?? []).map((r) => [r.id, r.round]));
    for (const s of scores ?? []) {
      const e = byUser.get(s.user_id);
      const rd = rMap.get(s.race_id);
      if (e && rd != null) e.byRound[rd] = s.points;
    }
    const lastRd = Math.max(0, ...(scores ?? []).map((s) => rMap.get(s.race_id) ?? 0));
    if (lastRd > 0) {
      const top = Math.max(...[...byUser.values()].map((e) => e.byRound[lastRd] ?? -Infinity));
      for (const e of byUser.values()) if (e.byRound[lastRd] === top) e.fahl = true;
    }

    const sort = (a: LeaderboardEntry, b: LeaderboardEntry) =>
      b.points - a.points || a.name.localeCompare(b.name);
    const list = [...byUser.values()].sort(sort);

    // Rank movement vs. standings before the latest scored race.
    const roundOf = new Map((raceRows ?? []).map((r) => [r.id, r.round]));
    const latest = Math.max(0, ...(scores ?? []).map((s) => roundOf.get(s.race_id) ?? 0));
    if (latest > 0) {
      const prevPts = new Map<string, number>();
      for (const s of scores ?? []) {
        if ((roundOf.get(s.race_id) ?? 0) === latest) continue;
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
  },
});

export function nextRace(races: Race[]): Race | null {
  const now = Date.now();
  return races.find((r) => new Date(r.race_at).getTime() > now) ?? null;
}

export function lastRace(races: Race[]): Race | null {
  const done = races.filter((r) => r.has_results);
  return done.length ? done[done.length - 1]! : null;
}
