import { useQuery } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useAuth } from "@/hooks/useAuth";
import {
  driversQuery,
  raceUpdatesQuery,
  racesQuery,
  type RaceUpdate,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

const SEEN_KEY = "dfr-updates-seen";

const TYPE_STYLES: Record<RaceUpdate["type"], { label: string; className: string }> = {
  penalty: { label: "Penalty", className: "bg-destructive/15 text-destructive" },
  grid_change: { label: "Grid Change", className: "bg-gold/15 text-gold" },
  investigation: { label: "Investigation", className: "bg-primary/15 text-primary" },
  general: { label: "News", className: "bg-secondary text-muted-foreground" },
};

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function UpdatesFeed() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState(0);

  const { data: updates = [] } = useQuery({ ...raceUpdatesQuery, enabled: !!user });
  const { data: drivers = [] } = useQuery(driversQuery);
  const { data: races = [] } = useQuery(racesQuery);

  const driverLabel = useMemo(
    () => new Map(drivers.map((d) => [d.id, d.code ?? d.full_name])),
    [drivers],
  );
  const raceLabel = useMemo(
    () => new Map(races.map((r) => [r.id, r.name.replace("Grand Prix", "GP")])),
    [races],
  );

  useEffect(() => {
    try {
      setLastSeen(Number(window.localStorage.getItem(SEEN_KEY)) || 0);
    } catch {
      // localStorage unavailable — fall back to "everything unread" on this device
    }
  }, []);

  // While the drawer is open, keep marking the current snapshot as seen so the
  // badge stays quiet during reading instead of re-lighting on every refetch.
  useEffect(() => {
    if (!open) return;
    const newest = updates.reduce(
      (acc, u) => Math.max(acc, new Date(u.created_at).getTime()),
      0,
    );
    const next = Math.max(newest, Date.now());
    if (next > lastSeen) {
      setLastSeen(next);
      try {
        window.localStorage.setItem(SEEN_KEY, String(next));
      } catch {
        // storage unavailable — badge will simply re-appear next visit
      }
    }
  }, [open, updates, lastSeen]);

  if (!user) return null;

  const unread = updates.filter((u) => new Date(u.created_at).getTime() > lastSeen).length;

  return (
    <>
      <div className="relative shrink-0">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Race updates"
          title="Race updates & news"
          onClick={() => setOpen(true)}
          className="hit-slop h-8 w-8 sm:h-9 sm:w-9"
        >
          <Megaphone className="h-4 w-4" />
        </Button>
        {unread > 0 && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-0.5 font-mono text-[9px] font-bold leading-none text-primary-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </div>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="max-h-[82vh]">
          <DrawerHeader className="pb-2">
            <DrawerTitle className="text-left font-display text-lg font-extrabold italic uppercase tracking-wide">
              Race Updates
            </DrawerTitle>
            <DrawerDescription className="text-left font-mono text-[11px]">
              Penalties, grid changes & stewards news — check before locking picks.
            </DrawerDescription>
          </DrawerHeader>
          <div className="max-h-[60vh] overflow-y-auto px-4 pb-6">
            {updates.length === 0 ? (
              <div className="py-10 text-center">
                <Megaphone className="mx-auto h-10 w-10 text-muted-foreground/50" />
                <p className="mt-3 text-sm text-muted-foreground">No updates yet.</p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground/70">
                  Steward announcements about penalties and grid changes will appear here.
                </p>
              </div>
            ) : (
              <ul className="space-y-2.5">
                {updates.map((u) => {
                  const chip = TYPE_STYLES[u.type] ?? TYPE_STYLES.general;
                  return (
                    <li
                      key={u.id}
                      className="rounded-lg border border-border/70 bg-card/60 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider",
                            chip.className,
                          )}
                        >
                          {chip.label}
                        </span>
                        {u.driver_id && (
                          <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-bold text-foreground">
                            {driverLabel.get(u.driver_id) ?? u.driver_id}
                          </span>
                        )}
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                          {timeAgo(u.created_at)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm font-bold leading-snug text-foreground">
                        {u.title}
                      </p>
                      {u.body && (
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {u.body}
                        </p>
                      )}
                      <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                        {raceLabel.get(u.race_id) ?? "League news"}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
