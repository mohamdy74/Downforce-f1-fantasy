// VAPID KEY HELPER — generate with: npm install -g web-push && web-push generate-vapid-keys
// Then add PUBLIC/PRIVATE to Supabase Edge Function secrets (Dashboard → Project Settings → Edge Functions)
export const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
export const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";

// Helper to encode VAPID public key for subscription
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, "+")
    .replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Check if VAPID is configured
export function isVapidConfigured(): boolean {
  return !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_PUBLIC_KEY.length > 10);
}
