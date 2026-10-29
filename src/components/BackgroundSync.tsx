import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { syncBrowserSubscription } from "@/components/PushOptIn";
import { supabase } from "@/integrations/supabase/client";
import { syncF1Data } from "@/lib/f1-sync.functions";
import { checkAndSendRaceReminders } from "@/lib/push.functions";

const MIN_GAP_MS = 10 * 60 * 1000;
const BG_SYNC_LAST_KEY = "dfr:bg-sync:last-run";

export function BackgroundSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Persisted across reloads so a quick refresh doesn't re-run the full chain.
    let last = 0;
    try {
      last = Number(window.localStorage.getItem(BG_SYNC_LAST_KEY)) || 0;
    } catch {
      /* private mode: fall back to 0 */
    }
    let running = false;

    if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      supabase.auth
        .getSession()
        .then(({ data }) => {
          if (data.session) {
            syncBrowserSubscription().catch(() => {});
          }
        })
        .catch(() => {});
    }

    const run = async () => {
      if (document.visibilityState !== "visible") return;
      if (running || Date.now() - last < MIN_GAP_MS) return;
      running = true;
      last = Date.now();
      try {
        window.localStorage.setItem(BG_SYNC_LAST_KEY, String(last));
      } catch {
        /* ignore quota errors */
      }
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) return;
        if (
          typeof window !== "undefined" &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          await syncBrowserSubscription().catch(() => {});
        }
        await Promise.allSettled([
          syncF1Data({ data: {} }),
          checkAndSendRaceReminders({ data: {} }),
        ]);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["races"] }),
          queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
        ]);
      } catch {
        // ignore background sync errors
      } finally {
        running = false;
      }
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
