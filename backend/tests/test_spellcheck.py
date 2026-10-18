import unittest

from app import spellcheck


class SpellcheckTests(unittest.TestCase):
    def test_empty_without_crash(self):
        self.assertEqual(spellcheck.misspelled(""), [])
        self.assertEqual(spellcheck.misspelled("12+34"), [])

    def test_suggestions_parse_hunspell_shape(self):
        self.assertEqual(spellcheck.suggestions(""), {})
        self.assertEqual(spellcheck.suggestions("12+34"), {})
