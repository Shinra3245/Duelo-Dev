/**
 * Tipos y contratos para las semillas de problemas (doc 04 §1, doc 07 §1).
 */
import type { ProblemCategory, ProblemEntity, TestCaseEntity } from '@duelodev/shared';

export interface SeedTestCase {
  ordinal: number;
  input: string;
  expected_output: string;
  is_example: boolean;
}

export interface SeedProblemOrigin {
  kind: 'original' | 'adapted';
  url: string | null;
  license: string | null;
  attribution: string | null;
  verification_status: 'verified' | 'pending';
}

export interface SeedProblem {
  slug: string;
  title: string;
  category: ProblemCategory;
  description: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  version: number;
  origin: SeedProblemOrigin;
  test_cases: SeedTestCase[];
}

export interface SeedResult {
  seeded: number;
  skipped: number;
  problems: ProblemEntity[];
  test_cases: TestCaseEntity[];
}

export interface SeederOptions {
  /** Si es true, sobreescribe problemas existentes si su content_hash difiere */
  force?: boolean;
}
