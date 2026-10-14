import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, Bell, RefreshCw, Clock, Trophy, Users, MessageCircle, CheckCircle2, AlertTriangle, Trash2, Edit3 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DriverPicker, EMPTY } from "@/components/DriverPicker";
import { useAuth } from "@/hooks/useAuth";
import { syncF1Data } from "@/lib/f1-sync.functions";
import { driversQuery, leaderboardQuery, nextRace, racesQuery } from "@/lib/queries";
import { executeStewardAction, getStewardsDashboard, STEWARD_EMAIL } from "@/lib/stewards.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/stewards")({
  head: () => ({
    meta: [{ title: "FIA Stewards & Race Control — DOWNFORCE" }],
  }),
  component: StewardsPage,
});

function StewardsPage() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const { data: races = [] } = useQuery(racesQuery);
  const { data: drivers = [] } = useQuery(driversQuery);
  const { data: board = [] } = useQuery({ ...leaderboardQuery, enabled: !!user });

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

  // Broadcast state
  const [pushTitle, setPushTitle] = useState("DOWNFORCE — Race Control");
  const [pushBody, setPushBody] = useState("");

  // Score override state
  const [scoreUser, setScoreUser] = useState("");
  const [scorePts, setScorePts] = useState("0");

  // Pick override state
  const [pickUser, setPickUser] = useState("");
  const [pickPole, setPickPole] = useState(EMPTY);
  const [pickFl, setPickFl] = useState(EMPTY);
  const [pickDnf, setPickDnf] = useState(EMPTY);
  const [pickTop10Codes, setPickTop10Codes] = useState("");

  // Manual results state
  const [resPole, setResPole] = useState(EMPTY);
  const [resFl, setResFl] = useState(EMPTY);
  const [resTop10Codes, setResTop10Codes] = useState("");
  const [resDnfCodes, setResDnfCodes] = useState("");

  // Player rename state
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

  const byCode = new Map(drivers.filter((d) => d.code).map((d) => [d.code!.toUpperCase(), d.id]));
  const byId = new Map(drivers.map((d) => [d.id, d]));

  function parseCodesToIds(raw: string): string[] {
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .map((code) => byCode.get(code) ?? drivers.find((d) => d.id.toUpperCase() === code)?.id ?? "")
      .filter(Boolean);
  }

  async function runAction(payload: Parameters<typeof executeStewardAction>[0]["data"]) {
    setBusy(true);
    try {
      const res = await executeStewardAction({ data: payload });
      toast.success(res.msg);
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

  // WhatsApp Round Summary text
  const fahlPlayer = board.find((e) => e.fahl);
  const top3 = board.slice(0, 3);
  const waSummary = [
    `🏁 *DOWNFORCE — ${activeRace?.name ?? "Race"} Report* 🏎️`,
    fahlPlayer ? `👑 *فحل الجولة:* ${fahlPlayer.name}` : "",
    "",
    `🏆 *Overall Standings:*`,
    ...top3.map((e, i) => `${i + 1}. ${e.name} — ${e.points} pts`),
    "",
    `📊 Check full debrief & 1v1 battles:`,
    typeof window !== "undefined" ? window.location.origin : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 pb-28 pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-gold">
            FIA Stewards &amp; Race Control
          </p>
          <h1 className="text-3xl">Stewards Room</h1>
        </div>
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
          className="gap-1.5"
        >
          <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
          7. Force Sync &amp; Recalculate All
        </Button>
      </div>

      {/* Round selector */}
      <div className="carbon-panel rounded-lg p-3">
        <label className="block font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Target Grand Prix Round
        </label>
        <select
          value={activeRace?.id ?? ""}
          onChange={(e) => setSelectedRaceId(e.target.value)}
          className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm font-bold"
        >
          {races.map((r) => (
            <option key={r.id} value={r.id}>
              R{r.round} — {r.name} {r.has_results ? "(Scored ✓)" : "(Upcoming)"}
            </option>
          ))}
        </select>
      </div>

      {/* 1. Live Pick Status Radar */}
      <section className="carbon-panel rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg">
            <CheckCircle2 className="h-5 w-5 text-gold" />
            1. Live Pick Status Radar ({activeRace?.name})
          </h2>
          <Button
            size="sm"
            variant="secondary"
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
            Push Alert Missing Only
          </Button>
        </div>
        <div className="mt-3 divide-y divide-border">
          {(dash?.profiles ?? []).map((p) => {
            const pr = predByUser.get(p.id);
            const hasPole = !!pr?.pole_driver_id;
            const topCount = (pr?.top10 ?? []).filter((x) => x && x !== "__none__").length;
            const pts = scoreByUser.get(p.id);
            return (
              <div key={p.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="font-display font-bold italic uppercase">{p.display_name}</span>
                <div className="flex items-center gap-2 font-mono text-xs">
                  <span className={cn("rounded px-2 py-0.5", hasPole ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive")}>
                    Pole: {hasPole ? "✓" : "✗"}
                  </span>
                  <span className={cn("rounded px-2 py-0.5", topCount === 10 ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive")}>
                    Top 10: {topCount}/10
                  </span>
                  {pts != null && <span className="font-bold text-gold">{pts} pts</span>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. Broadcast Push Notification */}
      <section className="carbon-panel rounded-lg p-4">
        <h2 className="flex items-center gap-2 text-lg">
          <Bell className="h-5 w-5 text-primary" />
          2. Broadcast Push Notification (All Phones)
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            type="text"
            value={pushTitle}
            onChange={(e) => setPushTitle(e.target.value)}
            placeholder="Notification Title"
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          />
          <input
            type="text"
            value={pushBody}
            onChange={(e) => setPushBody(e.target.value)}
            placeholder="Message body (e.g. Results are out! Check Standings)"
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => runAction({ action: "broadcast_push", title: pushTitle, body: pushBody || `Check out the latest update for ${activeRace?.name}!` })}
          >
            Send Broadcast Now
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              runAction({
                action: "broadcast_push",
                title: `🏆 ${activeRace?.name} Results Scored!`,
                body: "Points & standings are live! Tap to see who won فحل الجولة 👑",
              })
            }
          >
            Preset: Results Live 🏆
          </Button>
        </div>
      </section>

      {/* 3. Score & Penalty Override (-25 Waiver) */}
      <section className="carbon-panel rounded-lg p-4">
        <h2 className="flex items-center gap-2 text-lg">
          <Trophy className="h-5 w-5 text-gold" />
          3. Score &amp; Penalty Override ({activeRace?.name})
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <select
            value={scoreUser}
            onChange={(e) => {
              setScoreUser(e.target.value);
              const cur = scoreByUser.get(e.target.value);
              if (cur != null) setScorePts(String(cur));
            }}
            className="h-10 rounded-md border border-input bg-background px-2 text-sm"
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
            className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm"
            placeholder="Points"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-10 flex-1"
              disabled={busy || !scoreUser || !activeRace}
              onClick={() => runAction({ action: "override_score", raceId: activeRace!.id, userId: scoreUser, points: Number(scorePts) })}
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
      </section>

      {/* 4. Admin Pick Override (Enter picks on behalf of player) */}
      <section className="carbon-panel rounded-lg p-4">
        <h2 className="flex items-center gap-2 text-lg">
          <Edit3 className="h-5 w-5 text-primary" />
          4. Stewards Pick Override (Enter / Edit Player Picks)
        </h2>
        <div className="mt-3 space-y-3">
          <select
            value={pickUser}
            onChange={(e) => {
              const uid = e.target.value;
              setPickUser(uid);
              const pr = predByUser.get(uid);
              setPickPole(pr?.pole_driver_id ?? EMPTY);
              setPickFl(pr?.fastest_lap_driver_id ?? EMPTY);
              setPickDnf(pr?.dnf_driver_id ?? EMPTY);
              setPickTop10Codes((pr?.top10 ?? []).map((id) => byId.get(id)?.code ?? id).join(", "));
            }}
            className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Select player to enter/edit picks for…</option>
            {(dash?.profiles ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.display_name}</option>
            ))}
          </select>
          <div className="grid gap-2 sm:grid-cols-3">
            <div>
              <span className="font-mono text-[10px] uppercase text-muted-foreground">Pole Pick</span>
              <DriverPicker drivers={drivers} value={pickPole} onChange={setPickPole} />
            </div>
            <div>
              <span className="font-mono text-[10px] uppercase text-muted-foreground">Fastest Lap</span>
              <DriverPicker drivers={drivers} value={pickFl} onChange={setPickFl} />
            </div>
            <div>
              <span className="font-mono text-[10px] uppercase text-muted-foreground">DNF Pick</span>
              <DriverPicker drivers={drivers} value={pickDnf} onChange={setPickDnf} />
            </div>
          </div>
          <div>
            <span className="font-mono text-[10px] uppercase text-muted-foreground">
              Top 10 Driver Codes (comma separated, e.g. VER, NOR, LEC, PIA, HAM, RUS, SAI, ALO, GAS, ALB)
            </span>
            <input
              type="text"
              value={pickTop10Codes}
              onChange={(e) => setPickTop10Codes(e.target.value)}
              placeholder="VER, NOR, LEC, PIA, HAM, RUS, ANT, ALO, GAS, ALB"
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm uppercase"
            />
          </div>
          <Button
            size="sm"
            disabled={busy || !pickUser || !activeRace}
            onClick={() => {
              const ids = parseCodesToIds(pickTop10Codes);
              if (ids.length !== 10 && ids.length !== 0) {
                toast.error(`Resolved ${ids.length}/10 driver codes. Enter 10 valid 3-letter codes (or leave empty for pole-only).`);
                return;
              }
              runAction({
                action: "override_picks",
                raceId: activeRace!.id,
                userId: pickUser,
                pole: pickPole === EMPTY ? null : pickPole,
                fl: pickFl === EMPTY ? null : pickFl,
                dnf: pickDnf === EMPTY ? null : pickDnf,
                top10: ids,
              });
            }}
          >
            Save Player Picks as Steward
          </Button>
        </div>
      </section>

      {/* 5. Extend / Shift Deadlines (Rain Delay / Red Flag) */}
      <section className="carbon-panel rounded-lg p-4">
        <h2 className="flex items-center gap-2 text-lg">
          <Clock className="h-5 w-5 text-gold" />
          5. Adjust Lock Deadlines ({activeRace?.name})
        </h2>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          Qualifying: {activeRace?.qualifying_at ? new Date(activeRace.qualifying_at).toLocaleString("en-GB", { timeZone: "Africa/Cairo" }) : "N/A"} · Race: {activeRace ? new Date(activeRace.race_at).toLocaleString("en-GB", { timeZone: "Africa/Cairo" }) : "N/A"} (Cairo)
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !activeRace} onClick={() => runAction({ action: "shift_deadline", raceId: activeRace!.id, target: "qualifying", minutes: 30 })}>
            Quali +30m
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !activeRace} onClick={() => runAction({ action: "shift_deadline", raceId: activeRace!.id, target: "qualifying", minutes: -30 })}>
            Quali −30m
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !activeRace} onClick={() => runAction({ action: "shift_deadline", raceId: activeRace!.id, target: "race", minutes: 30 })}>
            Race +30m
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !activeRace} onClick={() => runAction({ action: "shift_deadline", raceId: activeRace!.id, target: "race", minutes: 60 })}>
            Race +1h
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !activeRace} onClick={() => runAction({ action: "shift_deadline", raceId: activeRace!.id, target: "race", minutes: -30 })}>
            Race −30m
          </Button>
        </div>
      </section>

      {/* 6. Manual Race Results Entry */}
      <section className="carbon-panel rounded-lg p-4">
        <h2 className="flex items-center gap-2 text-lg">
          <AlertTriangle className="h-5 w-5 text-primary" />
          6. Manual Race Results Entry &amp; Instant Scoring ({activeRace?.name})
        </h2>
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <span className="font-mono text-[10px] uppercase text-muted-foreground">Actual Pole Winner</span>
              <DriverPicker drivers={drivers} value={resPole} onChange={setResPole} />
            </div>
            <div>
              <span className="font-mono text-[10px] uppercase text-muted-foreground">Actual Fastest Lap</span>
              <DriverPicker drivers={drivers} value={resFl} onChange={setResFl} />
            </div>
          </div>
          <div>
            <span className="font-mono text-[10px] uppercase text-muted-foreground">
              Actual Top 10 Finishing Order (10 codes: P1 to P10)
            </span>
            <input
              type="text"
              value={resTop10Codes}
              onChange={(e) => setResTop10Codes(e.target.value)}
              placeholder="VER, NOR, LEC, PIA, HAM, RUS, ANT, ALO, GAS, ALB"
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm uppercase"
            />
          </div>
          <div>
            <span className="font-mono text-[10px] uppercase text-muted-foreground">
              DNF Driver Codes (optional, comma separated)
            </span>
            <input
              type="text"
              value={resDnfCodes}
              onChange={(e) => setResDnfCodes(e.target.value)}
              placeholder="LAW, OCO"
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm uppercase"
            />
          </div>
          <Button
            size="sm"
            disabled={busy || !activeRace}
            onClick={() => {
              const top10Ids = parseCodesToIds(resTop10Codes);
              if (top10Ids.length !== 10) {
                toast.error(`Resolved ${top10Ids.length}/10 drivers. Please enter 10 valid 3-letter codes.`);
                return;
              }
              const dnfIds = parseCodesToIds(resDnfCodes);
              runAction({
                action: "manual_results",
                raceId: activeRace!.id,
                pole: resPole === EMPTY ? null : resPole,
                fl: resFl === EMPTY ? null : resFl,
                top10: top10Ids,
                dnfs: dnfIds,
              });
            }}
          >
            Publish Official Results &amp; Score League Now
          </Button>
        </div>
      </section>

      {/* 8. Player Manager */}
      <section className="carbon-panel rounded-lg p-4">
        <h2 className="flex items-center gap-2 text-lg">
          <Users className="h-5 w-5 text-gold" />
          8. Player Manager (Rename / Remove Test Accounts)
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <select
            value={renameId}
            onChange={(e) => {
              setRenameId(e.target.value);
              const p = (dash?.profiles ?? []).find((x) => x.id === e.target.value);
              setRenameVal(p?.display_name ?? "");
            }}
            className="h-10 rounded-md border border-input bg-background px-2 text-sm"
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
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
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
              className="h-10"
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
      </section>

      {/* 9. WhatsApp Round Report Generator */}
      <section className="carbon-panel rounded-lg p-4">
        <h2 className="flex items-center gap-2 text-lg">
          <MessageCircle className="h-5 w-5 text-success" />
          9. WhatsApp Post-Race Report Generator
        </h2>
        <pre className="mt-2 whitespace-pre-wrap rounded-md bg-secondary/50 p-3 font-mono text-xs">
          {waSummary}
        </pre>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(waSummary)}`, "_blank")}
            className="gap-1.5"
          >
            <MessageCircle className="h-4 w-4" />
            Send to WhatsApp Group
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(waSummary);
              toast.success("Copied report!");
            }}
          >
            Copy Text
          </Button>
        </div>
      </section>
    </main>
  );
}
