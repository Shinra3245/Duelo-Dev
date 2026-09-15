import { randomUUID } from 'node:crypto';
import type { RefreshTokenEntity, UserEntity } from '@duelodev/shared';
import type {
  CreateRefreshTokenInput,
  CreateUserInput,
  RefreshTokenRepository,
  UpdateUserInput,
  UserRepository,
} from './types.js';

/**
 * Repositorio de usuarios en memoria para pruebas e inicialización sin base de datos viva.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, UserEntity>();

  async findById(id: string): Promise<UserEntity | null> {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    const normalized = email.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.email && user.email.toLowerCase() === normalized) {
        return { ...user };
      }
    }
    return null;
  }

  async findByGamertag(gamertag: string): Promise<UserEntity | null> {
    const normalized = gamertag.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.gamertag.toLowerCase() === normalized) {
        return { ...user };
      }
    }
    return null;
  }

  async create(input: CreateUserInput): Promise<UserEntity> {
    const now = new Date().toISOString();
    const user: UserEntity = {
      id: input.id ?? randomUUID(),
      email: input.email ? input.email.trim().toLowerCase() : null,
      password_hash: input.password_hash ?? null,
      gamertag: input.gamertag.trim(),
      role: input.role,
      created_at: input.created_at ?? now,
      updated_at: input.updated_at ?? now,
    };

    this.users.set(user.id, user);
    return { ...user };
  }

  async update(id: string, input: UpdateUserInput): Promise<UserEntity | null> {
    const existing = this.users.get(id);
    if (!existing) {
      return null;
    }

    const updated: UserEntity = {
      ...existing,
      ...(input.email !== undefined
        ? { email: input.email ? input.email.trim().toLowerCase() : null }
        : {}),
      ...(input.password_hash !== undefined ? { password_hash: input.password_hash } : {}),
      ...(input.gamertag !== undefined ? { gamertag: input.gamertag.trim() } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      updated_at: input.updated_at ?? new Date().toISOString(),
    };

    this.users.set(id, updated);
    return { ...updated };
  }

  async count(): Promise<number> {
    return this.users.size;
  }

  /** Limpia todos los registros (útil entre pruebas). */
  clear(): void {
    this.users.clear();
  }
}

/**
 * Repositorio de refresh tokens en memoria con soporte de rotación y detección de reuso familiar.
 */
export class InMemoryRefreshTokenRepository implements RefreshTokenRepository {
  private readonly tokens = new Map<string, RefreshTokenEntity>();
  private readonly tokenHashToId = new Map<string, string>();

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenEntity> {
    const now = new Date().toISOString();
    const token: RefreshTokenEntity = {
      id: input.id ?? randomUUID(),
      user_id: input.user_id,
      token_hash: input.token_hash,
      family_id: input.family_id,
      expires_at: input.expires_at,
      revoked: input.revoked ?? false,
      created_at: input.created_at ?? now,
    };

    this.tokens.set(token.id, token);
    this.tokenHashToId.set(token.token_hash, token.id);
    return { ...token };
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenEntity | null> {
    const id = this.tokenHashToId.get(tokenHash);
    if (!id) {
      return null;
    }
    const token = this.tokens.get(id);
    return token ? { ...token } : null;
  }

  async revoke(id: string): Promise<void> {
    const token = this.tokens.get(id);
    if (token) {
      token.revoked = true;
    }
  }

  async revokeFamily(userId: string, familyId: string): Promise<number> {
    let count = 0;
    for (const token of this.tokens.values()) {
      if (token.user_id === userId && token.family_id === familyId) {
        if (!token.revoked) {
          token.revoked = true;
          count++;
        }
      }
    }
    return count;
  }

  async deleteExpired(nowIso?: string): Promise<number> {
    const reference = nowIso ? new Date(nowIso).getTime() : Date.now();
    let deleted = 0;

    for (const [id, token] of this.tokens.entries()) {
      if (new Date(token.expires_at).getTime() <= reference) {
        this.tokenHashToId.delete(token.token_hash);
        this.tokens.delete(id);
        deleted++;
      }
    }

    return deleted;
  }

  /** Limpia todos los tokens (útil entre pruebas). */
  clear(): void {
    this.tokens.clear();
    this.tokenHashToId.clear();
  }
}
