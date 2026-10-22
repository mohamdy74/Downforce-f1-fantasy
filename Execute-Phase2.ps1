# ==============================================================================
# DOWNFORCE - PHASE 2 (ARCHITECTURE MODULARIZATION & HIGH-TRAFFIC HARDENING)
# ==============================================================================
# Executes Phase 2 on top of Phase 1:
#   - MOD-01: Extracts shared F1 API & telemetry parsers (src/lib/f1-parsers.ts)
#             and deduplicates weekend.functions.ts & f1-sync.functions.ts
#   - MOD-02: Extracts shared share-card browser helpers (src/lib/shareActions.ts)
#             and deduplicates SharePicks.tsx & SharePole.tsx
#   - MOD-03: Centralizes push subscription parsing (parsePushSubscriptionKey)
#             and strict deadline column typing in stewards.functions.ts
#   - SCALE-01: Bypasses Supabase 1,000-row cap (.limit(50000) / .limit(10000))
#               in src/lib/queries.ts (leaderboardQuery)
#   - SCALE-02: Adds random jitter in src/components/BackgroundSync.tsx to
#               prevent thundering-herd sync spikes on shared links
#   - SCALE-03: Adds in-flight sync lock, bounded rate-limit map eviction,
#               and chunked push notification batching (25 at a time)
#   - SEC-03: Adds browser-bundle import guard + removes hardcoded private key
#             fallback in src/lib/webpush-native.ts, and adds HTTP security
#             headers (HSTS, X-Frame-Options, nosniff, Referrer-Policy) in
#             src/server.ts
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
Write-Host "STEP 1: Creating Shared Domain Modules (f1-parsers & shareActions)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 1.1 Create src/lib/f1-parsers.ts
Write-Utf8NoBom "src\lib\f1-parsers.ts" @'
/**
 * Shared parsers and fetch helpers for Ergast/Jolpica and OpenF1 APIs.
 * Deduplicates getJson, date ISO normalization, lap formatting, and status classification.
 */

export async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function toIso(session?: { date: string; time?: string | undefined } | null): string | null {
  if (!session?.date) return null;
  const d = new Date(`${session.date}T${session.time ?? "12:00:00Z"}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function fmtLap(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : s;
}

export function isClassifiedFinishStatus(
  status: string | null | undefined,
  includeLappedKeyword = true,
): boolean {
  if (!status) return false;
  return includeLappedKeyword
    ? /finished|lapped|\+\d+ lap/i.test(status)
    : /finished|\+\d+ lap/i.test(status);
}
'@

# 1.2 Create src/lib/shareActions.ts
Write-Utf8NoBom "src\lib\shareActions.ts" @'
import { toast } from "sonner";

/**
 * Shared actions for saving PNG blobs, Web Share API invocation,
 * clipboard copying, and Cairo timezone date formatting.
 */

export function saveBlob(blob: Blob, fileName: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
  toast.success("Image saved.");
}

export async function shareImageFile(
  blob: Blob,
  fileName: string,
  title: string,
): Promise<void> {
  const file = new File([blob], fileName, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return;
    }
  }
  saveBlob(blob, fileName);
}

export async function shareOrCopyText(text: string): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return;
    }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
}

export function formatCairoDate(iso: string | null | undefined, seconds = false): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d
    .toLocaleString("en-GB", {
      timeZone: "Africa/Cairo",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" as const } : {}),
    })
    .toUpperCase();
}
'@

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 2: Refactoring Share Components & Weekend RPCs" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 2.1 Refactor src/lib/weekend.functions.ts to use src/lib/f1-parsers.ts
$wkPath = "src\lib\weekend.functions.ts"
$wk = Read-Utf8Lf $wkPath
if (-not $wk.Contains('from "./f1-parsers"')) {
    $oldWkImport = 'import type { Json } from "@/integrations/supabase/types";'
    $newWkImport = (@'
import type { Json } from "@/integrations/supabase/types";
import { getJson, toIso as iso, fmtLap } from "./f1-parsers";
'@ -replace "\r\n", "`n").Trim()
    $wk = $wk.Replace($oldWkImport, $newWkImport)
}

$oldWkHelpers = (@'
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type JSess = { date: string; time?: string | undefined };
function iso(s: JSess | undefined): string | null {
  if (!s?.date) return null;
  const d = new Date(`${s.date}T${s.time ?? "12:00:00Z"}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fmtLap(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : s;
}
'@ -replace "\r\n", "`n")

if ($wk.Contains($oldWkHelpers)) {
    $wk = $wk.Replace($oldWkHelpers, "type JSess = { date: string; time?: string | undefined };")
}
Write-Utf8NoBom $wkPath $wk

# 2.2 Refactor src/components/SharePicks.tsx
$spkPath = "src\components\SharePicks.tsx"
$spk = Read-Utf8Lf $spkPath
if (-not $spk.Contains('from "@/lib/shareActions"')) {
    $oldSpkImport = 'import type { CardData, CardDriver } from "@/lib/shareCard";'
    $newSpkImport = (@'
import type { CardData, CardDriver } from "@/lib/shareCard";
import { saveBlob, shareImageFile, shareOrCopyText } from "@/lib/shareActions";
'@ -replace "\r\n", "`n").Trim()
    $spk = $spk.Replace($oldSpkImport, $newSpkImport)
}

$oldSpkActions = (@'
  function saveBlob(blob: Blob) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
    toast.success("Image saved.");
  }

  async function handleDownloadImage() {
    const blob = cachedBlob ?? (await (await import("@/lib/shareCard")).renderPickCard(cardData()));
    if (!blob) {
      toast.error("Couldn't create the image.");
      return;
    }
    saveBlob(blob);
  }

  async function handleShareImage() {
    const blob = cachedBlob ?? (await (await import("@/lib/shareCard")).renderPickCard(cardData()));
    if (!blob) {
      toast.error("Couldn't create the image.");
      return;
    }
    const file = new File([blob], fileName, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `DOWNFORCE \u2014 ${raceName}` });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return; // user closed the share sheet
      }
    }
    saveBlob(blob); // browser can't share images: download instead
  }

  async function nativeShareText() {
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  }
'@ -replace "\r\n", "`n")

$oldSpkActionsRaw = $oldSpkActions.Replace("\u2014", [string][char]0x2014)

$newSpkActions = (@'
  async function handleDownloadImage() {
    const blob = cachedBlob ?? (await (await import("@/lib/shareCard")).renderPickCard(cardData()));
    if (!blob) { toast.error("Couldn't create the image."); return; }
    saveBlob(blob, fileName);
  }

  async function handleShareImage() {
    const blob = cachedBlob ?? (await (await import("@/lib/shareCard")).renderPickCard(cardData()));
    if (!blob) { toast.error("Couldn't create the image."); return; }
    await shareImageFile(blob, fileName, `DOWNFORCE \u2014 ${raceName}`);
  }
'@ -replace "\r\n", "`n")

if ($spk.Contains($oldSpkActionsRaw)) {
    $spk = $spk.Replace($oldSpkActionsRaw, $newSpkActions)
}
$spk = $spk.Replace('onClick={nativeShareText}', 'onClick={() => shareOrCopyText(text)}')
Write-Utf8NoBom $spkPath $spk

# 2.3 Refactor src/components/SharePole.tsx
$splPath = "src\components\SharePole.tsx"
$spl = Read-Utf8Lf $splPath
$oldSplImport = 'import type { PoleCardData } from "@/lib/shareCard"; const formatCairo = (iso?: string | null) => iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).toUpperCase() : null;'
$newSplImport = (@'
import type { PoleCardData } from "@/lib/shareCard";
import { saveBlob, shareImageFile, shareOrCopyText, formatCairoDate } from "@/lib/shareActions";
'@ -replace "\r\n", "`n").Trim()
if ($spl.Contains($oldSplImport)) {
    $spl = $spl.Replace($oldSplImport, $newSplImport)
}
$spl = $spl.Replace('const when = formatCairo(savedAt, true);', 'const when = formatCairoDate(savedAt, true);')

$oldSplActions = (@'
  function saveBlob(blob: Blob) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
    toast.success("Image saved.");
  }

  async function handleDownload() {
    const blob = cachedBlob ?? (await (await import("@/lib/shareCard")).renderPoleCard(card()));
    if (!blob) {
      toast.error("Couldn't create the image.");
      return;
    }
    saveBlob(blob);
  }

  async function handleShareImage() {
    const blob = cachedBlob ?? (await (await import("@/lib/shareCard")).renderPoleCard(card()));
    if (!blob) {
      toast.error("Couldn't create the image.");
      return;
    }
    const file = new File([blob], fileName, { type: "image/png" });
    

    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `DOWNFORCE \u2014 ${raceName} pole pick` });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return;
      }
    }
    saveBlob(blob);
  }

  async function shareText() {
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  }
'@ -replace "\r\n", "`n")

$oldSplActionsRaw = $oldSplActions.Replace("\u2014", [string][char]0x2014)

$newSplActions = (@'
  async function handleDownload() {
    const blob = cachedBlob ?? (await (await import("@/lib/shareCard")).renderPoleCard(card()));
    if (!blob) { toast.error("Couldn't create the image."); return; }
    saveBlob(blob, fileName);
  }

  async function handleShareImage() {
    const blob = cachedBlob ?? (await (await import("@/lib/shareCard")).renderPoleCard(card()));
    if (!blob) { toast.error("Couldn't create the image."); return; }
    await shareImageFile(blob, fileName, `DOWNFORCE \u2014 ${raceName} pole pick`);
  }
'@ -replace "\r\n", "`n")

if ($spl.Contains($oldSplActionsRaw)) {
    $spl = $spl.Replace($oldSplActionsRaw, $newSplActions)
}
$spl = $spl.Replace('onClick={shareText}', 'onClick={() => shareOrCopyText(text)}')
Write-Utf8NoBom $splPath $spl

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 3: Hardening WebPush, Stewards, F1 Sync & Server Entry" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 3.1 Harden src/lib/webpush-native.ts (Server-only guard + remove hardcoded private key fallback)
$wpPath = "src\lib\webpush-native.ts"
$wp = Read-Utf8Lf $wpPath
$wp = $wp.Replace('const DEFAULT_VAPID_PRIVATE = "SowWFCNDsBlHZ3SW6l-nm3qjvEW-kG0DkVZTq8dIjJs";', 'const DEFAULT_VAPID_PRIVATE = "";')
if (-not $wp.Contains("Server-Only module")) {
    $guard = (@'
if (typeof window !== "undefined") {
  throw new Error("Security violation: webpush-native is a Server-Only module and must never be imported in browser code.");
}
'@ -replace "\r\n", "`n").Trim()
    $wp = $guard + "`n`n" + $wp
}
$oldSendSig = (@'
export async function sendNativeWebPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payloadObj: { title: string; body: string; tag?: string; url?: string },
): Promise<{ ok: boolean; status: number }> {
  const pub = process.env["VAPID_PUBLIC_KEY"] || DEFAULT_VAPID_PUBLIC;
  const priv = process.env["VAPID_PRIVATE_KEY"] || DEFAULT_VAPID_PRIVATE;
  const payloadStr = JSON.stringify(payloadObj);
'@ -replace "\r\n", "`n")

$newSendSig = (@'
export async function sendNativeWebPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payloadObj: { title: string; body: string; tag?: string; url?: string },
): Promise<{ ok: boolean; status: number }> {
  const pub = process.env["VITE_VAPID_PUBLIC_KEY"] || process.env["VAPID_PUBLIC_KEY"] || DEFAULT_VAPID_PUBLIC;
  const priv = process.env["VAPID_PRIVATE_KEY"] || DEFAULT_VAPID_PRIVATE;
  if (!pub || !priv) return { ok: false, status: 0 };
  const payloadStr = JSON.stringify(payloadObj);
'@ -replace "\r\n", "`n")
if ($wp.Contains($oldSendSig)) {
    $wp = $wp.Replace($oldSendSig, $newSendSig)
}
Write-Utf8NoBom $wpPath $wp

# 3.2 Update src/lib/push.functions.ts to pass object payload to sendNativeWebPush (and dynamic import)
Write-Utf8NoBom "src\lib\push.functions.ts" @'
import { createServerFn } from "@tanstack/react-start";

import {
  VAPID_PRIVATE_KEY,
  VAPID_PUBLIC_KEY,
  isCompleteTop10,
  parsePushSubscriptionKey,
} from "@/lib/push-keys";

export const checkAndSendRaceReminders = createServerFn({ method: "POST" })
  .inputValidator((input: { forceWindow?: "2h" | "30m" | null } | undefined) => ({
    forceWindow: input?.forceWindow ?? null,
  }))
  .handler(async () => {
    const pub = VAPID_PUBLIC_KEY;
    const priv = VAPID_PRIVATE_KEY;
    if (!pub || !priv) return { sent: 0, reason: "VAPID keys not configured" };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { sendNativeWebPush } = await import("@/lib/webpush-native");
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

    // Strictly enforce real countdown windows
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

    const payloadObj = {
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
    };

    let sent = 0;
    const newlyNotified = new Set<string>();
    const BATCH_SIZE = 25;
    for (let i = 0; i < targetSubs.length; i += BATCH_SIZE) {
      const batch = targetSubs.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        batch.map(async (sub) => {
          try {
            const res = await sendNativeWebPush(
              { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
              payloadObj,
            );
            if (res.ok) {
              sent++;
              newlyNotified.add(sub.userId);
            }
          } catch {
            // Ignore expired subscription
          }
        }),
      );
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

# 3.3 Refactor src/lib/stewards.functions.ts (dynamic webpush-native import, parsePushSubscriptionKey, strict deadline updates)
$stewPath = "src\lib\stewards.functions.ts"
$stew = Read-Utf8Lf $stewPath

# Remove unused scoreSprint import if present
$stew = $stew.Replace('import { scoreSprint, type SprintResultRow } from "./sprintScoring";', 'import { type SprintResultRow } from "./sprintScoring";')

# Remove top-level webpush-native import and add parsePushSubscriptionKey
$stew = $stew.Replace('import { sendNativeWebPush } from "./webpush-native";' + "`n", "")
if (-not $stew.Contains('import { parsePushSubscriptionKey } from "./push-keys";')) {
    $stew = $stew.Replace(
        'import { type ResultRow } from "./scoring";',
        "import { type ResultRow } from `"./scoring`";`nimport { parsePushSubscriptionKey } from `"./push-keys`";"
    )
}

if (-not $stew.Contains('await import("./webpush-native")')) {
    $stew = $stew.Replace(
        "    const sb = await requireSteward(context);",
        "    const sb = await requireSteward(context);`n    const { sendNativeWebPush } = await import(`"./webpush-native`");"
    )
    # Only keep dynamic import inside executeStewardAction (not getStewardsDashboard / exportLeagueBackup)
    $stew = $stew.Replace(
        "  .handler(async ({ data, context }) => {`n    const sb = await requireSteward(context);`n    const { sendNativeWebPush } = await import(`"./webpush-native`");",
        "  .handler(async ({ data, context }) => {`n    const sb = await requireSteward(context);"
    )
    $stew = $stew.Replace(
        "  .handler(async ({ context }) => {`n    const sb = await requireSteward(context);`n    const { sendNativeWebPush } = await import(`"./webpush-native`");",
        "  .handler(async ({ context }) => {`n    const sb = await requireSteward(context);"
    )
}

# Fix exact deadline type in stewards.functions.ts
$oldSetExact = (@'
    if (d.action === "set_exact_deadline" && d.raceId && d.isoTime) {
      const col = d.target === "qualifying" ? "qualifying_at" : "race_at";
      const parsed = new Date(d.isoTime);
      if (Number.isNaN(parsed.getTime())) throw new Error("Invalid date/time format");
      const { error } = await sb.from("races").update({ [col]: parsed.toISOString() }).eq("id", d.raceId);
'@ -replace "\r\n", "`n")

$newSetExact = (@'
    if (d.action === "set_exact_deadline" && d.raceId && d.isoTime) {
      const parsed = new Date(d.isoTime);
      if (Number.isNaN(parsed.getTime())) throw new Error("Invalid date/time format");
      const updateData = d.target === "qualifying"
        ? { qualifying_at: parsed.toISOString() }
        : { race_at: parsed.toISOString() };
      const { error } = await sb.from("races").update(updateData).eq("id", d.raceId);
'@ -replace "\r\n", "`n")
if ($stew.Contains($oldSetExact)) {
    $stew = $stew.Replace($oldSetExact, $newSetExact)
}

# Fix shift deadline type in stewards.functions.ts
$oldShift = (@'
    if (d.action === "shift_deadline" && d.raceId && d.minutes != null) {
      const { data: r } = await sb.from("races").select("race_at, qualifying_at").eq("id", d.raceId).single();
      if (!r) throw new Error("Race not found");
      const col = d.target === "qualifying" ? "qualifying_at" : "race_at";
      const cur = (d.target === "qualifying" ? r.qualifying_at : r.race_at) ?? r.race_at;
      const nextIso = new Date(new Date(cur).getTime() + d.minutes * 60_000).toISOString();
      const { error } = await sb.from("races").update({ [col]: nextIso }).eq("id", d.raceId);
'@ -replace "\r\n", "`n")

$newShift = (@'
    if (d.action === "shift_deadline" && d.raceId && d.minutes != null) {
      const { data: r } = await sb.from("races").select("race_at, qualifying_at").eq("id", d.raceId).single();
      if (!r) throw new Error("Race not found");
      const cur = (d.target === "qualifying" ? r.qualifying_at : r.race_at) ?? r.race_at;
      const nextIso = new Date(new Date(cur).getTime() + d.minutes * 60_000).toISOString();
      const updateData = d.target === "qualifying"
        ? { qualifying_at: nextIso }
        : { race_at: nextIso };
      const { error } = await sb.from("races").update(updateData).eq("id", d.raceId);
'@ -replace "\r\n", "`n")
if ($stew.Contains($oldShift)) {
    $stew = $stew.Replace($oldShift, $newShift)
}

# Use parsePushSubscriptionKey in stewards.functions.ts
$oldTestPush = (@'
      for (const r of subRows) {
        const m = /^push_sub:([^:]+):(.+)$/.exec(r.key);
        if (!m) continue;
        const sub = JSON.parse(m[2]!) as { endpoint: string; p256dh: string; auth: string };
        const res = await sendNativeWebPush(sub, {
'@ -replace "\r\n", "`n")

$newTestPush = (@'
      for (const r of subRows) {
        const sub = parsePushSubscriptionKey(r.key);
        if (!sub) continue;
        const res = await sendNativeWebPush(sub, {
'@ -replace "\r\n", "`n")
if ($stew.Contains($oldTestPush)) {
    $stew = $stew.Replace($oldTestPush, $newTestPush)
}

$oldNudgeTasks = (@'
      const tasks = (subRows ?? []).map(async (r) => {
        const m = /^push_sub:([^:]+):(.+)$/.exec(r.key);
        if (!m) return;
        const uid = m[1]!;
        if (completedUsers.has(uid)) return;
        try {
          const sub = JSON.parse(m[2]!) as { endpoint: string; p256dh: string; auth: string };
          const res = await sendNativeWebPush(sub, payloadObj);
          if (res.ok) {
            reachedUserIds.add(uid);
          } else if (res.status === 404 || res.status === 410) {
            deadKeys.push(r.key);
          }
        } catch {}
      });
'@ -replace "\r\n", "`n")

$newNudgeTasks = (@'
      const tasks = (subRows ?? []).map(async (r) => {
        const parsed = parsePushSubscriptionKey(r.key);
        if (!parsed || completedUsers.has(parsed.userId)) return;
        try {
          const res = await sendNativeWebPush(parsed, payloadObj);
          if (res.ok) {
            reachedUserIds.add(parsed.userId);
          } else if (res.status === 404 || res.status === 410) {
            deadKeys.push(r.key);
          }
        } catch {}
      });
'@ -replace "\r\n", "`n")
if ($stew.Contains($oldNudgeTasks)) {
    $stew = $stew.Replace($oldNudgeTasks, $newNudgeTasks)
}
Write-Utf8NoBom $stewPath $stew

# 3.4 Refactor src/lib/f1-sync.functions.ts (f1-parsers, parsePushSubscriptionKey, dynamic webpush-native, inFlightSyncLock, batching)
$syncPath = "src\lib\f1-sync.functions.ts"
$sync = Read-Utf8Lf $syncPath

$sync = $sync.Replace('import type { Json } from "@/integrations/supabase/types";' + "`n", "")
$sync = $sync.Replace('import { scoreSprint, type SprintResultRow } from "./sprintScoring";', 'import { type SprintResultRow } from "./sprintScoring";')
$sync = $sync.Replace('import { sendNativeWebPush } from "./webpush-native";', 'import { getJson, toIso, isClassifiedFinishStatus } from "./f1-parsers";' + "`n" + 'import { parsePushSubscriptionKey } from "./push-keys";')

$oldSyncHelpers = (@'
function toIso(session: { date: string; time?: string | undefined } | undefined): string | null {
  if (!session?.date) return null;
  return new Date(`${session.date}T${session.time ?? "12:00:00Z"}`).toISOString();
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
'@ -replace "\r\n", "`n")
if ($sync.Contains($oldSyncHelpers)) {
    $sync = $sync.Replace($oldSyncHelpers + "`n", "")
}

if (-not $sync.Contains("inFlightSyncLock")) {
    $sync = $sync.Replace(
        "const userSyncCalls = new Map<string, number>();",
        "const userSyncCalls = new Map<string, number>();`nlet inFlightSyncLock = false;"
    )
}

$oldRateCheck = (@'
    if (Date.now() - lastCall < minInterval) {
      if (!data.force) return { skipped: true as const };
      throw new Error("Please wait a few seconds before syncing again.");
    }
    userSyncCalls.set(userId, Date.now());
'@ -replace "\r\n", "`n")

$newRateCheck = (@'
    if (Date.now() - lastCall < minInterval) {
      if (!data.force) return { skipped: true as const };
      throw new Error("Please wait a few seconds before syncing again.");
    }
    if (userSyncCalls.size > 500) {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [k, ts] of userSyncCalls) {
        if (ts < cutoff) userSyncCalls.delete(k);
      }
    }
    userSyncCalls.set(userId, Date.now());
    if (!data.force && inFlightSyncLock) {
      return { skipped: true as const };
    }
'@ -replace "\r\n", "`n")
if ($sync.Contains($oldRateCheck)) {
    $sync = $sync.Replace($oldRateCheck, $newRateCheck)
}

if (-not $sync.Contains("inFlightSyncLock = true;")) {
    $sync = $sync.Replace(
        "    // ---- Calendar (preserving Steward custom deadline overrides!) ----",
        "    inFlightSyncLock = true;`n    try {`n    // ---- Calendar (preserving Steward custom deadline overrides!) ----"
    )
    $sync = $sync.Replace(
        "    return { skipped: false as const, races: races.length, scored: racesWithResults.length };`n  });",
        "    return { skipped: false as const, races: races.length, scored: racesWithResults.length };`n    } finally { inFlightSyncLock = false; }`n  });"
    )
}

$sync = $sync.Replace('const finished = /finished|lapped|\+\d+ lap/i.test(status);', 'const finished = isClassifiedFinishStatus(status, true);')

$oldPushLoop = (@'
        const deadKeys: string[] = [];
        for (const r of subRows) {
          const m = /^push_sub:([^:]+):(.+)$/.exec(r.key);
          if (!m) continue;
          if (doneUsers.has(m[1]!)) continue;
          try {
            const sub = JSON.parse(m[2]!) as { endpoint: string; p256dh: string; auth: string };
            const res = await sendNativeWebPush(sub, payloadObj);
            if (res.ok) totalSent++;
            else if (res.status === 404 || res.status === 410) deadKeys.push(r.key);
          } catch {}
        }
'@ -replace "\r\n", "`n")

$newPushLoop = (@'
        const { sendNativeWebPush } = await import("./webpush-native");
        const deadKeys: string[] = [];
        const pendingSubs = subRows.flatMap((r) => {
          const parsed = parsePushSubscriptionKey(r.key);
          return parsed && !doneUsers.has(parsed.userId) ? [parsed] : [];
        });
        const BATCH_SIZE = 25;
        for (let i = 0; i < pendingSubs.length; i += BATCH_SIZE) {
          const batch = pendingSubs.slice(i, i + BATCH_SIZE);
          await Promise.allSettled(
            batch.map(async (sub) => {
              try {
                const res = await sendNativeWebPush(sub, payloadObj);
                if (res.ok) totalSent++;
                else if (res.status === 404 || res.status === 410) deadKeys.push(sub.rawKey);
              } catch {}
            }),
          );
        }
'@ -replace "\r\n", "`n")
if ($sync.Contains($oldPushLoop)) {
    $sync = $sync.Replace($oldPushLoop, $newPushLoop)
}
Write-Utf8NoBom $syncPath $sync

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 4: Scale Hardening (queries.ts, BackgroundSync.tsx, server.ts)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 4.1 Bypass Supabase 1,000-row cap in src/lib/queries.ts
$qPath = "src\lib\queries.ts"
$q = Read-Utf8Lf $qPath
$oldQ = (@'
    const [
      { data: scores, error: sErr },
      { data: profiles, error: pErr },
      { data: raceRows },
    ] = await Promise.all([
      supabase.from("scores").select("user_id, race_id, points"),
      supabase.from("profiles").select("id, display_name, avatar_url"),
      supabase.from("races").select("id, round").eq("season", SEASON),
    ]);
'@ -replace "\r\n", "`n")

$newQ = (@'
    const [
      { data: scores, error: sErr },
      { data: profiles, error: pErr },
      { data: raceRows },
    ] = await Promise.all([
      supabase.from("scores").select("user_id, race_id, points").limit(50000),
      supabase.from("profiles").select("id, display_name, avatar_url").limit(10000),
      supabase.from("races").select("id, round").eq("season", SEASON),
    ]);
'@ -replace "\r\n", "`n")
if ($q.Contains($oldQ)) {
    $q = $q.Replace($oldQ, $newQ)
    Write-Utf8NoBom $qPath $q
}

# 4.2 Add random jitter in src/components/BackgroundSync.tsx
$bgPath = "src\components\BackgroundSync.tsx"
$bg = Read-Utf8Lf $bgPath
$bg = $bg.Replace("if (idle) idle(run, { timeout: 4000 });", "if (idle) window.setTimeout(() => idle(run, { timeout: 4000 }), Math.floor(Math.random() * 2500));")
$bg = $bg.Replace("else window.setTimeout(run, 1500);", "else window.setTimeout(run, 1500 + Math.floor(Math.random() * 4000));")
Write-Utf8NoBom $bgPath $bg

# 4.3 Add HTTP Security Headers in src/server.ts
Write-Utf8NoBom "src\server.ts" @'
import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "X-Permitted-Cross-Domain-Policies": "none",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) {
      headers.set(k, v);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const rawResponse = await handler.fetch(request, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(rawResponse);
      return withSecurityHeaders(normalized);
    } catch (error) {
      console.error(error);
      return withSecurityHeaders(
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
  },
};
'@

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 5: Running Production Build Verification (npm run build)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n  [ERROR] Production build failed! Rolling back Phase 2 changes..." -ForegroundColor Red
    git checkout -- .
    Remove-Item -Path "src\lib\f1-parsers.ts" -ErrorAction SilentlyContinue
    Remove-Item -Path "src\lib\shareActions.ts" -ErrorAction SilentlyContinue
    exit 1
}

$clientAssetsDir = Join-Path (Get-Location).Path ".output\public"
if (Test-Path $clientAssetsDir) {
    $leaks = Get-ChildItem -Path $clientAssetsDir -Recurse -Include *.js | Select-String -Pattern "SowWFCNDsBlHZ3SW6l"
    if ($leaks) {
        Write-Host "  [WARNING] Private key found in client bundle!" -ForegroundColor Red
        exit 1
    } else {
        Write-Host "  [PASS] Verified 0 private keys in client JS bundle (.output/public)!" -ForegroundColor Green
    }
}

Write-Host "`n  [PASS] Production build succeeded with 0 errors!" -ForegroundColor Green

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "STEP 6: Committing & Pushing Phase 2 to GitHub (origin/main)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

git add -A
git commit -m "Phase 2: extract f1-parsers & shareActions, harden webpush-native, add 50k leaderboard limit, sync lock, and HTTP security headers"
git push origin main

Write-Host "`n==================================================================" -ForegroundColor Green
Write-Host "SUCCESS! Phase 2 is complete, verified, and pushed to origin/main!" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
