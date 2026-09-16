import type { JudgeResultNotification, Verdict } from '@duelodev/shared';

/**
 * Función receptora de avisos de veredictos del juez desde Redis Pub/Sub `judge:results`.
 */
export type ResultListener = (notification: JudgeResultNotification) => Promise<void> | void;

/**
 * Contrato de suscripción a avisos de resultados del juez (doc 04 §131-133).
 */
export interface ResultSubscriber {
  /**
   * Se suscribe a los avisos entrantes. Retorna una función para cancelar la suscripción.
   */
  subscribe(listener: ResultListener): () => void;
}

/**
 * Contrato de publicación de avisos de resultados del juez para pruebas o puentes de transporte.
 */
export interface ResultPublisher {
  /**
   * Publica una notificación de resultado a todos los suscriptores.
   */
  publish(notification: JudgeResultNotification): Promise<void>;
}

/**
 * Registro de envío juzgado obtenido de la base de datos PostgreSQL (doc 04 §131).
 */
export interface JudgedSubmissionRecord {
  id: string;
  match_id: string;
  round_id: string;
  user_id: string;
  problem_id: string;
  admission_seq: number;
  received_at: string;
  verdict: Verdict;
  passed_cases: number;
  total_cases: number;
  exec_time_ms: number;
  compile_output?: string | undefined;
}

/**
 * Proveedor de envíos juzgados persistidos para reconciliación de estado (doc 04 §131).
 */
export interface SubmissionProvider {
  /**
   * Recupera los envíos juzgados para una partida específica.
   */
  findJudgedSubmissionsByMatch(matchId: string): Promise<JudgedSubmissionRecord[]>;

  /**
   * Recupera un envío juzgado individual por su ID desde la persistencia durable.
   */
  findJudgedSubmissionById?(submissionId: string): Promise<JudgedSubmissionRecord | null>;

  /**
   * Obtiene la salida de compilación para un envío específico, si existe.
   */
  getCompileOutput?(submissionId: string): Promise<string | undefined>;
}

/**
 * Almacén de control de idempotencia para envíos procesados en Realtime (doc 04 §132).
 * Evita aplicar doble puntuación o dobles transiciones ante avisos duplicados o reconciliaciones.
 */
export interface ProcessedSubmissionStore {
  /**
   * Determina si un envío específico ya fue procesado para la partida dada.
   */
  hasBeenProcessed(matchId: string, submissionId: string): Promise<boolean>;

  /**
   * Reserva de forma atómica el procesamiento de un envío para prevenir que avisos
   * o reconciliaciones concurrentes procesen el mismo envío dos veces.
   * Retorna true si adquirió la reserva; false si ya fue procesado o está en proceso.
   */
  claimProcessing?(matchId: string, submissionId: string): Promise<boolean>;

  /**
   * Libera una reserva de procesamiento previa en caso de error o descarte temprano.
   */
  releaseProcessing?(matchId: string, submissionId: string): Promise<void>;

  /**
   * Marca un envío como procesado definitivamente para la partida dada.
   */
  markProcessed(matchId: string, submissionId: string): Promise<void>;

  /**
   * Cuenta el total de envíos procesados, opcionalmente filtrado por partida.
   */
  countProcessed(matchId?: string): Promise<number>;
}
