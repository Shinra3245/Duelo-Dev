import type { IncomingMessage, ServerResponse } from 'node:http';

export interface CorsOptions {
  allowedOrigins?: string[];
  allowCredentials?: boolean;
  allowedMethods?: string[];
  allowedHeaders?: string[];
  maxAgeSeconds?: number;
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DEFAULT_HEADERS = ['content-type', 'authorization', 'idempotency-key', 'x-request-id'];

export function parseCorsOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function applyCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  options: CorsOptions = {},
): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!origin) {
    return;
  }

  if (!isAllowedOrigin(origin, options.allowedOrigins ?? [])) {
    return;
  }

  appendVary(res, 'Origin');
  res.setHeader('access-control-allow-origin', origin);

  if (options.allowCredentials ?? true) {
    res.setHeader('access-control-allow-credentials', 'true');
  }
}

export function handleCorsPreflight(
  req: IncomingMessage,
  res: ServerResponse,
  options: CorsOptions = {},
): boolean {
  if (req.method?.toUpperCase() !== 'OPTIONS') {
    return false;
  }

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (origin && !isAllowedOrigin(origin, options.allowedOrigins ?? [])) {
    res.statusCode = 403;
    res.end();
    return true;
  }

  applyCorsHeaders(req, res, options);
  res.statusCode = 204;
  res.setHeader(
    'access-control-allow-methods',
    (options.allowedMethods ?? DEFAULT_METHODS).join(', '),
  );
  res.setHeader(
    'access-control-allow-headers',
    (options.allowedHeaders ?? DEFAULT_HEADERS).join(', '),
  );
  res.setHeader('access-control-max-age', String(options.maxAgeSeconds ?? 600));
  res.end();
  return true;
}

function isAllowedOrigin(origin: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes('*')) return true;
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;

  for (const allowed of allowedOrigins) {
    const normalizedAllowed = normalizeOrigin(allowed);
    if (normalizedAllowed && normalizedAllowed === normalizedOrigin) {
      return true;
    }
  }

  const parsed = new URL(normalizedOrigin);
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
}

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return null;
  }
}

function appendVary(res: ServerResponse, value: string): void {
  const current = res.getHeader('vary');
  if (!current) {
    res.setHeader('vary', value);
    return;
  }

  const values = Array.isArray(current)
    ? current.flatMap((entry) => String(entry).split(','))
    : String(current).split(',');
  const normalized = values.map((entry) => entry.trim().toLowerCase());
  if (!normalized.includes(value.toLowerCase())) {
    res.setHeader(
      'vary',
      [...values.map((entry) => entry.trim()).filter(Boolean), value].join(', '),
    );
  }
}
