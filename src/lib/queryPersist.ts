const CACHE_PREFIX = "dfr:qcache:v2:";
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60_000; // 7 days

type CacheEnvelope<T> = {
  ts: number;
  data: T;
};

export function readQueryCache<T>(key: string): { data: T; updatedAt: number } | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed.ts !== "number" || parsed.data === undefined) return undefined;
    if (Date.now() - parsed.ts > MAX_CACHE_AGE_MS) {
      window.localStorage.removeItem(CACHE_PREFIX + key);
      return undefined;
    }
    return { data: parsed.data, updatedAt: parsed.ts };
  } catch {
    return undefined;
  }
}

export function writeQueryCache<T>(key: string, data: T): T {
  if (typeof window !== "undefined") {
    try {
      const payload: CacheEnvelope<T> = { ts: Date.now(), data };
      window.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(payload));
    } catch {
      /* ignore quota or private browsing errors */
    }
  }
  return data;
}
