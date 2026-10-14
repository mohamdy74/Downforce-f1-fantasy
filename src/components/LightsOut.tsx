import { useEffect, useState } from "react";

/** Five red start lights fill in sequence, then go out — played after picks are saved. */
export function LightsOut({ onDone }: { onDone: () => void }) {
  const [lit, setLit] = useState(0);
  const [out, setOut] = useState(false);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i <= 5; i++) timers.push(setTimeout(() => setLit(i), i * 280));
    timers.push(setTimeout(() => (setOut(true), import("canvas-confetti").then((m) => m.default({ particleCount: 70, spread: 70, origin: { y: 0.6 }, colors: ["#E10600", "#FFD230", "#FFFFFF"] }))), 5 * 280 + 450));
    timers.push(setTimeout(onDone, 5 * 280 + 2100));
    return () => timers.forEach(clearTimeout);
  }, [onDone]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-background/95 backdrop-blur cursor-pointer"
      onClick={onDone}
    >
      <div className="flex gap-3">
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            className="h-10 w-10 rounded-full border-2 border-border transition-all duration-150 sm:h-12 sm:w-12"
            style={
              !out && lit > i
                ? { background: "var(--primary)", boxShadow: "0 0 24px var(--primary)" }
                : { background: "var(--muted)" }
            }
          />
        ))}
      </div>
      <div
        className="px-6 text-center font-display text-2xl font-black italic uppercase transition-opacity duration-300"
        style={{ opacity: out ? 1 : 0 }}
      >
        <p>Lights out and away we go</p>
        <p className="mt-2 font-mono text-xs uppercase tracking-widest text-muted-foreground not-italic font-normal">
          Picks locked & confirmed for the race 🏁
        </p>
      </div>
    </div>
  );
}
