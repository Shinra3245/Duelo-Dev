-- 001_initial_schema.up.sql
-- Esquema durable inicial de PostgreSQL para DueloDev (doc 04 §1).

-- Habilitar extensión pgcrypto para UUID si es necesario
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Usuarios
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255),
  gamertag VARCHAR(20) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'guest', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_users_gamertag CHECK (gamertag ~ '^[A-Za-z0-9-]{3,20}$')
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 2. Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  family_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(user_id, family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- 3. Problemas
CREATE TABLE IF NOT EXISTS problems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(32) NOT NULL CHECK (category IN ('muy_facil', 'facil', 'facil_medio', 'dificil')),
  time_limit_ms INTEGER NOT NULL CHECK (time_limit_ms > 0),
  memory_limit_mb INTEGER NOT NULL CHECK (memory_limit_mb > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  content_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_problems_category ON problems(category);

-- 4. Casos de prueba
CREATE TABLE IF NOT EXISTS test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  input TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  is_example BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_test_cases_problem_ordinal UNIQUE (problem_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_test_cases_problem ON test_cases(problem_id);

-- 5. Partidas (Matches)
CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code VARCHAR(10) NOT NULL UNIQUE,
  mode VARCHAR(20) NOT NULL CHECK (mode IN ('puntos', 'rondas')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('lobby', 'running', 'settling', 'finished', 'abandoned')),
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  host_id UUID NOT NULL REFERENCES users(id),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  admission_seq INTEGER NOT NULL DEFAULT 0 CHECK (admission_seq >= 0),
  winner_ids UUID[] NOT NULL DEFAULT '{}',
  winner_id UUID REFERENCES users(id),
  finish_reason VARCHAR(32) CHECK (finish_reason IS NULL OR finish_reason IN (
    'target_reached', 'problems_exhausted', 'time_expired', 'abandonment',
    'all_players_left', 'judge_unavailable', 'host_timeout', 'admin_override'
  )),
  started_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_matches_room_code ON matches(room_code);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);

-- 6. Jugadores en partida
CREATE TABLE IF NOT EXISTS match_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  cases_total INTEGER NOT NULL DEFAULT 0 CHECK (cases_total >= 0),
  time_total_ms INTEGER NOT NULL DEFAULT 0 CHECK (time_total_ms >= 0),
  current_problem_idx INTEGER NOT NULL DEFAULT 0 CHECK (current_problem_idx >= 0),
  is_ready BOOLEAN NOT NULL DEFAULT false,
  is_revealed BOOLEAN NOT NULL DEFAULT false,
  connection_status VARCHAR(20) NOT NULL DEFAULT 'connected' CHECK (connection_status IN ('connected', 'disconnected', 'left')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  left_at TIMESTAMPTZ,
  CONSTRAINT uq_match_players_match_user UNIQUE (match_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id);

-- 7. Rondas de partida
CREATE TABLE IF NOT EXISTS match_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round_id UUID NOT NULL,
  user_id UUID REFERENCES users(id),
  problem_id UUID NOT NULL REFERENCES problems(id),
  problem_version INTEGER NOT NULL CHECK (problem_version > 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('open', 'settling', 'closed')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  cutoff_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  winner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_match_rounds_match_round ON match_rounds(match_id, round_id);

-- 8. Envíos (Submissions)
CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  problem_id UUID NOT NULL REFERENCES problems(id),
  language VARCHAR(20) NOT NULL CHECK (language IN ('python', 'cpp', 'java')),
  source_code TEXT NOT NULL,
  time_limit_ms INTEGER NOT NULL CHECK (time_limit_ms > 0),
  memory_limit_mb INTEGER NOT NULL CHECK (memory_limit_mb > 0),
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  admission_seq INTEGER NOT NULL CHECK (admission_seq >= 1),
  status VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'judging', 'completed')),
  verdict VARCHAR(20) CHECK (verdict IS NULL OR verdict IN ('AC', 'WA', 'TLE', 'MLE', 'OLE', 'CE', 'RE', 'SE')),
  passed_cases INTEGER CHECK (passed_cases IS NULL OR passed_cases >= 0),
  total_cases INTEGER CHECK (total_cases IS NULL OR total_cases >= 0),
  exec_time_ms INTEGER CHECK (exec_time_ms IS NULL OR exec_time_ms >= 0),
  compile_output VARCHAR(4096),
  judge_error TEXT,
  judged_at TIMESTAMPTZ,
  CONSTRAINT chk_submissions_passed_lte_total CHECK (
    passed_cases IS NULL OR total_cases IS NULL OR passed_cases <= total_cases
  ),
  CONSTRAINT uq_submissions_match_admission UNIQUE (match_id, admission_seq)
);

CREATE INDEX IF NOT EXISTS idx_submissions_match_user ON submissions(match_id, user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_round ON submissions(round_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

-- 9. Soluciones válidas en partida
CREATE TABLE IF NOT EXISTS match_solves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  round_id UUID NOT NULL,
  submission_id UUID NOT NULL REFERENCES submissions(id),
  solve_elapsed_ms INTEGER NOT NULL CHECK (solve_elapsed_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_match_solves_match_user_round UNIQUE (match_id, user_id, round_id)
);

-- 10. Resultados de ronda
CREATE TABLE IF NOT EXISTS match_round_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round_id UUID NOT NULL,
  winner_id UUID REFERENCES users(id),
  winning_submission_id UUID REFERENCES submissions(id),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_match_round_results_match_round UNIQUE (match_id, round_id)
);

-- 11. Envíos procesados en partida
CREATE TABLE IF NOT EXISTS match_processed_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  submission_id UUID NOT NULL REFERENCES submissions(id) UNIQUE,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 12. Instantáneas de código (Snapshots)
CREATE TABLE IF NOT EXISTS match_code_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  problem_id UUID NOT NULL REFERENCES problems(id),
  language VARCHAR(20) NOT NULL CHECK (language IN ('python', 'cpp', 'java')),
  source_code TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_code_snapshots_match_user ON match_code_snapshots(match_id, user_id, round_id);

-- 13. Eventos de auditoría y producto
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_name VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_type, aggregate_id);
