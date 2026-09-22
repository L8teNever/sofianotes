"""Cloudflare Workers AI (Moondream) handwriting OCR."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import urllib.error
import urllib.request

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
MODEL = os.environ.get(
    "CLOUDFLARE_OCR_MODEL", "@cf/moondream/moondream3.1-9B-A2B"
).strip() or "@cf/moondream/moondream3.1-9B-A2B"
TIMEOUT_SEC = 12
MAX_IMAGE_CHARS = 900_000

DIGIT_PROMPT = (
    "Transcribe the handwritten whiteboard ink. "
    "Reply with ONLY the written characters, no extra words. "
    "Prefer digits 0-9 when a glyph could be a letter or a number. "
    "Keep math operators + - x * / = ^ ( ) % and signs for square root √, pi π, and equals."
)
TEXT_PROMPT = (
    "This is a school notebook whiteboard. "
    "Transcribe ALL handwritten ink in the image in one answer: words, "
    "square roots √, and any math written underneath. "
    "Reply with ONLY that text. "
    "Use neighboring letters as context to tell letters from digits "
    "(l vs 1, O vs 0, S vs 5, Z vs 2). "
    "Prefer real German or English words and keep umlauts ä ö ü ß. "
    "Only use digits when the ink is clearly a number."
)
KEEP_CHARS = r"0-9A-Za-zÄÖÜäöüß+\-*/=xX^().,√π% "

_PREFIX = re.compile(
    r"^(the\s+)?((handwritten|written)\s+)?(text|ink|characters?|transcription|answer)"
    r"(\s+(is|says|reads|shown))?\s*[:\-–]\s*",
    re.I,
)


def configured() -> bool:
    return bool(ACCOUNT_ID and API_TOKEN)


def model_name() -> str:
    return MODEL


def extract_answer(payload: dict) -> str:
    result = payload.get("result") if isinstance(payload, dict) else None
    if isinstance(result, dict) and isinstance(result.get("result"), dict):
        inner = result["result"]
        for key in ("answer", "response", "caption"):
            val = inner.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    if isinstance(result, dict):
        for key in ("answer", "response", "caption"):
            val = result.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        if isinstance(result.get("result"), str) and result["result"].strip():
            return result["result"].strip()
    if isinstance(result, str):
        return result.strip()
    return ""


def clean_text(raw: str) -> str:
    s = str(raw or "").strip().strip("`\"'")
    lines = [ln.strip() for ln in s.splitlines() if ln.strip()]
    if lines:
        s = lines[-1]
    s = _PREFIX.sub("", s).strip().strip("`\"'")
    s = s.replace("×", "x").replace("÷", "/").replace("—", "-").replace("–", "-")
    s = re.sub(r"sqrt", "√", s, flags=re.I)
    s = re.sub(r"\bpi\b", "π", s, flags=re.I)
    if re.search(r"\b(image|shows|background|number|digit|character)\b", s, re.I):
        named = re.search(
            r"(?:number|digit|character|says|reads)\s+['\"]?([0-9A-Za-zÄÖÜäöüß+\-*/=xX√π%()]{1,32})",
            s,
            re.I,
        )
        if named:
            s = named.group(1)
        else:
            quoted = re.search(r"['\"]([^'\"]{1,48})['\"]", s)
            if quoted:
                s = quoted.group(1)
            else:
                tokens = re.findall(r"[0-9A-Za-zÄÖÜäöüß+\-*/=xX^()√π%]+", s)
                s = max(tokens, key=len) if tokens else s
    has_op = re.search(r"[+\-*/=√^%]", s)
    has_letters = re.search(r"[A-Za-zÄÖÜäöüß]", s)
    if has_op and not has_letters:
        s = re.sub(r"\s+", "", s)
    else:
        s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"[^" + KEEP_CHARS + r"]", "", s)
    if len(s) > 96:
        s = s[:96]
    return s.strip()


def _post(image_data_uri: str, prefer_digits: bool) -> dict:
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}"
    body = {
        "image": image_data_uri,
        "question": DIGIT_PROMPT if prefer_digits else TEXT_PROMPT,
        "task": "query",
        "reasoning": False,
        "temperature": 0,
        "max_tokens": 96 if not prefer_digits else 48,
        "stream": False,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def transcribe(image_data_uri: str, prefer_digits: bool = True) -> dict:
    if not configured():
        return {"ok": False, "error": "not_configured"}
    if not isinstance(image_data_uri, str) or not image_data_uri.startswith("data:image/"):
        return {"ok": False, "error": "bad_image"}
    if len(image_data_uri) > MAX_IMAGE_CHARS:
        return {"ok": False, "error": "too_large"}
    started = time.monotonic()
    try:
        payload = await asyncio.to_thread(_post, image_data_uri, prefer_digits)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")[:240]
        return {"ok": False, "error": f"http_{err.code}", "detail": detail}
    except Exception as err:  # noqa: BLE001 — network/timeouts stay optional
        return {"ok": False, "error": type(err).__name__}
    if not payload.get("success"):
        return {"ok": False, "error": "model_error", "detail": payload.get("errors")}
    text = clean_text(extract_answer(payload))
    ms = int((time.monotonic() - started) * 1000)
    if not text:
        return {"ok": False, "error": "empty", "ms": ms}
    return {"ok": True, "text": text, "ms": ms, "model": MODEL}
