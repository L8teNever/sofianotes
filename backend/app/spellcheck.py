"""Optional hunspell check for German school notes."""

from __future__ import annotations

import re
import shutil
import subprocess

_WORD = re.compile(r"[A-Za-zÄÖÜäöüß]{3,}")
_HUNSPELL = shutil.which("hunspell")
_DICTS = "de_DE"


def misspelled(text: str) -> list[str]:
    raw = str(text or "").strip()
    if not raw or not _HUNSPELL:
        return []
    words = _WORD.findall(raw)
    if not words:
        return []
    try:
        proc = subprocess.run(
            [_HUNSPELL, "-l", "-d", _DICTS],
            input="\n".join(words) + "\n",
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode not in (0, 1) and "Can't open affix" in (proc.stderr or ""):
        try:
            proc = subprocess.run(
                [_HUNSPELL, "-l", "-d", "de_DE"],
                input="\n".join(words) + "\n",
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return []
    found = []
    seen = set()
    for line in (proc.stdout or "").splitlines():
        w = line.strip()
        if w and w.lower() not in seen:
            seen.add(w.lower())
            found.append(w)
    return found
