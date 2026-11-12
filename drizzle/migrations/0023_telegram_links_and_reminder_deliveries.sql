-- 0023 — Telegram linking on profiles + idempotent reminder delivery log.
--
-- Profiles already had a permissive SELECT policy (`USING (true)`) for anon and
-- authenticated, so a plain column add would have exposed every player's
-- telegram_chat_id to every visitor. Fix: drop the table-level grants and grant
-- column-level instead — the chat id, link token and username stay invisible to
-- clients, and only the service role (which bypasses RLS) writes them.
BEGIN;

-- TELEGRAM LINKING -----------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS telegram_chat_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_username text,
  ADD COLUMN IF NOT EXISTS telegram_linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS telegram_link_token text,
  ADD COLUMN IF NOT EXISTS telegram_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS notify_telegram boolean NOT NULL DEFAULT true;

-- Derived flag the client polls while waiting for the /start confirmation.
-- Generated (not a policy) so it can never drift from the chat id.
ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS telegram_linked;
ALTER TABLE public.profiles
  ADD COLUMN telegram_linked boolean GENERATED ALWAYS AS (telegram_chat_id IS NOT NULL) STORED;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_telegram_chat_id_key;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_telegram_chat_id_key UNIQUE (telegram_chat_id);

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_telegram_link_token_key;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_telegram_link_token_key UNIQUE (telegram_link_token);

-- Only linked, still-subscribed players are worth scanning every 15 minutes.
CREATE INDEX IF NOT EXISTS profiles_telegram_notify_idx
  ON public.profiles (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL AND notify_telegram = true;

-- Column-level grants: no client may read or write the chat id / link token.
REVOKE SELECT, INSERT, UPDATE ON public.profiles FROM anon, authenticated;

GRANT SELECT (id, display_name, avatar_url, created_at, notify_telegram, telegram_username, telegram_linked_at, telegram_linked)
  ON public.profiles TO anon, authenticated;

GRANT INSERT (id, display_name, avatar_url) ON public.profiles TO authenticated;
GRANT UPDATE (display_name, avatar_url, notify_telegram) ON public.profiles TO authenticated;

-- Note: rows are inserted by the SECURITY DEFINER `handle_new_user` trigger, not
-- by clients, so `notify_telegram` already defaults correctly on signup.

-- REMINDER DELIVERY LOG ------------------------------------------------------
-- One row per (race, session, window, target, user): the cron runs every 15
-- minutes and must never double-send. UNIQUE NULLS NOT DISTINCT lets the single
-- league_group row (user_id IS NULL) coexist with per-user rows.
CREATE TABLE IF NOT EXISTS public.reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  race_id uuid NOT NULL REFERENCES public.races(id) ON DELETE CASCADE,
  session_type text NOT NULL CHECK (session_type IN ('gp', 'sprint')),
  window_key text NOT NULL CHECK (window_key IN ('24h', '3h', '30m')),
  target_type text NOT NULL CHECK (target_type IN ('user', 'league_group')),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminder_deliveries_dedupe_key
    UNIQUE NULLS NOT DISTINCT (race_id, session_type, window_key, target_type, user_id)
);

CREATE INDEX IF NOT EXISTS reminder_deliveries_race_idx
  ON public.reminder_deliveries (race_id, session_type, window_key);

-- Service-role only: RLS enabled with no policies, and no client grants.
ALTER TABLE public.reminder_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reminder_deliveries FROM anon, authenticated;
GRANT ALL ON public.reminder_deliveries TO service_role;

COMMIT;