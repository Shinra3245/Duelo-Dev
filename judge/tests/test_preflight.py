"""No consultan Docker: verifican rechazo y saneamiento de observaciones."""

import subprocess

import pytest

from judge.preflight import assess, main


def test_rootful_docker_is_not_ready() -> None:
    report = assess({"security_options": ["name=seccomp,profile=builtin"], "cgroup_version": "2"})
    assert not report.prerequisites_ok
    assert not report.checks["rootless"]


def test_prerequisites_are_not_a_security_certificate() -> None:
    report = assess(
        {
            "security_options": ["name=rootless", "name=seccomp,profile=builtin"],
            "cgroup_version": "2",
            "cgroup_driver": "systemd",
        }
    )
    assert report.prerequisites_ok
    assert len(report.pending) == 3


@pytest.mark.parametrize("info", [None, [], "rootless", {}, {"security_options": "name=rootless"}])
def test_malformed_data_is_not_ready(info: object) -> None:
    assert not assess(info).prerequisites_ok


def test_rootless_substring_is_not_accepted() -> None:
    assert not assess({"security_options": ["name=notrootless"]}).checks["rootless"]


def test_cli_does_not_expose_docker_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def fail(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        raise subprocess.CalledProcessError(1, "docker", stderr="SECRET")

    monkeypatch.setattr(subprocess, "run", fail)
    assert main() == 2
    assert "SECRET" not in capsys.readouterr().out


def test_cli_success(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    def ok(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            "docker",
            0,
            '{"security_options":["name=rootless","name=seccomp"],'
            '"cgroup_version":"2","cgroup_driver":"systemd"}',
        )

    monkeypatch.setattr(subprocess, "run", ok)
    assert main() == 0
    assert '"prerequisites_ok": true' in capsys.readouterr().out
