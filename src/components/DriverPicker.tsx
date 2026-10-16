import { useState } from "react";

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
import { sortByTeam, teamColor } from "@/lib/teams";
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
        disabled={!!disabled}
        exclude={exclude ?? []}
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
  const sorted = sortByTeam(drivers);
  const selected = drivers.find((d) => d.id === value);

  return (
    <>
      <button
        type="button"
        disabled={!!disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-10 w-full items-center rounded-md border border-input bg-background px-3 text-sm ring-offset-background",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {selected ? (
          <span className="flex items-center gap-2">
            <span
              className="w-1 self-stretch rounded-full"
              style={{ background: teamColor(selected.team) }}
            />
            <span className="font-semibold">{selected.code ?? selected.full_name}</span>
            <span className="text-muted-foreground">{selected.team ?? ""}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
      </button>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="max-h-[85svh]">
          <DrawerHeader>
            <DrawerTitle>{placeholder}</DrawerTitle>
          </DrawerHeader>
          <div className="overflow-y-auto px-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <DrawerClose asChild>
              <button
                type="button"
                onClick={() => { onChange(EMPTY); setOpen(false); }}
                className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-sm text-muted-foreground active:bg-secondary/60"
              >
                — No pick —
              </button>
            </DrawerClose>
            {sorted.map((d) => {
              const taken = !!exclude?.includes(d.id) && d.id !== value;
              const isSelected = d.id === value;
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={taken}
                  onClick={() => { onChange(d.id); setOpen(false); }}
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
                  <span
                    className="w-7 shrink-0 font-mono text-[11px] font-bold tabular-nums text-muted-foreground"
                  >
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
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
