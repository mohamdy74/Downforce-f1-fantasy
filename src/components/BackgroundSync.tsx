import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { supabase } from "@/integrations/supabase/client";
import { syncF1Data } from "@/lib/f1-sync.functions";
import { checkAndSendRaceReminders } from "@/lib/push.functions";

const MIN_GAP_MS = 30 * 1000;

export function BackgroundSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let last = 0;
    let running = false;

    const run = async () => {
      if (running || Date.now() - last < MIN_GAP_MS) return;
      running = true;
      last = Date.now();
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) return;

        await Promise.allSettled([
          syncF1Data({ data: { force: true } }),
          checkAndSendRaceReminders({ data: {} }),
        ]);

        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["races"] }),
          queryClient.invalidateQueries({ queryKey: ["drivers"] }),
          queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
        ]);
      } catch {
        running = false;
      }
    };

    const idle = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (idle) idle(run, { timeout: 100 });
    else run();

    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [queryClient]);

  return null;
}
