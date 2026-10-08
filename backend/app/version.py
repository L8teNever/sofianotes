import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

VERSION_JSON = Path(__file__).resolve().parent.parent / "version.json"


def read_version() -> str:
    try:
        data = json.loads(VERSION_JSON.read_text(encoding="utf-8"))
        v = str(data.get("version") or "").strip()
        if v:
            return v
    except Exception:
        pass
    return "1.0.0"


def _usable_commit(value: str | None) -> str:
    s = str(value or "").strip()
    if not s or s.lower() in ("main", "master", "head", "unknown"):
        return ""
    return s[:7]


def get_git_commit() -> str:
    env_commit = _usable_commit(os.getenv("GIT_COMMIT") or os.getenv("GITHUB_SHA"))
    if env_commit:
        return env_commit

    if VERSION_JSON.exists():
        try:
            data = json.loads(VERSION_JSON.read_text(encoding="utf-8"))
            from_file = _usable_commit(data.get("commit"))
            if from_file:
                return from_file
        except Exception:
            pass

    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL,
        )
        return out.decode().strip()
    except Exception:
        return "main"


def get_version_info(build_ts: str) -> dict:
    commit = get_git_commit()
    try:
        ts_int = int(build_ts)
        build_date = datetime.fromtimestamp(ts_int).strftime("%d.%m.%Y, %H:%M")
    except Exception:
        build_date = datetime.now().strftime("%d.%m.%Y, %H:%M")

    return {
        "version": read_version(),
        "commit": commit,
        "build_ts": str(build_ts),
        "build_date": build_date,
        "channel": "Production",
    }


def inject_build(text: str, build_ts: str) -> str:
    # %%APP_VERSION%%, nicht __APP_VERSION__: das waere Teil von window.__APP_VERSION__.
    return text.replace("__BUILD__", str(build_ts)).replace("%%APP_VERSION%%", read_version())
