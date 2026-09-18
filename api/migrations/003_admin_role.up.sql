-- Amplía el contrato de roles y motivos administrativos sin eliminar datos históricos.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'guest', 'admin'));

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_finish_reason_check;
ALTER TABLE matches ADD CONSTRAINT matches_finish_reason_check CHECK (
  finish_reason IS NULL OR finish_reason IN (
    'target_reached', 'problems_exhausted', 'time_expired', 'abandonment',
    'all_players_left', 'judge_unavailable', 'host_timeout', 'admin_override'
  )
);
