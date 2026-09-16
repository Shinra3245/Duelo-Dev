"""Configuración del worker: obligatoria, saneada y coherente."""

from pathlib import Path

import pytest

from judge.settings import WorkerSettings


DIGEST = "a" * 64


def environment(tmp_path: Path) -> dict[str, str]:
    return {
        "DATABASE_URL": "postgresql://worker:secret@127.0.0.1:5432/duelodev",
        "REDIS_URL": "redis://127.0.0.1:6379/0",
        "JUDGE_CASES_ROOT": str(tmp_path),
        "JUDGE_WORKER_ID": "worker-1",
        "JUDGE_LEASE_MS": "120000",
        "JUDGE_RECOVERY_IDLE_MS": "125000",
        "JUDGE_IMAGE_PYTHON": f"python@sha256:{DIGEST}",
        "JUDGE_IMAGE_CPP": f"gcc@sha256:{DIGEST}",
        "JUDGE_IMAGE_JAVA": f"java@sha256:{DIGEST}",
    }


def test_loads_complete_configuration_without_exposing_credentials(tmp_path: Path) -> None:
    settings = WorkerSettings.from_environ(environment(tmp_path))

    assert settings.worker_id == "worker-1"
    assert settings.lease_duration_ms == 120_000
    assert settings.recovery_idle_ms == 125_000
    assert settings.batch_size == 1
    assert settings.block_ms == 1000
    assert "secret" not in repr(settings)


def test_all_required_values_are_reported_together(tmp_path: Path) -> None:
    values = environment(tmp_path)
    del values["DATABASE_URL"]
    del values["JUDGE_IMAGE_JAVA"]

    with pytest.raises(ValueError) as captured:
        WorkerSettings.from_environ(values)

    assert "DATABASE_URL" in str(captured.value)
    assert "JUDGE_IMAGE_JAVA" in str(captured.value)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("DATABASE_URL", "postgresql://missing-port/db"),
        ("REDIS_URL", "http://127.0.0.1:6379"),
        ("JUDGE_WORKER_ID", "../worker"),
        ("JUDGE_LEASE_MS", "0"),
        ("JUDGE_LEASE_MS", "01"),
        ("JUDGE_RECOVERY_IDLE_MS", "120000"),
        ("JUDGE_BATCH_SIZE", "17"),
        ("JUDGE_IMAGE_PYTHON", "python:latest"),
    ],
)
def test_rejects_unsafe_or_incoherent_configuration(tmp_path: Path, name: str, value: str) -> None:
    values = environment(tmp_path)
    values[name] = value

    with pytest.raises(ValueError):
        WorkerSettings.from_environ(values)
