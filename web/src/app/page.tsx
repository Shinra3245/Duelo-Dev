'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { api } from '@/lib/api';
import { registerGuestSessionCleanup } from '@/lib/guest-session';
import type {
  UserProfile,
  MatchConfig,
  ProblemCategory,
  PuntosMatchConfig,
  RondasMatchConfig,
} from '@duelodev/shared';

const PILOT_CATEGORIES: ProblemCategory[] = ['muy_facil', 'facil', 'facil_medio'];
type AccessMode = 'register' | 'login' | 'guest';

gsap.registerPlugin(useGSAP);

const DuelArenaCanvas = dynamic(
  () => import('@/components/duel-arena/DuelArenaCanvas').then((module) => module.DuelArenaCanvas),
  {
    ssr: false,
    loading: () => <div className="duel-arena-loading" aria-hidden="true" />,
  },
);

export default function Home() {
  const router = useRouter();
  const landingRef = useRef<HTMLElement>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Auth state
  const [accessMode, setAccessMode] = useState<AccessMode>('register');
  const [gamertag, setGamertag] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [conversionEmail, setConversionEmail] = useState('');
  const [conversionPassword, setConversionPassword] = useState('');
  const [error, setError] = useState('');

  // Room state
  const [roomCode, setRoomCode] = useState('');

  // Loading states
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isConvertingGuest, setIsConvertingGuest] = useState(false);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [isJoiningRoom, setIsJoiningRoom] = useState(false);

  useGSAP(
    () => {
      const media = gsap.matchMedia();

      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap
          .timeline({ defaults: { duration: 0.55, ease: 'power2.out' } })
          .from('[data-landing-item]', {
            autoAlpha: 0,
            y: 18,
            stagger: 0.07,
          });

        gsap.to('[data-landing-orb="primary"]', {
          x: 18,
          y: 14,
          duration: 6,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
        });
        gsap.to('[data-landing-orb="secondary"]', {
          x: -16,
          y: -12,
          duration: 7,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
        });
      });

      return () => media.revert();
    },
    { dependencies: [loading], revertOnUpdate: true, scope: landingRef },
  );

  useEffect(() => {
    api.auth
      .me()
      .then((res) => setUser(res.user))
      .catch((err: unknown) => {
        setUser(null);
        if (!isAuthStatus(err)) {
          setLoadError(getFriendlyErrorMessage(err, 'No se pudo conectar con el servidor.'));
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user || user.role !== 'guest') return;
    return registerGuestSessionCleanup();
  }, [user]);

  const handleAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoggingIn(true);
    try {
      const res =
        accessMode === 'guest'
          ? await api.auth.guest(gamertag)
          : accessMode === 'register'
            ? await api.auth.register({ email, password, gamertag })
            : await api.auth.login({ email, password });
      setUser(res.user);
      setPassword('');
    } catch (err: unknown) {
      setError(getFriendlyErrorMessage(err, 'No se pudo completar el acceso'));
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.auth.logout();
      setUser(null);
    } catch (err) {
      console.error(err);
    }
  };

  const handleConvertGuest = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setIsConvertingGuest(true);
    try {
      const res = await api.auth.convertGuest({
        email: conversionEmail,
        password: conversionPassword,
      });
      setUser(res.user);
      setConversionEmail('');
      setConversionPassword('');
    } catch (err: unknown) {
      setError(getFriendlyErrorMessage(err, 'No se pudo guardar la cuenta'));
    } finally {
      setIsConvertingGuest(false);
    }
  };

  const handleCreateRoom = async (mode: 'puntos' | 'rondas') => {
    setError('');
    setIsCreatingRoom(true);
    try {
      let config: MatchConfig;
      if (mode === 'puntos') {
        config = {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: PILOT_CATEGORIES,
          time_per_problem_s: 300,
        } as PuntosMatchConfig;
      } else {
        config = {
          mode: 'rondas',
          max_players: 2,
          num_problems: 3,
          categories: PILOT_CATEGORIES,
          target: 3,
          match_duration_s: 600,
        } as RondasMatchConfig;
      }

      const res = await api.rooms.create({ config });
      router.push(`/room/${res.room_code}`);
    } catch (err: unknown) {
      setError(getFriendlyErrorMessage(err, 'Error al crear la sala'));
      setIsCreatingRoom(false); // Only reset if error, if success we are redirecting
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomCode || !user) return;
    setError('');
    setIsJoiningRoom(true);
    try {
      const res = await api.rooms.join(roomCode.toUpperCase(), { gamertag: user.gamertag });
      router.push(`/room/${res.room_code}`);
    } catch (err: unknown) {
      setError(getFriendlyErrorMessage(err, 'Error al unirse a la sala'));
      setIsJoiningRoom(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-200">
        <div className="flex items-center gap-3 text-sm font-medium">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-cyan-300" />
          Preparando DueloDev...
        </div>
      </div>
    );
  }

  return (
    <main
      ref={landingRef}
      className="relative min-h-screen overflow-hidden bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 sm:py-10 lg:px-10"
    >
      <div
        aria-hidden="true"
        data-landing-orb="primary"
        className="pointer-events-none absolute -left-32 -top-32 h-80 w-80 will-change-transform rounded-full bg-cyan-400/20 blur-3xl"
      />
      <div
        aria-hidden="true"
        data-landing-orb="secondary"
        className="pointer-events-none absolute -bottom-40 -right-20 h-96 w-96 will-change-transform rounded-full bg-indigo-500/20 blur-3xl"
      />
      <div className="relative mx-auto grid w-full max-w-6xl gap-6 lg:grid-cols-[1.08fr_0.92fr] lg:items-stretch">
        <section
          data-landing-item
          className="flex flex-col justify-between rounded-3xl border border-white/10 bg-white/[0.07] p-6 shadow-2xl shadow-black/20 backdrop-blur sm:p-10"
        >
          <div data-landing-item className="landing-arena-frame">
            <div className="landing-arena-caption">
              <span>DUEL CORE // 01</span>
              <span>2 PLAYERS · 1 PROBLEM</span>
            </div>
            <DuelArenaCanvas className="landing-arena-canvas" />
            <div className="landing-arena-footer">
              <span className="landing-arena-pulse" />
              <span>Juez Python listo</span>
              <span className="landing-arena-divider" />
              <span>WebSocket sincronizado</span>
            </div>
          </div>
          <div>
            <div data-landing-item className="mb-7 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-300 font-black text-slate-950 shadow-lg shadow-cyan-400/20">
                D
              </span>
              <div>
                <p className="text-sm font-bold tracking-[0.18em] text-cyan-200">DUELODEV</p>
                <p className="text-xs text-slate-400">Torneo de programación en tiempo real</p>
              </div>
            </div>
            <p
              data-landing-item
              className="mb-3 inline-flex rounded-full border border-cyan-300/25 bg-cyan-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-cyan-200"
            >
              Modo torneo local
            </p>
            <h1
              data-landing-item
              className="max-w-xl text-4xl font-black leading-tight tracking-tight text-white sm:text-6xl"
            >
              Piensa rápido.
              <span className="block bg-gradient-to-r from-cyan-200 via-sky-300 to-indigo-300 bg-clip-text text-transparent">
                Programa mejor.
              </span>
            </h1>
            <p
              data-landing-item
              className="mt-5 max-w-xl text-base leading-7 text-slate-300 sm:text-lg"
            >
              Resuelve problemas, recibe veredictos del juez y sigue el marcador de tu sala sin
              perder el ritmo del duelo.
            </p>

            <ol data-landing-item className="mt-8 space-y-4 text-sm text-slate-200">
              <li className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/10 font-bold text-cyan-200 ring-1 ring-white/10">
                  1
                </span>
                <span className="pt-1">
                  Ingresa con un gamertag para identificarte durante el duelo.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/10 font-bold text-cyan-200 ring-1 ring-white/10">
                  2
                </span>
                <span className="pt-1">
                  Únete a la sala con el código que te entregue el organizador.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/10 font-bold text-cyan-200 ring-1 ring-white/10">
                  3
                </span>
                <span className="pt-1">
                  Escribe tu solución en Python 3 y observa el resultado al instante.
                </span>
              </li>
            </ol>
          </div>

          <div data-landing-item className="mt-10 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4 transition-transform duration-200 motion-safe:hover:-translate-y-1">
              <h2 className="font-bold text-emerald-200">Puntos</h2>
              <p className="mt-1 text-sm leading-6 text-emerald-100/80">
                Acumula puntos y casos resueltos durante la partida.
              </p>
            </div>
            <div className="rounded-2xl border border-indigo-300/20 bg-indigo-300/10 p-4 transition-transform duration-200 motion-safe:hover:-translate-y-1">
              <h2 className="font-bold text-indigo-200">Rondas</h2>
              <p className="mt-1 text-sm leading-6 text-indigo-100/80">
                Supera problemas consecutivos y mantén tu posición en el marcador.
              </p>
            </div>
          </div>
        </section>

        <section
          data-landing-item
          className="rounded-3xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl shadow-black/20 sm:p-8"
        >
          <div className="mb-7">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">
              Acceso de jugador
            </p>
            <h2 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              Entrar al torneo
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Usa un nombre visible para tus rivales y el código de sala del organizador.
            </p>
          </div>

          {loadError && (
            <div className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {loadError}
            </div>
          )}

          {error && (
            <div className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium leading-6 text-rose-800">
              {error}
            </div>
          )}

          {!user ? (
            <>
              <div className="mb-5 grid grid-cols-3 gap-2 rounded-2xl bg-slate-100 p-1">
                {(
                  [
                    ['register', 'Registrarse'],
                    ['login', 'Ingresar'],
                    ['guest', 'Invitado'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setAccessMode(mode);
                      setError('');
                    }}
                    className={`rounded-xl px-2 py-2 text-xs font-bold transition ${
                      accessMode === mode
                        ? 'bg-slate-950 text-white shadow'
                        : 'text-slate-600 hover:bg-white'
                    } motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-[0.98]`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <form onSubmit={handleAccess} className="space-y-5">
                {accessMode !== 'guest' && (
                  <div>
                    <label className="mb-2 block text-sm font-bold text-slate-800" htmlFor="email">
                      Correo electrónico
                    </label>
                    <input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-base font-semibold text-slate-950 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white"
                      placeholder="tu-correo@ejemplo.com"
                      autoComplete="email"
                      required
                    />
                  </div>
                )}

                {accessMode !== 'login' && (
                  <div>
                    <label
                      className="mb-2 block text-sm font-bold text-slate-800"
                      htmlFor="gamertag"
                    >
                      Gamertag
                    </label>
                    <input
                      id="gamertag"
                      type="text"
                      value={gamertag}
                      onChange={(e) => setGamertag(e.target.value)}
                      className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-base font-semibold text-slate-950 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white"
                      placeholder="Ej. ninja-dev"
                      required
                      pattern={'^[A-Za-z0-9\\-]{3,20}$'}
                      title="De 3 a 20 caracteres alfanuméricos o guiones"
                    />
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      Entre 3 y 20 caracteres. Usa letras, números o guiones.
                    </p>
                  </div>
                )}

                {accessMode !== 'guest' && (
                  <div>
                    <label
                      className="mb-2 block text-sm font-bold text-slate-800"
                      htmlFor="password"
                    >
                      Contraseña
                    </label>
                    <input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-base font-semibold text-slate-950 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white"
                      placeholder="Mínimo 8 caracteres"
                      autoComplete={accessMode === 'register' ? 'new-password' : 'current-password'}
                      minLength={8}
                      required
                    />
                  </div>
                )}

                <p className="rounded-2xl border border-indigo-100 bg-indigo-50 p-3 text-xs leading-5 text-indigo-900">
                  {accessMode === 'register'
                    ? 'Para el torneo recomendamos registrarte: tu gamertag quedará vinculado a tu cuenta.'
                    : accessMode === 'login'
                      ? 'Ingresa con la cuenta registrada que usarás durante el torneo.'
                      : 'El modo invitado sólo pide un gamertag y es provisional.'}
                </p>

                <button
                  type="submit"
                  disabled={isLoggingIn}
                  aria-busy={isLoggingIn}
                  className="w-full rounded-2xl bg-indigo-600 px-4 py-3.5 font-bold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-[0.99]"
                >
                  {isLoggingIn
                    ? 'Procesando...'
                    : accessMode === 'register'
                      ? 'Crear cuenta y entrar'
                      : accessMode === 'login'
                        ? 'Entrar con mi cuenta'
                        : 'Jugar como Invitado'}
                </button>
              </form>
            </>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between gap-4 rounded-2xl border border-indigo-100 bg-indigo-50 p-4">
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-indigo-600">
                    {user.role === 'guest' ? 'Invitado' : 'Cuenta registrada'}
                  </p>
                  <p className="mt-1 break-all font-mono text-lg font-black leading-6 text-slate-950">
                    {user.gamertag}
                  </p>
                </div>
                <button
                  onClick={handleLogout}
                  className="shrink-0 rounded-xl px-3 py-2 text-sm font-bold text-rose-600 transition hover:bg-rose-100 hover:text-rose-800"
                >
                  Salir
                </button>
              </div>

              <div className="border-t border-slate-200 pt-5">
                <h2 className="mb-3 text-xl font-black text-slate-950">Crear Sala</h2>
                <p className="mb-4 text-sm leading-6 text-slate-600">
                  Disponible para el anfitrión del torneo. Elige el formato de la partida.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => handleCreateRoom('puntos')}
                    disabled={isCreatingRoom}
                    aria-busy={isCreatingRoom}
                    className="rounded-2xl bg-emerald-600 px-4 py-3 font-bold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-[0.98]"
                  >
                    {isCreatingRoom ? 'Creando...' : 'Puntos'}
                  </button>
                  <button
                    onClick={() => handleCreateRoom('rondas')}
                    disabled={isCreatingRoom}
                    aria-busy={isCreatingRoom}
                    className="rounded-2xl bg-indigo-600 px-4 py-3 font-bold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-[0.98]"
                  >
                    {isCreatingRoom ? 'Creando...' : 'Rondas'}
                  </button>
                </div>
              </div>

              {user.role === 'guest' && (
                <div className="border-t border-slate-200 pt-5">
                  <h2 className="mb-2 text-xl font-black text-slate-950">Conserva tu gamertag</h2>
                  <p className="mb-4 text-sm leading-6 text-slate-600">
                    Registra este invitado para usar el mismo nombre durante todo el torneo y
                    conservar su historial.
                  </p>
                  <form onSubmit={handleConvertGuest} className="space-y-4">
                    <label
                      className="block text-sm font-bold text-slate-800"
                      htmlFor="convert-email"
                    >
                      Correo electrónico
                      <input
                        id="convert-email"
                        type="email"
                        value={conversionEmail}
                        onChange={(event) => setConversionEmail(event.target.value)}
                        className="mt-2 w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-base font-semibold text-slate-950 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white"
                        autoComplete="email"
                        required
                      />
                    </label>
                    <label
                      className="block text-sm font-bold text-slate-800"
                      htmlFor="convert-password"
                    >
                      Contraseña
                      <input
                        id="convert-password"
                        type="password"
                        value={conversionPassword}
                        onChange={(event) => setConversionPassword(event.target.value)}
                        className="mt-2 w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-base font-semibold text-slate-950 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white"
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={isConvertingGuest}
                      aria-busy={isConvertingGuest}
                      className="w-full rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 font-bold text-indigo-800 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isConvertingGuest ? 'Guardando...' : 'Registrar mi cuenta'}
                    </button>
                  </form>
                </div>
              )}

              <div className="border-t border-slate-200 pt-5">
                <h2 className="mb-2 text-xl font-black text-slate-950">Unirse a sala</h2>
                <p className="mb-4 text-sm leading-6 text-slate-600">
                  Escribe el código de seis caracteres que te compartió el organizador.
                </p>
                <form onSubmit={handleJoinRoom} className="flex flex-col gap-3 sm:flex-row">
                  <input
                    type="text"
                    value={roomCode}
                    onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                    aria-label="Código de sala"
                    className="min-w-0 flex-1 rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-center font-mono text-lg font-black uppercase tracking-[0.18em] text-slate-950 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white sm:text-left"
                    placeholder="CÓDIGO"
                    maxLength={6}
                    required
                  />
                  <button
                    type="submit"
                    disabled={isJoiningRoom}
                    aria-busy={isJoiningRoom}
                    className="rounded-2xl bg-slate-950 px-5 py-3 font-bold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-[0.98]"
                  >
                    {isJoiningRoom ? 'Uniendo...' : 'Unirse'}
                  </button>
                </form>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function isAuthStatus(err: unknown) {
  const status = (err as { status?: number }).status;
  return status === 401 || status === 403;
}

function getFriendlyErrorMessage(err: unknown, fallback: string) {
  const message = (err as Error).message || fallback;
  if (message === 'Failed to fetch' || message.toLowerCase().includes('fetch')) {
    return 'No se pudo conectar con el servidor. Verifica que este equipo esté en el mismo Wi‑Fi del torneo y que la URL LAN mostrada por el servidor sea la correcta.';
  }
  return message;
}
