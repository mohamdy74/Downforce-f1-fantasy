import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, requireTelegramUser, unauthorized } from "@/lib/telegram-auth.server";
import { readServerEnv } from "@/lib/env";

// POST   /api/telegram/link — mint a 15-minute single-use link token.
// DELETE /api/telegram/link — unlink the caller's chat id.
export const Route = createFileRoute("/api/telegram/link")({
  staticData: { sitemap: false },
  server: {
    handlers: {
      POST: async () => {
        const auth = await requireTelegramUser();
        if (auth instanceof Response) return auth;
        if (!readServerEnv("TELEGRAM_BOT_USERNAME")) {
          return jsonResponse({ error: "telegram_not_configured" }, 500);
        }
        const { createTelegramLinkToken } = await import("@/lib/telegram.server");
        return jsonResponse(await createTelegramLinkToken(auth.userId));
      },
      DELETE: async () => {
        const auth = await requireTelegramUser();
        if (auth instanceof Response) return auth;
        const { unlinkTelegram } = await import("@/lib/telegram.server");
        await unlinkTelegram(auth.userId);
        return jsonResponse({ ok: true });
      },
    },
  },
});
