import { MAX_EVENT_PAYLOAD_BYTES } from '@duelodev/shared';

/** Serializa un evento /match y devuelve null si no cabe en el presupuesto de transporte. */
export function serializeMatchEvent(event: string, payload: unknown): string | null {
  let message: string;
  try {
    message = JSON.stringify({ event, payload });
  } catch {
    return null;
  }

  return Buffer.byteLength(message, 'utf8') <= MAX_EVENT_PAYLOAD_BYTES ? message : null;
}
