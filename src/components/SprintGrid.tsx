import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { DriverPicker } from "@/components/DriverPicker";
import type { Driver } from "@/lib/queries";
import { sortByTeam, teamColor, teamLabel, teamsOf } from "@/lib/teams";
import { cn } from "@/lib/utils";

export const EMPTY = "__none__";

export function Field({
  label,
  children,
  purple,
}: {
  label: string;
  children: React.ReactNode;
  purple?: boolean;
}) {
  return (
    <div>
      <p
        className={cn(
          "mb-1.5 font-mono text-[11px] font-semibold uppercase tracking-widest",
          purple ? "text-purple" : "text-muted-foreground",
        )}
      >
        {label}
      </p>
      {children}
    </div>
  );
}

// Re-export DriverPicker as DriverSelect for backward compat with sprint.tsx
export const DriverSelect = DriverPicker;

export function SprintGrid({
  drivers,
  top10,
  setTop10,
  locked,
  onRepeat,
  size,
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
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null);
  const [teamFilter, setTeamFilter] = useState<string | null>(null);
  const dragRef = useRef<{ from: number; x: number; y: number; moved: boolean } | null>(null);
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
      setActive(empty !== -1 ? empty : first !== -1 ? first : active); navigator.vibrate?.(10);
      return next;
    });
  }

  function clearSlot(i: number) {
    setTop10((prev) => prev.map((p, idx) => (idx === i ? EMPTY : p)));
    setActive(i);
  }

  function slotAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y)?.closest("[data-slot]");
    return el ? Number(el.getAttribute("data-slot")) : null;
  }

  function onDown(e: React.PointerEvent, i: number) {
    if (locked || top10[i] === EMPTY) return;
    dragRef.current = { from: i, x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
    d.moved = true;
    setDrag({ from: d.from, over: slotAt(e.clientX, e.clientY) });
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

  return (
    <section className="carbon-panel mt-8 rounded-lg">
      <div className="kerb-strip" />
      <div className="p-3 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl">{size === 10 ? "Starting grid" : "Sprint grid"}</h2>
          <div className="flex shrink-0 gap-2">
            {!locked && onRepeat && (
              <Button size="sm" variant="secondary" onClick={onRepeat}>
                Repeat last
              </Button>
            )}
            {!locked && used.size > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setTop10(Array(size).fill(EMPTY));
                  setActive(0);
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Tap a slot, then a driver. Drag a car onto another slot to swap positions.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-x-2.5 gap-y-2 sm:gap-x-3">
          {top10.map((id, i) => {
            const d = id !== EMPTY ? byId.get(id) : undefined;
            const isActive = i === active && !locked;
            const color = d ? teamColor(d.team) : "transparent";
            return (
              <button
                key={i}
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
                  "flex h-16 select-none items-center gap-2 overflow-hidden rounded-md border bg-background/70 pr-2 text-left transition",
                  i % 2 === 1 && "mt-5",
                  isActive && "border-primary ring-2 ring-primary/70",
                  !d && !isActive && "border-dashed",
                  drag?.from === i && "drag-ghost",
                  drag && drag.over === i && drag.from !== i && "drop-target",
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
                      {d ? (d.code ?? d.full_name) : "—"}
                    </span>
                  </span>
                  <span className="block truncate text-[11px] font-medium text-muted-foreground">
                    {d ? d.team : isActive ? "Pick a driver" : "Empty"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {!locked && (
          <>
            <p className="mt-6 font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Drivers · filling <span className="text-primary">P{active + 1}</span> <span className="ml-1 text-foreground">({used.size}/{size})</span> <button type="button" onClick={() => document.querySelector("[data-slot=\"0\"]")?.scrollIntoView({ behavior: "smooth", block: "center" })} className="ml-2 text-primary underline">Top</button>
            </p>

            <div className="sticky top-[52px] z-20 -mx-3 mt-2.5 flex gap-1.5 overflow-x-auto bg-background/95 px-3 py-2 backdrop-blur sm:mx-0">
              <button
                type="button"
                onClick={() => setTeamFilter(null)}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-widest transition",
                  teamFilter === null
                    ? "border-primary text-primary"
                    : "border-border text-muted-foreground",
                )}
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
                    className="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-widest transition"
                    style={{
                      borderColor: on ? color : "var(--color-border)",
                      color: on ? color : "var(--color-muted-foreground)",
                      boxShadow: on ? `0 0 12px -4px ${color}` : undefined,
                    }}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: color }}
                    />
                    {t}
                  </button>
                );
              })}
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5">
              {deck.map((d) => {
                const taken = used.has(d.id);
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
                    style={{ borderLeft: `5px solid ${teamColor(d.team)}` }}
                  >
                    <span
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 font-display text-lg font-extrabold italic tabular-nums leading-none opacity-70"
                      style={{ color: teamColor(d.team) }}
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
