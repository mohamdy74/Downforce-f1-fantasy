import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Countdown } from "@/components/Countdown";
import { DriverPicker, EMPTY } from "@/components/DriverPicker";
import { SprintGrid } from "@/components/SprintGrid";
import { LightsOut } from "@/components/LightsOut";
import { MissingPlayers } from "@/components/MissingPlayers";
import { assertDeadlineOpen, logPredAudit } from "@/lib/prediction.functions";
import { SharePicks } from "@/components/SharePicks";
import { SharePole } from "@/components/SharePole";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { driversQuery, getTrustedNow, nextRace, racesQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/predict")({
  head: () => ({
    meta: [
      { title: "Make your picks \u2014 DOWNFORCE" },
      {
        name: "description",
        content:
          "Lock in your top 10 finishing order plus pole, fastest lap and DNF picks before the lights go out.",
      },
      { property: "og:title", content: "Make your picks \u2014 DOWNFORCE" },
      {
        property: "og:description",
        content: "Predict the top 10, pole, fastest lap and a DNF for the next Grand Prix.",
      },
      { name: "twitter:title", content: "Make your picks \u2014 DOWNFORCE" },
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

function fireConfetti() {
  if (typeof window === "undefined") return;
  void import("canvas-confetti")
    .then((m) =>
      m.default({
        particleCount: 55,
        spread: 68,
        origin: { y: 0.78 },
        colors: ["#e10600", "#f59e0b", "#ffffff"],
        disableForReducedMotion: true,
      }),
    )
    .catch(() => null);
}

function Predict() {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const { data: races } = useQuery(racesQuery);
  const { data: drivers } = useQuery(driversQuery);

  // Re-evaluate lock states every 30s so the form flips to read-only if the user leaves the tab open
  const [now, setNow] = useState(() => getTrustedNow());
  useEffect(() => {
    const id = setInterval(() => setNow(getTrustedNow()), 30_000);
    return () => clearInterval(id);
  }, []);

  const upcoming = useMemo(() => (races ? nextRace(races, now) : null), [races, now]);
  const [selectedRaceId, setSelectedRaceId] = useState<string | null>(null);
  const race = useMemo(() => {
    if (!races?.length) return null;
    if (selectedRaceId) return races.find((r) => r.id === selectedRaceId) ?? upcoming ?? races[0]!;
    return upcoming ?? races[races.length - 1]!;
  }, [races, selectedRaceId, upcoming]);

  const raceLocked = !!race && new Date(race.race_at).getTime() <= now;
  const poleLockAt = race?.qualifying_at ?? race?.race_at ?? null;
  const poleLocked = !!poleLockAt && new Date(poleLockAt).getTime() <= now;

  const { data: prediction, isLoading: predLoading } = useQuery({
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

  const { data: results } = useQuery({
    queryKey: ["results", race?.id],
    enabled: !!race?.has_results,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("race_results")
        .select("*")
        .eq("race_id", race!.id)
        .order("position", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: score } = useQuery({
    queryKey: ["score", race?.id, user?.id],
    enabled: !!race?.has_results && !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("scores")
        .select("*")
        .eq("race_id", race!.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Draft persistence in localStorage per user+race so unfinished picks survive accidental reload
  const draftKey = user && race ? `dfr:draft:${user.id}:${race.id}` : null;

  const [top10, setTop10] = useState<string[]>(Array(10).fill(EMPTY));
  const [pole, setPole] = useState<string>(EMPTY);
  const [fl, setFl] = useState<string>(EMPTY);
  const [dnf, setDnf] = useState<string>(EMPTY);
  const [savingPole, setSavingPole] = useState(false);
  const [savingRace, setSavingRace] = useState(false);
  const [lightsOut, setLightsOut] = useState(false);
  const hydratedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = `${race?.id ?? ""}:${user?.id ?? ""}:${prediction?.id ?? "none"}:${prediction?.updated_at ?? ""}`;
    if (hydratedKeyRef.current === key) return;
    if (predLoading) return;
    hydratedKeyRef.current = key;

    if (prediction) {
      const padded = [...(prediction.top10 ?? [])];
      while (padded.length < 10) padded.push(EMPTY);
      setTop10(padded.slice(0, 10));
      setPole(prediction.pole_driver_id ?? EMPTY);
      setFl(prediction.fastest_lap_driver_id ?? EMPTY);
      setDnf(prediction.dnf_driver_id ?? EMPTY);
      return;
    }

    if (draftKey) {
      try {
        const raw = localStorage.getItem(draftKey);
        if (raw) {
          const d = JSON.parse(raw) as {
            top10?: string[];
            pole?: string;
            fl?: string;
            dnf?: string;
          };
          if (Array.isArray(d.top10) && d.top10.length === 10) setTop10(d.top10);
          else setTop10(Array(10).fill(EMPTY));
          setPole(d.pole ?? EMPTY);
          setFl(d.fl ?? EMPTY);
          setDnf(d.dnf ?? EMPTY);
          return;
        }
      } catch {
        /* ignore corrupt draft */
      }
    }

    setTop10(Array(10).fill(EMPTY));
    setPole(EMPTY);
    setFl(EMPTY);
    setDnf(EMPTY);
  }, [prediction, predLoading, draftKey, race?.id, user?.id]);

  // Save draft to localStorage while user has no saved prediction yet (debounced 250ms)
  useEffect(() => {
    if (!draftKey || prediction || predLoading) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ top10, pole, fl, dnf }));
      } catch {
        /* ignore quota errors */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [draftKey, prediction, predLoading, top10, pole, fl, dnf]);

  const savedTop10 = useMemo(() => {
    const p = [...(prediction?.top10 ?? [])];
    while (p.length < 10) p.push(EMPTY);
    return p.slice(0, 10);
  }, [prediction]);
  const savedPole = prediction?.pole_driver_id ?? EMPTY;
  const savedFl = prediction?.fastest_lap_driver_id ?? EMPTY;
  const savedDnf = prediction?.dnf_driver_id ?? EMPTY;

  const poleDirty = !poleLocked && pole !== savedPole;
  const raceDirty =
    !raceLocked &&
    (fl !== savedFl || dnf !== savedDnf || top10.some((d, i) => d !== savedTop10[i]));

  // Warn before closing tab if the user has unsaved edits to an already-submitted prediction
  useEffect(() => {
    if (!prediction || (!poleDirty && !raceDirty)) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [prediction, poleDirty, raceDirty]);

  const repeatLast = useCallback(async () => {
    if (!user || !race || !races) return;
    const prevRaces = races.filter((r) => r.round < race.round).sort((a, b) => b.round - a.round);
    if (!prevRaces.length) {
      toast.error("No earlier round to copy from.");
      return;
    }
    const { data } = await supabase
      .from("predictions")
      .select("*")
      .eq("user_id", user.id)
      .in("race_id", prevRaces.map((r) => r.id));
    const latest = prevRaces.map((r) => data?.find((p) => p.race_id === r.id)).find(Boolean);
    if (!latest) {
      toast.error("No saved picks found from an earlier round.");
      return;
    }
    const padded = [...(latest.top10 ?? [])];
    while (padded.length < 10) padded.push(EMPTY);
    setTop10(padded.slice(0, 10));
    if (!poleLocked && latest.pole_driver_id) setPole(latest.pole_driver_id);
    if (latest.fastest_lap_driver_id) setFl(latest.fastest_lap_driver_id);
    if (latest.dnf_driver_id) setDnf(latest.dnf_driver_id);
    toast.success("Copied your picks from the previous round \u2014 review & save!");
  }, [user, race, races, poleLocked]);

  if (authLoading) return null;
  if (!user) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-3xl">Sign in to make picks</h1>
        <p className="mt-2 text-muted-foreground">
          You need an account to lock in predictions before each race.
        </p>
        <Button asChild className="mt-6">
          <Link to="/auth">Continue with Google</Link>
        </Button>
      </main>
    );
  }

  async function savePole() {
    if (!race || !user) return;
    if (poleLocked) {
      toast.error("Qualifying has started \u2014 pole pick is locked.");
      return;
    }
    if (pole === EMPTY) {
      toast.error("Choose a pole position driver first.");
      return;
    }

    setSavingPole(true);
    try {
      await assertDeadlineOpen({ data: { raceId: race.id, kind: "pole" } });
    } catch (e) {
      setSavingPole(false);
      toast.error(e instanceof Error ? e.message : "Qualifying has locked.");
      return;
    }
    const newPole = pole === EMPTY ? null : pole;
    // Keep existing race picks in the row (or empty placeholder if none saved yet).
    const payload = {
      user_id: user.id,
      race_id: race.id,
      pole_driver_id: newPole,
      top10: prediction?.top10 ?? [],
      fastest_lap_driver_id: prediction?.fastest_lap_driver_id ?? null,
      dnf_driver_id: prediction?.dnf_driver_id ?? null,
      updated_at: new Date().toISOString(),
    };
    const { data: saved, error } = await supabase
      .from("predictions")
      .upsert(payload, { onConflict: "user_id,race_id" })
      .select("id")
      .single();
    setSavingPole(false);
    if (error) {
      toast.error(error.message);
      return;
    }

    if (newPole) writePoleAt(user.id, race.id, newPole);

    // Server-verified audit log entry (falls back silently if offline)
    void logPredAudit({
      data: {
        userId: user.id,
        raceId: race.id,
        predId: saved.id,
        action: prediction ? "update" : "create",
        changes: { pole: [prediction?.pole_driver_id ?? null, newPole] },
      },
    }).catch(() => {});

    toast.success("Pole position locked in!");
    fireConfetti();
    await queryClient.invalidateQueries({ queryKey: ["prediction", race.id, user.id] });
    await queryClient.invalidateQueries({ queryKey: ["pick-status", race.id] });
  }

  async function saveRace(e: React.FormEvent) {
    e.preventDefault();
    if (!race || !user) return;
    if (raceLocked) {
      toast.error("Picks are locked for this race.");
      return;
    }

    const picked = top10.filter((d) => d !== EMPTY);
    if (picked.length < 10) {
      toast.error("Fill all 10 finishing positions before saving.");
      return;
    }
    if (new Set(picked).size !== 10) {
      toast.error("Each driver can only appear once in the top 10.");
      return;
    }

    setSavingRace(true);
    try {
      await assertDeadlineOpen({ data: { raceId: race.id, kind: "race" } });
    } catch (err) {
      setSavingRace(false);
      toast.error(err instanceof Error ? err.message : "Race picks are locked.");
      return;
    }
    const newFl = fl === EMPTY ? null : fl;
    const newDnf = dnf === EMPTY ? null : dnf;
    // If qualifying hasn't started yet, also save whatever is in the pole picker;
    // once qualifying starts, never overwrite the already-locked pole value.
    const newPole = poleLocked
      ? (prediction?.pole_driver_id ?? null)
      : pole === EMPTY
        ? (prediction?.pole_driver_id ?? null)
        : pole;

    const payload = {
      user_id: user.id,
      race_id: race.id,
      top10,
      pole_driver_id: newPole,
      fastest_lap_driver_id: newFl,
      dnf_driver_id: newDnf,
      updated_at: new Date().toISOString(),
    };
    const { data: saved, error } = await supabase
      .from("predictions")
      .upsert(payload, { onConflict: "user_id,race_id" })
      .select("id")
      .single();
    setSavingRace(false);
    if (error) {
      toast.error(error.message);
      return;
    }

    if (draftKey) {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
    }

    const prevPole = prediction?.pole_driver_id ?? null;
    if (newPole && newPole !== prevPole) writePoleAt(user.id, race.id, newPole);

    const changes: Record<string, unknown> = {};
    const prevTop = prediction?.top10 ?? [];
    if (JSON.stringify(prevTop) !== JSON.stringify(top10)) changes["top10"] = [prevTop, top10];
    if ((prediction?.fastest_lap_driver_id ?? null) !== newFl) {
      changes["fastest_lap"] = [prediction?.fastest_lap_driver_id ?? null, newFl];
    }
    if ((prediction?.dnf_driver_id ?? null) !== newDnf) {
      changes["dnf"] = [prediction?.dnf_driver_id ?? null, newDnf];
    }
    if (!poleLocked && prevPole !== newPole) {
      changes["pole"] = [prevPole, newPole];
    }
    if (Object.keys(changes).length > 0) {
      void logPredAudit({
        data: {
          userId: user.id,
          raceId: race.id,
          predId: saved.id,
          action: prediction ? "update" : "create",
          changes,
        },
      }).catch(() => {});
    }

    setLightsOut(true);
    fireConfetti();
    await queryClient.invalidateQueries({ queryKey: ["prediction", race.id, user.id] });
    await queryClient.invalidateQueries({ queryKey: ["pick-status", race.id] });
  }

  const byId = new Map((drivers ?? []).map((d) => [d.id, d]));
  const breakdown = (score?.breakdown ?? null) as {
    items?: Array<{ pos: number; predicted: string; actual: string | null; delta: number | null; pts: number }>;
    pole?: number;
    fastestLap?: number;
    dnf?: number;
    podiumBonus?: number;
    noSubmission?: boolean;
  } | null;

  const filledCount = top10.filter((d) => d !== EMPTY).length;
  const poleSaved = !!prediction?.pole_driver_id;
  const raceSaved = (prediction?.top10?.filter((x) => x && x !== EMPTY).length ?? 0) === 10;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 pb-28">
      {lightsOut && <LightsOut onDone={() => setLightsOut(false)} />}
      {/* Race selector + dual lock countdowns */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            Season {race?.season} \u00b7 Round {race?.round}
          </p>
          <h1 className="text-3xl sm:text-4xl">{race?.name ?? "Loading\u2026"}</h1>
          <p className="text-sm text-muted-foreground">{race?.circuit}</p>
        </div>

        <select
          value={race?.id ?? ""}
          onChange={(e) => setSelectedRaceId(e.target.value)}
          className="h-10 rounded-md border border-border bg-card px-3 font-mono text-xs uppercase"
        >
          {races?.map((r) => (
            <option key={r.id} value={r.id}>
              R{String(r.round).padStart(2, "0")} \u00b7 {r.name}
              {r.has_results ? " \u2713" : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Status Banner: clearly shows if picks are already saved in DB */}
      {race && !race.has_results && (
        <div
          className={cn(
            "mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5 font-mono text-xs",
            raceSaved && poleSaved
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : poleSaved || raceSaved
                ? "border-gold/40 bg-gold/10 text-gold"
                : "border-primary/40 bg-primary/10 text-foreground",
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span>
              POLE:{" "}
              <strong>
                {poleSaved
                  ? `\u2713 SAVED (${byId.get(prediction!.pole_driver_id!)?.code ?? "OK"})`
                  : poleLocked
                    ? "\u2717 MISSED"
                    : "NOT SAVED"}
              </strong>
            </span>
            <span className="opacity-40">|</span>
            <span>
              RACE TOP 10:{" "}
              <strong>
                {raceSaved
                  ? "\u2713 SAVED (10/10)"
                  : raceLocked
                    ? "\u2717 MISSED (\u221225 PTS)"
                    : `NOT SAVED (${filledCount}/10 picked)`}
              </strong>
            </span>
          </div>
          <div className="flex items-center gap-2">
            {(poleDirty || raceDirty) && (
              <span className="rounded bg-gold/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold">
                {prediction ? "Unsaved edits" : "Draft auto-saved"}
              </span>
            )}
            {prediction?.updated_at && (
              <span className="text-[11px] opacity-75">
                Last saved {new Date(prediction.updated_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
              </span>
            )}
          </div>
        </div>
      )}

      {race && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {poleLockAt && (
            <Countdown
              target={poleLockAt}
              label={poleLocked ? "Pole pick locked" : "Pole locks (Quali start)"}
            />
          )}
          <Countdown
            target={race.race_at}
            label={raceLocked ? "Race picks locked" : "Race locks (Lights out)"}
          />
        </div>
      )}

      {race && <MissingPlayers race={race} />}

      {race?.has_sprint && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/50 bg-gold/10 px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-widest text-gold">
            \u26a1 Sprint weekend \u2014 don&apos;t forget your Sprint Top 8 (+9 pts max)
          </p>
          <Button asChild size="sm" variant="outline">
            <Link to="/sprint">Go to Sprint picks \u2192</Link>
          </Button>
        </div>
      )}

      {/* Results comparison when race is scored */}
      {race?.has_results && results && (
        <section className="carbon-panel mt-6 rounded-lg p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xl">Your Score</h2>
            <span className="font-display text-3xl font-black text-gold">
              {score?.points ?? 0} PTS
            </span>
          </div>
          {breakdown?.noSubmission && (
            <p className="mt-2 font-mono text-xs uppercase text-destructive">
              No prediction submitted \u2014 {score?.points ?? -25} pt penalty applied
            </p>
          )}
          {breakdown?.items && (
            <div className="mt-4 grid gap-1.5 text-sm">
              {breakdown.items.map((it) => {
                const pred = byId.get(it.predicted);
                const act = it.actual ? byId.get(it.actual) : null;
                return (
                  <div
                    key={it.pos}
                    className="flex items-center justify-between rounded bg-secondary/50 px-3 py-1.5 font-mono text-xs"
                  >
                    <span>
                      P{it.pos} \u00b7 Picked <strong>{pred?.code ?? "\u2014"}</strong>
                      {act ? ` (actual P${results.find((r) => r.driver_id === it.actual)?.position}: ${act.code})` : " (DNF/out)"}
                    </span>
                    <span className={cn(it.pts > 0 && "font-bold text-gold")}>+{it.pts}</span>
                  </div>
                );
              })}
              <div className="mt-2 flex flex-wrap gap-2 font-mono text-xs">
                <span className="rounded bg-secondary px-2 py-1">Pole +{breakdown.pole ?? 0}</span>
                <span className="rounded bg-secondary px-2 py-1">FL +{breakdown.fastestLap ?? 0}</span>
                <span className="rounded bg-secondary px-2 py-1">DNF +{breakdown.dnf ?? 0}</span>
                <span className="rounded bg-secondary px-2 py-1">
                  Podium bonus +{breakdown.podiumBonus ?? 0}
                </span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* STEP 1 \u2014 POLE POSITION (locks at Qualifying start) */}
      <section className="carbon-panel mt-8 rounded-lg">
        <div className="kerb-strip" />
        <div className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-gold">
                Step 1 \u00b7 Locks at Qualifying \u00b7 +3 pts
              </p>
              <h2 className="text-xl">Pole Position Pick</h2>
            </div>
            <span
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[11px] uppercase",
                poleLocked
                  ? "bg-destructive/20 text-destructive"
                  : prediction?.pole_driver_id
                    ? "bg-gold/20 text-gold"
                    : "bg-secondary text-muted-foreground",
              )}
            >
              {poleLocked ? "Locked" : prediction?.pole_driver_id ? "Saved" : "Open"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Saved on its own \u2014 lock in your Pole pick before Qualifying starts, then come back to set your Race Top 10 after seeing the grid.
          </p>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <DriverPicker
                drivers={drivers ?? []}
                value={pole}
                onChange={setPole}
                disabled={poleLocked}
                placeholder="Choose pole position driver"
              />
            </div>
            {!poleLocked && (
              <Button
                type="button"
                onClick={savePole}
                disabled={savingPole || pole === EMPTY}
                className="sm:w-auto"
              >
                {savingPole
                  ? "Saving\u2026"
                  : prediction?.pole_driver_id
                    ? poleDirty
                      ? "Update Pole Pick *"
                      : "Update Pole Pick"
                    : "Lock in Pole Pick"}
              </Button>
            )}
          </div>
          {race && drivers && pole !== EMPTY && (
            <div className="mt-4 border-t border-border/60 pt-4">
              <SharePole
                raceName={race.name}
                round={race.round}
                playerName={(user.user_metadata?.["full_name"] as string | undefined) ?? user.email ?? "Driver"}
                driver={byId.get(pole)}
                savedAt={
                  (user && race ? readPoleAt(user.id, race.id, pole) : null) ??
                  (prediction?.pole_driver_id === pole ? prediction?.updated_at : null) ??
                  null
                }
                circuit={[race.circuit, race.country].filter(Boolean).join(" \u00b7 ")}
              />
            </div>
          )}
        </div>
      </section>

      {/* STEP 2 \u2014 RACE TOP 10 + FL + DNF (locks at Race lights out) */}
      <form onSubmit={saveRace}>
        <SprintGrid
          size={10}
          drivers={drivers ?? []}
          top10={top10}
          setTop10={setTop10}
          locked={raceLocked}
          onRepeat={repeatLast}
        />

        <section className="carbon-panel mt-6 grid gap-4 rounded-lg p-5 sm:grid-cols-2">
          <Field label="Fastest Lap" badge="+2 PTS" purple disabled={raceLocked}>
            <DriverPicker drivers={drivers ?? []} value={fl} onChange={setFl} disabled={raceLocked} />
          </Field>
          <Field label="DNF Driver" badge="+3 PTS" disabled={raceLocked}>
            <DriverPicker drivers={drivers ?? []} value={dnf} onChange={setDnf} disabled={raceLocked} />
          </Field>
        </section>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          {race && drivers && (
            <SharePicks
              raceName={race.name}
              round={race.round}
              playerName={(user.user_metadata?.["full_name"] as string | undefined) ?? user.email ?? "Driver"}
              drivers={drivers}
              top10={top10}
              pole={pole === EMPTY ? null : pole}
              fastestLap={fl === EMPTY ? null : fl}
              dnf={dnf === EMPTY ? null : dnf}
              lockedAt={prediction?.updated_at ?? null}
            />
          )}
          {!raceLocked && (
            <Button type="submit" size="lg" disabled={savingRace} className="ml-auto">
              {savingRace
                ? "Locking in\u2026"
                : raceSaved
                  ? raceDirty
                    ? "Save Changes *"
                    : "Update Race Picks"
                  : `Lock in Race Picks (${filledCount}/10)`}
            </Button>
          )}
        </div>
      </form>

      {/* Sticky mobile save bar so the user never forgets to submit after picking 10 drivers */}
      {!raceLocked && (filledCount === 10 || raceDirty) && (!raceSaved || raceDirty) && (
        <div className="fixed inset-x-0 bottom-16 z-30 border-t border-primary/50 bg-background/95 px-4 py-2.5 backdrop-blur md:hidden">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <span className="font-mono text-xs font-bold uppercase text-gold">
              {raceSaved ? "Unsaved changes!" : "10/10 selected \u2014 tap to save!"}
            </span>
            <Button
              type="button"
              size="sm"
              disabled={savingRace}
              onClick={(e) => void saveRace(e as unknown as React.FormEvent)}
            >
              {savingRace ? "Saving\u2026" : "Save Race Picks"}
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}

function Field({
  label,
  badge,
  purple,
  children,
}: {
  label: string;
  badge: string;
  purple?: boolean | undefined;
  disabled?: boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="font-display text-sm font-bold uppercase tracking-wider">{label}</label>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] font-bold",
            purple ? "bg-purple-500/20 text-purple" : "bg-gold/20 text-gold",
          )}
        >
          {badge}
        </span>
      </div>
      {children}
    </div>
  );
}