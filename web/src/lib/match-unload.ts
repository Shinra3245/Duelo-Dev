export const ACTIVE_MATCH_LEAVE_QUESTION = '¿Estás seguro de que quieres abandonar la partida?';

export const ACTIVE_MATCH_UNLOAD_WARNING = `${ACTIVE_MATCH_LEAVE_QUESTION} Si sales, perderás la partida.`;

export function protectActiveMatchUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = ACTIVE_MATCH_UNLOAD_WARNING;
}
