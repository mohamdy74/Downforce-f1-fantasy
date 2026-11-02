/**
 * Shared outbound-request timeout helper. Every external HTTP call in the app
 * (F1 data APIs, Supabase REST/auth, web-push endpoints) is bounded so a slow
 * upstream fails fast with an abort error instead of hanging a request.
 *
 * If the caller already passed its own `signal`, the request is treated as
 * caller-managed and passed through untouched.
 */
export function withRequestTimeout(fetchFn: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    if (init?.signal) return fetchFn(input, init);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetchFn(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };
}
