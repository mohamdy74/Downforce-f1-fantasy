import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
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

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadDelay: 15, defaultPreloadStaleTime: 60_000, 
  });

  return router;
};
