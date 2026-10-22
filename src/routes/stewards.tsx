import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Shield,
  Bell,
  BellOff,
  RefreshCw,
  Clock,
  Trophy,
  Users,
  CheckCircle2,
  Flag,
  Trash2,
  Edit3,
  ChevronDown,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DriverPicker, EMPTY } from "@/components/DriverPicker";
import { SprintGrid } from "@/components/SprintGrid";
import { useAuth } from "@/hooks/useAuth";
import { syncF1Data } from "@/lib/f1-sync.functions";
import { isCompleteTop10 } from "@/lib/push-keys";
import { driversQuery, nextRace, racesQuery } from "@/lib/queries";
import { executeStewardAction, exportLeagueBackup, getStewardsDashboard, STEWARD_EMAIL } from "@/lib/stewards.functions";
import { Download } from "lucide-react";
import { sortByTeam, teamColor } from "@/lib/teams";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/stewards")({
  head: () => ({
    meta: [{ title: "FIA Stewards & Race Control — DOWNFORCE" }],
  }),
  component: StewardsPage,
});

function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StewardAccordionCard({
  id,
  openId,
  onToggle,
  icon,
  title,
  subtitle,
  badge,
  children,
}: {
  id: string;
  openId: string | null;
  onToggle: (id: string) => void;
  icon: ReactNode;
  title: string;
  subtitle: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const isOpen = openId === id;
  return (
    <section
      className={cn(
        "carbon-panel overflow-hidden rounded-xl border transition-colors",
        isOpen ? "border-primary/50 shadow-lg" : "border-border/70 hover:border-border",
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(id)}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-3.5 text-left transition-colors hover:bg-secondary/20 active:bg-secondary/40 sm:px-4"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-secondary/40">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-base font-extrabold italic uppercase leading-snug tracking-wide text-foreground sm:text-lg">
                {title}
              </h2>
              {badge}
            </div>
            <p className="mt-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {subtitle}
            </p>
          </div>
        </div>
        <div
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary/50 text-muted-foreground transition-transform duration-200",
            isOpen && "rotate-180 bg-primary/15 text-primary",
          )}
        >
          <ChevronDown className="h-4 w-4" />
        </div>
      </button>

      {isOpen && (
        <div className="border-t border-border/60 bg-background/40 px-3.5 py-4 sm:px-4">
          {children}
        </div>
      )}
    </section>
  );
}

function StewardsPage() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const { data: races = [] } = useQuery(racesQuery);
  const { data: drivers = [] } = useQuery(driversQuery);

  const isSteward = user?.email?.toLowerCase() === STEWARD_EMAIL;
  const upcoming = nextRace(races) ?? races[races.length - 1];
  const [selectedRaceId, setSelectedRaceId] = useState<string>("");
  const activeRace = races.find((r) => r.id === selectedRaceId) ?? upcoming;

  const { data: dash, refetch: refetchDash } = useQuery({
    queryKey: ["stewards-dash", activeRace?.id],
    enabled: !!isSteward && !!activeRace?.id,
    queryFn: () => getStewardsDashboard({ data: { raceId: activeRace!.id } }),
  });

  const [busy, setBusy] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);

  const toggleSection = (id: string) => {
    setOpenSection((prev) => (prev === id ? null : id));
  };

  const [scoreUser, setScoreUser] = useState("");
  const [scorePts, setScorePts] = useState("0");

  const [pickUser, setPickUser] = useState("");
  const [pickPole, setPickPole] = useState(EMPTY);
  const [pickFl, setPickFl] = useState(EMPTY);
  const [pickDnf, setPickDnf] = useState(EMPTY);
  const [pickTop10, setPickTop10] = useState<string[]>(Array(10).fill(EMPTY));

  const [customQualiDt, setCustomQualiDt] = useState("");
  const [customRaceDt, setCustomRaceDt] = useState("");
  const [customMinutes, setCustomMinutes] = useState("15");

  useEffect(() => {
    if (!activeRace) return;
    setCustomQualiDt(toLocalInputValue(activeRace.qualifying_at ?? activeRace.race_at));
    setCustomRaceDt(toLocalInputValue(activeRace.race_at));
  }, [activeRace?.id, activeRace?.qualifying_at, activeRace?.race_at]);

  const [resPole, setResPole] = useState(EMPTY);
  const [resFl, setResFl] = useState(EMPTY);
  const [resTop10, setResTop10] = useState<string[]>(Array(10).fill(EMPTY));
  const [resDnfList, setResDnfList] = useState<string[]>([]);

  useEffect(() => {
    if (!dash?.results?.length) return;
    const sortedFinishers = dash.results
      .filter((r) => r.finished && r.position != null && r.position <= 10)
      .sort((a, b) => a.position! - b.position!);
    if (sortedFinishers.length > 0) {
      setResTop10(Array.from({ length: 10 }, (_, i) => sortedFinishers[i]?.driver_id ?? EMPTY));
    }
    const p = dash.results.find((r) => r.pole)?.driver_id;
    const f = dash.results.find((r) => r.fastest_lap)?.driver_id;
    setResPole(p ?? EMPTY);
    setResFl(f ?? EMPTY);
    setResDnfList(dash.results.filter((r) => !r.finished).map((r) => r.driver_id));
  }, [dash?.results]);

  const [renameId, setRenameId] = useState("");
  const [renameVal, setRenameVal] = useState("");

  if (loading) return <main className="mx-auto max-w-3xl px-4 py-16">Loading Stewards Room…</main>;
  if (!user || !isSteward) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <Shield className="mx-auto h-12 w-12 text-primary" />
        <h1 className="mt-4 text-3xl">FIA Stewards Only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Access to Race Control is strictly restricted to the Race Director ({STEWARD_EMAIL}).
        </p>
      </main>
    );
  }

  async function runAction(payload: Parameters<typeof executeStewardAction>[0]["data"]) {
    setBusy(true);
    try {
      const res = await executeStewardAction({ data: payload });
      toast.success(res.msg, { duration: 6000 });
      await Promise.all([
        refetchDash(),
        queryClient.invalidateQueries({ queryKey: ["races"] }),
        queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const predByUser = new Map((dash?.preds ?? []).map((p) => [p.user_id, p]));
  const scoreByUser = new Map((dash?.scores ?? []).map((s) => [s.user_id, s.points]));
  const pushUserSet = new Set(dash?.pushUserIds ?? []);
  const sortedDrivers = sortByTeam(drivers);

  const totalPlayers = dash?.profiles?.length ?? 0;
  const lockedPlayers = (dash?.profiles ?? []).filter((p) => {
    const pr = predByUser.get(p.id);
    return isCompleteTop10(pr?.top10);
  }).length;

  function toggleDnfDriver(id: string) {
    setResDnfList((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-3 overflow-x-clip px-3 pb-28 pt-6 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-gold">
            FIA Stewards &amp; Race Control
          </p>
          <h1 className="text-2xl sm:text-3xl">Stewards Room</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const backup = await exportLeagueBackup();
                const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `downforce-backup-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 3000);
                toast.success("Full league database backup downloaded!");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Backup failed");
              } finally {
                setBusy(false);
              }
            }}
            className="h-9 gap-1.5 text-xs"
          >
            <Download className="h-3.5 w-3.5 text-gold" />
            Backup JSON
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await syncF1Data({ data: { force: true } });
                await Promise.all([
                  refetchDash(),
                  queryClient.invalidateQueries({ queryKey: ["races"] }),
                  queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
                ]);
                toast.success("Full F1 sync & score recalculation complete!");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Sync failed");
              } finally {
                setBusy(false);
              }
            }}
            className="h-9 gap-1.5 text-xs"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
            Force Sync All
          </Button>
        </div>
      </div>

      <div className="carbon-panel rounded-xl border border-border/70 p-3">
        <label className="block font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Target Grand Prix Round
        </label>
        <select
          value={activeRace?.id ?? ""}
          onChange={(e) => setSelectedRaceId(e.target.value)}
          className="mt-1.5 h-10 w-full min-w-0 rounded-md border border-input bg-background px-2.5 font-mono text-xs font-bold sm:text-sm"
        >
          {races.map((r) => (
            <option key={r.id} value={r.id}>
              R{r.round} · {r.name.replace("Grand Prix", "GP")} {r.has_results ? "(Scored ✓)" : "(Upcoming)"}
            </option>
          ))}
        </select>
      </div>

      {/* 1. Live Pick Status Radar */}
      <StewardAccordionCard
        id="radar"
        openId={openSection}
        onToggle={toggleSection}
        icon={<CheckCircle2 className="h-4 w-4 text-gold" />}
        title="Live Pick Status Radar"
        subtitle={`See who locked in for ${activeRace?.name ?? "this round"} and check each player's Push status`}
        badge={
          <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] font-bold text-gold">
            {lockedPlayers}/{totalPlayers} Locked
          </span>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="flex-1 sm:flex-initial"
              disabled={busy || !activeRace}
              onClick={() =>
                runAction({
                  action: "nudge_missing_push",
                  raceId: activeRace!.id,
                  title: `⏰ ${activeRace!.name} Picks Reminder!`,
                  body: "You still haven't locked in your Top 10! Tap here to submit before the -25 penalty.",
                })
              }
            >
              <Bell className="mr-1.5 h-3.5 w-3.5 text-gold" />
              Send Push Alert to Missing Players
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => runAction({ action: "test_my_push" })}
            >
              Test My Phone 🔔
            </Button>
          </div>

          <div className="divide-y divide-border">
            {(dash?.profiles ?? []).map((p) => {
              const pr = predByUser.get(p.id);
              const hasPole = !!pr?.pole_driver_id;
              const topCount = (pr?.top10 ?? []).filter((x) => x && x !== "__none__").length;
              const pts = scoreByUser.get(p.id);
              const hasPush = pushUserSet.has(p.id);
              return (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs sm:text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-display font-bold italic uppercase">{p.display_name}</span>
                    <span
                      title={hasPush ? "Subscribed to Web Push on phone/browser" : "Has not tapped Enable Alerts on phone yet"}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px]",
                        hasPush ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {hasPush ? <Bell className="h-2.5 w-2.5" /> : <BellOff className="h-2.5 w-2.5" />}
                      {hasPush ? "Push ON" : "No Push"}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
                    <span className={cn("rounded px-1.5 py-0.5", hasPole ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive")}>
                      Pole {hasPole ? "✓" : "✗"}
                    </span>
                    <span className={cn("rounded px-1.5 py-0.5", topCount === 10 ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive")}>
                      {topCount}/10
                    </span>
                    {pts != null && <span className="font-bold text-gold">{pts}p</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </StewardAccordionCard>

      {/* 2. Score & Penalty Override */}
      <StewardAccordionCard
        id="scores"
        openId={openSection}
        onToggle={toggleSection}
        icon={<Trophy className="h-4 w-4 text-gold" />}
        title="Score & Penalty Override"
        subtitle="Adjust round points or waive a −25 missed-submission penalty"
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <select
            value={scoreUser}
            onChange={(e) => {
              setScoreUser(e.target.value);
              const cur = scoreByUser.get(e.target.value);
              if (cur != null) setScorePts(String(cur));
            }}
            className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Select player…</option>
            {(dash?.profiles ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name} ({scoreByUser.get(p.id) ?? "no score"} pts)
              </option>
            ))}
          </select>
          <input
            type="number"
            value={scorePts}
            onChange={(e) => setScorePts(e.target.value)}
            className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 font-mono text-sm"
            placeholder="Points"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-10 flex-1"
              disabled={busy || !scoreUser || !activeRace}
              onClick={() =>
                runAction({
                  action: "override_score",
                  raceId: activeRace!.id,
                  userId: scoreUser,
                  points: Number(scorePts),
                })
              }
            >
              Set Points
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-10"
              disabled={busy || !scoreUser || !activeRace}
              onClick={() => runAction({ action: "remove_penalty", raceId: activeRace!.id, userId: scoreUser })}
            >
              Waive −25 → 0
            </Button>
          </div>
        </div>
      </StewardAccordionCard>

      {/* 3. Stewards Pick Override */}
      <StewardAccordionCard
        id="picks"
        openId={openSection}
        onToggle={toggleSection}
        icon={<Edit3 className="h-4 w-4 text-primary" />}
        title="Stewards Pick Override"
        subtitle="Enter or edit Pole, Fastest Lap, DNF & Top 10 grid for any player"
      >
        <div className="space-y-4">
          <select
            value={pickUser}
            onChange={(e) => {
              const uid = e.target.value;
              setPickUser(uid);
              const pr = predByUser.get(uid);
              setPickPole(pr?.pole_driver_id ?? EMPTY);
              setPickFl(pr?.fastest_lap_driver_id ?? EMPTY);
              setPickDnf(pr?.dnf_driver_id ?? EMPTY);
              const saved = pr?.top10 ?? [];
              setPickTop10(Array.from({ length: 10 }, (_, i) => saved[i] ?? EMPTY));
            }}
            className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm font-bold"
          >
            <option value="">Select player to enter/edit picks for…</option>
            {(dash?.profiles ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.display_name}</option>
            ))}
          </select>

          {pickUser && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">Pole Pick</span>
                  <DriverPicker drivers={drivers} value={pickPole} onChange={setPickPole} />
                </div>
                <div>
                  <span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">Fastest Lap</span>
                  <DriverPicker drivers={drivers} value={pickFl} onChange={setPickFl} />
                </div>
                <div>
                  <span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">DNF Pick</span>
                  <DriverPicker
                    drivers={drivers.filter((d) => !/aston|cadillac/i.test(d.team ?? ""))}
                    value={pickDnf}
                    exclude={pickTop10.filter((x) => x !== EMPTY)}
                    onChange={setPickDnf}
                  />
                </div>
              </div>

              <SprintGrid
                size={10}
                drivers={drivers}
                top10={pickTop10}
                setTop10={setPickTop10}
                locked={false}
              />

              <Button
                size="lg"
                className="w-full"
                disabled={busy || !pickUser || !activeRace}
                onClick={() => {
                  const valid = pickTop10.filter((x) => x !== EMPTY);
                  if (valid.length !== 10 && valid.length !== 0) {
                    toast.error(`Picked ${valid.length}/10 drivers. Complete all 10 slots (or clear all for Pole-only save).`);
                    return;
                  }
                  runAction({
                    action: "override_picks",
                    raceId: activeRace!.id,
                    userId: pickUser,
                    pole: pickPole === EMPTY ? null : pickPole,
                    fl: pickFl === EMPTY ? null : pickFl,
                    dnf: pickDnf === EMPTY ? null : pickDnf,
                    top10: valid.length === 10 ? pickTop10 : [],
                  });
                }}
              >
                Save Player Picks as Steward
              </Button>
            </>
          )}
        </div>
      </StewardAccordionCard>

      {/* 4. Adjust Lock Deadlines */}
      <StewardAccordionCard
        id="deadlines"
        openId={openSection}
        onToggle={toggleSection}
        icon={<Clock className="h-4 w-4 text-gold" />}
        title="Adjust Lock Deadlines"
        subtitle="Set exact date & time or shift Qualifying and Race lock times"
      >
        <div className="space-y-4">
          <p className="font-mono text-xs text-muted-foreground">
            Qualifying:{" "}
            <strong className="text-foreground">
              {activeRace?.qualifying_at
                ? new Date(activeRace.qualifying_at).toLocaleString("en-GB", { timeZone: "Africa/Cairo" })
                : "N/A"}
            </strong>{" "}
            · Race:{" "}
            <strong className="text-foreground">
              {activeRace
                ? new Date(activeRace.race_at).toLocaleString("en-GB", { timeZone: "Africa/Cairo" })
                : "N/A"}
            </strong>
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border/70 bg-secondary/20 p-3">
              <label className="block font-mono text-[10px] font-bold uppercase tracking-widest text-gold">
                Exact Qualifying Lock Time
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  type="datetime-local"
                  value={customQualiDt}
                  onChange={(e) => setCustomQualiDt(e.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs"
                />
                <Button
                  size="sm"
                  className="h-10 shrink-0"
                  disabled={busy || !activeRace || !customQualiDt}
                  onClick={() =>
                    runAction({
                      action: "set_exact_deadline",
                      raceId: activeRace!.id,
                      target: "qualifying",
                      isoTime: new Date(customQualiDt).toISOString(),
                    })
                  }
                >
                  Save
                </Button>
              </div>
            </div>

            <div className="rounded-md border border-border/70 bg-secondary/20 p-3">
              <label className="block font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
                Exact Race Lock Time
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  type="datetime-local"
                  value={customRaceDt}
                  onChange={(e) => setCustomRaceDt(e.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs"
                />
                <Button
                  size="sm"
                  className="h-10 shrink-0"
                  disabled={busy || !activeRace || !customRaceDt}
                  onClick={() =>
                    runAction({
                      action: "set_exact_deadline",
                      raceId: activeRace!.id,
                      target: "race",
                      isoTime: new Date(customRaceDt).toISOString(),
                    })
                  }
                >
                  Save
                </Button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">Shift by minutes:</span>
            <input
              type="number"
              value={customMinutes}
              onChange={(e) => setCustomMinutes(e.target.value)}
              className="h-9 w-20 rounded-md border border-input bg-background px-2 font-mono text-xs"
              placeholder="Mins"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !activeRace}
              onClick={() =>
                runAction({
                  action: "shift_deadline",
                  raceId: activeRace!.id,
                  target: "qualifying",
                  minutes: Number(customMinutes),
                })
              }
            >
              Shift Quali ({Number(customMinutes) >= 0 ? `+${customMinutes}` : customMinutes}m)
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !activeRace}
              onClick={() =>
                runAction({
                  action: "shift_deadline",
                  raceId: activeRace!.id,
                  target: "race",
                  minutes: Number(customMinutes),
                })
              }
            >
              Shift Race ({Number(customMinutes) >= 0 ? `+${customMinutes}` : customMinutes}m)
            </Button>
          </div>
        </div>
      </StewardAccordionCard>

      {/* 5. Manual Race Results Entry */}
      <StewardAccordionCard
        id="results"
        openId={openSection}
        onToggle={toggleSection}
        icon={<Flag className="h-4 w-4 text-primary" />}
        title="Manual Race Results Entry"
        subtitle="Select P1–P10 finishing order & retired DNF drivers to score immediately"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">Actual Pole Winner</span>
              <DriverPicker drivers={drivers} value={resPole} onChange={setResPole} />
            </div>
            <div>
              <span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">Actual Fastest Lap</span>
              <DriverPicker drivers={drivers} value={resFl} onChange={setResFl} />
            </div>
          </div>

          <SprintGrid
            size={10}
            drivers={drivers}
            top10={resTop10}
            setTop10={setResTop10}
            locked={false}
          />

          <div className="rounded-lg border border-border/70 bg-secondary/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-primary">
                Retired / DNF Drivers ({resDnfList.length} selected)
              </span>
              {resDnfList.length > 0 && (
                <button
                  type="button"
                  onClick={() => setResDnfList([])}
                  className="font-mono text-[10px] uppercase text-muted-foreground underline"
                >
                  Clear DNFs
                </button>
              )}
            </div>
            <div className="mt-2.5 grid grid-cols-3 gap-1.5 sm:grid-cols-5">
              {sortedDrivers.map((d) => {
                const isDnf = resDnfList.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDnfDriver(d.id)}
                    className={cn(
                      "flex min-w-0 items-center justify-between rounded-md border px-2 py-2 text-left font-mono text-xs font-bold transition",
                      isDnf
                        ? "border-destructive bg-destructive/20 text-destructive ring-1 ring-destructive"
                        : "border-border bg-background/70 text-foreground hover:border-primary/50",
                    )}
                    style={{ borderLeft: `4px solid ${teamColor(d.team)}` }}
                  >
                    <span className="truncate">{d.code ?? d.full_name}</span>
                    {isDnf && <span className="ml-1 shrink-0 text-[9px]">DNF</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <Button
            size="lg"
            className="w-full"
            disabled={busy || !activeRace}
            onClick={() => {
              const valid = resTop10.filter((x) => x !== EMPTY);
              if (valid.length !== 10) {
                toast.error(`Picked ${valid.length}/10 finishing positions. Please fill P1 through P10.`);
                return;
              }
              runAction({
                action: "manual_results",
                raceId: activeRace!.id,
                pole: resPole === EMPTY ? null : resPole,
                fl: resFl === EMPTY ? null : resFl,
                top10: resTop10,
                dnfs: resDnfList,
              });
            }}
          >
            Publish Official Results &amp; Score League Now
          </Button>
        </div>
      </StewardAccordionCard>

      {/* 6. Player Manager */}
      <StewardAccordionCard
        id="players"
        openId={openSection}
        onToggle={toggleSection}
        icon={<Users className="h-4 w-4 text-gold" />}
        title="Player Manager"
        subtitle="Rename player display names or remove test accounts"
        badge={
          <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] font-bold text-muted-foreground">
            {totalPlayers} Players
          </span>
        }
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <select
            value={renameId}
            onChange={(e) => {
              setRenameId(e.target.value);
              const p = (dash?.profiles ?? []).find((x) => x.id === e.target.value);
              setRenameVal(p?.display_name ?? "");
            }}
            className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Select player…</option>
            {(dash?.profiles ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.display_name}</option>
            ))}
          </select>
          <input
            type="text"
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            placeholder="New display name"
            className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-10 flex-1"
              disabled={busy || !renameId || !renameVal.trim()}
              onClick={() => runAction({ action: "rename_player", userId: renameId, name: renameVal })}
            >
              Rename
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-10 shrink-0"
              disabled={busy || !renameId}
              onClick={() => {
                if (window.confirm("Remove this player and their scores permanently?")) {
                  runAction({ action: "delete_player", userId: renameId });
                  setRenameId("");
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </StewardAccordionCard>
    </main>
  );
}
