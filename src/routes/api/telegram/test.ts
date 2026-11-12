import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, requireTelegramUser } from "@/lib/telegram-auth.server";

// POST /api/telegram/test — send one message to the caller's linked chat so the
// player can verify delivery immediately after linking.
export const Route = createFileRoute("/api/telegram/test")({
  staticData: { sitemap: false },
  server: {
    handlers: {
      POST: async () => {
        const auth = await requireTelegramUser();
        if (auth instanceof Response) return auth;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: profile } = await supabaseAdmin
          .from("profiles")
          .select("telegram_chat_id")
          .eq("id", auth.userId)
          .maybeSingle();

        const chatId = profile?.telegram_chat_id;
        if (!chatId) return jsonResponse({ error: "not_linked" }, 400);

        const { sendTelegramMessage } = await import("@/lib/telegram.server");
        const result = await sendTelegramMessage(
          chatId,
          "DOWNFORCE test message — your deadline reminders are wired up. 🏁",
        );
        if (!result.ok) {
          return jsonResponse({ error: "telegram_send_failed", status: result.status }, 502);
        }
        return jsonResponse({ ok: true });
      },
    },
  },
});