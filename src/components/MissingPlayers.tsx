import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, MessageCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import type { Race } from "@/lib/queries";
import { getPickRoster } from "@/lib/reminders.functions";

/**
 * "Who still has not locked in?" + a one-tap WhatsApp nudge.
 * Shows names only (never anyone's picks) and only while the race is still open.
 */
export function MissingPlayers({ race }: { race: Race }) {
  const { session, user } = useAuth();
  const token = session?.access_token;

  const { data } = useQuery({
    queryKey: ["pick-roster", race.id],
    enabled: !!token,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: 1,
    queryFn: () => getPickRoster({ data: { raceId: race.id, accessToken: token! } }),
  });

  if (!user || !data) return null;
  if (new Date(race.race_at).getTime() <= Date.now()) return null; // lock passed: nothing to remind

  const { missing, submitted } = data;
  if (missing.length === 0) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
        <span>Everyone has locked in ({submitted.length}/{submitted.length}).</span>
      </div>
    );
  }

  const url = typeof window !== "undefined" ? `${window.location.origin}/predict` : "";
  const text = [
    `⏰ ${race.name}: still waiting for ${missing.join(", ")}.`,
    `Picks lock when the race starts. A missing entry costs −25! 🏁`,
    url,
  ].join("\n");

  return (
    <div className="carbon-panel mt-4 rounded-lg border-l-4 p-3 sm:p-4" style={{ borderLeftColor: "var(--gold)" }}>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-gold">
        Still to lock in · {missing.length} of {missing.length + submitted.length}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {missing.map((name) => (
          <span key={name} className="rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs font-semibold">
            {name}
          </span>
        ))}
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3 h-10 w-full gap-2"
        onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank")}
      >
        <MessageCircle className="h-4 w-4" />
        Nudge them on WhatsApp
      </Button>
    </div>
  );
}
