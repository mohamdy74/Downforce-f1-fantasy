// Central, typed server-env access. Server-only values are read through this
// module so a missing secret is logged LOUDLY once (instead of failing
// silently) and call sites stay consistent.
const warned = new Set<string>();

export type ServerEnvName =
  | "SUPABASE_URL"
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "CRON_SECRET"
  | "VAPID_PUBLIC_KEY"
  | "VITE_VAPID_PUBLIC_KEY";

export function readServerEnv(name: ServerEnvName): string | null {
  if (typeof process === "undefined" || !process?.env) return null;
  const value = process.env[name]?.trim() || null;
  if (!value && !warned.has(name)) {
    warned.add(name);
    console.error(
      `[env] ${name} is not set — features depending on it stay disabled until it is configured (Lovable > Settings > Secrets).`,
    );
  }
  return value;
}

/**
 * Optional shared secret for the /reminders cron warm-up. While CRON_SECRET is
 * unset the endpoint stays open (backwards compatible); once the secret is set
 * in Lovable Secrets AND in GitHub repo secrets, requests without the matching
 * x-cron-secret header are rejected from triggering server-side work.
 */
export function cronRequestAuthorized(headerSecret: string | null): boolean {
  const expected = readServerEnv("CRON_SECRET");
  if (!expected) return true;
  return !!headerSecret && headerSecret === expected;
}

/**
 * Gate for the public checkAndSendRaceReminders server function. The entry is
 * shared by the /reminders cron warm-up and the browser BackgroundSync, so it
 * may only be locked once the server-side cron path is fully operational
 * (SUPABASE_SERVICE_ROLE_KEY set). Without the service role the browser path
 * is the only reminder delivery mechanism and must stay open.
 */
export function raceRemindersSweepAuthorized(headerSecret: string | null): boolean {
  if (!readServerEnv("SUPABASE_SERVICE_ROLE_KEY")) return true;
  return cronRequestAuthorized(headerSecret);
}
