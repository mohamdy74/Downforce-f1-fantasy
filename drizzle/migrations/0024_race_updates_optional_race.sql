-- 0024: A race update is either a general league announcement (race_id NULL)
-- or bound to a specific round. The steward chooses the target when
-- publishing — updates are no longer auto-attached to the current race.
-- 0018 was applied by hand to the live DB, so apply this one the same way
-- in the Supabase SQL Editor.

ALTER TABLE public.race_updates ALTER COLUMN race_id DROP NOT NULL;
