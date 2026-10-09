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

    def test_share_roles_and_authors(self):
        s = run(db.create_board("simon", "Mathe", None))
        bid = s["id"]
        self.assertEqual(run(db.board_role("simon", bid)), "owner")
        self.assertIsNone(run(db.board_role("franz", bid)))
        run(db.share_board("simon", bid, "franz"))
        self.assertEqual(run(db.board_role("franz", bid)), "edit")
        b = run(db.share_board("simon", bid, "franz", "add"))
        self.assertEqual(b["shareRoles"], {"franz": "add"})
        self.assertEqual(run(db.board_role("franz", bid)), "add")
        run(db.share_board("simon", bid, "franz", "view"))
        self.assertEqual(run(db.board_role("franz", bid)), "view")
        lib = run(db.library("franz", None))
        self.assertEqual(lib["boards"][0]["shareRoles"], {"franz": "view"})
        stroke = {"id": "x1", "tool": "pen", "color": "#000", "size": 4, "points": [{"x": 1, "y": 1}], "board_id": bid}
        run(db.insert_stroke(dict(stroke), "simon"))
        # spaeteres Aendern durch jemand anderen laesst den Autor stehen
        run(db.insert_stroke(dict(stroke, color="#f00"), "franz"))
        self.assertEqual(run(db.stroke_owners(["x1", "nope"])), {"x1": "simon"})
        loaded = run(db.load_all(bid))
        self.assertEqual(loaded[0]["author"], "simon")

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

    def test_owner_strokes_protected_from_guest(self):
        s = run(db.create_board("simon", "Geteilt", None))
        bid = s["id"]
        run(db.share_board("simon", bid, "franz", "edit"))
        stroke = {
            "id": "own1",
            "tool": "pen",
            "color": "#000",
            "size": 4,
            "points": [{"x": 1, "y": 1}],
            "board_id": bid,
        }
        run(db.insert_stroke(dict(stroke), "simon"))
        guest = {
            "id": "g1",
            "tool": "pen",
            "color": "#0f0",
            "size": 3,
            "points": [{"x": 2, "y": 2}],
            "board_id": bid,
        }
        run(db.insert_stroke(dict(guest), "franz"))
        kept = run(db.filter_owner_protected(bid, "franz", ["own1", "g1", "new"]))
        self.assertEqual(kept, ["g1", "new"])
        as_owner = run(db.filter_owner_protected(bid, "simon", ["own1", "g1"]))
        self.assertEqual(as_owner, ["own1", "g1"])

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


class MediaLibraryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.use_database(str(Path(self.tmp.name) / "t.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_newest_first_with_person_name(self):
        a = "11111111-1111-4111-8111-111111111111"
        b = "22222222-2222-4222-8222-222222222222"
        run(db.media_library_add(a, "franz", "Tafel.jpg", 800, 600))
        run(db.media_library_add(b, "simon", "Buch.jpg", 600, 900))
        items = run(db.media_library_list(10))
        self.assertEqual([i["id"] for i in items], [b, a])
        self.assertEqual(items[1]["personId"], "franz")
        self.assertEqual(items[1]["w"], 800)
        self.assertTrue(items[0]["personName"])

    def test_reinsert_moves_up_and_keeps_uploader(self):
        a = "11111111-1111-4111-8111-111111111111"
        b = "22222222-2222-4222-8222-222222222222"
        run(db.media_library_add(a, "franz", "Tafel.jpg", 800, 600))
        run(db.media_library_add(b, "simon", "Buch.jpg", 600, 900))
        run(db.media_library_add(a, "simon", "Tafel.jpg", 800, 600))
        items = run(db.media_library_list(10))
        self.assertEqual([i["id"] for i in items], [a, b])
        self.assertEqual(items[0]["personId"], "franz")
