import { describe, expect, it } from 'vitest';
import {
  AuditService,
  createApp,
  createOperationalMetricsProvider,
  InMemoryEventRepository,
  InMemoryRoomRepository,
  InMemorySubmissionRepository,
  InMemoryUserRepository,
  sanitizeAuditPayload,
} from '../src/index.js';
import type { ReadyResponse } from '@duelodev/shared';

describe('Infraestructura de Registro de Eventos de Auditoría y Métricas Operativas', () => {
  describe('InMemoryEventRepository', () => {
    it('registra eventos, clona el payload y genera ID y timestamp', async () => {
      const repo = new InMemoryEventRepository();
      const payload = { room_code: 'ABC123', meta: { score: 10 } };
      const event = await repo.recordEvent({
        aggregate_type: 'match',
        aggregate_id: 'match-1',
        event_name: 'room_created',
        payload,
      });

      expect(event.id).toBeTruthy();
      expect(event.aggregate_type).toBe('match');
      expect(event.aggregate_id).toBe('match-1');
      expect(event.event_name).toBe('room_created');
      expect(event.payload).toEqual(payload);
      expect(event.payload).not.toBe(payload);
      expect(event.created_at).toBeTruthy();

      const found = await repo.findEventsByAggregate('match', 'match-1');
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe(event.id);
    });

    it('findEventsByName filtra por nombre de evento y respeta límite', async () => {
      const repo = new InMemoryEventRepository();
      await repo.recordEvent({
        aggregate_type: 'match',
        aggregate_id: 'm1',
        event_name: 'submission',
        payload: { attempt: 1 },
      });
      await repo.recordEvent({
        aggregate_type: 'match',
        aggregate_id: 'm2',
        event_name: 'submission',
        payload: { attempt: 2 },
      });
      await repo.recordEvent({
        aggregate_type: 'match',
        aggregate_id: 'm3',
        event_name: 'other_event',
        payload: {},
      });

      const allSubs = await repo.findEventsByName('submission');
      expect(allSubs).toHaveLength(2);

      const limitedSubs = await repo.findEventsByName('submission', 1);
      expect(limitedSubs).toHaveLength(1);
      expect(limitedSubs[0]?.aggregate_id).toBe('m1');
    });

    it('countEvents cuenta total y por nombre de evento', async () => {
      const repo = new InMemoryEventRepository();
      expect(await repo.countEvents()).toBe(0);

      await repo.recordEvent({
        aggregate_type: 'match',
        aggregate_id: 'm1',
        event_name: 'room_created',
        payload: {},
      });
      await repo.recordEvent({
        aggregate_type: 'match',
        aggregate_id: 'm2',
        event_name: 'guest_joined',
        payload: {},
      });
      await repo.recordEvent({
        aggregate_type: 'match',
        aggregate_id: 'm3',
        event_name: 'room_created',
        payload: {},
      });

      expect(await repo.countEvents()).toBe(3);
      expect(await repo.countEvents('room_created')).toBe(2);
      expect(await repo.countEvents('guest_joined')).toBe(1);
      expect(await repo.countEvents('non_existent')).toBe(0);
    });

    it('clear vacía todos los eventos almacenados', async () => {
      const repo = new InMemoryEventRepository();
      await repo.recordEvent({
        aggregate_type: 'user',
        aggregate_id: 'u1',
        event_name: 'guest_converted',
        payload: {},
      });
      expect(await repo.countEvents()).toBe(1);

      repo.clear();
      expect(await repo.countEvents()).toBe(0);
      expect(await repo.findEventsByAggregate('user', 'u1')).toEqual([]);
    });
  });

  describe('AuditService y Saneamiento de Datos (doc 04 § 135)', () => {
    it('sanitizeAuditPayload elimina claves sensibles incluso en estructuras anidadas', () => {
      const dirty = {
        normal_key: 'visible',
        source_code: 'print("secret")',
        test_cases: [{ input: '1', expected_output: '2' }],
        cases: 'cases/prob-1',
        password: 'super-secret-password',
        password_hash: 'hash-abc',
        token: 'jwt.token.here',
        token_hash: 'token-hash-123',
        nested: {
          allowed: 42,
          source_code: 'import os',
          more: {
            token: 'deep-secret',
          },
        },
      };

      const clean = sanitizeAuditPayload(dirty);
      expect(clean['normal_key']).toBe('visible');
      expect(clean['source_code']).toBeUndefined();
      expect(clean['test_cases']).toBeUndefined();
      expect(clean['cases']).toBeUndefined();
      expect(clean['password']).toBeUndefined();
      expect(clean['password_hash']).toBeUndefined();
      expect(clean['token']).toBeUndefined();
      expect(clean['token_hash']).toBeUndefined();

      const nested = clean['nested'] as Record<string, unknown>;
      expect(nested['allowed']).toBe(42);
      expect(nested['source_code']).toBeUndefined();

      const deepNested = nested['more'] as Record<string, unknown>;
      expect(deepNested['token']).toBeUndefined();
    });

    it('métodos tipados registran con aggregateType y payload correctos', async () => {
      const eventRepo = new InMemoryEventRepository();
      const audit = new AuditService(eventRepo);

      // 1. recordRoomCreated
      const roomCreated = await audit.recordRoomCreated('m1', 'h1', 'ROOM01', 'puntos');
      expect(roomCreated.aggregate_type).toBe('match');
      expect(roomCreated.aggregate_id).toBe('m1');
      expect(roomCreated.event_name).toBe('room_created');
      expect(roomCreated.payload).toEqual({
        host_id: 'h1',
        room_code: 'ROOM01',
        mode: 'puntos',
      });

      // 2. recordGuestJoined
      const guestJoined = await audit.recordGuestJoined('m1', 'u2', 'guest-gamer');
      expect(guestJoined.aggregate_type).toBe('match');
      expect(guestJoined.aggregate_id).toBe('m1');
      expect(guestJoined.event_name).toBe('guest_joined');
      expect(guestJoined.payload).toEqual({
        user_id: 'u2',
        gamertag: 'guest-gamer',
      });

      // 3. recordMatchStarted
      const matchStarted = await audit.recordMatchStarted('m1', 'h1', 4);
      expect(matchStarted.aggregate_type).toBe('match');
      expect(matchStarted.aggregate_id).toBe('m1');
      expect(matchStarted.event_name).toBe('match_started');
      expect(matchStarted.payload).toEqual({
        host_id: 'h1',
        players_count: 4,
      });

      // 4. recordSubmission
      const sub = await audit.recordSubmission('s1', 'm1', 'r1', 'u2', 'p1', 'python');
      expect(sub.aggregate_type).toBe('submission');
      expect(sub.aggregate_id).toBe('s1');
      expect(sub.event_name).toBe('submission');
      expect(sub.payload).toEqual({
        match_id: 'm1',
        round_id: 'r1',
        user_id: 'u2',
        problem_id: 'p1',
        language: 'python',
      });
      // Verificar que no hay código fuente en el payload
      expect(sub.payload['source_code']).toBeUndefined();

      // 5. recordMatchFinished
      const matchFinished = await audit.recordMatchFinished('m1', 'target_reached', ['u2']);
      expect(matchFinished.aggregate_type).toBe('match');
      expect(matchFinished.aggregate_id).toBe('m1');
      expect(matchFinished.event_name).toBe('match_finished');
      expect(matchFinished.payload).toEqual({
        finish_reason: 'target_reached',
        winner_ids: ['u2'],
      });

      // 6. recordGuestConverted
      const guestConverted = await audit.recordGuestConverted('u2', 'converted-gamer');
      expect(guestConverted.aggregate_type).toBe('user');
      expect(guestConverted.aggregate_id).toBe('u2');
      expect(guestConverted.event_name).toBe('guest_converted');
      expect(guestConverted.payload).toEqual({
        gamertag: 'converted-gamer',
      });

      // 7. recordRevealToggled
      const revealToggled = await audit.recordRevealToggled('m1', 'u2', true);
      expect(revealToggled.aggregate_type).toBe('match');
      expect(revealToggled.aggregate_id).toBe('m1');
      expect(revealToggled.event_name).toBe('reveal_toggled');
      expect(revealToggled.payload).toEqual({
        user_id: 'u2',
        is_revealed: true,
      });

      // 8. recordGuestPurged
      const guestPurged = await audit.recordGuestPurged('u9', 'anon-12345678');
      expect(guestPurged.aggregate_type).toBe('user');
      expect(guestPurged.aggregate_id).toBe('u9');
      expect(guestPurged.event_name).toBe('guest_purged');
      expect(guestPurged.payload).toEqual({
        tombstone_gamertag: 'anon-12345678',
      });

      expect(await eventRepo.countEvents()).toBe(8);
    });
  });

  describe('createOperationalMetricsProvider', () => {
    it('calcula uptime_s, active_rooms, pending_submissions, total_users, recorded_events dinámicamente', async () => {
      const roomRepo = new InMemoryRoomRepository();
      const submissionRepo = new InMemorySubmissionRepository();
      const userRepo = new InMemoryUserRepository();
      const eventRepo = new InMemoryEventRepository();

      const startTime = Date.now() - 5000; // 5 segundos atrás
      const provider = createOperationalMetricsProvider(
        { roomRepo, submissionRepo, userRepo, eventRepo },
        startTime,
      );

      const metrics0 = await provider();
      expect(metrics0['uptime_s']).toBeGreaterThanOrEqual(4.9);
      expect(metrics0['active_rooms']).toBe(0);
      expect(metrics0['pending_submissions']).toBe(0);
      expect(metrics0['total_users']).toBe(0);
      expect(metrics0['recorded_events']).toBe(0);

      // Agregar salas activas
      await roomRepo.createMatch({
        room_code: 'RM0001',
        mode: 'puntos',
        status: 'lobby',
        config: {
          mode: 'puntos',
          max_players: 4,
          target_score: 50,
          round_duration_s: 300,
          problem_categories: ['facil'],
        },
        host_id: 'u1',
      });
      await roomRepo.createMatch({
        room_code: 'RM0002',
        mode: 'rondas',
        status: 'running',
        config: {
          mode: 'rondas',
          max_players: 2,
          round_duration_s: 300,
          problem_categories: ['facil'],
        },
        host_id: 'u2',
      });
      await roomRepo.createMatch({
        room_code: 'RM0003',
        mode: 'puntos',
        status: 'finished',
        config: {
          mode: 'puntos',
          max_players: 2,
          target_score: 30,
          round_duration_s: 300,
          problem_categories: ['facil'],
        },
        host_id: 'u3',
      });

      // Agregar usuarios
      await userRepo.create({ gamertag: 'user1', role: 'user' });
      await userRepo.create({ gamertag: 'user2', role: 'guest' });

      // Agregar envíos pendientes
      await submissionRepo.createSubmission({
        match_id: 'm1',
        round_id: 'r1',
        user_id: 'u1',
        problem_id: 'p1',
        language: 'python',
        source_code: 'pass',
        time_limit_ms: 1000,
        memory_limit_mb: 256,
        admission_seq: 1,
        status: 'queued',
      });

      // Agregar eventos
      await eventRepo.recordEvent({
        aggregate_type: 'match',
        aggregate_id: 'm1',
        event_name: 'room_created',
        payload: {},
      });

      const metrics1 = await provider();
      expect(metrics1['active_rooms']).toBe(2); // RM0001 (lobby) + RM0002 (running)
      expect(metrics1['total_users']).toBe(2);
      expect(metrics1['pending_submissions']).toBe(1);
      expect(metrics1['recorded_events']).toBe(1);
    });
  });

  describe('Integración en servicios existentes y createApp', () => {
    it('createApp inicializa eventRepo y auditService y expone métricas operativas en /readyz por defecto', async () => {
      const app = createApp({
        serviceName: 'api-audit-test',
        version: '0.1.0',
      });

      expect(app.ctx.eventRepo).toBeInstanceOf(InMemoryEventRepository);
      expect(app.ctx.auditService).toBeInstanceOf(AuditService);

      const { port } = await app.start(0, '127.0.0.1');
      try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(res.status).toBe(200);

        const data = (await res.json()) as ReadyResponse;
        expect(data.status).toBe('ready');
        expect(data.metrics).toBeDefined();
        expect(typeof data.metrics!['uptime_s']).toBe('number');
        expect(typeof data.metrics!['active_rooms']).toBe('number');
        expect(typeof data.metrics!['pending_submissions']).toBe('number');
        expect(typeof data.metrics!['total_users']).toBe('number');
        expect(typeof data.metrics!['recorded_events']).toBe('number');
      } finally {
        await app.close();
      }
    });

    it('los servicios integran auditService y registran eventos durante el flujo real', async () => {
      const app = createApp({
        serviceName: 'api-flow-test',
        authSecret: 'super-secret-key-for-audit-test-12345678',
      });

      const { authService, roomService, submissionService, retentionService, eventRepo } = app.ctx;

      // 1. Registro de usuario host
      const hostAuth = await authService.register({
        email: 'host@test.com',
        password: 'Password123!',
        gamertag: 'host-player',
      });

      // 2. Creación de sala -> emite room_created
      const createdRoom = await roomService.createRoom(hostAuth.user.id, {
        config: {
          mode: 'puntos',
          max_players: 3,
          num_problems: 1,
          time_per_problem_s: 60,
          categories: ['facil'],
        },
      });

      const roomEvents = await eventRepo!.findEventsByName('room_created');
      expect(roomEvents).toHaveLength(1);
      expect(roomEvents[0]?.payload['room_code']).toBe(createdRoom.room_code);

      // 3. Unir un invitado -> emite guest_joined
      const joinResult = await roomService.joinRoom(createdRoom.room_code, {
        gamertag: 'guest-rival',
      });

      const guestEvents = await eventRepo!.findEventsByName('guest_joined');
      expect(guestEvents).toHaveLength(1);
      expect(guestEvents[0]?.payload['user_id']).toBe(joinResult.response.user_id);
      expect(guestEvents[0]?.payload['gamertag']).toBe('guest-rival');

      // 4. Iniciar partida -> emite match_started
      await roomService.startRoom(createdRoom.room_code, hostAuth.user.id);
      const startEvents = await eventRepo!.findEventsByName('match_started');
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0]?.payload['players_count']).toBe(2);

      // 5. Envío de solución -> emite submission
      await submissionService.submit(
        hostAuth.user.id,
        {
          match_id: createdRoom.match_id,
          round_id: '00000000-0000-0000-0000-000000000001',
          problem_id: '00000000-0000-0000-0000-000000000002',
          language: 'python',
          source_code: 'def solution(): return 42',
        },
        null,
      );

      const subEvents = await eventRepo!.findEventsByName('submission');
      expect(subEvents).toHaveLength(1);
      expect(subEvents[0]?.payload['user_id']).toBe(hostAuth.user.id);
      expect(subEvents[0]?.payload['language']).toBe('python');
      expect(subEvents[0]?.payload['source_code']).toBeUndefined();

      // 6. Conversión de invitado -> emite guest_converted
      await authService.convertGuest(joinResult.response.user_id, {
        email: 'converted@test.com',
        password: 'Password123!',
      });

      const convEvents = await eventRepo!.findEventsByName('guest_converted');
      expect(convEvents).toHaveLength(1);
      expect(convEvents[0]?.aggregate_id).toBe(joinResult.response.user_id);

      // 7. Anonimización y purga de invitado -> emite guest_purged
      const guestToPurge = await authService.createGuest('guest-to-purge');
      await retentionService.anonymizeGuest(guestToPurge.user.id);

      const purgeEvents = await eventRepo!.findEventsByName('guest_purged');
      expect(purgeEvents).toHaveLength(1);
      expect(purgeEvents[0]?.aggregate_id).toBe(guestToPurge.user.id);
      expect(purgeEvents[0]?.payload['tombstone_gamertag']).toMatch(/^anon-/);
    });
  });
});
