import io
import json
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from app.goodnotes_export import build_goodnotes_archive, build_pdf
import app.goodnotes_export as ge


def sample_strokes():
    return [
        {
            "id": "a",
            "tool": "marker",
            "color": "#e63946",
            "size": 18,
            "points": [{"x": 0, "y": 0, "p": 1}, {"x": 80, "y": 40, "p": 1}, {"x": 160, "y": 10, "p": 1}],
        },
        {
            "id": "b",
            "tool": "pen",
            "color": "#1c1c1e",
            "size": 4,
            "points": [{"x": 10, "y": 80, "p": 0.8}, {"x": 40, "y": 120, "p": 0.6}, {"x": 90, "y": 90, "p": 0.7}],
        },
        {
            "id": "c",
            "tool": "text",
            "color": "#0b57d0",
            "size": 22,
            "points": [{"x": 200, "y": 80, "p": 1, "text": "42"}, {"x": 230, "y": 58, "p": 1}],
        },
        {
            "id": "d",
            "tool": "image",
            "color": "#000000",
            "size": 1,
            "points": [{"x": 0, "y": 200}, {"x": 120, "y": 280}],
            "extra": {"mediaId": "00000000-0000-0000-0000-000000000000", "crop": {"l": 0, "t": 0, "r": 1, "b": 1}},
        },
    ]


class GoodnotesExportTests(unittest.TestCase):
    def test_pdf_header(self):
        data = build_pdf(sample_strokes())
        self.assertTrue(data.startswith(b"%PDF"))
        self.assertGreater(len(data), 200)

    def test_empty_board_pdf(self):
        data = build_pdf([])
        self.assertTrue(data.startswith(b"%PDF"))

    def test_archive_contents(self):
        archive = build_goodnotes_archive(sample_strokes())
        zf = zipfile.ZipFile(io.BytesIO(archive))
        names = set(zf.namelist())
        self.assertEqual(names, {"manifest.json", "strokes.json", "sofianotes.pdf"})
        strokes = json.loads(zf.read("strokes.json"))
        self.assertEqual(len(strokes), 4)
        self.assertTrue(zf.read("sofianotes.pdf").startswith(b"%PDF"))
        manifest = json.loads(zf.read("manifest.json"))
        self.assertEqual(manifest["app"], "sofianotes")
        self.assertEqual(manifest["format"], 1)

    def test_write_exports_atomic(self):
        with TemporaryDirectory() as raw:
            tmp = Path(raw)
            old_gn, old_pdf = ge.GOODNOTES_PATH, ge.PDF_PATH
            ge.GOODNOTES_PATH = tmp / "sofianotes.goodnotes"
            ge.PDF_PATH = tmp / "sofianotes.pdf"
            try:
                gn, pdf = ge.write_exports(sample_strokes())
                self.assertTrue(gn.exists())
                self.assertTrue(pdf.exists())
                self.assertTrue(pdf.read_bytes().startswith(b"%PDF"))
                self.assertTrue(zipfile.is_zipfile(gn))
            finally:
                ge.GOODNOTES_PATH = old_gn
                ge.PDF_PATH = old_pdf


if __name__ == "__main__":
    unittest.main()
