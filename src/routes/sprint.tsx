import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Countdown } from "@/components/Countdown";
import { DriverSelect, EMPTY, SprintGrid } from "@/components/SprintGrid";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { driversQuery, getTrustedNow, racesQuery } from "@/lib/queries";
import { sprintPoleLockAt, sprintWeekend } from "@/lib/sprint";
import { assertDeadlineOpen } from "@/lib/prediction.functions";
import {
  SPRINT_MAX_POINTS,
  SPRINT_SLOTS,
  scoreSprint,
  type SprintResultRow,
} from "@/lib/sprintScoring";
import { teamColor } from "@/lib/teams";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/sprint")({
  head: () => ({
    meta: [
      { title: "Sprint picks \u2014 DOWNFORCE" },
      {
        name: "description",
        content: "Predict the sprint top 8 and the sprint pole. Up to 9 extra points on sprint weekends.",
      },
      { property: "og:title", content: "Sprint picks \u2014 DOWNFORCE" },
      {
        property: "og:description",
        content: "Predict the sprint top 8 and the sprint pole.",
      },
      { name: "twitter:title", content: "Sprint picks \u2014 DOWNFORCE" },
      { name: "twitter:description", content: "Predict the sprint top 8 and the sprint pole." },
    ],
  }),
  component: Sprint,
});

function fireConfetti() {
  if (typeof window === "undefined") return;
  void import("canvas-confetti")
    .then((m) =>
      m.default({
        particleCount: 45,
        spread: 62,
        origin: { y: 0.78 },
        colors: ["#e10600", "#f59e0b", "#ffffff"],
        disableForReducedMotion: true,
      }),
    )
    .catch(() => null);
}

function Sprint() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const { data: races } = useQuery(racesQuery);
  const { data: drivers } = useQuery(driversQuery);

  const race = useMemo(() => (races ? sprintWeekend(races) : null), [races]);

  const [now, setNow] = useState(() => getTrustedNow());
  useEffect(() => {
    const t = setInterval(() => setNow(getTrustedNow()), 30_000);
    return () => clearInterval(t);
  }, []);

  const sprintLocked = !!race?.sprint_at && new Date(race.sprint_at).getTime() <= now;
  const poleLockAt = race ? sprintPoleLockAt(race) : null;
  const poleLocked = !!poleLockAt && new Date(poleLockAt).getTime() <= now;

  const { data: prediction, isLoading: predLoading } = useQuery({
    queryKey: ["sprint-prediction", race?.id, user?.id],
    enabled: !!race && !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sprint_predictions")
        .select("*")
        .eq("race_id", race!.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: results } = useQuery({
    queryKey: ["sprint-results", race?.id],
    enabled: !!race,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sprint_results")
        .select("driver_id, position, finished, pole, status")
        .eq("race_id", race!.id)
        .order("position", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const draftKey = user && race ? `dfr:sprint-draft:${user.id}:${race.id}` : null;

  const [top8, setTop8] = useState<string[]>(Array(SPRINT_SLOTS).fill(EMPTY));
  const [pole, setPole] = useState<string>(EMPTY);
  const [savingPole, setSavingPole] = useState(false);
  const [savingSprint, setSavingSprint] = useState(false);
  const hydratedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = `${race?.id ?? ""}:${user?.id ?? ""}:${prediction?.id ?? "none"}:${prediction?.updated_at ?? ""}`;
    if (hydratedKeyRef.current === key) return;
    if (predLoading) return;
    hydratedKeyRef.current = key;

    if (prediction) {
      const p = [...(prediction.top8 ?? [])];
      while (p.length < SPRINT_SLOTS) p.push(EMPTY);
      setTop8(p.slice(0, SPRINT_SLOTS));
      setPole(prediction.pole_driver_id ?? EMPTY);
      return;
    }

    if (draftKey) {
      try {
        const raw = localStorage.getItem(draftKey);
        if (raw) {
          const d = JSON.parse(raw) as { top8?: string[]; pole?: string };
          if (Array.isArray(d.top8) && d.top8.length === SPRINT_SLOTS) setTop8(d.top8);
          else setTop8(Array(SPRINT_SLOTS).fill(EMPTY));
          setPole(d.pole ?? EMPTY);
          return;
        }
      } catch {
        /* ignore */
      }
    }

    setTop8(Array(SPRINT_SLOTS).fill(EMPTY));
    setPole(EMPTY);
  }, [prediction, predLoading, draftKey, race?.id, user?.id]);

  // Auto-save Sprint draft while user has not submitted yet
  useEffect(() => {
    if (!draftKey || prediction || predLoading) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ top8, pole }));
      } catch {
        /* ignore */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [draftKey, prediction, predLoading, top8, pole]);

  const savedTop8 = useMemo(() => {
    const p = [...(prediction?.top8 ?? [])];
    while (p.length < SPRINT_SLOTS) p.push(EMPTY);
    return p.slice(0, SPRINT_SLOTS);
  }, [prediction]);
  const savedPole = prediction?.pole_driver_id ?? EMPTY;

  const poleDirty = !poleLocked && pole !== savedPole;
  const sprintDirty = !sprintLocked && top8.some((d, i) => d !== savedTop8[i]);

  useEffect(() => {
    if (!prediction || (!poleDirty && !sprintDirty)) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [prediction, poleDirty, sprintDirty]);

  const repeatLast = useCallback(async () => {
    if (!user || !race || !races) return;
    const prevSprintRaces = races
      .filter((r) => r.has_sprint && r.round < race.round)
      .sort((a, b) => b.round - a.round);
    if (prevSprintRaces.length > 0) {
      const { data } = await supabase
        .from("sprint_predictions")
        .select("*")
        .eq("user_id", user.id)
        .in("race_id", prevSprintRaces.map((r) => r.id));
      const latestSprint = prevSprintRaces
        .map((r) => data?.find((p) => p.race_id === r.id))
        .find(Boolean);
      if (latestSprint && (latestSprint.top8?.length ?? 0) > 0) {
        const padded = [...(latestSprint.top8 ?? [])];
        while (padded.length < SPRINT_SLOTS) padded.push(EMPTY);
        setTop8(padded.slice(0, SPRINT_SLOTS));
        if (!poleLocked && latestSprint.pole_driver_id) setPole(latestSprint.pole_driver_id);
        toast.success("Copied your picks from the previous Sprint \u2014 review & save!");
        return;
      }
    }
    // Fallback: copy first 8 drivers from user's most recent Grand Prix prediction
    const { data: gpPreds } = await supabase
      .from("predictions")
      .select("top10, pole_driver_id, updated_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(1);
    const latestGp = gpPreds?.[0];
    if (latestGp && (latestGp.top10?.length ?? 0) >= SPRINT_SLOTS) {
      setTop8(latestGp.top10.slice(0, SPRINT_SLOTS));
      if (!poleLocked && latestGp.pole_driver_id) setPole(latestGp.pole_driver_id);
      toast.success("Copied Top 8 from your latest Grand Prix grid \u2014 review & save!");
      return;
    }
    toast.error("No saved Sprint or Grand Prix picks found to copy.");
  }, [user, race, races, poleLocked]);

  if (loading) return null;
  if (!user) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-3xl">Sign in to play Sprint</h1>
        <Button asChild className="mt-6">
          <Link to="/auth">Continue with Google</Link>
        </Button>
      </main>
    );
  }

  if (!race) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          Sprint weekend
        </p>
        <h1 className="mt-2 text-3xl">No Sprint this week</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page opens automatically on Sprint weekends (China, Miami, Canada, Great Britain, Netherlands, Singapore).
        </p>
        <Button asChild variant="outline" className="mt-6">
          <Link to="/weekend">See full calendar</Link>
        </Button>
      </main>
    );
  }

  async function savePole() {
    if (!race || !user) return;
    if (poleLocked) {
      toast.error("Sprint Qualifying has started \u2014 pole pick is locked.");
      return;
    }
    if (pole === EMPTY) {
      toast.error("Choose a sprint pole driver first.");
      return;
    }
    setSavingPole(true);
    try {
      await assertDeadlineOpen({ data: { raceId: race.id, kind: "sprint_pole" } });
    } catch (e) {
      setSavingPole(false);
      toast.error(e instanceof Error ? e.message : "Sprint pole is locked.");
      return;
    }
    const { error } = await supabase.from("sprint_predictions").upsert(
      {
        user_id: user.id,
        race_id: race.id,
        pole_driver_id: pole,
        top8: prediction?.top8 ?? [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,race_id" },
    );
    setSavingPole(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Sprint Pole locked in!");
    fireConfetti();
    await queryClient.invalidateQueries({ queryKey: ["sprint-prediction", race.id, user.id] });
  }

  async function saveSprint(e: React.FormEvent) {
    e.preventDefault();
    if (!race || !user) return;
    if (sprintLocked) {
      toast.error("Sprint has started \u2014 picks are locked.");
      return;
    }
    const picked = top8.filter((d) => d !== EMPTY);
    if (picked.length < SPRINT_SLOTS) {
      toast.error("Fill all 8 positions before saving.");
      return;
    }
    if (new Set(picked).size !== SPRINT_SLOTS) {
      toast.error("Each driver can only appear once.");
      return;
    }

    setSavingSprint(true);
    try {
      await assertDeadlineOpen({ data: { raceId: race.id, kind: "sprint" } });
    } catch (err) {
      setSavingSprint(false);
      toast.error(err instanceof Error ? err.message : "Sprint picks are locked.");
      return;
    }
    const newPole = poleLocked
      ? (prediction?.pole_driver_id ?? null)
      : pole === EMPTY
        ? (prediction?.pole_driver_id ?? null)
        : pole;

    const { error } = await supabase.from("sprint_predictions").upsert(
      {
        user_id: user.id,
        race_id: race.id,
        top8,
        pole_driver_id: newPole,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,race_id" },
    );
    setSavingSprint(false);
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
    toast.success("Sprint picks locked in!");
    fireConfetti();
    await queryClient.invalidateQueries({ queryKey: ["sprint-prediction", race.id, user.id] });
  }

  const byId = new Map((drivers ?? []).map((d) => [d.id, d]));
  const hasResults = (results?.length ?? 0) > 0;
  const breakdown = hasResults
    ? scoreSprint(
        prediction ? { top8: prediction.top8 ?? [], pole_driver_id: prediction.pole_driver_id } : null,
        results as SprintResultRow[],
      )
    : null;

  const filledCount = top8.filter((d) => d !== EMPTY).length;
  const sprintSaved = (prediction?.top8?.filter((x) => x && x !== EMPTY).length ?? 0) === SPRINT_SLOTS;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 pb-28">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-gold">
            \u26a1 Sprint Weekend \u00b7 Round {race.round} \u00b7 Max +{SPRINT_MAX_POINTS} pts
          </p>
          <h1 className="text-3xl sm:text-4xl">{race.name} \u2014 Sprint</h1>
          <p className="text-sm text-muted-foreground">
            1 pt for every exact position in P1\u2013P8, plus 1 pt for Sprint Pole. No penalty if you skip.
          </p>
        </div>
        {(poleDirty || sprintDirty) && (
          <span className="rounded bg-gold/20 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-gold">
            {prediction ? "Unsaved edits" : "Draft auto-saved"}
          </span>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {poleLockAt && (
          <Countdown
            target={poleLockAt}
            label={poleLocked ? "Sprint Pole locked" : "Sprint Pole locks (SQ start)"}
          />
        )}
        {race.sprint_at && (
          <Countdown
            target={race.sprint_at}
            label={sprintLocked ? "Sprint picks locked" : "Sprint locks (Start)"}
          />
        )}
      </div>

      {hasResults && breakdown && (
        <section className="carbon-panel mt-6 rounded-lg p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xl">Your Sprint Score</h2>
            <span className="font-display text-3xl font-black text-gold">
              +{breakdown.total} PTS
            </span>
          </div>
          <div className="mt-4 grid gap-1.5 font-mono text-xs">
            {Array.from({ length: SPRINT_SLOTS }, (_, i) => i + 1).map((pos) => {
              const actualRow = results!.find((r) => r.finished && r.position === pos);
              const act = actualRow ? byId.get(actualRow.driver_id) : null;
              const pickedId = prediction?.top8?.[pos - 1];
              const pred = pickedId ? byId.get(pickedId) : null;
              const hit = actualRow && pickedId === actualRow.driver_id;
              return (
                <div
                  key={pos}
                  className="flex items-center justify-between rounded bg-secondary/50 px-3 py-1.5"
                  style={{ borderLeft: `3px solid ${teamColor(act?.team)}` }}
                >
                  <span>
                    P{pos} \u00b7 Actual <strong>{act?.code ?? "\u2014"}</strong> \u00b7 Your pick{" "}
                    <strong>{pred?.code ?? "\u2014"}</strong>
                  </span>
                  <span className={cn(hit && "font-bold text-gold")}>{hit ? "+1" : "0"}</span>
                </div>
              );
            })}
            <div className="mt-2 flex gap-2">
              <span className="rounded bg-secondary px-2 py-1">Sprint Pole +{breakdown.pole}</span>
            </div>
          </div>
        </section>
      )}

      {/* STEP 1 \u2014 SPRINT POLE */}
      <section className="carbon-panel mt-8 rounded-lg">
        <div className="kerb-strip" />
        <div className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-gold">
                Step 1 \u00b7 Locks at Sprint Qualifying \u00b7 +1 pt
              </p>
              <h2 className="text-xl">Sprint Pole Pick</h2>
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
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <DriverSelect
                drivers={drivers ?? []}
                value={pole}
                onChange={setPole}
                disabled={poleLocked}
                placeholder="Choose sprint pole driver"
              />
            </div>
            {!poleLocked && (
              <Button type="button" onClick={savePole} disabled={savingPole || pole === EMPTY}>
                {savingPole
                  ? "Saving\u2026"
                  : prediction?.pole_driver_id
                    ? poleDirty
                      ? "Update Sprint Pole *"
                      : "Update Sprint Pole"
                    : "Lock in Sprint Pole"}
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* STEP 2 \u2014 SPRINT TOP 8 */}
      <form onSubmit={saveSprint}>
        <SprintGrid
          size={SPRINT_SLOTS}
          drivers={drivers ?? []}
          top10={top8}
          setTop10={setTop8}
          locked={sprintLocked}
          onRepeat={repeatLast}
        />

        {!sprintLocked && (
          <div className="mt-6 flex justify-end">
            <Button type="submit" size="lg" disabled={savingSprint}>
              {savingSprint
                ? "Locking in\u2026"
                : sprintSaved
                  ? sprintDirty
                    ? "Save Sprint Changes *"
                    : "Update Sprint Picks"
                  : `Lock in Sprint Top 8 (${filledCount}/${SPRINT_SLOTS})`}
            </Button>
          </div>
        )}
      </form>
    </main>
  );
}