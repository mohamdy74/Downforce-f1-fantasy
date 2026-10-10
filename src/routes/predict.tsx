import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Countdown } from "@/components/Countdown";
import { DriverPicker, EMPTY } from "@/components/DriverPicker";
import { LightsOut } from "@/components/LightsOut";
import { SharePicks } from "@/components/SharePicks";
import { SharePole } from "@/components/SharePole";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { driversQuery, nextRace, racesQuery, type Driver } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { sortByTeam, teamColor, teamLabel, teamsOf } from "@/lib/teams";

export const Route = createFileRoute("/predict")({
  head: () => ({
    meta: [
      { title: "Make your picks — DOWNFORCE" },
      {
        name: "description",
        content:
          "Lock in your top 10 finishing order plus pole, fastest lap and DNF picks before the lights go out.",
      },
      { property: "og:title", content: "Make your picks — DOWNFORCE" },
      {
        property: "og:description",
        content: "Predict the top 10, pole, fastest lap and a DNF for the next Grand Prix.",
      },
      { name: "twitter:title", content: "Make your picks — DOWNFORCE" },
      { name: "twitter:description", content: "Predict the top 10, pole, fastest lap and a DNF for the next Grand Prix." },
    ],
  }),
  component: Predict,
});

// The database only keeps one "updated_at" per prediction, which moves whenever the top 10
// changes. So we also remember (on this device) the moment the pole pick itself was saved.
const poleAtKey = (userId: string, raceId: string) => `dfr:pole-at:${userId}:${raceId}`;
function readPoleAt(userId: string, raceId: string, driverId: string): string | null {
  try {
    const raw = window.localStorage.getItem(poleAtKey(userId, raceId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { driver?: string; at?: string };
    return v.driver === driverId && v.at ? v.at : null;
  } catch {
    return null;
  }
}
function writePoleAt(userId: string, raceId: string, driverId: string) {
  try {
    window.localStorage.setItem(
      poleAtKey(userId, raceId),
      JSON.stringify({ driver: driverId, at: new Date().toISOString() }),
    );
  } catch {
    /* storage unavailable: the card falls back to the server time */
  }
}

function Predict() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const { data: races } = useQuery(racesQuery);
  const { data: drivers } = useQuery(driversQuery);

  const race = useMemo(() => (races ? nextRace(races) : null), [races]);

  const { data: prediction } = useQuery({
    queryKey: ["prediction", race?.id, user?.id],
    enabled: !!race && !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("predictions")
        .select("*")
        .eq("race_id", race!.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: lastPicks } = useQuery({
    queryKey: ["last-prediction", race?.id, user?.id],
    enabled: !!race && !!user && !!races,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("predictions")
        .select("race_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id")
        .eq("user_id", user!.id)
        .neq("race_id", race!.id);
      if (error) throw error;
      const round = new Map((races ?? []).map((r) => [r.id, r.round]));
      const prev = (data ?? [])
        .filter((p) => (round.get(p.race_id) ?? 0) < race!.round)
        .sort((a, b) => (round.get(b.race_id) ?? 0) - (round.get(a.race_id) ?? 0));
      return prev[0] ?? null;
    },
  });

  const [top10, setTop10] = useState<string[]>(Array(10).fill(EMPTY));
  const [pole, setPole] = useState(EMPTY);
  const [fastestLap, setFastestLap] = useState(EMPTY);
  const [dnf, setDnf] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [lightsOut, setLightsOut] = useState(false);
  const endLights = useCallback(() => setLightsOut(false), []);

  useEffect(() => {
    if (!prediction) return;
    const saved = prediction.top10 ?? [];
    setPole(prediction.pole_driver_id ?? EMPTY);
    // A pole-only save has no top 10 yet — keep whatever the player is building.
    if (saved.length === 0) return;
    setTop10(Array.from({ length: 10 }, (_, i) => saved[i] ?? EMPTY));
    setFastestLap(prediction.fastest_lap_driver_id ?? EMPTY);
    setDnf(prediction.dnf_driver_id ?? EMPTY);
  }, [prediction]);

  const now = Date.now();
  const raceLocked = !!race && new Date(race.race_at).getTime() <= now;
  const poleLocked =
    raceLocked ||
    (!!race?.qualifying_at && new Date(race.qualifying_at).getTime() <= now);
  const hasSaved = !!prediction && (prediction.top10?.length ?? 0) === 10;
  // Saved picks open in view mode so stray taps while scrolling can't change them.
  const viewOnly = raceLocked || (hasSaved && !editing);

  if (loading) {
    return (
      <Shell>
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="mt-4 h-12 w-full animate-pulse rounded-md bg-muted/60" />
        <div className="mt-6 h-40 w-full animate-pulse rounded-lg bg-muted/60" />
        <div className="mt-4 h-40 w-full animate-pulse rounded-lg bg-muted/60" />
      </Shell>
    );
  }

  if (!user) {
    return (
      <Shell>
        <h1 className="text-3xl">Sign in to predict</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          You need an account so your points can be tracked on the league table.
        </p>
        <Button asChild className="mt-6">
          <Link to="/auth">Continue with Google</Link>
        </Button>
      </Shell>
    );
  }

  if (!race) {
    return (
      <Shell>
        <h1 className="text-3xl">No race to predict</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          There is no upcoming Grand Prix on the calendar right now.
        </p>
      </Shell>
    );
  }

  // In-page reminder banner — red alert when picks not submitted
  const notSubmitted =
    !(!!prediction && (prediction.top10 ?? []).filter(Boolean).length === 10) &&
    (!raceLocked || (race.qualifying_at && new Date(race.qualifying_at).getTime() > Date.now()));

  const usedInTop10 = top10.filter((d) => d !== EMPTY);
  const duplicates = usedInTop10.length !== new Set(usedInTop10).size;
  const dnfInTop10 = dnf !== EMPTY && usedInTop10.includes(dnf);

  function repeatLast() {
    if (!lastPicks) return;
    const saved = lastPicks.top10 ?? [];
    setTop10(Array.from({ length: 10 }, (_, i) => saved[i] ?? EMPTY));
    if (!poleLocked) setPole(lastPicks.pole_driver_id ?? EMPTY);
    setFastestLap(lastPicks.fastest_lap_driver_id ?? EMPTY);
    setDnf(lastPicks.dnf_driver_id ?? EMPTY);
    toast.success("Loaded your picks from the last race.");
  }

  async function save() {
    if (duplicates) {
      toast.error("Each driver can only appear once in your top 10.");
      return;
    }
    if (dnfInTop10) {
      toast.error("Your DNF pick can't be one of your top 10 finishers.");
      return;
    }
    if (usedInTop10.length !== 10 && !raceLocked) {
      toast.error("Pick all 10 positions before submitting.");
      return;
    }

    setSaving(true);
    // Once qualifying has started the pole pick is frozen, so we never send it.
    // (An upsert would also run the database's "insert" checks against the pole
    // value and reject a save that only changes the top 10.)
    const fields = {
      top10,
      fastest_lap_driver_id: fastestLap === EMPTY ? null : fastestLap,
      dnf_driver_id: dnf === EMPTY ? null : dnf,
      ...(poleLocked ? {} : { pole_driver_id: pole === EMPTY ? null : pole }),
    };

    let error: { message: string } | null = null;
    const upd = await supabase
      .from("predictions")
      .update(fields)
      .eq("user_id", user!.id)
      .eq("race_id", race!.id)
      .select("id");
    if (upd.error) {
      error = upd.error;
    } else if (!upd.data?.length) {
      const ins = await supabase
        .from("predictions")
        .insert({ user_id: user!.id, race_id: race!.id, ...fields });
      error = ins.error;
    }
    setSaving(false);

    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Predictions locked in.");
    if (!poleLocked && pole !== EMPTY && pole !== savedPole) writePoleAt(user!.id, race!.id, pole);
    setEditing(false);
    navigator.vibrate?.([12, 40, 18]);
    setLightsOut(true);
    queryClient.invalidateQueries({ queryKey: ["prediction", race!.id, user!.id] });
  }

  // Pole can be saved alone (before the top 10 is ready) until qualifying starts.
  async function savePole() {
    if (pole === EMPTY) {
      toast.error("Choose a pole driver first.");
      return;
    }
    setSaving(true);
    const upd = await supabase
      .from("predictions")
      .update({ pole_driver_id: pole })
      .eq("user_id", user!.id)
      .eq("race_id", race!.id)
      .select("id");
    let error = upd.error;
    if (!error && !upd.data?.length) {
      const ins = await supabase
        .from("predictions")
        .insert({ user_id: user!.id, race_id: race!.id, pole_driver_id: pole, top10: [] });
      error = ins.error;
    }
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Pole pick saved.");
    writePoleAt(user!.id, race!.id, pole);
    queryClient.invalidateQueries({ queryKey: ["prediction", race!.id, user!.id] });
  }

  const savedPole = prediction?.pole_driver_id ?? null;
  const poleDirty = (savedPole ?? EMPTY) !== pole;
  const savedPoleDriver = savedPole ? (drivers ?? []).find((d) => d.id === savedPole) : undefined;
  const poleSavedAt = savedPole
    ? (readPoleAt(user.id, race.id, savedPole) ?? prediction?.updated_at ?? null)
    : null;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-10">
      <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-primary">
        Round {race.round}
      </p>
      <h1 className="mt-1 text-3xl">{race.name}</h1>
      <p className="text-sm text-muted-foreground">
        {race.circuit}
        {race.country ? ` · ${race.country}` : ""}
      </p>

      <TrackStatus target={race.race_at} />

      {/* Reminder banner — red when picks not submitted, shows time left */}
      {notSubmitted && (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <div className="shrink-0 rounded-full bg-destructive text-destructive-foreground h-8 w-8 flex items-center justify-center font-mono text-sm font-bold">
              !
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-destructive">Picks not submitted</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                You haven&apos;t locked in your predictions for <strong>{race.name}</strong>.
                {race.race_at ? ` Race starts at ${new Date(race.race_at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" })} (Cairo).` : ""}
              </p>
              <div className="mt-2 flex items-center gap-2 font-mono text-xs font-bold text-destructive">
                <span>Time left:</span>
                <Countdown target={race.race_at} label="Race closes" />
              </div>
            </div>
            <Button asChild size="sm" className="shrink-0 h-9 bg-destructive text-destructive-foreground hover:bg-destructive/90">
              <Link to="/predict">Submit picks →</Link>
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {race.qualifying_at && (
          <Countdown target={race.qualifying_at} label="Pole pick closes in" />
        )}
        <Countdown target={race.race_at} label="Top 10 / bonus picks close in" />
      </div>

      <section
        className="carbon-panel mt-6 rounded-lg border-l-4 p-4 sm:p-5"
        style={{ borderLeftColor: "var(--gold)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-gold">
              Pole position · +3
            </p>
            <h2 className="mt-1 text-xl">Who takes pole?</h2>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest",
              poleLocked
                ? "border-border text-muted-foreground"
                : savedPole && !poleDirty
                  ? "border-success/60 text-success"
                  : "border-gold/60 text-gold",
            )}
          >
            {poleLocked
              ? "Locked"
              : savedPole && !poleDirty
                ? "Saved ✓"
                : poleDirty && pole !== EMPTY
                  ? "Not saved"
                  : "No pick yet"}
          </span>
        </div>

        <div className="mt-4">
          <DriverPicker
            drivers={drivers ?? []}
            value={pole}
            disabled={poleLocked}
            onChange={setPole}
          />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {!poleLocked && (
            <Button
              type="button"
              disabled={saving || !poleDirty || pole === EMPTY}
              onClick={savePole}
              className="h-11"
            >
              {savedPole && !poleDirty ? "Pole saved ✓" : "Save pole"}
            </Button>
          )}
          {savedPole && (
            <SharePole
              raceName={race.name}
              round={race.round}
              playerName={(user.user_metadata?.["full_name"] as string | undefined) ?? "Me"}
              driver={savedPoleDriver}
              savedAt={poleSavedAt}
              circuit={[race.circuit, race.country].filter(Boolean).join(" · ")}
            />
          )}
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          {poleLocked
            ? "Qualifying has started, so the pole pick is locked."
            : savedPole && poleDirty
              ? "Save to update your pole card. The card always shows your saved pick."
              : "Save it now and finish your top 10 later. You can change it until qualifying starts."}
        </p>
      </section>

      <GridPicker
        drivers={drivers ?? []}
        top10={top10}
        setTop10={setTop10}
        locked={viewOnly}
        onRepeat={lastPicks ? repeatLast : undefined}
      />
      {duplicates && (
        <p className="mt-3 text-sm text-destructive">A driver is selected more than once.</p>
      )}

      <section className="carbon-panel mt-6 rounded-lg p-4 sm:p-5">
        <h2 className="text-xl">Bonus picks</h2>
        <div className="mt-4 space-y-4">
          <Field label="Fastest lap (+3)" purple>
            <DriverPicker
              drivers={drivers ?? []}
              value={fastestLap}
              disabled={viewOnly}
              onChange={setFastestLap}
            />
          </Field>
          <Field label="Driver to DNF (+1) — Aston Martin & Cadillac excluded">
            <DriverPicker
              drivers={(drivers ?? []).filter((d) => !/aston|cadillac/i.test(d.team ?? ""))}
              value={dnf}
              disabled={viewOnly}
              exclude={usedInTop10}
              onChange={setDnf}
            />
            {dnfInTop10 && (
              <p className="mt-1.5 text-sm text-destructive">
                Your DNF pick can't be one of your top 10 finishers.
              </p>
            )}
          </Field>
        </div>
      </section>

      {hasSaved && viewOnly && prediction && (
        <div className="mt-6">
          <SharePicks
            raceName={race.name}
            round={race.round}
            playerName={(user.user_metadata?.["full_name"] as string | undefined) ?? "Me"}
            drivers={drivers ?? []}
            top10={prediction.top10}
            pole={prediction.pole_driver_id}
            fastestLap={prediction.fastest_lap_driver_id}
            dnf={prediction.dnf_driver_id}
            lockedAt={prediction.updated_at}
          />
        </div>
      )}

      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 mt-4 rounded-lg bg-background/80 p-2 backdrop-blur-md md:bottom-3">
        {raceLocked ? (
          <Button size="lg" className="h-12 w-full text-base" disabled>
            Picks locked — race started
          </Button>
        ) : viewOnly ? (
          <Button size="lg" variant="outline" className="h-12 w-full text-base" onClick={() => setEditing(true)}>
            Edit picks
          </Button>
        ) : (
          <div className="flex gap-2">
            {hasSaved && (
              <Button
                size="lg"
                variant="outline"
                className="h-12 text-base"
                disabled={saving}
                onClick={() => {
                  queryClient.invalidateQueries({ queryKey: ["prediction", race.id, user.id] });
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            )}
            <Button size="lg" className="h-12 flex-1 text-base" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Lock in picks"}
            </Button>
          </div>
        )}
      </div>
      {lightsOut && <LightsOut onDone={endLights} />}
    </main>
  );
}

function Field({
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

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-3xl px-4 py-16">{children}</main>;
}

function TrackStatus({ target }: { target: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const left = new Date(target).getTime() - now;
  const state =
    left <= 0
      ? { label: "Locked · Formation lap", color: "var(--color-primary)" }
      : left < 2 * 3600_000
        ? { label: "Closing soon", color: "var(--gold)" }
        : { label: "Track open", color: "var(--track-green)" };
  return (
    <div
      className="mt-4 flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-xs font-bold uppercase tracking-widest"
      style={{ borderColor: state.color, color: state.color }}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full"
        style={{ background: state.color, boxShadow: `0 0 10px ${state.color}` }}
      />
      {state.label}
    </div>
  );
}

function GridPicker({
  drivers,
  top10,
  setTop10,
  locked,
  onRepeat,
}: {
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
      setActive(empty !== -1 ? empty : first !== -1 ? first : active);
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
    <section className="carbon-panel mt-8 overflow-hidden rounded-lg">
      <div className="kerb-strip" />
      <div className="p-3 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl">Starting grid</h2>
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
                  setTop10(Array(10).fill(EMPTY));
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
                  touchAction: d && !locked ? "none" : "auto",
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
              Drivers · filling <span className="text-primary">P{active + 1}</span>
            </p>

            <div className="-mx-1 mt-2.5 flex gap-1.5 overflow-x-auto px-1 pb-1">
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
