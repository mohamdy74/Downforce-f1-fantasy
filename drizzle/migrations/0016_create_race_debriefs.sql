CREATE TABLE IF NOT EXISTS public.race_debriefs (
  race_id uuid PRIMARY KEY REFERENCES public.races(id) ON DELETE CASCADE,
  content text NOT NULL,
  model text NOT NULL DEFAULT 'openai/gpt-6-astra',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.race_debriefs TO authenticated;
GRANT ALL ON public.race_debriefs TO service_role;
ALTER TABLE public.race_debriefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "race debriefs readable by authenticated" ON public.race_debriefs FOR SELECT TO authenticated USING (true);
CREATE POLICY "race debriefs insertable by authenticated" ON public.race_debriefs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "race debriefs updatable by authenticated" ON public.race_debriefs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);