import { useEffect, useState } from "react";
import { getTrustedNow } from "@/lib/queries";
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
  // null until mounted so server and browser render the same placeholder
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(getTrustedNow());
    const id = setInterval(() => setNow(getTrustedNow()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = now == null ? 1 : new Date(target).getTime() - now;
  const locked = now != null && left <= 0;
  const urgent2h = now != null && !locked && left <= 2 * 3600 * 1000;
  const { d, h, m, s } = parts(left);

  const cells = [
    { value: d, unit: "DAYS" },
    { value: h, unit: "HRS" },
    { value: m, unit: "MIN" },
    { value: s, unit: "SEC" },
  ];

  return (
    <div
      className={cn(
        "carbon-panel-strong rounded-xl border p-3.5 transition-colors",
        urgent2h ? "border-primary/70 bg-primary/5" : "border-border/80",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </p>
        {urgent2h && (
          <span className="animate-pulse rounded bg-primary px-1.5 py-0.5 font-mono text-[9px] font-black uppercase tracking-wider text-primary-foreground">
            Closing Soon
          </span>
        )}
      </div>

      {locked ? (
        <div className="mt-2.5 flex h-[62px] items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
          <p className="font-display text-lg font-extrabold italic uppercase tracking-wider text-primary">
            Locked
          </p>
        </div>
      ) : (
        <div className="mt-2.5 grid grid-cols-4 gap-2 sm:gap-2.5">
          {cells.map((c) => (
            <div
              key={c.unit}
              className="flex flex-col items-center justify-center rounded-lg border border-white/5 bg-secondary/75 px-2 py-2.5 text-center shadow-inner"
            >
              <span
                className={cn(
                  "font-mono text-xl font-extrabold tabular-nums leading-none sm:text-2xl",
                  urgent2h ? "text-primary" : "text-foreground",
                )}
              >
                {now == null ? "--" : String(c.value).padStart(2, "0")}
              </span>
              <span className="mt-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground leading-none">
                {c.unit}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}