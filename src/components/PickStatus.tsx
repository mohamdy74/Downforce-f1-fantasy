import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarPlus, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Skeleton } from "@/components/LoadingSkeleton";
import { Button } from "@/components/ui/button";
import { TelegramInline } from "@/components/TelegramSettings";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { isCompleteTop10 } from "@/lib/push-keys";
import { getTrustedNow, type Race } from "@/lib/queries";
import { cn } from "@/lib/utils";

export function PickStatus({ race }: { race: Race }) {
  const { user } = useAuth();
  const [host, setHost] = useState("");

  useEffect(() => {
    setHost(window.location.host);
  }, []);

  const { data: submitted } = useQuery({
    queryKey: ["has-prediction", race.id, user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("predictions")
        .select("id, top10")
        .eq("race_id", race.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return !!data && isCompleteTop10(data.top10);
    },
  });

  const locked = new Date(race.race_at).getTime() <= getTrustedNow();

  // "Remind me" goes straight to Google Calendar and subscribes to the season
  // feed: every Grand Prix and Sprint lock lands in the calendar with 90-minute
  // and 30-minute alarms ready — no file download, no per-race setup.
  const gcalHref = host
    ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(`webcal://${host}/api/calendar.ics`)}`
    : undefined;

  if (!user) {
    return (
      <div
        className="carbon-panel mb-6 flex flex-wrap items-center gap-3 rounded-lg border-l-4 p-4"
        style={{ borderLeftColor: "var(--gold)" }}
      >
        <AlertTriangle className="h-5 w-5 shrink-0 text-gold" />
        <p className="min-w-0 flex-1 text-sm">
          Sign in to lock in your picks for <strong>{race.name}</strong>.
        </p>
        <Button asChild size="sm">
          <Link to="/auth">Sign in</Link>
        </Button>
      </div>
    );
  }

  if (submitted === undefined) {
    // Reserved-height stand-in so the banner slot never collapses while the
    // has-prediction query resolves — removes the home-page layout shift.
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Checking your pick status"
        className="carbon-panel mb-6 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3 rounded-lg border-l-4 border-border p-4"
      >
        <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
        <div className="min-w-0 space-y-1.5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <div className="col-start-2 flex flex-wrap gap-2">
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
      </div>
    );
  }
  const ok = !!submitted;

  return (
    <div
      className={cn(
        "carbon-panel mb-6 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3 rounded-lg border-l-4 p-4",
      )}
      style={{ borderLeftColor: ok ? "var(--track-green)" : "var(--color-primary)" }}
    >
      {ok ? (
        <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: "var(--track-green)" }} />
      ) : (
        <AlertTriangle
          className={cn("h-5 w-5 shrink-0 text-primary", !locked && "animate-pulse")}
        />
      )}
      <p className="min-w-0 text-sm leading-snug">
        {ok ? (
          <>
            Your picks are in for <strong>{race.name}</strong> — tap to review or edit.
          </>
        ) : locked ? (
          <>
            Picks closed for <strong>{race.name}</strong>.
          </>
        ) : (
          <>
            You haven&apos;t submitted picks for <strong>{race.name}</strong> yet — missing out
            costs you 25 points.
          </>
        )}
      </p>
      <div className="col-start-2 flex flex-wrap gap-2">
        {!locked &&
          (gcalHref ? (
            <Button asChild size="sm" variant="secondary">
              <a href={gcalHref} target="_blank" rel="noreferrer noopener">
                <CalendarPlus className="mr-1 h-4 w-4" />
                Remind me
              </a>
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled>
              <CalendarPlus className="mr-1 h-4 w-4" />
              Remind me
            </Button>
          ))}
        <Button asChild size="sm" variant={ok ? "secondary" : "default"}>
          <Link to="/predict">{ok ? "Review" : "Predict"}</Link>
        </Button>
      </div>
      <div className="col-span-full border-t border-border/60 pt-3">
        <TelegramInline />
      </div>
    </div>
  );
}
