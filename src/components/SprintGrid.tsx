import { useMemo, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { GripVertical, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DriverPicker } from "@/components/DriverPicker";
import type { Driver } from "@/lib/queries";
import { sortByTeam, teamColor, teamLabel, teamsOf } from "@/lib/teams";
import { cn } from "@/lib/utils";

export const EMPTY = "__none__";

// Re-export DriverPicker as DriverSelect for backward compat with sprint.tsx
export const DriverSelect = DriverPicker;

export function SprintGrid({
  drivers,
  top10,
  setTop10,
  locked,
  size,
  onRepeat,
}: {
  size: number;
  drivers: Driver[];
  top10: string[];
  setTop10: React.Dispatch<React.SetStateAction<string[]>>;
  locked: boolean;
  onRepeat?: (() => void) | undefined;
}) {
  const [active, setActive] = useState(() => {
    const i = top10.indexOf(EMPTY);
    return i === -1 ? 0 : i;
  });
  const [drag, setDrag] = useState<{
    from: number;
    over: number | null;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [teamFilter, setTeamFilter] = useState<string | null>(null);
  const [gridAnimRef] = useAutoAnimate<HTMLDivElement>();
  const [animRef] = useAutoAnimate<HTMLDivElement>();
  const dragRef = useRef<{
    from: number;
    x: number;
    y: number;
    moved: boolean;
    fromGrip: boolean;
    pointerId: number;
    target: HTMLElement;
  } | null>(null);
  const byId = new Map(drivers.map((d) => [d.id, d]));
  const used = new Set(top10.filter((d) => d !== EMPTY));
  const sorted = useMemo(() => sortByTeam(drivers), [drivers]);
  const teams = useMemo(() => teamsOf(drivers), [drivers]);
  const deck = teamFilter ? sorted.filter((d) => teamLabel(d.team) === teamFilter) : sorted;

  function place(id: string) {
    if (locked) return;
    setTop10((prev) => {
      const next = prev.map((p) => (p === id ? EMPTY : p));
      next[active] = id;
      const empty = next.findIndex((p, i) => p === EMPTY && i > active);
      const first = next.indexOf(EMPTY);
      setActive(empty !== -1 ? empty : first !== -1 ? first : active);
      navigator.vibrate?.(10);
      return next;
    });
  }

  function clearSlot(i: number) {
    const snapshot = [...top10];
    const removedId = top10[i];
    const removedDriver = removedId && removedId !== EMPTY ? byId.get(removedId) : undefined;
    setTop10((prev) => prev.map((p, idx) => (idx === i ? EMPTY : p)));
    setActive(i);
    if (removedDriver) {
      toast(`Cleared P${i + 1} (${removedDriver.code ?? removedDriver.full_name})`, {
        action: {
          label: "Undo",
          onClick: () => {
            setTop10(snapshot);
            setActive(i);
          },
        },
      });
    }
  }

  function slotAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y)?.closest("[data-slot]");
    return el ? Number(el.getAttribute("data-slot")) : null;
  }

  function onDown(e: React.PointerEvent, i: number) {
    if (locked || top10[i] === EMPTY) return;
    const isGrip = !!(e.target as HTMLElement).closest("[data-grip]");
    const isMouse = e.pointerType === "mouse";
    const target = e.currentTarget as HTMLElement;
    dragRef.current = {
      from: i,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      fromGrip: isGrip || isMouse,
      pointerId: e.pointerId,
      target,
    };
    if (isGrip || isMouse) {
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  }

  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    // On touch devices, only initiate drag when grabbing the grip handle so normal vertical scrolling never hijacks picks
    if (!d.fromGrip) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
    if (!d.moved) {
      d.moved = true;
      navigator.vibrate?.(8);
    }
    setDrag({
      from: d.from,
      over: slotAt(e.clientX, e.clientY),
      clientX: e.clientX,
      clientY: e.clientY,
    });
  }

  function onUp(e: React.PointerEvent, i: number) {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || !d.moved) {
      const dr = top10[i] !== EMPTY;
      if (dr && i === active) clearSlot(i);
      else setActive(i);
      return;
    }
    const to = slotAt(e.clientX, e.clientY);
    if (to == null || to === d.from) return;
    setTop10((prev) => {
      const next = [...prev];
      [next[d.from], next[to]] = [next[to]!, next[d.from]!];
      return next;
    });
    setActive(to);
    navigator.vibrate?.(15);
  }

  const allOn = teamFilter === null;
  const primaryColor = "var(--color-primary)";
  const draggedDriver =
    drag != null && top10[drag.from] && top10[drag.from] !== EMPTY
      ? byId.get(top10[drag.from]!)
      : undefined;

  return (
    <section className="carbon-panel mt-8 rounded-lg">
      <div className="kerb-strip" />
      <div className="p-3 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="whitespace-nowrap text-lg sm:text-xl">
            {size === 10 ? "Starting grid" : "Sprint grid"}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {!locked && onRepeat && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="hit-slop gap-1.5 border-gold/45 bg-gold/10 font-mono text-[11px] font-bold uppercase tracking-wider text-gold hover:bg-gold/20"
                onClick={() => {
                  onRepeat();
                  navigator.vibrate?.(12);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Repeat Last
              </Button>
            )}
            {!locked && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="hit-slop"
                  disabled={active <= 0}
                  aria-label="Move driver up"
                  onClick={() => {
                    if (active <= 0) return;
                    setTop10((p) => {
                      const n = [...p];
                      [n[active - 1], n[active]] = [n[active]!, n[active - 1]!];
                      return n;
                    });
                    setActive(active - 1);
                    navigator.vibrate?.(10);
                  }}
                >
                  &#8593;
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="hit-slop"
                  disabled={active >= size - 1}
                  aria-label="Move driver down"
                  onClick={() => {
                    if (active >= size - 1) return;
                    setTop10((p) => {
                      const n = [...p];
                      [n[active + 1], n[active]] = [n[active]!, n[active + 1]!];
                      return n;
                    });
                    setActive(active + 1);
                    navigator.vibrate?.(10);
                  }}
                >
                  &#8595;
                </Button>
              </>
            )}

            {!locked && used.size > 0 && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="hit-slop"
                onClick={() => {
                  const snapshot = [...top10];
                  const prevActive = active;
                  setTop10(Array(size).fill(EMPTY));
                  setActive(0);
                  toast("Grid cleared", {
                    action: {
                      label: "Undo",
                      onClick: () => {
                        setTop10(snapshot);
                        setActive(prevActive);
                      },
                    },
                  });
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Tap a slot, then a driver. Drag the grip handle <span className="font-mono text-xs text-foreground/80">\u22ee\u22ee</span> to swap positions.
        </p>

        <div
          ref={gridAnimRef}
          className="mt-4 grid grid-cols-2 gap-x-2.5 gap-y-2 sm:gap-x-3"
        >
          {top10.map((id, i) => {
            const d = id !== EMPTY ? byId.get(id) : undefined;
            const isActive = i === active && !locked;
            const color = d ? teamColor(d.team) : "transparent";
            return (
              <button
                key={d ? `slot-${d.id}` : `empty-slot-${i}`}
                type="button"
                data-slot={i}
                disabled={locked}
                onPointerDown={(e) => onDown(e, i)}
                onPointerMove={onMove}
                onPointerUp={(e) => onUp(e, i)}
                onPointerCancel={() => {
                  dragRef.current = null;
                  setDrag(null);
                }}
                onLostPointerCapture={() => {
                  dragRef.current = null;
                  setDrag(null);
                }}
                className={cn(
                  "flex h-16 select-none items-center gap-2 overflow-hidden rounded-md border bg-background/70 pr-1.5 text-left transition",
                  i % 2 === 1 && "mt-5",
                  isActive && "border-primary ring-2 ring-primary/70",
                  !d && !isActive && "border-dashed",
                  drag?.from === i && "drag-ghost scale-[0.97]",
                  drag && drag.over === i && drag.from !== i && "drop-target scale-[1.02]",
                )}
                style={{
                  borderLeft: `5px solid ${color}`,
                  paddingLeft: "0.5rem",
                  touchAction: "pan-y",
                  boxShadow: d
                    ? `inset 0 0 24px -8px color-mix(in oklch, ${color} 55%, transparent), 0 0 14px -6px ${color}`
                    : undefined,
                  borderBottom: "2px solid oklch(1 0 0 / 0.35)",
                }}
              >
                <span
                  className={cn(
                    "w-8 shrink-0 rounded-sm py-1 text-center font-mono text-xs font-bold tabular-nums",
                    i === 0 ? "bg-gold text-gold-foreground" : "bg-secondary text-foreground",
                  )}
                >
                  P{i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    {d?.number != null && (
                      <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                        #{d.number}
                      </span>
                    )}
                    <span className="min-w-0 truncate font-display text-base font-extrabold italic uppercase leading-tight">
                      {d ? (d.code ?? d.full_name) : "\u2014"}
                    </span>
                  </span>
                  <span className="block truncate text-[11px] font-medium text-muted-foreground">
                    {d ? d.team : isActive ? "Pick a driver" : "Empty"}
                  </span>
                </span>
                {d && !locked && (
                  <span
                    data-grip="true"
                    aria-hidden="true"
                    style={{ touchAction: "none" }}
                    className="hit-slop flex h-10 w-7 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
                  >
                    <GripVertical className="h-4 w-4" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Floating GPU-accelerated Drag Preview Pill */}
        {drag && draggedDriver && (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-[120] flex items-center gap-2 rounded-lg border border-gold bg-card/95 px-3 py-1.5 shadow-2xl backdrop-blur-md"
            style={{
              transform: `translate3d(${drag.clientX - 48}px, ${drag.clientY - 54}px, 0)`,
              borderLeft: `4px solid ${teamColor(draggedDriver.team)}`,
              willChange: "transform",
            }}
          >
            <span className="rounded bg-gold px-1.5 py-0.5 font-mono text-[10px] font-bold text-gold-foreground">
              P{drag.over != null ? drag.over + 1 : drag.from + 1}
            </span>
            <span className="font-display text-sm font-extrabold italic uppercase">
              {draggedDriver.code ?? draggedDriver.full_name}
            </span>
          </div>
        )}

        {!locked && (
          <>
            <p className="mt-6 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Drivers \u00b7 filling <span className="text-primary">P{active + 1}</span>{" "}
              <span className="ml-1 tabular-nums text-foreground">
                ({used.size}/{size})
              </span>{" "}
              <button
                type="button"
                onClick={() =>
                  document
                    .querySelector('[data-slot="0"]')
                    ?.scrollIntoView({ behavior: "smooth", block: "center" })
                }
                className="hit-slop ml-2 text-primary underline"
              >
                Top
              </button>
            </p>

            <div className="sticky top-[52px] z-20 -mx-3 mt-2.5 flex gap-2 overflow-x-auto bg-transparent px-3 py-2.5 sm:mx-0">
              <button
                type="button"
                onClick={() => setTeamFilter(null)}
                className="shrink-0 rounded-full border px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest transition-all duration-200 active:scale-95"
                style={{
                  background: allOn
                    ? `color-mix(in oklch, ${primaryColor} 22%, rgba(255, 255, 255, 0.05))`
                    : "rgba(255, 255, 255, 0.03)",
                  borderColor: allOn ? primaryColor : "rgba(255, 255, 255, 0.16)",
                  borderBottom: allOn
                    ? "2px solid oklch(1 0 0 / 0.45)"
                    : "1.5px solid oklch(1 0 0 / 0.26)",
                  color: allOn ? "#ffffff" : "var(--color-muted-foreground)",
                  textShadow: allOn ? `0 0 10px ${primaryColor}` : undefined,
                  boxShadow: allOn
                    ? `inset 0 0 22px -6px color-mix(in oklch, ${primaryColor} 70%, transparent), 0 0 16px -3px ${primaryColor}, inset 0 1px 0 rgba(255, 255, 255, 0.32)`
                    : "inset 0 1px 0 rgba(255, 255, 255, 0.14)",
                }}
              >
                All
              </button>
              {teams.map((t) => {
                const color = teamColor(sorted.find((d) => teamLabel(d.team) === t)?.team);
                const on = teamFilter === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTeamFilter(on ? null : t)}
                    className="flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest transition-all duration-200 active:scale-95"
                    style={{
                      background: on
                        ? `color-mix(in oklch, ${color} 22%, rgba(255, 255, 255, 0.05))`
                        : `color-mix(in oklch, ${color} 6%, rgba(255, 255, 255, 0.02))`,
                      borderColor: on
                        ? color
                        : `color-mix(in oklch, ${color} 35%, rgba(255, 255, 255, 0.16))`,
                      borderBottom: on
                        ? "2px solid oklch(1 0 0 / 0.45)"
                        : "1.5px solid oklch(1 0 0 / 0.28)",
                      color: on ? "#ffffff" : "var(--color-foreground)",
                      textShadow: on ? `0 0 10px color-mix(in oklch, ${color} 85%, transparent)` : undefined,
                      boxShadow: on
                        ? `inset 0 0 22px -6px color-mix(in oklch, ${color} 72%, transparent), 0 0 16px -3px ${color}, inset 0 1px 0 rgba(255, 255, 255, 0.34)`
                        : `inset 0 0 16px -9px color-mix(in oklch, ${color} 40%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.15)`,
                    }}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full transition-transform duration-200"
                      style={{
                        background: color,
                        boxShadow: on
                          ? `0 0 10px ${color}, 0 0 4px #ffffff`
                          : `0 0 6px ${color}`,
                        transform: on ? "scale(1.2)" : undefined,
                      }}
                    />
                    {t}
                  </button>
                );
              })}
            </div>

            <div ref={animRef} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5">
              {deck.map((d) => {
                const taken = used.has(d.id);
                const dColor = teamColor(d.team);
                return (
                  <button
                    key={d.id}
                    type="button"
                    disabled={taken}
                    onClick={() => place(d.id)}
                    className={cn(
                      "relative flex h-16 flex-col justify-center overflow-hidden rounded-md border bg-background/70 px-2.5 pr-9 text-left transition hover:border-primary active:scale-[0.98]",
                      taken && "opacity-35",
                    )}
                    style={{
                      borderLeft: `5px solid ${dColor}`,
                      boxShadow: `inset 0 0 24px -8px color-mix(in oklch, ${dColor} 50%, transparent), 0 0 12px -6px ${dColor}`,
                      borderBottom: "2px solid oklch(1 0 0 / 0.32)",
                    }}
                  >
                    <span
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 font-display text-lg font-extrabold italic tabular-nums leading-none opacity-70"
                      style={{ color: dColor }}
                    >
                      {d.number ?? ""}
                    </span>
                    <span className="block font-display text-base font-extrabold italic uppercase leading-tight">
                      {d.code ?? d.full_name.split(" ").pop()}
                    </span>
                    <span className="block truncate text-[11px] font-medium text-muted-foreground">
                      {d.full_name}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}