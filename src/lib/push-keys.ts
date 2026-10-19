/** Single source of truth for Web Push VAPID keys + helpers.
 * Before: the same BPsK6... public key was hardcoded in 4 places
 * (push.functions.ts, webpush-native.ts, PushOptIn.tsx, AccountAndOnboarding.tsx).
 * Import from here instead.
 */
export const VAPID_PUBLIC_KEY =
  process.env["VITE_VAPID_PUBLIC_KEY"] ||
  process.env["VAPID_PUBLIC_KEY"] ||
  "BPsK6eJs07cjbH2JnZRJvMrZ_wTN4CfxgZqdZBXY-oQStSLyrd8NPq0xYVMsUqdbywWgvj5XJQboYn-E9TxPrSk";

export const VAPID_PRIVATE_KEY =
  process.env["VAPID_PRIVATE_KEY"] || "SowWFCNDsBlHZ3SW6l-nm3qjvEW-kG0DkVZTq8dIjJs";

export const VAPID_SUBJECT = "mailto:admin@downforce.app";

/** A top-10 counts as "submitted" only when all 10 slots are real driver ids. */
export function isCompleteTop10(top10: unknown): boolean {
  return (
    Array.isArray(top10) &&
    top10.filter((x) => x && x !== "__none__").length === 10
  );
}
