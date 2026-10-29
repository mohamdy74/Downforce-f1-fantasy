import { useQuery } from "@tanstack/react-query";
import { Copy, Download, Flag, Image as ImageIcon, Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { Driver } from "@/lib/queries";
import type { PoleCardData } from "@/lib/shareCard";
import { saveBlob, shareImageFile, shareOrCopyText, formatCairoDate } from "@/lib/shareActions";

/**
 * Stand-alone "pole position" share card. Works with or without a saved top 10:
 * all it needs is the race, the player and the driver picked for pole.
 */
export function SharePole({
  raceName,
  round,
  playerName,
  driver,
  savedAt,
  circuit,
  className,
}: {
  raceName: string;
  round: number;
  playerName: string;
  /** the driver picked for pole (null/undefined = nothing picked yet) */
  driver: Driver | null | undefined;
  /** ISO time the pole pick was saved; shown on the card in Cairo time */
  savedAt: string | null | undefined;
  /** circuit / location line shown under the race name */
  circuit?: string | null | undefined;
  className?: string;
}) {
  const { user } = useAuth();
  // Same name the league table shows; falls back to the Google name.
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
  const when = formatCairoDate(savedAt, true);
  const url = typeof window !== "undefined" ? `${window.location.origin}/predict` : "";
  const fileName = `downforce-pole-round-${round}.png`;

  const text = [
    `⚡ ${shownName}'s pole pick for ${raceName} (Round ${round})`,
    `🏁 Pole: ${driver?.full_name ?? "—"}`,
    when ? `🔒 Locked in ${when.replace(" · ", ", ")} (Cairo time)` : "",
    `🏆 Beat me on DOWNFORCE:`,
    url,
  ]
    .filter(Boolean)
    .join("\n");

  const card = (): PoleCardData => ({
    raceName,
    round,
    playerName: shownName,
    driver: driver
      ? { code: driver.code, name: driver.full_name, team: driver.team, number: driver.number }
      : null,
    circuit,
    savedAtLabel: when,
    host: typeof window !== "undefined" ? window.location.host : "downforce",
  });

  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [cachedBlob, setCachedBlob] = useState<Blob | null>(null);
  const key = [raceName, round, shownName, driver?.id, savedAt].join("|");
  useEffect(() => {
    if (!open) return;
    let dead = false;
    let objectUrl: string | null = null;
    import("@/lib/shareCard")
      .then((m) => m.renderPoleCard(card()))
      .then((blob) => {
        if (!blob || dead) return;
        objectUrl = URL.createObjectURL(blob);
        setCachedBlob(blob);
        setPreview(objectUrl);
      });
    return () => {
      dead = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setPreview(null);
      setCachedBlob(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  async function handleDownload() {
    const blob = cachedBlob ?? (await (await import("@/lib/shareCard")).renderPoleCard(card()));
    if (!blob) {
      toast.error("Couldn't create the image.");
      return;
    }
    saveBlob(blob, fileName);
  }

  async function handleShareImage() {
    const blob = cachedBlob ?? (await (await import("@/lib/shareCard")).renderPoleCard(card()));
    if (!blob) {
      toast.error("Couldn't create the image.");
      return;
    }
    await shareImageFile(blob, fileName, `DOWNFORCE \u2014 ${raceName} pole pick`);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={!driver}
          className={className ?? "h-11 w-full gap-2 border-gold/60 text-gold"}
        >
          <Flag className="h-4 w-4" />
          Share pole card
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92dvh] max-w-sm overflow-y-auto p-0">
        <DialogTitle className="sr-only">Share your pole pick</DialogTitle>
        <div className="aspect-[4/5] w-full overflow-hidden rounded-t-lg bg-muted/40">
          {preview ? (
            <img
              src={preview}
              alt={`${shownName}'s pole pick for ${raceName}`}
              className="h-full w-full"
            />
          ) : (
            <div className="h-full w-full animate-pulse" />
          )}
        </div>
        <div className="space-y-2 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={handleShareImage} className="gap-2">
              <ImageIcon className="h-4 w-4" /> Share Card
            </Button>
            <Button variant="outline" onClick={handleDownload} className="gap-2">
              <Download className="h-4 w-4" /> Save PNG
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              onClick={() => shareOrCopyText(text)}
              className="h-9 gap-1.5 text-xs"
            >
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
