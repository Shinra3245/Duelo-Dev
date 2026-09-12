"""Comprobación de Docker de solo lectura; no certifica el aislamiento del juez."""

import json
import subprocess
from dataclasses import asdict, dataclass

DOCKER_INFO_FORMAT = (
    '{"security_options":{{json .SecurityOptions}},'
    '"cgroup_version":{{json .CgroupVersion}},'
    '"cgroup_driver":{{json .CgroupDriver}}}'
)


@dataclass(frozen=True)
class PreflightReport:
    prerequisites_ok: bool
    checks: dict[str, bool]
    pending: tuple[str, ...]


def assess(info: object) -> PreflightReport:
    """Incluso con rootless/cgroups, faltan pruebas de límites y usuario dedicado."""
    if not isinstance(info, dict):
        info = {}
    options = info.get("security_options")
    names = (
        {option.split(",", 1)[0] for option in options if isinstance(option, str)}
        if isinstance(options, list)
        else set()
    )
    checks = {
        "rootless": "name=rootless" in names,
        "seccomp": "name=seccomp" in names,
        "cgroup_v2": info.get("cgroup_version") == "2",
        "cgroup_systemd": info.get("cgroup_driver") == "systemd",
    }
    return PreflightReport(
        prerequisites_ok=all(checks.values()),
        checks=checks,
        pending=(
            "Verificar usuario dedicado sin acceso a secretos ni socket rootful.",
            "Usar una máquina desechable para la suite de abuso.",
            "Demostrar CPU, memoria, PIDs y aislamiento con la suite S01–S20.",
        ),
    )


def main() -> int:
    try:
        result = subprocess.run(
            ["docker", "info", "--format", DOCKER_INFO_FORMAT],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        info: object = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        # Docker puede incluir datos del entorno en stderr; no reenviarlo.
        print(json.dumps({"error": "No se pudo consultar Docker de forma válida."}))
        return 2
    report = assess(info)
    print(json.dumps(asdict(report), ensure_ascii=False, indent=2))
    return 0 if report.prerequisites_ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
