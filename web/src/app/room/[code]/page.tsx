'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { RealtimeClient, realtimeUrl } from '@/lib/realtime';
import { S2C, C2S, MATCH_FINISH_REASON_LABELS } from '@duelodev/shared';
import type {
  RoomDetailsResponse,
  UserProfile,
  MatchSyncPayload,
  ProblemPublicResponse,
  VerdictPayload,
  ScoreUpdatePayload,
  ProblemBeginPayload,
  EventErrorPayload,
  MatchFinishedPayload,
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
          setMatchState(typedPayload);
          setRoom((prev) => (prev ? { ...prev, status: typedPayload.status } : prev));
        });

        client.on(S2C.PLAYER_STATUS, () => {
          api.rooms.get(roomCode).then(setRoom).catch(console.error);
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
    if (!room || !isConnected || isStartingMatch) return;
    setActionError('');
    setIsStartingMatch(true);
    try {
      const started = await api.rooms.start(room.room_code);
      setRoom((prev) => (prev ? { ...prev, status: started.status } : prev));
      wsClient?.send(C2S.JOIN_MATCH, { match_id: room.match_id });
    } catch (err) {
      console.error(err);
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
    return <div className="p-8">Cargando sala...</div>;
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
  const winnerNames =
    finishedMatch?.winner_ids.map(
      (winnerId) =>
        room.players.find((player) => player.user_id === winnerId)?.gamertag ?? winnerId,
    ) ?? [];
  const endsAtMs = matchState?.ends_at ? new Date(matchState.ends_at).getTime() : null;
  const secondsRemaining =
    endsAtMs === null ? null : Math.max(0, Math.ceil((endsAtMs - now) / 1000));
  const timeLabel = secondsRemaining === null ? 'Sin reloj activo' : formatClock(secondsRemaining);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center p-4">
      <div className="w-full max-w-6xl bg-white shadow rounded-xl overflow-hidden mt-8">
        <header className="bg-blue-600 text-white p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm text-blue-100">Sala</p>
            <h1 className="text-2xl font-bold tracking-wide">{roomCode.toUpperCase()}</h1>
          </div>
          <div className="flex flex-wrap gap-4 items-center">
            <span className="text-sm rounded-full bg-white/15 px-3 py-1">
              Estado: {room.status}
            </span>
            <span className="text-sm rounded-full bg-white/15 px-3 py-1">
              {isConnected ? 'Tiempo real conectado' : 'Reconectando tiempo real'}
            </span>
            <span
              className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}
              title={isConnected ? 'WS Conectado' : 'WS Desconectado'}
            ></span>
          </div>
        </header>

        <div className="p-6">
          {actionError && (
            <div className="mb-4 p-3 bg-red-100 text-red-700 rounded text-sm">{actionError}</div>
          )}

          {isLobby && (
            <div className="space-y-6">
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-900">
                <h2 className="text-2xl font-bold">Lobby</h2>
                <p className="mt-2 text-sm">
                  Comparte este código con el segundo jugador. Cuando la sala esté completa, ambos
                  pueden marcarse como listos y el anfitrión podrá iniciar la partida.
                </p>
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <code className="rounded bg-white px-4 py-3 text-2xl font-bold tracking-[0.35em] text-blue-950">
                    {roomCode.toUpperCase()}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyRoomCode}
                    className="rounded bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700"
                  >
                    Copiar código
                  </button>
                  {copyFeedback && <span className="text-sm font-medium">{copyFeedback}</span>}
                </div>
              </div>
              <div className="bg-gray-100 p-4 rounded">
                <h3 className="font-semibold mb-2">
                  Jugadores ({room.players.length}/{room.config.max_players})
                </h3>
                <ul className="space-y-2">
                  {room.players.map((p) => (
                    <li
                      key={p.user_id}
                      className="flex justify-between items-center bg-white p-2 rounded shadow-sm"
                    >
                      <span className="font-medium">
                        {p.gamertag} {p.is_host && '(Host)'}
                      </span>
                      <span
                        className={`text-sm px-2 py-1 rounded ${p.is_ready ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}
                      >
                        {p.is_ready ? 'Listo' : 'Esperando'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex gap-4">
                <button
                  onClick={handleReady}
                  disabled={!canUseRealtime}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white px-4 py-2 rounded"
                >
                  {canUseRealtime ? 'Marcar como Listo' : 'Conectando...'}
                </button>

                {isHost && (
                  <button
                    onClick={handleStartMatch}
                    disabled={!canStartMatch}
                    className="bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white px-4 py-2 rounded font-bold"
                  >
                    {isStartingMatch
                      ? 'Empezando...'
                      : hasRequiredPlayers
                        ? 'Empezar Partida'
                        : 'Esperando rival'}
                  </button>
                )}
              </div>

              {!hasRequiredPlayers && (
                <p className="text-sm text-gray-600">
                  Faltan jugadores para iniciar: {room.players.length}/{room.config.max_players}.
                </p>
              )}
            </div>
          )}

          {isPlaying && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold text-green-700">
                {room.status === 'finished' ? 'Partida finalizada' : '¡Partida en curso!'}
              </h2>

              {matchState && (
                <div
                  className={`rounded-lg border p-4 shadow-sm ${
                    secondsRemaining !== null && secondsRemaining <= 30 && room.status === 'running'
                      ? 'border-amber-300 bg-amber-50 text-amber-900'
                      : 'border-blue-200 bg-blue-50 text-blue-900'
                  }`}
                >
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold">Tiempo restante</p>
                      <p className="text-3xl font-bold tabular-nums">{timeLabel}</p>
                    </div>
                    <p className="text-sm">
                      {room.status === 'settling'
                        ? 'El tiempo terminó; esperando resultados pendientes del juez.'
                        : room.status === 'running'
                          ? 'El envío debe recibirse antes de que termine el reloj.'
                          : 'La partida ya no acepta nuevos envíos.'}
                    </p>
                  </div>
                </div>
              )}

              {finishedMatch && (
                <div className="bg-blue-50 border border-blue-200 text-blue-900 p-4 rounded shadow-sm">
                  <h3 className="font-bold mb-1">Resultado final</h3>
                  <p>{MATCH_FINISH_REASON_LABELS[finishedMatch.finish_reason]}</p>
                  <p className="mt-1">
                    {winnerNames.length > 0
                      ? `Ganador${winnerNames.length > 1 ? 'es' : ''}: ${winnerNames.join(', ')}`
                      : 'Partida sin ganador.'}
                  </p>
                </div>
              )}

              {matchState ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Panel Izquierdo: Problema y Estado */}
                  <div className="space-y-4">
                    <div className="bg-gray-100 p-4 rounded shadow-sm">
                      <div className="flex justify-between items-center mb-2">
                        <h3 className="font-bold text-lg">
                          Ronda {(matchState.problem_index ?? 0) + 1} / {room.config.num_problems}
                        </h3>
                      </div>
                      {problem ? (
                        <div>
                          <h4 className="text-xl font-bold mb-2">{problem.title}</h4>
                          <div className="text-sm whitespace-pre-wrap mb-4 bg-white p-3 rounded">
                            {problem.description}
                          </div>

                          <div className="space-y-2">
                            {problem.examples.map((ex, i) => (
                              <div
                                key={i}
                                className="bg-white p-3 rounded text-sm border border-gray-200"
                              >
                                <div className="font-mono bg-gray-50 p-2 mb-1">
                                  <strong>Entrada:</strong> {ex.input}
                                </div>
                                <div className="font-mono bg-gray-50 p-2">
                                  <strong>Salida:</strong> {ex.output}
                                </div>
                                {ex.explanation && (
                                  <div className="mt-2 text-gray-600 text-xs">{ex.explanation}</div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p>Cargando problema...</p>
                      )}
                    </div>

                    <div className="bg-white border border-gray-200 p-4 rounded shadow-sm">
                      <h3 className="font-bold mb-2">Puntuaciones</h3>
                      <ul className="space-y-1">
                        {matchState.scores.map((s) => {
                          const player = room.players.find((p) => p.user_id === s.user_id);
                          return (
                            <li key={s.user_id} className="flex justify-between">
                              <span>{player?.gamertag || s.user_id}</span>
                              <span className="font-bold">{s.score} pts</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>

                    {verdict && (
                      <div
                        className={`p-4 rounded shadow-sm ${verdict.verdict === 'AC' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}
                      >
                        <h3 className="font-bold mb-1">Último Veredicto: {verdict.verdict}</h3>
                        {verdict.passed !== undefined && (
                          <p>
                            Casos pasados: {verdict.passed} / {verdict.total}
                          </p>
                        )}
                        {verdict.exec_time_ms !== undefined && (
                          <p>Tiempo: {verdict.exec_time_ms}ms</p>
                        )}
                        {verdict.compile_output && (
                          <pre className="mt-2 text-xs font-mono whitespace-pre-wrap bg-white/50 p-2 rounded">
                            {verdict.compile_output}
                          </pre>
                        )}
                      </div>
                    )}

                    {isAwaitingVerdict && (
                      <div className="rounded border border-amber-200 bg-amber-50 p-4 text-amber-900 shadow-sm">
                        <h3 className="font-bold mb-1">Envío recibido</h3>
                        <p className="text-sm">
                          El juez está evaluando tu solución. El resultado aparecerá aquí cuando
                          termine la ejecución.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Panel Derecho: Editor */}
                  <div className="space-y-4">
                    <textarea
                      className="w-full h-96 font-mono text-sm p-4 border border-gray-300 rounded focus:outline-none focus:border-blue-500 bg-gray-50"
                      value={sourceCode}
                      onChange={(e) => setSourceCode(e.target.value)}
                      placeholder="Escribe tu código en Python 3 aquí..."
                      disabled={isSubmitting || room.status !== 'running'}
                    />

                    <button
                      onClick={handleSubmitCode}
                      disabled={!canSubmit}
                      className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-bold py-3 px-4 rounded transition-colors"
                    >
                      {room.status === 'finished'
                        ? 'Partida finalizada'
                        : isSubmitting
                          ? 'Enviando...'
                          : isAwaitingVerdict
                            ? 'Esperando veredicto...'
                            : 'Enviar Solución'}
                    </button>

                    <p className="text-xs text-gray-500">
                      Lenguaje habilitado en el MVP: Python 3. Evita enviar varias veces el mismo
                      código mientras el juez procesa tu solución.
                    </p>
                  </div>
                </div>
              ) : (
                <p>Sincronizando estado...</p>
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
