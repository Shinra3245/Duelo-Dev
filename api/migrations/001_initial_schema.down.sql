-- 001_initial_schema.down.sql
-- Reversión limpia del esquema durable inicial de PostgreSQL (doc 04 §1).

DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS match_code_snapshots CASCADE;
DROP TABLE IF EXISTS match_processed_submissions CASCADE;
DROP TABLE IF EXISTS match_round_results CASCADE;
DROP TABLE IF EXISTS match_solves CASCADE;
DROP TABLE IF EXISTS submissions CASCADE;
DROP TABLE IF EXISTS match_rounds CASCADE;
DROP TABLE IF EXISTS match_players CASCADE;
DROP TABLE IF EXISTS matches CASCADE;
DROP TABLE IF EXISTS test_cases CASCADE;
DROP TABLE IF EXISTS problems CASCADE;
DROP TABLE IF EXISTS refresh_tokens CASCADE;
DROP TABLE IF EXISTS users CASCADE;
