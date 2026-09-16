"""Aviso Redis de un resultado ya confirmado en PostgreSQL."""

from collections.abc import Callable
import json
from typing import Any

from judge.verdicts import Verdict
from judge.worker import EntryOutcome


JUDGE_RESULTS_CHANNEL = "judge:results"


class ResultNotificationError(RuntimeError):
    """Fallo saneado al reconstruir o publicar un aviso de resultado."""


class PostgresRedisResultNotifier:
    """Publica sólo datos leídos de la fila durable completada."""

    def __init__(
        self,
        connect: Callable[[], Any],
        publish: Callable[[str, str], object],
        channel: str = JUDGE_RESULTS_CHANNEL,
    ) -> None:
        if not callable(connect) or not callable(publish):
            raise ValueError("connect y publish deben ser invocables")
        if not isinstance(channel, str) or not channel:
            raise ValueError("channel es obligatorio")
        self._connect = connect
        self._publish = publish
        self._channel = channel

    def notify(self, outcome: EntryOutcome) -> None:
        if outcome.submission_id is None or outcome.result is None:
            raise ValueError("El aviso requiere un resultado durable")
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(_NOTIFICATION_SQL, (outcome.submission_id,))
                    row = cursor.fetchone()
            if row is None:
                raise ResultNotificationError("El resultado durable no está disponible")
            notification = _notification(row)
            if notification["submission_id"] != outcome.submission_id:
                raise ResultNotificationError("PostgreSQL devolvió un envío inesperado")
            self._publish(
                self._channel,
                json.dumps(notification, ensure_ascii=False, separators=(",", ":")),
            )
        except ResultNotificationError:
            raise
        except Exception:
            raise ResultNotificationError("No se pudo publicar el aviso durable") from None


def _notification(row: tuple[object, ...]) -> dict[str, object]:
    if len(row) != 9:
        raise ResultNotificationError("PostgreSQL devolvió un resultado incompleto")
    if any(value is None for value in row[:4]):
        raise ResultNotificationError("PostgreSQL devolvió identificadores inválidos")
    identifiers = tuple(str(value) for value in row[:4])
    if any(not value for value in identifiers):
        raise ResultNotificationError("PostgreSQL devolvió identificadores inválidos")
    try:
        verdict = Verdict(str(row[4]))
    except ValueError:
        raise ResultNotificationError("PostgreSQL devolvió un veredicto inválido") from None
    passed = _database_int(row[5])
    total = _database_int(row[6])
    exec_time_ms = _database_int(row[7])
    status = str(row[8])
    if status != "completed" or passed < 0 or total < passed or exec_time_ms < 0:
        raise ResultNotificationError("PostgreSQL devolvió un resultado inconsistente")
    return {
        "submission_id": identifiers[0],
        "match_id": identifiers[1],
        "round_id": identifiers[2],
        "user_id": identifiers[3],
        "verdict": verdict.value,
        "passed": passed,
        "total": total,
        "exec_time_ms": exec_time_ms,
    }


def _database_int(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ResultNotificationError("PostgreSQL devolvió un entero inválido")
    return value


_NOTIFICATION_SQL = """
SELECT id, match_id, round_id, user_id, verdict,
       passed_cases, total_cases, exec_time_ms, status
FROM submissions
WHERE id = %s
  AND status = 'completed'
  AND verdict IS NOT NULL
  AND passed_cases IS NOT NULL
  AND total_cases IS NOT NULL
  AND exec_time_ms IS NOT NULL
"""
