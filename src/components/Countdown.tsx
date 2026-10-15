import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

function parts(msLeft: number) {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  return {
    d: Math.floor(total / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
}

export function Countdown({ target, label }: { target: string; label: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = now == null ? 1 : new Date(target).getTime() - now;
  const locked = now != null && left <= 0;
  const urgent2h = now != null && !locked && left <= 2 * 3600 * 1000;
  const warning24h = now != null && !locked && !urgent2h && left <= 24 * 3600 * 1000;
  const { d, h, m, s } = parts(left);

  return (
    <div
      className={cn(
        "carbon-panel-strong rounded-md border px-3 py-2 transition-colors",
        urgent2h
          ? "border-primary/70 bg-primary/10"
          : warning24h
            ? "border-gold/50 bg-gold/5"
            : "border-transparent",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </p>
        {urgent2h && (
          <span className="animate-pulse rounded bg-primary px-1.5 py-0.5 font-mono text-[9px] font-black uppercase tracking-wider text-primary-foreground">
            Final Call
          </span>
        )}
        {warning24h && (
          <span className="rounded bg-gold/20 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-gold">
            &lt; 24h Left
          </span>
        )}
      </div>
      {now == null ? (
        <p className="font-mono text-lg font-bold tabular-nums text-muted-foreground">--:--:--</p>
      ) : locked ? (
        <p className="font-display text-lg font-extrabold italic uppercase text-primary">
          Locked
        </p>
      ) : (
        <p
          className={cn(
            "font-mono text-lg font-bold tabular-nums",
            urgent2h && "animate-pulse text-primary",
            warning24h && "text-gold",
          )}
        >
          {d > 0 ? `${d}d ` : ""}
          {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:
          {String(s).padStart(2, "0")}
        </p>
      )}
    </div>
  );
}
