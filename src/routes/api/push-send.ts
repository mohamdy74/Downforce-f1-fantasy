// SUPABASE EDGE FUNCTION / NITRO API — Push Notification Sender
// Run this at ~2h before qualifying / race via cron or external ping.
// Requires VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars.

export default async (req: Request): Promise<Response> => {
  // CORS for browser/tests
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const { race_id, deadline_type } = (await req.json().catch(() => ({}))) as {
      race_id?: string;
      deadline_type?: "pole" | "race";
    };

    // Load from env — must be set in Supabase Edge Function secrets
    const VAPID_PUBLIC = (globalThis as unknown as Record<string, string>).VAPID_PUBLIC_KEY;
    const VAPID_PRIVATE = (globalThis as unknown as Record<string, string>).VAPID_PRIVATE_KEY;

    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      return new Response(JSON.stringify({ error: "VAPID keys missing" }), { status: 500, headers });
    }

    // 1. Find upcoming race if not provided
    const raceId = race_id || await findNextRace();
    if (!raceId) return new Response(JSON.stringify({ error: "No upcoming race" }), { status: 404, headers });

    // 2. Find users who haven't submitted predictions for this race
    const missingUsers = await findMissingPredictions(raceId, deadline_type || "race");
    if (!missingUsers.length) return new Response(JSON.stringify({ ok: true, sent: 0, reason: "All predictions submitted" }), { status: 200, headers });

    // 3. Load push subscriptions for those users
    const subs = await loadSubscriptions(missingUsers);
    if (!subs.length) return new Response(JSON.stringify({ ok: true, sent: 0, reason: "No push subscriptions" }), { status: 200, headers });

    // 4. Build payload from race info
    const race = await getRaceInfo(raceId);
    const payload = {
      title: `DOWNFORCE — ${race?.name || "Next Race"}`,
      body: `Picks close ${deadline_type === "pole" ? "soon — pole pick ends" : "soon — top 10 closes"}. Don't miss out!`,
      tag: `downforce-${raceId}-${deadline_type || "race"}`,
      url: "/predict",
    };

    // 5. Send notifications (batch via Web Push protocol)
    let sent = 0;
    for (const sub of subs) {
      try {
        await sendWebPush(sub.endpoint, sub.p256dh, sub.auth, payload, VAPID_PUBLIC, VAPID_PRIVATE);
        sent++;
      } catch {
        // Individual failure — don't abort batch
      }
    }

    return new Response(JSON.stringify({ ok: true, sent, totalSubscriptions: subs.length, raceId }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
  }
};

// Helper stubs — implement with your Supabase client / DB access
async function findNextRace(): Promise<string | null> {
  // Query races table, find race with race_at > now
  return null; // TODO: implement
}

async function findMissingPredictions(raceId: string, type: string): Promise<string[]> {
  // Query predictions for race_id, return user_ids not present
  // For pole: check pole_driver_id; for race: check top10.length === 10
  return []; // TODO: implement
}

async function loadSubscriptions(userIds: string[]): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>> {
  // SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY(userIds)
  return []; // TODO: implement
}

async function getRaceInfo(raceId: string): Promise<{ name?: string; round?: number } | null> {
  return null; // TODO: implement
}

// Web Push Protocol — simplified (use web-push library in production)
async function sendWebPush(
  endpoint: string,
  p256dh: string,
  auth: string,
  payload: unknown,
  publicKey: string,
  privateKey: string,
): Promise<void> {
  // Production: use `web-push` npm package with VAPID keys
  // This is the protocol: POST to endpoint with signed JWT + encrypted payload
  const body = JSON.stringify(payload);
  // Placeholder: actual crypto/signing needed
  // In production: import webpush from 'web-push'; webpush.sendNotification(sub, payload, { vapidDetails: { subject: 'mailto:admin@downforce.app', publicKey, privateKey } })
  console.log("Web push to", endpoint, "payload:", body);
}
