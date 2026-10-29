import { Bell, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { VAPID_PUBLIC_KEY as PUBLIC_VAPID, urlBase64ToUint8Array } from "@/lib/push-keys";
import { savePushSubscription } from "@/lib/stewards.functions";

export async function syncBrowserSubscription(): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return false;
  }
  const reg = await navigator.serviceWorker.register("/sw.js");
  await reg.update().catch((error) => {
    console.error("[PushOptIn] Service Worker update failed:", error);
  });
  const readyReg = await navigator.serviceWorker.ready;

  let sub = await readyReg.pushManager.getSubscription();
  if (!sub) {
    sub = await readyReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID),
    });
  }
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.["p256dh"] || !json.keys?.["auth"]) return false;

  await savePushSubscription({
    data: {
      endpoint: json.endpoint,
      p256dh: json.keys["p256dh"],
      auth: json.keys["auth"],
    },
  });
  return true;
}

export function PushOptIn() {
  const { user } = useAuth();
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
      setPerm("unsupported");
      return;
    }
    setPerm(Notification.permission);
    if (user && Notification.permission === "granted") {
      syncBrowserSubscription().catch((error) => {
        console.error("[PushOptIn] Subscription sync failed:", error);
      });
    }
  }, [user?.id]);

  if (!user || perm === "unsupported") return null;

  async function enableAlerts() {
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPerm(result);
      if (result !== "granted") {
        toast.error("Please allow notifications in your browser settings.");
        return;
      }
      const ok = await syncBrowserSubscription();
      if (ok) {
        toast.success("Race reminders enabled on this device!");
        const reg = await navigator.serviceWorker.ready;
        reg.showNotification("🏎️ DOWNFORCE Alerts Active!", {
          body: "You will get notified 2h & 30m before Qualifying and Race lock.",
          icon: "/favicon.png",
          badge: "/favicon.png",
          tag: "downforce-welcome",
        }).catch((error) => {
          console.error("[PushOptIn] Notification display failed:", error);
        });;
      }
    } catch {
      toast.error("Could not activate push alerts on this browser.");
    } finally {
      setBusy(false);
    }
  }

  if (perm === "granted") {
    return (
      <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-secondary/20 px-3.5 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
          Auto-reminders active (2h &amp; 30m before lock)
        </span>
      </div>
    );
  }

  return (
    <div className="carbon-panel mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border-l-4 px-4 py-3" style={{ borderLeftColor: "var(--gold)" }}>
      <div className="flex items-center gap-2.5">
        <Bell className="h-4 w-4 shrink-0 text-gold" />
        <span className="text-xs font-medium">
          Get notified <strong>2h &amp; 30m</strong> before picks lock so you never take a −25 penalty
        </span>
      </div>
      <Button size="sm" variant="secondary" disabled={busy} onClick={enableAlerts} className="h-8 text-xs font-bold">
        {busy ? "Enabling..." : "Enable Alerts 🔔"}
      </Button>
    </div>
  );
}
