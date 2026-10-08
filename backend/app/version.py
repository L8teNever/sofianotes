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


def get_git_commit() -> str:
    env_commit = os.getenv("GIT_COMMIT") or os.getenv("GITHUB_SHA")
    if env_commit:
        return env_commit[:7]

    if VERSION_JSON.exists():
        try:
            data = json.loads(VERSION_JSON.read_text(encoding="utf-8"))
            if data.get("commit"):
                return str(data["commit"])[:7]
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
    return text.replace("__BUILD__", str(build_ts)).replace("__APP_VERSION__", read_version())
