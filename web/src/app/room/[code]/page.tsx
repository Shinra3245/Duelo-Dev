'use client';

import { useEffect, useState, use, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiClientError } from '@/lib/api';
import { CodeSyncClient } from '@/lib/code-sync';
import { isMobileGameDevice } from '@/lib/device-support';
import {
  getClosingDelimiterSkipPosition,
  insertAutoClosePair,
  isClipboardShortcut,
} from '@/lib/editor-behavior';
import { registerGuestSessionCleanup } from '@/lib/guest-session';
import { protectActiveMatchUnload } from '@/lib/match-unload';
import { RealtimeClient, realtimeUrl } from '@/lib/realtime';
import { S2C, C2S, comparePlayerScores, PROBLEM_CATEGORY_LABELS } from '@duelodev/shared';
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
  MatchSummaryResponse,
  PlayerScore,
  RevealChangedPayload,
  PlayerStatusPayload,
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
  const [rivalCode, setRivalCode] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAwaitingVerdict, setIsAwaitingVerdict] = useState(false);
  const [isStartingMatch, setIsStartingMatch] = useState(false);
  const [actionError, setActionError] = useState('');
  const [verdict, setVerdict] = useState<VerdictPayload | null>(null);
  const [problem, setProblem] = useState<ProblemPublicResponse | null>(null);
  const [finishedMatch, setFinishedMatch] = useState<MatchFinishedPayload | null>(null);
  const [matchSummary, setMatchSummary] = useState<MatchSummaryResponse | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const [isChallengeOpen, setIsChallengeOpen] = useState(false);
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [deviceCapability, setDeviceCapability] = useState<'checking' | 'desktop' | 'mobile'>(
    'checking',
  );
  const [now, setNow] = useState(() => Date.now());
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const sourceCodeRef = useRef(sourceCode);
  const lastPublishedSourceRef = useRef(sourceCode);
  const codeSyncClientsRef = useRef<Map<string, CodeSyncClient>>(new Map());
  const challengeButtonRef = useRef<HTMLButtonElement>(null);
  const leaveDialogRef = useRef<HTMLDialogElement>(null);
  const leaveCancelButtonRef = useRef<HTMLButtonElement>(null);
  const leaveTriggerButtonRef = useRef<HTMLButtonElement>(null);
  const leaveRequestedRef = useRef(false);
  const leaveTimeoutRef = useRef<number | null>(null);

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

  useEffect(() => {
    const updateDeviceCapability = () => {
      setDeviceCapability(
        isMobileGameDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)
          ? 'mobile'
          : 'desktop',
      );
    };

    updateDeviceCapability();
    window.addEventListener('resize', updateDeviceCapability);
    return () => window.removeEventListener('resize', updateDeviceCapability);
  }, []);

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
    setMatchSummary(null);
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
        if (res.status === 'finished' || res.status === 'abandoned') {
          api.matches
            .summary(res.match_id)
            .then((summary) => setMatchSummary(summary))
            .catch(console.error);
        }

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
          setServerOffsetMs(typedPayload.server_time - Date.now());
          setNow(Date.now());
          if (typedPayload.status !== 'lobby') {
            matchSyncRequested = true;
          }
          setMatchState(typedPayload);
          setRoom((prev) => (prev ? { ...prev, status: typedPayload.status } : prev));
        });

        client.on(S2C.PLAYER_STATUS, (payload: unknown) => {
          const status = payload as PlayerStatusPayload;
          if (status.user_id === user.id && status.status === 'left') {
            leaveRequestedRef.current = false;
            if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current);
            router.replace('/');
            return;
          }

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
          setRoom((prev) => (prev ? { ...prev, status: typedPayload.status } : prev));
          api.matches
            .summary(typedPayload.match_id)
            .then((summary) => setMatchSummary(summary))
            .catch(console.error);
          setMatchState((prev) =>
            prev
              ? {
                  ...prev,
                  state_version: typedPayload.state_version,
                  status: typedPayload.status,
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
          if (leaveRequestedRef.current) {
            leaveRequestedRef.current = false;
            if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current);
            setIsLeaving(false);
          }
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
    sourceCodeRef.current = sourceCode;
  }, [sourceCode]);

  const codeSyncTargetKey =
    room &&
    user &&
    matchState &&
    ['running', 'settling', 'finished', 'abandoned'].includes(room.status)
      ? [
          user.id,
          ...room.players
            .filter(
              (player) =>
                player.user_id !== user.id && matchState.players[player.user_id] !== 'left',
            )
            .map((player) => player.user_id),
        ]
          .sort()
          .join(',')
      : '';

  useEffect(() => {
    if (!room || !user || !matchState || !codeSyncTargetKey) return;

    const targetUserIds = codeSyncTargetKey.split(',').filter(Boolean);
    const clients = new Map<string, CodeSyncClient>();

    for (const targetUserId of targetUserIds) {
      const client = new CodeSyncClient(realtimeUrl, room.match_id, targetUserId, {
        onSync: (message) => {
          if (targetUserId === user.id) {
            if (!sourceCodeRef.current && message.source_code) {
              sourceCodeRef.current = message.source_code;
              setSourceCode(message.source_code);
            }
            return;
          }
          setRivalCode((previous) => ({ ...previous, [targetUserId]: message.source_code }));
        },
        onUpdate: (nextCode) => {
          if (targetUserId !== user.id) {
            setRivalCode((previous) => ({ ...previous, [targetUserId]: nextCode }));
          }
        },
      });
      clients.set(targetUserId, client);
      client.connect();
    }

    codeSyncClientsRef.current = clients;
    setRivalCode({});

    return () => {
      clients.forEach((client) => client.disconnect());
      if (codeSyncClientsRef.current === clients) {
        codeSyncClientsRef.current = new Map();
      }
      setRivalCode({});
    };
  }, [room?.match_id, user?.id, codeSyncTargetKey]);

  useEffect(() => {
    const ownerClient = codeSyncClientsRef.current.get(user?.id ?? '');
    if (!ownerClient || lastPublishedSourceRef.current === sourceCode) return;
    lastPublishedSourceRef.current = sourceCode;
    ownerClient.sendCode(sourceCode);
  }, [sourceCode, user?.id, codeSyncTargetKey]);

  useEffect(() => {
    if (matchState?.problem_id) {
      setProblem(null);
      api.problems.get(matchState.problem_id).then(setProblem).catch(console.error);
    }
  }, [matchState?.problem_id]);

  useEffect(() => {
    if (!isChallengeOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsChallengeOpen(false);
        challengeButtonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isChallengeOpen]);

  useEffect(() => {
    const dialog = leaveDialogRef.current;
    if (!dialog) return;
    if (isLeaveDialogOpen && !dialog.open) {
      dialog.showModal();
      leaveCancelButtonRef.current?.focus();
    } else if (!isLeaveDialogOpen && dialog.open) {
      dialog.close();
      leaveTriggerButtonRef.current?.focus();
    }
  }, [isLeaveDialogOpen]);

  useEffect(
    () => () => {
      if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    if (
      (!matchState?.ends_at && !matchState?.instructions_ends_at) ||
      room?.status === 'finished' ||
      room?.status === 'abandoned'
    )
      return;

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [matchState?.ends_at, matchState?.instructions_ends_at, room?.status]);

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

  const confirmLeaveMatch = () => {
    if (!wsClient || !isConnected) {
      setActionError('Espera a que vuelva la conexión para confirmar el abandono de forma segura.');
      return;
    }
    setActionError('');
    setIsLeaving(true);
    leaveRequestedRef.current = true;
    leaveTimeoutRef.current = window.setTimeout(() => {
      leaveRequestedRef.current = false;
      setIsLeaving(false);
      setActionError('No recibimos confirmación del servidor. Puedes volver a intentarlo.');
    }, 5000);
    wsClient.send(C2S.LEAVE_MATCH, {});
  };

  const handleReady = () => {
    if (!isConnected || deviceCapability !== 'desktop') return;
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

  const isGameViewportActive = Boolean(
    room && ['running', 'settling', 'finished', 'abandoned'].includes(room.status),
  );
  const canConfirmBrowserLeave = room?.status === 'running' || room?.status === 'settling';

  useEffect(() => {
    if (!canConfirmBrowserLeave) return;
    const confirmUnload = (event: BeforeUnloadEvent) => protectActiveMatchUnload(event);
    window.addEventListener('beforeunload', confirmUnload);
    return () => window.removeEventListener('beforeunload', confirmUnload);
  }, [canConfirmBrowserLeave]);

  useEffect(() => {
    if (!isGameViewportActive || deviceCapability !== 'desktop') return;
    document.documentElement.classList.add('duel-game-viewport');
    return () => document.documentElement.classList.remove('duel-game-viewport');
  }, [isGameViewportActive, deviceCapability]);

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

  if (isGameViewportActive && deviceCapability !== 'desktop') {
    return (
      <main className="duel-mobile-game-block" role="status" aria-live="polite">
        <div className="duel-mobile-game-card">
          <p className="duel-game-eyebrow">DueloDev · Sala {roomCode.toUpperCase()}</p>
          <h1>
            {deviceCapability === 'checking'
              ? 'Preparando el espacio de juego'
              : 'Esta partida requiere una computadora'}
          </h1>
          <p>
            {deviceCapability === 'checking'
              ? 'Estamos comprobando el tamaño y el tipo de dispositivo.'
              : 'Abre esta sala desde una computadora de escritorio o laptop para ver los tableros y continuar.'}
          </p>
          {deviceCapability === 'mobile' && (
            <p className="duel-mobile-game-warning">
              La partida sigue en curso y el reloj puede avanzar mientras cambias de dispositivo.
            </p>
          )}
        </div>
      </main>
    );
  }

  const isHost = room.host_id === user.id;
  const isLobby = room.status === 'lobby';
  const isPlaying =
    room.status === 'running' ||
    room.status === 'settling' ||
    room.status === 'finished' ||
    room.status === 'abandoned';
  const canLeaveMatch = room.status === 'running' || room.status === 'settling';
  const canUseRealtime = isConnected && wsClient !== null;
  const currentMatchPlayers = room.players.filter(
    (player) => matchState?.players[player.user_id] !== 'left',
  );
  const activePlayersAfterLeave = currentMatchPlayers.length - 1;
  const minPlayersToStart = 2;
  const readyPlayerCount = room.players.filter((player) => player.is_ready).length;
  const hasRequiredPlayers = readyPlayerCount >= minPlayersToStart;
  const canStartMatch =
    canUseRealtime && deviceCapability === 'desktop' && hasRequiredPlayers && !isStartingMatch;
  const canSubmit =
    room.status === 'running' &&
    Boolean(matchState?.problem_id && matchState.round_id) &&
    Boolean(sourceCode.trim()) &&
    !isSubmitting &&
    !isAwaitingVerdict &&
    !(matchState?.instructions_ends_at && now + serverOffsetMs < matchState.instructions_ends_at);
  const displayedScores: PlayerScore[] = [
    ...(finishedMatch?.final_scores ?? matchSummary?.final_scores ?? matchState?.scores ?? []),
  ].sort(comparePlayerScores);
  const serverNow = now + serverOffsetMs;
  const instructionsEndsAt = matchState?.instructions_ends_at ?? null;
  const instructionsRemaining =
    instructionsEndsAt === null
      ? 0
      : Math.max(0, Math.ceil((instructionsEndsAt - serverNow) / 1000));
  const isInstructionsPhase = room.status === 'running' && instructionsRemaining > 0;
  const endsAtMs = matchState?.ends_at ? new Date(matchState.ends_at).getTime() : null;
  const secondsRemaining =
    endsAtMs === null ? null : Math.max(0, Math.ceil((endsAtMs - serverNow) / 1000));
  const timeLabel = secondsRemaining === null ? 'Sin reloj activo' : formatClock(secondsRemaining);

  return (
    <div
      className={`duel-room-shell min-h-screen bg-slate-950 px-3 py-4 text-slate-900 sm:px-6 sm:py-8 ${isGameViewportActive ? 'duel-game-viewport-shell' : ''}`}
    >
      <div
        className={`duel-room-frame mx-auto w-full max-w-7xl overflow-hidden rounded-3xl border border-white/10 bg-slate-100 shadow-2xl shadow-black/30 ${isGameViewportActive ? 'duel-game-viewport-frame' : ''}`}
      >
        <header
          className={`duel-room-header bg-gradient-to-r from-slate-950 via-indigo-950 to-slate-900 px-5 py-5 text-white sm:px-8 ${isGameViewportActive ? 'duel-game-viewport-header' : ''}`}
        >
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
              <span className="duel-room-status rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-slate-100">
                {roomStatusLabel(room.status)}
              </span>
              <span
                className="duel-room-connection flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-slate-100"
                aria-live="polite"
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full ${isConnected ? 'bg-emerald-300' : 'bg-rose-300'}`}
                />
                {isConnected ? 'Tiempo real conectado' : 'Reconectando'}
              </span>
            </div>
          </div>
        </header>

        <div
          className={`duel-room-content p-4 sm:p-8 ${isGameViewportActive ? 'duel-game-viewport-content' : ''}`}
        >
          {actionError && (
            <div className="duel-room-alert mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium leading-6 text-rose-800">
              {actionError}
            </div>
          )}

          {isLobby && (
            <div className="space-y-6">
              <div className="duel-lobby-hero rounded-3xl border border-cyan-200 bg-gradient-to-br from-cyan-50 to-indigo-50 p-5 text-slate-900 shadow-sm sm:p-7">
                <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">
                      Sala preparada
                    </p>
                    <h2 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                      Lobby
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                      Comparte el código con los jugadores. La partida se habilita cuando haya al
                      menos dos participantes listos.
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
              <div className="duel-room-panel rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
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
                  disabled={!canUseRealtime || deviceCapability !== 'desktop'}
                  className="rounded-2xl bg-indigo-600 px-5 py-3 font-bold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                >
                  {deviceCapability === 'checking'
                    ? 'Validando dispositivo...'
                    : deviceCapability === 'mobile'
                      ? 'Disponible en computadora'
                      : canUseRealtime
                        ? 'Marcar como listo'
                        : 'Conectando...'}
                </button>

                {isHost && (
                  <button
                    onClick={handleStartMatch}
                    disabled={!canStartMatch}
                    className="rounded-2xl bg-emerald-600 px-5 py-3 font-bold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                  >
                    {deviceCapability === 'checking'
                      ? 'Validando dispositivo...'
                      : deviceCapability === 'mobile'
                        ? 'Inicia desde una computadora'
                        : isStartingMatch
                          ? 'Empezando...'
                          : hasRequiredPlayers
                            ? 'Empezar partida'
                            : `Esperando jugadores (${readyPlayerCount}/${minPlayersToStart})`}
                  </button>
                )}
              </div>

              {deviceCapability === 'mobile' && (
                <p className="duel-mobile-lobby-warning" role="status">
                  Puedes consultar este lobby desde aquí, pero para marcarte listo y jugar abre la
                  sala en una computadora de escritorio o laptop.
                </p>
              )}

              {!hasRequiredPlayers && (
                <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium leading-6 text-amber-900">
                  Se necesitan al menos {minPlayersToStart} jugadores listos para iniciar. Ahora hay{' '}
                  {readyPlayerCount}/{minPlayersToStart}.
                </p>
              )}
            </div>
          )}

          {isPlaying && (
            <div className="duel-game-shell space-y-4">
              {matchState ? (
                isInstructionsPhase ? (
                  <section className="duel-instructions-card" aria-labelledby="instructions-title">
                    <div className="duel-instructions-heading">
                      <div>
                        <p className="duel-game-eyebrow">
                          Ronda {(matchState.problem_index ?? 0) + 1}
                        </p>
                        <h2 id="instructions-title">Prepárate para programar</h2>
                        <p>
                          Lee el reto. El tiempo de juego inicia al terminar la cuenta regresiva.
                        </p>
                      </div>
                      <div className="duel-instructions-controls">
                        <div
                          className="duel-instructions-countdown"
                          aria-label={`Inicio en ${instructionsRemaining} segundos`}
                        >
                          <span>INICIO EN</span>
                          <strong aria-live="off">
                            00:{String(instructionsRemaining).padStart(2, '0')}
                          </strong>
                          <span>Python 3</span>
                        </div>
                        {canLeaveMatch && (
                          <button
                            ref={leaveTriggerButtonRef}
                            type="button"
                            className="duel-leave-match-trigger"
                            onClick={() => setIsLeaveDialogOpen(true)}
                          >
                            Abandonar partida
                          </button>
                        )}
                      </div>
                    </div>
                    <ProblemStatement
                      problem={problem}
                      problemIndex={matchState.problem_index ?? 0}
                      totalProblems={room.config.num_problems}
                    />
                  </section>
                ) : (
                  <div className="duel-new-match-view">
                    <div className="duel-game-toolbar" aria-label="Estado de la partida">
                      <div className="duel-toolbar-metric">
                        <span>Tiempo</span>
                        <strong aria-live="off">{timeLabel}</strong>
                      </div>
                      <div className="duel-toolbar-metric">
                        <span>Ronda</span>
                        <strong>
                          {(matchState.problem_index ?? 0) + 1}
                          <small> / {room.config.num_problems}</small>
                        </strong>
                      </div>
                      <div className="duel-game-toolbar-actions">
                        <button
                          ref={challengeButtonRef}
                          type="button"
                          className="duel-challenge-trigger"
                          aria-label="Abrir el reto"
                          aria-haspopup="dialog"
                          aria-expanded={isChallengeOpen}
                          aria-controls="duel-challenge-dialog"
                          onClick={() => setIsChallengeOpen((open) => !open)}
                        >
                          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                            <path
                              d="M12 17v.01M9.1 9a3 3 0 1 1 5.2 2c-1.3 1.1-2.3 1.6-2.3 3"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                            />
                            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                          </svg>
                          <span>Ver reto</span>
                        </button>
                        {canLeaveMatch && (
                          <button
                            ref={leaveTriggerButtonRef}
                            type="button"
                            className="duel-leave-match-trigger"
                            onClick={() => setIsLeaveDialogOpen(true)}
                          >
                            Abandonar partida
                          </button>
                        )}
                      </div>
                    </div>

                    {isChallengeOpen && (
                      <section
                        id="duel-challenge-dialog"
                        role="dialog"
                        aria-labelledby="challenge-title"
                        className="duel-challenge-popover"
                      >
                        <div className="duel-challenge-popover-heading">
                          <div>
                            <p className="duel-game-eyebrow">
                              Python 3 · Ronda {(matchState.problem_index ?? 0) + 1}
                            </p>
                            <h2 id="challenge-title">Reto actual</h2>
                          </div>
                          <button
                            type="button"
                            className="duel-challenge-close"
                            aria-label="Cerrar el reto"
                            onClick={() => {
                              setIsChallengeOpen(false);
                              challengeButtonRef.current?.focus();
                            }}
                          >
                            ×
                          </button>
                        </div>
                        <ProblemStatement
                          problem={problem}
                          problemIndex={matchState.problem_index ?? 0}
                          totalProblems={room.config.num_problems}
                        />
                      </section>
                    )}

                    {(room.status === 'finished' || room.status === 'abandoned') && (
                      <FinalStandings scores={displayedScores} players={room.players} />
                    )}

                    <div
                      className={`duel-code-board-grid ${currentMatchPlayers.length === 2 ? 'duel-two-boards' : ''}`}
                    >
                      <PythonEditor
                        value={sourceCode}
                        onChange={setSourceCode}
                        disabled={isSubmitting || room.status !== 'running'}
                        playerName={user.gamertag}
                        isRevealed={matchState.reveal_flags[user.id] ?? false}
                        onToggleReveal={handleToggleReveal}
                      />
                      {currentMatchPlayers
                        .filter((player) => player.user_id !== user.id)
                        .map((player, index) => (
                          <RivalCodeBoard
                            key={player.user_id}
                            player={player}
                            status={matchState.players[player.user_id] ?? 'disconnected'}
                            score={matchState.scores.find(
                              (item) => item.user_id === player.user_id,
                            )}
                            sourceCode={rivalCode[player.user_id]}
                            isRevealed={matchState.reveal_flags[player.user_id] ?? false}
                            isCompact={index > 0}
                          />
                        ))}
                    </div>

                    <div className="duel-game-actions">
                      <button
                        onClick={handleSubmitCode}
                        disabled={!canSubmit}
                        className="duel-submit-button"
                      >
                        {room.status === 'finished' || room.status === 'abandoned'
                          ? room.status === 'abandoned'
                            ? 'Sala cerrada'
                            : 'Partida finalizada'
                          : isSubmitting
                            ? 'Enviando...'
                            : isAwaitingVerdict
                              ? 'Esperando veredicto...'
                              : 'Enviar solución'}
                      </button>
                      <p id="python-editor-help">
                        Python 3 · Copiar y pegar desactivados. El reto permanece accesible desde
                        «Ver reto»; abrirlo no pausa el reloj.
                      </p>
                    </div>

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
                          termine.
                        </p>
                      </div>
                    )}
                    {room.status !== 'finished' && room.status !== 'abandoned' && (
                      <LiveStandings
                        scores={displayedScores.filter(
                          (score) => matchState.players[score.user_id] !== 'left',
                        )}
                        players={currentMatchPlayers}
                      />
                    )}
                    {matchSummary && (
                      <VisibleCodeSnapshots
                        summary={matchSummary}
                        players={room.players}
                        currentUserId={user.id}
                      />
                    )}
                  </div>
                )
              ) : (
                <p className="rounded-2xl bg-white p-5 text-sm font-medium text-slate-500">
                  Sincronizando partida con el servidor...
                </p>
              )}
              {canLeaveMatch && (
                <dialog
                  ref={leaveDialogRef}
                  className="duel-leave-dialog"
                  aria-labelledby="duel-leave-title"
                  aria-describedby="duel-leave-description"
                  onCancel={(event) => {
                    event.preventDefault();
                    if (!isLeaving) setIsLeaveDialogOpen(false);
                  }}
                >
                  <p className="duel-game-eyebrow">SALIDA DE PARTIDA</p>
                  <h2 id="duel-leave-title">¿Estás a punto de abandonar la partida?</h2>
                  <p id="duel-leave-description">
                    {activePlayersAfterLeave >= 2
                      ? 'La partida continuará con los jugadores restantes.'
                      : 'Tu rival será declarado ganador por abandono.'}{' '}
                    Esta acción no se puede deshacer.
                  </p>
                  {actionError && <p className="duel-leave-error">{actionError}</p>}
                  <div className="duel-leave-dialog-actions">
                    <button
                      ref={leaveCancelButtonRef}
                      type="button"
                      className="duel-leave-cancel"
                      disabled={isLeaving}
                      onClick={() => setIsLeaveDialogOpen(false)}
                    >
                      Seguir en la partida
                    </button>
                    <button
                      type="button"
                      className="duel-leave-confirm"
                      disabled={isLeaving || !isConnected}
                      aria-busy={isLeaving}
                      onClick={confirmLeaveMatch}
                    >
                      {isLeaving ? 'Abandonando…' : 'Sí, abandonar'}
                    </button>
                  </div>
                </dialog>
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

function ProblemStatement({
  problem,
  problemIndex,
  totalProblems,
}: {
  problem: ProblemPublicResponse | null;
  problemIndex: number;
  totalProblems: number;
}) {
  if (!problem) {
    return <p className="duel-problem-loading">Cargando el reto compartido…</p>;
  }

  return (
    <div className="duel-problem-content">
      <div className="duel-problem-meta">
        <span>
          Ronda {problemIndex + 1} / {totalProblems}
        </span>
        <span className="duel-problem-category">
          Dificultad: {PROBLEM_CATEGORY_LABELS[problem.category]}
        </span>
        <span>Python 3</span>
      </div>
      <h3>{problem.title}</h3>
      <p className="duel-problem-description">{problem.description}</p>
      {problem.examples.length > 0 && (
        <div className="duel-problem-examples">
          {problem.examples.map((example, index) => (
            <article key={`${index}-${example.input}`}>
              <div>
                <span>Entrada</span>
                <pre>{example.input || '∅'}</pre>
              </div>
              <div>
                <span>Salida</span>
                <pre>{example.output || '∅'}</pre>
              </div>
              {example.explanation && <p>{example.explanation}</p>}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function roomStatusLabel(status: RoomDetailsResponse['status']) {
  const labels: Record<RoomDetailsResponse['status'], string> = {
    lobby: 'Lobby',
    running: 'En curso',
    settling: 'Cerrando ronda',
    finished: 'Finalizada',
    abandoned: 'Cerrada',
  };
  return labels[status];
}

function FinalStandings({
  scores,
  players,
}: {
  scores: PlayerScore[];
  players: RoomPlayerSummary[];
}) {
  return (
    <section className="duel-final-standings rounded-3xl border border-indigo-200 bg-gradient-to-br from-indigo-950 to-slate-950 p-5 text-white shadow-xl sm:p-7">
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

function VisibleCodeSnapshots({
  summary,
  players,
  currentUserId,
}: {
  summary: MatchSummaryResponse;
  players: RoomPlayerSummary[];
  currentUserId: string;
}) {
  const playerNames = new Map(players.map((player) => [player.user_id, player.gamertag]));

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-indigo-600">
          Código compartido
        </p>
        <h3 className="mt-1 text-xl font-black text-slate-950">Soluciones autorizadas</h3>
        <p className="mt-1 text-sm leading-6 text-slate-500">
          Sólo aparecen tu código y los snapshots de rivales que autorizaron su revelación.
        </p>
      </div>
      {summary.snapshots.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
          No hay snapshots de código disponibles para esta partida.
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {summary.snapshots.map((snapshot, index) => {
            const isOwn = snapshot.user_id === currentUserId;
            return (
              <article
                key={`${snapshot.user_id}-${snapshot.round_id}-${snapshot.captured_at}-${index}`}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-950"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3 text-xs">
                  <span className="font-mono font-bold text-cyan-200">
                    {playerNames.get(snapshot.user_id) ?? snapshot.user_id}
                    {isOwn ? ' · tú' : ''}
                  </span>
                  <span className="text-slate-400">Python 3 · snapshot autorizado</span>
                </div>
                <pre
                  aria-label={`Código de ${playerNames.get(snapshot.user_id) ?? 'jugador'}`}
                  className="max-h-72 overflow-auto p-4 font-mono text-xs leading-6 text-slate-100"
                  dangerouslySetInnerHTML={{
                    __html: highlightPython(snapshot.source_code) || ' ',
                  }}
                />
              </article>
            );
          })}
        </div>
      )}
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
    <section className="duel-live-standings rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
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
    <div className={`duel-standings ${dark ? 'duel-standings-dark' : ''}`}>
      <ol className="duel-standings-mobile" aria-label="Clasificación de jugadores">
        {scores.map((score, index) => (
          <li className="duel-standings-mobile-card" key={score.user_id}>
            <div className="duel-standings-mobile-player">
              <span className="duel-standings-mobile-position">{index + 1}</span>
              <strong>{playerNames.get(score.user_id) ?? score.gamertag ?? score.user_id}</strong>
            </div>
            <dl className="duel-standings-mobile-stats">
              <div>
                <dt>Puntos</dt>
                <dd>{score.score}</dd>
              </div>
              <div>
                <dt>Casos</dt>
                <dd>{score.cases_total}</dd>
              </div>
              <div>
                <dt>Tiempo</dt>
                <dd>{formatScoreTime(score.time_total_ms)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
      <div className="duel-standings-table-wrap">
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
  playerName,
  isRevealed,
  onToggleReveal,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  playerName: string;
  isRevealed: boolean;
  onToggleReveal: () => void;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const lineCount = Math.max(1, value.split('\n').length);

  return (
    <article className="duel-code-board duel-own-code-board duel-python-editor overflow-hidden rounded-3xl border border-slate-700 bg-slate-950 shadow-inner focus-within:border-cyan-400">
      <div className="duel-code-board-header flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-3 text-xs">
        <div className="min-w-0">
          <span className="duel-code-player-name block truncate font-mono font-black text-slate-100">
            {playerName} <span>(Tú)</span>
          </span>
          <span className="font-mono text-slate-400">solution.py</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-cyan-300/10 px-2 py-1 font-bold uppercase tracking-[0.14em] text-cyan-200">
            Python 3
          </span>
          <button type="button" onClick={onToggleReveal} className="duel-code-visibility-button">
            {isRevealed ? 'Ocultar mi código' : 'Mostrar mi código'}
          </button>
        </div>
      </div>
      <div className="relative flex h-[28rem] min-h-0">
        <div
          ref={lineNumbersRef}
          aria-hidden="true"
          className="w-12 shrink-0 overflow-hidden border-r border-slate-800 bg-slate-900/80 px-3 py-5 text-right font-mono text-sm leading-6 text-slate-500 select-none"
        >
          {Array.from({ length: lineCount }, (_, index) => (
            <div key={index}>{index + 1}</div>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <pre
            ref={highlightRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-sm leading-6 text-slate-100"
            dangerouslySetInnerHTML={{ __html: highlightPython(value) || ' ' }}
          />
          <textarea
            ref={editorRef}
            aria-describedby="python-editor-help"
            aria-label="Editor de solución Python"
            className="relative h-full w-full resize-none overflow-auto bg-transparent p-5 font-mono text-sm leading-6 text-transparent caret-cyan-300 outline-none placeholder:text-slate-500"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onCopy={(event) => event.preventDefault()}
            onCut={(event) => event.preventDefault()}
            onPaste={(event) => event.preventDefault()}
            onContextMenu={(event) => event.preventDefault()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              const start = event.currentTarget.selectionStart;
              const end = event.currentTarget.selectionEnd;

              if (
                isClipboardShortcut(event.key, {
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  shiftKey: event.shiftKey,
                })
              ) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }

              const pair = insertAutoClosePair(value, start, end, event.key);
              if (pair) {
                event.preventDefault();
                onChange(pair.value);
                requestAnimationFrame(() => {
                  if (!editorRef.current) return;
                  editorRef.current.focus();
                  editorRef.current.selectionStart = pair.selectionStart;
                  editorRef.current.selectionEnd = pair.selectionEnd;
                });
                return;
              }

              const closingPosition = getClosingDelimiterSkipPosition(value, start, end, event.key);
              if (closingPosition !== null) {
                event.preventDefault();
                editorRef.current?.setSelectionRange(closingPosition, closingPosition);
                return;
              }

              if (event.key !== 'Tab') return;
              event.preventDefault();
              const nextValue = `${value.slice(0, start)}  ${value.slice(end)}`;
              onChange(nextValue);
              requestAnimationFrame(() => {
                if (!editorRef.current) return;
                editorRef.current.focus();
                editorRef.current.selectionStart = start + 2;
                editorRef.current.selectionEnd = start + 2;
              });
            }}
            onScroll={(event) => {
              if (highlightRef.current) {
                highlightRef.current.scrollTop = event.currentTarget.scrollTop;
                highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }
              if (lineNumbersRef.current) {
                lineNumbersRef.current.scrollTop = event.currentTarget.scrollTop;
              }
            }}
            placeholder="Escribe tu código en Python 3 aquí..."
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={disabled}
          />
        </div>
      </div>
    </article>
  );
}

function RivalCodeBoard({
  player,
  status,
  score,
  sourceCode,
  isRevealed,
  isCompact,
}: {
  player: RoomPlayerSummary;
  status: MatchSyncPayload['players'][string];
  score: PlayerScore | undefined;
  sourceCode: string | undefined;
  isRevealed: boolean;
  isCompact: boolean;
}) {
  return (
    <article
      className={`duel-code-board duel-rival-code-board ${isCompact ? 'duel-code-board-compact' : ''}`}
    >
      <header className="duel-code-board-header">
        <div className="min-w-0">
          <h3 className="duel-code-player-name truncate">{player.gamertag}</h3>
          <span className="duel-code-player-status">
            {status === 'connected' ? 'En línea' : 'Desconectado'}
          </span>
        </div>
        <span className="duel-code-score">
          {score?.score ?? 0}
          <small> pts</small>
        </span>
      </header>
      <div className="duel-rival-code-frame">
        {sourceCode === undefined ? (
          <p className="duel-code-sync-status">Sincronizando código…</p>
        ) : (
          <pre
            aria-label={`Código en vivo de ${player.gamertag}${isRevealed ? '' : ', desenfocado'}`}
            className={`duel-rival-code ${isRevealed ? '' : 'duel-code-blurred'}`}
            dangerouslySetInnerHTML={{ __html: highlightPython(sourceCode) || ' ' }}
          />
        )}
        {!isRevealed && <span className="duel-code-blur-badge">Código desenfocado</span>}
      </div>
    </article>
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
