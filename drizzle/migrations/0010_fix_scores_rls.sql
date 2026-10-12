-- Fix RLS policy on scores table to prevent reading other players' scores before race lock
-- Critical security fix: prevents leaking league standings before race finishes

DROP POLICY IF EXISTS "scores readable by signed-in players" ON public.scores;

CREATE POLICY "scores readable conditionally" ON public.scores
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id -- own scores always readable
    OR EXISTS (
      SELECT 1 FROM public.races r
      WHERE r.id = scores.race_id
        AND r.race_at <= now() -- or after race has started
    )
  );
