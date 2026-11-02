/**
 * Dev-only PostgREST query counter — wraps a Supabase client's fetch so every
 * REST call is logged with a running per-table tally. Makes N+1 patterns
 * (query count growing with list length) visible in the browser devtools
 * console and the dev-server terminal. No-op in production builds.
 */
const DEV = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

export function withQueryCounting(fetchFn: typeof fetch): typeof fetch {
  if (!DEV) return fetchFn;

  const counts = new Map<string, number>();
  let total = 0;

  return (input, init) => {
    try {
      let url = "";
      if (typeof input === "string") url = input;
      else if (input instanceof Request) url = input.url;
      const match = /\/rest\/v1\/([a-z_]+)/i.exec(url);
      if (match) {
        const table = match[1]!;
        total += 1;
        counts.set(table, (counts.get(table) ?? 0) + 1);
        const perTable = [...counts.entries()].map(([t, c]) => `${t}x${c}`).join(" ");
        console.debug(`[queries] #${total} ${table} | total=${total} | ${perTable}`);
      }
    } catch {
      /* logging must never break the request */
    }
    return fetchFn(input, init);
  };
}
