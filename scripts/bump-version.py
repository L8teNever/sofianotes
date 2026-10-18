#!/usr/bin/env python3
"""Patch-Version in backend/version.json um 1 erhoehen (semver x.y.Z)."""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "backend" / "version.json"


def bump_patch(ver: str) -> str:
    parts = [p for p in str(ver or "1.0.0").strip().split(".") if p != ""]
    while len(parts) < 3:
        parts.append("0")
    patch = re.sub(r"\D.*", "", parts[2]) or "0"
    parts[2] = str(int(patch) + 1)
    return ".".join(parts[:3])


def main() -> int:
    if os.environ.get("SKIP_VERSION_BUMP") == "1":
        return 0
    data: dict = {"version": "1.0.0", "commit": "main"}
    if PATH.exists():
        try:
            loaded = json.loads(PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data.update(loaded)
        except Exception:
            pass
    old = str(data.get("version") or "1.0.0")
    data["version"] = bump_patch(old)
    PATH.parent.mkdir(parents=True, exist_ok=True)
    PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("version " + old + " -> " + data["version"], file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
