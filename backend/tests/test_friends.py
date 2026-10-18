import asyncio
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import db
from app.auth import ACCESS_EMAIL_HEADER
from app.main import app


def run(coro):
    return asyncio.run(coro)


SIMON = {ACCESS_EMAIL_HEADER: "simon@example.com"}
FRANZ = {ACCESS_EMAIL_HEADER: "franz@example.com"}


class FriendsWatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.use_database(str(Path(self.tmp.name) / "t.db"))
        run(db.add_person_email("simon", "simon@example.com"))
        run(db.add_person_email("franz", "franz@example.com"))
        self.client = TestClient(app)
        self.board = run(db.create_board("simon", "Mathe Heft", None))

    def tearDown(self):
        self.tmp.cleanup()

    def ws(self, headers, watch=False):
        url = "/ws?board=" + self.board["id"] + ("&watch=1" if watch else "")
        return self.client.websocket_connect(url, headers=headers)

    def assert_refused(self, headers, watch):
        with self.ws(headers, watch) as w:
            with self.assertRaises(WebSocketDisconnect) as ctx:
                w.receive_json()
            self.assertEqual(ctx.exception.code, 4403)

    def test_watch_needs_someone_in_the_document(self):
        self.assert_refused(FRANZ, watch=False)  # keine Freigabe
        self.assert_refused(FRANZ, watch=True)  # niemand drin, dem man zuschauen koennte

    def test_watch_view_only_with_notice_and_copy(self):
        with self.ws(SIMON) as host:
            self.assertEqual(host.receive_json()["type"], "init")
            friends = self.client.get("/api/friends", headers=FRANZ).json()
            simon = next(p for p in friends["people"] if p["id"] == "simon")
            self.assertTrue(simon["online"])
            self.assertEqual(simon["doc"]["title"], "Mathe Heft")
            with self.ws(FRANZ, watch=True) as guest:
                init = guest.receive_json()
                self.assertEqual(init["type"], "init")
                self.assertEqual(init["role"], "view")
                seen = [host.receive_json() for _ in range(2)]
                join = next(m for m in seen if m["type"] == "watch_join")
                self.assertEqual(join["person"], "franz")
                # eigene Kopie geht beim Zuschauen
                res = self.client.post("/api/boards/" + self.board["id"] + "/copy", headers=FRANZ).json()
                self.assertTrue(res["ok"])
                self.assertEqual(res["board"]["ownerId"], "franz")
                self.assertTrue(res["board"]["title"].startswith("Kopie"))
            self.assertEqual(host.receive_json()["type"], "presence_leave")
            self.assertEqual(host.receive_json()["type"], "watch_leave")

    def test_opt_out_hides_document_and_refuses_watch(self):
        self.client.put("/api/me/prefs", headers=SIMON, json={"prefs": {"sofianotes-allow-watch": "0"}, "merge": True})
        with self.ws(SIMON) as host:
            host.receive_json()
            simon = next(p for p in self.client.get("/api/friends", headers=FRANZ).json()["people"] if p["id"] == "simon")
            self.assertTrue(simon["online"])
            self.assertIsNone(simon["doc"])
            self.assert_refused(FRANZ, watch=True)
        # ohne Zuschauen keine Kopie
        self.assertEqual(self.client.post("/api/boards/" + self.board["id"] + "/copy", headers=FRANZ).status_code, 404)


if __name__ == "__main__":
    unittest.main()
