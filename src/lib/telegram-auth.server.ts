// Resolves the signed-in player for a plain (non serverFn) route handler:
// server functions get `Authorization: Bearer <jwt>` from the client middleware
// (auth-attacher.ts), but a route handler only sees it if the caller sets it.
import { readServerEnv } from "@/lib/env";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function unauthorized(): Response {
  return jsonResponse({ error: "unauthorized" }, 401);
}

export async function requireTelegramUser(): Promise<{ userId: string } | Response> {
  const request = await getRequestSafe();
  const authHeader = request?.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return unauthorized();

  const url = readServerEnv("SUPABASE_URL");
  const key = readServerEnv("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !key) return jsonResponse({ error: "server_not_configured" }, 500);

  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  const userId = data?.user?.id;
  if (error || !userId) return unauthorized();
  return { userId };
}

async function getRequestSafe(): Promise<Request | undefined> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    return getRequest();
  } catch {
    return undefined;
  }
}