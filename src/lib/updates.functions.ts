import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireSteward } from "./stewards.functions";

export const RACE_UPDATE_TYPES = ["penalty", "grid_change", "investigation", "general"] as const;
export type RaceUpdateType = (typeof RACE_UPDATE_TYPES)[number];

export type StewardUpdateResult = { ok: true; msg: string } | { ok: false; msg: string };

const TITLE_MAX = 140;
const BODY_MAX = 500;

export const postRaceUpdate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      raceId?: string;
      type?: string;
      driverId?: string | null;
      title?: string;
      body?: string | null;
    }) => d,
  )
  .handler(async ({ data, context }): Promise<StewardUpdateResult> => {
    const sb = await requireSteward(context);

    const raceId = (data.raceId ?? "").trim();
    const type = (data.type ?? "").trim() as RaceUpdateType;
    const driverId = (data.driverId ?? "").trim();
    const title = (data.title ?? "").trim();
    const body = (data.body ?? "").trim();

    if (!raceId) return { ok: false, msg: "Pick a target round first." };
    if (!RACE_UPDATE_TYPES.includes(type)) return { ok: false, msg: "Unknown update type." };
    if (!title) return { ok: false, msg: "A title is required." };
    if (title.length > TITLE_MAX) {
      return { ok: false, msg: `Title must be ${TITLE_MAX} characters or less.` };
    }
    if (body.length > BODY_MAX) {
      return { ok: false, msg: `Details must be ${BODY_MAX} characters or less.` };
    }

    const { error } = await sb.from("race_updates").insert({
      race_id: raceId,
      type,
      driver_id: driverId || null,
      title,
      body: body || null,
    });
    if (error) return { ok: false, msg: `Could not publish update: ${error.message}` };
    return { ok: true, msg: "Update published to the league." };
  });

export const deleteRaceUpdate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id?: string }) => d)
  .handler(async ({ data, context }): Promise<StewardUpdateResult> => {
    const sb = await requireSteward(context);
    const id = (data.id ?? "").trim();
    if (!id) return { ok: false, msg: "Missing update id." };

    const { error } = await sb.from("race_updates").delete().eq("id", id);
    if (error) return { ok: false, msg: `Could not delete update: ${error.message}` };
    return { ok: true, msg: "Update removed." };
  });

export const updateRaceUpdate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      type?: string;
      driverId?: string | null;
      title?: string;
      body?: string | null;
    }) => d,
  )
  .handler(async ({ data, context }): Promise<StewardUpdateResult> => {
    const sb = await requireSteward(context);

    const id = (data.id ?? "").trim();
    const type = (data.type ?? "").trim() as RaceUpdateType;
    const driverId = (data.driverId ?? "").trim();
    const title = (data.title ?? "").trim();
    const body = (data.body ?? "").trim();

    if (!id) return { ok: false, msg: "Missing update id." };
    if (!RACE_UPDATE_TYPES.includes(type)) return { ok: false, msg: "Unknown update type." };
    if (!title) return { ok: false, msg: "A title is required." };
    if (title.length > TITLE_MAX) {
      return { ok: false, msg: `Title must be ${TITLE_MAX} characters or less.` };
    }
    if (body.length > BODY_MAX) {
      return { ok: false, msg: `Details must be ${BODY_MAX} characters or less.` };
    }

    const { error } = await sb
      .from("race_updates")
      .update({
        type,
        driver_id: driverId || null,
        title,
        body: body || null,
      })
      .eq("id", id);
    if (error) return { ok: false, msg: `Could not save changes: ${error.message}` };
    return { ok: true, msg: "Update edited." };
  });
