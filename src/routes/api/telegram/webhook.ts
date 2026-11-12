import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse } from "@/lib/telegram-auth.server";
import { readServerEnv } from "@/lib/env";

type TelegramUpdate = {
  message?: {
    text?: string;
    chat?: { id?: number };
    from?: { username?: string };
  };
};

const HELP =
  "DOWNFORCE bot\n\n" +
  "/start <token> — link this chat to your account (get the link in the app)\n" +
  "/status — show your next lock and whether picks are submitted\n" +
  "/stop — pause reminders";

async function secretMatches(provided: string | null): Promise<boolean> {
  const expected = readServerEnv("TELEGRAM_WEBHOOK_SECRET");
  if (!expected || !provided) return false;
  const { createHash, timingSafeEqual } = await import("node:crypto");
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

// POST /api/telegram/webhook — Telegram pushes updates here. Always answers 200
// for a valid secret so Telegram does not retry the same update forever.
export const Route = createFileRoute("/api/telegram/webhook")({
  staticData: { sitemap: false },
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await secretMatches(request.headers.get("x-telegram-bot-api-secret-token")))) {
          return jsonResponse({ error: "unauthorized" }, 401);
        }

        let update: TelegramUpdate;
        try {
          update = (await request.json()) as TelegramUpdate;
        } catch {
          return jsonResponse({ ok: true });
        }

        const chatId = update.message?.chat?.id;
        const text = update.message?.text ?? "";
        if (!chatId) return jsonResponse({ ok: true });

        const { sendTelegramMessage, linkTelegramFromToken, describeUserStatus, setNotify, formatStatusText } =
          await import("@/lib/telegram.server");

        let reply: string;
        if (text.startsWith("/start")) {
          const token = text.slice("/start".length).trim();
          const linked = token ? await linkTelegramFromToken(token, chatId, update.message?.from?.username ?? null) : null;
          reply = linked?.ok
            ? "Linked! You'll get a reminder before every Grand Prix and Sprint lock. 🏁"
            : "That link is invalid or expired. Open DOWNFORCE → Account → Telegram and generate a fresh one.";
        } else if (text.startsWith("/status")) {
          reply = formatStatusText(await describeUserStatus(chatId));
        } else if (text.startsWith("/stop")) {
          await setNotify(chatId, false);
          reply = "Reminders paused. Send /start or re-enable them in the app to resume.";
        } else {
          reply = HELP;
        }

        await sendTelegramMessage(chatId, reply);
        return jsonResponse({ ok: true });
      },
    },
  },
});