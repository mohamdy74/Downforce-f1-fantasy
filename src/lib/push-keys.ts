const envObj =
  typeof process !== "undefined" && process?.env ? process.env : ({} as Record<string, string | undefined>);

export const VAPID_PUBLIC_KEY =
  envObj["VITE_VAPID_PUBLIC_KEY"] ||
  envObj["VAPID_PUBLIC_KEY"] ||
  "BPsK6eJs07cjbH2JnZRJvMrZ_wTN4CfxgZqdZBXY-oQStSLyrd8NPq0xYVMsUqdbywWgvj5XJQboYn-E9TxPrSk";

export const VAPID_PRIVATE_KEY = typeof window === "undefined" ? (envObj["VAPID_PRIVATE_KEY"] || "SowWFCNDsBlHZ3SW6l-nm3qjvEW-kG0DkVZTq8dIjJs") : "";
export const VAPID_SUBJECT = "mailto:admin@downforce.app";

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

export function isCompleteTop10(top10: unknown): boolean {
  return (
    Array.isArray(top10) &&
    top10.filter((x) => Boolean(x && x !== "__none__")).length === 10
  );
}

export type PushSubscriptionRecord = {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  rawKey: string;
};

export function parsePushSubscriptionKey(key: string): PushSubscriptionRecord | null {
  const m = /^push_sub:([^:]+):(.+)$/.exec(key);
  if (!m) return null;
  const userId = m[1]!;
  try {
    const raw = JSON.parse(m[2]!) as {
      endpoint?: string | undefined;
      keys?: { p256dh?: string | undefined; auth?: string | undefined } | undefined;
      p256dh?: string | undefined;
      auth?: string | undefined;
    };
    const p256dh = raw.keys?.p256dh ?? raw.p256dh;
    const auth = raw.keys?.auth ?? raw.auth;
    if (!raw.endpoint || !p256dh || !auth) return null;
    return { userId, endpoint: raw.endpoint, p256dh, auth, rawKey: key };
  } catch {
    return null;
  }
}

export function extractSubscribedUserIds(
  rows: Array<{ key: string }> | null | undefined,
): string[] {
  return Array.from(
    new Set(
      (rows ?? [])
        .map((r) => /^push_sub:([^:]+):/.exec(r.key)?.[1])
        .filter((x): x is string => Boolean(x)),
    ),
  );
}

export function findStalePushKeysForEndpoint(
  existingRows: Array<{ key: string }> | null | undefined,
  userId: string,
  endpoint: string,
): string[] {
  const prefix = `push_sub:${userId}:`;
  const staleKeys: string[] = [];
  for (const r of existingRows ?? []) {
    if (!r.key.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(r.key.slice(prefix.length)) as { endpoint?: string | undefined };
      if (parsed.endpoint === endpoint) staleKeys.push(r.key);
    } catch {
      staleKeys.push(r.key);
    }
  }
  return staleKeys;
}