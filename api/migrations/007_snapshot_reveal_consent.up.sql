-- Conserva si el jugador había permitido revelar el código al capturarse cada snapshot.
ALTER TABLE match_code_snapshots
  ADD COLUMN IF NOT EXISTS is_revealed BOOLEAN NOT NULL DEFAULT false;
