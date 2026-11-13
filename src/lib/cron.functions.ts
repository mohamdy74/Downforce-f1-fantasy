import { createServerFn } from "@tanstack/react-start";

export const runRemindersCronWarmUp = createServerFn({ method: "POST" })
  .inputValidator((input: Record<string, unknown> | undefined) => input ?? {})
  .handler(async () => {
    // Cron-warm-up entry for the /reminders loader: season-sync warm-up,
    // gated by the optional CRON_SECRET. Server-function handler code
    // compiles server-only, so it may import the server-only warm-up module
    // (route files must not — their component ships to the browser).
    const { runRemindersWarmUp } = await import("./cron-warmup.server");
    await runRemindersWarmUp();
    return { ok: true as const };
  });
