-- Push Notifications Table
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_sub_user ON public.push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_sub_endpoint ON public.push_subscriptions(endpoint);

-- Enable RLS (Row Level Security) on table
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Policy: users can only see/edit their own subscriptions
CREATE POLICY IF NOT EXISTS push_sub_own ON public.push_subscriptions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
