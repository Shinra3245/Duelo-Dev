/**
 * Veredictos canónicos del juez (plan v2.0 §5.3).
 *
 * Espejo exacto de `judge/verdicts.py`. La correspondencia se verifica en
 * `tests/limits-contract.test.ts`; si divergen, CI falla.
 */
export const VERDICTS = {
  AC: 'AC',
  WA: 'WA',
  TLE: 'TLE',
  MLE: 'MLE',
  RE: 'RE',
  CE: 'CE',
  OLE: 'OLE',
  SE: 'SE',
} as const;

export type Verdict = (typeof VERDICTS)[keyof typeof VERDICTS];

/** Etiquetas en español para mostrar al jugador. */
export const VERDICT_LABELS: Record<Verdict, string> = {
  AC: 'Aceptado',
  WA: 'Respuesta incorrecta',
  TLE: 'Tiempo excedido',
  MLE: 'Memoria excedida',
  RE: 'Error en ejecución',
  CE: 'Error de compilación',
  OLE: 'Salida excedida',
  SE: 'Error del sistema',
};

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && value in VERDICTS;
}
