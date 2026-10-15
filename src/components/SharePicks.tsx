import { useQuery } from "@tanstack/react-query";
import { Copy, Download, Image as ImageIcon, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { Driver } from "@/lib/queries";
import { renderPickCard, type CardData, type CardDriver } from "@/lib/shareCard";

const MEDAL = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

export function SharePicks({
  raceName,
  round,
  playerName,
  drivers,
  top10,
  pole,
  fastestLap,
  dnf,
  lockedAt,
}: {
  raceName: string;
  round: number;
  playerName: string;
  drivers: Driver[];
  top10: string[];
  pole: string | null;
  fastestLap: string | null;
  dnf: string | null;
  lockedAt?: string | null;
}) {
  const { user } = useAuth();
  const { data: leagueName } = useQuery({
    queryKey: ["profile-name", user?.id],
    enabled: !!user,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user!.id)
        .maybeSingle();
      return data?.display_name ?? null;
    },
  });
  const shownName = (leagueName || playerName || "Player").trim();

  const byId = new Map(drivers.map((d) => [d.id, d]));
  const name = (id: string | null) => (id ? (byId.get(id)?.full_name ?? "—") : "—");
  const url = typeof window !== "undefined" ? `${window.location.origin}/predict` : "";
  const fileName = `downforce-round-${round}.png`;

  const text = [
    `🏎️ ${shownName}'s predictions for ${raceName} (Round ${round}) 🏁`,
    "━━━━━━━━━━━━━━",
    ...top10.map((id, i) => `${MEDAL[i]} P${i + 1}: ${name(id)}`),
    `⚡ Pole: ${name(pole)}`,
    `🟣 Fastest Lap: ${name(fastestLap)}`,
    `💥 DNF pick: ${name(dnf)}`,
    "━━━━━━━━━━━━━━",
    `🏆 Check my picks & challenge me on DOWNFORCE:`,
    url,
  ].join("\n");

  const ref = (id: string | null): CardDriver => {
    const d = id ? byId.get(id) : undefined;
    return d ? { code: d.code, name: d.full_name, team: d.team, number: d.number } : null;
  };
  const cardData = (): CardData => ({
    raceName,
    round,
    playerName: shownName,
    top10: top10.map(ref),
    pole: ref(pole),
    fastestLap: ref(fastestLap),
    dnf: ref(dnf),
    host: typeof window !== "undefined" ? window.location.host : "downforce",
    lockedAt,
  });

  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const cachedBlobRef = useRef<Blob | null>(null);
  const key = [raceName, round, shownName, top10.join(","), pole, fastestLap, dnf, drivers.length, lockedAt].join("|");

  // Pre-render the card in the background as soon as picks exist so opening the modal is 0ms instant
  useEffect(() => {
    if (drivers.length === 0) return;
    let dead = false;
    let objectUrl: string | null = null;
    renderPickCard(cardData()).then((blob) => {
      if (!blob || dead) return;
      cachedBlobRef.current = blob;
      objectUrl = URL.createObjectURL(blob);
      setPreview(objectUrl);
    });
    return () => {
      dead = true;
      cachedBlobRef.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setPreview(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function saveBlob(blob: Blob) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
    toast.success("Image saved.");
  }

  async function handleDownloadImage() {
    const blob = cachedBlobRef.current ?? (await renderPickCard(cardData()));
    if (!blob) {
      toast.error("Couldn't create the image.");
      return;
    }
    saveBlob(blob);
  }

  async function handleShareImage() {
    const blob = cachedBlobRef.current ?? (await renderPickCard(cardData()));
    if (!blob) {
      toast.error("Couldn't create the image.");
      return;
    }
    const file = new File([blob], fileName, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `DOWNFORCE — ${raceName}` });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return;
      }
    }
    saveBlob(blob);
  }

  async function nativeShareText() {
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="lg" className="h-12 w-full gap-2 border-gold/60 text-gold">
          <Share2 className="h-4 w-4" />
          Share Picks 🏁
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92dvh] max-w-sm overflow-y-auto p-0">
        <DialogTitle className="sr-only">Share your picks</DialogTitle>
        <div className="aspect-[4/5] w-full overflow-hidden rounded-t-lg bg-muted/40">
          {preview ? (
            <img src={preview} alt={`${shownName}'s picks for ${raceName}`} className="h-full w-full" />
          ) : (
            <div className="h-full w-full animate-pulse" />
          )}
        </div>

        <div className="space-y-2 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={handleShareImage} className="gap-2">
              <ImageIcon className="h-4 w-4" /> Share Card
            </Button>
            <Button variant="outline" onClick={handleDownloadImage} className="gap-2">
              <Download className="h-4 w-4" /> Save PNG
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={nativeShareText} className="h-9 gap-1.5 text-xs">
              <Share2 className="h-3.5 w-3.5" /> Share Text
            </Button>
            <Button
              variant="ghost"
              className="h-9 gap-1.5 text-xs"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  toast.success("Copied text to clipboard!");
                } catch {
                  toast.error("Couldn't copy. Use Share Text instead.");
                }
              }}
            >
              <Copy className="h-3.5 w-3.5" /> Copy Text
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
