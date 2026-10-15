import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { syncF1Data } from "@/lib/f1-sync.functions";

const MIN_GAP_MS = 10 * 60 * 1000;
const STORAGE_KEY = "dfr:last-bg-sync-ts";

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
    let running = false;

    const run = () => {
      const now = Date.now();
      if (running || now - readLastSync() < MIN_GAP_MS) return;
      running = true;
      writeLastSync(now);

      syncF1Data({ data: {} })
        .then((res) => {
          // Only invalidate queries if the user is not actively editing picks on /predict or /sprint
          const path = window.location.pathname;
          const isEditingPicks = path === "/predict" || path === "/sprint";
          if (!isEditingPicks && res && !("skipped" in res && res.skipped)) {
            return Promise.all([
              queryClient.invalidateQueries({ queryKey: ["races"] }),
              queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
            ]);
          }
          return null;
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
    else window.setTimeout(run, 2000);

    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [queryClient]);

  return null;
}
