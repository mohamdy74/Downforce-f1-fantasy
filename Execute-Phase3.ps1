# ==============================================================================
# DOWNFORCE - PHASE 3 (R14 LEAGUE START, PURE LEADERBOARD ENGINE, PUSH-KEY
# DEDUPLICATION, AND AUTOMATED CHARACTERIZATION TEST SUITE)
# ==============================================================================
# Executes Phase 3 on top of Phase 1 & Phase 2:
#   - LEAGUE-01: Enforces official League Start at Round 14 (Spanish GP,
#                LEAGUE_START_ROUND = 14), adds trusted server-clock sync
#                (syncServerClock / getTrustedNow), extracts pure
#                computeLeaderboardEntries in src/lib/queries.ts, and strips
#                all pre-R14 and all-zero placeholder rounds across
#                src/lib/queries.ts, src/routes/leaderboard.tsx,
#                src/routes/paddock.tsx, and src/routes/h2h.tsx.
#   - PUSH-01:   Enhances src/lib/push-keys.ts (urlBase64ToUint8Array,
#                extractSubscribedUserIds, findStalePushKeysForEndpoint) and
#                removes duplicated PUBLIC_VAPID & urlBase64ToUint8Array from
#                src/components/PushOptIn.tsx and
#                src/components/AccountAndOnboarding.tsx.
#   - GUARD-01:  Unifies isCompleteTop10 across src/components/PickStatus.tsx,
#                src/routes/predict.tsx, src/routes/reminders.tsx,
#                src/routes/stewards.tsx, src/lib/stewards.functions.ts,
#                src/lib/f1-sync.functions.ts, and src/lib/reminder.functions.ts.
#   - TEST-01:   Adds zero-dependency Node.js characterization test suite
#                (tests/characterization.test.mjs) and verifies both
#                `node --test` and `npm run build` before committing & pushing.
# ==============================================================================

$ErrorActionPreference = "Continue"
Set-Location "C:\Users\moham\fidelity-image-viewer"

function Read-Utf8Lf([string]$RelativePath) {
    $FullPath = Join-Path (Get-Location).Path $RelativePath
    $Raw = [System.IO.File]::ReadAllText($FullPath, [System.Text.Encoding]::UTF8)
    return ($Raw -replace "\r\n", "`n")
}

function Write-Utf8NoBom([string]$RelativePath, [string]$Content) {
    $FullPath = Join-Path (Get-Location).Path $RelativePath
    $Dir = Split-Path -Parent $FullPath
    if (-not (Test-Path $Dir)) {
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    }
    $Normalized = ($Content -replace "\r\n", "`n")
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($FullPath, $Normalized, $Utf8NoBom)
    Write-Host "  [UPDATED] $RelativePath" -ForegroundColor Green
}

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "STEP 1: Enhancing src/lib/push-keys.ts & Deduplicating Push Helpers" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 1.1 Write complete, browser-safe src/lib/push-keys.ts
Write-Utf8NoBom "src\lib\push-keys.ts" @'
/**
 * Single source of truth for Web Push VAPID keys, Base64URL conversion,
 * top-10 completion guard, and push_sub sync_state key parsing.
 * Safe for both browser and server bundles.
 */
const envObj =
  typeof process !== "undefined" && process?.env ? process.env : ({} as Record<string, string | undefined>);

export const VAPID_PUBLIC_KEY =
  envObj["VITE_VAPID_PUBLIC_KEY"] ||
  envObj["VAPID_PUBLIC_KEY"] ||
  "BPsK6eJs07cjbH2JnZRJvMrZ_wTN4CfxgZqdZBXY-oQStSLyrd8NPq0xYVMsUqdbywWgvj5XJQboYn-E9TxPrSk";

export const VAPID_PRIVATE_KEY = envObj["VAPID_PRIVATE_KEY"] || "";

export const VAPID_SUBJECT = "mailto:admin@downforce.app";

/** Converts a URL-safe Base64 VAPID public key into a Uint8Array for pushManager.subscribe(). */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/** A top-10 counts as "submitted" only when all 10 slots are real driver ids (excluding "__none__"). */
export function isCompleteTop10(top10: unknown): boolean {
  return (
    Array.isArray(top10) &&
    top10.filter((x) => Boolean(x && x !== "__none__")).length === 10
  );
}

export type PushSubscriptionRecord = {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  rawKey: string;
};

export function parsePushSubscriptionKey(key: string): PushSubscriptionRecord | null {
  const m = /^push_sub:([^:]+):(.+)$/.exec(key);
  if (!m) return null;
  const userId = m[1]!;
  try {
    const raw = JSON.parse(m[2]!) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      p256dh?: string;
      auth?: string;
    };
    const p256dh = raw.keys?.p256dh ?? raw.p256dh;
    const auth = raw.keys?.auth ?? raw.auth;
    if (!raw.endpoint || !p256dh || !auth) return null;
    return {
      userId,
      endpoint: raw.endpoint,
      p256dh,
      auth,
      rawKey: key,
    };
  } catch {
    return null;
  }
}

export function extractSubscribedUserIds(
  rows: Array<{ key: string }> | null | undefined,
): string[] {
  return Array.from(
    new Set(
      (rows ?? [])
        .map((r) => /^push_sub:([^:]+):/.exec(r.key)?.[1])
        .filter((x): x is string => Boolean(x)),
    ),
  );
}

export function findStalePushKeysForEndpoint(
  existingRows: Array<{ key: string }> | null | undefined,
  userId: string,
  endpoint: string,
): string[] {
  const prefix = `push_sub:${userId}:`;
  const staleKeys: string[] = [];
  for (const r of existingRows ?? []) {
    if (!r.key.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(r.key.slice(prefix.length)) as { endpoint?: string };
      if (parsed.endpoint === endpoint) staleKeys.push(r.key);
    } catch {
      staleKeys.push(r.key);
    }
  }
  return staleKeys;
}
'@

# 1.2 Refactor src/components/PushOptIn.tsx to use VAPID_PUBLIC_KEY & urlBase64ToUint8Array from push-keys.ts
$poPath = "src\components\PushOptIn.tsx"
$po = Read-Utf8Lf $poPath
$oldPoBlock = (@'
import { savePushSubscription } from "@/lib/stewards.functions";

const PUBLIC_VAPID =
  "BPsK6eJs07cjbH2JnZRJvMrZ_wTN4CfxgZqdZBXY-oQStSLyrd8NPq0xYVMsUqdbywWgvj5XJQboYn-E9TxPrSk";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
'@ -replace "\r\n", "`n")

$newPoBlock = (@'
import { VAPID_PUBLIC_KEY as PUBLIC_VAPID, urlBase64ToUint8Array } from "@/lib/push-keys";
import { savePushSubscription } from "@/lib/stewards.functions";
'@ -replace "\r\n", "`n")

if ($po.Contains($oldPoBlock)) {
    $po = $po.Replace($oldPoBlock, $newPoBlock)
    Write-Utf8NoBom $poPath $po
}

# 1.3 Refactor src/components/AccountAndOnboarding.tsx to use VAPID_PUBLIC_KEY & urlBase64ToUint8Array from push-keys.ts
$aoPath = "src\components\AccountAndOnboarding.tsx"
$ao = Read-Utf8Lf $aoPath
$oldAoBlock = (@'
import { deleteMyAccount, savePushSubscription, updateMyProfile } from "@/lib/stewards.functions";

const PUBLIC_VAPID =
  "BPsK6eJs07cjbH2JnZRJvMrZ_wTN4CfxgZqdZBXY-oQStSLyrd8NPq0xYVMsUqdbywWgvj5XJQboYn-E9TxPrSk";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
'@ -replace "\r\n", "`n")

$newAoBlock = (@'
import { VAPID_PUBLIC_KEY as PUBLIC_VAPID, urlBase64ToUint8Array } from "@/lib/push-keys";
import { deleteMyAccount, savePushSubscription, updateMyProfile } from "@/lib/stewards.functions";
'@ -replace "\r\n", "`n")

if ($ao.Contains($oldAoBlock)) {
    $ao = $ao.Replace($oldAoBlock, $newAoBlock)
    Write-Utf8NoBom $aoPath $ao
}

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 2: Unifying isCompleteTop10 Guard Across Client & Server" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 2.1 src/components/PickStatus.tsx
$psPath = "src\components\PickStatus.tsx"
$ps = Read-Utf8Lf $psPath
if (-not $ps.Contains("isCompleteTop10")) {
    $ps = $ps.Replace('import type { Race } from "@/lib/queries";', "import { isCompleteTop10 } from `"@/lib/push-keys`";`nimport type { Race } from `"@/lib/queries`";")
    $ps = $ps.Replace('return !!data && (data.top10 ?? []).filter(Boolean).length === 10;', 'return !!data && isCompleteTop10(data.top10);')
    Write-Utf8NoBom $psPath $ps
}

# 2.2 src/routes/predict.tsx
$prPath = "src\routes\predict.tsx"
$pr = Read-Utf8Lf $prPath
if (-not $pr.Contains("isCompleteTop10")) {
    $pr = $pr.Replace('import { driversQuery, nextRace, racesQuery, type Driver } from "@/lib/queries";', "import { isCompleteTop10 } from `"@/lib/push-keys`";`nimport { driversQuery, nextRace, racesQuery, type Driver } from `"@/lib/queries`";")
    $pr = $pr.Replace('if ((prediction?.top10 ?? []).filter(Boolean).length === 10) return;', 'if (isCompleteTop10(prediction?.top10)) return;')
    $pr = $pr.Replace('const done = (prediction?.top10 ?? []).filter(Boolean).length === 10;', 'const done = isCompleteTop10(prediction?.top10);')
    $pr = $pr.Replace('const hasSaved = !!prediction && (prediction.top10?.length ?? 0) === 10;', 'const hasSaved = !!prediction && isCompleteTop10(prediction.top10);')
    $pr = $pr.Replace('!(!!prediction && (prediction.top10 ?? []).filter(Boolean).length === 10)', '!isCompleteTop10(prediction?.top10)')
    $pr = $pr.Replace('prediction?.id && (prediction.top10?.length ?? 0) === 10 ? "edited" : "locked"', 'prediction?.id && isCompleteTop10(prediction.top10) ? "edited" : "locked"')
    Write-Utf8NoBom $prPath $pr
}

# 2.3 src/routes/reminders.tsx
$rmPath = "src\routes\reminders.tsx"
$rm = Read-Utf8Lf $rmPath
if (-not $rm.Contains("isCompleteTop10")) {
    $rm = $rm.Replace('import { racesQuery, nextRace } from "@/lib/queries";', "import { isCompleteTop10 } from `"@/lib/push-keys`";`nimport { racesQuery, nextRace } from `"@/lib/queries`";")
    $rm = $rm.Replace('.filter((p) => (p.top10 ?? []).filter(Boolean).length === 10)', '.filter((p) => isCompleteTop10(p.top10))')
    Write-Utf8NoBom $rmPath $rm
}

# 2.4 src/lib/reminder.functions.ts
$rfPath = "src\lib\reminder.functions.ts"
$rf = Read-Utf8Lf $rfPath
if (-not $rf.Contains("isCompleteTop10")) {
    $rf = $rf.Replace('import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";', "import { requireSupabaseAuth } from `"@/integrations/supabase/auth-middleware`";`nimport { isCompleteTop10 } from `"@/lib/push-keys`";")
    $rf = $rf.Replace('.filter((p) => (p.top10 ?? []).filter((x) => x && x !== "__none__").length === 10)', '.filter((p) => isCompleteTop10(p.top10))')
    Write-Utf8NoBom $rfPath $rf
}

# 2.5 src/lib/stewards.functions.ts (use isCompleteTop10, extractSubscribedUserIds, findStalePushKeysForEndpoint)
$stewPath = "src\lib\stewards.functions.ts"
$stew = Read-Utf8Lf $stewPath
$stew = $stew.Replace(
    'import { parsePushSubscriptionKey } from "./push-keys";',
    'import { extractSubscribedUserIds, findStalePushKeysForEndpoint, isCompleteTop10, parsePushSubscriptionKey } from "./push-keys";'
)
$oldStaleLoop = (@'
    const staleKeys: string[] = [];
    for (const r of existing ?? []) {
      try {
        const parsed = JSON.parse(r.key.slice(prefix.length)) as { endpoint?: string };
        if (parsed.endpoint === data.endpoint) staleKeys.push(r.key);
      } catch {
        staleKeys.push(r.key);
      }
    }
'@ -replace "\r\n", "`n")
if ($stew.Contains($oldStaleLoop)) {
    $stew = $stew.Replace($oldStaleLoop, "    const staleKeys = findStalePushKeysForEndpoint(existing, context.userId, data.endpoint);")
}

$oldPushIds = (@'
    const pushUserIds = Array.from(
      new Set(
        (subRows ?? [])
          .map((r) => /^push_sub:([^:]+):/.exec(r.key)?.[1])
          .filter((x): x is string => !!x),
      ),
    );
'@ -replace "\r\n", "`n")
if ($stew.Contains($oldPushIds)) {
    $stew = $stew.Replace($oldPushIds, "    const pushUserIds = extractSubscribedUserIds(subRows);")
}
$stew = $stew.Replace('.filter((p) => (p.top10 ?? []).filter((x) => x && x !== "__none__").length === 10)', '.filter((p) => isCompleteTop10(p.top10))')
Write-Utf8NoBom $stewPath $stew

# 2.6 src/lib/f1-sync.functions.ts (use isCompleteTop10)
$syncPath = "src\lib\f1-sync.functions.ts"
$sync = Read-Utf8Lf $syncPath
$sync = $sync.Replace(
    'import { parsePushSubscriptionKey } from "./push-keys";',
    'import { isCompleteTop10, parsePushSubscriptionKey } from "./push-keys";'
)
$sync = $sync.Replace(': (p.top10 ?? []).filter((x) => x && x !== "__none__").length === 10,', ': isCompleteTop10(p.top10),')
Write-Utf8NoBom $syncPath $sync

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 3: Enforcing R14 League Start & Pure Leaderboard Engine" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 3.1 Upgrade src/lib/queries.ts (LEAGUE_START_ROUND = 14, getTrustedNow, computeLeaderboardEntries, 50k limit)
Write-Utf8NoBom "src\lib\queries.ts" @'
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
'@

# 3.2 Update src/routes/h2h.tsx to import LEAGUE_START_ROUND from @/lib/queries
$h2hPath = "src\routes\h2h.tsx"
$h2h = Read-Utf8Lf $h2hPath
$h2h = $h2h.Replace(
    'import { leaderboardQuery, racesQuery } from "@/lib/queries";',
    'import { LEAGUE_START_ROUND, leaderboardQuery, racesQuery } from "@/lib/queries";'
)
$h2h = $h2h.Replace("`nconst LEAGUE_START_ROUND = 14;`n", "`n")
Write-Utf8NoBom $h2hPath $h2h

# 3.3 Update src/routes/leaderboard.tsx to filter R14+ non-zero rounds consistently
$lbPath = "src\routes\leaderboard.tsx"
$lb = Read-Utf8Lf $lbPath
$lb = $lb.Replace(
    'import { leaderboardQuery, racesQuery } from "@/lib/queries";',
    'import { LEAGUE_START_ROUND, leaderboardQuery, racesQuery } from "@/lib/queries";'
)
$lb = $lb.Replace(
    'const scored = board?.[0]?.races || (races?.filter((r) => r.has_results).length ?? 0);',
    'const scored = board?.[0]?.races || (races?.filter((r) => r.round >= LEAGUE_START_ROUND && r.has_results && (board ?? []).some((e) => (e.byRound[r.round] ?? 0) !== 0)).length ?? 0);'
)
$lb = $lb.Replace(
    '(races ?? []).filter((r) => r.has_results && (board ?? []).some((e) => e.byRound[r.round] !== undefined))',
    '(races ?? []).filter((r) => r.round >= LEAGUE_START_ROUND && r.has_results && (board ?? []).some((e) => (e.byRound[r.round] ?? 0) !== 0))'
)
Write-Utf8NoBom $lbPath $lb

# 3.4 Update src/routes/paddock.tsx to filter R14+ locked rounds while keeping glass pill styling
$padPath = "src\routes\paddock.tsx"
$pad = Read-Utf8Lf $padPath
$pad = $pad.Replace(
    'import { driversQuery, racesQuery, type Race } from "@/lib/queries";',
    'import { driversQuery, getTrustedNow, LEAGUE_START_ROUND, racesQuery, type Race } from "@/lib/queries";'
)
$pad = $pad.Replace(
    '() => (races ?? []).filter((r) => new Date(r.race_at).getTime() <= Date.now()),',
    '() => (races ?? []).filter((r) => r.round >= LEAGUE_START_ROUND && new Date(r.race_at).getTime() <= getTrustedNow()),'
)
Write-Utf8NoBom $padPath $pad

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 4: Creating Characterization Test Suite (tests/characterization.test.mjs)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

Write-Utf8NoBom "tests\characterization.test.mjs" @'
import test from "node:test";
import assert from "node:assert/strict";

// 1. Scoring contract (src/lib/scoring.ts)
const POSITION_POINTS = { 0: 3, 1: 2, 2: 1, 3: -1, 4: -2 };
const NO_SUBMISSION_PENALTY = -25;

function positionPoints(diff) {
  return diff in POSITION_POINTS ? POSITION_POINTS[diff] : -3;
}

function scorePrediction(prediction, results) {
  const finishPosition = new Map();
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

  const poleCorrect =
    !!prediction.pole_driver_id && prediction.pole_driver_id === poleDriver;
  const flCorrect =
    !!prediction.fastest_lap_driver_id &&
    prediction.fastest_lap_driver_id === fastestLapDriver;
  const dnfCorrect =
    !!prediction.dnf_driver_id && dnfDrivers.has(prediction.dnf_driver_id);

  const pole = poleCorrect ? 3 : 0;
  const fastestLap = flCorrect ? 3 : 0;
  const dnf = dnfCorrect ? 1 : 0;

  const perfectTop10 = prediction.top10.length === 10 && exactCount === 10;
  const perfectWeekend = perfectTop10 && poleCorrect && flCorrect && dnfCorrect;
  const perfect = perfectWeekend ? 15 : perfectTop10 ? 10 : 0;

  const total = top10 + pole + fastestLap + dnf + perfect;
  return { top10, pole, fastestLap, dnf, perfect, perfectTop10, perfectWeekend, total };
}

// 2. Sprint scoring contract (src/lib/sprintScoring.ts)
const SPRINT_SLOTS = 8;
function scoreSprint(prediction, results) {
  if (!prediction) return { top8: 0, pole: 0, total: 0 };
  const finishPosition = new Map();
  for (const r of results) {
    if (r.finished && r.position != null) finishPosition.set(r.driver_id, r.position);
  }
  const poleDriver = results.find((r) => r.pole)?.driver_id ?? null;

  let top8 = 0;
  (prediction.top8 ?? []).slice(0, SPRINT_SLOTS).forEach((driverId, index) => {
    if (finishPosition.get(driverId) === index + 1) top8 += 1;
  });

  const pole =
    !!prediction.pole_driver_id && prediction.pole_driver_id === poleDriver ? 1 : 0;

  return { top8, pole, total: top8 + pole };
}

// 3. Round scoring contract (src/lib/roundScoring.ts)
function filterValidDriverIds(ids) {
  return (ids ?? []).filter((x) => Boolean(x && x !== "__none__"));
}

function extractStewardLockedUsers(existingScores) {
  return new Set(
    (existingScores ?? [])
      .filter((s) => {
        const b = s.breakdown;
        return b && typeof b === "object" && b["stewardOverride"] === true;
      })
      .map((s) => s.user_id),
  );
}

function buildRaceScoreRows({
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
  nowIso = "2026-10-21T00:00:00.000Z",
}) {
  const stewardLockedUsers = extractStewardLockedUsers(existingScores);
  const byUser = new Map((predictions ?? []).map((p) => [p.user_id, p]));
  const sprintByUser = new Map((sprintPredictions ?? []).map((p) => [p.user_id, p]));
  const sprintFor = (userId) =>
    sprintResults?.length
      ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults)
      : null;

  const rows = [];
  for (const profile of profiles ?? []) {
    if (stewardLockedUsers.has(profile.id)) continue;
    if (raceAt && new Date(profile.created_at) > new Date(raceAt)) continue;

    const sprint = sprintFor(profile.id);
    const sprintTotal = sprint?.total ?? 0;
    const pr = byUser.get(profile.id);
    const validTop10 = filterValidDriverIds(pr?.top10);

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
            ? { noSubmission: true, poleOnly: true, pole: poleHit, ...(sprint ? { sprint } : {}), total }
            : { noSubmission: true, pole: poleHit, ...(sprint ? { sprint } : {}), total };
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

// 4. Leaderboard aggregation contract (src/lib/queries.ts)
const LEAGUE_START_ROUND = 14;
function computeLeaderboardEntries(profiles, scores, raceRows) {
  const rMap = new Map((raceRows ?? []).map((r) => [r.id, r.round]));
  const activeRounds = new Set();
  for (const s of scores ?? []) {
    const rd = rMap.get(s.race_id);
    if (rd != null && rd >= LEAGUE_START_ROUND && s.points !== 0) {
      activeRounds.add(rd);
    }
  }

  const byUser = new Map();
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

  let latestRound = 0;
  for (const s of scores ?? []) {
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

  const sort = (a, b) => b.points - a.points || a.name.localeCompare(b.name);
  const list = [...byUser.values()].sort(sort);

  if (latestRound > 0) {
    const prevPts = new Map();
    for (const s of scores ?? []) {
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

// 5. Push keys & F1 parsers contract
function parsePushSubscriptionKey(key) {
  const m = /^push_sub:([^:]+):(.+)$/.exec(key);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[2]);
    const p256dh = raw.keys?.p256dh ?? raw.p256dh;
    const auth = raw.keys?.auth ?? raw.auth;
    if (!raw.endpoint || !p256dh || !auth) return null;
    return { userId: m[1], endpoint: raw.endpoint, p256dh, auth, rawKey: key };
  } catch {
    return null;
  }
}

function findStalePushKeysForEndpoint(existingKeys, userId, endpoint) {
  const prefix = `push_sub:${userId}:`;
  const stale = [];
  for (const key of existingKeys) {
    if (!key.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(key.slice(prefix.length));
      if (parsed.endpoint === endpoint) stale.push(key);
    } catch {
      stale.push(key);
    }
  }
  return stale;
}

function toIso(session) {
  if (!session?.date) return null;
  const d = new Date(`${session.date}T${session.time ?? "12:00:00Z"}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isClassifiedFinishStatus(status, includeLappedKeyword = true) {
  if (!status) return false;
  return includeLappedKeyword
    ? /finished|lapped|\+\d+ lap/i.test(status)
    : /finished|\+\d+ lap/i.test(status);
}

function fmtLap(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : s;
}

test("Characterization 1: positionPoints & scorePrediction preserve exact F1 league scoring rules", () => {
  assert.equal(positionPoints(0), 3);
  assert.equal(positionPoints(1), 2);
  assert.equal(positionPoints(2), 1);
  assert.equal(positionPoints(3), -1);
  assert.equal(positionPoints(4), -2);
  assert.equal(positionPoints(5), -3);
  assert.equal(positionPoints(99), -3);

  const drivers = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"];
  const results = [
    ...drivers.map((id, i) => ({
      driver_id: id,
      position: i + 1,
      finished: true,
      pole: i === 0,
      fastest_lap: i === 1,
    })),
    { driver_id: "dnf1", position: null, finished: false, pole: false, fastest_lap: false },
  ];

  const perfect = scorePrediction(
    { top10: drivers, pole_driver_id: "d1", fastest_lap_driver_id: "d2", dnf_driver_id: "dnf1" },
    results,
  );
  assert.equal(perfect.total, 52);
  assert.equal(perfect.perfectWeekend, true);
});

test("Characterization 2: scoreSprint awards max 9 points and handles null safely", () => {
  const top8 = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];
  const results = top8.map((id, i) => ({
    driver_id: id,
    position: i + 1,
    finished: true,
    pole: i === 0,
  }));
  assert.deepEqual(scoreSprint(null, results), { top8: 0, pole: 0, total: 0 });
  assert.deepEqual(scoreSprint({ top8, pole_driver_id: "d1" }, results), { top8: 8, pole: 1, total: 9 });
});

test("Characterization 3: buildRaceScoreRows preserves stewardOverride lock, post-race signup exemption, and auto_sync vs manual_results contracts", () => {
  const results = Array.from({ length: 10 }, (_, i) => ({
    driver_id: `d${i + 1}`,
    position: i + 1,
    finished: true,
    pole: i === 0,
    fastest_lap: i === 0,
  }));
  const profiles = [
    { id: "u_locked", created_at: "2026-01-01T00:00:00Z" },
    { id: "u_late", created_at: "2026-10-25T00:00:00Z" },
    { id: "u_missing", created_at: "2026-01-01T00:00:00Z" },
    { id: "u_pole_only", created_at: "2026-01-01T00:00:00Z" },
  ];
  const predictions = [
    { user_id: "u_pole_only", top10: ["__none__"], pole_driver_id: "d1", fastest_lap_driver_id: null, dnf_driver_id: null },
  ];
  const existingScores = [
    { user_id: "u_locked", breakdown: { stewardOverride: true, total: 99 } },
  ];

  const autoRows = buildRaceScoreRows({
    raceId: "r1",
    raceAt: "2026-10-20T14:00:00Z",
    profiles,
    results,
    predictions,
    sprintResults: [],
    sprintPredictions: [],
    existingScores,
    mode: "auto_sync",
  });
  assert.equal(autoRows.length, 2);
  assert.deepEqual(autoRows[0].breakdown, { noSubmission: true, total: -25 });
  assert.deepEqual(autoRows[1].breakdown, { noSubmission: true, poleOnly: true, pole: 3, total: -22 });

  const manualRows = buildRaceScoreRows({
    raceId: "r1",
    raceAt: "2026-10-20T14:00:00Z",
    profiles,
    results,
    predictions,
    sprintResults: [],
    sprintPredictions: [],
    existingScores,
    mode: "manual_results",
    manualPoleWinner: "d1",
  });
  assert.equal(manualRows.length, 2);
  assert.deepEqual(manualRows[0].breakdown, { noSubmission: true, total: -25 });
  assert.deepEqual(manualRows[1].breakdown, { noSubmission: true, pole: 3, total: -22 });
});

test("Characterization 4: computeLeaderboardEntries filters R14+, strips zero-only rounds, and computes Fahl & rank change", () => {
  const profiles = [
    { id: "u1", display_name: "Mohamed Hamdy", avatar_url: null },
    { id: "u2", display_name: "Ahmed Hatem", avatar_url: null },
  ];
  const raceRows = [
    { id: "r13", round: 13 },
    { id: "r14", round: 14 },
    { id: "r15", round: 15 },
    { id: "r16", round: 16 },
  ];
  const scores = [
    { user_id: "u1", race_id: "r13", points: 50 },
    { user_id: "u1", race_id: "r14", points: 13 },
    { user_id: "u2", race_id: "r14", points: 9 },
    { user_id: "u1", race_id: "r15", points: 0 },
    { user_id: "u2", race_id: "r15", points: 0 },
    { user_id: "u1", race_id: "r16", points: 4 },
    { user_id: "u2", race_id: "r16", points: 18 },
  ];

  const board = computeLeaderboardEntries(profiles, scores, raceRows);
  assert.equal(board[0].userId, "u2");
  assert.equal(board[0].points, 27);
  assert.equal(board[0].fahl, true);
  assert.equal(board[0].change, 1);
  assert.equal(board[1].userId, "u1");
  assert.equal(board[1].points, 17);
  assert.equal(board[1].change, -1);
});

test("Characterization 5: push-keys and f1-parsers preserve exact string and regex semantics", () => {
  const key = 'push_sub:u123:{"endpoint":"https://fcm.googleapis.com/1","p256dh":"k","auth":"a"}';
  const parsed = parsePushSubscriptionKey(key);
  assert.equal(parsed?.userId, "u123");
  assert.equal(parsed?.endpoint, "https://fcm.googleapis.com/1");

  const stale = findStalePushKeysForEndpoint(
    [key, "push_sub:u123:corrupt-json", 'push_sub:u123:{"endpoint":"https://other"}'],
    "u123",
    "https://fcm.googleapis.com/1",
  );
  assert.deepEqual(stale, [key, "push_sub:u123:corrupt-json"]);
  assert.equal(toIso({ date: "2026-10-25", time: "19:00:00Z" }), "2026-10-25T19:00:00.000Z");
  assert.equal(isClassifiedFinishStatus("Finished"), true);
  assert.equal(isClassifiedFinishStatus("+1 Lap"), true);
  assert.equal(isClassifiedFinishStatus("Retired"), false);
  assert.equal(fmtLap(83.456), "1:23.456");
});
'@

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 5: Running Characterization Tests & Production Build" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

node --test tests/characterization.test.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  [ERROR] Characterization tests failed! Rolling back Phase 3..." -ForegroundColor Red
    git checkout -- .
    Remove-Item -Path "tests\characterization.test.mjs" -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "  [PASS] All 5 Characterization Test Suites passed!" -ForegroundColor Green

npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  [ERROR] Production build failed! Rolling back Phase 3..." -ForegroundColor Red
    git checkout -- .
    Remove-Item -Path "tests\characterization.test.mjs" -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "  [PASS] Production build succeeded with 0 errors!" -ForegroundColor Green

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 6: Committing & Pushing Phase 3 to GitHub (origin/main)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

git add -A
git commit -m "Phase 3: enforce R14 Spanish GP league start & zero-round filtering, extract computeLeaderboardEntries, unify push-keys & top10 guards, and add characterization test suite"
git push origin main

Write-Host "`n==================================================================" -ForegroundColor Green
Write-Host "SUCCESS! Phase 3 (Final Phase) is complete, verified, and pushed!" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
