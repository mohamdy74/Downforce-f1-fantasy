-- Replace the open (WITH CHECK true) insert policy on web_vitals with real
-- content checks matching what the RUM client actually writes.
DROP POLICY IF EXISTS "web vitals insertable by signed-in players" ON public.web_vitals;

CREATE POLICY "web vitals insertable by signed-in players"
ON public.web_vitals
FOR INSERT
TO authenticated
WITH CHECK (
  metric IN ('lcp', 'inp', 'cls', 'ttfb', 'load', 'api')
  AND value >= 0
  AND value <= 600000
  AND char_length(route) <= 100
  AND route LIKE '/%'
  AND device IN ('mobile', 'tablet', 'desktop')
  AND conn IN ('slow-2g', '2g', '3g', '4g', 'unknown')
);