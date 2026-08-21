"""Veredictos canónicos del juez (plan v2.0 §5.3).

Espejo exacto de `packages/shared/src/verdicts.ts`. La correspondencia se
verifica en `packages/shared/tests/limits-contract.test.ts`.
"""

from enum import StrEnum


class Verdict(StrEnum):
    AC = "AC"    # Todos los casos pasan
    WA = "WA"    # Salida difiere en >=1 caso
    TLE = "TLE"  # Excede tiempo en >=1 caso
    MLE = "MLE"  # OOM-kill del kernel
    RE = "RE"    # Exit code != 0
    CE = "CE"    # Falla compilación
    OLE = "OLE"  # stdout > 1 MB
    SE = "SE"    # Fallo interno del juez (se reintenta 1 vez)
