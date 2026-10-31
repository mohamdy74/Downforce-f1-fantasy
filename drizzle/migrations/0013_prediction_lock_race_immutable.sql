-- 0013: Prediction lock — make owner and race immutable on UPDATE (audit F-01).
-- The regular prediction trigger compared pick columns against the NEW race
-- but, unlike the sprint trigger, never rejected user_id/race_id changes: an
-- authenticated player could move unchanged picks into an already-started
-- race and have them scored retroactively (auto-scoring covers pending
-- rounds plus the latest completed round). Mirrors the sprint guard.

CREATE OR REPLACE FUNCTION public.enforce_prediction_locks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
BEGIN
  SELECT race_at, qualifying_at INTO r FROM public.races WHERE id = NEW.race_id;
  IF r IS NULL THEN
    RAISE EXCEPTION 'Unknown race';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF now() >= r.race_at THEN
      RAISE EXCEPTION 'Predictions are locked: the race has started';
    END IF;
    IF r.qualifying_at IS NOT NULL AND now() >= r.qualifying_at AND NEW.pole_driver_id IS NOT NULL THEN
      RAISE EXCEPTION 'Pole position picks are locked: qualifying has started';
    END IF;
  ELSE
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.race_id IS DISTINCT FROM OLD.race_id THEN
      RAISE EXCEPTION 'Prediction owner and race cannot be changed';
    END IF;

    IF now() >= r.race_at THEN
      IF NEW.top10 IS DISTINCT FROM OLD.top10
         OR NEW.fastest_lap_driver_id IS DISTINCT FROM OLD.fastest_lap_driver_id
         OR NEW.dnf_driver_id IS DISTINCT FROM OLD.dnf_driver_id
         OR NEW.pole_driver_id IS DISTINCT FROM OLD.pole_driver_id THEN
        RAISE EXCEPTION 'Predictions are locked: the race has started';
      END IF;
    ELSIF r.qualifying_at IS NOT NULL AND now() >= r.qualifying_at
          AND NEW.pole_driver_id IS DISTINCT FROM OLD.pole_driver_id THEN
      RAISE EXCEPTION 'Pole position picks are locked: qualifying has started';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS predictions_lock_guard ON public.predictions;
CREATE TRIGGER predictions_lock_guard BEFORE INSERT OR UPDATE ON public.predictions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_prediction_locks();
