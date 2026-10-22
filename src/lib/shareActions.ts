import { toast } from "sonner";

/**
 * Shared actions for saving PNG blobs, Web Share API invocation,
 * clipboard copying, and Cairo timezone date formatting.
 */

export function saveBlob(blob: Blob, fileName: string): void {
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

export async function shareImageFile(
  blob: Blob,
  fileName: string,
  title: string,
): Promise<void> {
  const file = new File([blob], fileName, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return;
    }
  }
  saveBlob(blob, fileName);
}

export async function shareOrCopyText(text: string): Promise<void> {
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

export function formatCairoDate(iso: string | null | undefined, seconds = false): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d
    .toLocaleString("en-GB", {
      timeZone: "Africa/Cairo",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" as const } : {}),
    })
    .toUpperCase();
}