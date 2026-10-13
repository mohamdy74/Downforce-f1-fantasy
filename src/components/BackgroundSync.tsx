import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { syncF1Data } from "@/lib/f1-sync.functions";

const MIN_GAP_MS = 10 * 60 * 1000;

/**
 * Runs the (server-throttled) race data sync in the background, after the page is
 * already on screen, so navigating never waits for it. When it finishes, the
 * cached races and standings are refreshed quietly.
 */
export function BackgroundSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let last = 0;
    let running = false;

    const run = () => {
      if (running || Date.now() - last < MIN_GAP_MS) return;
      running = true;
      last = Date.now();
      import("@/integrations/supabase/client").then(({ supabase }) => supabase.auth.getSession()).then(({ data }) => (data.session ? syncF1Data({ data: {} }) : null))
        .then(() =>
          Promise.all([
            queryClient.invalidateQueries({ queryKey: ["races"] }),
            queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
          ]),
        )
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
