'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACTIVE_PROBLEM_CATEGORIES, PROBLEM_CATEGORY_LABELS } from '@duelodev/shared';
import type {
  AdminPlayerSummary,
  AdminRankingEntry,
  AdminRoomSummary,
  CreateRoomRequest,
  ActiveProblemCategory,
  MatchStatus,
  UserProfile,
} from '@duelodev/shared';
import { api, ApiClientError } from '@/lib/api';

const defaultConfig: CreateRoomRequest = {
  config: {
    mode: 'puntos',
    max_players: 2,
    num_problems: 3,
    categories: ['facil', 'facil_medio', 'dificil'],
    time_per_problem_s: 300,
  },
};

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) return error.data.error.message;
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function playerLabel(player: AdminPlayerSummary): string {
  return player.email ? `${player.gamertag} · ${player.email}` : player.gamertag;
}

function isActiveRoom(room: AdminRoomSummary): boolean {
  return room.status === 'lobby' || room.status === 'running' || room.status === 'settling';
}

type RoomStatusFilter = 'all' | MatchStatus;

const roomStatusLabels: Record<RoomStatusFilter, string> = {
  all: 'Todos los estados',
  lobby: 'Lobby',
  running: 'En curso',
  settling: 'Resolviendo',
  finished: 'Finalizadas',
  abandoned: 'Cerradas',
};

export default function AdminPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [rooms, setRooms] = useState<AdminRoomSummary[]>([]);
  const [ranking, setRanking] = useState<AdminRankingEntry[]>([]);
  const [players, setPlayers] = useState<
    Array<AdminPlayerSummary & { match_id: string; room_code: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [config, setConfig] = useState(defaultConfig);
  const [winnerSelections, setWinnerSelections] = useState<Record<string, string[]>>({});
  const [roomStatusFilter, setRoomStatusFilter] = useState<RoomStatusFilter>('all');
  const [registeredUsersCanCreateRooms, setRegisteredUsersCanCreateRooms] = useState(true);

  const activeRooms = rooms.filter(isActiveRoom);
  const visibleRooms =
    roomStatusFilter === 'all' ? rooms : rooms.filter((room) => room.status === roomStatusFilter);

  const loadAdminData = async () => {
    const [roomsResponse, rankingResponse, playersResponse, roomPolicy] = await Promise.all([
      api.admin.rooms(),
      api.admin.ranking(),
      api.admin.players(),
      api.admin.roomPolicy(),
    ]);
    setRooms(roomsResponse.rooms);
    setRanking(rankingResponse.ranking);
    setPlayers(playersResponse.players);
    setRegisteredUsersCanCreateRooms(roomPolicy.registered_users_can_create_rooms);
  };

  useEffect(() => {
    let active = true;
    void api.auth
      .me()
      .then(async (response) => {
        if (!active) return;
        if (response.user.role !== 'admin') {
          setError('Esta ruta es privada y sólo está disponible para administración.');
          return;
        }
        setUser(response.user);
        await loadAdminData();
      })
      .catch((requestError: unknown) => {
        if (active && !(requestError instanceof ApiClientError && requestError.status === 401)) {
          setError(getErrorMessage(requestError, 'No se pudo validar la sesión administrativa.'));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await api.auth.login({ email, password });
      if (response.user.role !== 'admin') {
        throw new Error('La cuenta no tiene permisos administrativos.');
      }
      setUser(response.user);
      setPassword('');
      await loadAdminData();
    } catch (requestError: unknown) {
      setError(getErrorMessage(requestError, 'No se pudo iniciar sesión.'));
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    try {
      await api.auth.logout();
      setUser(null);
      setRooms([]);
      setRanking([]);
      setPlayers([]);
    } catch (requestError: unknown) {
      setError(getErrorMessage(requestError, 'No se pudo cerrar la sesión.'));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateRoom = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.admin.createRoom(config);
      await loadAdminData();
    } catch (requestError: unknown) {
      setError(getErrorMessage(requestError, 'No se pudo crear la sala.'));
    } finally {
      setBusy(false);
    }
  };

  const handleCloseRoom = async (room: AdminRoomSummary) => {
    if (!window.confirm(`¿Cerrar la sala ${room.room_code}? Se conservará todo su historial.`)) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await api.admin.closeRoom(room.match_id);
      await loadAdminData();
    } catch (requestError: unknown) {
      setError(getErrorMessage(requestError, 'No se pudo cerrar la sala.'));
    } finally {
      setBusy(false);
    }
  };

  const handleCloseAllRooms = async () => {
    if (activeRooms.length === 0) return;
    if (
      !window.confirm(
        `¿Cerrar las ${activeRooms.length} salas activas? Se conservarán jugadores, partidas e historial.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await api.admin.closeAllRooms();
      setWinnerSelections({});
      await loadAdminData();
    } catch (requestError: unknown) {
      setError(getErrorMessage(requestError, 'No se pudieron cerrar las salas activas.'));
    } finally {
      setBusy(false);
    }
  };

  const handleRoomCreationPolicy = async (enabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      const policy = await api.admin.setRoomCreationEnabled(enabled);
      setRegisteredUsersCanCreateRooms(policy.registered_users_can_create_rooms);
    } catch (requestError: unknown) {
      setError(getErrorMessage(requestError, 'No se pudo guardar la política de creación.'));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteRoom = async (room: AdminRoomSummary) => {
    const typedCode = window.prompt(
      `Esta acción elimina la sala ${room.room_code} y sus datos de partida. Escribe el código para confirmar:`,
    );
    if (typedCode?.trim().toUpperCase() !== room.room_code) return;

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.admin.deleteRoom(room.match_id);
      await loadAdminData();
      setNotice(`Sala ${result.room_code} eliminada. El evento de auditoría se conserva.`);
    } catch (requestError: unknown) {
      setError(getErrorMessage(requestError, 'No se pudo eliminar la sala.'));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAllActiveRooms = async () => {
    const confirmation = window.prompt(
      `Se cerrarán y eliminarán todas las salas activas, junto con sus envíos y código. La auditoría mínima se conservará. Escribe BORRAR ACTIVAS para continuar:`,
    );
    if (confirmation !== 'BORRAR ACTIVAS') return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.admin.deleteAllActiveRooms();
      await loadAdminData();
      setNotice(`Se eliminaron ${result.deleted_count} salas activas.`);
    } catch (requestError: unknown) {
      setError(getErrorMessage(requestError, 'No se pudieron eliminar las salas activas.'));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteHistory = async () => {
    const confirmation = window.prompt(
      'Esta acción elimina todos los registros finalizados y abandonados, además de sus envíos y código. La auditoría mínima se conserva. Escribe BORRAR HISTORIAL para continuar:',
    );
    if (confirmation !== 'BORRAR HISTORIAL') return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.admin.deleteAllHistoricalRooms();
      setWinnerSelections({});
      await loadAdminData();
      setNotice(`Se eliminaron ${result.deleted_count} registros históricos.`);
    } catch (requestError: unknown) {
      setError(getErrorMessage(requestError, 'No se pudo eliminar el historial.'));
    } finally {
      setBusy(false);
    }
  };

  const toggleCategory = (category: ActiveProblemCategory) => {
    setConfig((current) => {
      const categories = current.config.categories.includes(category)
        ? current.config.categories.filter((item) => item !== category)
        : [...current.config.categories, category];
      return { config: { ...current.config, categories } } as CreateRoomRequest;
    });
  };

  const toggleWinner = (roomId: string, userId: string) => {
    setWinnerSelections((current) => {
      const selected = current[roomId] ?? [];
      const next = selected.includes(userId)
        ? selected.filter((id) => id !== userId)
        : [...selected, userId];
      return { ...current, [roomId]: next };
    });
  };

  const handleSetResult = async (room: AdminRoomSummary) => {
    setBusy(true);
    setError('');
    try {
      await api.admin.setResult(room.match_id, winnerSelections[room.match_id] ?? []);
      await loadAdminData();
    } catch (requestError: unknown) {
      setError(getErrorMessage(requestError, 'No se pudo guardar la resolución manual.'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <main className="admin-shell">
        <p className="admin-muted">Validando acceso…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="admin-shell">
        <section className="admin-login-card" aria-labelledby="admin-login-title">
          <p className="admin-kicker">DUELODEV · ORGANIZACIÓN</p>
          <h1 id="admin-login-title">Panel administrativo</h1>
          <p className="admin-muted">
            Acceso restringido. Las credenciales se validan sólo en el servidor.
          </p>
          {error && (
            <p className="admin-alert" role="alert">
              {error}
            </p>
          )}
          <form onSubmit={handleLogin} className="admin-form">
            <label>
              Correo
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="username"
              />
            </label>
            <label>
              Contraseña
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
            <button className="admin-primary" type="submit" disabled={busy}>
              {busy ? 'Validando…' : 'Entrar al panel'}
            </button>
          </form>
          <button className="admin-link" type="button" onClick={() => router.push('/')}>
            Volver al inicio
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <div className="admin-layout">
        <header className="admin-header">
          <div>
            <p className="admin-kicker">DUELODEV · CONTROL PLANE</p>
            <h1>Panel administrativo</h1>
            <p className="admin-muted">Sesión activa: {user.email ?? user.gamertag}</p>
          </div>
          <button className="admin-secondary" type="button" onClick={handleLogout} disabled={busy}>
            Cerrar sesión
          </button>
        </header>

        {error && (
          <p className="admin-alert" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="admin-notice" role="status">
            {notice}
          </p>
        )}

        <section className="admin-grid admin-grid-top" aria-label="Resumen">
          <article className="admin-stat">
            <span>Salas</span>
            <strong>{rooms.length}</strong>
            <small>historial visible</small>
          </article>
          <article className="admin-stat">
            <span>Jugadores</span>
            <strong>{players.length}</strong>
            <small>participaciones cargadas</small>
          </article>
          <article className="admin-stat">
            <span>Ranking</span>
            <strong>{ranking.length}</strong>
            <small>jugadores ordenados</small>
          </article>
        </section>

        <section className="admin-panel admin-danger-panel" aria-labelledby="room-control-title">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">CONTROL DE OPERACIÓN</p>
              <h2 id="room-control-title">Cierre de salas</h2>
            </div>
            <span className="admin-badge">{activeRooms.length} activas</span>
          </div>
          <p className="admin-muted">
            Cerrar una sala la marca como abandonada y conserva sus jugadores, resultados e
            historial.
          </p>
          <button
            className="admin-danger"
            type="button"
            onClick={() => void handleCloseAllRooms()}
            disabled={busy || activeRooms.length === 0}
          >
            {busy ? 'Procesando…' : `Cerrar todas las salas activas (${activeRooms.length})`}
          </button>
        </section>

        <section className="admin-panel admin-danger-panel" aria-labelledby="room-delete-title">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">ELIMINACIÓN PERMANENTE</p>
              <h2 id="room-delete-title">Borrar registros</h2>
            </div>
          </div>
          <p className="admin-muted">
            Las acciones eliminan salas, jugadores, envíos y código. Sólo queda el evento mínimo de
            auditoría con el actor, la sala y el estado anterior.
          </p>
          <div className="admin-room-actions admin-delete-actions">
            <button
              className="admin-danger"
              type="button"
              onClick={() => void handleDeleteAllActiveRooms()}
              disabled={busy}
            >
              Borrar todas las salas activas
            </button>
            <button
              className="admin-danger"
              type="button"
              onClick={() => void handleDeleteHistory()}
              disabled={busy}
            >
              Borrar partidas previas
            </button>
          </div>
        </section>

        <section className="admin-panel" aria-labelledby="room-policy-title">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">ACCESO DE JUGADORES</p>
              <h2 id="room-policy-title">Creación de partidas</h2>
            </div>
            <span className="admin-badge">
              {registeredUsersCanCreateRooms ? 'Habilitada' : 'Deshabilitada'}
            </span>
          </div>
          <p className="admin-muted">
            Los invitados sólo pueden unirse. Al deshabilitar esta opción, las cuentas registradas
            todavía podrán entrar con un código de sala.
          </p>
          <button
            className={registeredUsersCanCreateRooms ? 'admin-danger' : 'admin-secondary'}
            type="button"
            onClick={() => void handleRoomCreationPolicy(!registeredUsersCanCreateRooms)}
            disabled={busy}
            aria-pressed={registeredUsersCanCreateRooms}
          >
            {registeredUsersCanCreateRooms ? 'Deshabilitar creación' : 'Habilitar creación'}
          </button>
        </section>

        <section className="admin-panel" aria-labelledby="create-room-title">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">CONFIGURACIÓN</p>
              <h2 id="create-room-title">Crear sala</h2>
            </div>
            <span className="admin-badge">2 o 3 jugadores</span>
          </div>
          <form onSubmit={handleCreateRoom} className="admin-room-form">
            <label>
              Modo
              <select
                value={config.config.mode}
                onChange={(event) =>
                  setConfig((current) =>
                    event.target.value === 'puntos'
                      ? {
                          config: {
                            ...defaultConfig.config,
                            max_players: current.config.max_players,
                          },
                        }
                      : {
                          config: {
                            mode: 'rondas',
                            max_players: current.config.max_players,
                            num_problems: 3,
                            categories: ['facil', 'facil_medio', 'dificil'],
                            target: 3,
                            match_duration_s: 600,
                          },
                        },
                  )
                }
              >
                <option value="puntos">Puntos</option>
                <option value="rondas">Rondas</option>
              </select>
            </label>
            <label>
              Jugadores
              <select
                value={config.config.max_players}
                onChange={(event) =>
                  setConfig((current) => ({
                    config: { ...current.config, max_players: Number(event.target.value) },
                  }))
                }
              >
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            <label>
              Problemas
              <input
                type="number"
                min={1}
                max={10}
                value={config.config.num_problems}
                onChange={(event) =>
                  setConfig((current) => ({
                    config: { ...current.config, num_problems: Number(event.target.value) },
                  }))
                }
              />
            </label>
            <fieldset className="admin-difficulty-fieldset">
              <legend>Dificultad</legend>
              {ACTIVE_PROBLEM_CATEGORIES.map((category) => (
                <label className="admin-check-label" key={category}>
                  <input
                    type="checkbox"
                    checked={config.config.categories.includes(category)}
                    onChange={() => toggleCategory(category)}
                  />
                  {PROBLEM_CATEGORY_LABELS[category]}
                </label>
              ))}
            </fieldset>
            <button className="admin-primary" type="submit" disabled={busy}>
              {busy ? 'Guardando…' : 'Crear sala'}
            </button>
          </form>
        </section>

        <section className="admin-panel" aria-labelledby="rooms-title">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">OPERACIÓN</p>
              <h2 id="rooms-title">Salas y resultados</h2>
            </div>
            <label className="admin-filter-label">
              <span className="sr-only">Filtrar salas por estado</span>
              <select
                aria-label="Filtrar salas por estado"
                value={roomStatusFilter}
                onChange={(event) => setRoomStatusFilter(event.target.value as RoomStatusFilter)}
              >
                {Object.entries(roomStatusLabels).map(([status, label]) => (
                  <option key={status} value={status}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="admin-muted">
            {visibleRooms.length} salas visibles · La eliminación permanente requiere escribir el
            código.
          </p>
          <div className="admin-room-list">
            {visibleRooms.length === 0 && (
              <p className="admin-muted">
                {roomStatusFilter === 'all'
                  ? 'Todavía no hay salas registradas.'
                  : `No hay salas con estado «${roomStatusLabels[roomStatusFilter]}».`}
              </p>
            )}
            {visibleRooms.map((room) => (
              <article className="admin-room-card" key={room.match_id}>
                <div className="admin-room-card-header">
                  <div>
                    <strong>{room.room_code}</strong>
                    <span>
                      {room.mode === 'puntos' ? 'Puntos' : 'Rondas'} ·{' '}
                      {roomStatusLabels[room.status]}
                    </span>
                  </div>
                  <time dateTime={room.created_at}>{formatDate(room.created_at)}</time>
                </div>
                <div className="admin-player-list">
                  {room.players.map((player) => (
                    <label className="admin-player-row" key={player.user_id}>
                      <input
                        type="checkbox"
                        checked={(winnerSelections[room.match_id] ?? []).includes(player.user_id)}
                        onChange={() => toggleWinner(room.match_id, player.user_id)}
                      />
                      <span>{playerLabel(player)}</span>
                      <b>{player.score} pts</b>
                    </label>
                  ))}
                </div>
                <div className="admin-room-footer">
                  <span className="admin-muted">
                    Ganadores actuales: {room.winner_ids.length || 'ninguno'}
                  </span>
                  <div className="admin-room-actions">
                    <button
                      className="admin-secondary"
                      type="button"
                      onClick={() => void handleSetResult(room)}
                      disabled={busy}
                    >
                      Guardar resolución manual
                    </button>
                    {isActiveRoom(room) && (
                      <button
                        className="admin-danger"
                        type="button"
                        onClick={() => void handleCloseRoom(room)}
                        disabled={busy}
                      >
                        Cerrar sala
                      </button>
                    )}
                    <button
                      className="admin-danger"
                      type="button"
                      onClick={() => void handleDeleteRoom(room)}
                      disabled={busy}
                    >
                      Eliminar registro
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="admin-grid admin-grid-bottom">
          <article className="admin-panel">
            <div className="admin-section-heading">
              <div>
                <p className="admin-kicker">CLASIFICACIÓN</p>
                <h2>Ranking</h2>
              </div>
            </div>
            <div className="admin-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Jugador</th>
                    <th scope="col">Puntos</th>
                    <th scope="col">Victorias</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.length === 0 ? (
                    <tr>
                      <td className="admin-table-empty" colSpan={4}>
                        Aún no hay resultados para mostrar.
                      </td>
                    </tr>
                  ) : (
                    ranking.map((entry) => (
                      <tr key={entry.user_id}>
                        <td data-label="Posición">{entry.rank}</td>
                        <td data-label="Jugador">{entry.gamertag}</td>
                        <td data-label="Puntos">{entry.score}</td>
                        <td data-label="Victorias">{entry.wins}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </article>
          <article className="admin-panel">
            <div className="admin-section-heading">
              <div>
                <p className="admin-kicker">JUGADORES</p>
                <h2>Participaciones</h2>
              </div>
            </div>
            <div className="admin-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Jugador</th>
                    <th scope="col">Sala</th>
                    <th scope="col">Casos</th>
                    <th scope="col">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {players.length === 0 ? (
                    <tr>
                      <td className="admin-table-empty" colSpan={4}>
                        Aún no hay participaciones para mostrar.
                      </td>
                    </tr>
                  ) : (
                    players.map((player) => (
                      <tr key={`${player.match_id}-${player.user_id}`}>
                        <td data-label="Jugador">{player.gamertag}</td>
                        <td data-label="Sala">{player.room_code}</td>
                        <td data-label="Casos">{player.cases_total}</td>
                        <td data-label="Estado">{player.connection_status}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
