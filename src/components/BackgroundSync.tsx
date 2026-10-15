import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { syncF1Data } from "@/lib/f1-sync.functions";

const MIN_GAP_MS = 10 * 60 * 1000;
const STORAGE_KEY = "dfr:last-bg-sync-ts";

declare global {
  interface Window {
    __dfrClockOffsetMs?: number;
  }
}

export function getTrustedNow(): number {
  if (typeof window !== "undefined" && typeof window.__dfrClockOffsetMs === "number") {
    return Date.now() + window.__dfrClockOffsetMs;
  }
  return Date.now();
}

async function calibrateServerClock() {
  if (typeof window === "undefined" || typeof window.__dfrClockOffsetMs === "number") return;
  try {
    const t0 = Date.now();
    const res = await fetch(window.location.origin + "/manifest.webmanifest", {
      method: "HEAD",
      cache: "no-store",
    });
    const dateHdr = res.headers.get("date");
    if (dateHdr) {
      const serverMs = new Date(dateHdr).getTime();
      const rtt = Date.now() - t0;
      if (!Number.isNaN(serverMs)) {
        const skew = serverMs + rtt / 2 - Date.now();
        // Only apply offset if device clock is off by more than 5 seconds
        window.__dfrClockOffsetMs = Math.abs(skew) > 5000 ? skew : 0;
      }
    }
  } catch {
    /* ignore offline */
  }
}

function readLastSync(): number {
  try {
    return Number(window.sessionStorage.getItem(STORAGE_KEY) || "0");
  } catch {
    return 0;
  }
}

function writeLastSync(ts: number) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, String(ts));
  } catch {
    /* ignore */
  }
}

export function BackgroundSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    calibrateServerClock();
    let running = false;

    const run = () => {
      const now = Date.now();
      if (running || now - readLastSync() < MIN_GAP_MS) return;
      running = true;
      writeLastSync(now);

      syncF1Data({ data: {} })
        .then((res) => {
          const path = window.location.pathname;
          if (path === "/predict" || path === "/sprint") return null;
          if (res && typeof res === "object" && "skipped" in res && res.skipped) return null;
          return Promise.all([
            queryClient.invalidateQueries({ queryKey: ["races"] }),
            queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
          ]);
        })
        .catch(() => null)
        .finally(() => {
          running = false;
        });
    };

    const idle = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (idle) idle(run, { timeout: 4000 });
    else window.setTimeout(run, 1500);

    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [queryClient]);

  return null;
}
