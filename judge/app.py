"""Composición y ciclo de vida del worker de DueloDev."""

from collections.abc import Callable
import importlib
import json
import os
import signal
import subprocess
import threading
from time import time
from typing import Any, Protocol

from judge.case_store import DirectoryCasesProvider
from judge.compiler import MAX_COMPILE_OUTPUT_BYTES
from judge.docker_compiler import DockerCompilationBackend
from judge.docker_session import DockerSessionBackend
from judge.pipeline import JudgePipeline
from judge.postgres_repository import PostgresRejectedEntryRepository, PostgresResultRepository
from judge.preflight import DOCKER_INFO_FORMAT, assess
from judge.result_notification import PostgresRedisResultNotifier
from judge.runtime import DockerCaseRunner, SubprocessDockerInvoker
from judge.session_runtime import DockerSubmissionRunner
from judge.settings import WorkerSettings
from judge.stream_consumer import ConsumerBatchStats, RedisPyStreamTransport, StreamConsumer
from judge.worker import StreamEntryCoordinator


class WorkerStartupError(RuntimeError):
    """Error de arranque saneado, sin URLs, payloads ni salida del daemon."""


class PollingConsumer(Protocol):
    def poll_once(self) -> ConsumerBatchStats: ...


def build_consumer(
    settings: WorkerSettings,
    redis_client: Any,
    connect: Callable[[], Any],
) -> StreamConsumer:
    """Conecta adaptadores ya validados sin iniciar el ciclo infinito."""
    invoker = SubprocessDockerInvoker(MAX_COMPILE_OUTPUT_BYTES)
    compiler = DockerCompilationBackend(invoker, settings.base_images)
    pipeline = JudgePipeline(
        DirectoryCasesProvider(settings.cases_root),
        compiler,
        DockerCaseRunner(invoker),
        compiler,
        lambda: int(time() * 1000),
        submission_runner=DockerSubmissionRunner(DockerSessionBackend(invoker)),
    )
    results = PostgresResultRepository(
        connect,
        lease_duration_ms=settings.lease_duration_ms,
    )
    coordinator = StreamEntryCoordinator(
        settings.worker_id,
        pipeline,
        results,
        PostgresRejectedEntryRepository(connect),
    )
    transport = RedisPyStreamTransport(redis_client)
    try:
        with connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                if cursor.fetchone() != (1,):
                    raise WorkerStartupError("PostgreSQL no respondió a la sonda")
        redis_client.ping()
        transport.ensure_group()
    except WorkerStartupError:
        raise
    except Exception:
        raise WorkerStartupError("No se pudieron preparar PostgreSQL y Redis") from None
    return StreamConsumer(
        settings.worker_id,
        transport,
        coordinator,
        count=settings.batch_size,
        block_ms=settings.block_ms,
        recovery_idle_ms=settings.recovery_idle_ms,
        notifier=PostgresRedisResultNotifier(connect, redis_client.publish),
    )


def run_consumer(
    consumer: PollingConsumer,
    stop_event: threading.Event,
    report: Callable[[ConsumerBatchStats], None],
    *,
    failure_backoff_s: float = 0.25,
) -> None:
    if failure_backoff_s < 0:
        raise ValueError("failure_backoff_s no puede ser negativo")
    while not stop_event.is_set():
        stats = consumer.poll_once()
        report(stats)
        if stats.read_failed or stats.recovery_failed:
            stop_event.wait(failure_backoff_s)


def docker_prerequisites_ok() -> bool:
    try:
        completed = subprocess.run(
            ("docker", "info", "--format", DOCKER_INFO_FORMAT),
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        return assess(json.loads(completed.stdout)).prerequisites_ok
    except (OSError, subprocess.SubprocessError, ValueError):
        return False


def main() -> int:
    redis_client: Any | None = None
    try:
        settings = WorkerSettings.from_environ(os.environ)
        if not docker_prerequisites_ok():
            raise WorkerStartupError("Docker rootless no cumple los prerrequisitos")
        redis_module = importlib.import_module("redis")
        psycopg_module = importlib.import_module("psycopg")
        redis_client = redis_module.Redis.from_url(settings.redis_url)
        consumer = build_consumer(
            settings,
            redis_client,
            lambda: psycopg_module.connect(settings.database_url),
        )
    except (ValueError, WorkerStartupError, ImportError):
        print(json.dumps({"level": "error", "message": "El worker no pudo iniciar"}))
        return 2

    stop_event = threading.Event()

    def request_stop(signum: int, frame: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    def report(stats: ConsumerBatchStats) -> None:
        if (
            stats.read_failed
            or stats.recovery_failed
            or stats.ack_failures
            or stats.notification_failures
        ):
            print(
                json.dumps(
                    {
                        "level": "warning",
                        "message": "Lote del juez con fallos recuperables",
                        "read_failed": stats.read_failed,
                        "recovery_failed": stats.recovery_failed,
                        "ack_failures": stats.ack_failures,
                        "notification_failures": stats.notification_failures,
                    }
                ),
                flush=True,
            )

    try:
        run_consumer(consumer, stop_event, report)
    except Exception:
        print(json.dumps({"level": "error", "message": "El ciclo del worker se detuvo"}))
        return 1
    finally:
        if redis_client is not None:
            try:
                redis_client.close()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
