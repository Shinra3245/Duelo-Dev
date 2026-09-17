'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type {
  UserProfile,
  MatchConfig,
  PuntosMatchConfig,
  RondasMatchConfig,
} from '@duelodev/shared';

export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // Auth state
  const [gamertag, setGamertag] = useState('');
  const [error, setError] = useState('');

  // Room state
  const [roomCode, setRoomCode] = useState('');

  useEffect(() => {
    api.auth
      .me()
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const handleGuestLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await api.auth.guest(gamertag);
      setUser(res.user);
    } catch (err: unknown) {
      setError((err as Error).message || 'Error al iniciar sesión');
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
    try {
      let config: MatchConfig;
      if (mode === 'puntos') {
        config = {
          mode: 'puntos',
          max_players: 2,
          num_problems: 1,
          categories: ['facil'],
          time_per_problem_s: 300,
        } as PuntosMatchConfig;
      } else {
        config = {
          mode: 'rondas',
          max_players: 2,
          num_problems: 3,
          categories: ['facil'],
          target: 3,
          match_duration_s: 600,
        } as RondasMatchConfig;
      }

      const res = await api.rooms.create({ config });
      router.push(`/room/${res.room_code}`);
    } catch (err: unknown) {
      setError((err as Error).message || 'Error al crear la sala');
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomCode || !user) return;
    setError('');
    try {
      const res = await api.rooms.join(roomCode.toUpperCase(), { gamertag: user.gamertag });
      router.push(`/room/${res.room_code}`);
    } catch (err: unknown) {
      setError((err as Error).message || 'Error al unirse a la sala');
    }
  };

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center">Cargando...</div>;
  }

  return (
    <main className="flex min-h-screen flex-col items-center p-8 lg:p-24 bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-xl shadow-md p-8">
        <h1 className="text-3xl font-bold mb-6 text-center text-gray-800">DueloDev</h1>

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
                pattern="^[A-Za-z0-9-]{3,20}$"
                title="De 3 a 20 caracteres alfanuméricos o guiones"
              />
            </div>
            <button
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition-colors"
            >
              Jugar como Invitado
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
                  className="bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded transition-colors"
                >
                  Puntos
                </button>
                <button
                  onClick={() => handleCreateRoom('rondas')}
                  className="bg-purple-600 hover:bg-purple-700 text-white font-semibold py-2 px-4 rounded transition-colors"
                >
                  Rondas
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
                  className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded transition-colors"
                >
                  Unirse
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
