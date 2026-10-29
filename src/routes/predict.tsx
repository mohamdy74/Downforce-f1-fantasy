import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Countdown } from "@/components/Countdown";
import { DriverPicker, EMPTY } from "@/components/DriverPicker"; import { SprintGrid } from "@/components/SprintGrid";
import { LightsOut } from "@/components/LightsOut";
import { MissingPlayers } from "@/components/MissingPlayers";
import { assertDeadlineOpen, logPredAudit } from "@/lib/prediction.functions";
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
    staleTime: 15_000,
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
    staleTime: 30_000,
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

  // localStorage cleanup: remove old pole timestamps (run once on mount)
  useEffect(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("dfr:pole-at:"));
    const cutoff = Date.now() - 90 * 24 * 3600_000; // 90 days ago
    keys.forEach((k) => {
      try {
        const v = JSON.parse(localStorage.getItem(k)!);
        if (new Date(v.at).getTime() < cutoff) localStorage.removeItem(k);
      } catch {
        // Invalid JSON, remove it
        localStorage.removeItem(k);
      }
    });
  }, []);

  useEffect(() => {
    if (!prediction) return;
    const saved = prediction.top10 ?? [];
    const newPole = prediction.pole_driver_id ?? EMPTY;
    if (pole !== newPole) setPole(newPole);

    // A pole-only save has no top 10 yet — keep whatever the player is building.
    if (saved.length === 0) return;
    const newTop10 = Array.from({ length: 10 }, (_, i) => saved[i] ?? EMPTY);
    if (JSON.stringify(top10) !== JSON.stringify(newTop10)) setTop10(newTop10);

    const newFastestLap = prediction.fastest_lap_driver_id ?? EMPTY;
    if (fastestLap !== newFastestLap) setFastestLap(newFastestLap);

    const newDnf = prediction.dnf_driver_id ?? EMPTY;
    if (dnf !== newDnf) setDnf(newDnf);
  }, [prediction]);

  // ---- Draft autosave: a closed tab, a dead battery or an app switch never loses half-made picks ----
  const draftKey = user && race ? `dfr:draft:${user.id}:${race.id}` : null;
  const draftChecked = useRef(false);
  useEffect(() => {
    if (!draftKey || draftChecked.current || prediction === undefined) return;
    draftChecked.current = true;
    if ((prediction?.top10 ?? []).filter(Boolean).length === 10) return; // already locked in
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw) as { top10?: string[]; fl?: string; dnf?: string };
      const restored = Array.from({ length: 10 }, (_, i) => d.top10?.[i] || EMPTY);
      if (restored.every((x) => x === EMPTY) && !d.fl && !d.dnf) return;
      setTop10(restored);
      if (d.fl) setFastestLap(d.fl);
      if (d.dnf) setDnf(d.dnf);
      toast.info("Draft restored. Press Lock in picks when you're happy.");
    } catch {
      /* unreadable draft: ignore */
    }
  }, [draftKey, prediction]);
  useEffect(() => {
    if (!draftKey || !draftChecked.current) return;
    try {
      const done = (prediction?.top10 ?? []).filter(Boolean).length === 10;
      const empty = top10.every((x) => x === EMPTY) && fastestLap === EMPTY && dnf === EMPTY;
      if (done || empty) window.localStorage.removeItem(draftKey);
      else
        window.localStorage.setItem(
          draftKey,
          JSON.stringify({
            top10,
            fl: fastestLap === EMPTY ? "" : fastestLap,
            dnf: dnf === EMPTY ? "" : dnf,
          }),
        );
    } catch {
      /* storage unavailable: ignore */
    }
  }, [draftKey, top10, fastestLap, dnf, prediction]);

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
        <div role="status" aria-label="Loading prediction page" className="h-4 w-24 animate-pulse rounded bg-muted" />
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

  // In-page status banner when picks are not yet locked in
  const notSubmitted =
    prediction !== undefined && !(!!prediction && (prediction.top10 ?? []).filter(Boolean).length === 10) &&
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

  async function save() { try { await assertDeadlineOpen({ data: { raceId: race!.id, kind: "race" } }); } catch (e) { toast.error(e instanceof Error ? e.message : "Locked"); return; }
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
      .eq("updated_at", prediction?.updated_at ?? new Date(0).toISOString()) // optimistic lock
      .select("id");

    if (upd.error) {
      error = upd.error;
    } else if (!upd.data?.length) {
      if (prediction?.id) {
        // Optimistic lock conflict: someone else modified this prediction
        toast.error("Someone else modified this prediction. Reloading...");
        queryClient.invalidateQueries({ queryKey: ["prediction", race!.id, user!.id] });
        setSaving(false);
        return;
      }
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
    toast.success("Predictions locked in."); logPredAudit({ data: { userId: user!.id, raceId: race!.id, predId: prediction?.id ?? user!.id, action: prediction?.id && (prediction.top10?.length ?? 0) === 10 ? "edited" : "locked", changes: { top10: [prediction?.top10 ?? [], top10] } } }).catch(() => null);
    try {
      window.localStorage.removeItem(`dfr:draft:${user!.id}:${race!.id}`);
    } catch {
      /* ignore */
    }
    if (!poleLocked && pole !== EMPTY && pole !== savedPole) writePoleAt(user!.id, race!.id, pole);
    setEditing(false);
    navigator.vibrate?.([12, 40, 18]);
    setLightsOut(true);
    queryClient.invalidateQueries({ queryKey: ["prediction", race!.id, user!.id] });
  }

  // Pole can be saved alone (before the top 10 is ready) until qualifying starts.
  async function savePole() { try { await assertDeadlineOpen({ data: { raceId: race!.id, kind: "pole" } }); } catch (e) { toast.error(e instanceof Error ? e.message : "Locked"); return; }
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
    toast.success("Pole pick saved."); logPredAudit({ data: { userId: user!.id, raceId: race!.id, predId: prediction?.id ?? user!.id, action: "pole", changes: { pole: [prediction?.pole_driver_id ?? null, pole] } } }).catch(() => null);
    writePoleAt(user!.id, race!.id, pole);
    queryClient.invalidateQueries({ queryKey: ["prediction", race!.id, user!.id] });
  }

  const savedPole = prediction?.pole_driver_id ?? null;
  const poleDirty = (savedPole ?? EMPTY) !== pole;
  const savedPoleDriver = savedPole ? (drivers ?? []).find((d) => d.id === savedPole) : undefined;
  const poleSavedAt = savedPole
    ? (readPoleAt(user.id, race.id, savedPole) ?? prediction?.updated_at ?? null)
    : null;

  const raceTimeCairo = race.race_at
    ? new Date(race.race_at).toLocaleString("en-GB", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Africa/Cairo",
      })
    : null;

  function scrollToPicker() {
    const targetId = poleLocked ? "grid-section" : "pole-section";
    document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-primary">
          Round {race.round}
        </p>
        <TrackStatus target={race.race_at} />
      </div>
      <h1 className="mt-1 text-3xl">{race.name}</h1>
      <p className="text-sm text-muted-foreground">
        {race.circuit}
        {race.country ? ` · ${race.country}` : ""}
      </p>

      {/* Clean, user-friendly Glass Telemetry Banner when picks aren't locked in yet */}
      {notSubmitted && (
        <div
          className="carbon-panel mt-4 overflow-hidden rounded-xl border p-3.5 sm:p-4"
          style={{
            borderColor: "color-mix(in oklch, var(--gold) 45%, rgba(255, 255, 255, 0.14))",
            boxShadow:
              "inset 0 0 28px -12px color-mix(in oklch, var(--gold) 35%, transparent), 0 10px 26px -12px rgba(0, 0, 0, 0.5)",
          }}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-gold/50 bg-gold/15 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-gold">
                  <span className="h-1.5 w-1.5 rounded-full bg-gold animate-pulse" />
                  Action Needed · {usedInTop10.length}/10 Picked
                </span>
                {savedPoleDriver && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/15 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-success">
                    Pole: {savedPoleDriver.code ?? savedPoleDriver.full_name} ✓
                  </span>
                )}
              </div>
              <p className="mt-2 font-display text-base font-extrabold italic uppercase tracking-wide text-foreground">
                Lock in your grid before lights out
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Complete your Top 10 &amp; bonus picks
                {raceTimeCairo ? ` before ${raceTimeCairo} (Cairo)` : ""} to score up to{" "}
                <strong className="text-foreground">52 pts</strong>.
              </p>
            </div>

            <Button
              type="button"
              size="sm"
              onClick={scrollToPicker}
              className="h-10 shrink-0 rounded-lg px-4 font-display text-xs font-extrabold italic uppercase tracking-wider shadow-md"
            >
              Start picking ↓
            </Button>
          </div>
        </div>
      )}

      {/* Deadlines row — avoids wasting a huge box when Pole is already locked */}
      {poleLocked ? (
        <div className="mt-3">
          <Countdown target={race.race_at} label="Top 10 & bonus picks close in" />
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {race.qualifying_at && (
            <Countdown target={race.qualifying_at} label="Pole pick closes in" />
          )}
          <Countdown target={race.race_at} label="Top 10 / bonus picks close in" />
        </div>
      )}

      <MissingPlayers race={race} />

      <section
        id="pole-section"
        className="carbon-panel mt-6 scroll-mt-16 rounded-lg border-l-4 p-4 sm:p-5"
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

      <div id="grid-section" className="scroll-mt-16">
        <SprintGrid size={10}
          drivers={drivers ?? []}
          top10={top10}
          setTop10={setTop10}
          locked={viewOnly}
          onRepeat={lastPicks ? repeatLast : undefined}
        />
      </div>
      {duplicates && (
        <p className="mt-3 text-sm text-destructive">A driver is selected more than once.</p>
      )}

      <section className="carbon-panel cv-auto mt-6 rounded-lg p-4 sm:p-5">
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
        <div className="cv-auto mt-6">
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

      <div className={viewOnly ? "mt-4" : "sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 mt-4 rounded-lg bg-background/95 p-2 md:bg-background/80 md:backdrop-blur-md md:bottom-3"}>
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
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 30_000);
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
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-widest"
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
