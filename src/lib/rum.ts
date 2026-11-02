/**
 * Real-user performance monitoring (RUM) — zero dependencies, fully anonymous.
 *
 * Collects Core Web Vitals (LCP, INP, CLS), TTFB, page load time and
 * same-origin API-call durations straight from the browser's built-in
 * PerformanceObserver, batches them, and writes them to the web_vitals
 * table through the normal supabase client. The read side is SQL-only with
 * the service role (p75 dashboard queries, run in the SQL editor).
 *
 * Privacy by construction:
 * - No user id, no IP, no identifiers: a row is just
 *   (metric, value, route, device, conn, created_at).
 * - route is the bare pathname with the query string stripped, so no data
 *   from URLs ever reaches the database.
 * - Users signalling Global Privacy Control or Do-Not-Track are skipped
 *   entirely — nothing is observed for them.
 * - The table is INSERT-only for signed-in players via RLS; there is no
 *   SELECT policy, so not even signed-in players can read anyone's rows.
 *
 * Documented approximations (fine for p75 tracking):
 * - INP is reported as the worst interaction duration of the page view.
 *   Google's strict INP is the 98th percentile across interactions; with the
 *   handful of interactions a visit has, the two track each other closely.
 * - SPA client-side route changes keep accruing into the same visit bucket;
 *   the reported route is the one active when the metric is emitted.
 */

type VitalsMetric = "lcp" | "inp" | "cls" | "ttfb" | "load" | "api";

type VitalsRow = {
  metric: VitalsMetric;
  value: number;
  route: string;
  device: string;
  conn: string;
};

const MAX_ROUTE_LEN = 100;
const FLUSH_EVERY_MS = 10_000;
const MIN_ROWS_TO_FLUSH = 5;
const MAX_QUEUE = 60;

let started = false;
let queue: VitalsRow[] = [];
let flushTimer: ReturnType<typeof setInterval> | undefined;

function consentOk(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl) return false;
  const dnt = nav.doNotTrack;
  return dnt !== "1" && dnt !== "yes";
}

function currentRoute(): string {
  return window.location.pathname.slice(0, MAX_ROUTE_LEN) || "/";
}

function deviceType(): string {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  if (coarse) return window.innerWidth >= 768 ? "tablet" : "mobile";
  return "desktop";
}

function connectionType(): string {
  const nav = navigator as Navigator & { connection?: { effectiveType?: string } };
  return nav.connection?.effectiveType ?? "unknown";
}

async function flush(final = false): Promise<void> {
  if (final && flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  if (!queue.length) return;
  const rows = queue;
  queue = [];
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const {
      data: { session },
    } = await supabase.auth.getSession();
    // RLS is INSERT-only for authenticated; skip the doomed call when signed out.
    if (!session) return;
    const { error } = await supabase.from("web_vitals").insert(rows);
    if (error) console.debug("[rum] insert failed:", error.message);
  } catch {
    // RUM must never break the app — drop the batch silently.
  }
}

export function startRum(): void {
  if (typeof window === "undefined" || started) return;
  if (!consentOk()) return;
  started = true;

  const device = deviceType();
  const conn = connectionType();
  const push = (metric: VitalsMetric, value: number, route = currentRoute()): void => {
    if (queue.length >= MAX_QUEUE) return;
    const rounded = metric === "cls" ? Math.round(value * 1000) / 1000 : Math.round(value);
    queue.push({ metric, value: rounded, route: route.slice(0, MAX_ROUTE_LEN), device, conn });
  };

  // LCP — keep the latest largest-contentful-paint entry.
  let lcp = 0;
  new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const last = entries[entries.length - 1];
    if (last) lcp = last.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });

  // CLS — sum layout shifts the user did not cause with their own input.
  let cls = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!(entry as LayoutShift).hadRecentInput) cls += (entry as LayoutShift).value;
    }
  }).observe({ type: "layout-shift", buffered: true });

  // INP — worst interaction duration of this visit (approximation, see top).
  let inp = 0;
  const eventOpts: PerformanceObserverInit = { type: "event", buffered: true };
  (eventOpts as { durationThreshold?: number }).durationThreshold = 40;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration > inp) inp = entry.duration;
    }
  }).observe(eventOpts);

  // Backend response times as real users experience them: same-origin
  // fetch/XHR resource timings (supabase REST lives on another origin and is
  // excluded automatically). For these rows route holds the endpoint path.
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const res = entry as PerformanceResourceTiming;
      if (res.initiatorType !== "fetch" && res.initiatorType !== "xmlhttprequest") continue;
      if (!res.name.startsWith(window.location.origin)) continue;
      if (res.duration < 100) continue; // ignore noise
      push("api", res.duration, new URL(res.name).pathname);
    }
  }).observe({ type: "resource", buffered: true });

  // Report the page-scoped metrics once, when the visit first goes hidden,
  // then flush everything. Later tab switches only flush queued api rows.
  let reported = false;
  const onHidden = (): void => {
    if (document.visibilityState !== "hidden") return;
    if (!reported) {
      reported = true;
      push("lcp", lcp);
      push("cls", cls);
      push("inp", inp);
      const nav = performance.getEntriesByType("navigation")[0] as
        PerformanceNavigationTiming | undefined;
      if (nav) {
        push("ttfb", nav.responseStart);
        if (nav.loadEventEnd > 0) push("load", nav.loadEventEnd);
      }
    }
    void flush(true);
  };
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onHidden);

  // Periodic flush so long SPA sessions still ship their api timings.
  flushTimer = setInterval(() => {
    if (queue.length >= MIN_ROWS_TO_FLUSH) void flush();
  }, FLUSH_EVERY_MS);
}
