#!/usr/bin/env node
/* global fetch, WebSocket, setTimeout, clearTimeout, console */
/* eslint-disable no-console */
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const API_URL = stripTrailingSlash(
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3001/api/v1',
);
const REALTIME_URL =
  process.env.REALTIME_URL ?? process.env.NEXT_PUBLIC_REALTIME_URL ?? 'ws://127.0.0.1:3002/match';
const WEB_URL = stripTrailingSlash(process.env.WEB_URL ?? 'http://127.0.0.1:3000');
const TIMEOUT_MS = positiveInt(process.env.SMOKE_TIMEOUT_MS, 90_000);
const EXPECTED_VERDICT = process.env.SMOKE_EXPECTED_VERDICT ?? 'WA';
const RUN_ID = Date.now().toString(36).slice(-6);

const C2S = {
  JOIN_MATCH: 'join_match',
};

const S2C = {
  MATCH_SYNC: 'match_sync',
  VERDICT: 'verdict',
  SCORE_UPDATE: 'score_update',
  ERROR: 'error',
};

const config = {
  mode: 'puntos',
  max_players: 2,
  num_problems: 1,
  categories: ['muy_facil', 'facil', 'facil_medio'],
  time_per_problem_s: 300,
};

const wrongPythonSolution = `# DueloDev tournament smoke: respuesta incorrecta controlada\nprint(0)\n`;

function positiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function withTimeout(promise, label, timeoutMs = TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout esperando ${label} (${timeoutMs} ms)`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseSetCookies(headers) {
  const raw =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);
  const cookies = new Map();
  for (const cookie of raw) {
    const first = cookie.split(';')[0];
    const idx = first.indexOf('=');
    if (idx > 0) {
      cookies.set(first.slice(0, idx), decodeURIComponent(first.slice(idx + 1)));
    }
  }
  return cookies;
}

function cookieHeader(cookies) {
  return [...cookies.entries()]
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

function accessToken(cookies) {
  const token = cookies.get('access_token');
  if (!token) {
    throw new Error('La API no devolvió cookie access_token');
  }
  return token;
}

async function apiRequest(path, { method = 'GET', token, cookies, body, idempotencyKey } = {}) {
  const headers = {
    'content-type': 'application/json',
    origin: WEB_URL,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookies) headers.cookie = cookieHeader(cookies);
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.error?.message ?? response.statusText;
    throw new Error(`${method} ${path} -> ${response.status}: ${message}`);
  }

  return { response, data, cookies: parseSetCookies(response.headers) };
}

async function registerUser(label) {
  const gamertag = `smoke-${label}-${RUN_ID}`.slice(0, 20);
  const email = `${gamertag}-${randomUUID().slice(0, 8)}@duelodev.local`;
  const { data, cookies } = await apiRequest('/auth/register', {
    method: 'POST',
    body: {
      email,
      password: 'SmokePass123!',
      gamertag,
    },
  });
  return { user: data.user, cookies, token: accessToken(cookies) };
}

function connectRealtime(token, label) {
  if (typeof WebSocket !== 'function') {
    throw new Error('Este smoke requiere Node con WebSocket global disponible');
  }

  const separator = REALTIME_URL.includes('?') ? '&' : '?';
  const socket = new WebSocket(`${REALTIME_URL}${separator}token=${encodeURIComponent(token)}`);
  const waiters = new Map();
  const messages = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    messages.push(message);
    const key = message.event;
    const pending = waiters.get(key) ?? [];
    for (const waiter of [...pending]) {
      if (waiter.predicate(message.payload)) {
        waiter.resolve(message.payload);
        pending.splice(pending.indexOf(waiter), 1);
      }
    }
    waiters.set(key, pending);
  });

  socket.addEventListener('error', () => {
    const pending = [...waiters.values()].flat();
    waiters.clear();
    for (const waiter of pending) {
      waiter.reject(new Error(`WebSocket ${label} emitió error`));
    }
  });

  const open = withTimeout(
    new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener(
        'close',
        () => reject(new Error(`WebSocket ${label} cerró antes de abrir`)),
        { once: true },
      );
    }),
    `apertura WebSocket ${label}`,
  );

  function send(event, payload) {
    socket.send(JSON.stringify({ event, payload }));
  }

  function waitFor(event, predicate = () => true, labelOverride = event) {
    return withTimeout(
      new Promise((resolve, reject) => {
        for (const message of messages) {
          if (message.event === event && predicate(message.payload)) {
            resolve(message.payload);
            return;
          }
        }
        const pending = waiters.get(event) ?? [];
        pending.push({ predicate, resolve, reject });
        waiters.set(event, pending);
      }),
      `${label}:${labelOverride}`,
    );
  }

  function close() {
    socket.close();
  }

  return { open, send, waitFor, close };
}

async function waitForSubmissionCompleted(submissionId, token) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    const { data } = await apiRequest(`/submissions/${submissionId}`, { token });
    last = data;
    if (data.status === 'completed') {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(
    `El envío ${submissionId} no terminó dentro del timeout; último estado=${last?.status ?? 'desconocido'}`,
  );
}

async function main() {
  console.log('Smoke torneo DueloDev');
  console.log(`API=${API_URL}`);
  console.log(`Realtime=${REALTIME_URL}`);
  console.log(`Origen web=${WEB_URL}`);

  const healthUrl = API_URL.replace(/\/api\/v1$/, '');
  const health = await fetch(`${healthUrl}/healthz`);
  if (!health.ok) {
    throw new Error(`API healthz -> ${health.status}`);
  }

  const host = await registerUser('host');
  const rival = await registerUser('rival');
  console.log(`Usuarios creados: ${host.user.gamertag}, ${rival.user.gamertag}`);

  const created = await apiRequest('/rooms', {
    method: 'POST',
    token: host.token,
    body: { config },
    idempotencyKey: randomUUID(),
  });
  const room = created.data;
  console.log(`Sala creada: ${room.room_code} (${room.match_id})`);

  await apiRequest(`/rooms/${room.room_code}/join`, {
    method: 'POST',
    token: rival.token,
    body: { gamertag: rival.user.gamertag },
  });
  console.log('Segundo jugador unido');

  await apiRequest(`/rooms/${room.room_code}/start`, {
    method: 'POST',
    token: host.token,
  });
  console.log('Partida iniciada por API');

  const hostWs = connectRealtime(host.token, 'host');
  const rivalWs = connectRealtime(rival.token, 'rival');
  try {
    await Promise.all([hostWs.open, rivalWs.open]);
    hostWs.send(C2S.JOIN_MATCH, { match_id: room.match_id });
    rivalWs.send(C2S.JOIN_MATCH, { match_id: room.match_id });

    const hostSync = await hostWs.waitFor(
      S2C.MATCH_SYNC,
      (payload) =>
        payload?.match_id === room.match_id &&
        payload?.status === 'running' &&
        payload?.problem_id &&
        payload?.round_id,
      'match_sync running',
    );
    await rivalWs.waitFor(
      S2C.MATCH_SYNC,
      (payload) => payload?.match_id === room.match_id,
      'match_sync rival',
    );

    console.log(`Problema activo: ${hostSync.problem_id}; ronda: ${hostSync.round_id}`);

    const accepted = await apiRequest('/submissions', {
      method: 'POST',
      token: host.token,
      idempotencyKey: randomUUID(),
      body: {
        match_id: room.match_id,
        round_id: hostSync.round_id,
        problem_id: hostSync.problem_id,
        language: 'python',
        source_code: wrongPythonSolution,
      },
    });
    const submission = accepted.data;
    console.log(`Envío admitido: ${submission.submission_id}`);

    const verdictFromSocket = await hostWs.waitFor(
      S2C.VERDICT,
      (payload) => payload?.submission_id === submission.submission_id,
      'verdict del envío',
    );
    await hostWs.waitFor(
      S2C.SCORE_UPDATE,
      (payload) => payload?.match_id === room.match_id,
      'score_update',
    );
    const durable = await waitForSubmissionCompleted(submission.submission_id, host.token);

    if (durable.verdict !== EXPECTED_VERDICT) {
      throw new Error(
        `Veredicto durable esperado ${EXPECTED_VERDICT}, recibido ${durable.verdict}`,
      );
    }
    if (verdictFromSocket.verdict !== durable.verdict) {
      throw new Error(
        `Veredicto socket ${verdictFromSocket.verdict} no coincide con durable ${durable.verdict}`,
      );
    }

    console.log(
      `Veredicto confirmado por socket y API: ${durable.verdict} (${durable.passed}/${durable.total})`,
    );
    console.log('Smoke torneo completado correctamente.');
  } finally {
    hostWs.close();
    rivalWs.close();
  }
}

main().catch((error) => {
  console.error(`Smoke torneo falló: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
