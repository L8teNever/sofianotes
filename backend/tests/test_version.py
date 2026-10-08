import unittest

from app.version import get_version_info, inject_build, read_version


class VersionTests(unittest.TestCase):
    def test_version_info_shape(self):
        info = get_version_info("1700000000")
        self.assertEqual(info["build_ts"], "1700000000")
        self.assertIn("version", info)
        self.assertIn("commit", info)
        self.assertIn("build_date", info)
        self.assertEqual(info["channel"], "Production")
        self.assertIn(".", info["build_date"])

    def test_inject_build(self):
        sw = 'const CACHE_NAME = "sofianotes-v__BUILD__"; v="%%APP_VERSION%%";'
        out = inject_build(sw, "42")
        self.assertIn("sofianotes-v42", out)
        self.assertNotIn("__BUILD__", out)
        self.assertNotIn("%%APP_VERSION%%", out)
        self.assertIn(read_version(), out)

    def test_read_version_semver(self):
        parts = read_version().split(".")
        self.assertGreaterEqual(len(parts), 3)


if __name__ == "__main__":
    unittest.main()
