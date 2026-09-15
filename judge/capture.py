"""Captura acotada de stdout/stderr para el supervisor confiable."""

from dataclasses import dataclass, field


@dataclass
class BoundedCapture:
    """Conserva como máximo `limit` bytes y marca cualquier exceso."""

    limit: int
    _chunks: list[bytes] = field(default_factory=list, init=False, repr=False)
    _size: int = field(default=0, init=False, repr=False)
    exceeded: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        if type(self.limit) is not int or self.limit < 1:
            raise ValueError("limit debe ser un entero positivo")

    @property
    def data(self) -> bytes:
        return b"".join(self._chunks)

    def append(self, chunk: bytes) -> None:
        if not isinstance(chunk, bytes):
            raise ValueError("la salida debe ser bytes")
        available = self.limit - self._size
        if available <= 0:
            self.exceeded = self.exceeded or bool(chunk)
            return
        accepted = chunk[:available]
        if accepted:
            self._chunks.append(accepted)
            self._size += len(accepted)
        if len(chunk) > available:
            self.exceeded = True
