import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Check, ChevronDown, Copy, Link2, Send, Trash2, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

const POLL_MS = 3_000;
const LINK_TIMEOUT_MS = 120_000;
const STATUS_KEY = "telegram-status";

type TelegramProfile = {
  telegram_linked: boolean;
  telegram_username: string | null;
  telegram_linked_at: string | null;
  notify_telegram: boolean;
};

async function readStatus(userId: string): Promise<TelegramProfile> {
  const { data, error } = await supabase
    .from("profiles")
    .select("telegram_linked, telegram_username, telegram_linked_at, notify_telegram")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return {
    telegram_linked: !!data?.telegram_linked,
    telegram_username: data?.telegram_username ?? null,
    telegram_linked_at: data?.telegram_linked_at ?? null,
    notify_telegram: data?.notify_telegram ?? true,
  };
}

/** Shared by the settings card and the pick-status inline row. */
function useTelegramStatus(userId: string | undefined, poll = false) {
  const query = useQuery({
    queryKey: [STATUS_KEY, userId],
    enabled: !!userId,
    refetchInterval: poll ? POLL_MS : false,
    staleTime: 5_000,
    queryFn: () => readStatus(userId!),
  });
  return query;
}

async function authedFetch(path: string, method: "POST" | "DELETE"): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(path, { method, headers });
}

type Phase = "idle" | "linking" | "linked";

function errorMessage(
  status: number,
  body: { error?: string; description?: string } | null,
): string {
  if (body?.error === "telegram_not_configured")
    return "Reminders aren't enabled on the server yet.";
  if (body?.error === "telegram_send_failed")
    return "Telegram couldn't deliver the message. If it keeps failing, the bot token isn't set on the server yet.";
  if (status === 401) return "Your session expired. Please sign in again.";
  if (status === 400 || body?.error === "not_linked")
    return "This account isn't linked to Telegram.";
  return "Couldn't reach the server. Please try again.";
}

function CalendarBlock({ host }: { host: string }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const httpsUrl = useMemo(() => `https://${host}/api/calendar.ics`, [host]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(httpsUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard API can be blocked (insecure context, denied permission):
      // select the URL so the player can copy it manually.
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [httpsUrl]);

  return (
    <div className="mt-4 border-t border-border/60 pt-4">
      <p className="text-sm font-medium">Subscribe to season calendar</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Every Grand Prix and Sprint lock on your calendar with 1h &amp; 30m alarms, updated
        automatically.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <a
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md bg-secondary px-4 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(`webcal://${host}/api/calendar.ics`)}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <CalendarPlus className="size-4" aria-hidden />
          Google Calendar
        </a>
        <a
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md bg-secondary px-4 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          href={`webcal://${host}/api/calendar.ics`}
        >
          <CalendarPlus className="size-4" aria-hidden />
          Apple / System calendar
        </a>
      </div>

      <div className="mt-3 flex flex-wrap items-stretch gap-2">
        <input
          ref={inputRef}
          dir="ltr"
          readOnly
          aria-label="Season calendar link"
          className="min-h-[44px] min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          value={httpsUrl}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-[44px]"
          onClick={copy}
          aria-live="polite"
        >
          {copied ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </div>
  );
}

/**
 * All Telegram link state + actions. Shared by the account-settings card and
 * the compact inline row on the pick-status card, so connecting from either
 * place drives the same flow.
 */
function useTelegramLink() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [host, setHost] = useState("");
  const deadline = useRef(0);

  useEffect(() => {
    setHost(window.location.host);
  }, []);

  // While waiting for the /start confirmation, poll the profile row (RLS lets a
  // player read their own row) instead of adding another endpoint.
  const status = useTelegramStatus(user?.id, phase === "linking");
  const linked = !!status.data?.telegram_linked;

  useEffect(() => {
    if (phase === "linking" && linked) setPhase("linked");
  }, [phase, linked]);

  useEffect(() => {
    if (phase === "linking" && Date.now() > deadline.current) {
      setPhase("idle");
      setError(
        "No confirmation within two minutes. Reopen the link and finish /start in Telegram.",
      );
    }
  }, [phase, status.dataUpdatedAt]);

  const userId = user?.id;

  async function startLink() {
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch("/api/telegram/link", "POST");
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !body?.url) {
        setError(errorMessage(res.status, body));
        return;
      }
      deadline.current = Date.now() + LINK_TIMEOUT_MS;
      setPhase("linking");
      window.open(body.url, "_blank", "noopener,noreferrer");
      await queryClient.invalidateQueries({ queryKey: [STATUS_KEY, userId] });
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch("/api/telegram/link", "DELETE");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(errorMessage(res.status, body));
        return;
      }
      setConfirmUnlink(false);
      setPhase("idle");
      await queryClient.invalidateQueries({ queryKey: [STATUS_KEY, userId] });
      toast.success("Telegram disconnected.");
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      const res = await authedFetch("/api/telegram/test", "POST");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          description?: string;
        } | null;
        toast.error(errorMessage(res.status, body));
        return;
      }
      toast.success("Test message sent to Telegram.");
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleNotify(next: boolean) {
    if (!userId) return;
    setError(null);
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ notify_telegram: next })
      .eq("id", userId);
    if (updateError) {
      setError("Couldn't update the setting. Please try again.");
      return;
    }
    await queryClient.invalidateQueries({ queryKey: [STATUS_KEY, userId] });
  }

  const isLinked = phase === "linked" || linked;

  return {
    phase,
    setPhase,
    error,
    setError,
    busy,
    confirmUnlink,
    setConfirmUnlink,
    showCalendar,
    setShowCalendar,
    host,
    status,
    isLinked,
    startLink,
    unlink,
    sendTest,
    toggleNotify,
  };
}

type TelegramLink = ReturnType<typeof useTelegramLink>;

/** The management UI without any outer card chrome — shared by both wrappers. */
function TelegramPanel({ t }: { t: TelegramLink }) {
  return (
    <>
      {t.error && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <p>{t.error}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2 min-h-[44px]"
            onClick={() => {
              t.setError(null);
              t.setPhase("idle");
            }}
          >
            Try again
          </Button>
        </div>
      )}

      {!t.isLinked && t.phase !== "linking" && (
        <>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Get a Telegram alert before Grand Prix and Sprint picks lock, so you never lose 25
            points.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              className="min-h-[44px]"
              onClick={t.startLink}
              disabled={t.busy}
              aria-busy={t.busy}
            >
              <Link2 className="size-4" aria-hidden />
              Connect Telegram
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="min-h-[44px]"
              onClick={() => t.setShowCalendar((v) => !v)}
              aria-expanded={t.showCalendar}
            >
              <CalendarPlus className="size-4" aria-hidden />
              Subscribe to season calendar
            </Button>
          </div>
        </>
      )}

      {t.phase === "linking" && (
        <div className="mt-3">
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
            Waiting for Telegram… open the chat and tap Start.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              className="min-h-[44px]"
              onClick={t.startLink}
              disabled={t.busy}
            >
              Reopen link
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-[44px]"
              onClick={() => t.setPhase("idle")}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {t.isLinked && t.phase !== "linking" && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span dir="ltr" className="font-mono text-sm">
              @{t.status.data?.telegram_username ?? "telegram"}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
              Connected
            </span>
          </div>

          <label className="mt-4 flex min-h-[44px] cursor-pointer items-center justify-between gap-3 text-sm">
            <span>Telegram reminders</span>
            <input
              type="checkbox"
              className="size-5 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              checked={t.status.data?.notify_telegram ?? true}
              onChange={(e) => t.toggleNotify(e.target.checked)}
            />
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              className="min-h-[44px]"
              onClick={t.sendTest}
              disabled={t.busy}
            >
              <Send className="size-4" aria-hidden />
              Send test message
            </Button>

            {!t.confirmUnlink ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-[44px]"
                onClick={() => t.setConfirmUnlink(true)}
                disabled={t.busy}
              >
                <Unplug className="size-4" aria-hidden />
                Disconnect
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Disconnect?</span>
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-[44px]"
                  onClick={t.unlink}
                  disabled={t.busy}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Confirm
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-[44px]"
                  onClick={() => t.setConfirmUnlink(false)}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {t.host && (t.showCalendar || t.isLinked) && <CalendarBlock host={t.host} />}
    </>
  );
}

/** Full settings card: account modal + onboarding step 2. */
export function TelegramSettings() {
  const t = useTelegramLink();
  return (
    <section
      className="carbon-panel rounded-lg border-l-4 p-4"
      style={{ borderLeftColor: "var(--gold)" }}
    >
      <div className="flex items-center gap-2">
        <Send className="size-4 shrink-0 text-gold" aria-hidden />
        <h3 className="text-sm font-semibold">Telegram alerts</h3>
      </div>
      <TelegramPanel t={t} />
    </section>
  );
}

/**
 * Always-visible compact row for the pick-status card. The row never
 * disappears: once linked it shows the Connected state with the username, and
 * the chevron expands the full management panel (reminder toggle, test send,
 * disconnect and the season-calendar subscribe block).
 */
export function TelegramInline() {
  const { user } = useAuth();
  const t = useTelegramLink();
  const [open, setOpen] = useState(false);

  if (!user) return null;
  const linked = t.isLinked;
  const username = t.status.data?.telegram_username ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Send className="size-4 shrink-0 text-gold" aria-hidden />
          <span className="text-sm font-semibold">Telegram reminders</span>
          {linked ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
              Connected
              {username && (
                <span dir="ltr" className="font-mono">
                  @{username}
                </span>
              )}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Not connected</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!linked && (
            <Button
              type="button"
              size="sm"
              className="min-h-[36px] text-xs font-bold"
              disabled={t.busy}
              aria-busy={t.busy}
              onClick={() => {
                setOpen(true);
                void t.startLink();
              }}
            >
              <Link2 className="size-3.5" aria-hidden />
              Connect
            </Button>
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Hide Telegram settings" : "Show Telegram settings"}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          >
            <ChevronDown
              className={cn("size-4 transition-transform", open && "rotate-180")}
              aria-hidden
            />
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <TelegramPanel t={t} />
        </div>
      )}
    </div>
  );
}
