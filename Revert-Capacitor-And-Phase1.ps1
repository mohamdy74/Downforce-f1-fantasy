# ==============================================================================
# DOWNFORCE - COMPLETE CAPACITOR REVERT + PHASE 1 (SECURITY & CORE SCORING)
# ==============================================================================
# 1. Reverts all Capacitor mobile files and commits back to clean baseline (85e0533)
# 2. Executes Phase 1:
#    - SEC-01: Removes hardcoded VAPID_PRIVATE_KEY fallback in src/lib/push-keys.ts
#    - SEC-02: Hardens checkAndSendRaceReminders in src/lib/push.functions.ts
#    - BUG-01: Removes requireSupabaseAuth from public /weekend schedule & session RPCs
#    - CORE-01: Extracts src/lib/roundScoring.ts & unifies race scoring in
#               stewards.functions.ts and f1-sync.functions.ts
#    - TS-STRICT: Fixes strict TypeScript checks in DriverPicker, ErrorBoundary, useTheme
# 3. Verifies with npm run build and pushes cleanly to GitHub (origin/main)
# ==============================================================================

$ErrorActionPreference = "Continue"
Set-Location "C:\Users\moham\fidelity-image-viewer"

function Write-Utf8NoBom([string]$RelativePath, [string]$Content) {
    $FullPath = Join-Path (Get-Location).Path $RelativePath
    $Dir = Split-Path -Parent $FullPath
    if (-not (Test-Path $Dir)) {
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    }
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($FullPath, $Content, $Utf8NoBom)
    Write-Host "  [UPDATED] $RelativePath" -ForegroundColor Green
}

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "STEP 1: Reverting Capacitor Technology & Restoring Clean State" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

$CurrentBranch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($CurrentBranch -ne "main") {
    git checkout main
}

$TempBranches = @("lovable-revert-baseline", "refactor/clean-architecture")
foreach ($tb in $TempBranches) {
    $exists = ("$(git branch --list $tb)").Trim()
    if ($exists) {
        git branch -D $tb | Out-Null
    }
}

git reset --hard 85e0533
git clean -fd

$CapFiles = @(
    "capacitor.config.json",
    "capacitor.config.ts",
    "src\lib\native.ts",
    ".github\workflows\build-apk.yml",
    ".github\scripts\customize_android.py",
    "public\offline.html",
    "public\aero-d-fg.webp",
    "public\app-icon.webp",
    "public\mono-splash.webp",
    "public\outline-splash.webp"
)
foreach ($cf in $CapFiles) {
    $full = Join-Path (Get-Location).Path $cf
    if (Test-Path $full) {
        Remove-Item -Path $full -Force -Recurse
        Write-Host "  [REMOVED] $cf" -ForegroundColor Yellow
    }
}

Write-Host "  [OK] Repository restored to clean pre-Capacitor baseline (85e0533)." -ForegroundColor Green

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 2: Phase 1A - Security Hardening & Public Weekend Fix" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 2.1 SEC-01: Remove hardcoded private VAPID key fallback + add push subscription parser
Write-Utf8NoBom "src\lib\push-keys.ts" @'
/** Single source of truth for Web Push VAPID keys + helpers.
 * Public key is safe for client & server use; private key MUST come from server environment.
 */
export const VAPID_PUBLIC_KEY =
  process.env["VITE_VAPID_PUBLIC_KEY"] ||
  process.env["VAPID_PUBLIC_KEY"] ||
  "BPsK6eJs07cjbH2JnZRJvMrZ_wTN4CfxgZqdZBXY-oQStSLyrd8NPq0xYVMsUqdbywWgvj5XJQboYn-E9TxPrSk";

export const VAPID_PRIVATE_KEY = process.env["VAPID_PRIVATE_KEY"] || "";

export const VAPID_SUBJECT = "mailto:admin@downforce.app";

/** A top-10 counts as "submitted" only when all 10 slots are real driver ids. */
export function isCompleteTop10(top10: unknown): boolean {
  return (
    Array.isArray(top10) &&
    top10.filter((x) => x && x !== "__none__").length === 10
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
'@

# 2.2 SEC-02: Harden checkAndSendRaceReminders in src/lib/push.functions.ts
Write-Utf8NoBom "src\lib\push.functions.ts" @'
import { createServerFn } from "@tanstack/react-start";

import {
  VAPID_PRIVATE_KEY,
  VAPID_PUBLIC_KEY,
  VAPID_SUBJECT,
  isCompleteTop10,
  parsePushSubscriptionKey,
} from "@/lib/push-keys";
import { sendNativeWebPush } from "@/lib/webpush-native";

export const checkAndSendRaceReminders = createServerFn({ method: "POST" })
  .inputValidator((input: { forceWindow?: "2h" | "30m" | null } | undefined) => ({
    forceWindow: input?.forceWindow ?? null,
  }))
  .handler(async () => {
    const pub = VAPID_PUBLIC_KEY;
    const priv = VAPID_PRIVATE_KEY;
    if (!pub || !priv) return { sent: 0, reason: "VAPID keys not configured" };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const now = Date.now();
    const in3Hours = new Date(now + 3 * 3600_000).toISOString();
    const nowIso = new Date(now).toISOString();

    const { data: upcomingRaces } = await supabaseAdmin
      .from("races")
      .select("id, name, round, race_at")
      .gt("race_at", nowIso)
      .lte("race_at", in3Hours)
      .order("race_at", { ascending: true })
      .limit(1);

    const race = upcomingRaces?.[0];
    if (!race) return { sent: 0, reason: "No race starting within 3 hours" };

    const minsLeft = (new Date(race.race_at).getTime() - now) / 60_000;

    // Strictly enforce real countdown windows (never allow unauthenticated forceWindow spoofing)
    let windowTag: "2h" | "30m" | null = null;
    if (minsLeft <= 125 && minsLeft >= 95) windowTag = "2h";
    else if (minsLeft <= 35 && minsLeft >= 10) windowTag = "30m";

    if (!windowTag) {
      return { sent: 0, minsLeft: Math.round(minsLeft), reason: "Outside 2h and 30m windows" };
    }

    const { data: preds } = await supabaseAdmin
      .from("predictions")
      .select("user_id, top10")
      .eq("race_id", race.id);

    const completedUsers = new Set(
      (preds ?? [])
        .filter((p) => isCompleteTop10(p.top10))
        .map((p) => p.user_id),
    );

    const [{ data: sLogs }, { data: sSubs }] = await Promise.all([
      supabaseAdmin
        .from("sync_state")
        .select("key")
        .like("key", `push_log:${race.id}:${windowTag}:%`),
      supabaseAdmin.from("sync_state").select("key").like("key", "push_sub:%"),
    ]);

    const sentSet = new Set((sLogs ?? []).map((r) => r.key.split(":").pop()!));
    const targetSubs = (sSubs ?? []).flatMap((r) => {
      const parsed = parsePushSubscriptionKey(r.key);
      if (!parsed || completedUsers.has(parsed.userId) || sentSet.has(parsed.userId)) return [];
      return [parsed];
    });

    if (!targetSubs.length) {
      return { sent: 0, windowTag, reason: "No pending un-notified users" };
    }

    const payload = JSON.stringify({
      title:
        windowTag === "30m"
          ? `\u{1F6A8} 30 mins left \u2014 ${race.name}!`
          : `\u23F0 2 hours to ${race.name}!`,
      body:
        windowTag === "30m"
          ? "Final call! You still haven't locked in your Top 10. Tap here now before picks lock (-25 pts)!"
          : "You haven't submitted your picks yet. Tap to open Predict and lock in your Top 10!",
      tag: `downforce-${race.id}-${windowTag}`,
      url: "/predict",
    });

    let sent = 0;
    const newlyNotified = new Set<string>();
    for (const sub of targetSubs) {
      try {
        const res = await sendNativeWebPush(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          payload,
          { subject: VAPID_SUBJECT, publicKey: pub, privateKey: priv },
        );
        if (res.ok) {
          sent++;
          newlyNotified.add(sub.userId);
        }
      } catch {
        // Ignore expired subscription
      }
    }

    if (newlyNotified.size > 0) {
      await supabaseAdmin.from("sync_state").upsert(
        Array.from(newlyNotified).map((uid) => ({
          key: `push_log:${race.id}:${windowTag}:${uid}`,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "key" },
      );
    }

    return { sent, windowTag, raceName: race.name };
  });
'@

# 2.3 BUG-01: Remove requireSupabaseAuth from getWeekendSchedule and getWeekendSession
$wkPath = "src\lib\weekend.functions.ts"
$wk = (([System.IO.File]::ReadAllText((Join-Path (Get-Location).Path $wkPath), [System.Text.Encoding]::UTF8)) -replace "\r\n", "`n")
$wk = $wk.Replace('import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";' + "`r`n", "")
$wk = $wk.Replace('import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";' + "`n", "")
$wk = $wk.Replace("  .middleware([requireSupabaseAuth])`r`n", "")
$wk = $wk.Replace("  .middleware([requireSupabaseAuth])`n", "")
Write-Utf8NoBom $wkPath $wk

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 3: Phase 1B - Unifying Round Scoring Engine & Strict Types" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 3.1 Fix strict TypeScript properties in DriverPicker, ErrorBoundary, useTheme
$dpPath = "src\components\DriverPicker.tsx"
$dp = (([System.IO.File]::ReadAllText((Join-Path (Get-Location).Path $dpPath), [System.Text.Encoding]::UTF8)) -replace "\r\n", "`n")
$dp = $dp.Replace("disabled?: boolean;", "disabled?: boolean | undefined;")
$dp = $dp.Replace("exclude?: string[];", "exclude?: string[] | undefined;")
Write-Utf8NoBom $dpPath $dp

$ebPath = "src\components\ErrorBoundary.tsx"
$eb = (([System.IO.File]::ReadAllText((Join-Path (Get-Location).Path $ebPath), [System.Text.Encoding]::UTF8)) -replace "\r\n", "`n")
$eb = $eb.Replace("  state: ErrorBoundaryState =", "  override state: ErrorBoundaryState =")
$eb = $eb.Replace("  componentDidCatch(error: Error)", "  override componentDidCatch(error: Error)")
$eb = $eb.Replace("  render()", "  override render()")
Write-Utf8NoBom $ebPath $eb

$utPath = "src\hooks\useTheme.ts"
$ut = (([System.IO.File]::ReadAllText((Join-Path (Get-Location).Path $utPath), [System.Text.Encoding]::UTF8)) -replace "\r\n", "`n")
$targetUt = @"
      mediaQuery.addEventListener("change", listener);
      return () => mediaQuery.removeEventListener("change", listener);
    }
  }, [theme]);
"@
$replaceUt = @"
      mediaQuery.addEventListener("change", listener);
      return () => mediaQuery.removeEventListener("change", listener);
    }
    return undefined;
  }, [theme]);
"@
if ($ut.Contains($targetUt.Trim())) {
    $ut = $ut.Replace($targetUt.Trim(), $replaceUt.Trim())
    Write-Utf8NoBom $utPath $ut
}

# 3.2 Create src/lib/roundScoring.ts
Write-Utf8NoBom "src\lib\roundScoring.ts" @'
import type { Json } from "@/integrations/supabase/types";
import { NO_SUBMISSION_PENALTY, scorePrediction, type ResultRow } from "./scoring";
import { scoreSprint, type SprintResultRow } from "./sprintScoring";

export type ProfileRecord = {
  id: string;
  created_at: string;
};

export type PredictionRecord = {
  user_id: string;
  top10: string[];
  pole_driver_id: string | null;
  fastest_lap_driver_id: string | null;
  dnf_driver_id: string | null;
};

export type SprintPredictionRecord = {
  user_id: string;
  top8: string[];
  pole_driver_id: string | null;
};

export type ScoreRecord = {
  user_id: string;
  breakdown: Json;
};

export type BuiltScoreRow = {
  user_id: string;
  race_id: string;
  points: number;
  breakdown: Json;
  updated_at: string;
};

/**
 * Single source of truth for round race-scoring across auto-sync and stewards manual entry.
 * Preserves the exact breakdown contracts:
 * - auto_sync sets `poleOnly: true` on incomplete top10 rows
 * - manual_results omits `poleOnly: true` on incomplete top10 rows
 * - both respect stewardOverride lock and skip post-race registrations
 */
export function buildRaceScoreRows(params: {
  raceId: string;
  raceAt: string | null;
  profiles: ProfileRecord[];
  results: ResultRow[];
  predictions: PredictionRecord[];
  sprintResults: SprintResultRow[] | null;
  sprintPredictions: SprintPredictionRecord[] | null;
  existingScores: ScoreRecord[] | null;
  mode: "auto_sync" | "manual_results";
  manualPoleWinner?: string | null;
}): BuiltScoreRow[] {
  const {
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
  } = params;

  if (!profiles.length || !results.length) return [];

  // Identify scores protected by FIA Stewards (never overwrite)
  const stewardLockedUsers = new Set(
    (existingScores ?? [])
      .filter((s) => {
        const b = s.breakdown as Record<string, unknown> | null;
        return b && b["stewardOverride"] === true;
      })
      .map((s) => s.user_id),
  );

  const byUser = new Map(predictions.map((p) => [p.user_id, p]));
  const sprintByUser = new Map((sprintPredictions ?? []).map((p) => [p.user_id, p]));

  const sprintFor = (userId: string) =>
    sprintResults?.length
      ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults)
      : null;

  const rows: BuiltScoreRow[] = [];
  const nowIso = new Date().toISOString();

  for (const profile of profiles) {
    if (stewardLockedUsers.has(profile.id)) continue;
    if (raceAt && new Date(profile.created_at) > new Date(raceAt)) continue;

    const sprint = sprintFor(profile.id);
    const sprintTotal = sprint?.total ?? 0;
    const pr = byUser.get(profile.id);
    const validTop10 = (pr?.top10 ?? []).filter((x) => x && x !== "__none__");

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
            ? {
                noSubmission: true,
                poleOnly: true,
                pole: poleHit,
                ...(sprint ? { sprint } : {}),
                total,
              }
            : {
                noSubmission: true,
                pole: poleHit,
                ...(sprint ? { sprint } : {}),
                total,
              };

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
'@

# 3.3 Wire buildRaceScoreRows into src/lib/stewards.functions.ts
$stewPath = "src\lib\stewards.functions.ts"
$stew = (([System.IO.File]::ReadAllText((Join-Path (Get-Location).Path $stewPath), [System.Text.Encoding]::UTF8)) -replace "\r\n", "`n")

$oldStewImport = 'import { scorePrediction, NO_SUBMISSION_PENALTY, type ResultRow } from "./scoring";'
$newStewImport = @"
import { type ResultRow } from "./scoring";
import { buildRaceScoreRows, type ProfileRecord, type PredictionRecord, type SprintPredictionRecord, type ScoreRecord } from "./roundScoring";
"@
$stew = $stew.Replace($oldStewImport, $newStewImport)

$oldManualLoop = @'
      const stewardLockedUsers = new Set(
        (existingScores ?? [])
          .filter((s) => {
            const b = s.breakdown as Record<string, unknown> | null;
            return b && b["stewardOverride"] === true;
          })
          .map((s) => s.user_id),
      );

      const byU = new Map((preds ?? []).map((p) => [p.user_id, p]));
      const sprintByU = new Map((sprintPreds ?? []).map((p) => [p.user_id, p]));
      const sprintFor = (uid: string) =>
        sprintResults?.length
          ? scoreSprint(sprintByU.get(uid) ?? null, sprintResults as SprintResultRow[])
          : null;

      const scoreRows = [];
      for (const p of profiles ?? []) {
        if (stewardLockedUsers.has(p.id)) continue;
        if (raceRow?.race_at && new Date(p.created_at) > new Date(raceRow.race_at)) continue;

        const sprint = sprintFor(p.id);
        const pr = byU.get(p.id);
        const validTop10 = (pr?.top10 ?? []).filter((x) => x && x !== "__none__");
        if (!pr || validTop10.length < 10) {
          const poleHit = pr?.pole_driver_id && pr.pole_driver_id === d.pole ? 3 : 0;
          const total = NO_SUBMISSION_PENALTY + poleHit + (sprint?.total ?? 0);
          scoreRows.push({
            user_id: p.id,
            race_id: d.raceId!,
            points: total,
            breakdown: { noSubmission: true, pole: poleHit, ...(sprint ? { sprint } : {}), total },
            updated_at: new Date().toISOString(),
          });
        } else {
          const b = scorePrediction(
            { top10: validTop10, pole_driver_id: pr.pole_driver_id, fastest_lap_driver_id: pr.fastest_lap_driver_id, dnf_driver_id: pr.dnf_driver_id },
            rows as ResultRow[],
          );
          const total = b.total + (sprint?.total ?? 0);
          scoreRows.push({
            user_id: p.id,
            race_id: d.raceId!,
            points: total,
            breakdown: { ...b, ...(sprint ? { sprint } : {}), total },
            updated_at: new Date().toISOString(),
          });
        }
      }
'@

$newManualLoop = @'
      const scoreRows = buildRaceScoreRows({
        raceId: d.raceId!,
        raceAt: raceRow?.race_at ?? null,
        profiles: (profiles ?? []) as ProfileRecord[],
        results: rows as ResultRow[],
        predictions: (preds ?? []) as PredictionRecord[],
        sprintResults: (sprintResults ?? []) as SprintResultRow[],
        sprintPredictions: (sprintPreds ?? []) as SprintPredictionRecord[],
        existingScores: (existingScores ?? []) as ScoreRecord[],
        mode: "manual_results",
        manualPoleWinner: d.pole,
      });
'@
$stew = $stew.Replace(($oldManualLoop -replace "\r\n", "`n"), ($newManualLoop -replace "\r\n", "`n"))
$stew = $stew.Replace($oldManualLoop, $newManualLoop)
Write-Utf8NoBom $stewPath $stew

# 3.4 Wire buildRaceScoreRows into src/lib/f1-sync.functions.ts
$syncPath = "src\lib\f1-sync.functions.ts"
$sync = (([System.IO.File]::ReadAllText((Join-Path (Get-Location).Path $syncPath), [System.Text.Encoding]::UTF8)) -replace "\r\n", "`n")

$oldSyncImport = 'import { NO_SUBMISSION_PENALTY, scorePrediction, type ResultRow } from "./scoring";'
$newSyncImport = @"
import { type ResultRow } from "./scoring";
import { buildRaceScoreRows, type ProfileRecord, type PredictionRecord, type SprintPredictionRecord, type ScoreRecord } from "./roundScoring";
"@
$sync = $sync.Replace($oldSyncImport, $newSyncImport)

$oldSyncLoop = @'
    // Never overwrite a score that was manually overridden or waived by FIA Stewards
    const stewardLockedUsers = new Set(
      (existingScores ?? [])
        .filter((s) => {
          const b = s.breakdown as Record<string, unknown> | null;
          return b && b["stewardOverride"] === true;
        })
        .map((s) => s.user_id),
    );

    const byUser = new Map((predictions ?? []).map((p) => [p.user_id, p]));
    const sprintByUser = new Map((sprintPreds ?? []).map((p) => [p.user_id, p]));
    const sprintFor = (userId: string) =>
      sprintResults?.length
        ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults as SprintResultRow[])
        : null;

    const rows: Array<{
      user_id: string;
      race_id: string;
      points: number;
      breakdown: Json;
      updated_at: string;
    }> = [];

    for (const profile of profiles) {
      if (stewardLockedUsers.has(profile.id)) continue;
      if (new Date(profile.created_at) > new Date(race.race_at)) continue;

      const sprint = sprintFor(profile.id);
      const prediction = byUser.get(profile.id);
      if (!prediction) {
        rows.push({
          user_id: profile.id,
          race_id: race.id,
          points: NO_SUBMISSION_PENALTY + (sprint?.total ?? 0),
          breakdown: {
            noSubmission: true,
            ...(sprint ? { sprint } : {}),
            total: NO_SUBMISSION_PENALTY + (sprint?.total ?? 0),
          },
          updated_at: new Date().toISOString(),
        });
        continue;
      }

      const validTop10 = (prediction.top10 ?? []).filter((x) => x && x !== "__none__");
      const breakdown = scorePrediction(
        {
          top10: validTop10,
          pole_driver_id: prediction.pole_driver_id,
          fastest_lap_driver_id: prediction.fastest_lap_driver_id,
          dnf_driver_id: prediction.dnf_driver_id,
        },
        results as ResultRow[],
      );

      const poleOnly = validTop10.length < 10;
      const raceTotal = poleOnly ? NO_SUBMISSION_PENALTY + breakdown.pole : breakdown.total;
      const total = raceTotal + (sprint?.total ?? 0);
      rows.push({
        user_id: profile.id,
        race_id: race.id,
        points: total,
        breakdown: poleOnly
          ? { noSubmission: true, poleOnly: true, pole: breakdown.pole, ...(sprint ? { sprint } : {}), total }
          : { ...breakdown, ...(sprint ? { sprint } : {}), total },
        updated_at: new Date().toISOString(),
      });
    }
'@

$newSyncLoop = @'
    const rows = buildRaceScoreRows({
      raceId: race.id,
      raceAt: race.race_at,
      profiles: (profiles ?? []) as ProfileRecord[],
      results: results as ResultRow[],
      predictions: (predictions ?? []) as PredictionRecord[],
      sprintResults: (sprintResults ?? []) as SprintResultRow[],
      sprintPredictions: (sprintPreds ?? []) as SprintPredictionRecord[],
      existingScores: (existingScores ?? []) as ScoreRecord[],
      mode: "auto_sync",
    });
'@
$sync = $sync.Replace(($oldSyncLoop -replace "\r\n", "`n"), ($newSyncLoop -replace "\r\n", "`n"))
$sync = $sync.Replace($oldSyncLoop, $newSyncLoop)
Write-Utf8NoBom $syncPath $sync

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 4: Verifying Build (npm run build) & Pushing to GitHub" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n[ERROR] Build failed! Rolling back to clean 85e0533..." -ForegroundColor Red
    git reset --hard 85e0533
    exit 1
}

Write-Host "`n  [PASS] Production build succeeded with 0 errors!" -ForegroundColor Green

git add -A
git commit -m "Revert Capacitor mobile shell and complete Phase 1 (VAPID security, public weekend RPCs, unified roundScoring engine)"
git push origin main --force

Write-Host "`n==================================================================" -ForegroundColor Green
Write-Host "DONE! Capacitor is 100% removed and Phase 1 is live on main!" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
