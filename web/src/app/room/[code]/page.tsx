'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { RealtimeClient, realtimeUrl } from '@/lib/realtime';
import { S2C, C2S } from '@duelodev/shared';
import type {
  RoomDetailsResponse,
  UserProfile,
  MatchSyncPayload,
  ProblemPublicResponse,
  VerdictPayload,
  ScoreUpdatePayload,
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
  const [verdict, setVerdict] = useState<VerdictPayload | null>(null);
  const [problem, setProblem] = useState<ProblemPublicResponse | null>(null);

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

    api.rooms
      .get(roomCode)
      .then((res) => {
        setRoom(res);

        // Conectar WS
        const client = new RealtimeClient(realtimeUrl);

        client.on('connected', () => {
          setIsConnected(true);
          // Unirse a la sala en el socket
          client.send(C2S.JOIN_MATCH, { match_id: res.match_id });
        });

        client.on('disconnected', () => setIsConnected(false));

        client.on(S2C.MATCH_SYNC, (payload: unknown) => {
          const typedPayload = payload as MatchSyncPayload;
          setMatchState(typedPayload);
          setRoom((prev) => (prev ? { ...prev, status: typedPayload.status } : prev));
        });

        client.on(S2C.PLAYER_STATUS, () => {
          // Actualizar estado de jugador
        });

        client.on(S2C.MATCH_STARTED, () => {
          setRoom((prev) => (prev ? { ...prev, status: 'running' } : prev));
        });

        client.on(S2C.SCORE_UPDATE, (payload: unknown) => {
          const typedPayload = payload as ScoreUpdatePayload;
          setMatchState((prev) => (prev ? { ...prev, scores: typedPayload.scores } : prev));
        });

        client.on(S2C.MATCH_FINISHED, () => {
          setRoom((prev) => (prev ? { ...prev, status: 'finished' } : prev));
          // Opcional: mostrar ganadores o redirigir a resumen final
        });

        client.on(S2C.VERDICT, (payload: unknown) => {
          const typedPayload = payload as VerdictPayload;
          if (typedPayload.user_id === user.id) {
            setVerdict(typedPayload);
          }
        });

        client.connect();
        setWsClient(client);
      })
      .catch((err) => {
        console.error(err);
        router.push('/');
      });

    return () => {
      wsClient?.disconnect();
    };
  }, [user, roomCode]);

  useEffect(() => {
    if (matchState?.problem_id) {
      api.problems.get(matchState.problem_id).then(setProblem).catch(console.error);
    }
  }, [matchState?.problem_id]);

  const handleSubmitCode = async () => {
    if (!room || !matchState || !matchState.problem_id || !matchState.round_id) return;
    setIsSubmitting(true);
    setVerdict(null);
    try {
      await api.submissions.create({
        match_id: room.match_id,
        round_id: matchState.round_id,
        problem_id: matchState.problem_id,
        language: 'python',
        source_code: sourceCode,
      });
    } catch (err) {
      console.error(err);
      alert('Error al enviar el código');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStartMatch = async () => {
    if (!room) return;
    try {
      await api.rooms.start(room.room_code);
    } catch (err) {
      console.error(err);
    }
  };

  const handleReady = () => {
    wsClient?.send(C2S.READY);
  };

  if (!room || !user) {
    return <div className="p-8">Cargando sala...</div>;
  }

  const isHost = room.host_id === user.id;
  const isLobby = room.status === 'lobby';
  const isPlaying =
    room.status === 'running' || room.status === 'settling' || room.status === 'finished';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center p-4">
      <div className="w-full max-w-6xl bg-white shadow rounded-xl overflow-hidden mt-8">
        <header className="bg-blue-600 text-white p-4 flex justify-between items-center">
          <h1 className="text-xl font-bold">Sala: {roomCode}</h1>
          <div className="flex gap-4 items-center">
            <span className="text-sm">Estado: {room.status}</span>
            <span
              className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}
              title={isConnected ? 'WS Conectado' : 'WS Desconectado'}
            ></span>
          </div>
        </header>

        <div className="p-6">
          {isLobby && (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold">Lobby</h2>
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
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
                >
                  Marcar como Listo
                </button>

                {isHost && (
                  <button
                    onClick={handleStartMatch}
                    className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded font-bold"
                  >
                    Empezar Partida
                  </button>
                )}
              </div>
            </div>
          )}

          {isPlaying && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold text-green-700">¡Partida en curso!</h2>
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
                  </div>

                  {/* Panel Derecho: Editor */}
                  <div className="space-y-4">
                    <textarea
                      className="w-full h-96 font-mono text-sm p-4 border border-gray-300 rounded focus:outline-none focus:border-blue-500 bg-gray-50"
                      value={sourceCode}
                      onChange={(e) => setSourceCode(e.target.value)}
                      placeholder="Escribe tu código en Python 3 aquí..."
                      disabled={isSubmitting}
                    />

                    <button
                      onClick={handleSubmitCode}
                      disabled={isSubmitting || !sourceCode.trim()}
                      className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-bold py-3 px-4 rounded transition-colors"
                    >
                      {isSubmitting ? 'Enviando...' : 'Enviar Solución'}
                    </button>
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
