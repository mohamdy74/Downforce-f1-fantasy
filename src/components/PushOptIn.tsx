import { Bell, BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { getVapidPublicKey, savePushSubscription } from "@/lib/push.functions";
import { urlBase64ToUint8Array } from "@/lib/push-vapid";

export function PushOptIn() {
  const { user } = useAuth();
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    setSupported(true);

    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => { setSubscribed(!!sub); if (!localStorage.getItem("dfr:push-ok") && (sub || Notification.permission === "granted")) enableAlerts(); else window.addEventListener("click", () => enableAlerts(), { once: true }); })
      .catch(() => {});
  }, []);

  return null;

  async function enableAlerts() {
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        toast.error("Please allow notifications in your browser settings.");
        return;
      }

      const { publicKey } = await getVapidPublicKey();
      if (!publicKey) {
        toast.error("Push server keys (VAPID) are not configured yet.");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      const json = sub.toJSON();
      const endpoint = json.endpoint ?? "";
      const p256dh = json.keys?.["p256dh"] ?? "";
      const auth = json.keys?.["auth"] ?? "";

      if (!endpoint || !p256dh || !auth) {
        throw new Error("Invalid browser push subscription.");
      }

      await savePushSubscription({ data: { endpoint, p256dh, auth } });
      setSubscribed(true);
      localStorage.setItem("dfr:push-ok", "1");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant={subscribed ? "ghost" : "secondary"}
      disabled={busy || subscribed}
      onClick={enableAlerts}
      className="gap-1.5"
    >
      {subscribed ? (
        <>
          <BellRing className="h-4 w-4 text-success" />
          Alerts active (2h & 30m)
        </>
      ) : (
        <>
          <Bell className="h-4 w-4 text-gold" />
          {busy ? "Enabling…" : "Notify me 2h & 30m before lock"}
        </>
      )}
    </Button>
  );
}
