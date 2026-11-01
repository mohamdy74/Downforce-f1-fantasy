import { createServerFn } from "@tanstack/react-start";
import { generateResponse, GatewayError } from "@lovable.dev/ai-gateway";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {} from "@/ai-gateway.types";

/**
 * AI Race Debrief — generates an Arabic post-race debrief per round from the
 * official results and every player's picks/scores. The result is cached in
 * `race_debriefs` (write path is server-only via the privileged client) and is
 * auto-regenerated when scores are later corrected (e.g. official feed
 * overwrites the fast fallback), or on explicit user request.
 */

const MODEL = "openai/gpt-6-astra" as const;

export type DebriefJson = {
  headline: string;
  summary: string;
  bullets: string[];
};

function extractText(res: unknown): string {
  const out = (res as { output?: unknown[] })?.output;
  if (!Array.isArray(out)) return "";
  const parts: string[] = [];
  for (const item of out) {
    const content = (item as { content?: unknown[] })?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if ((c as { type?: string })?.type === "output_text") {
        parts.push(String((c as { text?: string }).text ?? ""));
      }
    }
  }
  return parts.join("\n");
}

function parseDebrief(raw: string): DebriefJson | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as DebriefJson;
    if (typeof parsed.headline !== "string" || typeof parsed.summary !== "string") return null;
    if (!Array.isArray(parsed.bullets)) return null;
    return {
      headline: parsed.headline.slice(0, 200),
      summary: parsed.summary.slice(0, 1200),
      bullets: parsed.bullets
        .filter((b) => typeof b === "string")
        .slice(0, 6)
        .map((b) => b.slice(0, 300)),
    };
  } catch {
    return null;
  }
}

type RaceRow = { id: string; round: number; name: string; circuit: string | null };
type ResultRow = {
  driver_id: string;
  position: number | null;
  status: string | null;
  finished: boolean;
  fastest_lap: boolean;
  pole: boolean;
};
type DriverRow = { id: string; code: string | null; full_name: string; team: string | null };
type PredRow = {
  user_id: string;
  top10: string[];
  pole_driver_id: string | null;
  fastest_lap_driver_id: string | null;
  dnf_driver_id: string | null;
};
type ScoreRow = { user_id: string; points: number; updated_at: string };
type ProfileRow = { id: string; display_name: string };

export const getRaceDebrief = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { raceId: string; force?: boolean }) => d)
  .handler(async ({ data, context }) => {
    if (!context.userId) throw new Error("Sign in required");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin;

    const { data: race, error: raceErr } = await db
      .from("races")
      .select("id, round, name, circuit")
      .eq("id", data.raceId)
      .maybeSingle<RaceRow>();
    if (raceErr || !race) throw new Error("Race not found");

    const { data: results, error: resErr } = await db
      .from("race_results")
      .select("driver_id, position, status, finished, fastest_lap, pole")
      .eq("race_id", race.id)
      .order("position", { ascending: true, nullsFirst: false });
    if (resErr) throw new Error("Could not load results");
    if (!results || results.length < 10) return { status: "no_results" as const };

    const [{ data: drivers }, { data: preds }, { data: scores }, { data: profiles }] =
      await Promise.all([
        db.from("drivers").select("id, code, full_name, team"),
        db
          .from("predictions")
          .select("user_id, top10, pole_driver_id, fastest_lap_driver_id, dnf_driver_id")
          .eq("race_id", race.id),
        db.from("scores").select("user_id, points, updated_at").eq("race_id", race.id),
        db.from("profiles").select("id, display_name"),
      ]);

    const nameOf = new Map<string, string>();
    for (const p of (profiles ?? []) as ProfileRow[]) nameOf.set(p.id, p.display_name);
    const codeOf = new Map<string, string>();
    const teamOf = new Map<string, string>();
    for (const d of (drivers ?? []) as DriverRow[]) {
      codeOf.set(d.id, d.code ?? d.full_name);
      teamOf.set(d.id, d.team ?? "");
    }
    const pointsOf = new Map<string, number>();
    let newestScoreUpdate = "";
    for (const s of (scores ?? []) as ScoreRow[]) {
      pointsOf.set(s.user_id, s.points);
      if (s.updated_at > newestScoreUpdate) newestScoreUpdate = s.updated_at;
    }

    // Cache check (unless regeneration was requested).
    if (!data.force) {
      const { data: cached } = await db
        .from("race_debriefs")
        .select("content, updated_at")
        .eq("race_id", race.id)
        .maybeSingle<{ content: string; updated_at: string }>();
      if (cached) {
        const stale = newestScoreUpdate && cached.updated_at < newestScoreUpdate;
        if (!stale) {
          try {
            const parsed = parseDebrief(cached.content);
            if (parsed)
              return {
                status: "ok" as const,
                cached: true,
                debrief: parsed,
                generatedAt: cached.updated_at,
              };
          } catch {
            /* fall through to regeneration */
          }
        }
      }
    }

    // Build compact race facts for the model.
    const podium = (results ?? [])
      .filter((r) => r.finished && r.position != null && r.position <= 3)
      .map(
        (r) =>
          `P${r.position} ${codeOf.get(r.driver_id) ?? r.driver_id} (${teamOf.get(r.driver_id)})`,
      );
    const top10 = (results ?? [])
      .filter((r) => r.finished && r.position != null && r.position <= 10)
      .map((r) => `P${r.position} ${codeOf.get(r.driver_id) ?? r.driver_id}`);
    const dnfList = (results ?? [])
      .filter((r) => !r.finished)
      .map((r) => `${codeOf.get(r.driver_id) ?? r.driver_id}${r.status ? ` (${r.status})` : ""}`);
    const poleRow = (results ?? []).find((r) => r.pole);
    const flRow = (results ?? []).find((r) => r.fastest_lap);

    const playerLines = ((preds ?? []) as PredRow[]).map((p) => {
      const name = nameOf.get(p.user_id) ?? "Player";
      const pts = pointsOf.get(p.user_id);
      const picks = (p.top10 ?? [])
        .filter((x) => x && x !== "__none__")
        .map((x, i) => `P${i + 1} ${codeOf.get(x) ?? x}`)
        .join(", ");
      const bonuses: string[] = [];
      if (p.pole_driver_id)
        bonuses.push(`pole=${codeOf.get(p.pole_driver_id) ?? p.pole_driver_id}`);
      if (p.fastest_lap_driver_id)
        bonuses.push(`FL=${codeOf.get(p.fastest_lap_driver_id) ?? p.fastest_lap_driver_id}`);
      if (p.dnf_driver_id) bonuses.push(`DNF=${codeOf.get(p.dnf_driver_id) ?? p.dnf_driver_id}`);
      return `- ${name}: ${pts ?? "?"} pts | picks: ${picks || "(none)"}${bonuses.length ? ` | ${bonuses.join(", ")}` : ""}`;
    });

    const facts = [
      `Race: ${race.name} (Round ${race.round})${race.circuit ? ` at ${race.circuit}` : ""}`,
      `Podium: ${podium.join(" | ")}`,
      `Top 10: ${top10.join(", ")}`,
      `Pole: ${poleRow ? codeOf.get(poleRow.driver_id) : "?"}`,
      `Fastest lap: ${flRow ? codeOf.get(flRow.driver_id) : "?"}`,
      `Retirements (DNF): ${dnfList.length ? dnfList.join(", ") : "none"}`,
      "",
      "Players (fantasy league, scoring: top10 points table + 3 pole + 3 fastest lap + 1 DNF, -25 if no Top 10 submitted):",
      ...playerLines,
    ].join("\n");

    const instructions =
      "You are the race analyst for DOWNFORCE, an Arabic fantasy F1 prediction league (friends playing for fun). " +
      "Write a short post-race debrief in EGYPTIAN-flavoured Arabic (colloquial, friendly, like the group admin talking to the players). " +
      "Use driver three-letter codes as-is (e.g. VER, HAM) inside the Arabic text. " +
      "Keep it factual: only use the facts provided. Mention who scored big, who lost points and why (wrong picks, missed pole/fastest lap/DNF), the -25 no-submission penalty if anyone has it, and one or two surprising moments of the race. " +
      "Respond with ONLY a JSON object, no markdown fences, in this exact shape: " +
      '{"headline": string (one punchy Arabic line, max 12 words), "summary": string (2-3 short Arabic sentences), "bullets": string[] (3-5 short Arabic bullets, one per notable player or moment, each under 20 words)}.';

    try {
      const res = await generateResponse({
        model: MODEL,
        instructions,
        input: facts,
        max_output_tokens: 1600,
      });
      const text = extractText(res);
      const parsed = parseDebrief(text);
      if (!parsed) throw new Error("The analyst came back empty this time — try again.");
      const payload = JSON.stringify(parsed);
      const { error: upErr } = await db.from("race_debriefs").upsert(
        {
          race_id: race.id,
          content: payload,
          model: MODEL,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "race_id" },
      );
      if (upErr) throw new Error("Could not save the debrief");
      return {
        status: "ok" as const,
        cached: false,
        debrief: parsed,
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof GatewayError) {
        if (err.code === "payment_required")
          throw new Error("AI credits need a top-up before the analyst can write again.");
        throw new Error("The analyst is busy right now — try again in a minute.");
      }
      throw err instanceof Error ? err : new Error("Debrief generation failed");
    }
  });
