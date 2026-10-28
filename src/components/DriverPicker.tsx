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
  disabled?: boolean;
  exclude?: string[];
  placeholder?: string;
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
        <SelectItem value={EMPTY}>— No pick —</SelectItem>
        {sortByTeam(drivers).map((d) => {
          const taken = !!exclude?.includes(d.id) && d.id !== value;
          return (
            <SelectItem key={d.id} value={d.id} disabled={taken}>
              <span className="flex items-center gap-2">
                <span
                  className="w-6 shrink-0 border-l-2 pl-1 font-mono text-[11px] font-bold tabular-nums"
                  style={{ borderColor: teamColor(d.team) }}
                >
                  {d.number ?? "–"}
                </span>
                <span className="font-semibold">{d.code ?? d.full_name}</span>
                <span className="text-muted-foreground">
                  {d.full_name}
                  {d.team ? ` · ${d.team}` : ""}
                  {taken ? " — already picked" : ""}
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
  disabled?: boolean;
  exclude?: string[];
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
  }, [sorted, teamFilter, search]);

  return (
    <>
      <button
        type="button"
        disabled={!!disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-11 w-full items-center rounded-md border border-input bg-background px-3 text-sm ring-offset-background transition active:scale-[0.99]",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {selected ? (
          <span className="flex items-center gap-2">
            <span
              className="w-1 self-stretch rounded-full"
              style={{ background: teamColor(selected.team) }}
            />
            <span className="font-mono text-xs font-bold tabular-nums text-muted-foreground">
              #{selected.number ?? "–"}
            </span>
            <span className="font-semibold">{selected.code ?? selected.full_name}</span>
            <span className="truncate text-muted-foreground">{selected.team ?? ""}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
      </button>

      <Drawer
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setSearch("");
            setTeamFilter(null);
          }
        }}
      >
        <DrawerContent className="max-h-[85svh]">
          <DrawerHeader className="pb-2">
            <DrawerTitle>{placeholder}</DrawerTitle>
          </DrawerHeader>

          <div className="border-b border-border/60 px-3 pb-2.5">
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search driver, code, number, or team…"
                className="h-9 w-full rounded-md border border-border bg-secondary/40 pl-8 pr-8 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setTeamFilter(null)}
                className={cn(
                  "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition",
                  teamFilter === null
                    ? "border-primary bg-primary/20 text-foreground"
                    : "border-border/70 bg-secondary/30 text-muted-foreground",
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
                    className="flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition"
                    style={{
                      borderColor: on ? color : "rgba(255,255,255,0.14)",
                      background: on
                        ? `color-mix(in oklch, ${color} 22%, transparent)`
                        : "rgba(255,255,255,0.03)",
                    }}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: color }}
                    />
                    {t}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="overflow-y-auto px-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <DrawerClose asChild>
              <button
                type="button"
                onClick={() => {
                  onChange(EMPTY);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-sm text-muted-foreground active:bg-secondary/60"
              >
                — No pick —
              </button>
            </DrawerClose>
            {filtered.map((d) => {
              const taken = !!exclude?.includes(d.id) && d.id !== value;
              const isSelected = d.id === value;
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={taken}
                  onClick={() => {
                    onChange(d.id);
                    navigator.vibrate?.(10);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm active:bg-secondary/60",
                    taken && "opacity-35",
                    isSelected && "bg-primary/10",
                  )}
                >
                  <span
                    className="w-1 self-stretch rounded-full"
                    style={{ background: teamColor(d.team) }}
                  />
                  <span className="w-7 shrink-0 font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                    {d.number ?? "–"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{d.code ?? d.full_name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {d.full_name}
                      {d.team ? ` · ${d.team}` : ""}
                      {taken ? " — already picked" : ""}
                    </span>
                  </span>
                  {isSelected && (
                    <span className="shrink-0 font-mono text-xs font-bold text-primary">✓</span>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No matching drivers found.
              </p>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
