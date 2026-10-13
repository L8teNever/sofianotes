"""Bilder umwandeln, die der Browser nicht kann."""
import io

import pytest

from app import media


def _img(fmt, mode="RGB"):
    from PIL import Image

    im = Image.new(mode, (40, 30), (200, 10, 10, 128) if mode == "RGBA" else (200, 10, 10))
    buf = io.BytesIO()
    im.save(buf, fmt)
    return buf.getvalue()


@pytest.mark.parametrize("fmt,mode", [("PNG", "RGBA"), ("BMP", "RGB"), ("TIFF", "RGB"), ("WEBP", "RGB"), ("GIF", "P")])
def test_converts_to_jpeg(fmt, mode):
    out = media.convert_to_jpeg(_img(fmt, mode))
    assert out[:3] == b"\xff\xd8\xff"


def test_heic():
    pytest.importorskip("pillow_heif")
    import pillow_heif
    from PIL import Image

    pillow_heif.register_heif_opener()
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (0, 120, 200)).save(buf, "HEIF")
    assert media.convert_to_jpeg(buf.getvalue())[:3] == b"\xff\xd8\xff"


def test_garbage_rejected():
    with pytest.raises(ValueError):
        media.convert_to_jpeg(b"not an image")
