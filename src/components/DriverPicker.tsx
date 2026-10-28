import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { sortByTeam, teamColor, teamLabel, teamsOf } from "@/lib/teams";
import type { Driver } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const EMPTY = "__none__";

export function DriverPicker({
  drivers,
  value,
  onChange,
  disabled,
  exclude,
  placeholder = "Select driver",
}: {
  drivers: Driver[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  exclude?: string[] | undefined;
  placeholder?: string | undefined;
}) {
  const mobile = useIsMobile();

  if (mobile) {
    return (
      <MobileDriverPicker
        drivers={drivers}
        value={value}
        onChange={onChange}
        disabled={disabled}
        exclude={exclude}
        placeholder={placeholder}
      />
    );
  }

  return (
    <Select value={value} onValueChange={onChange} disabled={!!disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={EMPTY}>\u2014 No pick \u2014</SelectItem>
        {sortByTeam(drivers).map((d) => {
          const taken = !!exclude?.includes(d.id) && d.id !== value;
          return (
            <SelectItem key={d.id} value={d.id} disabled={taken}>
              <span className="flex items-center gap-2">
                <span
                  className="w-6 shrink-0 border-l-2 pl-1 font-mono text-[11px] font-bold tabular-nums"
                  style={{ borderColor: teamColor(d.team) }}
                >
                  {d.number ?? "\u2013"}
                </span>
                <span className="font-semibold">{d.code ?? d.full_name}</span>
                <span className="text-muted-foreground">
                  {d.full_name}
                  {d.team ? ` \u00b7 ${d.team}` : ""}
                  {taken ? " \u2014 already picked" : ""}
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function MobileDriverPicker({
  drivers,
  value,
  onChange,
  disabled,
  exclude,
  placeholder,
}: {
  drivers: Driver[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  exclude?: string[] | undefined;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [teamFilter, setTeamFilter] = useState<string | null>(null);
  const sorted = useMemo(() => sortByTeam(drivers), [drivers]);
  const teams = useMemo(() => teamsOf(drivers), [drivers]);
  const selected = drivers.find((d) => d.id === value);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sorted.filter((d) => {
      if (teamFilter && teamLabel(d.team) !== teamFilter) return false;
      if (!q) return true;
      return (
        d.full_name.toLowerCase().includes(q) ||
        (d.code ?? "").toLowerCase().includes(q) ||
        (d.team ?? "").toLowerCase().includes(q) ||
        String(d.number ?? "").includes(q)
      );
    });
  }, [sorted, search, teamFilter]);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setSearch("");
    setTeamFilter(null);
    navigator.vibrate?.(10);
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!disabled) {
          setOpen(next);
          if (!next) {
            setSearch("");
            setTeamFilter(null);
          }
        }
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background/70 px-3 text-left text-sm transition active:scale-[0.99] disabled:opacity-50",
        )}
        style={{
          borderLeft: selected ? `4px solid ${teamColor(selected.team)}` : undefined,
        }}
      >
        {selected ? (
          <span className="flex min-w-0 items-center gap-2">
            {selected.number != null && (
              <span className="font-mono text-xs font-bold tabular-nums text-muted-foreground">
                #{selected.number}
              </span>
            )}
            <span className="font-display font-extrabold italic uppercase">
              {selected.code ?? selected.full_name}
            </span>
            <span className="truncate text-xs text-muted-foreground">{selected.full_name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
        <span className="font-mono text-xs text-muted-foreground">\u25be</span>
      </button>

      <DrawerContent className="max-h-[85vh]">
        <DrawerHeader className="flex flex-row items-center justify-between border-b border-border pb-3">
          <DrawerTitle className="font-display text-lg font-extrabold italic uppercase">
            {placeholder}
          </DrawerTitle>
          <DrawerClose asChild>
            <button
              type="button"
              className="rounded-sm px-2 py-1 font-mono text-xs uppercase text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </DrawerClose>
        </DrawerHeader>

        {/* Instant Search + Team Filter Bar inside Drawer */}
        <div className="space-y-2.5 border-b border-border/60 bg-background/60 px-3 py-2.5">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search driver, code, # or team..."
              className="h-9 w-full rounded-md border border-border bg-secondary/40 pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className=" hit-slop absolute right-2.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5">
            <button
              type="button"
              onClick={() => setTeamFilter(null)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors",
                teamFilter === null
                  ? "border-primary bg-primary/20 text-foreground"
                  : "border-border bg-secondary/40 text-muted-foreground",
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
                  className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors"
                  style={{
                    borderColor: on ? color : "var(--color-border)",
                    background: on ? `color-mix(in oklch, ${color} 22%, transparent)` : undefined,
                  }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                  {t}
                </button>
              );
            })}
          </div>
        </div>

        <div className=" overflow-y-auto p-3">
          <button
            type="button"
            onClick={() => pick(EMPTY)}
            className="mb-2 flex h-11 w-full items-center justify-center rounded-md border border-dashed border-border font-mono text-xs uppercase tracking-widest text-muted-foreground active:bg-secondary"
          >
            \u2014 Clear pick \u2014
          </button>

          {filtered.length === 0 ? (
            <p className="py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
              No matching drivers found
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {filtered.map((d) => {
                const taken = !!exclude?.includes(d.id) && d.id !== value;
                const active = d.id === value;
                return (
                  <button
                    key={d.id}
                    type="button"
                    disabled={taken}
                    onClick={() => pick(d.id)}
                    className={cn(
                      "relative flex h-16 flex-col justify-center overflow-hidden rounded-md border bg-card px-2.5 pr-9 text-left transition active:scale-[0.98]",
                      active && "border-primary ring-2 ring-primary/60",
                      taken && "opacity-30",
                    )}
                    style={{ borderLeft: `4px solid ${teamColor(d.team)}` }}
                  >
                    <span
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 font-display text-lg font-extrabold italic tabular-nums leading-none opacity-65"
                      style={{ color: teamColor(d.team) }}
                    >
                      {d.number ?? ""}
                    </span>
                    <span className="block font-display text-base font-extrabold italic uppercase leading-tight">
                      {d.code ?? d.full_name.split(" ").pop()}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {d.full_name}
                    </span>
                    <span className="block truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
                      {d.team ?? ""}{taken ? " \u00b7 picked" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}