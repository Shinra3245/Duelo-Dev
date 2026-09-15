import { randomBytes } from 'node:crypto';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  type CreateRoomRequest,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type RoomCreatedResponse,
  type RoomDetailsResponse,
  type RoomPlayerSummary,
  type StartRoomResponse,
} from '@duelodev/shared';

import { HttpError } from '../plugins/body-parser.js';
import type { RoomRepository, UserRepository } from '../repositories/types.js';
import type { AuthService } from './auth.js';

const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Genera un código legible de sala alfanumérico en mayúsculas (doc 04 §2).
 */
export function generateRoomCode(length = 6): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

export interface RoomServiceOptions {
  roomRepo: RoomRepository;
  userRepo: UserRepository;
  authService: AuthService;
}

/**
 * Servicio de salas y ciclo de vida de partidas en lobby (doc 04 §2).
 */
export class RoomService {
  private readonly roomRepo: RoomRepository;
  private readonly userRepo: UserRepository;
  private readonly authService: AuthService;

  constructor(options: RoomServiceOptions) {
    this.roomRepo = options.roomRepo;
    this.userRepo = options.userRepo;
    this.authService = options.authService;
  }

  /**
   * Crea una nueva sala de juego. Requiere usuario registrado (doc 04 §2).
   */
  async createRoom(
    userId: string,
    req: CreateRoomRequest,
    baseUrl = 'http://localhost:3000',
  ): Promise<RoomCreatedResponse> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
    }

    if (user.role !== 'user') {
      throw new HttpError(
        403,
        ERROR_CODES.FORBIDDEN,
        'Solo los usuarios registrados pueden crear salas.',
      );
    }

    // Generar código de sala único
    let roomCode = '';
    for (let attempts = 0; attempts < 10; attempts++) {
      const candidate = generateRoomCode(6);
      const existing = await this.roomRepo.findMatchByRoomCode(candidate);
      if (!existing) {
        roomCode = candidate;
        break;
      }
    }

    if (!roomCode) {
      throw new HttpError(500, ERROR_CODES.INTERNAL, ERROR_MESSAGES.INTERNAL);
    }

    const match = await this.roomRepo.createMatch({
      room_code: roomCode,
      mode: req.config.mode,
      status: 'lobby',
      config: req.config,
      host_id: user.id,
      state_version: 1,
      admission_seq: 0,
      winner_ids: [],
    });

    // Añadir al host como primer jugador en la sala
    await this.roomRepo.addPlayer({
      match_id: match.id,
      user_id: user.id,
      is_ready: true,
      connection_status: 'connected',
    });

    const shareUrl = `${baseUrl.replace(/\/+$/, '')}/room/${match.room_code}`;

    return {
      match_id: match.id,
      room_code: match.room_code,
      share_url: shareUrl,
      config: match.config,
      created_at: match.created_at,
    };
  }

  /**
   * Une a un jugador o invitado a la sala (doc 04 §2).
   * Si no está autenticado, crea un nuevo usuario 'guest' y devuelve sus tokens para Set-Cookie.
   */
  async joinRoom(
    rawRoomCode: string,
    req: JoinRoomRequest,
    authenticatedUserId?: string,
  ): Promise<{
    response: JoinRoomResponse;
    newGuestTokens?: { accessToken: string; refreshToken: string };
  }> {
    const roomCode = rawRoomCode.trim().toUpperCase();
    const match = await this.roomRepo.findMatchByRoomCode(roomCode);

    if (!match || match.status === 'finished' || match.status === 'abandoned') {
      throw new HttpError(404, ERROR_CODES.ROOM_NOT_FOUND, ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    if (match.status !== 'lobby') {
      throw new HttpError(
        409,
        ERROR_CODES.ROOM_ALREADY_STARTED,
        ERROR_MESSAGES.ROOM_ALREADY_STARTED,
      );
    }

    const players = await this.roomRepo.findPlayersByMatchId(match.id);

    // Si el usuario ya está autenticado y ya forma parte de la sala (unión idempotente)
    if (authenticatedUserId) {
      const existingPlayer = players.find((p) => p.user_id === authenticatedUserId);
      if (existingPlayer) {
        const user = await this.userRepo.findById(authenticatedUserId);
        return {
          response: {
            match_id: match.id,
            user_id: authenticatedUserId,
            gamertag: user ? user.gamertag : req.gamertag,
            role: match.host_id === authenticatedUserId ? 'host' : 'player',
            room_code: match.room_code,
          },
        };
      }
    }

    // Verificar capacidad máxima
    if (players.length >= match.config.max_players) {
      throw new HttpError(409, ERROR_CODES.ROOM_FULL, ERROR_MESSAGES.ROOM_FULL);
    }

    // Verificar unicidad de gamertag en la sala (comparación case-insensitive, doc 04 §2)
    const normalizedGamertag = req.gamertag.trim().toLowerCase();
    for (const p of players) {
      const u = await this.userRepo.findById(p.user_id);
      if (u && u.gamertag.toLowerCase() === normalizedGamertag) {
        if (u.id !== authenticatedUserId) {
          throw new HttpError(409, ERROR_CODES.GAMERTAG_TAKEN, ERROR_MESSAGES.GAMERTAG_TAKEN);
        }
      }
    }

    let finalUserId: string;
    let finalGamertag: string;
    let newGuestTokens: { accessToken: string; refreshToken: string } | undefined;

    if (authenticatedUserId) {
      const user = await this.userRepo.findById(authenticatedUserId);
      if (!user) {
        throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
      }
      finalUserId = user.id;
      finalGamertag = user.gamertag;
    } else {
      // Crear cuenta provisional de invitado (doc 04 §2)
      const guest = await this.authService.createGuest(req.gamertag);
      finalUserId = guest.user.id;
      finalGamertag = guest.user.gamertag;
      newGuestTokens = {
        accessToken: guest.accessToken,
        refreshToken: guest.refreshToken,
      };
    }

    await this.roomRepo.addPlayer({
      match_id: match.id,
      user_id: finalUserId,
      is_ready: true,
      connection_status: 'connected',
    });

    const role = match.host_id === finalUserId ? 'host' : 'player';

    return {
      response: {
        match_id: match.id,
        user_id: finalUserId,
        gamertag: finalGamertag,
        role,
        room_code: match.room_code,
      },
      ...(newGuestTokens ? { newGuestTokens } : {}),
    };
  }

  /**
   * Obtiene los detalles y miembros de la sala para un jugador miembro (doc 04 §2).
   */
  async getRoomDetails(
    rawRoomCode: string,
    requestingUserId?: string,
  ): Promise<RoomDetailsResponse> {
    const roomCode = rawRoomCode.trim().toUpperCase();
    const match = await this.roomRepo.findMatchByRoomCode(roomCode);

    if (!match || match.status === 'finished' || match.status === 'abandoned') {
      throw new HttpError(404, ERROR_CODES.ROOM_NOT_FOUND, ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    if (!requestingUserId) {
      throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
    }

    const players = await this.roomRepo.findPlayersByMatchId(match.id);
    const isMember =
      players.some((p) => p.user_id === requestingUserId) || match.host_id === requestingUserId;

    if (!isMember) {
      throw new HttpError(403, ERROR_CODES.FORBIDDEN, ERROR_MESSAGES.FORBIDDEN);
    }

    const playerSummaries: RoomPlayerSummary[] = [];
    for (const p of players) {
      const u = await this.userRepo.findById(p.user_id);
      playerSummaries.push({
        user_id: p.user_id,
        gamertag: u ? u.gamertag : 'Desconocido',
        is_ready: p.is_ready,
        is_host: p.user_id === match.host_id,
      });
    }

    return {
      match_id: match.id,
      room_code: match.room_code,
      status: match.status,
      config: match.config,
      host_id: match.host_id,
      players: playerSummaries,
      created_at: match.created_at,
    };
  }

  /**
   * Inicia la partida a petición del anfitrión de manera idempotente (doc 04 §2).
   */
  async startRoom(rawRoomCode: string, requestingUserId: string): Promise<StartRoomResponse> {
    const roomCode = rawRoomCode.trim().toUpperCase();
    const match = await this.roomRepo.findMatchByRoomCode(roomCode);

    if (!match || match.status === 'finished' || match.status === 'abandoned') {
      throw new HttpError(404, ERROR_CODES.ROOM_NOT_FOUND, ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    if (match.host_id !== requestingUserId) {
      throw new HttpError(403, ERROR_CODES.FORBIDDEN, ERROR_MESSAGES.FORBIDDEN);
    }

    // Idempotencia: si ya está iniciada, responder 200 con started: true
    if (match.status === 'running') {
      return {
        match_id: match.id,
        started: true,
        status: 'running',
      };
    }

    if (match.status === 'settling') {
      throw new HttpError(409, ERROR_CODES.CONFLICT, 'La partida está finalizando.');
    }

    const players = await this.roomRepo.findPlayersByMatchId(match.id);
    if (players.length < 2) {
      throw new HttpError(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        'Se necesitan al menos 2 jugadores para iniciar la partida.',
      );
    }

    await this.roomRepo.updateMatch(match.id, {
      status: 'running',
      started_at: new Date().toISOString(),
      state_version: match.state_version + 1,
    });

    return {
      match_id: match.id,
      started: true,
      status: 'running',
    };
  }
}
