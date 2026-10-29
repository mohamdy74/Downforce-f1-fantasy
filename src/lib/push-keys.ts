/**
 * Single source of truth for Web Push VAPID public key, Base64URL conversion,
 * key-rotation comparison, top-10 completion guard, and push_sub sync_state key parsing.
 * Safe for both browser and server bundles (NEVER contains VAPID_PRIVATE_KEY).
 */
export function cleanVapidKey(val: string | undefined): string {
  return (val ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
}

const envObj =
  typeof process !== "undefined" && process?.env
    ? (process.env as Record<string, string | undefined>)
    : ({} as Record<string, string | undefined>);

const viteEnv =
  typeof import.meta !== "undefined" && (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ? (import.meta as unknown as { env: Record<string, string | undefined> }).env
    : ({} as Record<string, string | undefined>);

export const VAPID_PUBLIC_KEY = cleanVapidKey(
  viteEnv["VITE_VAPID_PUBLIC_KEY"] ||
    envObj["VITE_VAPID_PUBLIC_KEY"] ||
    envObj["VAPID_PUBLIC_KEY"] ||
    "",
);

export const VAPID_SUBJECT = "mailto:admin@downforce.app";

/** Converts a URL-safe Base64 VAPID public key into a Uint8Array<ArrayBuffer> for pushManager.subscribe(). */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const cleaned = cleanVapidKey(base64String);
  const padding = "=".repeat((4 - (cleaned.length % 4)) % 4);
  const base64 = (cleaned + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Checks whether an existing browser PushSubscription was created with the exact same
 * VAPID public key. When VAPID keys are rotated, this returns false so the client can
 * automatically unsubscribe the old key and re-subscribe with the new key.
 */
export function hasMatchingApplicationServerKey(
  sub: PushSubscription,
  expectedKeyBytes: Uint8Array,
): boolean {
  const existingBuf = sub.options?.applicationServerKey;
  if (!existingBuf) return false;
  const existingBytes = new Uint8Array(existingBuf);
  if (existingBytes.length !== expectedKeyBytes.length) return false;
  for (let i = 0; i < existingBytes.length; i++) {
    if (existingBytes[i] !== expectedKeyBytes[i]) return false;
  }
  return true;
}

/** A top-10 counts as "submitted" only when all 10 slots are real driver ids (excluding "__none__"). */
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
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      p256dh?: string;
      auth?: string;
    };
    const p256dh = raw.keys?.p256dh ?? raw.p256dh;
    const auth = raw.keys?.auth ?? raw.auth;
    if (!raw.endpoint || !p256dh || !auth) return null;
    return {
      userId,
      endpoint: raw.endpoint,
      p256dh,
      auth,
      rawKey: key,
    };
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
      const parsed = JSON.parse(r.key.slice(prefix.length)) as { endpoint?: string };
      if (parsed.endpoint === endpoint) staleKeys.push(r.key);
    } catch {
      staleKeys.push(r.key);
    }
  }
  return staleKeys;
}
