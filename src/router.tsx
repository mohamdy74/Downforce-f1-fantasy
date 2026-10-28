import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { SEASON, type Driver, type LeaderboardEntry, type Race } from "@/lib/queries";
import { readQueryCache } from "@/lib/queryPersist";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    // Reuse fresh data when moving between tabs instead of refetching every time.
    defaultOptions: {
      queries: {
        staleTime: 2 * 60_000,
        gcTime: 15 * 60_000,
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  });

  // Hydrate 0ms instant snapshots from localStorage on client boot
  if (typeof window !== "undefined") {
    const cachedRaces = readQueryCache<Race[]>(`races:${SEASON}`);
    if (cachedRaces) {
      queryClient.setQueryData(["races", SEASON], cachedRaces.data, {
        updatedAt: cachedRaces.updatedAt,
      });
    }
    const cachedDrivers = readQueryCache<Driver[]>("drivers");
    if (cachedDrivers) {
      queryClient.setQueryData(["drivers"], cachedDrivers.data, {
        updatedAt: cachedDrivers.updatedAt,
      });
    }
    const cachedBoard = readQueryCache<LeaderboardEntry[]>(`leaderboard:${SEASON}`);
    if (cachedBoard) {
      queryClient.setQueryData(["leaderboard", SEASON], cachedBoard.data, {
        updatedAt: cachedBoard.updatedAt,
      });
    }
  }

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultViewTransition: true,
    defaultPreload: "intent",
    defaultPreloadDelay: 15,
    defaultPreloadStaleTime: 60_000,
  });

  return router;
};