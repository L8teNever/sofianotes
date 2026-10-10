import asyncio
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from app import main


class LocalOcrModelRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.model = root / "models" / "trocr-de-small"
        (self.model / "onnx").mkdir(parents=True)
        (self.model / "config.json").write_text("{}")
        (self.model / "onnx" / "encoder_model_quantized.onnx").write_bytes(b"x")
        (root / "geheim.txt").write_text("nein")
        self._old = main.LOCAL_OCR_DIR
        main.LOCAL_OCR_DIR = self.model

    def tearDown(self):
        main.LOCAL_OCR_DIR = self._old
        self.tmp.cleanup()

    def test_serves_model_files(self):
        r = asyncio.run(main.local_ocr_model("onnx/encoder_model_quantized.onnx"))
        self.assertEqual(Path(r.path).name, "encoder_model_quantized.onnx")

    def test_missing_file_is_404(self):
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(main.local_ocr_model("onnx/fehlt.onnx"))
        self.assertEqual(ctx.exception.status_code, 404)

    def test_no_escape_from_model_dir(self):
        for bad in ("../../geheim.txt", "../geheim.txt", "/etc/passwd"):
            with self.assertRaises(HTTPException):
                asyncio.run(main.local_ocr_model(bad))

    def test_missing_model_dir_is_404(self):
        main.LOCAL_OCR_DIR = Path(self.tmp.name) / "gibts-nicht"
        with self.assertRaises(HTTPException):
            asyncio.run(main.local_ocr_model("config.json"))

    def test_info_version_changes_with_files(self):
        a = asyncio.run(main.local_ocr_model_info())
        self.assertTrue(a["available"])
        self.assertEqual(a["bytes"], 3)
        (self.model / "onnx" / "encoder_model_quantized.onnx").write_bytes(b"xyz")
        b = asyncio.run(main.local_ocr_model_info())
        self.assertNotEqual(a["version"], b["version"])

    def test_info_without_model(self):
        main.LOCAL_OCR_DIR = Path(self.tmp.name) / "gibts-nicht"
        self.assertEqual(asyncio.run(main.local_ocr_model_info()), {"available": False})
