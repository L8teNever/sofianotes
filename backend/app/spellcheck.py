"""Optional hunspell check for German school notes."""

from __future__ import annotations

import re
import shutil
import subprocess

_WORD = re.compile(r"[A-Za-zÄÖÜäöüß]{3,}")
_HUNSPELL = shutil.which("hunspell")
_DICTS = "de_DE"
_SUG = re.compile(r"^[&?] (\S+) \d+ \d+: (.+)$")


def _run(args: list[str], payload: str) -> subprocess.CompletedProcess[str] | None:
    if not _HUNSPELL:
        return None
    try:
        return subprocess.run(
            args,
            input=payload,
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def misspelled(text: str) -> list[str]:
    raw = str(text or "").strip()
    if not raw or not _HUNSPELL:
        return []
    words = _WORD.findall(raw)
    if not words:
        return []
    proc = _run([_HUNSPELL, "-l", "-d", _DICTS], "\n".join(words) + "\n")
    if proc is None:
        return []
    if proc.returncode not in (0, 1) and "Can't open affix" in (proc.stderr or ""):
        proc = _run([_HUNSPELL, "-l", "-d", "de_DE"], "\n".join(words) + "\n")
        if proc is None:
            return []
    found = []
    seen = set()
    for line in (proc.stdout or "").splitlines():
        w = line.strip()
        if w and w.lower() not in seen:
            seen.add(w.lower())
            found.append(w)
    return found


def suggestions(text: str) -> dict[str, list[str]]:
    raw = str(text or "").strip()
    if not raw or not _HUNSPELL:
        return {}
    words = _WORD.findall(raw)
    if not words:
        return {}
    proc = _run([_HUNSPELL, "-a", "-d", _DICTS], "\n".join(words) + "\n")
    if proc is None:
        return {}
    out: dict[str, list[str]] = {}
    for line in (proc.stdout or "").splitlines():
        m = _SUG.match(line.strip())
        if not m:
            continue
        word = m.group(1)
        opts = []
        seen = set()
        for part in m.group(2).split(","):
            cand = part.strip().split()[0] if part.strip() else ""
            cand = re.sub(r"[^A-Za-zÄÖÜäöüß]", "", cand)
            key = cand.lower()
            if len(cand) < 3 or key in seen:
                continue
            seen.add(key)
            opts.append(cand)
            if len(opts) >= 6:
                break
        if opts:
            out[word.lower()] = opts
    return out
