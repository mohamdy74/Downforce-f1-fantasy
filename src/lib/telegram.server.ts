// Server-only Telegram logic. Every Supabase import happens inside a handler
// (see the convention in cron-warmup.server.ts) so nothing here leaks into the
// browser bundle.
import { readServerEnv } from "@/lib/env";
import { isCompleteTop10 } from "@/lib/push-keys";
import {
  activeWindowKey,
  buildReminderMessage,
  reminderKeyboard,
  sessionLabel,
  type SessionType,
} from "@/lib/telegram";

const SEASON = 2026;
const API_BASE = "https://api.telegram.org";

type AdminClient = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];

export type SendResult = { ok: true } | { ok: false; status: number; description: string };

function botToken(): string | null {
  return readServerEnv("TELEGRAM_BOT_TOKEN");
}

export function appUrl(): string {
  return readServerEnv("APP_URL") ?? "https://downforce.lovable.app";
}

/** Never throws: callers branch on `ok` and treat 403 as "user blocked the bot". */
export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  extra?: Record<string, unknown>,
): Promise<SendResult> {
  const token = botToken();
  if (!token) return { ok: false, status: 0, description: "TELEGRAM_BOT_TOKEN is not set" };

  try {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    const payload = (await res.json().catch(() => null)) as { description?: string } | null;
    return { ok: false, status: res.status, description: payload?.description ?? res.statusText };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      description: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Single-use link token, valid for 15 minutes; a new one invalidates the old. */
export async function createTelegramLinkToken(
  userId: string,
): Promise<{ url: string; expiresAt: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { randomBytes } = await import("node:crypto");

  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

  await supabaseAdmin
    .from("profiles")
    .update({
      telegram_link_token: token,
      telegram_token_expires_at: expiresAt,
    })
    .eq("id", userId);

  const username = readServerEnv("TELEGRAM_BOT_USERNAME") ?? "";
  return { url: `https://t.me/${username}?start=${token}`, expiresAt };
}

export async function unlinkTelegram(userId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("profiles")
    .update({
      telegram_chat_id: null,
      telegram_username: null,
      telegram_linked_at: null,
      telegram_link_token: null,
      telegram_token_expires_at: null,
    })
    .eq("id", userId);
}

export async function linkTelegramFromToken(
  token: string,
  chatId: number,
  username: string | null,
): Promise<{ ok: true } | { ok: false; reason: "invalid" }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const nowIso = new Date().toISOString();

  const { data: match } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("telegram_link_token", token)
    .gt("telegram_token_expires_at", nowIso)
    .maybeSingle();

  if (!match) return { ok: false, reason: "invalid" };

  // Guarded by the token itself so a replayed token cannot overwrite a second link.
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({
      telegram_chat_id: chatId,
      telegram_username: username,
      telegram_linked_at: nowIso,
      notify_telegram: true,
      telegram_link_token: null,
      telegram_token_expires_at: null,
    })
    .eq("id", match.id)
    .eq("telegram_link_token", token);

  if (error) return { ok: false, reason: "invalid" };
  return { ok: true };
}

export type UserStatus = {
  linked: boolean;
  username: string | null;
  notify: boolean;
  race: { id: string; name: string; raceAt: string } | null;
  gp: { submitted: boolean; lockAt: string | null };
  sprint: { submitted: boolean; lockAt: string | null } | null;
};

function relative(iso: string | null): string {
  if (!iso) return "unknown";
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (mins <= 0) return "closed";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

export function formatStatusText(status: UserStatus): string {
  if (!status.linked) return "This chat is not linked to a DOWNFORCE account yet.";
  const lines = [`Linked as ${status.username ? `@${status.username}` : "a DOWNFORCE player"}.`];
  if (!status.race) {
    lines.push("No upcoming race on the calendar.");
    return lines.join("\n");
  }
  lines.push(`Next up: ${status.race.name} (locks ${relative(status.race.raceAt)}).`);
  lines.push(
    status.gp.submitted
      ? "Grand Prix: picks submitted."
      : `Grand Prix: missing — locks ${relative(status.gp.lockAt)}.`,
  );
  if (status.sprint) {
    lines.push(
      status.sprint.submitted
        ? "Sprint: picks submitted."
        : `Sprint: missing — locks ${relative(status.sprint.lockAt)}.`,
    );
  }
  if (!status.notify) lines.push("Reminders are paused — send /start to resume.");
  return lines.join("\n");
}

export async function describeUserStatus(chatId: number): Promise<UserStatus> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("id, telegram_username, notify_telegram, telegram_chat_id")
    .eq("telegram_chat_id", chatId)
    .maybeSingle();

  const { data: race } = await supabaseAdmin
    .from("races")
    .select("id, name, race_at, sprint_at, has_sprint")
    .eq("season", SEASON)
    .gt("race_at", new Date().toISOString())
    .order("race_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const empty: UserStatus = {
    linked: false,
    username: null,
    notify: true,
    race: null,
    gp: { submitted: false, lockAt: null },
    sprint: null,
  };
  if (!profile || !race) return { ...empty, linked: !!profile };

  const { data: gpRow } = await supabaseAdmin
    .from("predictions")
    .select("top10")
    .eq("race_id", race.id)
    .eq("user_id", profile.id)
    .maybeSingle();

  let sprint: UserStatus["sprint"] = null;
  if (race.has_sprint && race.sprint_at) {
    const { data: sprintRow } = await supabaseAdmin
      .from("sprint_predictions")
      .select("top8")
      .eq("race_id", race.id)
      .eq("user_id", profile.id)
      .maybeSingle();
    sprint = {
      submitted: Array.isArray(sprintRow?.top8) && (sprintRow?.top8?.length ?? 0) > 0,
      lockAt: race.sprint_at,
    };
  }

  return {
    linked: true,
    username: profile.telegram_username ?? null,
    notify: profile.notify_telegram ?? true,
    race: { id: race.id, name: race.name, raceAt: race.race_at },
    gp: { submitted: isCompleteTop10(gpRow?.top10), lockAt: race.race_at },
    sprint,
  };
}

export async function setNotify(chatId: number, notify: boolean): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("profiles")
    .update({ notify_telegram: notify })
    .eq("telegram_chat_id", chatId);
}

type SweepRace = {
  id: string;
  name: string;
  has_sprint: boolean;
  race_at: string;
  sprint_at: string | null;
};

type LinkedUser = { id: string; display_name: string; telegram_chat_id: number | null };

type SweepEntry = {
  race: SweepRace;
  session: SessionType;
  windowKey: ReturnType<typeof activeWindowKey> & string;
  minsLeft: number;
};

/**
 * One reminder pass: per-(race, session, window) fan-out to linked players who
 * have not submitted, deduped through reminder_deliveries so the 15-minute cron
 * never double-sends.
 */
export async function runTelegramReminderSweep(): Promise<{
  sent: number;
  blocked: number;
  leaguePing: "sent" | "skipped" | "disabled";
}> {
  const token = botToken();
  if (!token) {
    console.error("[telegram] TELEGRAM_BOT_TOKEN is not set — reminder sweep disabled.");
    return { sent: 0, blocked: 0, leaguePing: "disabled" };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = Date.now();

  const { data: races } = await supabaseAdmin
    .from("races")
    .select("id, name, has_sprint, race_at, sprint_at")
    .eq("season", SEASON)
    .gt("race_at", new Date(now).toISOString())
    .lte("race_at", new Date(now + 24 * 3600_000).toISOString());

  const sweepRaces = (races ?? []) as SweepRace[];
  if (!sweepRaces.length) return { sent: 0, blocked: 0, leaguePing: "skipped" };

  // Build the (race, session, window) entries that are open right now.
  const entries: SweepEntry[] = [];
  for (const race of sweepRaces) {
    const sessions: Array<{ session: SessionType; at: string }> = [
      { session: "gp", at: race.race_at },
    ];
    if (race.has_sprint && race.sprint_at) {
      sessions.push({ session: "sprint", at: race.sprint_at });
    }
    for (const { session, at } of sessions) {
      const minsLeft = Math.floor((new Date(at).getTime() - now) / 60_000);
      const windowKey = activeWindowKey(minsLeft);
      if (!windowKey) continue;
      entries.push({ race, session, windowKey, minsLeft });
    }
  }
  if (!entries.length) return { sent: 0, blocked: 0, leaguePing: "skipped" };

  const raceIds = [...new Set(entries.map((e) => e.race.id))];

  const [{ data: users }, gpRes, sprintRes, deliveryRes] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id, display_name, telegram_chat_id")
      .not("telegram_chat_id", "is", null)
      .eq("notify_telegram", true),
    supabaseAdmin.from("predictions").select("race_id, user_id, top10").in("race_id", raceIds),
    supabaseAdmin
      .from("sprint_predictions")
      .select("race_id, user_id, top8")
      .in("race_id", raceIds),
    supabaseAdmin
      .from("reminder_deliveries")
      .select("race_id, session_type, window_key, target_type, user_id")
      .in("race_id", raceIds),
  ]);

  const linkedUsers = (users ?? []) as LinkedUser[];
  if (!linkedUsers.length) return { sent: 0, blocked: 0, leaguePing: "skipped" };

  const submittedFor = (session: SessionType) => {
    const set = new Set<string>();
    if (session === "gp") {
      for (const row of gpRes.data ?? []) {
        if (isCompleteTop10(row.top10)) set.add(`${row.race_id}:${row.user_id}`);
      }
    } else {
      for (const row of sprintRes.data ?? []) {
        if (Array.isArray(row.top8) && row.top8.length > 0)
          set.add(`${row.race_id}:${row.user_id}`);
      }
    }
    return set;
  };
  const submitted = { gp: submittedFor("gp"), sprint: submittedFor("sprint") };

  const delivered = new Set(
    (deliveryRes.data ?? []).map(
      (row) =>
        `${row.race_id}:${row.session_type}:${row.window_key}:${row.target_type}:${row.user_id ?? "group"}`,
    ),
  );

  let sent = 0;
  let blocked = 0;
  let leaguePing: "sent" | "skipped" | "disabled" = "disabled";
  const inserts: Array<{
    race_id: string;
    session_type: SessionType;
    window_key: string;
    target_type: "user" | "league_group";
    user_id: string | null;
  }> = [];
  const toMute = new Set<string>();
  const leagueChatId = readServerEnv("TELEGRAM_LEAGUE_CHAT_ID");

  for (const entry of entries) {
    const missing = linkedUsers.filter(
      (u) =>
        u.telegram_chat_id != null && !submitted[entry.session].has(`${entry.race.id}:${u.id}`),
    );

    // Per-user reminders.
    const pending = missing.filter(
      (u) => !delivered.has(`${entry.race.id}:${entry.session}:${entry.windowKey}:user:${u.id}`),
    );

    const BATCH = 25;
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map((u) =>
          sendTelegramMessage(
            u.telegram_chat_id!,
            buildReminderMessage({
              raceName: entry.race.name,
              session: entry.session,
              minsLeft: entry.minsLeft,
            }),
            { reply_markup: reminderKeyboard(appUrl()) },
          ),
        ),
      );

      results.forEach((result, index) => {
        const user = batch[index]!;
        if (result.status === "fulfilled" && result.value.ok) {
          sent++;
          inserts.push({
            race_id: entry.race.id,
            session_type: entry.session,
            window_key: entry.windowKey,
            target_type: "user",
            user_id: user.id,
          });
          return;
        }
        const failure = result.status === "fulfilled" ? result.value : null;
        // 403 = the player blocked the bot: stop notifying them, keep the link.
        if (failure && !failure.ok && failure.status === 403) {
          blocked++;
          toMute.add(user.id);
          inserts.push({
            race_id: entry.race.id,
            session_type: entry.session,
            window_key: entry.windowKey,
            target_type: "user",
            user_id: user.id,
          });
          return;
        }
        console.error(
          `[telegram] reminder to ${user.id} failed:`,
          failure && !failure.ok ? failure.description : "unknown error",
        );
      });
    }

    // Single group summary, only for the 3h window.
    if (!leagueChatId || entry.windowKey !== "3h") continue;
    const groupKey = `${entry.race.id}:${entry.session}:${entry.windowKey}:league_group:group`;
    if (delivered.has(groupKey)) {
      leaguePing = "skipped";
      continue;
    }
    const names = missing.map((u) => u.display_name).filter(Boolean);
    const text = names.length
      ? `${sessionLabel(entry.session)} — ${entry.race.name}: still missing picks from ${names.join(", ")}. Locks ${relative(entry.race.race_at)}.`
      : `${sessionLabel(entry.session)} — ${entry.race.name}: everyone has submitted.`;
    const groupResult = await sendTelegramMessage(leagueChatId, text);
    if (groupResult.ok) {
      sent++;
      leaguePing = "sent";
      inserts.push({
        race_id: entry.race.id,
        session_type: entry.session,
        window_key: entry.windowKey,
        target_type: "league_group",
        user_id: null,
      });
    } else {
      leaguePing = "skipped";
      console.error("[telegram] league ping failed:", groupResult.description);
    }
  }

  if (toMute.size) {
    await supabaseAdmin
      .from("profiles")
      .update({ notify_telegram: false })
      .in("id", [...toMute]);
  }

  for (const row of inserts) {
    // 23505 = another cron pass already recorded this delivery.
    const { error } = await supabaseAdmin.from("reminder_deliveries").insert(row);
    if (error && error.code !== "23505") {
      console.error("[telegram] delivery log insert failed:", error.message);
    }
  }

  return { sent, blocked, leaguePing };
}
