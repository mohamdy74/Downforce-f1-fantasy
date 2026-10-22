import { useEffect, useState } from "react";
import { getTrustedNow } from "@/lib/queries";

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
  // null until mounted so server and browser render the same placeholder (no wrong-number flash).
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(getTrustedNow());
    const id = setInterval(() => setNow(getTrustedNow()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = now == null ? 1 : new Date(target).getTime() - now;
  const locked = left <= 0;
  const { d, h, m, s } = parts(left);

  return (
    <div className="carbon-panel-strong rounded-lg border border-border/80 p-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      {now == null ? (
        <p className="font-mono text-lg font-bold tabular-nums text-muted-foreground">--:--:--</p>
      ) : locked ? (
        <p className="font-display text-lg font-extrabold italic uppercase text-primary">
          Locked
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">{[{v:d,u:"DAYS"},{v:h,u:"HRS"},{v:m,u:"MIN"},{v:s,u:"SEC"}].map((x)=>(<div key={x.u} className="rounded bg-secondary/80 py-1.5 border border-border/50"><span className={left<7200000?"block font-mono text-base sm:text-lg font-extrabold tabular-nums leading-none text-primary animate-pulse":"block font-mono text-base sm:text-lg font-extrabold tabular-nums leading-none text-foreground"}>{String(x.v).padStart(2,"0")}</span><span className="mt-1 block font-mono text-[9px] font-bold tracking-widest text-muted-foreground">{x.u}</span></div>))}</div>
      )}
    </div>
  );
}