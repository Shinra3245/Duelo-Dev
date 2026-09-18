'use client';

import { useEffect, useState, use, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiClientError } from '@/lib/api';
import { registerGuestSessionCleanup } from '@/lib/guest-session';
import { RealtimeClient, realtimeUrl } from '@/lib/realtime';
import { S2C, C2S, comparePlayerScores } from '@duelodev/shared';
import type {
  RoomDetailsResponse,
  RoomPlayerSummary,
  UserProfile,
  MatchSyncPayload,
  ProblemPublicResponse,
  VerdictPayload,
  ScoreUpdatePayload,
  ProblemBeginPayload,
  EventErrorPayload,
  MatchFinishedPayload,
  PlayerScore,
  RevealChangedPayload,
} from '@duelodev/shared';

export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const resolvedParams = use(params);
  const roomCode = resolvedParams.code;
  const router = useRouter();

  const [user, setUser] = useState<UserProfile | null>(null);
  const [room, setRoom] = useState<RoomDetailsResponse | null>(null);
  const [wsClient, setWsClient] = useState<RealtimeClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [matchState, setMatchState] = useState<MatchSyncPayload | null>(null);

  const [sourceCode, setSourceCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAwaitingVerdict, setIsAwaitingVerdict] = useState(false);
  const [isStartingMatch, setIsStartingMatch] = useState(false);
  const [actionError, setActionError] = useState('');
  const [verdict, setVerdict] = useState<VerdictPayload | null>(null);
  const [problem, setProblem] = useState<ProblemPublicResponse | null>(null);
  const [finishedMatch, setFinishedMatch] = useState<MatchFinishedPayload | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // App load
  useEffect(() => {
    api.auth
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.push('/'));
  }, [router]);

  useEffect(() => {
    if (!user || user.role !== 'guest') return;
    return registerGuestSessionCleanup();
  }, [user]);

  // Load room & connect
  useEffect(() => {
    if (!user || !roomCode) return;

    let cancelled = false;
    let client: RealtimeClient | null = null;

    setWsClient(null);
    setIsConnected(false);
    setMatchState(null);
    setProblem(null);
    setVerdict(null);
    setFinishedMatch(null);
    setActionError('');

    api.rooms
      .get(roomCode)
      .then((res) => {
        if (cancelled) return;

        // Si la sala ya estaba iniciada al cargar, el JOIN inicial solicitará
        // el MATCH_SYNC con el problema actual. En lobby dejamos la marca en
        // falso para poder pedir ese mismo sync cuando el anfitrión inicie.
        let matchSyncRequested = res.status !== 'lobby';

        setRoom(res);

        // Conectar WS
        client = new RealtimeClient(realtimeUrl);

        client.on('connected', () => {
          setIsConnected(true);
          // Unirse a la sala en el socket
          client?.send(C2S.JOIN_MATCH, { match_id: res.match_id });
        });

        client.on('disconnected', () => setIsConnected(false));

        client.on(S2C.MATCH_SYNC, (payload: unknown) => {
          const typedPayload = payload as MatchSyncPayload;
          if (typedPayload.status !== 'lobby') {
            matchSyncRequested = true;
          }
          setMatchState(typedPayload);
          setRoom((prev) => (prev ? { ...prev, status: typedPayload.status } : prev));
        });

        client.on(S2C.PLAYER_STATUS, () => {
          api.rooms
            .get(roomCode)
            .then((nextRoom) => {
              setRoom(nextRoom);

              // El start de la API persiste el estado en PostgreSQL. El
              // anfitrión solicita el sync al terminar el start, mientras
              // que los rivales reciben PLAYER_STATUS. Solicitar el JOIN una
              // sola vez evita que se queden con el MATCH_SYNC del lobby.
              if (nextRoom.status !== 'lobby' && !matchSyncRequested) {
                matchSyncRequested = true;
                client?.send(C2S.JOIN_MATCH, { match_id: nextRoom.match_id });
              }
            })
            .catch(console.error);
        });

        client.on(S2C.MATCH_STARTED, () => {
          setRoom((prev) => (prev ? { ...prev, status: 'running' } : prev));
        });

        client.on(S2C.PROBLEM_BEGIN, (payload: unknown) => {
          const typedPayload = payload as ProblemBeginPayload;
          setProblem(null);
          setVerdict(null);
          setIsAwaitingVerdict(false);
          setRoom((prev) => (prev ? { ...prev, status: 'running' } : prev));
          setMatchState((prev) =>
            prev
              ? {
                  ...prev,
                  state_version: typedPayload.state_version,
                  status: 'running',
                  round_id: typedPayload.round_id,
                  problem_id: typedPayload.problem_id,
                  problem_index: typedPayload.index,
                  ends_at: typedPayload.ends_at,
                }
              : prev,
          );
        });

        client.on(S2C.SCORE_UPDATE, (payload: unknown) => {
          const typedPayload = payload as ScoreUpdatePayload;
          setMatchState((prev) => (prev ? { ...prev, scores: typedPayload.scores } : prev));
        });

        client.on(S2C.REVEAL_CHANGED, (payload: unknown) => {
          const typedPayload = payload as RevealChangedPayload;
          setMatchState((prev) =>
            prev
              ? {
                  ...prev,
                  reveal_flags: {
                    ...prev.reveal_flags,
                    [typedPayload.user_id]: typedPayload.visible,
                  },
                }
              : prev,
          );
        });

        client.on(S2C.PLAYER_STATUS, (payload: unknown) => {
          const typedPayload = payload as {
            user_id: string;
            status: MatchSyncPayload['players'][string];
          };
          setMatchState((prev) =>
            prev
              ? {
                  ...prev,
                  players: { ...prev.players, [typedPayload.user_id]: typedPayload.status },
                }
              : prev,
          );
        });

        client.on(S2C.MATCH_FINISHED, (payload: unknown) => {
          const typedPayload = payload as MatchFinishedPayload;
          setIsAwaitingVerdict(false);
          setFinishedMatch(typedPayload);
          setRoom((prev) => (prev ? { ...prev, status: 'finished' } : prev));
          setMatchState((prev) =>
            prev
              ? {
                  ...prev,
                  state_version: typedPayload.state_version,
                  status: 'finished',
                  scores: typedPayload.final_scores,
                  winner_ids: typedPayload.winner_ids,
                  winner_id: typedPayload.winner_id,
                  finish_reason: typedPayload.finish_reason,
                }
              : prev,
          );
        });

        client.on(S2C.ERROR, (payload: unknown) => {
          const typedPayload = payload as EventErrorPayload;
          setIsAwaitingVerdict(false);
          setActionError(typedPayload.message || 'Ocurrió un error en tiempo real');
        });

        client.on(S2C.VERDICT, (payload: unknown) => {
          const typedPayload = payload as VerdictPayload;
          if (typedPayload.user_id === user.id) {
            setIsAwaitingVerdict(false);
            setVerdict(typedPayload);
          }
        });

        client.connect();
        setWsClient(client);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        router.push('/');
      });

    return () => {
      cancelled = true;
      client?.disconnect();
    };
  }, [user, roomCode, router]);

  useEffect(() => {
    if (matchState?.problem_id) {
      api.problems.get(matchState.problem_id).then(setProblem).catch(console.error);
    }
  }, [matchState?.problem_id]);

  useEffect(() => {
    if (!matchState?.ends_at || room?.status === 'finished') return;

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [matchState?.ends_at, room?.status]);

  const handleSubmitCode = async () => {
    if (!room || !matchState || !matchState.problem_id || !matchState.round_id) return;
    setIsSubmitting(true);
    setVerdict(null);
    setIsAwaitingVerdict(false);
    try {
      await api.submissions.create({
        match_id: room.match_id,
        round_id: matchState.round_id,
        problem_id: matchState.problem_id,
        language: 'python',
        source_code: sourceCode,
      });
      setIsAwaitingVerdict(true);
    } catch (err) {
      console.error(err);
      setActionError((err as Error).message || 'Error al enviar el código');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStartMatch = async () => {
    const currentUser = user;
    if (!room || !currentUser || !isConnected || isStartingMatch) return;
    setActionError('');
    setIsStartingMatch(true);
    try {
      const started = await api.rooms.start(room.room_code);
      setRoom((prev) => (prev ? { ...prev, status: started.status } : prev));
      wsClient?.send(C2S.JOIN_MATCH, { match_id: room.match_id });
    } catch (err) {
      console.error(err);
      if (err instanceof ApiClientError && err.status === 403) {
        try {
          const currentSession = await api.auth.me();
          if (currentSession.user.id !== currentUser.id) {
            setActionError(
              `La sesión de este navegador cambió a "${currentSession.user.gamertag}". Para probar dos jugadores, usa otro dispositivo, una ventana privada o un perfil de navegador separado para el rival.`,
            );
            return;
          }
        } catch {
          // Conserva el mensaje de autorización si la sesión ya no puede consultarse.
        }
      }
      setActionError((err as Error).message || 'Error al empezar la partida');
    } finally {
      setIsStartingMatch(false);
    }
  };

  const handleReady = () => {
    if (!isConnected) return;
    setActionError('');
    wsClient?.send(C2S.READY, {});
  };

  const handleToggleReveal = () => {
    if (!isConnected || !wsClient || !user || !matchState) return;
    wsClient.send(C2S.TOGGLE_REVEAL, {
      visible: !(matchState.reveal_flags[user.id] ?? false),
    });
  };

  const handleCopyRoomCode = async () => {
    setCopyFeedback('');
    try {
      await navigator.clipboard.writeText(roomCode.toUpperCase());
      setCopyFeedback('Código copiado');
      window.setTimeout(() => setCopyFeedback(''), 2000);
    } catch {
      setCopyFeedback('Copia manualmente el código');
    }
  };

  if (!room || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-200">
        <div className="flex items-center gap-3 text-sm font-medium">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-cyan-300" />
          Cargando sala...
        </div>
      </div>
    );
  }

  const isHost = room.host_id === user.id;
  const isLobby = room.status === 'lobby';
  const isPlaying =
    room.status === 'running' || room.status === 'settling' || room.status === 'finished';
  const canUseRealtime = isConnected && wsClient !== null;
  const hasRequiredPlayers = room.players.length >= room.config.max_players;
  const canStartMatch = canUseRealtime && hasRequiredPlayers && !isStartingMatch;
  const canSubmit =
    room.status === 'running' &&
    Boolean(matchState?.problem_id && matchState.round_id) &&
    Boolean(sourceCode.trim()) &&
    !isSubmitting &&
    !isAwaitingVerdict;
  const displayedScores: PlayerScore[] = [
    ...(finishedMatch?.final_scores ?? matchState?.scores ?? []),
  ].sort(comparePlayerScores);
  const endsAtMs = matchState?.ends_at ? new Date(matchState.ends_at).getTime() : null;
  const secondsRemaining =
    endsAtMs === null ? null : Math.max(0, Math.ceil((endsAtMs - now) / 1000));
  const timeLabel = secondsRemaining === null ? 'Sin reloj activo' : formatClock(secondsRemaining);

  return (
    <div className="min-h-screen bg-slate-950 px-3 py-4 text-slate-900 sm:px-6 sm:py-8">
      <div className="mx-auto w-full max-w-7xl overflow-hidden rounded-3xl border border-white/10 bg-slate-100 shadow-2xl shadow-black/30">
        <header className="bg-gradient-to-r from-slate-950 via-indigo-950 to-slate-900 px-5 py-5 text-white sm:px-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-200">
                Sala activa
              </p>
              <h1 className="mt-1 break-all font-mono text-3xl font-black tracking-[0.16em] text-white sm:text-4xl">
                {roomCode.toUpperCase()}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-bold sm:justify-end sm:text-sm">
              <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 capitalize text-slate-100">
                {room.status}
              </span>
              <span className="flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-slate-100">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${isConnected ? 'bg-emerald-300' : 'bg-rose-300'}`}
                />
                {isConnected ? 'Tiempo real conectado' : 'Reconectando'}
              </span>
            </div>
          </div>
        </header>

        <div className="p-4 sm:p-8">
          {actionError && (
            <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium leading-6 text-rose-800">
              {actionError}
            </div>
          )}

          {isLobby && (
            <div className="space-y-6">
              <div className="rounded-3xl border border-cyan-200 bg-gradient-to-br from-cyan-50 to-indigo-50 p-5 text-slate-900 shadow-sm sm:p-7">
                <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">
                      Sala preparada
                    </p>
                    <h2 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                      Lobby
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                      Comparte el código con los jugadores. La partida se habilita cuando la sala
                      alcance su capacidad.
                    </p>
                  </div>
                  <div className="rounded-2xl border border-indigo-200 bg-white/80 px-4 py-3 text-left shadow-sm sm:text-right">
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                      Jugadores
                    </p>
                    <p className="mt-1 text-2xl font-black text-slate-950">
                      {room.players.length}
                      <span className="text-slate-400">/{room.config.max_players}</span>
                    </p>
                  </div>
                </div>
                <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <code className="min-w-0 break-all rounded-2xl border border-indigo-200 bg-white px-4 py-3 text-center font-mono text-3xl font-black tracking-[0.24em] text-indigo-950 shadow-sm sm:text-left">
                    {roomCode.toUpperCase()}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyRoomCode}
                    className="rounded-2xl bg-indigo-600 px-5 py-3 font-bold text-white transition hover:bg-indigo-700"
                  >
                    Copiar código
                  </button>
                  {copyFeedback && (
                    <span className="text-sm font-bold text-emerald-700">{copyFeedback}</span>
                  )}
                </div>
              </div>
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-black text-slate-950">Jugadores conectados</h3>
                    <p className="mt-1 text-sm text-slate-500">
                      Cada participante debe aparecer como listo antes de comenzar.
                    </p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                    Capacidad {room.config.max_players}
                  </span>
                </div>
                <ul className="space-y-3">
                  {room.players.map((p) => (
                    <li
                      key={p.user_id}
                      className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 sm:p-4"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-100 font-black text-indigo-700">
                          {p.gamertag.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0">
                          <span className="block break-all font-mono text-sm font-black leading-5 text-slate-950 sm:text-base">
                            {p.gamertag}
                          </span>
                          {p.is_host && (
                            <span className="text-xs font-bold text-indigo-600">Anfitrión</span>
                          )}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${p.is_ready ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}
                      >
                        {p.is_ready ? 'Listo' : 'Esperando'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  onClick={handleReady}
                  disabled={!canUseRealtime}
                  className="rounded-2xl bg-indigo-600 px-5 py-3 font-bold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                >
                  {canUseRealtime ? 'Marcar como listo' : 'Conectando...'}
                </button>

                {isHost && (
                  <button
                    onClick={handleStartMatch}
                    disabled={!canStartMatch}
                    className="rounded-2xl bg-emerald-600 px-5 py-3 font-bold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                  >
                    {isStartingMatch
                      ? 'Empezando...'
                      : hasRequiredPlayers
                        ? 'Empezar partida'
                        : `Esperando jugadores (${room.players.length}/${room.config.max_players})`}
                  </button>
                )}
              </div>

              {!hasRequiredPlayers && (
                <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium leading-6 text-amber-900">
                  La partida se habilitará cuando estén todos los jugadores: {room.players.length}/
                  {room.config.max_players}.
                </p>
              )}
            </div>
          )}

          {isPlaying && (
            <div className="space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">
                    Duelo en vivo
                  </p>
                  <h2 className="mt-1 text-3xl font-black tracking-tight text-slate-950">
                    {room.status === 'finished' ? 'Resultados finales' : 'Partida en curso'}
                  </h2>
                </div>
                <span className="text-sm font-medium text-slate-500">
                  {room.config.mode === 'puntos' ? 'Modo Puntos' : 'Modo Rondas'}
                </span>
              </div>

              {matchState && (
                <div
                  className={`rounded-3xl border p-5 shadow-sm sm:p-6 ${
                    secondsRemaining !== null && secondsRemaining <= 30 && room.status === 'running'
                      ? 'border-amber-300 bg-amber-50 text-amber-900'
                      : 'border-blue-200 bg-blue-50 text-blue-900'
                  }`}
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.14em]">
                        Tiempo restante
                      </p>
                      <p className="mt-1 text-4xl font-black tabular-nums tracking-tight">
                        {timeLabel}
                      </p>
                    </div>
                    <p className="max-w-xl text-sm font-medium leading-6">
                      {room.status === 'settling'
                        ? 'El tiempo terminó; esperando resultados pendientes del juez.'
                        : room.status === 'running'
                          ? 'El envío debe recibirse antes de que termine el reloj.'
                          : 'La partida ya no acepta nuevos envíos.'}
                    </p>
                  </div>
                </div>
              )}

              {room.status === 'finished' && (
                <FinalStandings scores={displayedScores} players={room.players} />
              )}

              {matchState ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Panel Izquierdo: Problema y Estado */}
                  <div className="space-y-4">
                    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <h3 className="text-xl font-black text-slate-950">
                          Ronda {(matchState.problem_index ?? 0) + 1} / {room.config.num_problems}
                        </h3>
                        <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700">
                          Python 3
                        </span>
                      </div>
                      {problem ? (
                        <div>
                          <h4 className="mb-3 text-2xl font-black tracking-tight text-slate-950">
                            {problem.title}
                          </h4>
                          <div className="mb-5 whitespace-pre-wrap rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-slate-700 sm:text-base">
                            {problem.description}
                          </div>

                          <div className="space-y-2">
                            {problem.examples.map((ex, i) => (
                              <div
                                key={i}
                                className="rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-700"
                              >
                                <div className="mb-1 overflow-x-auto rounded-xl bg-slate-100 p-3 font-mono text-xs leading-6">
                                  <strong>Entrada:</strong> {ex.input}
                                </div>
                                <div className="overflow-x-auto rounded-xl bg-slate-100 p-3 font-mono text-xs leading-6">
                                  <strong>Salida:</strong> {ex.output}
                                </div>
                                {ex.explanation && (
                                  <div className="mt-2 text-xs leading-5 text-slate-500">
                                    {ex.explanation}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="rounded-2xl bg-slate-50 p-4 text-sm font-medium text-slate-500">
                          Cargando problema...
                        </p>
                      )}
                    </div>

                    {room.status !== 'finished' && (
                      <LiveStandings scores={displayedScores} players={room.players} />
                    )}

                    {verdict && (
                      <div
                        className={`rounded-2xl border p-4 text-sm shadow-sm ${verdict.verdict === 'AC' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}
                      >
                        <h3 className="mb-1 font-black">Último veredicto: {verdict.verdict}</h3>
                        {verdict.passed !== undefined && (
                          <p>
                            Casos pasados: {verdict.passed} / {verdict.total}
                          </p>
                        )}
                        {verdict.exec_time_ms !== undefined && (
                          <p>Tiempo: {verdict.exec_time_ms}ms</p>
                        )}
                        {verdict.compile_output && (
                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl bg-white/60 p-3 font-mono text-xs leading-5">
                            {verdict.compile_output}
                          </pre>
                        )}
                      </div>
                    )}

                    {isAwaitingVerdict && (
                      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 shadow-sm">
                        <h3 className="mb-1 font-black">Envío recibido</h3>
                        <p className="text-sm leading-6">
                          El juez está evaluando tu solución. El resultado aparecerá aquí cuando
                          termine la ejecución.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Panel Derecho: Editor */}
                  <div className="space-y-4">
                    <PythonEditor
                      value={sourceCode}
                      onChange={setSourceCode}
                      disabled={isSubmitting || room.status !== 'running'}
                    />

                    <RivalBoards
                      room={room}
                      matchState={matchState}
                      currentUserId={user.id}
                      onToggleReveal={handleToggleReveal}
                    />

                    <button
                      onClick={handleSubmitCode}
                      disabled={!canSubmit}
                      className="w-full rounded-2xl bg-indigo-600 px-4 py-3.5 font-bold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                    >
                      {room.status === 'finished'
                        ? 'Partida finalizada'
                        : isSubmitting
                          ? 'Enviando...'
                          : isAwaitingVerdict
                            ? 'Esperando veredicto...'
                            : 'Enviar Solución'}
                    </button>

                    <p className="text-xs leading-5 text-slate-500">
                      Lenguaje habilitado en el MVP: Python 3. Evita enviar varias veces el mismo
                      código mientras el juez procesa tu solución.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="rounded-2xl bg-white p-5 text-sm font-medium text-slate-500">
                  Sincronizando estado...
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function FinalStandings({
  scores,
  players,
}: {
  scores: PlayerScore[];
  players: RoomPlayerSummary[];
}) {
  return (
    <section className="rounded-3xl border border-indigo-200 bg-gradient-to-br from-indigo-950 to-slate-950 p-5 text-white shadow-xl sm:p-7">
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-200">
            Resultados oficiales
          </p>
          <h3 className="mt-1 text-2xl font-black tracking-tight">Tabla final</h3>
        </div>
        <p className="text-sm text-slate-300">Ordenada de mayor a menor puntuación</p>
      </div>
      <StandingsTable scores={scores} players={players} dark />
    </section>
  );
}

function LiveStandings({
  scores,
  players,
}: {
  scores: PlayerScore[];
  players: RoomPlayerSummary[];
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xl font-black text-slate-950">Marcador en vivo</h3>
          <p className="mt-1 text-sm text-slate-500">
            La clasificación se actualiza con cada veredicto.
          </p>
        </div>
        <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-700">
          En directo
        </span>
      </div>
      <StandingsTable scores={scores} players={players} />
    </section>
  );
}

function StandingsTable({
  scores,
  players,
  dark = false,
}: {
  scores: PlayerScore[];
  players: RoomPlayerSummary[];
  dark?: boolean;
}) {
  const playerNames = new Map(players.map((player) => [player.user_id, player.gamertag]));
  const headClass = dark ? 'text-slate-400' : 'text-slate-500';
  const rowClass = dark ? 'border-white/10 text-slate-100' : 'border-slate-100 text-slate-800';
  const mutedClass = dark ? 'text-slate-400' : 'text-slate-500';

  return (
    <div className="overflow-x-auto rounded-2xl border border-current/10">
      <table className="w-full min-w-[520px] border-collapse text-left text-sm">
        <thead className={`text-xs uppercase tracking-[0.12em] ${headClass}`}>
          <tr className="border-b border-current/10">
            <th className="px-4 py-3 font-bold">Pos.</th>
            <th className="px-4 py-3 font-bold">Jugador</th>
            <th className="px-4 py-3 text-right font-bold">Puntos</th>
            <th className="px-4 py-3 text-right font-bold">Casos</th>
            <th className="px-4 py-3 text-right font-bold">Tiempo</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((score, index) => (
            <tr key={score.user_id} className={`border-b last:border-0 ${rowClass}`}>
              <td className="px-4 py-3 font-black">{index + 1}</td>
              <td className="max-w-[220px] px-4 py-3">
                <span className="block break-all font-mono font-bold">
                  {playerNames.get(score.user_id) ?? score.gamertag ?? score.user_id}
                </span>
              </td>
              <td className="px-4 py-3 text-right text-base font-black">{score.score}</td>
              <td className={`px-4 py-3 text-right ${mutedClass}`}>{score.cases_total}</td>
              <td className={`px-4 py-3 text-right tabular-nums ${mutedClass}`}>
                {formatScoreTime(score.time_total_ms)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatScoreTime(timeMs: number) {
  if (!Number.isFinite(timeMs) || timeMs < 0) return '—';
  return `${(timeMs / 1000).toFixed(1)} s`;
}

function PythonEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const highlightRef = useRef<HTMLPreElement>(null);

  return (
    <div className="relative h-96 overflow-hidden rounded-3xl border border-slate-700 bg-slate-950 shadow-inner focus-within:border-cyan-400">
      <pre
        ref={highlightRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-sm leading-6 text-slate-100"
        dangerouslySetInnerHTML={{ __html: highlightPython(value) || ' ' }}
      />
      <textarea
        aria-label="Editor de solución Python"
        className="relative h-full w-full resize-none bg-transparent p-5 font-mono text-sm leading-6 text-transparent caret-cyan-300 outline-none placeholder:text-slate-500"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (highlightRef.current) {
            highlightRef.current.scrollTop = event.currentTarget.scrollTop;
            highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
          }
        }}
        placeholder="Escribe tu código en Python 3 aquí..."
        spellCheck={false}
        disabled={disabled}
      />
      <span className="pointer-events-none absolute right-4 top-3 rounded-full bg-cyan-300/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-200">
        Python 3 · IDE
      </span>
    </div>
  );
}

function RivalBoards({
  room,
  matchState,
  currentUserId,
  onToggleReveal,
}: {
  room: RoomDetailsResponse;
  matchState: MatchSyncPayload;
  currentUserId: string;
  onToggleReveal: () => void;
}) {
  const scoreMap = new Map(matchState.scores.map((score) => [score.user_id, score]));
  const rivals = room.players.filter((player) => player.user_id !== currentUserId);
  const ownReveal = matchState.reveal_flags[currentUserId] ?? false;

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900 p-4 text-slate-100 shadow-lg sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-cyan-300">Rivales</p>
          <h3 className="mt-1 text-lg font-black">Tableros y progreso</h3>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            El código rival sólo aparece cuando su dueño lo revela o la partida termina.
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleReveal}
          className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-bold text-cyan-100 transition hover:bg-cyan-400/20"
        >
          {ownReveal ? 'Ocultar mi código' : 'Revelar mi código'}
        </button>
      </div>
      <div className="grid gap-3">
        {rivals.length === 0 && <p className="text-sm text-slate-400">Esperando rivales…</p>}
        {rivals.map((player) => {
          const score = scoreMap.get(player.user_id);
          const isRevealed = matchState.reveal_flags[player.user_id] ?? false;
          const status = matchState.players[player.user_id] ?? 'disconnected';
          return (
            <div
              className="rounded-2xl border border-slate-700 bg-slate-950/70 p-3"
              key={player.user_id}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-mono text-sm font-bold text-slate-100">
                  {player.gamertag}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold uppercase ${status === 'connected' ? 'bg-emerald-400/15 text-emerald-200' : 'bg-amber-400/15 text-amber-200'}`}
                >
                  {status === 'connected' ? 'Conectado' : status}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <span>
                  <b className="block text-base text-cyan-200">{score?.score ?? 0}</b>Puntos
                </span>
                <span>
                  <b className="block text-base text-cyan-200">{score?.cases_total ?? 0}</b>Casos
                </span>
                <span>
                  <b className="block text-base text-cyan-200">
                    {(score?.current_problem_idx ?? 0) + 1}
                  </b>
                  Problema
                </span>
              </div>
              <p className="mt-3 border-t border-slate-800 pt-2 text-xs text-slate-400">
                {isRevealed ? 'Código revelado por el jugador.' : 'Código oculto por permisos.'}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function highlightPython(value: string): string {
  const escaped = escapeHtml(value);
  return escaped.replace(
    /(#.*|&quot;.*?&quot;|&#39;.*?&#39;|\b(?:and|as|assert|class|def|elif|else|for|from|if|import|in|is|not|or|return|while|True|False|None)\b|\b\d+(?:\.\d+)?\b)/g,
    (token) => {
      const color = token.startsWith('#')
        ? 'text-emerald-300'
        : token.startsWith('&quot;') || token.startsWith('&#39;')
          ? 'text-amber-300'
          : /^\d/.test(token)
            ? 'text-fuchsia-300'
            : 'text-cyan-300';
      return `<span class="${color}">${token}</span>`;
    },
  );
}
