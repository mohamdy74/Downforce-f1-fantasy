import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Send, Users, UserX, Clock, Loader2 } from "lucide-react";

import { Skeleton } from "@/components/LoadingSkeleton";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import { nextRace, racesQuery } from "@/lib/queries";
import { getReminderStatsPaginated, type PaginatedReminderStatsResult } from "@/lib/reminder.functions";

export function ReminderList() {
  const { data: races } = useQuery(racesQuery);
  const { user } = useAuth();

  const race = races ? nextRace(races) : null;

  // Use infinite query for paginated results
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isLoading: missingLoading,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["missing-preds-paginated", race?.id],
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      return await getReminderStatsPaginated({
        data: { 
          raceId: race!.id,
          limit: DEFAULT_PAGE_SIZE,
          cursor: pageParam,
        },
      });
    },
    initialPageParam: null,
    getNextPageParam: (lastPage: PaginatedReminderStatsResult) => lastPage.nextCursor,
    enabled: !!race && !!user,
    staleTime: 2 * 60_000,
  });

  // Merge all pages
  const allMissing = data?.pages.flatMap((page: PaginatedReminderStatsResult) => page.missing) ?? [];
  const totalSubmitted = data?.pages[0]?.submitted ?? 0;
  const totalCount = data?.pages[0]?.total ?? 0;

  if (!race || !races) return null;
  if (missingLoading) {
    // Skeleton stand-in instead of flashing the "Couldn't load" error panel
    // while the stats query is still in flight.
    return (
      <div
        className="carbon-panel-strong mt-6 rounded-lg p-4 sm:p-5"
        role="status"
        aria-busy="true"
        aria-label="Loading reminder list"
      >
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="mt-3 space-y-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full rounded-md" />
          ))}
        </div>
      </div>
    );
  }
  if (!data && !missingLoading) {
    return (
      <div className="carbon-panel-strong rounded-lg p-4 text-sm text-muted-foreground">
        Couldn&apos;t load reminder list \u2014 check that predictions table is accessible.
      </div>
    );
  }
  if (allMissing.length === 0) return null;

  const whatsappMsg = encodeURIComponent(
    `DOWNFORCE reminder: ${race.name} picks close at ${new Date(race.race_at).toLocaleString("en-GB", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" })} \u2014 lock in your predictions!`,
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
          {totalSubmitted} submitted / {allMissing.length} missing
        </span>
      </div>

      <div className="mt-3 space-y-1.5 max-h-64 overflow-y-auto">
        {allMissing.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-secondary/30"
          >
            <UserX className="h-3.5 w-3.5 text-destructive shrink-0" />
            <span className="truncate font-display text-sm font-extrabold italic uppercase">
              {m.display_name || "Player"}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <Button asChild size="sm" variant="outline" className="h-9 gap-1.5">
          <a
            href={waLink}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open WhatsApp with reminder message (manual send)"
          >
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
          Race closes{" "}
          {new Date(race.race_at).toLocaleString("en-GB", {
            weekday: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Africa/Cairo",
          })}{" "}
          (Cairo)
        </div>
      )}

      {hasNextPage && (
        <div className="mt-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="w-full h-9"
          >
            {isFetchingNextPage ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                Loading more...
              </>
            ) : (
              "Load more players"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
