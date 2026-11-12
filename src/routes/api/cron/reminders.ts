import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse } from "@/lib/telegram-auth.server";
import { readServerEnv } from "@/lib/env";

async function cronAuthorized(request: Request): Promise<boolean> {
  const expected = readServerEnv("CRON_SECRET");
  if (!expected) return false;
  const provided = /^Bearer ([^\s,]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!provided) return false;
  const { createHash, timingSafeEqual } = await import("node:crypto");
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

// POST /api/cron/reminders — 15-minute sweep. Bearer CRON_SECRET, like the
// existing Lovable cron entries.
export const Route = createFileRoute("/api/cron/reminders")({
  staticData: { sitemap: false },
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!readServerEnv("CRON_SECRET")) {
          return jsonResponse({ error: "server_configuration_error" }, 500);
        }
        if (!(await cronAuthorized(request))) {
          return jsonResponse({ error: "unauthorized" }, 401);
        }
        const { runTelegramReminderSweep } = await import("@/lib/telegram.server");
        return jsonResponse(await runTelegramReminderSweep());
      },
    },
  },
});