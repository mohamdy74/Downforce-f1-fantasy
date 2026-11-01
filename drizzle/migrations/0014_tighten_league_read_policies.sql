-- Remove anonymous (signed-out) access to league data; every page that reads
-- these tables already requires sign-in, so anon reads were unused exposure.

-- scores: drop the blanket public-read policy, keep signed-in league reads
DROP POLICY IF EXISTS "public read scores" ON public.scores;
REVOKE SELECT ON public.scores FROM anon;

-- profiles: drop the blanket public-read policy, keep signed-in league reads
DROP POLICY IF EXISTS "public read profiles" ON public.profiles;
REVOKE SELECT ON public.profiles FROM anon;

-- sprint_results: replace the allow-everyone policy with a signed-in-only rule
DROP POLICY IF EXISTS "sprint_results_read_all" ON public.sprint_results;
REVOKE SELECT ON public.sprint_results FROM anon;
CREATE POLICY "sprint results readable by signed-in players"
  ON public.sprint_results
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);
GRANT SELECT ON public.sprint_results TO authenticated;

-- weekend_sessions: RLS already denies signed-out users; remove the stale grant
REVOKE SELECT ON public.weekend_sessions FROM anon;