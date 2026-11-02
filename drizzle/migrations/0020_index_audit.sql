-- 0020: Index audit — after a full pass over every query in the app
-- (queries.ts, *.functions.ts, job-queue.ts, routes, components) and the
-- schema (0000–0019): two indexes from 0012 turned out to be exact/near
-- duplicates of constraint indexes (pure write overhead), and exactly one
-- hot ORDER BY had no usable index (the app-wide race-updates feed).
--
-- CONCURRENTLY everywhere: no read/write locks on live tables.
-- NOTE: statements marked CONCURRENTLY cannot run inside a transaction —
-- run the three statements ONE AT A TIME in the Supabase SQL Editor.

-- 1) scores_user_race_idx (user_id, race_id) is an EXACT duplicate of the
--    UNIQUE (user_id, race_id) constraint index scores_user_id_race_id_key.
--    Every scores upsert (one bulk upsert per scored race) and every
--    delete_player cleanup maintained both trees for identical coverage.
DROP INDEX CONCURRENTLY IF EXISTS public.scores_user_race_idx;

-- 2) prediction_logs_race_created_idx (race_id, created_at DESC) is redundant
--    with prediction_logs_race_idx (race_id, created_at) from 0007: the ASC
--    index already serves every race_id filter, and ORDER BY created_at DESC
--    is just a backward scan of the same btree. The audit trigger inserts a
--    row on EVERY prediction save/edit — this drops one tree per insert.
DROP INDEX CONCURRENTLY IF EXISTS public.prediction_logs_race_created_idx;

-- 3) The Updates bell feed (raceUpdatesQuery in queries.ts) runs on every
--    page load for every signed-in player:
--      SELECT ... FROM race_updates ORDER BY created_at DESC LIMIT 50
--    No race filter, so the existing race_updates_race_created_idx
--    (race_id, created_at DESC) cannot serve it (leading column unconstrained
--    -> Seq Scan + top-N sort). Writes to this table are steward-only and
--    rare, so the index costs almost nothing and the feed stops sorting.
CREATE INDEX CONCURRENTLY IF NOT EXISTS race_updates_created_idx
  ON public.race_updates (created_at DESC);
