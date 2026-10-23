/**
 * Shared parsers and fetch helpers for Ergast/Jolpica, OpenF1, F1 Live Timing, and ESPN APIs.
 * Includes timeout guards, automatic retry on HTTP 429/5xx, and lap time parsers.
 */

const envMap =
  typeof process !== "undefined" && process?.env
    ? process.env
    : ({} as Record<string, string | undefined>);

export async function getJson<T>(
  url: string,
  options?: {
    timeoutMs?: number | undefined;
    retries?: number | undefined;
    headers?: Record<string, string> | undefined;
  },
): Promise<T | null> {
  const timeoutMs = options?.timeoutMs ?? 7_000;
  const retries = options?.retries ?? 1;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "DownforceF1/2026",
    ...(options?.headers ?? {}),
  };

  if (url.includes("api.openf1.org")) {
    const token = envMap["OPENF1_API_KEY"] || envMap["OPENF1_TOKEN"];
    if (token && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, {
        headers,
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      if (timer) clearTimeout(timer);

      if ((res.status === 429 || res.status >= 502) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      if (timer) clearTimeout(timer);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}

export function toIso(session?: { date: string; time?: string | undefined } | null): string | null {
  if (!session?.date) return null;
  const d = new Date(`${session.date}T${session.time ?? "12:00:00Z"}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function fmtLap(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : s;
}

/**
 * Parses a lap time string like "1:36.052" or "96.052" into seconds (96.052).
 */
export function parseLapTimeSeconds(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const mColon = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(trimmed);
  if (mColon) {
    const mins = Number(mColon[1]);
    const secs = Number(mColon[2]);
    const total = Math.round((mins * 60 + secs) * 1000) / 1000;
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  const num = Number(trimmed);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export function isClassifiedFinishStatus(
  status: string | null | undefined,
  includeLappedKeyword = true,
): boolean {
  if (!status) return false;
  return includeLappedKeyword
    ? /finished|lapped|\+\d+ lap/i.test(status)
    : /finished|\+\d+ lap/i.test(status);
}