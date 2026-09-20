import {
  ACTIVE_PROBLEM_CATEGORIES,
  ACTIVE_PROBLEMS_PER_CATEGORY,
  RONDAS_TARGET_VALUES,
  type ProblemCategory,
} from '@duelodev/shared';

export function getActiveProblemLimit(categories: readonly ProblemCategory[]): number {
  const activeCategoryCount = categories.filter((category) =>
    ACTIVE_PROBLEM_CATEGORIES.some((activeCategory) => activeCategory === category),
  ).length;
  return activeCategoryCount * ACTIVE_PROBLEMS_PER_CATEGORY;
}

export function fitRondasTarget(target: number, numProblems: number): number {
  if (RONDAS_TARGET_VALUES.some((value) => value === target && value <= numProblems)) {
    return target;
  }
  return [...RONDAS_TARGET_VALUES].reverse().find((value) => value <= numProblems) ?? 3;
}
