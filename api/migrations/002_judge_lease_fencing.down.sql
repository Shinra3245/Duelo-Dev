-- Migración 002 (Down): Reversión de lease y fencing para workers del juez (S19)

DROP TABLE IF EXISTS judge_rejected_messages;

DROP INDEX IF EXISTS idx_submissions_claim;

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS chk_submissions_lease_coherence,
  DROP COLUMN IF EXISTS lease_until,
  DROP COLUMN IF EXISTS worker_id,
  DROP COLUMN IF EXISTS attempt_token;
