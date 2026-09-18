'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type {
  UserProfile,
  MatchConfig,
  ProblemCategory,
  PuntosMatchConfig,
  RondasMatchConfig,
} from '@duelodev/shared';

const PILOT_CATEGORIES: ProblemCategory[] = ['muy_facil', 'facil', 'facil_medio'];

export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Auth state
  const [gamertag, setGamertag] = useState('');
  const [error, setError] = useState('');

  // Room state
  const [roomCode, setRoomCode] = useState('');

  // Loading states
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [isJoiningRoom, setIsJoiningRoom] = useState(false);

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

  const handleGuestLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoggingIn(true);
    try {
      const res = await api.auth.guest(gamertag);
      setUser(res.user);
    } catch (err: unknown) {
      setError(getFriendlyErrorMessage(err, 'Error al iniciar sesión'));
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
    return <div className="flex min-h-screen items-center justify-center">Cargando...</div>;
  }

  return (
    <main className="flex min-h-screen flex-col items-center p-8 lg:p-24 bg-gray-50">
      <div className="w-full max-w-4xl grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="bg-white rounded-xl shadow-md p-8">
          <p className="text-sm font-semibold text-blue-700 mb-2">Modo torneo local</p>
          <h1 className="text-3xl font-bold mb-4 text-gray-800">DueloDev</h1>
          <p className="text-gray-600 mb-6">
            Crea duelos de programación para dos jugadores, comparte el código de sala y deja que el
            juez evalúe las soluciones en tiempo real.
          </p>

          <ol className="space-y-3 text-sm text-gray-700">
            <li className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-100 font-bold text-blue-700">
                1
              </span>
              <span>Ingresa con un gamertag de invitado para identificarte durante el duelo.</span>
            </li>
            <li className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-100 font-bold text-blue-700">
                2
              </span>
              <span>Crea una sala en modo Puntos o Rondas y comparte el código con tu rival.</span>
            </li>
            <li className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-100 font-bold text-blue-700">
                3
              </span>
              <span>
                Cuando ambos estén dentro, el anfitrión inicia la partida y se envía Python 3.
              </span>
            </li>
          </ol>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <h2 className="font-semibold text-green-900">Puntos</h2>
              <p className="mt-1 text-sm text-green-800">
                Gana quien obtenga primero Accepted en el problema activo.
              </p>
            </div>
            <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
              <h2 className="font-semibold text-purple-900">Rondas</h2>
              <p className="mt-1 text-sm text-purple-800">
                Se acumulan puntos a través de varios problemas del duelo.
              </p>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-xl shadow-md p-8">
          <h2 className="text-2xl font-bold mb-6 text-center text-gray-800">Entrar al torneo</h2>

          {loadError && (
            <div className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {loadError}
            </div>
          )}

          {error && <div className="mb-4 p-3 bg-red-100 text-red-700 rounded text-sm">{error}</div>}

          {!user ? (
            <form onSubmit={handleGuestLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Gamertag</label>
                <input
                  type="text"
                  value={gamertag}
                  onChange={(e) => setGamertag(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Ej. ninja-dev"
                  required
                  pattern={'^[A-Za-z0-9\\-]{3,20}$'}
                  title="De 3 a 20 caracteres alfanuméricos o guiones"
                />
              </div>
              <button
                type="submit"
                disabled={isLoggingIn}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded transition-colors"
              >
                {isLoggingIn ? 'Iniciando...' : 'Jugar como Invitado'}
              </button>
            </form>
          ) : (
            <div className="space-y-6">
              <div className="flex justify-between items-center bg-gray-100 p-3 rounded">
                <div>
                  <p className="text-sm text-gray-500">Conectado como</p>
                  <p className="font-bold text-gray-800">{user.gamertag}</p>
                </div>
                <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800">
                  Salir
                </button>
              </div>

              <div className="pt-4 border-t border-gray-200">
                <h2 className="text-xl font-semibold mb-4 text-gray-800">Crear Sala</h2>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => handleCreateRoom('puntos')}
                    disabled={isCreatingRoom}
                    className="bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded transition-colors"
                  >
                    {isCreatingRoom ? 'Creando...' : 'Puntos'}
                  </button>
                  <button
                    onClick={() => handleCreateRoom('rondas')}
                    disabled={isCreatingRoom}
                    className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded transition-colors"
                  >
                    {isCreatingRoom ? 'Creando...' : 'Rondas'}
                  </button>
                </div>
              </div>

              <div className="pt-4 border-t border-gray-200">
                <h2 className="text-xl font-semibold mb-4 text-gray-800">Unirse a Sala</h2>
                <form onSubmit={handleJoinRoom} className="flex gap-2">
                  <input
                    type="text"
                    value={roomCode}
                    onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 uppercase"
                    placeholder="CÓDIGO"
                    maxLength={6}
                    required
                  />
                  <button
                    type="submit"
                    disabled={isJoiningRoom}
                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded transition-colors"
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
