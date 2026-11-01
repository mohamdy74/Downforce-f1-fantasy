DROP POLICY IF EXISTS "race debriefs updatable by authenticated" ON public.race_debriefs;
DROP POLICY IF EXISTS "race debriefs insertable by authenticated" ON public.race_debriefs;
DROP POLICY IF EXISTS "race debriefs readable by authenticated" ON public.race_debriefs;
REVOKE INSERT, UPDATE ON public.race_debriefs FROM authenticated;
GRANT SELECT ON public.race_debriefs TO authenticated;
CREATE POLICY "race debriefs readable by signed-in players" ON public.race_debriefs FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);