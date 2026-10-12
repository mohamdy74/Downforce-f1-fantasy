-- Add database indexes for performance optimization
-- Optimizes leaderboard aggregation and high-traffic queries

-- Scores: optimize leaderboard aggregation
CREATE INDEX IF NOT EXISTS scores_user_race_idx ON public.scores (user_id, race_id);
CREATE INDEX IF NOT EXISTS scores_race_points_idx ON public.scores (race_id, points DESC);

-- Prediction logs: optimize user history queries
CREATE INDEX IF NOT EXISTS prediction_logs_user_race_idx ON public.prediction_logs (user_id, race_id);
CREATE INDEX IF NOT EXISTS prediction_logs_race_created_idx ON public.prediction_logs (race_id, created_at DESC);

-- Predictions: optimize race_id lookups
CREATE INDEX IF NOT EXISTS predictions_race_user_idx ON public.predictions (race_id, user_id);
