import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarPlus, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PushOptIn } from "@/components/PushOptIn";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { isCompleteTop10 } from "@/lib/push-keys";
import { getTrustedNow, type Race } from "@/lib/queries";
import { cn } from "@/lib/utils";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function icsStamp(d: Date) {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`
  );
}

/** The next deadline that has not passed yet: pole closes at qualifying, everything else at the race. */
function nextDeadline(race: Race): Date {
  const q = race.qualifying_at ? new Date(race.qualifying_at) : null;
  if (q && q.getTime() > getTrustedNow()) return q;
  return new Date(race.race_at);
}

function gcalStamp(d: Date) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Android: opens Google Calendar with the event filled in (one tap, no file to download). */
function addToGoogleCalendar(race: Race) {
  const deadline = nextDeadline(race);
  const start = new Date(deadline.getTime() - 60 * 60 * 1000);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `DOWNFORCE — picks close: ${race.name}`,
    dates: `${gcalStamp(start)}/${gcalStamp(deadline)}`,
    details: `Lock in your picks before the deadline to avoid the −25 penalty: ${window.location.origin}/predict`,
  });
  window.open(`https://calendar.google.com/calendar/render?${params.toString()}`, "_blank");
}

function remindMe(race: Race) {
  if (/android/i.test(navigator.userAgent)) addToGoogleCalendar(race);
  else addToCalendar(race);
}

/** Downloads a calendar reminder one hour before picks close. */
function addToCalendar(race: Race) {
  const deadline = nextDeadline(race);
  const start = new Date(deadline.getTime() - 60 * 60 * 1000);
  const end = new Date(deadline.getTime());
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DOWNFORCE//Fantasy Racing League//EN",
    "BEGIN:VEVENT",
    `UID:${race.id}@downforce`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:DOWNFORCE — picks close: ${race.name}`,
    `DESCRIPTION:Lock in your top 10 before the deadline to avoid the -25 penalty.`,
    "BEGIN:VALARM",
    "TRIGGER:-PT60M",
    "ACTION:DISPLAY",
    "DESCRIPTION:DOWNFORCE picks close in 1 hour",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `downforce-round-${race.round}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

export function PickStatus({ race }: { race: Race }) {
  const { user } = useAuth();

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

  if (!user) {
    return (
      <div className="carbon-panel mb-6 flex flex-wrap items-center gap-3 rounded-lg border-l-4 p-4" style={{ borderLeftColor: "var(--gold)" }}>
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

  if (submitted === undefined) return null; const ok = !!submitted;

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
        <AlertTriangle className={cn("h-5 w-5 shrink-0 text-primary", !locked && "animate-pulse")} />
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
            You haven&apos;t submitted picks for <strong>{race.name}</strong> yet — missing out costs
            you 25 points.
          </>
        )}
      </p>
      <div className="col-start-2 flex flex-wrap gap-2">
        {!locked && (
          <><Button size="sm" variant="secondary" onClick={() => remindMe(race)}>
            <CalendarPlus className="mr-1 h-4 w-4" />
            Remind me
          </Button>
          <PushOptIn /></>
        )}
        <Button asChild size="sm" variant={ok ? "secondary" : "default"}>
          <Link to="/predict">{ok ? "Review" : "Predict"}</Link>
        </Button>
      </div>
    </div>
  );
}
