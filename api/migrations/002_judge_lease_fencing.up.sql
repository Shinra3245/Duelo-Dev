-- Migración 002: Lease y fencing para workers del juez (S19, doc 04 §4/§5)

-- 1. Añadir columnas de lease y fencing a submissions
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS attempt_token VARCHAR(64),
  ADD COLUMN IF NOT EXISTS worker_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

-- 2. Índice parcial para reclamo atómico de envíos pendientes o con lease vencido
CREATE INDEX IF NOT EXISTS idx_submissions_claim
  ON submissions(status, lease_until)
  WHERE status IN ('queued', 'judging');

-- 3. Tabla durable e idempotente para mensajes rechazados del juez (doc 04 §135)
-- Registra únicamente message_id y motivo saneado, sin código ni casos de prueba
CREATE TABLE IF NOT EXISTS judge_rejected_messages (
  message_id VARCHAR(128) PRIMARY KEY,
  reason TEXT NOT NULL,
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_judge_rejected_messages_date
  ON judge_rejected_messages(rejected_at);
