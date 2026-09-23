import asyncio
import tempfile
import unittest
from pathlib import Path

from app import db


def run(coro):
    return asyncio.run(coro)


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.use_database(str(Path(self.tmp.name) / "t.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_people(self):
        people = run(db.people())
        self.assertEqual([p["id"] for p in people], ["simon", "franz", "jungen"])

    def test_separate_boards_and_share(self):
        s = run(db.create_board("simon", "Mathe", None))
        f = run(db.create_board("franz", "Musik", None))
        self.assertIsNotNone(s)
        lib_s = run(db.library("simon", None))
        lib_f = run(db.library("franz", None))
        self.assertEqual(len(lib_s["boards"]), 1)
        self.assertEqual(len(lib_f["boards"]), 1)
        self.assertEqual(lib_s["boards"][0]["title"], "Mathe")
        run(db.share_board("simon", s["id"], "jungen"))
        lib_j = run(db.library("jungen", None))
        self.assertEqual(len(lib_j["boards"]), 1)
        self.assertTrue(lib_j["boards"][0]["shared"])
        self.assertEqual(lib_j["boards"][0]["title"], "Mathe")
        folder = run(db.create_folder("jungen", "Schule", None))
        self.assertTrue(run(db.place_board("jungen", s["id"], folder["id"])))
        root = run(db.library("jungen", None))
        nested = run(db.library("jungen", folder["id"]))
        self.assertEqual(len(root["boards"]), 0)
        self.assertEqual(len(nested["boards"]), 1)
        sim = run(db.library("simon", None))
        self.assertEqual(sim["boards"][0]["folderId"], None)

    def test_strokes_stay_on_board(self):
        a = run(db.create_board("simon", "A", None))
        b = run(db.create_board("simon", "B", None))
        run(
            db.insert_stroke(
                {
                    "id": "s1",
                    "tool": "pen",
                    "color": "#000",
                    "size": 4,
                    "points": [{"x": 1, "y": 1, "p": 1}],
                    "board_id": a["id"],
                }
            )
        )
        self.assertEqual(len(run(db.load_all(a["id"]))), 1)
        self.assertEqual(len(run(db.load_all(b["id"]))), 0)
        self.assertTrue(run(db.can_access("simon", a["id"])))
        self.assertFalse(run(db.can_access("franz", a["id"])))

    def test_client_ids_and_upsert(self):
        bid = "11111111-1111-4111-8111-111111111111"
        board = run(db.create_board("simon", "Offline", None, bid))
        self.assertEqual(board["id"], bid)
        again = run(db.create_board("simon", "Offline", None, bid))
        self.assertEqual(again["id"], bid)
        run(
            db.insert_stroke(
                {
                    "id": "off1",
                    "tool": "pen",
                    "color": "#000",
                    "size": 3,
                    "points": [{"x": 0, "y": 0, "p": 1}],
                    "board_id": bid,
                }
            )
        )
        self.assertEqual(len(run(db.load_all(bid))), 1)


if __name__ == "__main__":
    unittest.main()
