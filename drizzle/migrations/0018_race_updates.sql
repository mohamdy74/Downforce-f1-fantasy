-- 0018: Race updates feed — steward-published news (penalties, grid changes,
-- investigations, general announcements) surfaced to every signed-in player
-- through the Updates bell in the site header. Players only ever SELECT:
-- writes happen exclusively through the steward-gated serverFn using the
-- service role, so there are deliberately no INSERT/UPDATE/DELETE policies
-- (RLS + grants mirror the race_debriefs pattern from 0016/0017).

CREATE TABLE IF NOT EXISTS public.race_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  race_id uuid NOT NULL REFERENCES public.races(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('penalty', 'grid_change', 'investigation', 'general')),
  driver_id text REFERENCES public.drivers(id) ON DELETE SET NULL,
  title text NOT NULL,
  body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.race_updates TO authenticated;
GRANT ALL ON public.race_updates TO service_role;
ALTER TABLE public.race_updates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "race updates readable by signed-in players" ON public.race_updates
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
CREATE INDEX IF NOT EXISTS race_updates_race_created_idx
  ON public.race_updates (race_id, created_at DESC);
