"""Transporte Redis Stream y ciclo de consumo sin decisiones de negocio propias."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from judge.worker import EntryOutcome


JUDGE_STREAM_KEY = "judge:stream"
JUDGE_CONSUMER_GROUP = "judges"


class StreamTransportError(RuntimeError):
    """Fallo saneado del transporte; nunca incluye el contenido del mensaje."""


@dataclass(frozen=True)
class StreamEntry:
    message_id: str
    fields: Mapping[Any, Any] = field(repr=False)

    def __post_init__(self) -> None:
        if not self.message_id:
            raise ValueError("message_id es obligatorio")


class EntryCoordinator(Protocol):
    def handle(self, message_id: str, fields: Mapping[Any, Any]) -> EntryOutcome: ...


class StreamTransport(Protocol):
    def claim_stale(
        self, consumer_name: str, count: int, min_idle_ms: int
    ) -> Sequence[StreamEntry]: ...

    def read_new(self, consumer_name: str, count: int, block_ms: int) -> Sequence[StreamEntry]: ...

    def ack(self, message_id: str) -> bool: ...


@dataclass(frozen=True)
class ConsumerBatchStats:
    read: int = 0
    recovered: int = 0
    acknowledged: int = 0
    retried: int = 0
    ack_failures: int = 0
    read_failed: bool = False
    recovery_failed: bool = False


class StreamConsumer:
    """Procesa un lote y conserva pendientes todas las decisiones no durables."""

    def __init__(
        self,
        consumer_name: str,
        transport: StreamTransport,
        coordinator: EntryCoordinator,
        *,
        count: int = 1,
        block_ms: int = 1000,
        recovery_idle_ms: int,
    ) -> None:
        if not isinstance(consumer_name, str) or not consumer_name:
            raise ValueError("consumer_name es obligatorio")
        if type(count) is not int or count < 1:
            raise ValueError("count debe ser positivo")
        if type(block_ms) is not int or block_ms < 1:
            raise ValueError("block_ms debe ser positivo")
        if type(recovery_idle_ms) is not int or recovery_idle_ms < 1:
            raise ValueError("recovery_idle_ms debe ser positivo")
        self._consumer_name = consumer_name
        self._transport = transport
        self._coordinator = coordinator
        self._count = count
        self._block_ms = block_ms
        self._recovery_idle_ms = recovery_idle_ms

    def poll_once(self) -> ConsumerBatchStats:
        try:
            recovered = self._transport.claim_stale(
                self._consumer_name, self._count, self._recovery_idle_ms
            )
        except Exception:
            return ConsumerBatchStats(recovery_failed=True)
        try:
            entries = (
                recovered
                if recovered
                else self._transport.read_new(self._consumer_name, self._count, self._block_ms)
            )
        except Exception:
            return ConsumerBatchStats(read_failed=True)

        acknowledged = 0
        retried = 0
        ack_failures = 0
        for entry in entries:
            try:
                outcome = self._coordinator.handle(entry.message_id, entry.fields)
            except Exception:
                retried += 1
                continue
            if not outcome.should_ack:
                retried += 1
                continue
            try:
                acked = self._transport.ack(entry.message_id)
            except Exception:
                acked = False
            if acked:
                acknowledged += 1
            else:
                ack_failures += 1
        return ConsumerBatchStats(
            read=len(entries),
            recovered=len(recovered),
            acknowledged=acknowledged,
            retried=retried,
            ack_failures=ack_failures,
        )


class RedisPyStreamTransport:
    """Adaptador mínimo sobre un cliente redis-py síncrono inyectado."""

    def __init__(
        self,
        client: Any,
        stream: str = JUDGE_STREAM_KEY,
        group: str = JUDGE_CONSUMER_GROUP,
    ) -> None:
        if not stream or not group:
            raise ValueError("stream y group son obligatorios")
        self._client = client
        self._stream = stream
        self._group = group

    def ensure_group(self) -> bool:
        """Crea el grupo desde 0-0; BUSYGROUP confirma que ya existe."""
        try:
            self._client.xgroup_create(self._stream, self._group, id="0-0", mkstream=True)
            return True
        except Exception as error:
            if "BUSYGROUP" in str(error):
                return False
            raise StreamTransportError("No se pudo preparar el consumer group") from None

    def read_new(self, consumer_name: str, count: int, block_ms: int) -> Sequence[StreamEntry]:
        try:
            response = self._client.xreadgroup(
                self._group,
                consumer_name,
                {self._stream: ">"},
                count=count,
                block=block_ms,
            )
            return self._decode_response(response)
        except StreamTransportError:
            raise
        except Exception:
            raise StreamTransportError("No se pudo leer el stream") from None

    def claim_stale(
        self, consumer_name: str, count: int, min_idle_ms: int
    ) -> Sequence[StreamEntry]:
        try:
            response = self._client.xautoclaim(
                self._stream,
                self._group,
                consumer_name,
                min_idle_ms,
                "0-0",
                count=count,
            )
            if not isinstance(response, (list, tuple)) or len(response) not in (2, 3):
                raise StreamTransportError("Redis devolvió una recuperación inválida")
            return self._decode_entries(response[1])
        except StreamTransportError:
            raise
        except Exception:
            raise StreamTransportError("No se pudieron recuperar pendientes") from None

    def ack(self, message_id: str) -> bool:
        try:
            return int(self._client.xack(self._stream, self._group, message_id)) == 1
        except Exception:
            raise StreamTransportError("No se pudo confirmar el mensaje") from None

    def _decode_response(self, response: object) -> tuple[StreamEntry, ...]:
        if response in (None, []):
            return ()
        if not isinstance(response, (list, tuple)):
            raise StreamTransportError("Redis devolvió una respuesta de stream inválida")
        entries: list[StreamEntry] = []
        for stream_data in response:
            if not isinstance(stream_data, (list, tuple)) or len(stream_data) != 2:
                raise StreamTransportError("Redis devolvió una respuesta de stream inválida")
            stream_name = _redis_text(stream_data[0], "stream")
            if stream_name != self._stream or not isinstance(stream_data[1], (list, tuple)):
                raise StreamTransportError("Redis devolvió un stream inesperado")
            entries.extend(self._decode_entries(stream_data[1]))
        return tuple(entries)

    @staticmethod
    def _decode_entries(response: object) -> tuple[StreamEntry, ...]:
        if not isinstance(response, (list, tuple)):
            raise StreamTransportError("Redis devolvió entradas inválidas")
        entries: list[StreamEntry] = []
        for raw_entry in response:
            if not isinstance(raw_entry, (list, tuple)) or len(raw_entry) != 2:
                raise StreamTransportError("Redis devolvió una entrada inválida")
            message_id = _redis_text(raw_entry[0], "message_id")
            if not isinstance(raw_entry[1], Mapping):
                raise StreamTransportError("Redis devolvió campos inválidos")
            entries.append(StreamEntry(message_id, raw_entry[1]))
        return tuple(entries)


def _redis_text(value: object, name: str) -> str:
    if isinstance(value, bytes):
        try:
            decoded = value.decode("utf-8")
        except UnicodeDecodeError:
            raise StreamTransportError(f"Redis devolvió {name} no UTF-8") from None
    elif isinstance(value, str):
        decoded = value
    else:
        raise StreamTransportError(f"Redis devolvió {name} no textual")
    if not decoded:
        raise StreamTransportError(f"Redis devolvió {name} vacío")
    return decoded
