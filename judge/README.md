# Juez — sandbox de ejecución

Estado: **estructura creada en la Semana 0. La implementación es de las Semanas 1-2.**

Hoy solo existe la fuente de verdad de constantes y veredictos, que ya está atada a
TypeScript por un test de contrato:

- `limits.py` — **única fuente de verdad** de tiempos, memoria, pids y salida (D3/D7).
- `verdicts.py` — enum canónico de veredictos (plan §5.3).

Pendiente (Semanas 1-2): `Dockerfile.judge`, `executor.py`, `runner.sh`, `worker.py`,
`seccomp-profile.json` y la suite de abuso de 15 puntos.

## Dos restricciones que definen este módulo

1. **Un contenedor por envío, no por caso.** Con 12 casos, arrancar un contenedor por
   caso son 4-6 s de puro overhead por envío. `runner.sh` itera los casos dentro del
   contenedor y emite una línea JSON por caso.
2. **El worker nunca comparte contenedor ni usuario con los secretos de la API.**
   `docker-py` necesita el socket de Docker, y ese socket es root en el host: un worker
   comprometido con acceso a él anula todo el sandbox.

Ambas están razonadas en `.claude/context/03-escalabilidad-hallazgos.md` (H1 y H2) y son
requisitos, no preferencias.
