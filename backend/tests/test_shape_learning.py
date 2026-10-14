import unittest

from app.shape_learning import DEFAULTS, clean_event, compute_params, compute_stats


def ev(kind, shape=None, ellipse=None, line=None, ms=None):
    return {"event": kind, "shape": shape, "ellipse": ellipse, "line": line, "ms": ms}


class ShapeLearningTests(unittest.TestCase):
    def test_defaults_with_few_samples(self):
        self.assertEqual(compute_params([ev("snap_kept", "circle", 0.05)]), DEFAULTS)

    def test_false_alarms_tighten_ellipse_tolerance(self):
        events = [ev("snap_kept", "circle", 0.04)] * 10 + [ev("snap_undone", "circle", 0.11, ms=900)] * 10
        params = compute_params(events)
        self.assertLess(params["ellipseTol"], 0.11)
        self.assertGreaterEqual(params["ellipseTol"], 0.04)

    def test_missed_attempts_loosen_ellipse_tolerance(self):
        events = [ev("snap_kept", "circle", 0.05)] * 6 + [ev("missed", None, 0.16)] * 10
        self.assertGreaterEqual(compute_params(events)["ellipseTol"], 0.16)

    def test_line_tolerance_adapts(self):
        events = [ev("snap_kept", "line", line=1.03)] * 8 + [ev("snap_undone", "line", line=1.09)] * 8
        self.assertLess(compute_params(events)["lineTol"], 1.09)

    def test_hold_time_reacts_to_false_alarms_and_misses(self):
        many_fp = [ev("snap_undone", "circle", 0.1)] * 15 + [ev("snap_kept", "circle", 0.05)] * 5
        self.assertGreater(compute_params(many_fp)["holdMs"], DEFAULTS["holdMs"])
        many_missed = [ev("missed", None, 0.1)] * 15 + [ev("snap_kept", "circle", 0.05)] * 5
        self.assertLess(compute_params(many_missed)["holdMs"], DEFAULTS["holdMs"])

    def test_bounds(self):
        events = [ev("snap_undone", "circle", 0.01, ms=100)] * 200
        params = compute_params(events)
        self.assertGreaterEqual(params["ellipseTol"], 0.06)
        self.assertLessEqual(params["holdMs"], 2500)

    def test_stats_and_cleaning(self):
        stats = compute_stats([ev("snap_undone", "circle", 0.1, ms=1000), ev("snap_undone", "line", ms=3000), ev("snap_kept", "line")])
        self.assertEqual(stats["undone"], 2)
        self.assertEqual(stats["avgUndoMs"], 2000)
        self.assertIsNone(clean_event({"event": "hack"}))
        self.assertEqual(clean_event({"event": "missed", "ellipse": "0.2"})["ellipse"], 0.2)


if __name__ == "__main__":
    unittest.main()
