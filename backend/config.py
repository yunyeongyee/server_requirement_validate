"""설정 변수: 프로젝트 루트의 .env 파일 → 환경변수. (.env 는 git에 올리지 않는다. .env.example 참고)

이미 환경변수로 설정된 값이 있으면 그 값이 우선한다.
"""
from __future__ import annotations
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"


def load_env(path: Path = ENV_FILE) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:  # 줄 끝 주석
            value = value.split(" #", 1)[0].rstrip()
        os.environ.setdefault(key, value)


def get(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()
