-- Acelera la selección de partidas terminales para anonimización de snapshots vencidos.
CREATE INDEX IF NOT EXISTS idx_matches_finished_terminal
  ON matches (finished_at)
  WHERE status IN ('finished', 'abandoned') AND finished_at IS NOT NULL;
