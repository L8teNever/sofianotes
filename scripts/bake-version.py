#!/usr/bin/env python3
"""Keep backend/version.json's semver; set commit from GIT_COMMIT or .git HEAD."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "backend" / "version.json"
GITDIR = Path(os.environ.get("GIT_DIR") or (ROOT / ".git"))


def looks_like_sha(value: str) -> bool:
    s = (value or "").strip()
    if not s or s.lower() in ("main", "master", "head", "unknown"):
        return False
    return len(s) >= 7 and all(c in "0123456789abcdefABCDEF" for c in s[:40])


def sha_from_gitdir(gitdir: Path) -> str:
    try:
        head = (gitdir / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    if not head:
        return ""
    if head.startswith("ref:"):
        ref = head.split(":", 1)[1].strip()
        ref_path = gitdir / ref
        if ref_path.is_file():
            return ref_path.read_text(encoding="utf-8").strip()[:7]
        packed = gitdir / "packed-refs"
        if packed.is_file():
            for line in packed.read_text(encoding="utf-8").splitlines():
                if not line or line.startswith("#") or " " not in line:
                    continue
                sha, name = line.split(" ", 1)
                if name.strip() == ref:
                    return sha[:7]
        return ""
    return head[:7]


def main() -> int:
    data: dict = {"version": "1.0.0", "commit": ""}
    if PATH.exists():
        try:
            loaded = json.loads(PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data.update(loaded)
        except Exception:
            pass
    env = (os.environ.get("GIT_COMMIT") or os.environ.get("GITHUB_SHA") or "").strip()
    commit = env if looks_like_sha(env) else sha_from_gitdir(GITDIR)
    if commit:
        data["commit"] = commit[:7] if looks_like_sha(commit) else commit
    PATH.parent.mkdir(parents=True, exist_ok=True)
    PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("baked version=" + str(data.get("version")) + " commit=" + str(data.get("commit")), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
