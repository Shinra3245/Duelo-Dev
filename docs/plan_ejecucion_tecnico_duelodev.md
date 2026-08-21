# DueloDev — Plan de Ejecución Técnico Completo

### Especificación de ingeniería, desglose de tareas y manual de operación del proyecto

_Versión 2.0 — Julio 2026_
_Este documento sustituye y absorbe al "Plan Maestro v1.1". Las decisiones D1-D10 permanecen vigentes y aquí se traducen a especificación implementable._

---

## Índice

1. Visión y alcance
2. Resumen de decisiones vigentes (D1-D10)
3. Arquitectura general del sistema
4. Estructura del repositorio
5. Especificación del Juez (Fase 1)
6. Base de datos: esquema completo (Fase 2)
7. Cola de trabajos: diseño Redis (Fase 2)
8. API REST: contrato de endpoints (Fase 2-4)
9. Tiempo real: catálogo de eventos WebSocket (Fase 3)
10. Sincronización Yjs y capa de difuminado (Fase 3)
11. Máquina de estados y modos de juego (Fase 3-4)
12. Frontend: mapa de pantallas y componentes (Fase 4)
13. Desglose semanal de tareas con criterios de aceptación
14. Estrategia de pruebas
15. Despliegue: local y VPS
16. Runbook del evento de campus
17. Métricas e instrumentación
18. Registro de riesgos
19. Roadmap post-MVP (v1.5 y v2)

---

## 1. Visión y alcance

**DueloDev** es una plataforma web en español donde programadores se enfrentan en tiempo real resolviendo el mismo problema lógico, viendo la actividad del rival en vivo (editor difuminado, cursor, errores, tests pasados), con modos de juego tipo videojuego.

**Alcance del MVP (lo que SÍ entra):** duelos 1v1 y salas de 2-3 jugadores; modos Puntos y Rondas; lenguajes Python/C++/Java; visor difuminado con revelado voluntario; cuentas de anfitrión + invitados con gamertag; juez aislado con Docker; 18 problemas en 4 categorías; evento de campus como validación.

**Fuera del MVP (v1.5/v2):** power-ups y ataques, ranking ELO, Battle Royale 3-5+ con minimapa Canvas, protocolo binario MessagePack, paths de aprendizaje, monetización.

---

## 2. Resumen de decisiones vigentes

| ID  | Decisión          | Resumen                                                                                                                                                                                                           |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Victoria y modos  | Híbrido (primer Accepted; desempate por casos pasados). Modos: **Rondas** (gauntlet secuencial) y **Puntos** (un problema a la vez, punto al más rápido). Arquitectura de modos enchufables (Strategy).           |
| D2  | Visor rival       | Difuminado por defecto (blur en cliente), actividad nítida, toggle "mostrar mi tablero", anti-copia (sin selección/copy en panel rival, sin paste en editor propio durante partida), revelado total post-partida. |
| D3  | Lenguajes         | Python 3.12, C++ (g++ -O2 c++17), Java (OpenJDK 21). Multiplicadores de tiempo ×3/×1/×2.                                                                                                                          |
| D4  | Identidad         | Anfitrión registrado (email u OAuth Google); invitado con link + gamertag; conversión post-partida; purga de guests a 30 días.                                                                                    |
| D5  | Feedback del juez | Veredicto + conteo `N/M casos`. Nunca se muestran los casos ocultos. Se ejecutan todos los casos (salvo Compilation Error).                                                                                       |
| D6  | Problemas         | 18 problemas adaptados de fuentes abiertas (enunciados reescritos): 5 muy fácil, 6 fácil, 5 fácil-medio, 2 difícil.                                                                                               |
| D7  | Límites del juez  | 1 envío/10 s por jugador; 2 s base C++; 256 MB RAM; 1 CPU; salida 1 MB; pids 64; sin red; 3 workers.                                                                                                              |
| D8  | Infraestructura   | Desarrollo local (Docker Compose, $0); VPS 4 vCPU/8 GB solo para el evento (~$30 USD/mes); presupuesto validación < $50 USD.                                                                                      |
| D9  | Cronograma        | 12 semanas, 35-40 h/semana. Regla de recorte: pulido visual → modo Rondas → problemas difíciles. Nunca: seguridad, anti-copia, estabilidad.                                                                       |
| D10 | Nombre            | **DueloDev**. Dominio preferente `duelo.dev`; alternos `duelodev.dev` / `.pro` / `.io`. Verificar renovaciones e IMPI.                                                                                            |

---

## 3. Arquitectura general del sistema

### 3.1 Componentes

```
┌─────────────────────────────── NAVEGADOR ───────────────────────────────┐
│  Next.js 14 (App Router) + Monaco Editor + y-monaco + socket.io-client │
│  • Editor propio (escritura)  • Panel rival (readOnly + blur CSS)      │
└──────────┬──────────────────────────────────────┬───────────────────────┘
           │ HTTPS REST (auth, salas, envíos)     │ WSS (Yjs deltas + eventos de partida)
           ▼                                      ▼
┌──────────────────────┐              ┌────────────────────────────┐
│  API Backend         │              │  Realtime Server           │
│  Node.js + Fastify   │◄────────────►│  Node.js + Socket.io       │
│  (REST + auth JWT)   │  Redis Pub/  │  + y-websocket provider    │
│                      │  Sub interno │  + GameMode StateMachine   │
└─────┬────────┬───────┘              └────────────┬───────────────┘
      │        │                                   │
      │        │ LPUSH judge:queue                 │ SUBSCRIBE judge:results
      ▼        ▼                                   │
┌──────────┐ ┌─────────────────┐                  │
│PostgreSQL│ │ Redis 7         │◄─────────────────┘
│ 16       │ │ • cola de juez  │
└──────────┘ │ • pub/sub       │
             │ • rate limiting │
             └───────┬─────────┘
                     │ BRPOP judge:queue
                     ▼
        ┌────────────────────────────┐
        │  Judge Workers ×3 (Python) │
        │  docker run ubuntu-judge   │
        │  cgroups·seccomp·sin red   │
        └────────────────────────────┘
```

### 3.2 Justificación de cada elección

- **Fastify sobre Express:** ~2× más rápido en JSON, validación de esquemas integrada (útil para el contrato de la sección 8). Alternativa aceptable: Express si hay más familiaridad — la decisión no es estructural.
- **API y Realtime como procesos separados:** el servidor de WebSockets tiene ciclo de vida distinto (conexiones largas) y así un deploy del API no tira las partidas en curso. En dev corren en el mismo Compose; en el VPS son dos contenedores.
- **Redis triple uso:** cola del juez (lista), notificación de resultados (pub/sub) y rate limiting (INCR con TTL). Un solo servicio, tres patrones.
- **Workers en Python:** manipulan la API de Docker (docker-py), archivos temporales y comparación de salidas. Python es el mejor pegamento para esto y ya lo dicta el documento arquitectónico original.

---

## 4. Estructura del repositorio (monorepo)

```
duelodev/
├── docker-compose.yml            # postgres + redis + api + realtime + workers
├── docker-compose.prod.yml       # overrides para el VPS (recursos, restart, TLS)
├── .env.example
├── README.md
├── docs/                         # este plan, decisiones, runbook del evento
│
├── judge/                        # FASE 1
│   ├── Dockerfile.judge          # imagen ubuntu-judge (g++, python3, openjdk)
│   ├── worker.py                 # loop BRPOP → ejecutar → publicar resultado
│   ├── executor.py               # orquestación del contenedor por envío
│   ├── verdicts.py               # enum y lógica de comparación de salidas
│   ├── limits.py                 # constantes de D7 (única fuente de verdad)
│   ├── seccomp-profile.json      # perfil de syscalls permitidas
│   └── tests/                    # suite de abuso (fork bomb, OOM, red, etc.)
│
├── api/                          # FASE 2
│   ├── src/
│   │   ├── routes/               # auth, rooms, submissions, problems, users
│   │   ├── plugins/              # jwt, postgres, redis, rate-limit
│   │   ├── services/             # lógica de negocio
│   │   └── schemas/              # validación JSON Schema de cada endpoint
│   ├── migrations/               # SQL versionado (node-pg-migrate)
│   └── seeds/                    # problemas y casos de prueba
│
├── realtime/                     # FASE 3
│   ├── src/
│   │   ├── server.ts             # Socket.io + y-websocket
│   │   ├── rooms.ts              # ciclo de vida de salas
│   │   ├── gamemodes/
│   │   │   ├── GameMode.ts       # interfaz Strategy (D1)
│   │   │   ├── PuntosMode.ts
│   │   │   └── RondasMode.ts
│   │   └── events.ts             # catálogo tipado (sección 9)
│
├── web/                          # FASE 4
│   ├── app/                      # rutas Next.js (sección 12)
│   ├── components/
│   │   ├── editor/               # OwnEditor, RivalPanel (blur), RevealToggle
│   │   ├── match/                # Timer, Scoreboard, VerdictBadge, ResultScreen
│   │   └── lobby/                # RoomCreator, JoinGate, GamertagInput
│   └── lib/                      # cliente socket, cliente API, hooks
│
└── problems/                     # FASE 0/10 — fuente de verdad del contenido
    └── {slug}/
        ├── statement.es.md       # enunciado reescrito en español
        ├── meta.json             # categoría, límites, licencia de origen
        ├── cases/                # 01.in/01.out ... 12.in/12.out (ocultos)
        ├── examples/             # ejemplos visibles (2)
        └── solutions/            # ref.py, ref.cpp, ref.java (validan límites)
```

**Por qué monorepo:** una sola persona, un solo flujo de versiones, y `docker-compose up` levanta todo. Separar repos es fricción sin beneficio a esta escala.

---

## 5. Especificación del Juez (Fase 1)

### 5.1 Imagen `ubuntu-judge`

```dockerfile
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    g++-13 python3.12 openjdk-21-jdk-headless time \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1500 -s /usr/sbin/nologin runner
USER runner
WORKDIR /box
```

Claves: usuario **no root** (`runner`), sin shell de login, directorio de trabajo `/box` que se monta como tmpfs por ejecución.

### 5.2 Pipeline de un envío

```
1. Worker toma job de Redis (BRPOP judge:queue)
2. Crea dir temporal /tmp/job-{uuid}/ con:
      main.{py|cpp|java}  ← código del usuario
      cases/              ← copiados desde el problema
3. FASE COMPILAR (C++/Java; Python la salta):
      docker run --rm --network=none --cpus=1.0 --memory=256m
        --pids-limit=64 --read-only --tmpfs /box:size=64m
        --security-opt seccomp=seccomp-profile.json
        -v /tmp/job-{uuid}:/src:ro  ubuntu-judge
        <comando de compilación, timeout 10s/15s>
      → si falla: veredicto COMPILATION_ERROR (stderr truncado a 4 KB al usuario)
4. FASE EJECUTAR (por cada caso i de 1..M):
      mismo docker run, stdin ← cases/i.in, stdout capturado
      timeout = base × multiplicador (D3/D7), medido con wall clock + margen
      → TLE si excede tiempo · MLE/RE si OOM-kill o exit≠0 · OLE si stdout>1MB
5. COMPARAR: normalizar (trim trailing whitespace por línea, newline final)
      salida == esperado → caso pasado
6. VEREDICTO GLOBAL:
      todos pasan → ACCEPTED
      si no → el veredicto del primer caso fallado + conteo passed/total (D5)
7. Worker publica en Redis: PUBLISH judge:results {submission_id, verdict,
      passed, total, time_ms, compile_output?}
8. Worker persiste en PostgreSQL (tabla submissions) y borra /tmp/job-{uuid}
```

### 5.3 Veredictos (enum canónico)

| Código | Nombre                | Condición                                   |
| ------ | --------------------- | ------------------------------------------- |
| `AC`   | Accepted              | Todos los casos pasan                       |
| `WA`   | Wrong Answer          | Salida difiere en ≥1 caso                   |
| `TLE`  | Time Limit Exceeded   | Excede tiempo en ≥1 caso                    |
| `MLE`  | Memory Limit Exceeded | OOM-kill del kernel                         |
| `RE`   | Runtime Error         | Exit code ≠ 0                               |
| `CE`   | Compilation Error     | Falla compilación                           |
| `OLE`  | Output Limit Exceeded | stdout > 1 MB                               |
| `SE`   | System Error          | Fallo interno del juez (se reintenta 1 vez) |

### 5.4 Perfil seccomp

Punto de partida: el perfil **default de Docker** (ya bloquea `mount`, `reboot`, `ptrace` peligrosos, etc.) endurecido quitando de la lista de permitidas: `socket`, `connect`, `bind`, `listen` (defensa en profundidad junto a `--network=none`). No bloquear `clone`/`fork` a nivel seccomp para Java (la JVM crea hilos); el control real de procesos es `--pids-limit=64`.

### 5.5 Checklist de auditoría (obligatoria al cierre de la Fase 1)

- [ ] Fork bomb (`:(){ :|:& };:` traducida a cada lenguaje) → muere por pids-limit, host estable.
- [ ] Ciclo infinito → TLE en tiempo esperado ±10%.
- [ ] Reserva de RAM gigante → MLE por OOM, no swap del host (`--memory-swap` igualado).
- [ ] `import socket; connect(...)` / `new Socket(...)` → falla (sin red).
- [ ] Escritura fuera de `/box` → falla (`--read-only` + tmpfs).
- [ ] Lectura de `/etc/passwd`, variables de entorno del host → no expone nada sensible.
- [ ] Salida de 100 MB → OLE, sin llenar disco.
- [ ] 50 envíos consecutivos → cero contenedores zombis (`docker ps -a` limpio), cero fugas en /tmp.
- [ ] El worker sobrevive a un job corrupto (JSON inválido) sin morir.

---

## 6. Base de datos: esquema completo (Fase 2)

```sql
-- users: registrados e invitados (D4)
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL CHECK (type IN ('registered','guest')),
  email         TEXT UNIQUE,                 -- NULL para guests
  password_hash TEXT,                        -- argon2id; NULL si OAuth o guest
  oauth_google  TEXT UNIQUE,
  gamertag      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  CONSTRAINT registered_has_credentials CHECK (
    type = 'guest' OR email IS NOT NULL OR oauth_google IS NOT NULL)
);
CREATE INDEX idx_users_guest_purge ON users (created_at) WHERE type='guest';

-- problems y casos ocultos (D5, D6)
CREATE TABLE problems (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT UNIQUE NOT NULL,
  title        TEXT NOT NULL,
  statement_md TEXT NOT NULL,               -- enunciado en español
  category     TEXT NOT NULL CHECK (category IN
               ('muy_facil','facil','facil_medio','dificil')),
  time_limit_ms  INT NOT NULL DEFAULT 2000, -- base C++ (D7)
  source_license TEXT,                      -- trazabilidad D6
  is_active    BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE test_cases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id  UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  ordinal     INT NOT NULL,
  input       TEXT NOT NULL,
  expected    TEXT NOT NULL,
  is_example  BOOLEAN NOT NULL DEFAULT false,  -- true = visible al jugador
  UNIQUE (problem_id, ordinal)
);
-- Regla dura: la API JAMÁS serializa test_cases con is_example=false.

-- matches y participantes (D1)
CREATE TABLE matches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code   TEXT UNIQUE NOT NULL,          -- 6 chars, el del link
  mode        TEXT NOT NULL CHECK (mode IN ('puntos','rondas')),
  status      TEXT NOT NULL DEFAULT 'lobby'
              CHECK (status IN ('lobby','running','finished','abandoned')),
  config      JSONB NOT NULL,   -- {num_problems, time_per_problem_s, categories,...}
  problem_ids UUID[] NOT NULL DEFAULT '{}',
  created_by  UUID NOT NULL REFERENCES users(id),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  winner_id   UUID REFERENCES users(id)
);

CREATE TABLE match_players (
  match_id    UUID REFERENCES matches(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id),
  score       INT NOT NULL DEFAULT 0,        -- puntos o problemas resueltos
  cases_total INT NOT NULL DEFAULT 0,        -- para desempate (D1/D5)
  time_total_ms BIGINT NOT NULL DEFAULT 0,   -- segundo desempate
  reveal_board  BOOLEAN NOT NULL DEFAULT false,  -- toggle D2
  PRIMARY KEY (match_id, user_id)
);

-- submissions: cada envío al juez
CREATE TABLE submissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id    UUID REFERENCES matches(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  problem_id  UUID NOT NULL REFERENCES problems(id),
  language    TEXT NOT NULL CHECK (language IN ('python','cpp','java')),
  source_code TEXT NOT NULL,
  verdict     TEXT,             -- NULL = en cola/juzgando
  cases_passed INT,
  cases_total  INT,
  exec_time_ms INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  judged_at   TIMESTAMPTZ
);
CREATE INDEX idx_submissions_match ON submissions (match_id, user_id, created_at);
```

**Notas de diseño:** `config JSONB` en matches evita migraciones por cada parámetro nuevo de modo de juego (clave para v1.5). `problem_ids` como array congela el set de problemas de la partida al iniciarla (reproducibilidad). `cases_total` y `time_total_ms` en `match_players` materializan los desempates de D1 sin recalcular.

---

## 7. Cola de trabajos: diseño Redis (Fase 2)

| Estructura        | Clave                          | Patrón                                                                                  |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| Cola del juez     | `judge:queue`                  | API hace `LPUSH` con JSON del job; workers hacen `BRPOP` (bloqueante, distribuye solo). |
| Resultados        | `judge:results` (canal)        | Worker publica; Realtime está suscrito y reenvía al room del match.                     |
| Rate limit envíos | `rl:submit:{user_id}`          | `INCR` + `EXPIRE 10`; si valor > 1 → 429 (D7: 1 envío/10 s).                            |
| Job en proceso    | `judge:processing:{worker_id}` | Copia del job actual; si el worker muere, un reaper lo reencola (at-least-once).        |

**Formato del job:**

```json
{
  "submission_id": "uuid",
  "match_id": "uuid",
  "user_id": "uuid",
  "problem_id": "uuid",
  "language": "cpp",
  "source_code": "...",
  "time_limit_ms": 2000,
  "enqueued_at": 1753900000
}
```

**Idempotencia:** el worker, antes de juzgar, verifica que `submissions.verdict IS NULL`; si ya hay veredicto (reencolado duplicado), descarta. Esto hace seguro el modelo at-least-once.

---

## 8. API REST: contrato de endpoints

Prefijo `/api/v1`. Auth: JWT (access 15 min + refresh 7 días) en cookie httpOnly. Los invitados reciben un JWT de tipo `guest` limitado a su match.

| Método y ruta               | Auth             | Descripción                                                                         | Respuesta clave         |
| --------------------------- | ---------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| `POST /auth/register`       | —                | email+password (argon2id) o inicio OAuth                                            | 201 + cookies           |
| `POST /auth/login`          | —                | credenciales                                                                        | 200 + cookies           |
| `POST /auth/refresh`        | refresh          | rota tokens                                                                         | 200                     |
| `POST /rooms`               | registered       | crea sala: `{mode, num_problems, categories, time_per_problem_s, max_players(2-3)}` | `{room_code, join_url}` |
| `POST /rooms/{code}/join`   | —                | invitado: `{gamertag}` → crea user guest + JWT guest                                | `{token, match_id}`     |
| `GET /rooms/{code}`         | any              | estado del lobby (jugadores, config)                                                |                         |
| `POST /rooms/{code}/start`  | creador          | congela `problem_ids`, status→running, avisa a Realtime                             |                         |
| `POST /submissions`         | player del match | `{match_id, problem_id, language, source_code}` → valida rate limit → encola        | 202 `{submission_id}`   |
| `GET /submissions/{id}`     | dueño            | estado/veredicto (fallback si se cae el WS)                                         |                         |
| `GET /problems/{id}/public` | player del match | enunciado + SOLO ejemplos (`is_example=true`)                                       |                         |
| `POST /users/convert`       | guest            | `{email, password}` → promociona guest a registered conservando historial (D4)      |                         |
| `GET /matches/{id}/summary` | player           | resultado final + códigos revelados (D2 post-partida)                               |                         |

**Validación:** todo endpoint declara JSON Schema (Fastify lo aplica automático). `source_code` máx. 64 KB. `gamertag` 3-20 chars alfanuméricos + guion.

---

## 9. Tiempo real: catálogo de eventos WebSocket (Fase 3)

Namespace `/match`, room de Socket.io = `match:{id}`. El cliente se autentica en el handshake con su JWT.

**Cliente → Servidor**

| Evento          | Payload           | Notas                                      |
| --------------- | ----------------- | ------------------------------------------ |
| `join_match`    | `{match_id}`      | valida JWT y pertenencia                   |
| `toggle_reveal` | `{visible: bool}` | D2; actualiza `match_players.reveal_board` |
| `ready`         | `{}`              | lobby: marca listo                         |

**Servidor → Clientes del room**

| Evento                | Payload                                            | Cuándo                                                                                                                                   |
| --------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `match_started`       | `{mode, problem_order, config, server_time}`       | al POST /start                                                                                                                           |
| `problem_begin`       | `{problem_id, index, ends_at}`                     | inicio de cada problema/ronda (el server manda `ends_at` absoluto: el cronómetro se calcula contra reloj de servidor, nunca del cliente) |
| `submission_received` | `{user_id}`                                        | rival ve "está juzgando..."                                                                                                              |
| `verdict`             | `{user_id, submission_id, verdict, passed, total}` | reenvío de `judge:results`; el detalle de compilación solo va al dueño                                                                   |
| `score_update`        | `{scores: [{user_id, score, cases_total}]}`        | tras cada veredicto relevante                                                                                                            |
| `reveal_changed`      | `{user_id, visible}`                               | toggle D2                                                                                                                                |
| `player_status`       | `{user_id, status: connected\|disconnected}`       | reconexión con gracia de 60 s                                                                                                            |
| `match_finished`      | `{winner_id, final_scores, summary_url}`           | condición de victoria del modo                                                                                                           |

**Yjs viaja aparte** por el provider `y-websocket` en el path `/yjs/{match_id}/{user_id}` — un documento Yjs **por jugador** (su editor), al que los rivales se conectan en solo-lectura. Separar Yjs de los eventos de partida evita que un burst de tecleo retrase un veredicto.

---

## 10. Sincronización Yjs y capa de difuminado (Fase 3)

1. **Documento por jugador:** `ydoc_{user_id}` con un `Y.Text` enlazado a Monaco vía `y-monaco` (MonacoBinding). El dueño escribe; los demás montan un Monaco `readOnly:true` enlazado al mismo doc.
2. **Awareness de Yjs** transporta posición de cursor y selección → el panel rival muestra el cursor nítido encima del texto difuminado (la "actividad" de D2).
3. **Difuminado (solo presentación):** contenedor del panel rival con clase `.rival-blurred` → `filter: blur(6px)` aplicado al layer de texto de Monaco (`.view-lines`), dejando sin blur la capa de cursores y las decoraciones de número de línea. Al recibir `reveal_changed{visible:true}` se quita la clase (transición CSS 200 ms).
4. **Anti-copia (D2), implementación concreta:**
   - Panel rival: `user-select:none`; listeners que cancelan `copy`, `cut`, `contextmenu`; Monaco con `contextmenu:false`.
   - Editor propio en partida: interceptar `onKeyDown` Ctrl/Cmd+V y el evento `paste` del DOM → `preventDefault()` + toast "Pegar está deshabilitado durante la partida".
   - Riesgo residual documentado (dev tools sobre el ydoc): aceptado para MVP; mitigación futura = difuminado en servidor (v2 torneos).
5. **Persistencia:** los ydocs viven en memoria del Realtime durante la partida; al `match_finished`, el texto final se persiste como snapshot en `submissions`/`matches` para la pantalla de revelado, y los docs se destruyen.

---

## 11. Máquina de estados y modos de juego (Fases 3-4)

### 11.1 Estados de una partida

```
LOBBY ──start──▶ RUNNING ──condición de victoria──▶ FINISHED
  │                 │
  └──sin quorum──▶ ABANDONED ◀──todos desconectados >60s──┘
```

### 11.2 Interfaz Strategy (D1)

```typescript
interface GameMode {
  onMatchStart(ctx: MatchContext): void; // define problema(s) inicial(es)
  onVerdict(ctx: MatchContext, v: Verdict): ModeAction[];
  onProblemTimeout(ctx: MatchContext): ModeAction[];
  checkVictory(ctx: MatchContext): VictoryResult | null;
}
// ModeAction: AdvancePlayer | AdvanceAll | AwardPoint | EmitEvent | EndMatch
```

### 11.3 Reglas exactas por modo

**PuntosMode:** todos ven el problema `i`. Primer `AC` → `AwardPoint` + `AdvanceAll` al problema `i+1`. Si expira `time_per_problem_s` sin AC → punto desierto (o al que más casos pasó, configurable en `config`) + `AdvanceAll`. Victoria: fin de la lista → mayor score; empates → `cases_total`, luego `time_total_ms`.

**RondasMode:** cada jugador tiene su propio índice de problema. `AC` de un jugador → `AdvancePlayer` (solo él avanza). Victoria: primero en llegar al hito (`config.target`: 3/6/9/10) o, al expirar el tiempo global, quien tenga más resueltos; mismos desempates.

**Regla transversal (D5):** un `AC` posterior del mismo jugador al mismo problema no re-puntúa; los `cases_passed` del mejor intento son los que suman a `cases_total`.

---

## 12. Frontend: mapa de pantallas (Fase 4)

| Ruta                          | Pantalla       | Componentes clave                                                                                                                                                                                                                                                      |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                           | Landing        | CTA "Crear sala" / "Tengo un link", explicación en 3 pasos                                                                                                                                                                                                             |
| `/registro`, `/entrar`        | Auth           | forms + OAuth Google                                                                                                                                                                                                                                                   |
| `/sala/nueva`                 | Config de sala | selector de modo, nº problemas, categorías, tiempo, jugadores (2-3)                                                                                                                                                                                                    |
| `/sala/{code}`                | Lobby          | lista de jugadores, JoinGate (gamertag si invitado), botón Iniciar (solo creador), copiar link                                                                                                                                                                         |
| `/duelo/{match_id}`           | **Partida**    | layout dividido: `OwnEditor` (60%) + `RivalPanel(s)` (40%); `Timer` (contra `ends_at` del server), `Scoreboard`, `VerdictBadge` (AC/WA 7/10...), selector de lenguaje, botón Ejecutar (con cooldown visual de 10 s), `RevealToggle`, enunciado colapsable con ejemplos |
| `/duelo/{match_id}/resultado` | Post-partida   | ganador, tabla final, códigos revelados lado a lado, CTA de conversión guest→cuenta (D4), "Revancha" (crea sala nueva con misma config)                                                                                                                                |

**Detalles de UX que son requisitos, no adornos:** el cronómetro se deriva de `ends_at` (hora de servidor) para inmunidad a relojes locales; el botón Ejecutar muestra el cooldown de D7 como anillo de progreso (convierte el rate limit en mecánica visible, no en error); estado "juzgando..." con spinner en el propio panel y en el del rival (`submission_received`) — esa tensión de "ya envió" es parte del espectáculo.

---

## 13. Desglose semanal de tareas con criterios de aceptación

> 35-40 h/semana (D9). Cada semana cierra con su criterio verificable; si no se cumple, se aplica la regla de recorte antes de avanzar.

**Semana 0 (paralela, ~10 h repartidas):** redactar reglas de ambos modos en una página · elegir los 18 conceptos de problemas y sus fuentes/licencias · comprar dominio (orden D10) · crear repo con la estructura de la sección 4 y el compose base (postgres+redis).
✔️ _Criterio:_ `docker compose up` levanta postgres y redis; lista de 18 problemas con fuente y licencia anotada.

**Semanas 1-2 — Juez:**

- S1: Dockerfile `ubuntu-judge` · `limits.py` · `executor.py` (compilar+ejecutar 1 caso, C++ primero, luego Python y Java) · comparación normalizada de salidas.
- S2: bucle multi-caso y veredictos completos · perfil seccomp · `worker.py` con BRPOP+idempotencia · **suite de abuso completa (checklist 5.5)**.
  ✔️ _Criterio:_ los 9 puntos del checklist pasan; un envío por CLI devuelve veredicto correcto en los 3 lenguajes.

**Semanas 3-4 — Persistencia y API:**

- S3: migraciones del esquema (sección 6) · seeds con 3 problemas de prueba · auth (register/login/refresh/argon2id/JWT) · endpoints de rooms.
- S4: `POST /submissions` con rate limit Redis · integración worker↔Postgres · `judge:results` publicándose · pruebas de concurrencia: 10 envíos simultáneos, 3 workers, cero pérdidas.
  ✔️ _Criterio:_ con `curl` se crea sala, se une invitado, se envía código y llega el veredicto persistido; el rate limit responde 429 correctamente.

**Semanas 5-6 — Tiempo real:**

- S5: servidor Socket.io con auth por JWT · rooms y eventos de lobby · suscripción a `judge:results` → evento `verdict` al room · y-websocket con un doc por jugador.
- S6: y-monaco en un cliente HTML mínimo (aún sin Next) · capa blur + awareness de cursores · `toggle_reveal` de punta a punta · reconexión con gracia de 60 s.
  ✔️ _Criterio:_ dos navegadores en la misma sala: A escribe, B ve texto difuminado y cursor nítido en <300 ms; A activa revelar y B lo ve legible; A recarga la página y se reincorpora.

**Semanas 7-8 — Frontend + PuntosMode:**

- S7: Next.js con auth, landing, crear sala, lobby con link e invitados · esqueleto de `/duelo` con Monaco propio + panel rival conectados a lo de S6.
- S8: `PuntosMode` completo en el Realtime (máquina de estados) · Timer contra `ends_at` · Scoreboard · VerdictBadge · botón Ejecutar con cooldown · pantalla de resultado con revelado y conversión de guest.
  ✔️ _Criterio:_ **primer duelo real completo** en modo Puntos entre dos máquinas distintas, de lobby a pantalla de ganador, sin tocar la consola.

**Semana 9 — RondasMode:** implementar sobre la misma interfaz Strategy · UI de progreso individual (barra "3/10") · sala de 3 jugadores probada en ambos modos.
✔️ _Criterio:_ los dos modos funcionan con 2 y con 3 jugadores; escribir RondasMode NO requirió tocar el núcleo de salas (prueba de la arquitectura D1).

**Semana 10 — Contenido y endurecimiento:** cargar los 18 problemas con casos y soluciones de referencia (las soluciones validan los límites de tiempo en los 3 lenguajes) · prueba de carga: 10 salas simuladas con bots de tecleo + envíos · corregir cuellos de botella · logging estructurado.
✔️ _Criterio:_ 18 problemas juegan bien; bajo carga, latencia Yjs <300 ms y espera de juez <60 s p95.

**Semana 11 — Beta cerrada + despliegue:** VPS con `compose.prod` + Caddy/TLS · beta con 4-6 amigos remotos, ambos modos · triage y corrección de todo lo bloqueante · congelar features.
✔️ _Criterio:_ una noche de beta sin caídas de sala ni del juez; backlog clasificado en "antes del evento" vs "después".

**Semana 12 — Evento:** ejecutar el runbook (sección 16).

---

## 14. Estrategia de pruebas

| Capa           | Herramienta                       | Qué cubre                                                                                   |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| Juez (crítico) | pytest + suite de abuso 5.5       | seguridad, veredictos, límites; corre en cada cambio del juez                               |
| API            | vitest + supertest                | contrato de cada endpoint, auth, rate limit, "nunca filtrar casos ocultos" (test explícito) |
| Modos de juego | vitest unitario                   | `checkVictory` y desempates con tablas de casos (la lógica de D1 en puro, sin sockets)      |
| Tiempo real    | script de bots (socket.io-client) | N clientes tecleando + enviando; mide latencias                                             |
| E2E            | Playwright (2 contextos)          | flujo completo: crear sala → invitado → duelo → resultado                                   |
| Carga          | los bots de arriba ×10 salas      | semana 10                                                                                   |

Prioridad honesta para una persona: **el juez al 100% de cobertura de abuso; modos de juego unitarios completos; E2E solo el camino feliz.** El resto, pruebas manuales guiadas por checklist.

---

## 15. Despliegue

**Local:** `docker compose up` levanta todo; `web` en modo dev con hot reload fuera de Docker si se prefiere velocidad.

**VPS (evento):**

1. Ubuntu 24.04, usuario no root con SSH por llave, `ufw` solo 22/80/443, fail2ban.
2. Docker + Compose; clonar repo; `.env` de producción (secretos generados, no los de dev).
3. `docker-compose.prod.yml`: `restart: unless-stopped`, límites de memoria por servicio, workers=3, Postgres con volumen y backup diario (`pg_dump` a cron + copia fuera del VPS).
4. Caddy como reverse proxy: TLS automático para `duelo.dev` → `web`, `/api` → API, `/socket.io` y `/yjs` → Realtime (websockets habilitados).
5. Smoke test post-deploy: duelo completo desde dos redes distintas (una con datos móviles).

**Regla D8:** este VPS no contiene nada más. Se destruye o reinstala después del evento.

---

## 16. Runbook del evento de campus (Semana 12)

**T-7 días:** confirmar espacio, wifi (probar latencia real del campus al VPS), proyector para partidas estelares; abrir registro previo (formulario simple) para estimar asistencia; preparar bracket del torneo (llaves de 8-16) + zona de salas casuales libres.

**T-1 día:** deploy congelado + smoke test; snapshot del VPS; cargar los 18 problemas verificados; imprimir QR del link; definir MC (alguien narra las finales — el formato espectáculo se narra, como en TETR.IO).

**Día del evento:**

- Formato sugerido (2.5 h): 30 min registro/salas casuales libres → torneo modo Puntos, llaves 1v1, problemas fácil/fácil-medio, 10 min por ronda → final en proyector con problemas fácil-medio/difícil narrada por el MC → premiación simbólica.
- Operación: el fundador NO compite; monitorea `docker stats`, logs y la cola (`LLEN judge:queue`) en una laptop.
- **Plan B por fallo:** VPS caído → restaurar snapshot (10 min, el MC entretiene); juez saturado → subir workers a 5 en caliente (`docker compose up -d --scale worker=5`); wifi del campus caído → hotspot móvil para el proyector y salas reducidas.

**T+7 días:** enviar a los asistentes el resumen con sus partidas + CTA de cuenta; medir los criterios de éxito; retro escrita de 1 página (qué falló, qué sorprendió, qué pidió la gente) → alimenta el plan v1.5.

**Criterios de éxito (heredados):** 0 incidentes de seguridad · duelos completos en ambos modos sin caída · latencia visor <300 ms · ≥30% juega otra partida en 7 días · ≥25% de invitados convierten a cuenta.

---

## 17. Métricas e instrumentación

Tabla `events` simple en Postgres (`user_id, type, payload JSONB, created_at`) — sin herramientas externas en el MVP. Eventos mínimos: `room_created`, `guest_joined`, `match_started`, `submission`, `match_finished`, `guest_converted`, `reveal_toggled` (¿la gente usa el toggle? dato de diseño valioso). Dashboard: 5 queries SQL guardadas, no más.

---

## 18. Registro de riesgos (vivo)

| #   | Riesgo                          | Prob. | Impacto | Mitigación                                                                            | Disparador de alerta                     |
| --- | ------------------------------- | ----- | ------- | ------------------------------------------------------------------------------------- | ---------------------------------------- |
| R1  | Escape/abuso del sandbox        | Media | Crítico | Sección 5 completa + checklist 5.5 + VPS desechable                                   | cualquier proceso no esperado en el host |
| R2  | Copia entre rivales             | Alta  | Alto    | D2 (blur + anti-paste); riesgo residual aceptado y documentado                        | quejas en beta/evento                    |
| R3  | Atraso de cronograma            | Alta  | Alto    | criterios semanales + regla de recorte D9                                             | 2 criterios semanales fallados seguidos  |
| R4  | Cola saturada en evento         | Media | Medio   | escalar workers en caliente; cooldown 10 s                                            | `LLEN judge:queue` > 15                  |
| R5  | Wifi del campus                 | Media | Medio   | plan B del runbook                                                                    | ping al VPS > 200 ms sostenido           |
| R6  | Licencias de problemas          | Baja  | Medio   | enunciados 100% reescritos + registro por problema en `meta.json`                     | —                                        |
| R7  | Burnout (una persona, 40 h/sem) | Media | Alto    | los criterios semanales son también permiso de parar: si la semana cerró, se descansa | dos semanas sin cerrar criterio          |

---

## 19. Roadmap post-MVP

**v1.5 (semanas 13-18, condicionado a métricas del evento):** power-ups sobre la máquina de estados (`ModeAction` ya lo soporta): _pista adicional_, _código a la mitad_; ataques: _cambio de lenguaje repentino_, _sin ejemplos_, _sin pistas_ — cada uno es un evento del catálogo + regla en el modo, no un rediseño. Ranking ELO simple por modo. Java entra si quedó fuera. Historial y perfil público.

**v2 (trimestre siguiente):** Battle Royale 3-5+ → minimapa Canvas alimentado por eventos discretos de actividad (no por Yjs completo) + serialización MessagePack del canal de eventos (aquí sí aplica el protocolo tipo Ribbon del documento arquitectónico — antes de 4+ jugadores es optimización prematura). Difuminado en servidor para torneos con premio. Piloto B2B con la universidad del evento.

**Norte de monetización (del análisis del Inversionista):** B2B universitario → freemium (ranking/cosméticos/paths) → torneos patrocinados por empresas reclutadoras.

---

_Fin del documento. Toda modificación a D1-D10 requiere actualizar la sección 2 y la fecha de versión._
