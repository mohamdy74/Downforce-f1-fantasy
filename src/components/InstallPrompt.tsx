import { useLocation } from "@tanstack/react-router";
import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const VISITS_KEY = "dfr:visits";
const DISMISSED_KEY = "dfr:install-dismissed";

/**
 * Android / Chrome only: offers "Add to Home screen" from the second visit on (home page only).
 * An installed app opens in one tap, which is the best cure for forgetting to make picks.
 * If the browser never fires the install event (iPhone, already installed) nothing is shown.
 */
export function InstallPrompt() {
  const { pathname } = useLocation();
  const [event, setEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    try {
      if (window.matchMedia("(display-mode: standalone)").matches) return;
      const visits = Number(window.localStorage.getItem(VISITS_KEY) ?? "0") + 1;
      window.localStorage.setItem(VISITS_KEY, String(visits));
      if (window.localStorage.getItem(DISMISSED_KEY) || visits < 2) return;

      const onPrompt = (e: Event) => {
        e.preventDefault();
        setEvent(e as InstallEvent);
      };
      const onInstalled = () => setEvent(null);
      window.addEventListener("beforeinstallprompt", onPrompt);
      window.addEventListener("appinstalled", onInstalled);
      return () => {
        window.removeEventListener("beforeinstallprompt", onPrompt);
        window.removeEventListener("appinstalled", onInstalled);
      };
    } catch {
      return;
    }
  }, []);

  if (!event || pathname !== "/") return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* ignore */
    }
    setEvent(null);
  };

  return (
    <div className="fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 md:hidden">
      <div className="carbon-panel flex items-center gap-3 rounded-lg p-3 shadow-lg">
        <Download className="h-5 w-5 shrink-0 text-gold" />
        <p className="min-w-0 flex-1 text-sm leading-snug">
          Add <strong>DOWNFORCE</strong> to your home screen. One tap to make your picks.
        </p>
        <Button
          size="sm"
          onClick={async () => {
            await event.prompt();
            const choice = await event.userChoice.catch(() => null);
            if (choice?.outcome === "dismissed") dismiss();
            else setEvent(null);
          }}
        >
          Install
        </Button>
        <button type="button" aria-label="Dismiss" onClick={dismiss} className="shrink-0 p-1 text-muted-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
