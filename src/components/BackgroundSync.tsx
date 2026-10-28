import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { supabase } from "@/integrations/supabase/client";
import { syncF1Data } from "@/lib/f1-sync.functions";
import { checkAndSendRaceReminders } from "@/lib/push.functions";

const MIN_GAP_MS = 15 * 60 * 1000;
const MAX_RETRIES = 3;

export function BackgroundSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let last = 0;
    let running = false;
    let retryCount = 0;

    const run = async () => {
      if (running || Date.now() - last < MIN_GAP_MS) return;
      running = true;
      last = Date.now();
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) return;
        
        if (document.visibilityState === "hidden") {
          await Promise.allSettled([
            syncF1Data({ data: {} }),
            checkAndSendRaceReminders({ data: {} }),
          ]);
        }
        
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

    const runWithRetry = async () => {
      try {
        await run();
        retryCount = 0;
      } catch {
        retryCount++;
        if (retryCount <= MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
          setTimeout(runWithRetry, delay);
        }
      }
    };

    const idle = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (idle) window.setTimeout(() => idle(runWithRetry, { timeout: 4000 }), Math.floor(Math.random() * 2500));
    else window.setTimeout(runWithRetry, 1500 + Math.floor(Math.random() * 4000));

    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [queryClient]);

  return null;
}
