/**
 * Proveedor de métricas operativas del sistema (doc 08 § Métricas de producto, H10).
 */
import type {
  EventRepository,
  RoomRepository,
  SubmissionRepository,
  UserRepository,
} from '../repositories/types.js';
import type { MetricsProvider } from '../types.js';

export interface OperationalMetricsRepositories {
  roomRepo: RoomRepository;
  submissionRepo: SubmissionRepository;
  userRepo: UserRepository;
  eventRepo: EventRepository;
}

/**
 * Crea un proveedor dinámico de métricas operativas ligeras para `/readyz`.
 */
export function createOperationalMetricsProvider(
  repos: OperationalMetricsRepositories,
  startTime?: number,
): MetricsProvider {
  const effectiveStartTime = startTime ?? Date.now();

  return async (): Promise<Record<string, number>> => {
    const uptime_s = Math.round(((Date.now() - effectiveStartTime) / 1000) * 100) / 100;

    let active_rooms = 0;
    if (typeof repos.roomRepo.countActiveRooms === 'function') {
      active_rooms = await repos.roomRepo.countActiveRooms();
    }

    let pending_submissions = 0;
    if (typeof repos.submissionRepo.findPendingSubmissions === 'function') {
      const pending = await repos.submissionRepo.findPendingSubmissions(1000);
      pending_submissions = pending.length;
    }

    let total_users = 0;
    if (typeof repos.userRepo.count === 'function') {
      total_users = await repos.userRepo.count();
    }

    let recorded_events = 0;
    if (typeof repos.eventRepo.countEvents === 'function') {
      recorded_events = await repos.eventRepo.countEvents();
    }

    return {
      uptime_s,
      active_rooms,
      pending_submissions,
      total_users,
      recorded_events,
    };
  };
}
