-- Job queue: durable background jobs (season sync) claimed atomically from
-- the jobs table and processed by the status poll / cron warm-up worker.
CREATE TABLE IF NOT EXISTS "jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "dedup_key" text,
  "status" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "timeout_ms" integer NOT NULL DEFAULT 60000,
  "run_after" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "last_error" text,
  "result" jsonb,
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_check"
    CHECK ("status" IN ('queued', 'processing', 'succeeded', 'failed', 'dead'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Only one active job per (type, dedup_key): duplicate enqueues coalesce
-- onto the active job instead of piling up.
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_active_dedup_idx"
  ON "jobs" ("type", "dedup_key")
  WHERE "status" IN ('queued', 'processing');

CREATE INDEX IF NOT EXISTS "jobs_due_idx" ON "jobs" ("status", "run_after");

-- RLS: jobs are internal plumbing — clients get zero access. Only the
-- service-role server client (RLS bypass) reads and writes this table.
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
