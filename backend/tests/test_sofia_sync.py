import asyncio
import tempfile
import unittest
from pathlib import Path

from app import db, sofia_sync


def run(coro):
    return asyncio.run(coro)


def snapshot(math_name="Mathematik", with_moro=True):
    users = [
        {"id": 1, "email": "l8tenever@gmail.com", "display_name": "Simon", "role": "super_admin", "class_id": 1, "aliases": ["sim.kul@sbj.example"]},
        {"id": 3, "email": "simon@kulbarts.com", "display_name": "Simon", "role": "student", "class_id": 1, "aliases": []},
    ]
    if with_moro:
        users.append({"id": 2, "email": "moro@gmx.de", "display_name": "Moro", "role": "student", "class_id": 1, "aliases": []})
    subjects = [
        {"id": 5, "name": math_name, "short_name": "M", "color": "#808eff", "class_id": 1, "is_global": False},
        {"id": 11, "name": "Deutsch", "short_name": "D", "color": "#fff3e0", "class_id": 1, "is_global": False},
        {"id": 99, "name": "Fremde Klasse", "short_name": "FK", "color": "#00ff00", "class_id": 2, "is_global": False},
    ]
    return {"users": users, "subjects": subjects}


class SofiaSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.use_database(str(Path(self.tmp.name) / "t.db"))
        run(db.add_person_email("simon", "l8tenever@gmail.com"))
        run(db.add_person_email("simon", "simon@kulbarts.com"))
        self.board = run(db.create_board("simon", "Mitschrift", None))
        self.old_math = run(db.create_folder("simon", "mathematik", None))

    def tearDown(self):
        self.tmp.cleanup()

    def folders(self, pid):
        return {f["name"]: f for f in run(db.library(pid, None))["folders"]}

    def test_people_come_from_sofia(self):
        run(db.apply_sofia_sync(snapshot()))
        people = run(db.people())
        self.assertEqual(sorted(p["name"] for p in people), ["Moro", "Simon", "Simon"])
        # vorhandene Person bleibt erhalten (Blaetter!) und ist ueber Haupt- und Zweitadresse erreichbar
        self.assertEqual(run(db.person_by_email("l8tenever@gmail.com"))["id"], "simon")
        self.assertEqual(run(db.person_by_email("sim.kul@sbj.example"))["id"], "simon")
        self.assertTrue(run(db.person_by_email("l8tenever@gmail.com"))["isAdmin"])
        # eigenes Sofia-Konto -> eigene Person
        other = run(db.person_by_email("simon@kulbarts.com"))
        self.assertNotEqual(other["id"], "simon")
        self.assertEqual(len(run(db.library("simon", None))["boards"]), 1)
        # alte Personen ohne Sofia-Gegenstueck sind ausgeblendet, nicht geloescht
        self.assertNotIn("franz", [p["id"] for p in people])

    def test_subject_folders(self):
        run(db.apply_sofia_sync(snapshot()))
        f = self.folders("simon")
        self.assertIn("Deutsch", f)
        self.assertNotIn("Fremde Klasse", f)
        # gleichnamiger vorhandener Ordner wird uebernommen statt doppelt angelegt
        self.assertEqual(f["mathematik"]["id"], self.old_math["id"])
        self.assertEqual(f["mathematik"]["sofiaSubjectId"], 5)
        moro = run(db.person_by_email("moro@gmx.de"))
        self.assertEqual(sorted(self.folders(moro["id"])), ["Deutsch", "Mathematik"])
        # zweiter Abgleich legt nichts doppelt an, Umbenennung zieht nach
        run(db.apply_sofia_sync(snapshot(math_name="Mathe")))
        f2 = self.folders(moro["id"])
        self.assertEqual(sorted(f2), ["Deutsch", "Mathe"])
        # Person verschwindet aus Sofia -> ausgeblendet
        run(db.apply_sofia_sync(snapshot(with_moro=False)))
        self.assertIsNone(run(db.person_by_email("moro@gmx.de")))

    def test_soft_colors(self):
        self.assertEqual(db._soft_color("#fff3e0"), "#fff3e0")
        bright = db._soft_color("#00ff00")
        self.assertTrue(bright.startswith("#") and bright != "#00ff00")

    def test_lesson_matches_subject(self):
        sofia_sync._subjects = snapshot()["subjects"]
        self.assertEqual(sofia_sync._subject_for_lesson({"subject_short": "M", "subject": "M"})["id"], 5)
        self.assertEqual(sofia_sync._subject_for_lesson({"subject_short": "", "subject": "Deutsch"})["id"], 11)
        self.assertIsNone(sofia_sync._subject_for_lesson({"subject_short": "XY", "subject": "Sport"}))


if __name__ == "__main__":
    unittest.main()


class HomeworkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.use_database(str(Path(self.tmp.name) / "t.db"))
        run(db.add_person_email("simon", "l8tenever@gmail.com"))
        run(db.apply_sofia_sync(snapshot()))
        sofia_sync._subjects = snapshot()["subjects"]

    def tearDown(self):
        self.tmp.cleanup()

    def test_board_per_homework_in_subject_folder(self):
        info = run(db.sofia_person("simon"))
        folder = info["folders"][5]
        a = run(db.homework_board("simon", 42, "Mathematik – S. 12", folder))
        b = run(db.homework_board("simon", 42, "egal", folder))
        self.assertTrue(a["created"])
        self.assertFalse(b["created"])
        self.assertEqual(a["id"], b["id"])
        lib = run(db.library("simon", folder))
        self.assertEqual([x["title"] for x in lib["boards"]], ["Mathematik – S. 12"])
        self.assertEqual(run(db.get_board(a["id"]))["sofiaHomeworkId"], 42)

    def test_pack_homework(self):
        info = run(db.sofia_person("simon"))
        hw = {
            "id": 42, "subject_id": 5, "description": "S. 12 Nr. 3", "due_date": "2026-10-08",
            "checked_by": [1], "attachments": [{"url": "/uploads/homework/a.png", "type": "image", "name": "Blatt"}, {"url": "http://evil/x", "type": "file"}],
        }
        p = sofia_sync._pack_homework(hw, info, {42: "board-1"})
        self.assertTrue(p["done"])
        self.assertEqual(p["subject"], "Mathematik")
        self.assertEqual(p["boardId"], "board-1")
        self.assertEqual(len(p["attachments"]), 1)
        self.assertTrue(p["attachments"][0]["url"].startswith("/api/sofia/file?u="))
