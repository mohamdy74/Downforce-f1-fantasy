/** Single source of truth for Web Push VAPID keys + helpers.
 * Public key is safe for client & server use; private key MUST come from server environment.
 */
export const VAPID_PUBLIC_KEY =
  process.env["VITE_VAPID_PUBLIC_KEY"] ||
  process.env["VAPID_PUBLIC_KEY"] ||
  "BPsK6eJs07cjbH2JnZRJvMrZ_wTN4CfxgZqdZBXY-oQStSLyrd8NPq0xYVMsUqdbywWgvj5XJQboYn-E9TxPrSk";

export const VAPID_PRIVATE_KEY = process.env["VAPID_PRIVATE_KEY"] || "";

export const VAPID_SUBJECT = "mailto:admin@downforce.app";

/** A top-10 counts as "submitted" only when all 10 slots are real driver ids. */
export function isCompleteTop10(top10: unknown): boolean {
  return (
    Array.isArray(top10) &&
    top10.filter((x) => x && x !== "__none__").length === 10
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