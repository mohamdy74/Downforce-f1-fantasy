import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import { getIsSteward } from "@/lib/stewards.functions";

/**
 * Steward flag verified on the server, so the steward email constant never
 * ships in the client bundle. undefined = still checking, false = signed out
 * or not a steward.
 */
export function useIsSteward(): boolean | undefined {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ["is-steward", user?.id],
    queryFn: () => getIsSteward(),
    enabled: !!user,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  if (!user) return false;
  return data?.isSteward;
}
