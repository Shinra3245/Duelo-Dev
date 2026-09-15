import { randomBytes } from 'node:crypto';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  type ConvertGuestRequest,
  type LoginRequest,
  type RegisterRequest,
  type UserEntity,
  type UserProfile,
} from '@duelodev/shared';
import { HttpError } from '../plugins/body-parser.js';
import { ACCESS_TOKEN_MAX_AGE_S, REFRESH_TOKEN_MAX_AGE_S } from '../plugins/cookies.js';
import type { RefreshTokenRepository, UserRepository } from '../repositories/types.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  createAccessToken,
  generateFamilyId,
  generateSecureToken,
  hashToken,
  verifyAccessToken,
  type AccessTokenPayload,
} from './tokens.js';

export interface AuthResult {
  user: UserProfile;
  accessToken: string;
  refreshToken: string;
}

export interface AuthServiceOptions {
  userRepo: UserRepository;
  refreshTokenRepo: RefreshTokenRepository;
  authSecret: string;
  refreshTokenMaxAgeS?: number;
  accessTokenMaxAgeS?: number;
}

export function toUserProfile(user: UserEntity): UserProfile {
  return {
    id: user.id,
    email: user.email,
    gamertag: user.gamertag,
    role: user.role,
    created_at: user.created_at,
  };
}

/**
 * Servicio de autenticación, control de acceso y rotación de tokens (doc 04 §2).
 */
export class AuthService {
  private readonly userRepo: UserRepository;
  private readonly refreshTokenRepo: RefreshTokenRepository;
  private readonly authSecret: string;
  private readonly refreshTokenMaxAgeS: number;
  private readonly accessTokenMaxAgeS: number;

  constructor(options: AuthServiceOptions) {
    this.userRepo = options.userRepo;
    this.refreshTokenRepo = options.refreshTokenRepo;
    this.authSecret = options.authSecret;
    this.refreshTokenMaxAgeS = options.refreshTokenMaxAgeS ?? REFRESH_TOKEN_MAX_AGE_S;
    this.accessTokenMaxAgeS = options.accessTokenMaxAgeS ?? ACCESS_TOKEN_MAX_AGE_S;
  }

  /**
   * Registra una nueva cuenta de usuario con correo, contraseña y gamertag únicos.
   */
  async register(data: RegisterRequest): Promise<AuthResult> {
    const normalizedEmail = data.email.trim().toLowerCase();

    const existingEmail = await this.userRepo.findByEmail(normalizedEmail);
    if (existingEmail) {
      throw new HttpError(409, ERROR_CODES.EMAIL_TAKEN, ERROR_MESSAGES.EMAIL_TAKEN);
    }

    const existingGamertag = await this.userRepo.findByGamertag(data.gamertag);
    if (existingGamertag) {
      throw new HttpError(409, ERROR_CODES.GAMERTAG_TAKEN, ERROR_MESSAGES.GAMERTAG_TAKEN);
    }

    const passwordHash = await hashPassword(data.password);
    const user = await this.userRepo.create({
      email: normalizedEmail,
      password_hash: passwordHash,
      gamertag: data.gamertag,
      role: 'user',
    });

    return this.issueTokensForUser(user);
  }

  /**
   * Inicia sesión verificando credenciales con scrypt en tiempo constante.
   */
  async login(data: LoginRequest): Promise<AuthResult> {
    const normalizedEmail = data.email.trim().toLowerCase();
    const user = await this.userRepo.findByEmail(normalizedEmail);

    if (!user || !user.password_hash) {
      throw new HttpError(401, ERROR_CODES.INVALID_CREDENTIALS, ERROR_MESSAGES.INVALID_CREDENTIALS);
    }

    const valid = await verifyPassword(data.password, user.password_hash);
    if (!valid) {
      throw new HttpError(401, ERROR_CODES.INVALID_CREDENTIALS, ERROR_MESSAGES.INVALID_CREDENTIALS);
    }

    return this.issueTokensForUser(user);
  }

  /**
   * Rota el refresh token preservando family_id. Si detecta reuso de un token revocado,
   * invalida toda la familia (doc 04 §2, doc 05 §1).
   */
  async refresh(rawRefreshToken: string): Promise<AuthResult> {
    if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
      throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
    }

    const tokenHash = hashToken(rawRefreshToken);
    const token = await this.refreshTokenRepo.findByTokenHash(tokenHash);

    if (!token) {
      throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
    }

    if (token.revoked) {
      // Reuso detectado: revocación familiar completa por seguridad
      await this.refreshTokenRepo.revokeFamily(token.user_id, token.family_id);
      throw new HttpError(401, ERROR_CODES.REFRESH_REUSED, ERROR_MESSAGES.REFRESH_REUSED);
    }

    if (new Date(token.expires_at).getTime() <= Date.now()) {
      throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, 'Tu sesión ha expirado.');
    }

    // Invalida el token usado e inicia rotación
    await this.refreshTokenRepo.revoke(token.id);

    const user = await this.userRepo.findById(token.user_id);
    if (!user) {
      throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
    }

    // Genera un nuevo refresh token dentro de la misma familia
    const newRawRefreshToken = generateSecureToken();
    const expiresAt = new Date(Date.now() + this.refreshTokenMaxAgeS * 1000).toISOString();

    await this.refreshTokenRepo.create({
      user_id: user.id,
      token_hash: hashToken(newRawRefreshToken),
      family_id: token.family_id,
      expires_at: expiresAt,
    });

    const accessToken = createAccessToken(
      {
        userId: user.id,
        role: user.role,
        gamertag: user.gamertag,
      },
      this.authSecret,
      this.accessTokenMaxAgeS,
    );

    return {
      user: toUserProfile(user),
      accessToken,
      refreshToken: newRawRefreshToken,
    };
  }

  /**
   * Cierra la sesión revocando el refresh token durable en almacenamiento.
   */
  async logout(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
      return;
    }

    try {
      const tokenHash = hashToken(rawRefreshToken);
      const token = await this.refreshTokenRepo.findByTokenHash(tokenHash);
      if (token) {
        await this.refreshTokenRepo.revoke(token.id);
      }
    } catch {
      // Silencioso ante tokens malformados en cierre de sesión
    }
  }

  /**
   * Convierte un usuario invitado en cuenta registrada conservando su UUID (doc 04 §1).
   */
  async convertGuest(userId: string, data: ConvertGuestRequest): Promise<AuthResult> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, ERROR_MESSAGES.NOT_FOUND);
    }

    if (user.role !== 'guest') {
      throw new HttpError(409, ERROR_CODES.CONFLICT, 'El usuario ya es una cuenta registrada.');
    }

    const normalizedEmail = data.email.trim().toLowerCase();
    const existingEmail = await this.userRepo.findByEmail(normalizedEmail);
    if (existingEmail && existingEmail.id !== userId) {
      throw new HttpError(409, ERROR_CODES.EMAIL_TAKEN, ERROR_MESSAGES.EMAIL_TAKEN);
    }

    const passwordHash = await hashPassword(data.password);
    const updatedUser = await this.userRepo.update(userId, {
      email: normalizedEmail,
      password_hash: passwordHash,
      role: 'user',
    });

    if (!updatedUser) {
      throw new HttpError(500, ERROR_CODES.INTERNAL, ERROR_MESSAGES.INTERNAL);
    }

    return this.issueTokensForUser(updatedUser);
  }

  /**
   * Crea un usuario invitado provisional con gamertag válido.
   */
  async createGuest(gamertag?: string): Promise<AuthResult> {
    let chosenGamertag = gamertag?.trim();
    if (!chosenGamertag) {
      chosenGamertag = `guest-${randomBytes(3).toString('hex')}`;
    }

    const existing = await this.userRepo.findByGamertag(chosenGamertag);
    if (existing) {
      throw new HttpError(409, ERROR_CODES.GAMERTAG_TAKEN, ERROR_MESSAGES.GAMERTAG_TAKEN);
    }

    const user = await this.userRepo.create({
      gamertag: chosenGamertag,
      role: 'guest',
      email: null,
      password_hash: null,
    });

    return this.issueTokensForUser(user);
  }

  /**
   * Autentica y valida un access token firmado en la petición.
   */
  authenticateAccessToken(rawToken: string): AccessTokenPayload {
    const payload = verifyAccessToken(rawToken, this.authSecret);
    if (!payload) {
      throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
    }
    return payload;
  }

  private async issueTokensForUser(user: UserEntity): Promise<AuthResult> {
    const rawRefreshToken = generateSecureToken();
    const familyId = generateFamilyId();
    const expiresAt = new Date(Date.now() + this.refreshTokenMaxAgeS * 1000).toISOString();

    await this.refreshTokenRepo.create({
      user_id: user.id,
      token_hash: hashToken(rawRefreshToken),
      family_id: familyId,
      expires_at: expiresAt,
    });

    const accessToken = createAccessToken(
      {
        userId: user.id,
        role: user.role,
        gamertag: user.gamertag,
      },
      this.authSecret,
      this.accessTokenMaxAgeS,
    );

    return {
      user: toUserProfile(user),
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }
}
