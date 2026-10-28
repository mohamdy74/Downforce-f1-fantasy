const CACHE_PREFIX = "dfr:qcache:v1:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CacheEnvelope<T> {
  ts: number;
  data: T;
}

export function readQueryCache<T>(key: string): { data: T; updatedAt: number } | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed.ts !== "number" || Date.now() - parsed.ts > MAX_AGE_MS) {
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
      const envelope: CacheEnvelope<T> = { ts: Date.now(), data };
      window.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(envelope));
    } catch {
      /* storage quota full or private mode: ignore */
    }
  }
  return data;
}
