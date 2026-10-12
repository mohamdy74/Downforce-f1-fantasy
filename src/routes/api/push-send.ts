// SUPABASE EDGE FUNCTION / NITRO API — Push Notification Sender
// Run this at ~2h before qualifying / race via cron or external ping.
// Requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and PUSH_API_KEY env vars.

export default async (req: Request): Promise<Response> => {
  // Check API key authentication
  const apiKey = req.headers.get("x-api-key");
  if (!process.env.PUSH_API_KEY || apiKey !== process.env.PUSH_API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // CORS restricted to allowed origin
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://yourdomain.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
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

    if (!isVapidConfigured()) {
      return new Response(JSON.stringify({ ok: false, error: "VAPID keys not configured — set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY" }), { status: 503, headers });
    }

    // 5. Send notifications (batch via Web Push protocol — needs web-push lib in production)
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

import { isVapidConfigured, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } from "@/lib/push-vapid";
import { supabase } from "@/integrations/supabase/client.server";
async function findNextRace(): Promise<string | null> {
  const { data } = await supabase
    .from("races")
    .select("id")
    .gte("race_at", new Date().toISOString())
    .order("race_at", { ascending: true })
    .limit(1)
    .single();
  return data?.id ?? null;
}

async function findMissingPredictions(raceId: string, type: "pole" | "race"): Promise<string[]> {
  // Get users who submitted predictions for this race with full top10
  const { data: submitted } = await supabase
    .from("predictions")
    .select("user_id, top10, pole_driver_id")
    .eq("race_id", raceId);

  const submittedIds = new Set<string>();
  for (const s of submitted ?? []) {
    if (type === "pole" && s.pole_driver_id) submittedIds.add(s.user_id);
    if (type === "race" && (s.top10 ?? []).filter(Boolean).length === 10) submittedIds.add(s.user_id);
  }

  // Get all profiles that are NOT in submitted set
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id")
    .not("id", "in", `(${Array.from(submittedIds).join(",") || "00000000-0000-0000-0000-000000000000"})`);

  return (profiles ?? []).map((p) => p.id);
}

async function loadSubscriptions(userIds: string[]): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>> {
  if (!userIds.length) return [];
  const { data } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", userIds);
  return (data ?? []) as Array<{ endpoint: string; p256dh: string; auth: string }>;
}

async function getRaceInfo(raceId: string): Promise<{ name?: string; round?: number; race_at?: string } | null> {
  const { data } = await supabase
    .from("races")
    .select("name, round, race_at")
    .eq("id", raceId)
    .single();
  return data ?? null;
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
