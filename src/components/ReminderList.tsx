import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Send, Users, UserX, Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { nextRace, racesQuery } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";

export function ReminderList() {
  const { data: races } = useQuery(racesQuery);
  const { user } = useAuth();

  const race = races ? nextRace(races) : null;
  if (!race || !races) return null;

  const { data: missing } = useQuery({
    queryKey: ["missing-preds", race.id],
    enabled: !!race,
    queryFn: async () => {
      // Get predictions for this race
      const { data: preds } = await supabase
        .from("predictions")
        .select("user_id, top10")
        .eq("race_id", race.id);
      const submittedIds = new Set(
        (preds ?? [])
          .filter((p) => (p.top10 ?? []).filter(Boolean).length === 10)
          .map((p) => p.user_id),
      );
      // Get profiles for non-submitted users
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, display_name")
        .not("id", "in", `(${Array.from(submittedIds).join(",") || ""})`);
      return {
        submitted: submittedIds.size,
        missing: profiles ?? [],
        total: (preds ?? []).length,
      };
    },
  });

  if (!missing || !missing.missing) {
    return (
      <div className="carbon-panel-strong rounded-lg p-4 text-sm text-muted-foreground">
        Couldn&apos;t load reminder list — check that predictions table is accessible.
      </div>
    );
  }
  if (missing.missing.length === 0) return null;

  const whatsappMsg = encodeURIComponent(
    `DOWNFORCE reminder: ${race.name} picks close at ${new Date(race.race_at).toLocaleString("en-GB", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" })} — lock in your predictions!`,
  );
  const waLink = `https://wa.me/?text=${whatsappMsg}`;

  return (
    <div className="carbon-panel-strong rounded-lg p-4 sm:p-5 mt-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          Who hasn&apos;t submitted
        </h2>
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">
          {missing.submitted} submitted / {missing.missing.length} missing
        </span>
      </div>

      <div className="mt-3 space-y-1.5 max-h-64 overflow-y-auto">
        {missing.missing.map((m) => (
          <div key={m.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-secondary/30">
            <UserX className="h-3.5 w-3.5 text-destructive shrink-0" />
            <span className="truncate font-display text-sm font-extrabold italic uppercase">{m.display_name || "Player"}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <Button asChild size="sm" variant="outline" className="h-9 gap-1.5">
          <a href={waLink} target="_blank" rel="noopener noreferrer" aria-label="Open WhatsApp with reminder message (manual send)">
            <Send className="h-3.5 w-3.5" />
            WhatsApp reminder (manual)
          </a>
        </Button>
        <Button asChild size="sm" variant="secondary" className="h-9">
          <Link to="/predict">Submit my picks</Link>
        </Button>
      </div>

      {race.race_at && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
          <Clock className="h-3 w-3" />
          Race closes {new Date(race.race_at).toLocaleString("en-GB", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" })} (Cairo)
        </div>
      )}
    </div>
  );
}
