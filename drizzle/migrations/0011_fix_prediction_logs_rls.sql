-- Fix RLS policy on prediction_logs to protect player privacy
-- High priority: prevents immediate visibility of edit strategies after race starts

DROP POLICY IF EXISTS "locked race logs readable by league" ON public.prediction_logs;

CREATE POLICY "locked race logs readable by league" ON public.prediction_logs
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id -- own logs always readable
    OR EXISTS (
      SELECT 1 FROM public.races r
      WHERE r.id = prediction_logs.race_id
        AND r.race_at <= now() - interval '1 hour' -- 1h after race start
    )
  );
