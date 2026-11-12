import { createFileRoute } from "@tanstack/react-router";
import { readServerEnv } from "@/lib/env";
import { buildCalendarIcs, type IcsRace } from "@/lib/telegram";

const SEASON = 2026;

// GET /api/calendar.ics — public, cacheable season feed. Public by design: it
// contains only race/lock times, no player data.
export const Route = createFileRoute("/api/calendar.ics")({
  staticData: { sitemap: false },
  server: {
    handlers: {
      GET: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin
          .from("races")
          .select(
            "id, round, name, circuit, locality, country, race_at, qualifying_at, has_sprint, sprint_at",
          )
          .eq("season", SEASON)
          .order("round", { ascending: true });

        if (error) {
          console.error("[calendar] races query failed:", error.message);
          return new Response("calendar unavailable", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }

        const body = buildCalendarIcs({
          races: (data ?? []) as IcsRace[],
          season: SEASON,
          appUrl: readServerEnv("APP_URL") ?? "https://downforce.lovable.app",
        });

        return new Response(body, {
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Cache-Control": "public, max-age=3600, s-maxage=3600",
            "Content-Disposition": 'inline; filename="downforce.ics"',
          },
        });
      },
    },
  },
});
