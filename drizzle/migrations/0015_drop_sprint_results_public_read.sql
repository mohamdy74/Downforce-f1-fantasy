-- The earlier pending sprint migration re-created a blanket read policy on
-- sprint_results; the signed-in-only policy is the one that should remain.
DROP POLICY IF EXISTS "sprint results readable by everyone" ON public.sprint_results;
REVOKE SELECT ON public.sprint_results FROM anon;