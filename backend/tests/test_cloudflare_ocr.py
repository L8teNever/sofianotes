import unittest

from app.cloudflare_ocr import clean_text, extract_answer


class CloudflareOcrTests(unittest.TestCase):
    def test_extract_nested_moondream_answer(self):
        payload = {
            "success": True,
            "result": {
                "result": {"answer": "12+34", "caption": None},
                "usage": {},
            },
        }
        self.assertEqual(extract_answer(payload), "12+34")

    def test_clean_strips_sentence_and_spaces_for_math(self):
        self.assertEqual(clean_text("The handwritten text says: 12 + 34"), "12+34")
        self.assertEqual(clean_text("`7`"), "7")
        self.assertEqual(clean_text("Hallo"), "Hallo")
        self.assertEqual(
            clean_text("The image shows a large, bold, black number 7 on a white background."),
            "7",
        )

    def test_clean_keeps_root_equals_pi(self):
        self.assertEqual(clean_text("sqrt 9 = 3"), "√9=3")
        self.assertEqual(clean_text("2π"), "2π")
        self.assertEqual(clean_text("50%"), "50%")

        self.assertEqual(clean_text("Übung Hausaufgaben"), "Übung Hausaufgaben")

    def test_clean_empty(self):
        self.assertEqual(clean_text("   "), "")
