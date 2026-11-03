import { cn } from "@/lib/utils";

/** Shared R{round} chip bar — one style everywhere (weekend + paddock). */
export function RoundChips({
  rounds,
  activeId,
  onSelect,
  className,
}: {
  rounds: { id: string; round: number }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-1.5 overflow-x-auto py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {rounds.map((r) => {
        const on = r.id === activeId;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onSelect(r.id)}
            aria-pressed={on}
            className={cn(
              "hit-slop shrink-0 rounded-full border px-3.5 py-1.5 font-mono text-xs font-bold uppercase tracking-widest transition-colors",
              on
                ? "border-primary bg-primary/15 text-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            R{r.round}
          </button>
        );
      })}
    </div>
  );
}
