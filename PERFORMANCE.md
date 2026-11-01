# DOWNFORCE — Performance Baseline ("Before")

Recorded: 2026-10-31 (pre-optimization). Purpose: freeze a comparable "Before" baseline.
After each fix batch, append an "After (date)" column set to each table — never edit the Before values.

Baseline context (measured in the 2026-10-31 production audit, single anonymous runs):
- Home: TTFB 2540 ms / DCL 5196 ms / full load 6777 ms; 9 long tasks totaling 4158 ms (max 1213 ms).
- SPA transition / → /leaderboard: ~4057 ms. Home makes 1 Supabase call; after navigation 4 (races ×2, drivers ×2 — duplicate keys).
- Client JS: ~997 KB total across chunks; core entry ~580 KB. Route-level code splitting confirmed working.
- FCP/LCP/INP/CLS were not reliably measurable in that environment — the protocol below collects them properly.

---

## 1. Measurement protocol — repeat every time the same way

### Pages (Lighthouse, mobile, throttled)
1. Chrome (desktop) → DevTools → Lighthouse tab. Mode: Navigation. Device: **Mobile**. Keep default throttling ON (Slow 4G, 4× CPU slowdown).
2. Sign in first (typical usage), normal browsing profile, but enable "Disable cache" in the Network tab.
3. Navigate to the page, wait for full load, then run the audit. **Run 3× per page and record the median** of LCP, INP, CLS.
4. From the Network tab (hard reload, cache disabled):
   - **Total JS**: filter JS — sum the "Transfer Size" column.
   - **Image weight**: filter Img — sum Transfer Size.
   - **Requests**: total request count (All filter).
5. Enter values in the table below. Note: INP needs real interaction — after the audit, scroll and tap around for ~30 s and read INP from the Chrome Web Vitals extension or the Performance panel.

### Endpoints (server functions)
All five are TanStack Start serverFn POSTs (auth-checked except where noted), visible in DevTools → Network → Fetch/XHR while using the app.
1. Open the page that triggers the endpoint and let it poll naturally (weekend pages poll every 20–25 s).
2. Collect **at least 5 samples** per endpoint; record the average and the slowest "Time" value.
3. DB queries per request are already counted statically from source (below) — no runtime counting needed.

---

## 2. Baseline — Pages (Before, 2026-10-31)

| Page | LCP (ms) | INP (ms) | CLS | Total JS (KB) | Images (KB) | Requests |
|---|---|---|---|---|---|---|
| `/` Home | — | — | — | ~997 (all chunks, build) | — | — |
| `/predict` | — | — | — | — | — | — |
| `/leaderboard` | — | — | — | — | — | — |
| `/weekend` | — | — | — | — | — | — |
| `/paddock` | — | — | — | — | — | — |

Fill the empty cells using the protocol above (3-run medians). Do not delete the pre-filled measured values.

---

## 3. Baseline — Endpoints (Before, 2026-10-31)

| # | Endpoint (serverFn) | Trigger / cadence | Avg (ms) | Slowest (ms) | DB queries per request (static code count) | Notes |
|---|---|---|---|---|---|---|
| 1 | `syncF1Data` | BackgroundSync ≤ every 10 min per visitor | — | — | **1** when data fresh (<5 min window, skips); **6–8** steady state; **+8 per newly scored race** (6 parallel reads + scores upsert); up to ~20 on backfill | Writes: races/drivers/race_results/scores/sync_state upserts, errors currently unchecked |
| 2 | `checkAndSendRaceReminders` | BackgroundSync + /reminders cron (every 10 min) | — | — | **2** when no window is active; **~6–10** during reminder windows (per window: dedup read + predictions read + result writes) | Per-user dedup keys; batches of 25 push sends |
| 3 | `getWeekendSession` | /weekend page, every 20 s while a session is live | — | — | **2** post-session (served from DB); **~4 live** (+1 drivers read + 1 classification persist) | Live path adds up to 4 external provider engines (Jolpica/OpenF1/F1 Live/ESPN); 20 s shared server cache + in-flight dedup |
| 4 | `getLiveRaceTelemetry` | /weekend + /paddock, every 25 s during a race | — | — | **1** when served from 20 s cache (loadRace only); **4** when race already official; **~13 live** (pole resolve + 5-parallel score reads + finalize upserts race_results/races/scores) | Can finalize results + scores server-side; up to 5–8 external calls per live sweep |
| 5 | `getReminderStats` | /reminders page views | — | — | **2** (predictions + profiles) | Auth-gated; counts only, never pick contents |

Endpoint timing cells stay empty until measured per the protocol — average and slowest of ≥5 samples.

---

## 4. After (append only)

| Fix / batch | Date | Pages re-measured | Endpoints re-measured | Delta summary |
|---|---|---|---|---|
| — | — | — | — | — |

Add one row per fix batch with its measured deltas (Before → After for LCP/INP/CLS/JS/requests and endpoint avg/slowest).
