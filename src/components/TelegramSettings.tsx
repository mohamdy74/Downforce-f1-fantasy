import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Check, Copy, Link2, Send, Trash2, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

const POLL_MS = 3_000;
const LINK_TIMEOUT_MS = 120_000;
const DISMISS_KEY = "downforce:telegram-callout-dismissed";
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

/** Shared by the settings card and the home-screen callout. */
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

function errorMessage(status: number, body: { error?: string } | null): string {
  if (body?.error === "telegram_not_configured") return "التذكيرات غير مفعّلة على الخادم بعد.";
  if (status === 401) return "انتهت الجلسة، سجّل الدخول من جديد.";
  if (status === 400 || body?.error === "not_linked") return "هذا الحساب غير مربوط بتيليجرام.";
  return "تعذّر الاتصال بالخادم. حاول مرة أخرى.";
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
      <p className="text-sm font-medium">اشتراك في تقويم الموسم</p>
      <p className="mt-1 text-xs text-muted-foreground">
        مواعيد إغلاق الجراند بري والسبرنت على تقويمك، تُحدَّث تلقائياً.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <a
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md bg-secondary px-4 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(`webcal://${host}/api/calendar.ics`)}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <CalendarPlus className="size-4" aria-hidden />
          تقويم Google
        </a>
        <a
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md bg-secondary px-4 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          href={`webcal://${host}/api/calendar.ics`}
        >
          <CalendarPlus className="size-4" aria-hidden />
          تقويم Apple / النظام
        </a>
      </div>

      <div className="mt-3 flex flex-wrap items-stretch gap-2">
        <input
          ref={inputRef}
          dir="ltr"
          readOnly
          aria-label="رابط تقويم الموسم"
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
          {copied ? "تم النسخ" : "نسخ الرابط"}
        </Button>
      </div>
    </div>
  );
}

export function TelegramSettings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [host, setHost] = useState("");
  const deadline = useRef<number>(0);

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
      setError("لم يصل التأكيد خلال دقيقتين. افتح الرابط من جديد وأكمل /start في تيليجرام.");
    }
  }, [phase, status.dataUpdatedAt]);

  if (!user) return null;
  const userId = user.id;

  async function startLink() {
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
      setError("تعذّر الاتصال بالخادم. حاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
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
      toast.success("تم فصل حساب تيليجرام.");
    } catch {
      setError("تعذّر الاتصال بالخادم. حاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    try {
      const res = await authedFetch("/api/telegram/test", "POST");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(errorMessage(res.status, body));
        return;
      }
      toast.success("أُرسلت رسالة تجريبية إلى تيليجرام.");
    } catch {
      toast.error("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleNotify(next: boolean) {
    setError(null);
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ notify_telegram: next })
      .eq("id", userId);
    if (updateError) {
      setError("تعذّر تحديث الإعداد. حاول مرة أخرى.");
      return;
    }
    await queryClient.invalidateQueries({ queryKey: [STATUS_KEY, userId] });
  }

  const isLinked = phase === "linked" || linked;

  return (
    <section
      className="carbon-panel rounded-lg border-l-4 p-4"
      style={{ borderLeftColor: "var(--gold)" }}
    >
      <div className="flex items-center gap-2">
        <Send className="size-4 shrink-0 text-gold" aria-hidden />
        <h3 className="text-sm font-semibold">تنبيهات تيليجرام</h3>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <p>{error}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2 min-h-[44px]"
            onClick={() => {
              setError(null);
              setPhase("idle");
            }}
          >
            إعادة المحاولة
          </Button>
        </div>
      )}

      {!isLinked && phase !== "linking" && (
        <>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            يصلك تنبيه قبل إغلاق توقعات الجراند بري والسبرنت على تيليجرام، حتى لا تخسر 25 نقطة.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              className="min-h-[44px]"
              onClick={startLink}
              disabled={busy}
              aria-busy={busy}
            >
              <Link2 className="size-4" aria-hidden />
              ربط تيليجرام
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="min-h-[44px]"
              onClick={() => setShowCalendar((v) => !v)}
              aria-expanded={showCalendar}
            >
              <CalendarPlus className="size-4" aria-hidden />
              اشتراك في تقويم الموسم
            </Button>
          </div>
        </>
      )}

      {phase === "linking" && (
        <div className="mt-3">
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
            بانتظار التأكيد من تيليجرام… افتح المحادثة واضغط Start.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              className="min-h-[44px]"
              onClick={startLink}
              disabled={busy}
            >
              إعادة فتح الرابط
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-[44px]"
              onClick={() => setPhase("idle")}
            >
              إلغاء
            </Button>
          </div>
        </div>
      )}

      {isLinked && phase !== "linking" && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span dir="ltr" className="font-mono text-sm">
              @{status.data?.telegram_username ?? "telegram"}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
              متصل
            </span>
          </div>

          <label className="mt-4 flex min-h-[44px] cursor-pointer items-center justify-between gap-3 text-sm">
            <span>تذكير عبر تيليجرام</span>
            <input
              type="checkbox"
              className="size-5 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              checked={status.data?.notify_telegram ?? true}
              onChange={(e) => toggleNotify(e.target.checked)}
            />
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              className="min-h-[44px]"
              onClick={sendTest}
              disabled={busy}
            >
              <Send className="size-4" aria-hidden />
              إرسال رسالة تجريبية
            </Button>

            {!confirmUnlink ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-[44px]"
                onClick={() => setConfirmUnlink(true)}
                disabled={busy}
              >
                <Unplug className="size-4" aria-hidden />
                فصل الحساب
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">تأكيد الفصل؟</span>
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-[44px]"
                  onClick={unlink}
                  disabled={busy}
                >
                  <Trash2 className="size-4" aria-hidden />
                  تأكيد
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-[44px]"
                  onClick={() => setConfirmUnlink(false)}
                >
                  إلغاء
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {host && (showCalendar || isLinked) && <CalendarBlock host={host} />}
    </section>
  );
}

export function TelegramCallout({ onOpen }: { onOpen: () => void }) {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
  }, []);

  const { data } = useTelegramStatus(user?.id);

  if (!user || dismissed || data?.telegram_linked) return null;

  return (
    <div
      className="carbon-panel mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border-l-4 px-4 py-3"
      style={{ borderLeftColor: "var(--gold)" }}
    >
      <span className="text-xs font-medium">
        فعّل تذكيرات تيليجرام قبل إغلاق التوقعات ولا تخسر 25 نقطة.
      </span>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" className="min-h-[44px] text-xs font-bold" onClick={onOpen}>
          ربط
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="min-h-[44px] text-xs"
          onClick={() => {
            window.localStorage.setItem(DISMISS_KEY, "1");
            setDismissed(true);
          }}
        >
          إخفاء
        </Button>
      </div>
    </div>
  );
}
