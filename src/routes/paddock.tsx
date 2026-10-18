import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { driversQuery, getTrustedNow, LEAGUE_START_ROUND, racesQuery, type Race } from "@/lib/queries";
import { positionPoints } from "@/lib/scoring";
import { teamColor } from "@/lib/teams";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/paddock")({
  head: () => ({
    meta: [
      { title: "Paddock Reveal & Race Debrief â€” DOWNFORCE" },
      {
        name: "description",
        content: "See every player's picks once the grid locks, and a colour-coded debrief of where points were won and lost.",
      },
      { property: "og:title", content: "Paddock Reveal & Race Debrief â€” DOWNFORCE" },
      { property: "og:description", content: "Everyone's picks revealed after lock, with a post-race points debrief." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Paddock Reveal & Race Debrief â€” DOWNFORCE" },
      { name: "twitter:description", content: "Everyone's picks revealed after lock, with a post-race points debrief." },
    ],
  }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(racesQuery).catch(() => null),
      context.queryClient.ensureQueryData(driversQuery).catch(() => null),
    ]);
  },
  component: Paddock,
});

type Pred = {
  user_id: string;
  top10: string[];
  pole_driver_id: string | null;
  fastest_lap_driver_id: string | null;
  dnf_driver_id: string | null;
};

function topPick(ids: (string | null | undefined)[]): { id: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (!id || id === "__none__") continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let bestId = "";
  let bestCount = 0;
  for (const [id, c] of counts.entries()) {
    if (c > bestCount) {
      bestId = id;
      bestCount = c;
    }
  }
  return bestId ? { id: bestId, count: bestCount } : null;
}

function Paddock() {
  const { user, loading } = useAuth();
  const { data: races } = useQuery(racesQuery);
  const { data: drivers } = useQuery(driversQuery);

  // Only include rounds from R14 (Spanish GP) onwards
  const locked = useMemo(
    () =>
      (races ?? []).filter(
        (r) => r.round >= LEAGUE_START_ROUND && new Date(r.race_at).getTime() <= getTrustedNow(),
      ),
    [races],
  );
  const [raceId, setRaceId] = useState<string | null>(null);
  const race: Race | undefined =
    locked.find((r) => r.id === raceId) ?? locked[locked.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["paddock", race?.id, user?.id],
    enabled: !!race && !!user,
    staleTime: 45_000,
    queryFn: async () => {
      const [preds, profiles, results, scores, logs] = await Promise.all([
        supabase
          .from("predictions")
          .select("user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id")
          .eq("race_id", race!.id),
        supabase.from("profiles").select("id, display_name"),
        supabase
          .from("race_results")
          .select("driver_id, position, finished, fastest_lap, pole")
          .eq("race_id", race!.id),
        supabase.from("scores").select("user_id, points").eq("race_id", race!.id),
        supabase
          .from("prediction_logs")
          .select("user_id, action, changes, created_at")
          .eq("race_id", race!.id)
          .order("created_at"),
      ]);
      const logMap = new Map<string, { action: string; changes: unknown; created_at: string }[]>();
      for (const l of logs.data ?? []) {
        const arr = logMap.get(l.user_id) ?? [];
        arr.push(l);
        logMap.set(l.user_id, arr);
      }
      return {
        preds: (preds.data ?? []) as Pred[],
        names: new Map((profiles.data ?? []).map((p) => [p.id, p.display_name])),
        results: results.data ?? [],
        points: new Map((scores.data ?? []).map((s) => [s.user_id, s.points])),
        logs: logMap,
      };
    },
  });

  if (loading) return <main className="mx-auto max-w-3xl px-4 py-16">Loadingâ€¦</main>;
  if (!user)
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-3xl">Sign in to see the paddock</h1>
        <Button asChild className="mt-6">
          <Link to="/auth">Continue with Google</Link>
        </Button>
      </main>
    );

  const byId = new Map((drivers ?? []).map((d) => [d.id, d]));
  const finish = new Map<string, number>();
  const dnfs = new Set<string>();
  let poleId: string | null = null;
  let flId: string | null = null;
  for (const r of data?.results ?? []) {
    if (r.finished && r.position != null) finish.set(r.driver_id, r.position);
    if (!r.finished) dnfs.add(r.driver_id);
    if (r.pole) poleId = r.driver_id;
    if (r.fastest_lap) flId = r.driver_id;
  }
  const hasResults = !!race?.has_results && (data?.results.length ?? 0) > 0;
  const sorted = [...(data?.preds ?? [])].sort(
    (a, b) => (data?.points.get(b.user_id) ?? 0) - (data?.points.get(a.user_id) ?? 0),
  );

  const crowdP1 = topPick(sorted.map((p) => p.top10[0]));
  const crowdPole = topPick(sorted.map((p) => p.pole_driver_id));

  return (
    <main className="mx-auto max-w-3xl px-4 pb-28 pt-10">
      <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-primary">
        {hasResults ? "Race debrief" : "Paddock reveal"}
      </p>
      <h1 className="mt-1 text-3xl">{race ? race.name : "No locked race yet"}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {hasResults
          ? "Green = exact position, gold = close, red = points lost"
          : "Picks are revealed once the grid locks â€” see what the group chose"}
      </p>

      {locked.length > 1 && (
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {locked
            .slice()
            .reverse()
            .map((r) => (
              <button
                key={r.id}
                onClick={() => setRaceId(r.id)}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1 font-mono text-xs transition-colors",
                  r.id === race?.id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground",
                )}
              >
                R{r.round} Â· {r.name.replace(" Grand Prix", " GP")}
              </button>
            ))}
        </div>
      )}

      {sorted.length > 1 && (crowdP1 || crowdPole) && (
        <div className="carbon-panel mt-4 grid grid-cols-2 gap-2 rounded-lg border border-border/70 p-3">
          {crowdP1 && (
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Crowd P1 Winner Pick
              </p>
              <p className="mt-0.5 font-display text-base font-extrabold italic uppercase text-gold">
                {byId.get(crowdP1.id)?.code ?? crowdP1.id}{" "}
                <span className="font-mono text-xs font-normal not-italic text-muted-foreground">
                  ({crowdP1.count}/{sorted.length})
                </span>
              </p>
            </div>
          )}
          {crowdPole && (
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Crowd Pole Pick
              </p>
              <p className="mt-0.5 font-display text-base font-extrabold italic uppercase text-foreground">
                {byId.get(crowdPole.id)?.code ?? crowdPole.id}{" "}
                <span className="font-mono text-xs font-normal not-italic text-muted-foreground">
                  ({crowdPole.count}/{sorted.length})
                </span>
              </p>
            </div>
          )}
        </div>
      )}

      {race && isLoading && (
        <div className="mt-6 space-y-4">
          {[0, 1, 2].map((k) => (
            <div key={k} className="carbon-panel h-48 animate-pulse rounded-lg p-4" />
          ))}
        </div>
      )}

      {race && !isLoading && sorted.length === 0 && (
        <p className="mt-8 text-sm text-muted-foreground">No one submitted picks for this race.</p>
      )}

      <div className="mt-6 space-y-4">
        {sorted.map((p) => {
          const pts = data?.points.get(p.user_id);
          return (
            <section key={p.user_id} className="carbon-panel rounded-lg p-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg">
                  {data?.names.get(p.user_id) ?? "Driver"}
                  {p.user_id === user.id && <span className="ml-2 text-xs text-primary">YOU</span>}
                </h2>
                {hasResults && pts != null && (
                  <span className="font-display text-2xl font-black text-gold">{pts} pts</span>
                )}
              </div>
              <ol className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                {p.top10.map((id, i) => {
                  const d = byId.get(id);
                  const actual = finish.get(id);
                  const diff = actual == null ? 99 : Math.abs(actual - (i + 1));
                  const pt = positionPoints(diff);
                  return (
                    <li
                      key={i}
                      className={cn(
                        "flex items-center gap-1.5 rounded-sm border-l-4 px-2 py-1 text-sm",
                        !hasResults && "bg-muted/40",
                        hasResults && diff === 0 && "bg-success/20",
                        hasResults && pt > 0 && diff !== 0 && "bg-gold/15",
                        hasResults && pt <= 0 && "bg-destructive/15",
                      )}
                      style={{ borderColor: teamColor(d?.team ?? null) }}
                    >
                      <span className="w-6 font-mono text-[11px] text-muted-foreground">P{i + 1}</span>
                      <span className="font-semibold">{d?.code ?? id}</span>
                      {hasResults && (
                        <span className="ml-auto font-mono text-xs">
                          {actual ? `P${actual}` : "DNF"} Â· {pt > 0 ? `+${pt}` : pt}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
              <div className="mt-2 grid grid-cols-3 gap-1 text-center text-xs">
                <BonusChip label="Pole" code={byId.get(p.pole_driver_id ?? "")?.code} hit={hasResults ? p.pole_driver_id === poleId : null} pts={3} />
                <BonusChip label="FL" code={byId.get(p.fastest_lap_driver_id ?? "")?.code} hit={hasResults ? p.fastest_lap_driver_id === flId : null} pts={3} />
                <BonusChip label="DNF" code={byId.get(p.dnf_driver_id ?? "")?.code} hit={hasResults ? !!p.dnf_driver_id && dnfs.has(p.dnf_driver_id) : null} pts={1} />
              </div>
              <AuditTrail entries={data?.logs.get(p.user_id) ?? []} code={(id) => byId.get(id)?.code ?? id} />
            </section>
          );
        })}
      </div>
    </main>
  );
}

function BonusChip({ label, code, hit, pts }: { label: string; code?: string | null | undefined; hit: boolean | null; pts: number }) {
  return (
    <div
      className={cn(
        "rounded-sm py-1",
        hit === null && "bg-muted/40",
        hit === true && "bg-success/20",
        hit === false && "bg-muted/20 text-muted-foreground",
      )}
    >
      <span className="text-muted-foreground">{label}</span> <b>{code ?? "â€”"}</b>
      {hit && <span className="ml-1 text-success">+{pts}</span>}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = { locked: "Locked picks", edited: "Edited picks", pole: "Pole pick" };

function AuditTrail({
  entries,
  code,
}: {
  entries: { action: string; changes: unknown; created_at: string }[];
  code: (id: string) => string;
}) {
  if (!entries.length) return null;
  const fmt = (t: string) =>
    new Date(t).toLocaleString("en-GB", {
      timeZone: "Africa/Cairo",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  const describe = (c: unknown): string => {
    const ch = (c ?? {}) as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, label] of [["pole", "Pole"], ["fl", "FL"], ["dnf", "DNF"]] as const) {
      const v = ch[k];
      if (Array.isArray(v)) parts.push(`${label} ${v[0] ? code(String(v[0])) : "â€”"}â†’${v[1] ? code(String(v[1])) : "â€”"}`);
      else if (typeof v === "string") parts.push(`${label} ${code(v)}`);
    }
    if (Array.isArray(ch["top10"]) && Array.isArray((ch["top10"] as unknown[])[0])) parts.push("top 10 changed");
    return parts.join(" Â· ");
  };
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">
        {entries.length} change{entries.length > 1 ? "s" : ""} Â· last {fmt(entries[entries.length - 1]!.created_at)} (Cairo)
      </summary>
      <ul className="mt-1 space-y-0.5 font-mono">
        {entries.map((e, i) => (
          <li key={i}>
            {fmt(e.created_at)} â€” {ACTION_LABEL[e.action] ?? e.action} {describe(e.changes)}
          </li>
        ))}
      </ul>
    </details>
  );
}