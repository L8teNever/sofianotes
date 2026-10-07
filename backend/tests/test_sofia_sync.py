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


class SolutionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.use_database(str(Path(self.tmp.name) / "t.db"))
        run(db.add_person_email("simon", "l8tenever@gmail.com"))
        run(db.apply_sofia_sync(snapshot()))
        self.calls = []
        self._orig = (sofia_sync.enabled, sofia_sync._upload_pdf, sofia_sync._send_json)
        sofia_sync.enabled = lambda: True
        sofia_sync._upload_pdf = lambda email, name, data: self.calls.append(("upload", email, name, data[:4])) or {"url": "/uploads/homework/x.pdf", "type": "file", "name": name}

        def send(method, path, email, payload=None):
            self.calls.append((method, path, email))
            return {"id": 77}

        sofia_sync._send_json = send

    def tearDown(self):
        sofia_sync.enabled, sofia_sync._upload_pdf, sofia_sync._send_json = self._orig
        self.tmp.cleanup()

    def test_link_existing_board(self):
        a = run(db.create_board("simon", "Alt", None))
        b = run(db.create_board("simon", "Neu", None))
        self.assertTrue(run(db.link_homework_board("simon", 5, a["id"])))
        self.assertTrue(run(db.link_homework_board("simon", 5, b["id"])))
        self.assertEqual(run(db.homework_boards("simon")), {5: b["id"]})
        self.assertFalse(run(db.link_homework_board("simon", 5, "fremd")))
        titles = [x["title"] for x in run(db.recent_boards("simon"))]
        self.assertIn("Alt", titles)

    def test_upload_creates_then_updates_solution(self):
        b = run(db.homework_board("simon", 42, "Mathe – S. 12", None))
        bid = b["id"]
        # leeres Blatt: nichts hochladen
        self.assertEqual(run(sofia_sync.upload_solution(bid))["error"], "empty")
        run(db.insert_stroke({"id": "s1", "tool": "pen", "color": "#000", "size": 4, "points": [{"x": 0, "y": 0, "p": 0.5}, {"x": 40, "y": 30, "p": 0.5}], "board_id": bid}))
        r1 = run(sofia_sync.upload_solution(bid))
        self.assertTrue(r1["ok"])
        self.assertEqual(self.calls[0][0], "upload")
        self.assertEqual(self.calls[0][3], b"%PDF")
        self.assertEqual(self.calls[1][:2], ("POST", "/homework/42/solutions"))
        self.assertEqual(run(db.get_board(bid))["sofiaSolutionId"], 77)
        run(sofia_sync.upload_solution(bid))
        self.assertEqual(self.calls[-1][:2], ("PUT", "/homework/42/solutions/77"))
        # Modus "nur per Knopf": automatisch nichts, per Knopf schon
        run(db.set_person_settings("simon", "manual", None))
        self.assertEqual(run(sofia_sync.upload_solution(bid))["error"], "off")
        self.assertTrue(run(sofia_sync.upload_solution(bid, manual=True))["ok"])
        # aus -> gar nicht
        run(db.set_person_settings("simon", "off", None))
        self.assertEqual(run(sofia_sync.upload_solution(bid, manual=True))["error"], "off")

    def test_paper_defaults(self):
        self.assertEqual(run(db.create_board("simon", "A", None))["paper"], "graph")
        run(db.set_person_settings("simon", None, "dots"))
        self.assertEqual(run(db.create_board("simon", "B", None))["paper"], "dots")
        f = run(db.create_folder("simon", "Deutsch", None))
        sub = run(db.create_folder("simon", "Aufsaetze", f["id"]))
        run(db.set_folder_paper("simon", f["id"], "lines"))
        self.assertEqual(run(db.create_board("simon", "C", sub["id"]))["paper"], "lines")
        self.assertFalse(run(db.set_folder_paper("simon", f["id"], "quatsch")))
        b = run(db.create_board("simon", "D", f["id"]))
        self.assertTrue(run(db.set_board_paper(b["id"], "blank")))
        self.assertEqual(run(db.get_board(b["id"]))["paper"], "blank")


class BoardFileTests(unittest.TestCase):
    def test_roundtrip(self):
        import tempfile
        from pathlib import Path
        from app import board_file, media

        with tempfile.TemporaryDirectory() as tmp:
            old = media.MEDIA_DIR
            media.MEDIA_DIR = Path(tmp)
            try:
                mid = "11111111-2222-3333-4444-555555555555"
                media.path_for(mid).write_bytes(b"\xff\xd8fakejpeg")
                board = {"title": "Mathe", "paper": "lines", "refs": [{"mediaId": mid, "name": "Buch"}]}
                strokes = [
                    {"id": "a", "tool": "pen", "color": "#000", "size": 2, "points": [{"x": 1, "y": 2, "p": 0.5}]},
                    {"id": "b", "tool": "image", "color": "#000", "size": 1, "points": [{"x": 0, "y": 0}, {"x": 9, "y": 9}], "extra": {"mediaId": mid, "crop": {"l": 0}}},
                    {"id": "c", "tool": "text", "color": "#000", "size": 1, "points": [{"x": 0, "y": 0}], "extra": {"html": "<b>Hi</b>"}},
                ]
                data = board_file.build(board, strokes)
                out = board_file.parse(data)
                self.assertEqual(out["title"], "Mathe")
                self.assertEqual(out["paper"], "lines")
                self.assertEqual(len(out["strokes"]), 3)
                self.assertNotEqual(out["strokes"][0]["id"], "a")
                new_mid = out["strokes"][1]["extra"]["mediaId"]
                self.assertNotEqual(new_mid, mid)
                self.assertEqual(media.load_bytes(new_mid), b"\xff\xd8fakejpeg")
                self.assertEqual(out["refs"][0]["mediaId"], new_mid)
                self.assertEqual(out["strokes"][2]["extra"]["html"], "<b>Hi</b>")
                with self.assertRaises(ValueError):
                    board_file.parse(b"kein zip")
            finally:
                media.MEDIA_DIR = old


class BoardFileHomeworkTests(unittest.TestCase):
    def test_homework_id_roundtrip(self):
        from app import board_file

        data = board_file.build({"title": "x", "sofiaHomeworkId": 7}, [])
        self.assertEqual(board_file.parse(data)["sofiaHomeworkId"], 7)
        data = board_file.build({"title": "x"}, [])
        self.assertIsNone(board_file.parse(data)["sofiaHomeworkId"])


class BoardFileFilesTests(unittest.TestCase):
    def test_file_refs_roundtrip(self):
        import tempfile
        from pathlib import Path
        from app import board_file, files

        with tempfile.TemporaryDirectory() as tmp:
            old = files.FILES_DIR
            files.FILES_DIR = Path(tmp)
            try:
                meta = files.save(b"%PDF-1.4 test", "Buch.pdf", "application/pdf")
                data = board_file.build({"title": "x", "refs": [{"fileId": meta["id"], "name": "Buch.pdf", "mime": "application/pdf"}]}, [])
                out = board_file.parse(data)
                ref = out["refs"][0]
                self.assertNotEqual(ref["fileId"], meta["id"])
                self.assertEqual(ref["name"], "Buch.pdf")
                blob, m2 = files.load(ref["fileId"])
                self.assertEqual(blob, b"%PDF-1.4 test")
                self.assertEqual(m2["mime"], "application/pdf")
            finally:
                files.FILES_DIR = old


class HistoryTests(unittest.TestCase):
    def test_log_view_restore(self):
        import asyncio
        import tempfile
        from app import db

        with tempfile.TemporaryDirectory() as tmp:
            db.use_database(tmp + "/h.db")

            async def run():
                b = await db.create_board("simon", "Verlauf", None)
                bid = b["id"]
                s1 = {"id": "s1", "tool": "pen", "color": "#000", "size": 2, "points": [{"x": 0, "y": 0}], "board_id": bid}
                await db.insert_stroke(dict(s1), "simon")
                g = await db.history_groups(bid)
                upto1 = g["groups"][0]["toId"]
                s2 = dict(s1, id="s2")
                await db.insert_stroke(s2, "simon")
                await db.insert_stroke(dict(s1, color="#f00"), "simon")
                await db.delete_strokes(["s2"], "simon")
                g = await db.history_groups(bid)
                self.assertEqual(len(g["groups"]), 1)
                grp = g["groups"][0]
                self.assertEqual((grp["added"], grp["changed"], grp["removed"]), (2, 1, 1))
                view = await db.history_view(bid, upto1, upto1)
                self.assertEqual([s["id"] for s in view["strokes"]], ["s1"])
                self.assertEqual(view["added"], ["s1"])
                full = await db.history_view(bid, grp["fromId"], grp["toId"])
                self.assertEqual([s["id"] for s in full["removed"]], [])  # s2 neu und wieder weg -> nicht "entfernt"
                authors = await db.stroke_authors(bid)
                self.assertEqual(authors["s1"]["person"], "simon")
                res = await db.restore_version(bid, upto1, "simon")
                strokes = await db.load_all(bid)
                self.assertEqual(strokes[0]["color"], "#000")
                self.assertEqual(res["restored"], 1)

            asyncio.run(run())


class SendTests(unittest.TestCase):
    def test_send_copy_and_pdf(self):
        import asyncio
        import tempfile
        from pathlib import Path
        from fastapi import HTTPException
        from app import db, files, main, media

        class Req:
            def __init__(self, body):
                self.body = body

            async def json(self):
                return self.body

        with tempfile.TemporaryDirectory() as tmp:
            db.use_database(tmp + "/s.db")
            old_f, old_m = files.FILES_DIR, media.MEDIA_DIR
            files.FILES_DIR, media.MEDIA_DIR = Path(tmp) / "f", Path(tmp) / "m"
            try:
                people = db._people_sync()
                me, other = {"id": people[0]["id"]}, {"id": people[1]["id"]}

                async def run():
                    b = await db.create_board(me["id"], "Mathe", None)
                    await db.insert_stroke({"id": "x1", "tool": "pen", "color": "#000", "size": 3, "points": [{"x": 0, "y": 0}, {"x": 50, "y": 20}], "board_id": b["id"]}, me["id"])
                    r = await main.send_board(b["id"], Req({"to": [other["id"]], "format": "sofianotes"}), me)
                    self.assertEqual(r["sent"], 1)
                    await main.send_board(b["id"], Req({"to": [other["id"]], "format": "pdf"}), me)
                    inbox = await main.get_inbox(other)
                    self.assertEqual(inbox["unseen"], 2)
                    self.assertEqual(sorted(i["kind"] for i in inbox["items"]), ["board", "pdf"])
                    copy = next(i for i in inbox["items"] if i["kind"] == "board")
                    self.assertNotEqual(copy["boardId"], b["id"])
                    self.assertEqual(db._board_row(copy["boardId"])["ownerId"], other["id"])
                    self.assertEqual(len(await db.load_all(copy["boardId"])), 1)
                    pdf = next(i for i in inbox["items"] if i["kind"] == "pdf")
                    self.assertTrue(files.load(pdf["fileId"])[0].startswith(b"%PDF"))
                    await main.inbox_seen(other)
                    self.assertEqual((await main.get_inbox(other))["unseen"], 0)
                    with self.assertRaises(HTTPException):
                        await main.send_board(b["id"], Req({"to": [me["id"]], "format": "pdf"}), me)

                asyncio.run(run())
            finally:
                files.FILES_DIR, media.MEDIA_DIR = old_f, old_m


class NotebookTests(unittest.TestCase):
    def test_notebook_store_and_file(self):
        import asyncio
        import tempfile
        from pathlib import Path
        from app import board_file, db, goodnotes_export, media

        with tempfile.TemporaryDirectory() as tmp:
            db.use_database(tmp + "/n.db")
            old = media.MEDIA_DIR
            media.MEDIA_DIR = Path(tmp) / "m"
            try:
                mid = "11111111-2222-3333-4444-555555555555"
                media.path_for(mid).write_bytes(b"\xff\xd8fake")

                async def run():
                    b = await db.create_board("simon", "Heft", None)
                    nb = db.clean_notebook({"layout": "horizontal", "template": {"paper": "lines"}, "pages": [{"id": "p1"}, {"id": "p2", "paper": "dots", "mediaId": mid, "w": 900, "h": 600}, {"bad": 1}]})
                    self.assertEqual(len(nb["pages"]), 2)
                    await db.set_board_notebook(b["id"], nb)
                    board = await db.get_board(b["id"])
                    self.assertEqual(board["notebook"]["layout"], "horizontal")
                    rects = goodnotes_export.page_rects(board["notebook"])
                    self.assertEqual(rects[1][1], 794 + 48)
                    data = board_file.build(board, [])
                    out = board_file.parse(data)
                    self.assertEqual(out["notebook"]["pages"][0]["paper"], "graph")
                    new_mid = out["notebook"]["pages"][1]["mediaId"]
                    self.assertNotEqual(new_mid, mid)
                    self.assertEqual(media.load_bytes(new_mid), b"\xff\xd8fake")

                asyncio.run(run())
            finally:
                media.MEDIA_DIR = old
