import type { RefreshTokenEntity, UserEntity, UserRole } from '@duelodev/shared';

export interface CreateUserInput {
  id?: string;
  email?: string | null;
  password_hash?: string | null;
  gamertag: string;
  role: UserRole;
  created_at?: string;
  updated_at?: string;
}

export interface UpdateUserInput {
  email?: string | null;
  password_hash?: string | null;
  gamertag?: string;
  role?: UserRole;
  updated_at?: string;
}

export interface UserRepository {
  findById(id: string): Promise<UserEntity | null>;
  findByEmail(email: string): Promise<UserEntity | null>;
  findByGamertag(gamertag: string): Promise<UserEntity | null>;
  create(input: CreateUserInput): Promise<UserEntity>;
  update(id: string, input: UpdateUserInput): Promise<UserEntity | null>;
  count(): Promise<number>;
}

export interface CreateRefreshTokenInput {
  id?: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: string;
  revoked?: boolean;
  created_at?: string;
}

export interface RefreshTokenRepository {
  create(input: CreateRefreshTokenInput): Promise<RefreshTokenEntity>;
  findByTokenHash(tokenHash: string): Promise<RefreshTokenEntity | null>;
  revoke(id: string): Promise<void>;
  revokeFamily(userId: string, familyId: string): Promise<number>;
  deleteExpired(nowIso?: string): Promise<number>;
}
