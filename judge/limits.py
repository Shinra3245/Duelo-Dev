"""Límites del juez (decisiones D3 y D7).

FUENTE ÚNICA DE VERDAD de estos valores (contexto H9). El espejo en TypeScript
está en `packages/shared/src/limits.ts` y la igualdad se verifica en
`packages/shared/tests/limits-contract.test.ts`; si divergen, CI falla.

Ningún otro archivo del proyecto puede contener un número mágico de tiempo,
memoria o pids.
"""

from typing import Final, Literal

Language = Literal["python", "cpp", "java"]

LANGUAGES: Final[tuple[Language, ...]] = ("python", "cpp", "java")

# Multiplicador de tiempo respecto al límite base, que es el de C++ (D3).
TIME_MULTIPLIERS: Final[dict[Language, int]] = {
    "python": 3,
    "cpp": 1,
    "java": 2,
}

# Límite base por defecto en milisegundos; C++ (D7). Cada problema puede subirlo.
DEFAULT_TIME_LIMIT_MS: Final[int] = 2000

# Límites duros del contenedor, iguales para todo lenguaje (D7).
MEMORY_LIMIT_MB: Final[int] = 256
CPU_LIMIT: Final[float] = 1.0
PIDS_LIMIT: Final[int] = 64
OUTPUT_LIMIT_BYTES: Final[int] = 1024 * 1024
SOURCE_CODE_MAX_BYTES: Final[int] = 64 * 1024

# Timeouts de compilación en milisegundos. Python no compila.
COMPILE_TIMEOUT_MS: Final[dict[Language, int]] = {
    "python": 0,
    "cpp": 10_000,
    "java": 15_000,
}

# Margen del timeout externo de pared respecto al límite interno.
# Red de seguridad si el `timeout` dentro del contenedor falla (doc 06 §1).
WALL_CLOCK_MARGIN: Final[float] = 1.5

# Cooldown entre envíos por jugador, en segundos (D7).
SUBMIT_COOLDOWN_S: Final[int] = 10

# Tamaño de la tmpfs montada en /box por envío.
BOX_TMPFS_MB: Final[int] = 64


def resolve_time_limit_ms(base_ms: int, language: Language) -> int:
    """Límite efectivo para un lenguaje a partir del límite base del problema."""
    return round(base_ms * TIME_MULTIPLIERS[language])
