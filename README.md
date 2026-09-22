# sofianotes

Live-Collaborative-Whiteboard fuer iPad (Apple Pencil), Desktop und Android.
Ein einzelnes, dauerhaftes Board, an dem mehrere Personen gleichzeitig zeichnen
koennen — inkl. Palm Rejection, Pinch-Zoom, Radiergummi und Live-Cursor der
anderen Teilnehmer.

## Stack

- Backend: Python (FastAPI) + WebSocket
- Persistenz: SQLite (`data/board.db`)
- Frontend: Vanilla JS + HTML5 Canvas (kein Framework)
- PWA: installierbar auf iPad/Android/Desktop
- Deployment: Docker, Pull-basiert vom GitHub-Repo

## Lokal entwickeln & testen

```bash
# Variante A: direkt mit Python
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
# -> http://localhost:8000

# Variante B: mit Docker (wie auf dem Server, nur auf 127.0.0.1)
docker compose up --build
# -> http://localhost:8000
```

Zum Testen der Live-Kollaboration einfach das Board in zwei Browser-Tabs
(oder einem Tab + iPad im selben WLAN via lokaler IP) oeffnen und zeichnen —
Striche, Radieren und der Cursor/Werkzeug-Hinweis der anderen Seite sollten
sofort erscheinen.

Auf einem iPad: die lokale Adresse (z.B. `http://<lokale-ip>:8000`) im
Safari-Home-Bildschirm hinzufuegen, um die PWA zu installieren und mit Apple
Pencil zu testen (Palm Rejection greift nur bei echtem `pointerType: 'pen'`,
das simuliert ein Desktop-Browser nicht).

## Bedienung

- **Stift**: zeichnet mit Apple Pencil (druckempfindlich) oder Maus. Finger-
  Touches sind standardmaessig reine Navigation (Pan/Zoom), niemals Zeichnen —
  klassische Palm Rejection.
- **Finger-Zeichnen** (Schalter 🖐️ in der Toolbar): schaltet das um, sodass
  auch ein einzelner Finger mit dem aktuell gewaehlten Werkzeug zeichnet
  (fuer Geraete/Tests ohne Stift). Zwei Finger bleiben dabei immer fuer
  Pinch-to-Zoom reserviert; kommt waehrend des Zeichnens ein zweiter Finger
  dazu, wird der Strich sofort verworfen.
- **Textmarker**: wie der Stift, aber breiter und halbtransparent, liegt beim
  Rendern immer unter der normalen Tinte (klassischer Highlighter-Effekt).
- **Formen-Erkennung** (Schalter 🔷 in der Toolbar, per Klick an/aus): mit dem
  Stift eine Linie, ein Dreieck, ein Rechteck oder einen Kreis zeichnen und am
  Ende kurz ruhig halten (Stift bleibt unten) — die Form wird dann automatisch
  glattgezogen. Ohne Halten oder bei ausgeschaltetem Schalter bleibt jeder
  Strich normale Handschrift, die Erkennung greift nie ungefragt ein.
- **Auswahl (👆 Lasso)**: mit dem Stift/der Maus eine Schlinge um Striche
  ziehen, um sie auszuwaehlen (gestrichelter Rahmen), danach von innerhalb des
  Rahmens ziehen, um die ausgewaehlten Striche zu verschieben. Ein Tap
  ausserhalb hebt die Auswahl wieder auf.
- **Radiergummi**: entfernt beruehrte Striche komplett, Kreis-Cursor zeigt die
  aktuelle Groesse.
- **Rueckgaengig/Wiederholen** (↩️/↪️ oder Strg/Cmd+Z, mit Shift fuer
  Wiederholen): persoenlicher Verlauf der eigenen Aktionen (Strich
  hinzugefuegt, radiert, verschoben). Wirkt nur auf die eigenen Aktionen,
  nicht auf das, was andere Teilnehmer gerade zeichnen.
- **Zwei Finger**: Pinch-to-Zoom (0.25x–4x) und Pan. Ein laufender Strich,
  eine laufende Verschiebung oder eine laufende Lasso-Auswahl wird sofort
  verworfen, sobald ein zweiter Finger aufsetzt.
- **Space + Maus-Drag** bzw. **mittlere Maustaste**: Pan am Desktop.
- **Mausrad**: Zoom am Desktop.

## Architektur / Sync-Protokoll

Jeder Client verbindet sich per WebSocket auf `/ws`. Beim Verbinden schickt
der Server den kompletten Board-Zustand (`init`). Waehrend des Zeichnens
werden Punkte in kleinen Batches live gestreamt (`stroke_start` /
`stroke_points` / `stroke_end`), sodass andere Teilnehmer den Strich schon
waehrend des Zeichnens sehen — nicht erst danach. Radiergummi-Aktionen werden
als kleine `erase`-Diffs (nur betroffene Strich-IDs) gesendet statt das ganze
Board neu zu laden. Live-Cursor-Updates (`cursor`) zeigen Position und
aktuell gewaehltes Werkzeug der anderen Person ueber ihrem Zeichenpunkt an.
Persistiert wird erst der fertige Strich (SQLite) — das Board uebersteht also
Server-Neustarts.

## Deployment (GitHub -> Server, Pull-Mechanismus)

Es gibt **keinen** manuellen Datei-Upload. Auf dem Server liegt ein Git-Klon
des Repos, `deploy.sh` zieht Aenderungen und baut den Container neu:

```bash
# einmalig auf dem Server, im gewuenschten Zielverzeichnis
git clone https://github.com/L8teNever/sofianotes
cd sofianotes
cp .env.example .env   # BIND_HOST/BIND_PORT fuer die eigene Umgebung anpassen

# nach jedem Push erneut ausfuehren
./deploy.sh
```

`deploy.sh` macht nichts anderes als `git pull --ff-only && docker compose up
-d --build`. Der Container bindet laut `docker-compose.yml` an
`${BIND_HOST}:${BIND_PORT}` (Default lokal `127.0.0.1:8000`). Fuer einen
produktiven Betrieb hinter einem eigenen Reverse Proxy oder Tunnel `BIND_HOST`
und `BIND_PORT` in der eigenen, nicht eingecheckten `.env` entsprechend
setzen — Details zur konkreten Domain/Tunnel-Konfiguration sind bewusst nicht
Teil dieses oeffentlichen Repos.

## Was bewusst fehlt

Mehrere Boards, Undo/Redo, Nutzer-Accounts/Login, Formen-Werkzeuge — laut
Anforderung nicht Teil dieses Projekts.
