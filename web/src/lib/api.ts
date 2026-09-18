import { ERROR_CODES } from '@duelodev/shared';
import type {
  ApiError,
  RegisterRequest,
  AuthUserResponse,
  LoginRequest,
  LogoutResponse,
  CreateRoomRequest,
  RoomCreatedResponse,
  JoinRoomRequest,
  JoinRoomResponse,
  RoomDetailsResponse,
  StartRoomResponse,
  CreateSubmissionRequest,
  SubmissionAcceptedResponse,
  SubmissionDetailsResponse,
  ProblemPublicResponse,
  MatchSummaryResponse,
  AdminManualResultResponse,
  AdminPlayersResponse,
  AdminRankingResponse,
  AdminRoomsResponse,
} from '@duelodev/shared';

const DEFAULT_API_BASE_URL = 'http://localhost:3001/api/v1';

export const API_BASE_URL = resolveApiBaseUrl();

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public data: ApiError,
  ) {
    super(data.error?.message || 'API Error');
    this.name = 'ApiClientError';
  }
}

function resolveApiBaseUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_BASE_URL;
  if (typeof window === 'undefined') {
    return stripTrailingSlash(configuredUrl);
  }

  return stripTrailingSlash(rewriteLoopbackForLanBrowser(configuredUrl, '3001'));
}

function rewriteLoopbackForLanBrowser(configuredUrl: string, fallbackPort: string) {
  const browserHost = window.location.hostname;
  if (isLoopbackHost(browserHost)) {
    return configuredUrl;
  }

  try {
    const parsed = new URL(configuredUrl);
    if (!isLoopbackHost(parsed.hostname)) {
      return configuredUrl;
    }

    parsed.protocol = window.location.protocol;
    parsed.hostname = browserHost;
    parsed.port = parsed.port || fallbackPort;
    return parsed.toString();
  } catch {
    return `${window.location.protocol}//${browserHost}:${fallbackPort}/api/v1`;
  }
}

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function stripTrailingSlash(url: string) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  // Incluimos credentials para enviar/recibir cookies (refresh_token, etc.)
  const config: RequestInit = {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  };

  const response = await fetch(url, config);

  if (!response.ok) {
    let errorData: ApiError;
    try {
      errorData = await response.json();
    } catch {
      errorData = {
        error: {
          code: ERROR_CODES.INTERNAL,
          message: 'Error desconocido del servidor',
          request_id: '',
        },
      };
    }
    throw new ApiClientError(response.status, errorData);
  }

  // Si no hay contenido (ej. 204), retornamos objeto vacío
  if (response.status === 204) return {} as T;

  return response.json();
}

export const api = {
  auth: {
    register: (data: RegisterRequest) =>
      request<AuthUserResponse>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
    login: (data: LoginRequest) =>
      request<AuthUserResponse>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
    guest: (gamertag: string) =>
      request<AuthUserResponse>('/auth/guest', {
        method: 'POST',
        body: JSON.stringify({ gamertag }),
      }),
    me: () => request<AuthUserResponse>('/auth/me'),
    logout: () => request<LogoutResponse>('/auth/logout', { method: 'POST' }),
  },
  rooms: {
    create: (data: CreateRoomRequest, idempotencyKey?: string) =>
      request<RoomCreatedResponse>('/rooms', {
        method: 'POST',
        body: JSON.stringify(data),
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      }),
    join: (code: string, data: JoinRoomRequest) =>
      request<JoinRoomResponse>(`/rooms/${code}/join`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    get: (code: string) => request<RoomDetailsResponse>(`/rooms/${code}`),
    start: (code: string) => request<StartRoomResponse>(`/rooms/${code}/start`, { method: 'POST' }),
  },
  problems: {
    get: (id: string) => request<ProblemPublicResponse>(`/problems/${id}/public`),
  },
  submissions: {
    create: (data: CreateSubmissionRequest, idempotencyKey?: string) =>
      request<SubmissionAcceptedResponse>('/submissions', {
        method: 'POST',
        body: JSON.stringify(data),
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      }),
    get: (id: string) => request<SubmissionDetailsResponse>(`/submissions/${id}`),
  },
  matches: {
    summary: (id: string) => request<MatchSummaryResponse>(`/matches/${id}/summary`),
  },
  admin: {
    rooms: (status?: string) =>
      request<AdminRoomsResponse>(
        `/admin/rooms${status ? `?status=${encodeURIComponent(status)}` : ''}`,
      ),
    createRoom: (data: CreateRoomRequest) =>
      request<RoomCreatedResponse>('/admin/rooms/create', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    players: (query?: string) =>
      request<AdminPlayersResponse>(
        `/admin/players${query ? `?q=${encodeURIComponent(query)}` : ''}`,
      ),
    ranking: () => request<AdminRankingResponse>('/admin/ranking'),
    setResult: (matchId: string, winnerIds: string[]) =>
      request<AdminManualResultResponse>(`/admin/rooms/${matchId}/result`, {
        method: 'POST',
        body: JSON.stringify({ winner_ids: winnerIds }),
      }),
  },
};
