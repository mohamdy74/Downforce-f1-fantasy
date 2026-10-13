import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Countdown } from "@/components/Countdown";
import { DriverSelect, EMPTY, SprintGrid } from "@/components/SprintGrid";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { driversQuery, racesQuery } from "@/lib/queries";
import { sprintPoleLockAt, sprintWeekend } from "@/lib/sprint";
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
      { title: "Sprint picks — DOWNFORCE" },
      {
        name: "description",
        content: "Predict the sprint top 8 and the sprint pole. Up to 9 extra points on sprint weekends.",
      },
      { property: "og:title", content: "Sprint picks — DOWNFORCE" },
      {
        property: "og:description",
        content: "Predict the sprint top 8 and the sprint pole.",
      },
      { name: "twitter:title", content: "Sprint picks — DOWNFORCE" },
      { name: "twitter:description", content: "Predict the sprint top 8 and the sprint pole." },
    ],
  }),
  component: Sprint,
});

function Sprint() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const { data: races } = useQuery(racesQuery);
  const { data: drivers } = useQuery(driversQuery);

  const race = useMemo(() => (races ? sprintWeekend(races) : null), [races]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const sprintLocked = !!race?.sprint_at && new Date(race.sprint_at).getTime() <= now;
  const poleLockAt = race ? sprintPoleLockAt(race) : null;
  const poleLocked = !!poleLockAt && new Date(poleLockAt).getTime() <= now;

  const { data: prediction } = useQuery({
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
    queryFn: async (): Promise<SprintResultRow[]> => {
      const { data, error } = await supabase
        .from("sprint_results")
        .select("driver_id, position, finished, pole")
        .eq("race_id", race!.id);
      if (error) throw error;
      return (data ?? []) as SprintResultRow[];
    },
  });

  const { data: group } = useQuery({
    queryKey: ["sprint-group", race?.id, user?.id, sprintLocked],
    enabled: !!race && !!user && sprintLocked,
    queryFn: async () => {
      const [preds, profiles] = await Promise.all([
        supabase
          .from("sprint_predictions")
          .select("user_id, top8, pole_driver_id")
          .eq("race_id", race!.id),
        supabase.from("profiles").select("id, display_name"),
      ]);
      if (preds.error) throw preds.error;
      const names: Record<string, string> = {};
      for (const p of profiles.data ?? []) names[p.id] = p.display_name;
      return { preds: preds.data ?? [], names };
    },
  });

  const [top8, setTop8] = useState<string[]>(Array(SPRINT_SLOTS).fill(EMPTY));
  const [pole, setPole] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!prediction) return;
    const saved = prediction.top8 ?? [];
    setPole(prediction.pole_driver_id ?? EMPTY);
    // A pole-only save has no top 8 yet — keep whatever the player is building.
    if (saved.length === 0) return;
    setTop8(Array.from({ length: SPRINT_SLOTS }, (_, i) => saved[i] ?? EMPTY));
  }, [prediction]);

  const hasSaved = (prediction?.top8?.length ?? 0) === SPRINT_SLOTS;
  const viewOnly = sprintLocked || (hasSaved && !editing);

  if (loading) {
    return (
      <Shell>
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="mt-4 h-12 w-full animate-pulse rounded-md bg-muted/60" />
        <div className="mt-6 h-40 w-full animate-pulse rounded-lg bg-muted/60" />
      </Shell>
    );
  }

  if (!user) {
    return (
      <Shell>
        <h1 className="text-3xl">Sign in to predict the sprint</h1>
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
        <h1 className="text-3xl">No sprint this weekend</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          The Sprint tab only opens on sprint weekends.
        </p>
      </Shell>
    );
  }

  const used = top8.filter((d) => d !== EMPTY);
  const duplicates = used.length !== new Set(used).size;
  const byId = new Map((drivers ?? []).map((d) => [d.id, d]));
  const codeOf = (id: string | null | undefined) =>
    id ? (byId.get(id)?.code ?? byId.get(id)?.full_name ?? id) : "—";

  const savedPole = prediction?.pole_driver_id ?? null;
  const poleDirty = (savedPole ?? EMPTY) !== pole;

  const hasResults = (results?.length ?? 0) > 0;
  const mine = prediction
    ? scoreSprint(
        { top8: prediction.top8 ?? [], pole_driver_id: prediction.pole_driver_id },
        results ?? [],
      )
    : null;
  const actualTop8 = (results ?? [])
    .filter((r) => r.finished && r.position != null && r.position <= SPRINT_SLOTS)
    .sort((a, b) => a.position! - b.position!);
  const actualPole = (results ?? []).find((r) => r.pole)?.driver_id ?? null;

  async function save() {
    if (duplicates) {
      toast.error("Each driver can only appear once in your sprint top 8.");
      return;
    }
    if (used.length !== SPRINT_SLOTS) {
      toast.error(`Pick all ${SPRINT_SLOTS} positions before submitting.`);
      return;
    }
    setSaving(true);
    // Once sprint qualifying has started the pole pick is frozen, so we never send it.
    const fields = {
      top8,
      ...(poleLocked ? {} : { pole_driver_id: pole === EMPTY ? null : pole }),
    };
    let error: { message: string } | null = null;
    const upd = await supabase
      .from("sprint_predictions")
      .update(fields)
      .eq("user_id", user!.id)
      .eq("race_id", race!.id)
      .eq("updated_at", prediction?.updated_at ?? new Date(0).toISOString()) // optimistic lock
      .select("id");

    if (upd.error) {
      error = upd.error;
    } else if (!upd.data?.length) {
      if (prediction?.id) {
        // Optimistic lock conflict
        toast.error("Someone else modified this prediction. Reloading...");
        queryClient.invalidateQueries({ queryKey: ["sprint-prediction", race!.id, user!.id] });
        setSaving(false);
        return;
      }
      const ins = await supabase
        .from("sprint_predictions")
        .insert({ user_id: user!.id, race_id: race!.id, ...fields });
      error = ins.error;
    }
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Sprint picks locked in.");
    setEditing(false);
    navigator.vibrate?.([12, 40, 18]);
    queryClient.invalidateQueries({ queryKey: ["sprint-prediction", race!.id, user!.id] });
  }

  async function savePole() {
    if (pole === EMPTY) {
      toast.error("Choose a sprint pole driver first.");
      return;
    }
    setSaving(true);
    const upd = await supabase
      .from("sprint_predictions")
      .update({ pole_driver_id: pole })
      .eq("user_id", user!.id)
      .eq("race_id", race!.id)
      .select("id");
    let error = upd.error;
    if (!error && !upd.data?.length) {
      const ins = await supabase
        .from("sprint_predictions")
        .insert({ user_id: user!.id, race_id: race!.id, pole_driver_id: pole, top8: [] });
      error = ins.error;
    }
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Sprint pole pick saved.");
    queryClient.invalidateQueries({ queryKey: ["sprint-prediction", race!.id, user!.id] });
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-10">
      <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-primary">
        Round {race.round} · Sprint
      </p>
      <h1 className="mt-1 text-3xl">{race.name}</h1>
      <p className="text-sm text-muted-foreground">
        {race.circuit}
        {race.country ? ` · ${race.country}` : ""}
      </p>

      <p className="mt-3 text-sm text-muted-foreground">
        Predict the sprint top 8: +1 for every exact position, plus +1 for the sprint pole.
        Maximum {SPRINT_MAX_POINTS} points, added to this round's total.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {poleLockAt && <Countdown target={poleLockAt} label="Sprint pole pick closes in" />}
        {race.sprint_at && <Countdown target={race.sprint_at} label="Sprint top 8 closes in" />}
      </div>

      <section
        className="carbon-panel mt-6 rounded-lg border-l-4 p-4 sm:p-5"
        style={{ borderLeftColor: "var(--gold)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-gold">
              Sprint pole · +1
            </p>
            <h2 className="mt-1 text-xl">Who takes sprint pole?</h2>
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
          <DriverSelect
            drivers={drivers ?? []}
            value={pole}
            disabled={poleLocked}
            onChange={setPole}
          />
        </div>

        {!poleLocked && (
          <Button
            type="button"
            disabled={saving || !poleDirty || pole === EMPTY}
            onClick={savePole}
            className="mt-3 h-11 w-full"
          >
            {savedPole && !poleDirty ? "Sprint pole saved ✓" : "Save sprint pole"}
          </Button>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {poleLocked
            ? "Sprint qualifying has started, so the sprint pole pick is locked."
            : "Save it now and finish your top 8 later. You can change it until sprint qualifying starts."}
        </p>
      </section>

      <SprintGrid
        size={SPRINT_SLOTS}
        drivers={drivers ?? []}
        top10={top8}
        setTop10={setTop8}
        locked={viewOnly}
      />
      {duplicates && (
        <p className="mt-3 text-sm text-destructive">A driver is selected more than once.</p>
      )}

      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 mt-4 rounded-lg bg-background/80 p-2 backdrop-blur-md md:bottom-3">
        {sprintLocked ? (
          <Button size="lg" className="h-12 w-full text-base" disabled>
            Sprint picks locked — sprint started
          </Button>
        ) : viewOnly ? (
          <Button
            size="lg"
            variant="outline"
            className="h-12 w-full text-base"
            onClick={() => setEditing(true)}
          >
            Edit sprint picks
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
                  queryClient.invalidateQueries({
                    queryKey: ["sprint-prediction", race.id, user.id],
                  });
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            )}
            <Button size="lg" className="h-12 flex-1 text-base" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Lock in sprint picks"}
            </Button>
          </div>
        )}
      </div>

      {hasResults && (
        <section className="carbon-panel mt-6 rounded-lg p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl">Sprint result</h2>
            {mine && (
              <span className="font-mono text-sm font-bold">
                Your sprint points: +{mine.total} / {SPRINT_MAX_POINTS}
              </span>
            )}
          </div>
          <ul className="mt-3 divide-y divide-border">
            {actualTop8.map((r) => {
              const d = byId.get(r.driver_id);
              const picked = prediction?.top8?.[r.position! - 1];
              const hit = picked === r.driver_id;
              return (
                <li key={r.driver_id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="w-8 font-mono font-bold">P{r.position}</span>
                  <span
                    className="border-l-4 pl-2 font-display font-extrabold italic uppercase"
                    style={{ borderColor: teamColor(d?.team ?? null) }}
                  >
                    {codeOf(r.driver_id)}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    your pick: {codeOf(picked)}
                  </span>
                  <span className={cn("w-8 text-right font-mono font-bold", hit ? "text-success" : "text-muted-foreground")}>
                    {hit ? "+1" : "0"}
                  </span>
                </li>
              );
            })}
            <li className="flex items-center gap-3 py-2 text-sm">
              <span className="w-8 font-mono font-bold text-gold">POLE</span>
              <span className="font-display font-extrabold italic uppercase">
                {codeOf(actualPole)}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                your pick: {codeOf(prediction?.pole_driver_id)}
              </span>
              <span
                className={cn(
                  "w-8 text-right font-mono font-bold",
                  mine && mine.pole > 0 ? "text-success" : "text-muted-foreground",
                )}
              >
                {mine && mine.pole > 0 ? "+1" : "0"}
              </span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Sprint points are added to the round total once the Grand Prix is scored.
          </p>
        </section>
      )}

      {sprintLocked && group && (
        <section className="carbon-panel mt-6 rounded-lg p-4 sm:p-5">
          <h2 className="text-xl">Everyone's sprint picks</h2>
          {group.preds.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Nobody submitted sprint picks.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {group.preds.map((p) => {
                const s = hasResults
                  ? scoreSprint({ top8: p.top8 ?? [], pole_driver_id: p.pole_driver_id }, results ?? [])
                  : null;
                return (
                  <li key={p.user_id} className="py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{group.names[p.user_id] ?? "Player"}</span>
                      {s && <span className="font-mono font-bold">+{s.total}</span>}
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      Pole {codeOf(p.pole_driver_id)} · {(p.top8 ?? []).map((id) => codeOf(id)).join(" ") || "no top 8"}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-3xl px-4 py-16">{children}</main>;
}
