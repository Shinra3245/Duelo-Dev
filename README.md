# DueloDev

Duelos de programación en tiempo real. Dos o tres personas resuelven el mismo problema a
la vez, viendo el editor del rival difuminado: su cursor, su actividad, sus veredictos.

> Estado: **Semana 0 — cimientos.** El plan completo está en
> [`docs/plan_ejecucion_tecnico_duelodev.md`](docs/plan_ejecucion_tecnico_duelodev.md).

## Arrancar en local

Requisitos: Node 24 LTS, Docker y Docker Compose.

```bash
cp .env.example .env      # rellena los secretos; genera con: openssl rand -base64 48
npm install
docker compose up -d      # postgres + redis
```

Verifica que ambos servicios quedaron sanos:

```bash
docker compose ps
```

## Comandos

| Comando                       | Qué hace                                |
| ----------------------------- | --------------------------------------- |
| `npm run typecheck`           | Typecheck de todos los paquetes         |
| `npm run lint`                | ESLint sobre el monorepo                |
| `npm run format`              | Prettier en modo escritura              |
| `npm test`                    | Pruebas unitarias de todos los paquetes |
| `npm run up` / `npm run down` | Levanta / apaga el stack local          |

## Estructura

```
packages/shared/   Contratos compartidos: eventos WS, veredictos, límites, errores
judge/             Juez aislado en Docker (Python)          — Semanas 1-2
api/               API REST (Fastify)                       — Semanas 3-4
realtime/          Socket.io + Yjs + modos de juego          — Semanas 5-6
web/               Next.js 14 + Monaco                       — Semanas 7-9
problems/          Los 18 problemas: enunciados y casos       — Semana 10
docs/              Plan de ejecución y decisiones
```

`packages/shared` es la **fuente única** de los contratos entre servicios. Ni el realtime
ni el web escriben literales de nombres de evento: los importan de ahí.

Los límites del juez (tiempos, memoria, pids) tienen su fuente de verdad en
`judge/limits.py`; `packages/shared/src/limits.ts` es su espejo y un test de contrato
falla si divergen.

## Arquitectura en una imagen

```
navegador ──HTTPS──► api ──LPUSH──► redis ──► workers del juez ──► docker aislado
    │                  │                            │
    └────WSS───────► realtime ◄──pub/sub────────────┘
                        │
                        └── Yjs: un documento por jugador, difuminado en el rival
```

La API y el realtime son procesos separados a propósito: desplegar la API no debe tirar
las partidas en curso.

## Juego limpio

El panel del rival está difuminado y bloquea copiar; el editor propio bloquea pegar
durante la partida. Es una barrera de diseño, no un blindaje: alguien con las
herramientas de desarrollo del navegador abiertas puede leer el texto del rival. Lo
decimos abierto porque preferimos que lo sepas a fingir que no ocurre.

## Contribuir

`main` está protegida. El trabajo va en ramas `feat/…`, `fix/…`, `chore/…`, `sec/…`, con
commits convencionales en español:

```
feat(juez): ejecutar todos los casos en un solo contenedor
```

Nada se mergea sin CI en verde.
