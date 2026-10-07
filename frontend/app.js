(() => {
  "use strict";

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  window.__sofiaMainCtx = ctx;
  const eraserCursorEl = document.getElementById("eraser-cursor");
  const statusEl = document.getElementById("status");
  const statusTextEl = document.getElementById("status-text");
  const zoomIndicatorEl = document.getElementById("zoom-indicator");
  const toolbarEl = document.getElementById("toolbar");
  const sizeSlider = document.getElementById("size-slider");
  const shapeToggleEl = document.getElementById("shape-toggle");
  const fingerDrawToggleEl = document.getElementById("finger-draw-toggle");
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");

  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 4;
  const GRID_SIZE = 32;
  // ---- Geraete-Einstellungen mit dem Konto abgleichen ----
  // Stift, Farben, Leisten, Zoom usw. liegen lokal im Browser und zusaetzlich am Konto.
  // Nur eigene Aenderungen gehen hoch (kurz gebuendelt); nachgesehen wird einmal beim Oeffnen.
  const PREF_KEYS = [
    "sofianotes-prefs",
    "sofianotes-colors",
    "sofianotes-dock",
    "sofianotes-undo-corner",
    "sofianotes-topbar-pos",
    "sofianotes-topbar-hidden",
    "sofianotes-rulerbar-pos",
    "sofianotes-zoom-rows",
    "sofianotes-zoom-step",
    "sofianotes-zoompane-pos",
    "sofianotes-math",
    "sofianotes-eraser-return",
    "sofianotes-hwpanel-layout",
    "sofianotes-hwpanel",
    "sofianotes-hwpill-pos",
    "sofianotes-calc",
    "sofianotes-nb-paging",
    "sofianotes-nb-spread",
    "sofianotes-templates",
  ];
  const PREF_META = "sofianotes-prefs-sync"; // {at, dirty}
  const prefSync = (() => {
    let meta = { at: 0, dirty: false };
    try {
      meta = Object.assign(meta, JSON.parse(localStorage.getItem(PREF_META) || "{}"));
    } catch (err) {}
    let pushTimer = null;
    let applying = false;
    const saveMeta = () => {
      try {
        origSet.call(localStorage, PREF_META, JSON.stringify(meta));
      } catch (err) {}
    };
    const proto = window.Storage && Storage.prototype;
    const origSet = proto.setItem;
    const origRemove = proto.removeItem;
    const touched = (store, key) => {
      if (applying || store !== window.localStorage || !PREF_KEYS.includes(key)) return;
      meta.dirty = true;
      saveMeta();
      clearTimeout(pushTimer);
      pushTimer = setTimeout(push, 1500);
    };
    proto.setItem = function (key, value) {
      const before = this === window.localStorage ? this.getItem(key) : null;
      origSet.call(this, key, value);
      if (before !== String(value)) touched(this, key);
    };
    proto.removeItem = function (key) {
      origRemove.call(this, key);
      touched(this, key);
    };
    function localPrefs() {
      const out = {};
      for (const k of PREF_KEYS) {
        const v = localStorage.getItem(k);
        if (v != null) out[k] = v;
      }
      return out;
    }
    async function push() {
      clearTimeout(pushTimer);
      try {
        const r = await fetch("/api/me/prefs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prefs: localPrefs() }),
        });
        if (!r.ok) throw new Error(r.status);
        const res = await r.json();
        meta = { at: res.updatedAt || Date.now() / 1000, dirty: false };
        saveMeta();
      } catch (err) {
        /* offline: beim naechsten Mal */
      }
    }
    // Rueckgabe: true, wenn sich lokal etwas geaendert hat
    async function pull() {
      let res;
      try {
        const r = await fetch("/api/me/prefs", { cache: "no-store" });
        if (!r.ok) return false;
        res = await r.json();
      } catch (err) {
        return false;
      }
      if (meta.dirty || !res.updatedAt) {
        push();
        return false;
      }
      if (res.updatedAt <= meta.at) return false;
      const remote = res.prefs || {};
      let changed = false;
      applying = true;
      try {
        for (const k of PREF_KEYS) {
          const v = Object.prototype.hasOwnProperty.call(remote, k) ? remote[k] : null;
          if (localStorage.getItem(k) === v) continue;
          changed = true;
          if (v == null) localStorage.removeItem(k);
          else localStorage.setItem(k, v);
        }
      } finally {
        applying = false;
      }
      meta = { at: res.updatedAt, dirty: false };
      saveMeta();
      return changed;
    }
    // Neu laden nur, wenn gerade kein Blatt offen ist (sonst beim naechsten Start)
    async function check(force) {
      const boardOpen = typeof currentBoardId === "string" && currentBoardId && libraryBackdrop.classList.contains("hidden");
      if (boardOpen && !force) {
        if (meta.dirty) push();
        return;
      }
      if (await pull()) {
        try {
          if (sessionStorage.getItem("sofianotes-prefs-reload") === String(meta.at)) return;
          sessionStorage.setItem("sofianotes-prefs-reload", String(meta.at));
        } catch (err) {}
        location.reload();
      }
    }
    // noch nicht hochgeladene Aenderung nicht verlieren, wenn die App weggelegt wird
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && meta.dirty) push();
    });
    return { check, push };
  })();

  // ---- Notizbuch: A4-Seiten statt unendlichem Blatt ----
  const A4_W = 794;
  const A4_H = 1123;
  const PAGE_GAP = 48;
  let notebookBoardId = null;
  let notebook = null; // {layout, template: {paper, mediaId?}, pages: [{id, paper, mediaId?, w, h}]}
  // Lage der Seiten in Weltkoordinaten (gleich wie auf dem Server fuer den PDF-Export)
  function pageRects(nb) {
    const out = [];
    if (!nb) return out;
    const horiz = nb.layout === "horizontal";
    let pos = 0;
    for (const pg of nb.pages || []) {
      const w = pg.w || A4_W;
      const h = pg.h || A4_H;
      out.push(horiz ? { page: pg, id: pg.id, x: pos, y: 0, w, h } : { page: pg, id: pg.id, x: 0, y: pos, w, h });
      pos += (horiz ? w : h) + PAGE_GAP;
    }
    return out;
  }
  // Wie ein echter A4-Block: 5-mm-Kaestchen bzw. -Punkte, liniert mit ca. 8,5 mm,
  // Kopfbereich und roter Randlinie. 1 mm = A4_W / 210 Welteinheiten.
  const MM = A4_W / 210;
  const NB_GRID = 5 * MM;
  const NB_LINE = 8.5 * MM;
  const NB_LINE_TOP = 25 * MM;
  const NB_MARGIN = 20 * MM;
  function drawPagePattern(paper, r, target, unit) {
    if (paper === "blank") return;
    const ctx = target || window.__sofiaMainCtx;
    const scale = unit || currentScale();
    if (paper === "dots") {
      ctx.fillStyle = "rgba(60,70,90,0.30)";
      const rad = Math.max(0.55, 1.0 / scale);
      for (let x = r.x + NB_GRID; x < r.x + r.w - 1; x += NB_GRID)
        for (let y = r.y + NB_GRID; y < r.y + r.h - 1; y += NB_GRID) {
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      return;
    }
    ctx.lineWidth = Math.max(0.35, 0.9 / scale);
    if (paper === "graph") {
      ctx.strokeStyle = "rgba(80,100,150,0.20)";
      ctx.beginPath();
      for (let x = r.x + NB_GRID; x < r.x + r.w - 1; x += NB_GRID) {
        ctx.moveTo(x, r.y);
        ctx.lineTo(x, r.y + r.h);
      }
      for (let y = r.y + NB_GRID; y < r.y + r.h - 1; y += NB_GRID) {
        ctx.moveTo(r.x, y);
        ctx.lineTo(r.x + r.w, y);
      }
      ctx.stroke();
      return;
    }
    // liniert
    ctx.strokeStyle = "rgba(80,100,150,0.30)";
    ctx.beginPath();
    for (let y = r.y + NB_LINE_TOP; y < r.y + r.h - NB_LINE * 0.6; y += NB_LINE) {
      ctx.moveTo(r.x, y);
      ctx.lineTo(r.x + r.w, y);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(217,48,37,0.40)";
    ctx.beginPath();
    ctx.moveTo(r.x + NB_MARGIN, r.y);
    ctx.lineTo(r.x + NB_MARGIN, r.y + r.h);
    ctx.stroke();
  }
  // Im Notizbuch nicht von den Seiten wegscrollen oder -zoomen koennen
  function clampNotebookView() {
    const rects = pageRects(notebook);
    if (!rects.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxW = 0, maxH = 0;
    for (const r of rects) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
      maxW = Math.max(maxW, r.w);
      maxH = Math.max(maxH, r.h);
    }
    const left = viewLeft;
    const right = window.innerWidth - viewRight;
    const top = 76;
    const bottom = window.innerHeight - 20;
    const availW = right - left;
    const availH = bottom - top;
    // hoechstens so weit raus, dass eine ganze Seite drauf passt
    const spreadW = window.sofiaNbSpread && window.sofiaNbSpread() ? maxW * 2 + PAGE_GAP : maxW;
    const minScale = Math.max(MIN_ZOOM, Math.min(availW / spreadW, availH / maxH) * 0.92);
    if (scale < minScale) {
      const c = screenToWorld(left + availW / 2, top + availH / 2);
      scale = minScale;
      offsetX = left + availW / 2 - c.x * scale;
      offsetY = top + availH / 2 - c.y * scale;
    }
    const fit = (lo, hi, a, b, endRoom) => {
      // a..b = Inhalt am Bildschirm; lo..hi = sichtbarer Bereich -> Verschiebung.
      // Hinter der letzten Seite bleibt Platz fuer den "Neue Seite"-Knopf.
      const m = 24;
      if (b - a <= hi - lo - m - endRoom) return (lo + hi - endRoom) / 2 - (a + b) / 2; // kleiner als Bildschirm: mittig
      if (a > lo + m) return lo + m - a;
      if (b < hi - endRoom) return hi - endRoom - b;
      return 0;
    };
    const horiz = notebook.layout === "horizontal";
    offsetX += fit(left, right, minX * scale + offsetX, maxX * scale + offsetX, horiz ? 110 : 24);
    offsetY += fit(top, bottom, minY * scale + offsetY, maxY * scale + offsetY, horiz ? 24 : 130);
  }

  function drawPages() {
    const a = screenToWorld(viewLeft, 0);
    const b = screenToWorld(window.innerWidth - viewRight, window.innerHeight);
    for (const r of pageRects(notebook)) {
      if (r.x > b.x || r.x + r.w < a.x || r.y > b.y || r.y + r.h < a.y) continue;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.16)";
      ctx.shadowBlur = 14 * scale * dpr;
      ctx.shadowOffsetY = 3 * scale * dpr;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      const img = r.page.mediaId ? ensureMedia(r.page.mediaId) : null;
      if (img && img.complete && img.naturalWidth) ctx.drawImage(img, r.x, r.y, r.w, r.h);
      else if (!r.page.mediaId) drawPagePattern(r.page.paper || "graph", r);
      ctx.restore();
    }
  }

  // Versionsverlauf: Vorschau eines alten Stands und farbige Markierungen
  let historyView = null; // {strokes: Map, marks: Map id->color, ghosts: [stroke]}
  let authorMarks = null; // Map id->color (live: wer hat was geschrieben)
  function drawHistoryMarks() {
    const marks = historyView ? historyView.marks : authorMarks;
    if (!marks || !marks.size) return;
    const src = historyView ? historyView.strokes : boardStrokes;
    const pad = 5 / scale;
    ctx.save();
    for (const [id, color] of marks) {
      const s = src.get(id);
      if (!s || !s.bbox) continue;
      const b = s.bbox;
      ctx.fillStyle = hexToRgba(color, 0.16);
      ctx.strokeStyle = hexToRgba(color, 0.55);
      ctx.lineWidth = 1.5 / scale;
      ctx.beginPath();
      const x = b.minX - pad, y = b.minY - pad, w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6 / scale);
      else ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
  // im Abschnitt geloeschte Striche: blass und rot gestrichelt umrandet
  function drawHistoryGhosts() {
    if (!historyView || !historyView.ghosts.length) return;
    ctx.save();
    ctx.globalAlpha = 0.3;
    for (const g of historyView.ghosts) drawStroke(g);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(217,48,37,0.8)";
    ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.lineWidth = 1.5 / scale;
    const pad = 5 / scale;
    for (const g of historyView.ghosts) {
      const b = g.bbox;
      if (b) ctx.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2);
    }
    ctx.restore();
  }

  // Persoenliche Einstellungen vom Server (gelten auf allen Geraeten)
  const mySettings = { solutionMode: "auto", defaultPaper: "graph" };
  function lsGetRaw(k) {
    try {
      return localStorage.getItem(k);
    } catch (err) {
      return null;
    }
  }
  let zoomStepDefault = (() => {
    const v = parseFloat(lsGetRaw("sofianotes-zoom-step"));
    return Number.isFinite(v) && v > 0 ? v : 0;
  })();
  let zoomRowsDefault = (() => {
    const v = parseFloat(lsGetRaw("sofianotes-zoom-rows"));
    return Number.isFinite(v) && v > 0 ? v : 1;
  })();
  const POINTS_FLUSH_MS = 30;
  const ERASE_FLUSH_MS = 60;
  const CURSOR_SEND_MS = 45;
  // Formen-Erkennung nur bei bewusstem Stillhalten: deutlich laenger als jede normale
  // Schreibpause, sonst wird Handschrift faelschlich als Form erkannt.
  // Haltezeit/Toleranzen lernt der Server aus den Rueckmeldungen aller Geraete (siehe
  // shape_learning.py) und schickt sie live; das hier sind nur die Startwerte.
  const shapeParams = { holdMs: 1500, stillPx: 12, ellipseTol: 0.12, lineTol: 1.12 };
  const HOLD_HINT_MS = 450; // ab hier zeigt ein Ring an der Stiftspitze, dass gleich eine Form erkannt wird
  const MIN_MOVE_WORLD = 0.35; // kleine Stiftbewegungen zaehlen mit, sonst wirken Kurven eckig
  const GAP_FILL_WORLD = 3.5; // grosse Luecken zwischen Samples mit Zwischenpunkten fuellen

  const uuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });

  // ---- view transform (world <-> screen, CSS px) ----------------------
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  function worldToScreen(x, y) {
    return { x: x * scale + offsetX, y: y * scale + offsetY };
  }
  function screenToWorld(x, y) {
    return { x: (x - offsetX) / scale, y: (y - offsetY) / scale };
  }
  function clampZoom(z) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  }

  // Sichtbarer Zeichenbereich: ohne Seitenleiste das ganze Fenster. Ist die Aufgabe als
  // Seitenleiste angedockt, wird die Zeichenflaeche schmaler (und rutscht bei einer Leiste
  // links nach rechts). Bildschirm-Koordinaten bleiben Fenster-Koordinaten - nur beim
  // Zeichnen wird um viewLeft verschoben.
  let viewLeft = 0;
  let viewRight = 0;
  function viewWidth() {
    return Math.max(120, window.innerWidth - viewLeft - viewRight);
  }
  function resizeCanvas() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = viewWidth();
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = window.innerHeight + "px";
    canvas.style.left = viewLeft + "px";
    requestRedraw();
  }
  function currentScale() {
    return scale;
  }
  window.sofiaView = () => ({ scale, offsetX, offsetY });
  let pagesInsetLeft = 0; // Seiten-Leiste im Notizbuch (links)
  let requestedInsets = [0, 0];
  function setViewInsets(left, right) {
    requestedInsets = [left || 0, right || 0];
    left = Math.max(pagesInsetLeft, Math.round(left || 0));
    right = Math.max(0, Math.round(right || 0));
    if (left === viewLeft && right === viewRight) return;
    // was vorher in der Mitte des Sichtbereichs lag, bleibt dort
    const oldMid = viewLeft + (window.innerWidth - viewLeft - viewRight) / 2;
    viewLeft = left;
    viewRight = right;
    const newMid = viewLeft + (window.innerWidth - viewLeft - viewRight) / 2;
    offsetX += newMid - oldMid;
    document.documentElement.style.setProperty("--view-left", viewLeft + "px");
    document.documentElement.style.setProperty("--view-right", viewRight + "px");
    resizeCanvas();
    layoutTopBar();
    // die Rueckgaengig-Knoepfe gleiten animiert an ihren Platz -> danach nochmal einpassen
    setTimeout(layoutTopBar, 420);
    if (typeof positionToolPopover === "function") positionToolPopover();
  }
  // Obere Leiste bei schmalem Zeichenbereich (Seitenleiste angedockt) in den freien Platz
  // neben den Rueckgaengig-Knoepfen einpassen; der Blattname wird dafuer gekuerzt.
  function layoutTopBar() {
    const bar = document.getElementById("top-filename-bar");
    const undo = document.getElementById("undo-redo-dock");
    if (!bar) return;
    document.body.classList.toggle("view-narrow", !!(viewLeft || viewRight));
    const vertical = bar.classList.contains("tb-vertical") || bar.classList.contains("free-drag");
    if (!viewLeft && !viewRight || vertical) {
      bar.style.left = "";
      bar.style.transform = "";
      bar.style.maxWidth = "";
      return;
    }
    let from = viewLeft + 12;
    let to = window.innerWidth - viewRight - 12;
    const u = undo && !undo.classList.contains("free-drag") ? undo.getBoundingClientRect() : null;
    const atBottom = bar.classList.contains("tb-bottom");
    if (u && u.width && (atBottom ? u.bottom > window.innerHeight - 80 : u.top < 80)) {
      if (u.left < (from + to) / 2) from = Math.max(from, u.right + 10);
      else to = Math.min(to, u.left - 10);
    }
    bar.style.maxWidth = Math.max(200, to - from) + "px";
    const w = Math.min(bar.scrollWidth, to - from);
    bar.style.transform = "none";
    bar.style.left = Math.round(from + Math.max(0, (to - from - w) / 2)) + "px";
  }
  window.addEventListener("resize", () => layoutTopBar());
  window.addEventListener("resize", () => {
    resizeCanvas();
    positionToolPopover();
  });

  // ---- board state ------------------------------------------------------
  const boardStrokes = new Map(); // id -> stroke
  const remoteInProgress = new Map(); // strokeId -> stroke (owned by other client)
  let currentStroke = null; // own in-progress stroke
  let dirty = true;
  let cropState = null;
  function requestRedraw() {
    dirty = true;
  }

  function makeBBox(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }
  function unionBBox(boxes) {
    if (boxes.length === 0) return null;
    const u = { ...boxes[0] };
    for (const b of boxes.slice(1)) {
      if (b.minX < u.minX) u.minX = b.minX;
      if (b.minY < u.minY) u.minY = b.minY;
      if (b.maxX > u.maxX) u.maxX = b.maxX;
      if (b.maxY > u.maxY) u.maxY = b.maxY;
    }
    return u;
  }

  function widthAt(size, _pressure) {
    // Stift und Marker haben eine feste Staerke — kein Druck vom Pencil.
    return Math.max(1, size);
  }

  function lerpPt(a, b, t) {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      p: (a.p || 0.5) * (1 - t) + (b.p || 0.5) * t,
    };
  }

  function quadPoint(p0, p1, p2, t) {
    const u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
      p: u * u * (p0.p || 0.5) + 2 * u * t * (p1.p || 0.5) + t * t * (p2.p || 0.5),
    };
  }

  // Quadratische Mittelpunkt-Kurve statt Catmull-Rom: folgt den Punkten
  // ohne UeberSchwinger, die als dunkle Marker-Perlen oder eckige Tinte wirken.
  function densifyStroke(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    const firstMid = lerpPt(pts[0], pts[1], 0.5);
    const firstLen = Math.hypot(firstMid.x - pts[0].x, firstMid.y - pts[0].y);
    const firstSteps = Math.max(1, Math.min(6, Math.ceil(firstLen / 2.2)));
    for (let s = 1; s <= firstSteps; s++) out.push(lerpPt(pts[0], firstMid, s / firstSteps));
    for (let i = 1; i < pts.length - 1; i++) {
      const start = lerpPt(pts[i - 1], pts[i], 0.5);
      const ctrl = pts[i];
      const end = lerpPt(pts[i], pts[i + 1], 0.5);
      const segLen =
        Math.hypot(ctrl.x - start.x, ctrl.y - start.y) + Math.hypot(end.x - ctrl.x, end.y - ctrl.y);
      const steps = Math.max(1, Math.min(10, Math.ceil(segLen / 2.2)));
      for (let s = 1; s <= steps; s++) out.push(quadPoint(start, ctrl, end, s / steps));
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function looksLikePolygon(pts) {
    if (pts.length === 2) return true;
    if (pts.length < 3 || pts.length > 6) return false;
    const a = pts[0];
    const b = pts[pts.length - 1];
    return Math.hypot(a.x - b.x, a.y - b.y) < 6;
  }

  function drawRibbon(c, pts, size, color, alpha, constantWidth) {
    const radii = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      radii[i] = constantWidth ? size / 2 : widthAt(size, pts[i].p) / 2;
    }
    if (!constantWidth) {
      for (let pass = 0; pass < 2; pass++) {
        const next = radii.slice();
        for (let i = 1; i < radii.length - 1; i++) next[i] = (radii[i - 1] + radii[i] * 2 + radii[i + 1]) / 4;
        for (let i = 1; i < radii.length - 1; i++) radii[i] = next[i];
      }
    }

    const left = new Array(pts.length);
    const right = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[i === 0 ? 0 : i - 1];
      const next = pts[i === pts.length - 1 ? i : i + 1];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) {
        dx = 1;
        dy = 0;
      } else {
        dx /= len;
        dy /= len;
      }
      const nx = -dy;
      const ny = dx;
      const r = radii[i];
      left[i] = { x: pts[i].x + nx * r, y: pts[i].y + ny * r };
      right[i] = { x: pts[i].x - nx * r, y: pts[i].y - ny * r };
    }

    c.save();
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < left.length; i++) c.lineTo(left[i].x, left[i].y);
    for (let i = right.length - 1; i >= 0; i--) c.lineTo(right[i].x, right[i].y);
    c.closePath();
    c.fill();
    c.beginPath();
    c.arc(pts[0].x, pts[0].y, radii[0], 0, Math.PI * 2);
    c.arc(pts[pts.length - 1].x, pts[pts.length - 1].y, radii[radii.length - 1], 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  function avgPressureWidth(pts, size) {
    let pSum = 0;
    for (const p of pts) pSum += p.p || 0.5;
    return widthAt(size, pSum / pts.length);
  }

  function traceStraightPath(c, pts) {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
  }

  function traceMidpointPath(c, pts) {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2) {
      c.lineTo(pts[1].x, pts[1].y);
      return;
    }
    c.lineTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    c.lineTo(last.x, last.y);
  }

  function drawPolylineStroke(c, pts, size, color, alpha, constantWidth, smooth) {
    c.save();
    c.globalAlpha = alpha;
    c.strokeStyle = color;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.miterLimit = 2;
    if (smooth && !looksLikePolygon(pts)) traceMidpointPath(c, pts);
    else traceStraightPath(c, pts);
    c.lineWidth = constantWidth ? size : avgPressureWidth(pts, size);
    c.stroke();
    c.restore();
  }

  function drawStroke(stroke, target, opts) {
    const c = target || ctx;
    const pts = stroke.points;
    if (pts.length === 0) return;
    if (stroke.tool === "table") {
      drawTable(c, stroke);
      return;
    }
    if (isBoxText(stroke)) {
      drawBoxText(c, stroke);
      return;
    }
    if (stroke.tool === "text") {
      const label = (pts[0] && pts[0].text) || "";
      if (!label) return;
      c.save();
      c.globalAlpha = 1;
      c.fillStyle = stroke.color || "#0b57d0";
      c.font = `600 ${Math.max(14, stroke.size || 22)}px Inter, sans-serif`;
      c.textBaseline = "alphabetic";
      c.textAlign = "left";
      c.translate(pts[0].x, pts[0].y);
      const rot = strokeRotation(stroke);
      if (rot) c.rotate(rot);
      c.fillText(label, 0, 0);
      c.restore();
      return;
    }
    if (stroke.tool === "image") {
      drawImageStroke(c, stroke);
      return;
    }
    const isMarker = stroke.tool === "marker";
    const alpha = opts && opts.alpha != null ? opts.alpha : isMarker ? 0.38 : 1;
    if (pts.length === 1) {
      const p = pts[0];
      c.save();
      c.globalAlpha = alpha;
      c.beginPath();
      c.fillStyle = stroke.color;
      c.arc(p.x, p.y, stroke.size / 2, 0, Math.PI * 2);
      c.fill();
      c.restore();
      return;
    }
    const taggedShape = stroke.extra && stroke.extra.shape;
    if (
      taggedShape === "rectangle" ||
      taggedShape === "triangle" ||
      taggedShape === "line" ||
      looksLikePolygon(pts)
    ) {
      drawPolylineStroke(c, pts, stroke.size, stroke.color, alpha, true, false);
      return;
    }
    // feste Breite, glatte Kurve — Druckstaerke aendert die Dicke nicht
    drawPolylineStroke(c, pts, stroke.size, stroke.color, alpha, true, true);
  }

  const mediaImages = new Map();

  function ensureMedia(mediaId) {
    if (!mediaId) return null;
    let img = mediaImages.get(mediaId);
    if (img) return img;
    img = new Image();
    img.decoding = "async";
    img.onload = () => requestRedraw();
    img.src = "/api/media/" + encodeURIComponent(mediaId);
    img.onerror = () => {
      if (!window.SofiaOffline) return;
      SofiaOffline.getMedia(mediaId).then((blob) => {
        if (!blob) return;
        img.src = URL.createObjectURL(blob);
      });
    };
    mediaImages.set(mediaId, img);
    return img;
  }

  function imageDestRect(stroke) {
    const pts = stroke.points || [];
    if (pts.length < 2) return null;
    const minX = Math.min(pts[0].x, pts[1].x);
    const minY = Math.min(pts[0].y, pts[1].y);
    const maxX = Math.max(pts[0].x, pts[1].x);
    const maxY = Math.max(pts[0].y, pts[1].y);
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function imageCrop(stroke) {
    const c = (stroke.extra && stroke.extra.crop) || {};
    const l = Math.max(0, Math.min(0.98, c.l == null ? 0 : c.l));
    const t = Math.max(0, Math.min(0.98, c.t == null ? 0 : c.t));
    const r = Math.max(l + 0.02, Math.min(1, c.r == null ? 1 : c.r));
    const b = Math.max(t + 0.02, Math.min(1, c.b == null ? 1 : c.b));
    return { l, t, r, b };
  }

  function imageFullRect(stroke) {
    const dest = imageDestRect(stroke);
    if (!dest) return null;
    const crop = imageCrop(stroke);
    const fw = dest.w / (crop.r - crop.l);
    const fh = dest.h / (crop.b - crop.t);
    const minX = dest.minX - crop.l * fw;
    const minY = dest.minY - crop.t * fh;
    return { minX, minY, maxX: minX + fw, maxY: minY + fh, w: fw, h: fh };
  }

  function rotatePoint(p, cx, cy, ang) {
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos, p: p.p, text: p.text };
  }

  function strokeRotation(stroke) {
    const r = stroke && stroke.extra && stroke.extra.rotation;
    return Number.isFinite(r) ? r : 0;
  }

  function imageRotatedCorners(stroke) {
    const dest = imageDestRect(stroke);
    if (!dest) return [];
    const cx = dest.minX + dest.w / 2;
    const cy = dest.minY + dest.h / 2;
    const rot = strokeRotation(stroke);
    const pts = [
      { x: dest.minX, y: dest.minY },
      { x: dest.maxX, y: dest.minY },
      { x: dest.maxX, y: dest.maxY },
      { x: dest.minX, y: dest.maxY },
    ];
    if (!rot) return pts;
    return pts.map((p) => rotatePoint(p, cx, cy, rot));
  }

  function strokeWorldBBox(stroke) {
    if (!stroke) return null;
    if (stroke.tool === "image") {
      const corners = imageRotatedCorners(stroke);
      if (corners.length) return makeBBox(corners);
    }
    return makeBBox(stroke.points || []);
  }

  function drawImageStroke(c, stroke) {
    const dest = imageDestRect(stroke);
    if (!dest || dest.w < 1 || dest.h < 1) return;
    const extra = stroke.extra || {};
    const showingCrop = cropState && cropState.strokeId === stroke.id;
    const rect = showingCrop ? cropState.full : dest;
    const crop = showingCrop ? cropState.crop : imageCrop(stroke);
    const img = ensureMedia(extra.mediaId);
    c.save();
    if (!img || !img.complete || !img.naturalWidth) {
      c.fillStyle = "#e8eaed";
      c.fillRect(dest.minX, dest.minY, dest.w, dest.h);
      c.strokeStyle = "#9aa0a6";
      c.lineWidth = 1.5 / scale;
      c.strokeRect(dest.minX, dest.minY, dest.w, dest.h);
      c.restore();
      return;
    }
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const sx = crop.l * nw;
    const sy = crop.t * nh;
    const sw = Math.max(1, (crop.r - crop.l) * nw);
    const sh = Math.max(1, (crop.b - crop.t) * nh);
    if (showingCrop) {
      c.globalAlpha = 0.38;
      c.drawImage(img, rect.minX, rect.minY, rect.w, rect.h);
      c.globalAlpha = 1;
      const cx = rect.minX + crop.l * rect.w;
      const cy = rect.minY + crop.t * rect.h;
      const cw = (crop.r - crop.l) * rect.w;
      const ch = (crop.b - crop.t) * rect.h;
      c.drawImage(img, sx, sy, sw, sh, cx, cy, cw, ch);
    } else {
      const rot = strokeRotation(stroke);
      const cx = dest.minX + dest.w / 2;
      const cy = dest.minY + dest.h / 2;
      c.translate(cx, cy);
      if (rot) c.rotate(rot);
      c.drawImage(img, sx, sy, sw, sh, -dest.w / 2, -dest.h / 2, dest.w, dest.h);
    }
    c.restore();
  }

  const markerLayer = document.createElement("canvas");
  const markerCtx = markerLayer.getContext("2d", { alpha: true });

  function syncMarkerLayer() {
    if (markerLayer.width !== canvas.width || markerLayer.height !== canvas.height) {
      markerLayer.width = canvas.width;
      markerLayer.height = canvas.height;
    } else {
      markerCtx.setTransform(1, 0, 0, 1, 0, 0);
      markerCtx.clearRect(0, 0, markerLayer.width, markerLayer.height);
    }
  }

  let gridStyle = "graph";

  // area/k optional: fuer das Zoom-Fenster (eigener Ausschnitt, eigener Massstab)
  function drawGrid(target, area, k) {
    if (gridStyle === "blank") return;
    const ctx = target || window.__sofiaMainCtx;
    const unit = k || scale;
    const topLeft = area ? { x: area.minX, y: area.minY } : screenToWorld(0, 0);
    const bottomRight = area ? { x: area.maxX, y: area.maxY } : screenToWorld(window.innerWidth, window.innerHeight);
    const startX = Math.floor(topLeft.x / GRID_SIZE) * GRID_SIZE;
    const startY = Math.floor(topLeft.y / GRID_SIZE) * GRID_SIZE;

    if (gridStyle === "dots") {
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      const r = 1.15 / unit;
      for (let x = startX; x <= bottomRight.x; x += GRID_SIZE) {
        for (let y = startY; y <= bottomRight.y; y += GRID_SIZE) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return;
    }

    ctx.lineWidth = 1 / unit;
    if (gridStyle !== "lines") {
      for (let x = startX; x <= bottomRight.x; x += GRID_SIZE) {
        const bold = Math.round(x / GRID_SIZE) % 4 === 0;
        ctx.strokeStyle = bold ? "rgba(70,90,150,0.22)" : "rgba(70,90,150,0.10)";
        ctx.beginPath();
        ctx.moveTo(x, topLeft.y);
        ctx.lineTo(x, bottomRight.y);
        ctx.stroke();
      }
    }
    for (let y = startY; y <= bottomRight.y; y += GRID_SIZE) {
      const bold = Math.round(y / GRID_SIZE) % 4 === 0;
      ctx.strokeStyle = bold ? "rgba(70,90,150,0.22)" : "rgba(70,90,150,0.10)";
      ctx.beginPath();
      ctx.moveTo(topLeft.x, y);
      ctx.lineTo(bottomRight.x, y);
      ctx.stroke();
    }
  }

  function drawLassoAndSelection() {
    if (lassoPoints && lassoPoints.length > 1) {
      ctx.save();
      ctx.setLineDash([6 / scale, 5 / scale]);
      ctx.strokeStyle = "#3b6fe0";
      ctx.lineWidth = 1.5 / scale;
      ctx.beginPath();
      ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
      for (let i = 1; i < lassoPoints.length; i++) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
      ctx.stroke();
      ctx.restore();
    }
    if (selection.ids.size > 0 && selection.bbox) {
      const b = selection.bbox;
      const pad = 10 / scale;
      ctx.save();
      ctx.setLineDash([6 / scale, 5 / scale]);
      ctx.strokeStyle = "#3b6fe0";
      ctx.lineWidth = 1.5 / scale;
      ctx.fillStyle = "rgba(59,111,224,0.08)";
      const x = b.minX - pad, y = b.minY - pad, w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#3b6fe0";
      ctx.lineWidth = 1.5 / scale;
      const hs = 5 / scale;
      for (const p of selectionHandlePoints(b, pad)) {
        if (p.edge) {
          // Seitengriff als kleine Pille entlang der Kante
          const horiz = p.name === "n" || p.name === "s";
          const lw = (horiz ? 18 : 8) / scale;
          const lh = (horiz ? 8 : 18) / scale;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(p.x - lw / 2, p.y - lh / 2, lw, lh, 4 / scale);
          else ctx.rect(p.x - lw / 2, p.y - lh / 2, lw, lh);
          ctx.fill();
          ctx.stroke();
          continue;
        }
        ctx.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
        ctx.strokeRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
      }
      const rot = selectionRotateHandle(b, pad);
      const midBottom = { x: (b.minX + b.maxX) / 2, y: b.maxY + pad };
      ctx.beginPath();
      ctx.moveTo(midBottom.x, midBottom.y);
      ctx.lineTo(rot.x, rot.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rot.x, rot.y, 7 / scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#3b6fe0";
      ctx.beginPath();
      ctx.arc(rot.x, rot.y, 2.2 / scale, 0, Math.PI * 2);
      ctx.fill();
      // ausgewaehlte Tabelle: kleine Griffe auf den inneren Linien (zum Ziehen)
      const selT = typeof selectedTable === "function" ? selectedTable() : null;
      if (selT) {
        const g = tableGeom(selT);
        ctx.fillStyle = "#3b6fe0";
        const gw = 4 / scale, gl = 14 / scale;
        const live = dragState && dragState.kind === "tblline" ? dragState : null;
        for (let i = 1; i < g.xs.length - 1; i++) {
          if (live && live.axis === "x" && live.i === i) {
            ctx.fillRect(g.xs[i] - 1 / scale, g.y0, 2 / scale, g.H);
          }
          ctx.fillRect(g.xs[i] - gw / 2, g.y0, gw, gl);
        }
        for (let i = 1; i < g.ys.length - 1; i++) {
          if (live && live.axis === "y" && live.i === i) {
            ctx.fillRect(g.x0, g.ys[i] - 1 / scale, g.W, 2 / scale);
          }
          ctx.fillRect(g.x0, g.ys[i] - gw / 2, gl, gw);
        }
        ctx.fillStyle = "#fff";
      }
      const knots = selectedEditKnots();
      const kr = 4.5 / scale;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#0b57d0";
      ctx.lineWidth = 1.6 / scale;
      for (const k of knots) {
        ctx.beginPath();
        ctx.arc(k.x, k.y, kr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
    if (cropState && cropState.full) {
      const full = cropState.full;
      const crop = cropState.crop;
      const cx = full.minX + crop.l * full.w;
      const cy = full.minY + crop.t * full.h;
      const cw = (crop.r - crop.l) * full.w;
      const ch = (crop.b - crop.t) * full.h;
      ctx.save();
      ctx.fillStyle = "rgba(15,23,42,0.35)";
      ctx.fillRect(full.minX, full.minY, full.w, cy - full.minY);
      ctx.fillRect(full.minX, cy + ch, full.w, full.maxY - (cy + ch));
      ctx.fillRect(full.minX, cy, cx - full.minX, ch);
      ctx.fillRect(cx + cw, cy, full.maxX - (cx + cw), ch);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2 / scale;
      ctx.strokeRect(cx, cy, cw, ch);
      ctx.fillStyle = "#fff";
      const hs = 6 / scale;
      for (const p of cropHandlePoints(full, crop)) {
        ctx.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
        ctx.strokeStyle = "#3b6fe0";
        ctx.strokeRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
      }
      ctx.restore();
    }
    positionMediaToolbar();
  }

  // Ecken: gleichmaessig skalieren. Seitenmitten: nur in die Breite bzw. Hoehe strecken.
  function selectionHandlePoints(b, pad) {
    const x0 = b.minX - pad, y0 = b.minY - pad, x1 = b.maxX + pad, y1 = b.maxY + pad;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    return [
      { name: "nw", x: x0, y: y0 },
      { name: "ne", x: x1, y: y0 },
      { name: "sw", x: x0, y: y1 },
      { name: "se", x: x1, y: y1 },
      { name: "n", x: mx, y: y0, edge: true },
      { name: "s", x: mx, y: y1, edge: true },
      { name: "w", x: x0, y: my, edge: true },
      { name: "e", x: x1, y: my, edge: true },
    ];
  }

  function selectionRotateHandle(b, pad) {
    const lift = 26 / Math.max(scale, 0.25);
    return { name: "rot", x: (b.minX + b.maxX) / 2, y: b.maxY + pad + lift };
  }

  function cropHandlePoints(full, crop) {
    const x0 = full.minX + crop.l * full.w;
    const y0 = full.minY + crop.t * full.h;
    const x1 = full.minX + crop.r * full.w;
    const y1 = full.minY + crop.b * full.h;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    return [
      { name: "nw", x: x0, y: y0 },
      { name: "n", x: mx, y: y0 },
      { name: "ne", x: x1, y: y0 },
      { name: "w", x: x0, y: my },
      { name: "e", x: x1, y: my },
      { name: "sw", x: x0, y: y1 },
      { name: "s", x: mx, y: y1 },
      { name: "se", x: x1, y: y1 },
    ];
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = notebook ? "#e8e6ed" : "#f8f9fa";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, (offsetX - viewLeft) * dpr, offsetY * dpr);
    let pageClip = false;
    if (notebook) {
      clampNotebookView();
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, (offsetX - viewLeft) * dpr, offsetY * dpr);
      drawPages();
      // alles Geschriebene endet am Seitenrand
      ctx.save();
      ctx.beginPath();
      for (const r of pageRects(notebook)) ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      pageClip = true;
    } else drawGrid();
    if (window.sofiaPagesUi) window.sofiaPagesUi();
    // im Versionsverlauf: alter Stand statt des aktuellen Blatts
    const src = historyView ? historyView.strokes : boardStrokes;
    drawHistoryMarks();

    for (const stroke of src.values()) if (stroke.tool === "image") drawStroke(stroke);
    for (const stroke of remoteInProgress.values()) if (stroke.tool === "image") drawStroke(stroke);
    // Tabellen liegen wie Papier unter der Tinte, damit man direkt in die Zellen schreiben kann.
    for (const stroke of src.values()) if (stroke.tool === "table") drawStroke(stroke);

    // Marker auf eigenem Layer in voller Deckkraft, dann einmalig mit Alpha
    // draufgelegt — so entstehen keine dunklen Perlen durch Selbstueberlagerung.
    // Nach den Bildern, damit Textmarker auf Fotos und PDFs liegt.
    syncMarkerLayer();
    markerCtx.setTransform(scale * dpr, 0, 0, scale * dpr, (offsetX - viewLeft) * dpr, offsetY * dpr);
    for (const stroke of src.values()) if (stroke.tool === "marker") drawStroke(stroke, markerCtx, { alpha: 1 });
    for (const stroke of remoteInProgress.values()) if (stroke.tool === "marker") drawStroke(stroke, markerCtx, { alpha: 1 });
    if (currentStroke && currentStroke.tool === "marker") drawStroke(currentStroke, markerCtx, { alpha: 1 });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.38;
    ctx.drawImage(markerLayer, 0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, (offsetX - viewLeft) * dpr, offsetY * dpr);

    for (const stroke of src.values()) if (stroke.tool !== "marker" && stroke.tool !== "image" && stroke.tool !== "table") drawStroke(stroke);
    drawHistoryGhosts();
    for (const stroke of remoteInProgress.values()) if (stroke.tool !== "marker" && stroke.tool !== "image") drawStroke(stroke);
    if (currentStroke && currentStroke.tool && currentStroke.tool !== "marker") drawStroke(currentStroke);
    if (pageClip) {
      ctx.restore();
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, (offsetX - viewLeft) * dpr, offsetY * dpr);
    }

    drawTextDragPreview();
    drawZoomBoxOnPage();
    drawLassoAndSelection();
    drawRuler();
    drawHoldHint();
    positionTextEditor();
    positionInkChips();
    positionScanBoxes();

    zoomIndicatorEl.textContent = Math.round(scale * 100) + "%";
    repositionPresenceLabels();
    drawZoomPane();
    if (ruler.visible) positionRulerBar();
  }

  function tick() {
    if (holdHint) dirty = true; // Fortschrittsring laeuft fluessig mit
    if (dirty) {
      draw();
      dirty = false;
    }
    flushNetworkBuffers();
    requestAnimationFrame(tick);
  }

  // ---- toolbar ------------------------------------------------------
  let currentTool = "pen"; // pen | marker | eraser | select
  let currentColor = "#1E1F22";
  let penSize = 6;
  let markerSize = 24;
  let eraserSize = 28;
  let selection = { ids: new Set(), bbox: null };
  let shapeRecognitionEnabled = true;
  let fingerDrawEnabled = false;
  let mathSolveEnabled = localStorage.getItem("sofianotes-math") !== "0";
  let eraserReturnEnabled = localStorage.getItem("sofianotes-eraser-return") !== "0";
  let lastToolBeforeEraser = "pen";
  let strokeClipboard = [];
  let lastPointerWorld = null;

  const toolConfigs = {
    pen: { label: "Stift", min: 1, max: 45, presets: [3, 8, 20] },
    marker: { label: "Marker", min: 6, max: 60, presets: [12, 24, 40] },
    eraser: { label: "Radierer", min: 5, max: 80, presets: [12, 28, 55] },
    select: { label: "Auswahl", min: 1, max: 20, presets: [] },
    text: { label: "Text", min: 10, max: 96, presets: [18, 28, 44], names: ["Klein", "Mittel", "Groß"], title: "Textgröße" },
  };
  let textSize = 28;

  const toolPopover = document.getElementById("tool-popover");
  const popoverTitle = document.getElementById("popover-tool-title");
  const popoverSizeText = document.getElementById("popover-size-text");
  const popoverPresets = document.getElementById("popover-presets");
  const popoverPreview = document.getElementById("popover-brush-preview");
  const settingsToggleBtn = document.getElementById("btn-settings-toggle");
  const settingsBackdrop = document.getElementById("settings-backdrop");
  const settingsPopover = document.getElementById("settings-popover");
  const settingsCloseBtn = document.getElementById("btn-settings-close");
  const zoomToggleBtn = document.getElementById("btn-zoom-toggle");
  const zoomPopover = document.getElementById("zoom-popover");
  const filenameInput = document.getElementById("canvas-filename");
  const topBar = document.getElementById("top-filename-bar");
  const undoDock = document.getElementById("undo-redo-dock");

  function activeSize() {
    if (currentTool === "text") return textSize;
    if (currentTool === "eraser") return eraserSize;
    if (currentTool === "marker") return markerSize;
    return penSize;
  }

  // Stift-Einstellungen gelten fuer alle Blaetter und bleiben nach dem Neuladen
  let prefsTimer = null;
  function savePrefs() {
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => {
      try {
        localStorage.setItem(
          "sofianotes-prefs",
          JSON.stringify({
            tool: currentTool === "marker" || (currentTool !== "pen" && lastInkToolPref === "marker") ? "marker" : "pen",
            color: currentColor,
            penSize,
            markerSize,
            eraserSize,
            textSize,
            shapes: shapeRecognitionEnabled,
            finger: fingerDrawEnabled,
          })
        );
      } catch (err) {}
    }, 150);
  }
  let lastInkToolPref = "pen";

  function setActiveSize(v) {
    savePrefs();
    const n = Number(v);
    if (currentTool === "text") {
      textSize = n;
      if (textEdit) applyTextEditStyle({ size: n });
    } else if (currentTool === "eraser") eraserSize = n;
    else if (currentTool === "marker") markerSize = n;
    else penSize = n;
  }

  function isInkTool(tool) {
    return tool === "pen" || tool === "marker";
  }

  function currentDock() {
    if (toolbarEl.classList.contains("dock-top")) return "top";
    if (toolbarEl.classList.contains("dock-left")) return "left";
    if (toolbarEl.classList.contains("dock-right")) return "right";
    return "bottom";
  }

  function positionToolPopover() {
    if (!toolPopover || toolPopover.classList.contains("hidden")) return;
    if (toolPopover.parentElement !== document.body) document.body.appendChild(toolPopover);
    const dock = currentDock();
    const active = toolbarEl.querySelector(".tool-btn.active");
    const tools = toolbarEl.querySelector(".tools-container");
    const r = (active || tools).getBoundingClientRect();
    const gap = 12;
    const pad = 8;
    toolPopover.style.position = "fixed";
    toolPopover.style.zIndex = "90";
    toolPopover.style.right = "auto";
    toolPopover.style.bottom = "auto";
    toolPopover.style.transform = "none";
    const pw = toolPopover.offsetWidth || 240;
    const ph = toolPopover.offsetHeight || 180;
    let left;
    let top;
    if (dock === "bottom") {
      left = r.left + r.width / 2 - pw / 2;
      top = r.top - gap - ph;
    } else if (dock === "top") {
      left = r.left + r.width / 2 - pw / 2;
      top = r.bottom + gap;
    } else if (dock === "left") {
      left = r.right + gap;
      top = r.top + r.height / 2 - ph / 2;
    } else {
      left = r.left - gap - pw;
      top = r.top + r.height / 2 - ph / 2;
    }
    left = Math.max(pad, Math.min(window.innerWidth - pw - pad, left));
    top = Math.max(pad, Math.min(window.innerHeight - ph - pad, top));
    toolPopover.style.left = left + "px";
    toolPopover.style.top = top + "px";
  }

  function hideSettings() {
    if (settingsBackdrop) settingsBackdrop.classList.add("hidden");
  }

  function hidePopovers() {
    toolPopover.classList.add("hidden");
    hideSettings();
    zoomPopover.classList.add("hidden");
    hideEraseAllMenu();
    hidePasteMenu();
  }

  function hexToRgba(hex, alpha) {
    let c = (hex || "#000").replace("#", "");
    if (c.length === 3) c = c.split("").map((x) => x + x).join("");
    const r = parseInt(c.slice(0, 2), 16) || 0;
    const g = parseInt(c.slice(2, 4), 16) || 0;
    const b = parseInt(c.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function renderToolPopover() {
    const selected = typeof selectionInkStrokes === "function" ? selectionInkStrokes() : [];
    const usingSel = selected.length > 0;
    const cfg = usingSel
      ? toolConfigs[selected[0].tool] || toolConfigs.pen
      : toolConfigs[currentTool] || toolConfigs.pen;
    const size = usingSel ? selected[0].size : activeSize();
    popoverTitle.textContent = usingSel ? (cfg.title || "Auswahl Stärke") : cfg.title || cfg.label + " Stärke";
    popoverSizeText.textContent = Math.round(size) + " px";
    sizeSlider.min = String(cfg.min);
    sizeSlider.max = String(cfg.max);
    sizeSlider.value = String(size);
    popoverPresets.innerHTML = "";
    const names = cfg.names || ["Dünn", "Mittel", "Dick"];
    cfg.presets.forEach((preset, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "preset-btn" + (preset === size ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "preset-dot";
      const px = 6 + i * 5;
      dot.style.width = px + "px";
      dot.style.height = px + "px";
      if (currentTool === "marker" && !usingSel) dot.style.background = hexToRgba(currentColor, 0.55);
      else if (currentTool === "eraser") dot.style.background = "#94a3b8";
      else dot.style.background = currentColor;
      btn.appendChild(dot);
      const lab = document.createElement("span");
      lab.textContent = names[i] || String(preset);
      btn.appendChild(lab);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        setActiveSize(preset);
        restyleSelection({ size: preset });
        renderToolPopover();
        updateEraserCursorVisibility();
      });
      popoverPresets.appendChild(btn);
    });
    const previewPx = Math.min(22, Math.max(4, size / 2));
    popoverPreview.style.width = previewPx + "px";
    popoverPreview.style.height = previewPx + "px";
    const previewTool = usingSel ? selected[0].tool : currentTool;
    if (previewTool === "eraser") {
      popoverPreview.style.background = "#e2e8f0";
      popoverPreview.style.border = "1px solid #94a3b8";
    } else if (previewTool === "marker") {
      popoverPreview.style.background = hexToRgba(currentColor, 0.55);
      popoverPreview.style.border = "none";
    } else {
      popoverPreview.style.background = currentColor;
      popoverPreview.style.border = "none";
    }
    const clearRow = document.getElementById("eraser-clear-row");
    if (clearRow) clearRow.classList.toggle("hidden", currentTool !== "eraser" || usingSel);
    if (!toolPopover.classList.contains("hidden")) positionToolPopover();
  }

  function setTool(tool, { openPopover } = {}) {
    if (textEdit) commitTextEditor();
    if (zoomWin && (tool === "select" || tool === "text")) closeZoomWindow();
    const already = currentTool === tool;
    if (tool === "eraser" && currentTool !== "eraser") {
      lastToolBeforeEraser = currentTool || "pen";
    }
    currentTool = tool;
    if (tool === "pen" || tool === "marker") lastInkTool = lastInkToolPref = tool;
    savePrefs();
    syncModeFromTool(tool);
    toolbarEl.querySelectorAll(".tool-btn[data-tool]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tool === tool);
    });
    updateEraserCursorVisibility();
    if (tool === "eraser") clearSelection();
    hideSettings();
    zoomPopover.classList.add("hidden");
    if (tool === "select" && selection.ids.size === 0) {
      toolPopover.classList.add("hidden");
      return;
    }
    renderToolPopover();
    if (!openPopover) return;
    if (!already && tool !== "select") {
      toolPopover.classList.add("hidden");
      return;
    }
    if (tool === "select" && !already) {
      toolPopover.classList.add("hidden");
      return;
    }
    if (!toolPopover.classList.contains("hidden")) {
      toolPopover.classList.add("hidden");
      return;
    }
    toolPopover.classList.remove("hidden");
    positionToolPopover();
  }

  function restoreToolAfterEraser({ keepEraser } = {}) {
    if (keepEraser || !eraserReturnEnabled || currentTool !== "eraser") return;
    const next = lastToolBeforeEraser && lastToolBeforeEraser !== "eraser" ? lastToolBeforeEraser : "pen";
    setTool(next);
  }

  toolbarEl.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    let ignoreClick = false;
    btn.addEventListener("pointerup", (e) => {
      if (dockDrag && dockDrag.live) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const r = btn.getBoundingClientRect();
      if (e.clientX < r.left - 2 || e.clientX > r.right + 2 || e.clientY < r.top - 2 || e.clientY > r.bottom + 2) return;
      ignoreClick = true;
      setTool(btn.dataset.tool, { openPopover: true });
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (ignoreClick) {
        ignoreClick = false;
        return;
      }
      setTool(btn.dataset.tool, { openPopover: true });
    });
  });
  // ---- Farben: 4 feste Plaetze + eigene Verknuepfungen (rechts, scrollbar) ----
  // Gespeichert pro Geraet, gilt fuer alle Blaetter. Lange druecken (Rechtsklick)
  // auf eine Farbe: aendern, verschieben, entfernen.
  const DEFAULT_COLORS = ["#1E1F22", "#1A73E8", "#EA4335", "#34A853"];
  const COLOR_NAMES = { "#1E1F22": "Schwarz", "#1A73E8": "Blau", "#EA4335": "Rot", "#34A853": "Grün", "#FBBC04": "Gelb" };
  let palette = { base: DEFAULT_COLORS.slice(), custom: [] };
  try {
    const raw = JSON.parse(localStorage.getItem("sofianotes-colors") || "null");
    if (raw && Array.isArray(raw.base) && raw.base.length === DEFAULT_COLORS.length) palette.base = raw.base.map(normColor);
    if (raw && Array.isArray(raw.custom)) palette.custom = raw.custom.map(normColor).slice(0, 40);
  } catch (err) {}
  function normColor(c) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c || "").trim());
    return m ? "#" + m[1].toUpperCase() : "#1E1F22";
  }
  function savePalette() {
    try {
      localStorage.setItem("sofianotes-colors", JSON.stringify(palette));
    } catch (err) {}
  }
  const swatchBaseEl = document.getElementById("swatch-base");
  const swatchCustomEl = document.getElementById("swatch-custom");
  const swatchMenu = document.getElementById("swatch-menu");
  const swatchEditInput = document.getElementById("swatch-edit-input");
  let swatchMenuTarget = null; // {group, index}

  function pickColor(color) {
    currentColor = normColor(color);
    markActiveSwatch();
    if (textEdit) applyTextEditStyle({ color: currentColor });
    restyleSelection({ color: currentColor });
    renderToolPopover();
    savePrefs();
  }
  function markActiveSwatch() {
    let found = null;
    toolbarEl.querySelectorAll("#swatches-container .swatch").forEach((b) => {
      const on = !found && b.dataset.color === normColor(currentColor);
      b.classList.toggle("active", on);
      if (on) found = b;
    });
    if (found && found.parentElement === swatchCustomEl) {
      const l = found.offsetLeft - swatchCustomEl.offsetLeft;
      if (l < swatchCustomEl.scrollLeft || l + found.offsetWidth > swatchCustomEl.scrollLeft + swatchCustomEl.clientWidth) {
        swatchCustomEl.scrollLeft = l - swatchCustomEl.clientWidth / 2;
      }
    }
  }
  function makeSwatch(color, group, index) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.color = color;
    b.dataset.group = group;
    b.dataset.index = String(index);
    b.style.background = color;
    b.title = (COLOR_NAMES[color] || color) + " – lange drücken zum Ändern";
    let hold = null;
    let start = null;
    b.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (e.pointerType === "mouse" && e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      clearTimeout(hold);
      hold = setTimeout(() => {
        hold = "fired";
        openSwatchMenu(b);
      }, 480);
    });
    b.addEventListener("pointermove", (e) => {
      if (start && hold && hold !== "fired" && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) {
        clearTimeout(hold);
        hold = null;
      }
    });
    const cancel = () => {
      if (hold !== "fired") clearTimeout(hold);
    };
    b.addEventListener("pointerup", cancel);
    b.addEventListener("pointercancel", () => {
      clearTimeout(hold);
      hold = null;
    });
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openSwatchMenu(b);
    });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (hold === "fired" || swatchScrollDrag.moved) {
        hold = null;
        return;
      }
      hold = null;
      pickColor(color);
    });
    return b;
  }
  function renderSwatches() {
    if (!swatchBaseEl || !swatchCustomEl) return;
    swatchBaseEl.textContent = "";
    swatchCustomEl.textContent = "";
    palette.base.forEach((c, i) => swatchBaseEl.appendChild(makeSwatch(c, "base", i)));
    palette.custom.forEach((c, i) => swatchCustomEl.appendChild(makeSwatch(c, "custom", i)));
    swatchCustomEl.classList.toggle("empty", palette.custom.length === 0);
    markActiveSwatch();
  }

  // eigene Farben mit dem Finger/Stift seitlich durchschieben (die Leiste selbst
  // faengt Gesten ab, deshalb hier von Hand)
  const swatchScrollDrag = { id: null, x: 0, y: 0, sl: 0, st: 0, moved: false };
  if (swatchCustomEl) {
    swatchCustomEl.addEventListener("pointerdown", (e) => {
      swatchScrollDrag.id = e.pointerId;
      swatchScrollDrag.x = e.clientX;
      swatchScrollDrag.y = e.clientY;
      swatchScrollDrag.sl = swatchCustomEl.scrollLeft;
      swatchScrollDrag.st = swatchCustomEl.scrollTop;
      swatchScrollDrag.moved = false;
    }, true);
    window.addEventListener("pointermove", (e) => {
      if (swatchScrollDrag.id !== e.pointerId) return;
      const dx = e.clientX - swatchScrollDrag.x;
      const dy = e.clientY - swatchScrollDrag.y;
      if (!swatchScrollDrag.moved && Math.hypot(dx, dy) < 6) return;
      swatchScrollDrag.moved = true;
      swatchCustomEl.scrollLeft = swatchScrollDrag.sl - dx;
      swatchCustomEl.scrollTop = swatchScrollDrag.st - dy;
    });
    const end = (e) => {
      if (swatchScrollDrag.id !== e.pointerId) return;
      swatchScrollDrag.id = null;
      // click kommt nach pointerup - "moved" kurz stehen lassen
      setTimeout(() => (swatchScrollDrag.moved = false), 0);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    swatchCustomEl.addEventListener("wheel", (e) => {
      if (swatchCustomEl.scrollWidth <= swatchCustomEl.clientWidth && swatchCustomEl.scrollHeight <= swatchCustomEl.clientHeight) return;
      e.preventDefault();
      e.stopPropagation();
      swatchCustomEl.scrollLeft += e.deltaY + e.deltaX;
      swatchCustomEl.scrollTop += e.deltaY + e.deltaX;
    }, { passive: false });
  }

  function openSwatchMenu(btn) {
    if (!swatchMenu) return;
    swatchMenuTarget = { group: btn.dataset.group, index: Number(btn.dataset.index) };
    const custom = swatchMenuTarget.group === "custom";
    const list = palette[swatchMenuTarget.group];
    document.getElementById("swatch-menu-remove").classList.toggle("hidden", !custom);
    document.getElementById("swatch-menu-left").classList.toggle("hidden", !custom || swatchMenuTarget.index === 0);
    document.getElementById("swatch-menu-right").classList.toggle("hidden", !custom || swatchMenuTarget.index >= list.length - 1);
    swatchEditInput.value = list[swatchMenuTarget.index].toLowerCase();
    swatchMenu.classList.remove("hidden");
    const r = btn.getBoundingClientRect();
    const mw = swatchMenu.offsetWidth;
    const mh = swatchMenu.offsetHeight;
    let top = r.top - mh - 10;
    if (top < 8) top = r.bottom + 10;
    swatchMenu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.left + r.width / 2 - mw / 2)) + "px";
    swatchMenu.style.top = top + "px";
    try {
      if (navigator.vibrate) navigator.vibrate(10);
    } catch (err) {}
  }
  function closeSwatchMenu() {
    if (swatchMenu) swatchMenu.classList.add("hidden");
    swatchMenuTarget = null;
  }
  if (swatchMenu) {
    swatchMenu.addEventListener("pointerdown", (e) => e.stopPropagation());
    swatchEditInput.addEventListener("input", () => {
      if (!swatchMenuTarget) return;
      const list = palette[swatchMenuTarget.group];
      const was = list[swatchMenuTarget.index];
      const c = normColor(swatchEditInput.value);
      list[swatchMenuTarget.index] = c;
      savePalette();
      if (normColor(currentColor) === was) currentColor = c;
      renderSwatches();
      if (normColor(currentColor) === c) pickColor(c);
    });
    swatchEditInput.addEventListener("change", () => closeSwatchMenu());
    const move = (d) => {
      if (!swatchMenuTarget) return;
      const list = palette.custom;
      const i = swatchMenuTarget.index;
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      savePalette();
      renderSwatches();
      const btn = swatchCustomEl.children[j];
      if (btn) openSwatchMenu(btn);
    };
    document.getElementById("swatch-menu-left").addEventListener("click", (e) => {
      e.stopPropagation();
      move(-1);
    });
    document.getElementById("swatch-menu-right").addEventListener("click", (e) => {
      e.stopPropagation();
      move(1);
    });
    document.getElementById("swatch-menu-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!swatchMenuTarget || swatchMenuTarget.group !== "custom") return;
      palette.custom.splice(swatchMenuTarget.index, 1);
      savePalette();
      closeSwatchMenu();
      renderSwatches();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!swatchMenu.classList.contains("hidden") && !e.target.closest("#swatch-menu")) closeSwatchMenu();
    }, true);
  }

  // "+": neue Farbe waehlen -> wird rechts als eigene Verknuepfung angelegt
  const customColorInput = document.getElementById("custom-color-input");
  customColorInput.addEventListener("input", (e) => {
    currentColor = normColor(e.target.value);
    markActiveSwatch();
    restyleSelection({ color: currentColor }, "color");
    renderToolPopover();
  });
  customColorInput.addEventListener("change", (e) => {
    const c = normColor(e.target.value);
    if (!palette.base.includes(c) && !palette.custom.includes(c)) {
      palette.custom.push(c);
      savePalette();
      renderSwatches();
      swatchCustomEl.scrollLeft = swatchCustomEl.scrollWidth;
      swatchCustomEl.scrollTop = swatchCustomEl.scrollHeight;
    }
    pickColor(c);
  });
  renderSwatches();

  sizeSlider.addEventListener("input", () => {
    setActiveSize(sizeSlider.value);
    restyleSelection({ size: Number(sizeSlider.value) }, "size");
    renderToolPopover();
    updateEraserCursorVisibility();
  });
  const btnEraseAll = document.getElementById("btn-erase-all");
  const btnEraseAllHere = document.getElementById("btn-erase-all-here");
  if (btnEraseAll) {
    btnEraseAll.addEventListener("click", (e) => {
      e.stopPropagation();
      clearAllInk();
    });
  }
  if (btnEraseAllHere) {
    btnEraseAllHere.addEventListener("click", (e) => {
      e.stopPropagation();
      clearAllInk();
    });
  }

  shapeToggleEl.addEventListener("click", (e) => {
    e.stopPropagation();
    shapeRecognitionEnabled = !shapeRecognitionEnabled;
    shapeToggleEl.classList.toggle("active", shapeRecognitionEnabled);
    savePrefs();
  });

  fingerDrawToggleEl.addEventListener("click", (e) => {
    e.stopPropagation();
    fingerDrawEnabled = !fingerDrawEnabled;
    fingerDrawToggleEl.classList.toggle("active", fingerDrawEnabled);
    savePrefs();
  });

  const mathToggleEl = document.getElementById("math-toggle");
  if (mathToggleEl) {
    mathToggleEl.classList.toggle("active", mathSolveEnabled);
    mathToggleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      mathSolveEnabled = !mathSolveEnabled;
      localStorage.setItem("sofianotes-math", mathSolveEnabled ? "1" : "0");
      mathToggleEl.classList.toggle("active", mathSolveEnabled);
      renderInkOverlay();
    });
  }

  const eraserReturnToggleEl = document.getElementById("eraser-return-toggle");
  if (eraserReturnToggleEl) {
    eraserReturnToggleEl.classList.toggle("active", eraserReturnEnabled);
    eraserReturnToggleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      eraserReturnEnabled = !eraserReturnEnabled;
      localStorage.setItem("sofianotes-eraser-return", eraserReturnEnabled ? "1" : "0");
      eraserReturnToggleEl.classList.toggle("active", eraserReturnEnabled);
    });
  }

  function openSettings() {
    toolPopover.classList.add("hidden");
    zoomPopover.classList.add("hidden");
    hideEraseAllMenu();
    hidePasteMenu();
    if (settingsBackdrop) settingsBackdrop.classList.remove("hidden");
    showSettingsPage("main");
    if (window.SofiaUpdates && window.SofiaUpdates.refreshInfo) {
      window.SofiaUpdates.refreshInfo();
    }
  }

  if (settingsToggleBtn) settingsToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (settingsBackdrop && !settingsBackdrop.classList.contains("hidden")) hideSettings();
    else openSettings();
  });

  // Einstellungen: Startseite mit Bereichen, jeder Bereich als Unterseite
  const SET_TITLES = { main: "Einstellungen" };
  const GRID_NAMES = { graph: "Kariert", dots: "Punkte", lines: "Liniert", blank: "Blanko" };
  const DOCK_NAMES = { top: "Oben", bottom: "Unten", left: "Links", right: "Rechts" };
  function showSettingsPage(page) {
    if (!settingsPopover) return;
    settingsPopover.querySelectorAll(".set-page").forEach((el) => el.classList.toggle("hidden", el.dataset.page !== page));
    const nav = settingsPopover.querySelector('.set-nav[data-go="' + page + '"]');
    document.getElementById("settings-title").textContent = page === "main" ? SET_TITLES.main : nav ? nav.dataset.title : "";
    document.getElementById("btn-settings-back")?.classList.toggle("hidden", page === "main");
    settingsPopover.dataset.page = page;
    syncSettingsSummary();
  }
  function syncSettingsSummary() {
    const set = (id, t) => {
      const el = document.getElementById(id);
      if (el) el.textContent = t;
    };
    set("set-sum-paper", (currentBoardId ? "Dieses Blatt: " + (GRID_NAMES[gridStyle] || "Kariert") + " · " : "") + "Neue: " + (GRID_NAMES[mySettings.defaultPaper] || "Kariert"));
    set("set-sum-zoom", (ZOOM_ROW_NAMES[zoomRowsDefault] || zoomRowsDefault + " Kästchen hoch") + (zoomStepDefault ? " · " + String(zoomStepDefault).replace(".5", "½") + " runter" : ""));
    set("set-sum-sofia", { auto: "Automatisch teilen", manual: "Nur per Knopf", off: "Nie teilen" }[mySettings.solutionMode] || "");
    renderZoomRowsSetting();
    const on = [];
    if (shapeRecognitionEnabled) on.push("Formen");
    if (mathSolveEnabled) on.push("Rechnungen");
    if (fingerDrawEnabled) on.push("Finger zeichnet");
    set("set-sum-write", on.length ? on.join(", ") + " an" : "Alles aus");
    set("set-sum-bar", DOCK_NAMES[currentDock()] || "Unten");
    document.querySelectorAll(".set-dlg .btn-dock-quick").forEach((b) => b.classList.toggle("active", b.dataset.pos === currentDock()));
    const st = document.getElementById("settings-version-status-text");
    set("set-sum-app", (document.getElementById("settings-version-label")?.textContent || "") + (st ? " · " + st.textContent : ""));
  }
  if (settingsPopover) {
    settingsPopover.querySelectorAll(".set-nav").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        showSettingsPage(b.dataset.go);
      })
    );
    document.getElementById("btn-settings-back")?.addEventListener("click", (e) => {
      e.stopPropagation();
      showSettingsPage("main");
    });
    settingsPopover.addEventListener("click", () => setTimeout(syncSettingsSummary, 0));
  }
  document.getElementById("canvas-menu-settings")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (typeof closeCanvasMenus === "function") closeCanvasMenus();
    openSettings();
  });
  if (settingsCloseBtn) {
    settingsCloseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideSettings();
    });
  }
  if (settingsBackdrop) {
    settingsBackdrop.addEventListener("click", (e) => {
      if (e.target === settingsBackdrop) hideSettings();
    });
  }
  if (settingsPopover) {
    settingsPopover.addEventListener("click", (e) => e.stopPropagation());
  }

  // Papier gehoert zum Blatt (fuer alle gleich), neue Blaetter bekommen den Standard
  function applyPaper(paper) {
    gridStyle = GRID_NAMES[paper] ? paper : "graph";
    document.querySelectorAll(".btn-grid-style").forEach((b) => b.classList.toggle("active", b.dataset.grid === gridStyle));
    requestRedraw();
  }
  document.querySelectorAll(".btn-grid-style").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (window.sofiaSetPagePaper && window.sofiaSetPagePaper(btn.dataset.grid)) return;
      const was = gridStyle;
      const next = btn.dataset.grid;
      const bid = currentBoardId;
      if (!bid || next === was) return;
      optimistic({
        apply: () => {
          applyPaper(next);
          if (currentBoardMeta) currentBoardMeta.paper = next;
        },
        revert: () => {
          if (bid === currentBoardId) applyPaper(was);
        },
        request: () =>
          api("/api/boards/" + encodeURIComponent(bid), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paper: next }),
          }),
        failText: "Papier ändern hat nicht geklappt",
      });
    });
  });
  function renderPaperDefault() {
    document.querySelectorAll("#set-paper-default [data-paper]").forEach((b) => b.classList.toggle("active", b.dataset.paper === mySettings.defaultPaper));
  }
  function saveMySettings(patch, failText) {
    const before = { ...mySettings };
    optimistic({
      apply: () => {
        Object.assign(mySettings, patch);
        renderMySettings();
      },
      revert: () => {
        Object.assign(mySettings, before);
        renderMySettings();
      },
      request: () =>
        api("/api/me/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }),
      failText,
    });
  }
  function renderMySettings() {
    renderPaperDefault();
    document.querySelectorAll("#set-solution-mode [data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mySettings.solutionMode));
    if (typeof renderSolution === "function") renderSolution();
    syncSettingsSummary();
  }
  document.querySelectorAll("#set-paper-default [data-paper]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      saveMySettings({ defaultPaper: b.dataset.paper }, "Speichern hat nicht geklappt");
    })
  );
  document.querySelectorAll("#set-solution-mode [data-mode]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      saveMySettings({ solutionMode: b.dataset.mode }, "Speichern hat nicht geklappt");
    })
  );
  async function loadMySettings() {
    try {
      Object.assign(mySettings, await api("/api/me/settings"));
    } catch (err) {
      /* offline: Standard behalten */
    }
    renderMySettings();
    try {
      const st = await api("/api/sofia/status");
      document.getElementById("set-nav-sofia")?.classList.toggle("hidden", !(st && st.enabled));
    } catch (err) {}
  }
  // Zoom-Fenster: Standard-Schreibhoehe
  const ZOOM_ROW_NAMES = { 1: "1 Kästchen hoch", 1.5: "1½ Kästchen hoch", 2: "2 Kästchen hoch", 3: "3 Kästchen hoch" };
  function renderZoomRowsSetting() {
    document.querySelectorAll("#set-zoom-rows [data-rows]").forEach((b) => b.classList.toggle("active", parseFloat(b.dataset.rows) === zoomRowsDefault));
    document.querySelectorAll("#set-zoom-step [data-step]").forEach((b) => b.classList.toggle("active", parseFloat(b.dataset.step) === zoomStepDefault));
  }
  document.querySelectorAll("#set-zoom-step [data-step]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      zoomStepDefault = parseFloat(b.dataset.step) || 0;
      try {
        localStorage.setItem("sofianotes-zoom-step", String(zoomStepDefault));
      } catch (err) {}
      renderZoomRowsSetting();
      syncSettingsSummary();
    })
  );
  document.querySelectorAll("#set-zoom-rows [data-rows]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      zoomRowsDefault = parseFloat(b.dataset.rows);
      try {
        localStorage.setItem("sofianotes-zoom-rows", String(zoomRowsDefault));
      } catch (err) {}
      renderZoomRowsSetting();
      syncSettingsSummary();
    })
  );

  function applyZoomPercent(pct, cx, cy) {
    const x = cx == null ? window.innerWidth / 2 : cx;
    const y = cy == null ? window.innerHeight / 2 : cy;
    const anchor = screenToWorld(x, y);
    scale = clampZoom(pct / 100);
    offsetX = x - anchor.x * scale;
    offsetY = y - anchor.y * scale;
    requestRedraw();
    document.querySelectorAll(".btn-zoom-preset").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.zoom) === Math.round(scale * 100));
    });
  }

  zoomToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toolPopover.classList.add("hidden");
    hideSettings();
    zoomPopover.classList.toggle("hidden");
    if (!zoomPopover.classList.contains("hidden")) renderPeopleJumpList();
  });
  document.getElementById("btn-zoom-in").addEventListener("click", (e) => {
    e.stopPropagation();
    applyZoomPercent(Math.round(scale * 100) + 15);
  });
  document.getElementById("btn-zoom-out").addEventListener("click", (e) => {
    e.stopPropagation();
    applyZoomPercent(Math.round(scale * 100) - 15);
  });
  document.getElementById("btn-zoom-reset").addEventListener("click", (e) => {
    e.stopPropagation();
    applyZoomPercent(100);
  });
  document.querySelectorAll(".btn-zoom-preset").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      applyZoomPercent(Number(btn.dataset.zoom));
    });
  });

  // ---- movable docks ------------------------------------------------
  function setDockPosition(pos) {
    toolbarEl.classList.remove("dock-bottom", "dock-top", "dock-left", "dock-right", "free-drag", "dragging", "orient-vertical");
    toolbarEl.style.left = "";
    toolbarEl.style.top = "";
    toolbarEl.style.right = "";
    toolbarEl.style.bottom = "";
    toolbarEl.style.transform = "";
    toolbarEl.classList.add("dock-" + pos);
    localStorage.setItem("sofianotes-dock", pos);
    syncBarStack();
    positionToolPopover();
  }
  function setUndoCorner(corner) {
    undoDock.classList.remove(
      "corner-top-left",
      "corner-top-right",
      "corner-bottom-left",
      "corner-bottom-right",
      "free-drag",
      "dragging"
    );
    undoDock.style.left = "";
    undoDock.style.top = "";
    undoDock.style.right = "";
    undoDock.style.bottom = "";
    undoDock.style.transform = "";
    undoDock.classList.add("corner-" + corner);
    localStorage.setItem("sofianotes-undo-corner", corner);
  }

  const guides = {
    top: document.getElementById("guide-top"),
    bottom: document.getElementById("guide-bottom"),
    left: document.getElementById("guide-left"),
    right: document.getElementById("guide-right"),
    tl: document.getElementById("guide-tl"),
    tr: document.getElementById("guide-tr"),
    bl: document.getElementById("guide-bl"),
    br: document.getElementById("guide-br"),
  };
  const EDGE_GUIDE_KEYS = ["top", "bottom", "left", "right"];
  const CORNER_GUIDE_KEYS = ["tl", "tr", "bl", "br"];
  const CORNER_BY_GUIDE = {
    tl: "top-left",
    tr: "top-right",
    bl: "bottom-left",
    br: "bottom-right",
  };
  const GUIDE_BY_CORNER = {
    "top-left": "tl",
    "top-right": "tr",
    "bottom-left": "bl",
    "bottom-right": "br",
  };
  const DOCK_HOLD_MS = 380;
  const SNAP_PX = 88;
  const HOLD_MOVE_CANCEL_PX = 14;

  function hideGuides() {
    Object.values(guides).forEach((el) => el.classList.remove("visible", "hot"));
  }
  function showSnapGuides(kind, hotKey) {
    const keys = kind === "dock" ? EDGE_GUIDE_KEYS : CORNER_GUIDE_KEYS;
    Object.entries(guides).forEach(([k, el]) => {
      const on = keys.includes(k);
      el.classList.toggle("visible", on);
      el.classList.toggle("hot", on && k === hotKey);
    });
  }
  function nearestEdge(x, y) {
    const w = window.innerWidth, h = window.innerHeight;
    const d = { top: y, bottom: h - y, left: x, right: w - x };
    return Object.keys(d).reduce((a, b) => (d[a] < d[b] ? a : b));
  }
  function edgeDistance(x, y, edge) {
    const w = window.innerWidth, h = window.innerHeight;
    if (edge === "top") return y;
    if (edge === "bottom") return h - y;
    if (edge === "left") return x;
    return w - x;
  }
  function nearestCorner(x, y) {
    const w = window.innerWidth, h = window.innerHeight;
    const opts = {
      "top-left": Math.hypot(x, y),
      "top-right": Math.hypot(w - x, y),
      "bottom-left": Math.hypot(x, h - y),
      "bottom-right": Math.hypot(w - x, h - y),
    };
    return Object.keys(opts).reduce((a, b) => (opts[a] < opts[b] ? a : b));
  }
  function cornerDistance(x, y, corner) {
    const w = window.innerWidth, h = window.innerHeight;
    const cx = corner.includes("right") ? w : 0;
    const cy = corner.includes("bottom") ? h : 0;
    return Math.hypot(x - cx, y - cy);
  }
  function safePad() {
    return 12;
  }
  function placeEl(el, left, top) {
    const pad = 6;
    const maxL = Math.max(pad, window.innerWidth - el.offsetWidth - pad);
    const maxT = Math.max(pad, window.innerHeight - el.offsetHeight - pad);
    el.style.left = Math.min(maxL, Math.max(pad, left)) + "px";
    el.style.top = Math.min(maxT, Math.max(pad, top)) + "px";
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.transform = "none";
  }
  function dockSnapPoint(edge, el) {
    const pad = safePad();
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (edge === "bottom") return { left: (vw - w) / 2, top: vh - h - pad };
    if (edge === "top") return { left: (vw - w) / 2, top: pad };
    if (edge === "left") return { left: pad, top: (vh - h) / 2 };
    return { left: vw - w - pad, top: (vh - h) / 2 };
  }
  function cornerSnapPoint(corner, el) {
    const pad = safePad();
    const w = el.offsetWidth, h = el.offsetHeight;
    return {
      left: corner.includes("right") ? window.innerWidth - w - pad : pad,
      top: corner.includes("bottom") ? window.innerHeight - h - pad : pad,
    };
  }
  function applyToolbarOrient(edge) {
    toolbarEl.classList.toggle("orient-vertical", edge === "left" || edge === "right");
  }
  function liftDock(el, kind) {
    const r = el.getBoundingClientRect();
    if (kind === "dock") {
      toolbarEl.classList.remove("dock-bottom", "dock-top", "dock-left", "dock-right");
    } else if (kind === "topbar") {
      topBar.classList.remove("tb-top", "tb-bottom", "tb-left", "tb-right");
      topBar.style.maxWidth = "";
    } else {
      undoDock.classList.remove(
        "corner-top-left",
        "corner-top-right",
        "corner-bottom-left",
        "corner-bottom-right"
      );
    }
    el.classList.add("free-drag", "dragging");
    placeEl(el, r.left, r.top);
    try {
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (err) {}
    return r;
  }

  let dockDrag = null;

  function armDockDrag(kind, e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest("input, textarea, .popover, .tool-popover, .settings-modal, .settings-backdrop, .swatch-scroll, .swatch, .lib-add-menu")) return;
    if (kind !== "topbar") e.preventDefault();
    const el = kind === "dock" ? toolbarEl : kind === "topbar" ? topBar : undoDock;
    dockDrag = {
      kind,
      el,
      pointerId: e.pointerId,
      live: false,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      grabDX: 0,
      grabDY: 0,
      snap: null,
      timer: setTimeout(() => {
        if (!dockDrag || dockDrag.live) return;
        hidePopovers();
        const r = liftDock(el, kind);
        dockDrag.live = true;
        dockDrag.grabDX = dockDrag.lastX - r.left;
        dockDrag.grabDY = dockDrag.lastY - r.top;
        try {
          el.setPointerCapture(dockDrag.pointerId);
        } catch (err) {}
        moveDockDrag(dockDrag.lastX, dockDrag.lastY);
      }, DOCK_HOLD_MS),
    };
  }

  function moveDockDrag(x, y) {
    if (!dockDrag || !dockDrag.live) return;
    const el = dockDrag.el;
    if (dockDrag.kind === "dock" || dockDrag.kind === "topbar") {
      const edge = nearestEdge(x, y);
      if (dockDrag.kind === "dock") applyToolbarOrient(edge);
      else topBar.classList.toggle("tb-vertical", edge === "left" || edge === "right");
      const dist = edgeDistance(x, y, edge);
      const snapping = dist < SNAP_PX;
      dockDrag.snap = snapping ? edge : null;
      showSnapGuides("dock", edge);
      if (snapping) {
        const p = dockSnapPoint(edge, el);
        placeEl(el, p.left, p.top);
      } else {
        placeEl(el, x - dockDrag.grabDX, y - dockDrag.grabDY);
      }
    } else {
      const corner = nearestCorner(x, y);
      const dist = cornerDistance(x, y, corner);
      const snapping = dist < SNAP_PX;
      dockDrag.snap = snapping ? corner : null;
      showSnapGuides("undo", GUIDE_BY_CORNER[corner]);
      if (snapping) {
        const p = cornerSnapPoint(corner, el);
        placeEl(el, p.left, p.top);
      } else {
        placeEl(el, x - dockDrag.grabDX, y - dockDrag.grabDY);
      }
    }
    positionToolPopover();
  }

  function endDockDrag() {
    if (!dockDrag) return;
    clearTimeout(dockDrag.timer);
    const { kind, live, lastX, lastY, el } = dockDrag;
    if (live) suppressDockClick = true;
    dockDrag = null;
    hideGuides();
    if (!live) return;
    if (kind === "dock") {
      setDockPosition(nearestEdge(lastX, lastY));
    } else if (kind === "topbar") {
      el.classList.remove("free-drag", "dragging");
      setTopBarPos(nearestEdge(lastX, lastY));
    } else {
      setUndoCorner(nearestCorner(lastX, lastY));
    }
    el.classList.remove("free-drag", "dragging");
    positionToolPopover();
  }

  let suppressDockClick = false;
  function blockDockClick(e) {
    if (!suppressDockClick) return;
    e.preventDefault();
    e.stopPropagation();
    suppressDockClick = false;
  }
  toolbarEl.addEventListener("click", blockDockClick, true);
  undoDock.addEventListener("click", blockDockClick, true);
  toolbarEl.addEventListener("pointerdown", (e) => armDockDrag("dock", e));
  topBar.addEventListener("click", blockDockClick, true);
  topBar.addEventListener("pointerdown", (e) => armDockDrag("topbar", e));
  undoDock.addEventListener("pointerdown", (e) => armDockDrag("undo", e));
  window.addEventListener("pointermove", (e) => {
    if (!dockDrag || e.pointerId !== dockDrag.pointerId) return;
    dockDrag.lastX = e.clientX;
    dockDrag.lastY = e.clientY;
    if (!dockDrag.live) {
      const moved = Math.hypot(e.clientX - dockDrag.startX, e.clientY - dockDrag.startY);
      if (moved > HOLD_MOVE_CANCEL_PX) {
        clearTimeout(dockDrag.timer);
        dockDrag = null;
      }
      return;
    }
    e.preventDefault();
    moveDockDrag(e.clientX, e.clientY);
  }, { passive: false });
  window.addEventListener("pointerup", (e) => {
    if (!dockDrag || e.pointerId !== dockDrag.pointerId) return;
    endDockDrag();
  });
  window.addEventListener("pointercancel", (e) => {
    if (!dockDrag || e.pointerId !== dockDrag.pointerId) return;
    endDockDrag();
  });

  // ---- Kopfleiste: Rand (oben/unten/links/rechts) und welche Knoepfe sichtbar sind ----
  // Sitzt die Werkzeugleiste am selben Rand, rueckt sie nach innen (die Kopfleiste bleibt am Rand).
  function topBarPos() {
    for (const p of ["bottom", "left", "right"]) if (topBar.classList.contains("tb-" + p)) return p;
    return "top";
  }
  function syncBarStack() {
    const same = topBarPos() === currentDock() && !topBar.classList.contains("free-drag");
    document.body.classList.toggle("bars-stacked", same);
  }
  function setTopBarPos(pos) {
    topBar.classList.remove("tb-top", "tb-bottom", "tb-left", "tb-right", "free-drag", "dragging");
    Object.assign(topBar.style, { left: "", top: "", right: "", bottom: "", transform: "", maxWidth: "" });
    topBar.classList.add("tb-" + pos);
    topBar.classList.toggle("tb-vertical", pos === "left" || pos === "right");
    try {
      localStorage.setItem("sofianotes-topbar-pos", pos);
    } catch (err) {}
    document.body.dataset.topbar = pos;
    syncBarStack();
    layoutTopBar();
    fitFilename();
    document.querySelectorAll("#set-topbar-pos [data-pos]").forEach((b) => b.classList.toggle("active", b.dataset.pos === pos));
    try {
      if (zoomWin) layoutZoomPane(); // beim Start noch nicht angelegt
    } catch (err) {}
  }
  const TOPBAR_ITEMS = [
    { key: "status", label: "Verbindung", icon: "wifi", sel: "#status" },
    { key: "modes", label: "Modus-Knöpfe", icon: "ink_pen", sel: "#mode-switch" },
    { key: "ruler", label: "Lineal", icon: "straighten", sel: "#btn-ruler" },
    { key: "zoom", label: "Zoom-Fenster", icon: "zoom_in_map", sel: "#btn-zoom-window" },
    { key: "calc", label: "Rechner", icon: "calculate", sel: "#btn-calc" },
    { key: "hw", label: "Aufgabe", icon: "assignment", sel: "#btn-hw-panel" },
    { key: "insert", label: "Einfügen", icon: "add_box", sel: ".insert-menu-wrap" },
  ];
  let topBarHidden = (() => {
    try {
      const v = JSON.parse(lsGetRaw("sofianotes-topbar-hidden") || "[]");
      return Array.isArray(v) ? v : [];
    } catch (err) {
      return [];
    }
  })();
  function applyTopBarItems() {
    for (const it of TOPBAR_ITEMS) {
      const el = topBar.querySelector(it.sel);
      if (el) el.classList.toggle("tb-off", topBarHidden.includes(it.key));
    }
    // doppelte/haengende Trennstriche ausblenden
    let prevVisible = null;
    const kids = Array.from(topBar.children);
    for (const el of kids) {
      if (!el.classList.contains("bar-divider")) continue;
      el.classList.remove("tb-off");
    }
    for (const el of kids) {
      const shown = !el.classList.contains("tb-off") && !el.classList.contains("hidden") && getComputedStyle(el).display !== "none";
      if (!shown) continue;
      if (el.classList.contains("bar-divider")) {
        if (!prevVisible || prevVisible.classList.contains("bar-divider")) el.classList.add("tb-off");
        else prevVisible = el;
      } else prevVisible = el;
    }
    if (prevVisible && prevVisible.classList.contains("bar-divider")) prevVisible.classList.add("tb-off");
    renderTopBarSettings();
    renderHiddenMenu();
    layoutTopBar();
  }
  function renderTopBarSettings() {
    const box = document.getElementById("set-topbar-items");
    if (!box) return;
    box.innerHTML = "";
    for (const it of TOPBAR_ITEMS) {
      const b = document.createElement("button");
      b.type = "button";
      const on = !topBarHidden.includes(it.key);
      b.className = "set-check" + (on ? " active" : "");
      b.innerHTML = '<span class="material-symbols-rounded"></span><span></span><span class="material-symbols-rounded set-check-box"></span>';
      b.children[0].textContent = it.icon;
      b.children[1].textContent = it.label;
      b.children[2].textContent = on ? "check_box" : "check_box_outline_blank";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        topBarHidden = on ? [...topBarHidden, it.key] : topBarHidden.filter((k) => k !== it.key);
        try {
          localStorage.setItem("sofianotes-topbar-hidden", JSON.stringify(topBarHidden));
        } catch (err) {}
        applyTopBarItems();
      });
      box.appendChild(b);
    }
  }
  // Ausgeblendete Knoepfe stehen im ⋯-Menue unter Teilen/Herunterladen/Einstellungen
  function renderHiddenMenu() {
    const box = document.getElementById("canvas-menu-hidden");
    if (!box) return;
    box.innerHTML = "";
    const add = (icon, label, run) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lib-add-opt";
      b.innerHTML = '<span class="material-symbols-rounded"></span><span></span>';
      b.children[0].textContent = icon;
      b.children[1].textContent = label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof closeCanvasMenus === "function") closeCanvasMenus();
        run();
      });
      box.appendChild(b);
    };
    const click = (sel) => () => document.querySelector(sel)?.click();
    for (const key of topBarHidden) {
      if (key === "modes") {
        add("ink_pen", "Stift", click('.mode-btn[data-mode="pen"]'));
        add("ink_eraser", "Radierer", click('.mode-btn[data-mode="eraser"]'));
        add("text_fields", "Text", click('.mode-btn[data-mode="text"]'));
        add("lasso_select", "Lasso", click('.mode-btn[data-mode="lasso"]'));
      } else if (key === "ruler") add("straighten", "Lineal an/aus", click("#btn-ruler"));
      else if (key === "zoom") add("zoom_in_map", "Zoom-Fenster", click("#btn-zoom-window"));
      else if (key === "calc") add("calculate", "Rechner", click("#btn-calc"));
      else if (key === "hw" && !document.getElementById("btn-hw-panel").classList.contains("hidden")) add("assignment", "Aufgabe", click("#btn-hw-panel"));
      else if (key === "insert") {
        add("table", "Tabelle einfügen", click("#insert-table"));
        add("add_photo_alternate", "Bild einfügen", click("#insert-image"));
        add("description", "PDF / Datei einfügen", click("#insert-pdf"));
      }
    }
    box.classList.toggle("hidden", !box.children.length);
  }
  document.querySelectorAll("#set-topbar-pos [data-pos]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      setTopBarPos(b.dataset.pos);
    })
  );
  // Blattname nimmt nur so viel Platz wie sein Text
  const filenameMeasure = document.createElement("canvas").getContext("2d");
  function fitFilename() {
    const inp = document.getElementById("canvas-filename");
    if (!inp) return;
    const cs = getComputedStyle(inp);
    filenameMeasure.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    const w = filenameMeasure.measureText(inp.value || inp.placeholder || "").width;
    inp.style.width = Math.ceil(w + 14) + "px";
  }
  document.getElementById("canvas-filename")?.addEventListener("input", fitFilename);
  document.fonts?.ready?.then(fitFilename);

  document.querySelectorAll(".btn-dock-quick").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setDockPosition(btn.dataset.pos);
    });
  });

  document.addEventListener("pointerdown", (e) => {
    if (
      e.target.closest("#toolbar") ||
      e.target.closest("#tool-popover") ||
      e.target.closest("#settings-popover") ||
      e.target.closest("#erase-all-menu") ||
      e.target.closest("#paste-menu") ||
      e.target.closest("#selection-toolbar") ||
      e.target.closest("#undo-redo-dock") ||
      e.target.closest("#top-filename-bar") ||
      e.target.closest("#who-backdrop") ||
      e.target.closest("#library-backdrop") ||
      e.target.closest("#share-backdrop") ||
      e.target.closest("#move-backdrop")
    ) {
      return;
    }
    hidePopovers();
  });

  (function restorePrefs() {
    let p = null;
    try {
      p = JSON.parse(localStorage.getItem("sofianotes-prefs") || "null");
    } catch (err) {}
    if (!p || typeof p !== "object") return;
    const num = (v, cfg, d) => (Number.isFinite(Number(v)) ? Math.max(cfg.min, Math.min(cfg.max, Number(v))) : d);
    penSize = num(p.penSize, toolConfigs.pen, penSize);
    markerSize = num(p.markerSize, toolConfigs.marker, markerSize);
    eraserSize = num(p.eraserSize, toolConfigs.eraser, eraserSize);
    textSize = num(p.textSize, toolConfigs.text, textSize);
    if (typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color)) currentColor = p.color.toUpperCase();
    if (typeof p.shapes === "boolean") shapeRecognitionEnabled = p.shapes;
    if (typeof p.finger === "boolean") fingerDrawEnabled = p.finger;
    shapeToggleEl.classList.toggle("active", shapeRecognitionEnabled);
    fingerDrawToggleEl.classList.toggle("active", fingerDrawEnabled);
    markActiveSwatch();
    if (p.tool === "marker") setTool("marker");
  })();

  const savedDock = localStorage.getItem("sofianotes-dock") || "bottom";
  const savedCorner = localStorage.getItem("sofianotes-undo-corner") || "top-left";
  setTopBarPos(["top", "bottom", "left", "right"].includes(lsGetRaw("sofianotes-topbar-pos")) ? lsGetRaw("sofianotes-topbar-pos") : "top");
  setDockPosition(savedDock);
  applyTopBarItems();
  setUndoCorner(savedCorner);
  if (filenameInput) {
    filenameInput.addEventListener("change", () => {
      const v = filenameInput.value.trim() || "Unbenannte Skizze";
      filenameInput.value = v;
      fitFilename();
      document.title = v + " – sofianotes";
      if (currentBoardId && currentPersonId) {
        fetch("/api/boards/" + encodeURIComponent(currentBoardId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personId: currentPersonId, title: v }),
        }).catch(() => {
          enqueueOp({ type: "board_rename", personId: currentPersonId, id: currentBoardId, title: v });
        });
      }
    });
    filenameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") filenameInput.blur();
    });
  }
  renderToolPopover();

  function updateEraserCursorVisibility() {
    if (currentTool !== "eraser") {
      eraserCursorEl.style.display = "none";
    }
  }

  // ---- websocket ------------------------------------------------------
  let ws = null;
  let myClientId = null;
  let myColor = null;
  let reconnectDelay = 1000;
  let wantWs = false;
  let PEOPLE = [];
  let currentPersonId = "";
  let isAdmin = false;
  let currentBoardId = "";
  let currentBoardMeta = null;
  let currentFolderId = null;
  let librarySearchQuery = "";
  let libraryCache = null;
  const whoBackdrop = document.getElementById("who-backdrop");
  const libraryBackdrop = document.getElementById("library-backdrop");
  const shareBackdrop = document.getElementById("share-backdrop");
  const moveBackdrop = document.getElementById("move-backdrop");
  const whoChip = document.getElementById("btn-who-chip");

  function personName(id) {
    const p = PEOPLE.find((x) => x.id === id);
    return p ? p.name : id;
  }

  function wsSend(obj) {
    if (window.sofiaHistoryChanged && /^(stroke_end|stroke_move|erase)$/.test(obj && obj.type)) window.sofiaHistoryChanged();
    if (window.sofiaPagesChanged && /^(stroke_end|stroke_move|erase)$/.test(obj && obj.type)) window.sofiaPagesChanged();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      scheduleSaveBoard();
      return;
    }
    scheduleSaveBoard();
    if (!currentBoardId || !currentPersonId) return;
    if (obj.type === "stroke_end" && currentStroke) {
      enqueueOp({ type: "stroke_put", personId: currentPersonId, boardId: currentBoardId, stroke: serializeStroke(currentStroke) });
    } else if (obj.type === "stroke_move" && obj.stroke) {
      enqueueOp({ type: "stroke_put", personId: currentPersonId, boardId: currentBoardId, stroke: obj.stroke });
    } else if (obj.type === "erase" && obj.strokeIds) {
      enqueueOp({ type: "stroke_erase", personId: currentPersonId, boardId: currentBoardId, strokeIds: obj.strokeIds });
    }
  }

  function setConnState(mode) {
    statusEl.classList.toggle("connected", mode === "live");
    statusEl.classList.toggle("offline", mode === "offline");
    statusEl.classList.toggle("sync", mode === "sync");
    statusEl.classList.toggle("hidden", mode !== "offline");
    statusTextEl.textContent = mode === "live" ? "Live" : mode === "sync" ? "Sync…" : "Offline";
  }

  function setConnected(connected) {
    setConnState(connected ? "live" : "offline");
  }

  let saveBoardTimer = null;
  function scheduleSaveBoard() {
    if (!currentBoardId || !window.SofiaOffline) return;
    clearTimeout(saveBoardTimer);
    saveBoardTimer = setTimeout(() => {
      const list = Array.from(boardStrokes.values()).map(cloneStroke);
      SofiaOffline.setStrokes(currentBoardId, list).catch(() => {});
    }, 80);
  }

  function applyStrokeList(list) {
    boardStrokes.clear();
    for (const s of list || []) {
      tagShape(s);
      s.bbox = strokeWorldBBox(s);
      boardStrokes.set(s.id, s);
      if (s.tool === "image" && s.extra && s.extra.mediaId) ensureMedia(s.extra.mediaId);
    }
    requestRedraw();
  }

  async function probeOnline() {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      return r.ok;
    } catch (err) {
      return false;
    }
  }

  async function enqueueOp(op) {
    if (window.SofiaOffline) await SofiaOffline.enqueue(op);
  }

  async function flushOutbox() {
    if (!window.SofiaOffline) return true;
    const entries = await SofiaOffline.outboxEntries();
    if (!entries.length) return true;
    setConnState("sync");
    for (const item of entries) {
      try {
        await sendQueuedOp(item.op);
        await SofiaOffline.outboxDelete(item.key);
      } catch (err) {
        setConnState("offline");
        return false;
      }
    }
    return true;
  }

  async function sendQueuedOp(op) {
    const headers = { "Content-Type": "application/json" };
    if (op.type === "media") {
      const r = await fetch("/api/media", { method: "POST", headers, body: JSON.stringify({ id: op.id, image: op.image }) });
      if (!r.ok) throw new Error("media");
      return;
    }
    if (op.type === "board_create") {
      const r = await fetch("/api/boards", {
        method: "POST",
        headers,
        body: JSON.stringify({ personId: op.personId, title: op.title, folderId: op.folderId, id: op.id }),
      });
      if (!r.ok) throw new Error("board");
      return;
    }
    if (op.type === "board_rename") {
      const r = await fetch("/api/boards/" + encodeURIComponent(op.id), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ personId: op.personId, title: op.title }),
      });
      if (!r.ok) throw new Error("rename");
      return;
    }
    if (op.type === "board_delete") {
      const r = await fetch("/api/boards/" + encodeURIComponent(op.id) + "?person=" + encodeURIComponent(op.personId), { method: "DELETE" });
      if (!r.ok) throw new Error("delete");
      return;
    }
    if (op.type === "folder_create") {
      const r = await fetch("/api/folders", {
        method: "POST",
        headers,
        body: JSON.stringify({ personId: op.personId, name: op.name, parentId: op.parentId, id: op.id }),
      });
      if (!r.ok) throw new Error("folder");
      return;
    }
    if (op.type === "folder_rename") {
      const r = await fetch("/api/folders/" + encodeURIComponent(op.id), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ personId: op.personId, name: op.name }),
      });
      if (!r.ok) throw new Error("folder");
      return;
    }
    if (op.type === "folder_move") {
      const r = await fetch("/api/folders/" + encodeURIComponent(op.id), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ personId: op.personId, parentId: op.parentId }),
      });
      if (!r.ok) throw new Error("folder");
      return;
    }
    if (op.type === "folder_delete") {
      const r = await fetch("/api/folders/" + encodeURIComponent(op.id) + "?person=" + encodeURIComponent(op.personId), { method: "DELETE" });
      if (!r.ok) throw new Error("folder");
      return;
    }
    if (op.type === "place") {
      const r = await fetch("/api/placements", {
        method: "POST",
        headers,
        body: JSON.stringify({ personId: op.personId, boardId: op.boardId, folderId: op.folderId }),
      });
      if (!r.ok) throw new Error("place");
      return;
    }
    if (op.type === "share") {
      const r = await fetch("/api/boards/" + encodeURIComponent(op.boardId) + "/share", {
        method: "POST",
        headers,
        body: JSON.stringify({ personId: op.personId, withPersonId: op.withPersonId }),
      });
      if (!r.ok) throw new Error("share");
      return;
    }
    if (op.type === "unshare") {
      const r = await fetch(
        "/api/boards/" + encodeURIComponent(op.boardId) + "/share/" + encodeURIComponent(op.withPersonId) + "?person=" + encodeURIComponent(op.personId),
        { method: "DELETE" }
      );
      if (!r.ok) throw new Error("unshare");
      return;
    }
    if (op.type === "stroke_put") {
      const r = await fetch("/api/boards/" + encodeURIComponent(op.boardId) + "/strokes", {
        method: "POST",
        headers,
        body: JSON.stringify({ personId: op.personId, stroke: op.stroke }),
      });
      if (!r.ok) throw new Error("stroke");
      return;
    }
    if (op.type === "stroke_erase") {
      const r = await fetch("/api/boards/" + encodeURIComponent(op.boardId) + "/erase", {
        method: "POST",
        headers,
        body: JSON.stringify({ personId: op.personId, strokeIds: op.strokeIds }),
      });
      if (!r.ok) throw new Error("erase");
    }
  }

  async function goOnlineIfPossible() {
    if (!(await probeOnline())) {
      setConnState("offline");
      return false;
    }
    const ok = await flushOutbox();
    if (!ok) return false;
    if (wantWs && currentBoardId) connectWS();
    else setConnState("live");
    return true;
  }

  function disconnectWS() {
    wantWs = false;
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    setConnected(false);
  }

  function connectWS() {
    if (!currentPersonId || !currentBoardId) return;
    wantWs = true;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url =
      `${proto}//${location.host}/ws?person=` +
      encodeURIComponent(currentPersonId) +
      "&board=" +
      encodeURIComponent(currentBoardId);
    ws = new WebSocket(url);

    ws.onopen = () => {
      setConnState("live");
      reconnectDelay = 1000;
    };
    ws.onclose = (ev) => {
      if (ev && ev.code === 4403) {
        // kein Zugriff auf dieses Blatt (z.B. fremder Link): zurueck in die Bibliothek
        // statt endlos neu zu verbinden
        wantWs = false;
        currentBoardId = null;
        boardStrokes.clear();
        requestRedraw();
        showLibrary();
        return;
      }
      if (!wantWs) {
        setConnState("offline");
        return;
      }
      setConnState("offline");
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      setTimeout(() => {
        if (wantWs) goOnlineIfPossible();
      }, reconnectDelay);
      reconnectDelay = Math.min(10000, reconnectDelay * 1.7);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  }

  function finalizeIncomingStroke(id) {
    const s = remoteInProgress.get(id);
    if (!s) return;
    remoteInProgress.delete(id);
    if (s.points.length > 0) {
      tagShape(s);
      s.bbox = strokeWorldBBox(s);
      s.endedAt = performance.now();
      boardStrokes.set(s.id, s);
    }
  }

  function handleMessage(msg) {
    if (window.sofiaHistoryChanged && /^(stroke_end|stroke_move|erase|board_reload)$/.test(msg.type)) window.sofiaHistoryChanged();
    if (window.sofiaPagesChanged && /^(stroke_end|stroke_move|erase|board_notebook)$/.test(msg.type)) window.sofiaPagesChanged();
    switch (msg.type) {
      case "init": {
        myClientId = msg.clientId;
        myColor = msg.color;
        if (msg.board) {
          currentBoardId = msg.board.id;
          currentBoardMeta = msg.board;
          if (filenameInput) filenameInput.value = msg.board.title || "Unbenannte Skizze";
          fitFilename();
          document.title = (msg.board.title || "sofianotes") + " – sofianotes";
          syncHomeworkPanel(msg.board);
          applyPaper(msg.board.paper);
          const firstOpen = !notebook || notebookBoardId !== msg.board.id;
          notebook = msg.board.notebook || null;
          notebookBoardId = msg.board.id;
          if (notebook && firstOpen && window.sofiaFitPage) window.sofiaFitPage(0);
        }
        boardStrokes.clear();
        for (const s of msg.strokes) {
          tagShape(s);
          s.bbox = strokeWorldBBox(s);
          boardStrokes.set(s.id, s);
          if (s.tool === "image" && s.extra && s.extra.mediaId) ensureMedia(s.extra.mediaId);
        }
        requestRedraw();
        scheduleSaveBoard();
        break;
      }
      case "board_reload":
        if (currentBoardId) openBoard(currentBoardId, filenameInput ? filenameInput.value : "", { fromHistory: true });
        break;
      case "board_notebook":
        notebook = msg.notebook || null;
        if (currentBoardMeta) currentBoardMeta.notebook = notebook;
        requestRedraw();
        break;
      case "board_refs":
        if (currentBoardMeta) currentBoardMeta.refs = msg.refs || [];
        if (hwView && hwView.i >= panelItems().length) closeHwViewer();
        renderHwPanel();
        break;
      case "board_paper":
        if (currentBoardMeta) currentBoardMeta.paper = msg.paper;
        applyPaper(msg.paper);
        break;
      case "presence_join":
        ensurePresence(msg.id, msg.color);
        renderPeopleJumpList();
        break;
      case "presence_leave":
        removePresence(msg.id);
        renderPeopleJumpList();
        break;
      case "cursor": {
        const p = ensurePresence(msg.id, msg.color);
        p.x = msg.x;
        p.y = msg.y;
        p.tool = msg.tool;
        p.size = msg.size;
        p.lastSeen = performance.now();
        requestRedraw();
        break;
      }
      case "stroke_start": {
        remoteInProgress.set(msg.strokeId, {
          id: msg.strokeId,
          tool: msg.tool,
          color: msg.color,
          size: msg.size,
          points: msg.points || [],
          ownerId: msg.id,
        });
        requestRedraw();
        break;
      }
      case "stroke_points": {
        const s = remoteInProgress.get(msg.strokeId);
        if (s) s.points.push(...msg.points);
        requestRedraw();
        break;
      }
      case "stroke_replace": {
        const s = remoteInProgress.get(msg.strokeId);
        if (s) {
          s.points = msg.points;
          if (msg.extra && typeof msg.extra === "object") s.extra = msg.extra;
        }
        requestRedraw();
        break;
      }
      case "stroke_end":
        finalizeIncomingStroke(msg.strokeId);
        requestRedraw();
        break;
      case "stroke_abort":
        remoteInProgress.delete(msg.strokeId);
        requestRedraw();
        break;
      case "stroke_move": {
        const s = msg.stroke;
        if (s && s.id) {
          s.bbox = strokeWorldBBox(s);
          boardStrokes.set(s.id, s);
          if (s.tool === "image" && s.extra && s.extra.mediaId) ensureMedia(s.extra.mediaId);
          requestRedraw();
        }
        break;
      }
      case "erase":
        for (const id of msg.strokeIds) {
          boardStrokes.delete(id);
          remoteInProgress.delete(id);
        }
        requestRedraw();
        break;
      case "shape_params":
        applyShapeState(msg);
        break;
    }
  }

  // ---- presence (other users' live cursor + active tool) ---------------
  const presence = new Map(); // clientId -> {el,color,x,y,tool,size,lastSeen}
  const PRESENCE_TIMEOUT_MS = 4000;
  const TOOL_LABELS = { pen: "✏️ Stift", marker: "🖍️ Marker", eraser: "🧹 Radierer", select: "👆 Auswahl" };

  function ensurePresence(id, color) {
    let p = presence.get(id);
    if (!p) {
      const el = document.createElement("div");
      el.className = "presence-label";
      document.body.appendChild(el);
      p = { el, color: color || "#888", x: 0, y: 0, tool: "pen", size: 4, lastSeen: performance.now() };
      presence.set(id, p);
    }
    if (color) p.color = color;
    return p;
  }
  function removePresence(id) {
    const p = presence.get(id);
    if (p) {
      p.el.remove();
      presence.delete(id);
    }
  }
  function repositionPresenceLabels() {
    const now = performance.now();
    for (const [id, p] of presence) {
      if (now - p.lastSeen > PRESENCE_TIMEOUT_MS) {
        removePresence(id);
        continue;
      }
      const s = worldToScreen(p.x, p.y);
      p.el.style.left = s.x + "px";
      p.el.style.top = s.y - 14 + "px";
      p.el.style.background = p.color;
      p.el.textContent = (p.label || TOOL_LABELS[p.tool] || p.tool);
    }
  }

  function jumpToWorld(x, y) {
    offsetX = window.innerWidth / 2 - x * scale;
    offsetY = window.innerHeight / 2 - y * scale;
    requestRedraw();
  }

  function liveOtherPeople() {
    const now = performance.now();
    return Array.from(presence.entries())
      .filter(([id, p]) => id !== myClientId && now - p.lastSeen <= PRESENCE_TIMEOUT_MS)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }

  function renderPeopleJumpList() {
    const host = document.getElementById("zoom-people");
    if (!host) return;
    const people = liveOtherPeople();
    host.innerHTML = "";
    if (!people.length) {
      const empty = document.createElement("div");
      empty.className = "zoom-people-empty";
      empty.textContent = "Niemand sonst auf dem Blatt";
      host.appendChild(empty);
      return;
    }
    people.forEach(([id, p], i) => {
      p.label = "Person " + (i + 1);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "zoom-person";
      btn.title = "Zur Person springen";
      const dot = document.createElement("span");
      dot.className = "zoom-person-dot";
      dot.style.background = p.color || "#888";
      btn.appendChild(dot);
      btn.appendChild(document.createTextNode(p.label));
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        jumpToWorld(p.x, p.y);
      });
      host.appendChild(btn);
    });
  }

  // ---- network buffering (batch outgoing points / erase ids) -----------
  let lastPointsFlush = 0;
  let lastEraseFlush = 0;
  let lastCursorSend = 0;
  const pendingErase = new Set();
  let erasedThisGesture = new Set();
  let erasedStrokesThisGesture = new Map(); // id -> vollstaendiger Strich (fuer Undo)

  function flushNetworkBuffers() {
    const now = performance.now();
    if (currentStroke && currentStroke.unsent && currentStroke.unsent.length > 0 && now - lastPointsFlush > POINTS_FLUSH_MS) {
      wsSend({ type: "stroke_points", strokeId: currentStroke.id, points: currentStroke.unsent });
      currentStroke.unsent = [];
      lastPointsFlush = now;
    }
    if (pendingErase.size > 0 && now - lastEraseFlush > ERASE_FLUSH_MS) {
      wsSend({ type: "erase", strokeIds: Array.from(pendingErase) });
      pendingErase.clear();
      lastEraseFlush = now;
    }
  }

  function sendCursor(x, y, tool, size) {
    const now = performance.now();
    if (now - lastCursorSend < CURSOR_SEND_MS) return;
    lastCursorSend = now;
    wsSend({ type: "cursor", x, y, tool, size });
  }

  // ---- Undo/Redo (persoenlicher Verlauf der eigenen Aktionen) -----------
  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO = 100;

  function cloneStroke(s) {
    const out = { id: s.id, tool: s.tool, color: s.color, size: s.size, points: s.points.map((p) => ({ ...p })) };
    if (s.extra) out.extra = JSON.parse(JSON.stringify(s.extra));
    return out;
  }
  function serializeStroke(s) {
    const out = { id: s.id, tool: s.tool, color: s.color, size: s.size, points: s.points };
    if (s.extra) out.extra = s.extra;
    return out;
  }
  function updateUndoRedoButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }
  function pushUndo(action) {
    undoStack.push(action);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    updateUndoRedoButtons();
  }
  const eraseAllMenu = document.getElementById("erase-all-menu");
  function hideEraseAllMenu() {
    if (eraseAllMenu) eraseAllMenu.classList.add("hidden");
  }
  function showEraseAllMenu(clientX, clientY) {
    if (!eraseAllMenu || !boardStrokes.size) return;
    hidePasteMenu();
    eraseAllMenu.classList.remove("hidden");
    const w = 188;
    const h = 52;
    let left = clientX + 10;
    let top = clientY + 10;
    if (left + w > window.innerWidth - 8) left = Math.max(8, clientX - w - 10);
    if (top + h > window.innerHeight - 8) top = Math.max(8, clientY - h - 10);
    eraseAllMenu.style.left = left + "px";
    eraseAllMenu.style.top = top + "px";
  }
  const pasteMenu = document.getElementById("paste-menu");
  let pasteHoldTimer = null;
  let pasteHoldStart = null;
  let pasteHoldConsumed = false;
  let pasteAnchorWorld = null;
  const PASTE_HOLD_MS = 480;
  function hidePasteMenu() {
    if (pasteMenu) pasteMenu.classList.add("hidden");
  }
  function placeContextMenu(el, clientX, clientY) {
    if (!el) return;
    const w = 188;
    const h = 52;
    let left = clientX + 10;
    let top = clientY + 10;
    if (left + w > window.innerWidth - 8) left = Math.max(8, clientX - w - 10);
    if (top + h > window.innerHeight - 8) top = Math.max(8, clientY - h - 10);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }
  function showPasteMenu(clientX, clientY, world) {
    if (!pasteMenu || !strokeClipboard.length) return;
    hideEraseAllMenu();
    pasteAnchorWorld = world;
    lastPointerWorld = world;
    pasteMenu.classList.remove("hidden");
    placeContextMenu(pasteMenu, clientX, clientY);
  }
  function clearPasteHold() {
    if (pasteHoldTimer) {
      clearTimeout(pasteHoldTimer);
      pasteHoldTimer = null;
    }
    pasteHoldStart = null;
  }
  function boardEmptyAt(world) {
    if (cropState) return false;
    if (selection.bbox && pointInBBox(world, selection.bbox, 12 / Math.max(scale, 0.25))) return false;
    if (typeof pickStrokeAt === "function" && pickStrokeAt(world)) return false;
    return true;
  }
  function firePasteHold() {
    if (!pasteHoldStart || !strokeClipboard.length) {
      clearPasteHold();
      return;
    }
    const hold = pasteHoldStart;
    pasteHoldConsumed = true;
    if (currentStroke && currentStroke.eraser) currentStroke = null;
    else if (currentStroke) abortStroke();
    lassoPoints = null;
    lassoPointerId = null;
    if (dragState) cancelSelectionDrag();
    panState = null;
    showPasteMenu(hold.clientX, hold.clientY, hold.world);
    clearPasteHold();
  }
  function armPasteHold(e, world) {
    clearPasteHold();
    pasteHoldConsumed = false;
    if (!strokeClipboard.length) return;
    if (!boardEmptyAt(world)) return;
    pasteHoldStart = {
      world,
      clientX: e.clientX,
      clientY: e.clientY,
      pointerId: e.pointerId,
    };
    pasteHoldTimer = setTimeout(firePasteHold, PASTE_HOLD_MS);
  }
  function notePasteHoldMove(e) {
    if (!pasteHoldStart || pasteHoldStart.pointerId !== e.pointerId) return;
    const dist = Math.hypot(e.clientX - pasteHoldStart.clientX, e.clientY - pasteHoldStart.clientY);
    if (dist > 12) clearPasteHold();
  }
  function clearAllInk() {
    // Nur Tinte - Bilder, PDFs, Textfelder und Tabellen bleiben stehen.
    const clones = Array.from(boardStrokes.values())
      .filter((s) => !isObjectStroke(s))
      .map(cloneStroke);
    hideEraseAllMenu();
    if (!clones.length) return;
    const ids = clones.map((s) => s.id);
    for (const id of ids) boardStrokes.delete(id);
    wsSend({ type: "erase", strokeIds: ids });
    pushUndo({ type: "erase", strokes: clones });
    inkGroups = [];
    scanBoxes = [];
    dismissedInk.clear();
    ocrCache.clear();
    renderInkOverlay();
    toolPopover.classList.add("hidden");
    requestRedraw();
  }
  function putStroke(stroke) {
    const copy = cloneStroke(stroke);
    copy.bbox = strokeWorldBBox(copy);
    copy.endedAt = performance.now();
    boardStrokes.set(copy.id, copy);
    if (copy.tool === "image" && copy.extra && copy.extra.mediaId) ensureMedia(copy.extra.mediaId);
    wsSend({ type: "stroke_move", stroke: serializeStroke(copy) });
  }
  function removeStrokes(ids) {
    for (const id of ids) noteShapeRemoved(id);
    for (const id of ids) boardStrokes.delete(id);
    wsSend({ type: "erase", strokeIds: ids });
  }
  function applyAction(action, direction) {
    // direction: 1 = vorwaerts (redo/erste Ausfuehrung), -1 = rueckgaengig (undo)
    if (action.type === "add") {
      if (direction === 1) putStroke(action.stroke);
      else removeStrokes([action.stroke.id]);
    } else if (action.type === "erase") {
      if (direction === 1) removeStrokes(action.strokes.map((s) => s.id));
      else for (const s of action.strokes) putStroke(s);
    } else if (action.type === "move") {
      for (const m of action.moves) {
        const s = boardStrokes.get(m.id);
        const points = direction === 1 ? m.after : m.before;
        if (s) {
          s.points = points.map((p) => ({ ...p }));
          const extra = direction === 1 ? m.afterExtra : m.beforeExtra;
          if (extra) s.extra = JSON.parse(JSON.stringify(extra));
          else if (s.extra && s.extra.rotation != null) {
            const next = Object.assign({}, s.extra);
            delete next.rotation;
            s.extra = Object.keys(next).length ? next : undefined;
          }
          const sz = direction === 1 ? m.afterSize : m.beforeSize;
          if (sz != null && Number.isFinite(sz)) s.size = sz;
          s.bbox = strokeWorldBBox(s);
          wsSend({ type: "stroke_move", stroke: serializeStroke(s) });
        }
      }
    } else if (action.type === "replace") {
      // before/after sind vollstaendige Striche; null = existiert in diesem Zustand nicht
      const target = direction === 1 ? action.after : action.before;
      const other = direction === 1 ? action.before : action.after;
      if (target) putStroke(target);
      else if (other) removeStrokes([other.id]);
      if (selection.ids.size) selectStrokeIds(Array.from(selection.ids));
    } else if (action.type === "add_many") {
      if (direction === 1) for (const s of action.strokes) putStroke(s);
      else removeStrokes(action.strokes.map((s) => s.id));
    } else if (action.type === "style") {
      for (const c of action.changes) {
        const s = boardStrokes.get(c.id);
        const st = direction === 1 ? c.after : c.before;
        if (s && st) {
          s.color = st.color;
          s.size = st.size;
          if (isBoxText(s)) relayoutBoxText(s);
          wsSend({ type: "stroke_move", stroke: serializeStroke(s) });
        }
      }
    }
    requestRedraw();
  }
  function undo() {
    if (undoStack.length === 0) return;
    const action = undoStack.pop();
    applyAction(action, -1);
    redoStack.push(action);
    updateUndoRedoButtons();
  }
  function redo() {
    if (redoStack.length === 0) return;
    const action = redoStack.pop();
    applyAction(action, 1);
    undoStack.push(action);
    updateUndoRedoButtons();
  }
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  function downloadCurrentBoard() {
    // GoodNotes importiert PDF; das eigene .goodnotes-ZIP ist kein natives GN-Dokument.
    window.location.href = "/api/export.pdf?board=" + encodeURIComponent(currentBoardId || "");
  }
  window.addEventListener("keydown", (e) => {
    const meta = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const typing = document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA");
    if (typing) return;
    if (e.key === "Escape" && settingsBackdrop && !settingsBackdrop.classList.contains("hidden")) {
      e.preventDefault();
      if (settingsPopover && settingsPopover.dataset.page && settingsPopover.dataset.page !== "main") showSettingsPage("main");
      else hideSettings();
      return;
    }
    if (meta && key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (meta && key === "c") {
      e.preventDefault();
      copySelection();
      return;
    }
    if (meta && key === "x") {
      e.preventDefault();
      cutSelection();
      return;
    }
    if (meta && key === "v") {
      e.preventDefault();
      pasteClipboard();
    }
  });
  updateUndoRedoButtons();

  // ---- Formen-Erkennung (Linie/Rechteck/Dreieck/Kreis beim Halten) ------
  let holdTimer = null;
  let holdHintTimer = null;
  let holdAnchor = null; // {x, y, index} Weltpunkt (und Punkt-Index), um den der Stift gerade ruhig steht
  let holdStartedAt = 0;
  let holdHint = null; // {x, y} solange der Fortschrittsring angezeigt wird

  function clearHoldTimer() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (holdHintTimer) {
      clearTimeout(holdHintTimer);
      holdHintTimer = null;
    }
    holdAnchor = null;
    if (holdHint) {
      holdHint = null;
      requestRedraw();
    }
  }
  function isHoldSnapTool(tool) {
    return tool === "pen" || tool === "marker";
  }

  // Wird bei jedem neuen Punkt aufgerufen. Bleibt der Stift innerhalb von HOLD_STILL_PX um
  // den Haltepunkt, laeuft die Uhr weiter; erst eine echte Bewegung startet sie neu.
  const MARKER_HOLD_MS = 350; // Textmarker: kurz halten reicht fuer eine gerade Linie
  let holdDuration = 1500;

  function armHoldTimer() {
    if (!shapeRecognitionEnabled) return clearHoldTimer();
    if (!currentStroke || !isHoldSnapTool(currentStroke.tool) || currentStroke.locked || currentStroke.rulerEdge) return clearHoldTimer();
    const tip = currentStroke.points[currentStroke.points.length - 1];
    if (holdAnchor && tip && Math.hypot(tip.x - holdAnchor.x, tip.y - holdAnchor.y) <= shapeParams.stillPx / scale) return;
    clearHoldTimer();
    if (!tip) return;
    holdAnchor = { x: tip.x, y: tip.y, index: currentStroke.points.length - 1 };
    holdStartedAt = performance.now();
    holdDuration = currentStroke.tool === "marker" ? MARKER_HOLD_MS : shapeParams.holdMs;
    holdHintTimer = setTimeout(showHoldHint, Math.min(HOLD_HINT_MS, holdDuration * 0.3));
    holdTimer = setTimeout(tryShapeSnap, holdDuration);
  }

  // Die Zitter-Punkte, die waehrend des Haltens dazukommen, gehoeren nicht zur Form -
  // sonst verfaelschen sie bei Kreisen den Mittelpunkt und die Erkennung scheitert.
  function pointsBeforeHold(points) {
    if (!holdAnchor || holdAnchor.index == null) return points;
    return points.slice(0, holdAnchor.index + 1);
  }

  // Textmarker markiert Text: nur gerade Linien, keine Kreise/Rechtecke
  function detectHoldShape(points, tool) {
    if (tool === "marker") return straightenOpenStroke(points);
    return detectShape(points);
  }

  // Ring nur zeigen, wenn beim Weiterhalten wirklich eine Form entstuende -
  // eine normale Schreibpause bleibt so komplett ohne Ablenkung.
  function showHoldHint() {
    holdHintTimer = null;
    if (!currentStroke || currentStroke.locked || !holdAnchor) return;
    if (!detectHoldShape(pointsBeforeHold(currentStroke.points), currentStroke.tool)) return;
    holdHint = { x: holdAnchor.x, y: holdAnchor.y };
    requestRedraw();
  }

  function drawHoldHint() {
    if (!holdHint) return;
    const progress = Math.min(1, (performance.now() - holdStartedAt) / holdDuration);
    const r = 14 / scale;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = "rgba(26,115,232,0.18)";
    ctx.beginPath();
    ctx.arc(holdHint.x, holdHint.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#1A73E8";
    ctx.beginPath();
    ctx.arc(holdHint.x, holdHint.y, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function perpDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function rdpSimplify(points, epsilon) {
    function section(pts) {
      if (pts.length < 3) return pts;
      let maxDist = 0, index = 0;
      const a = pts[0], b = pts[pts.length - 1];
      for (let i = 1; i < pts.length - 1; i++) {
        const d = perpDist(pts[i], a, b);
        if (d > maxDist) {
          maxDist = d;
          index = i;
        }
      }
      if (maxDist > epsilon) {
        const left = section(pts.slice(0, index + 1));
        const right = section(pts.slice(index));
        return left.slice(0, -1).concat(right);
      }
      return [a, b];
    }
    return section(points);
  }

  function resampleByLength(points, spacing) {
    if (points.length < 2) return points.slice();
    const out = [{ x: points[0].x, y: points[0].y, p: points[0].p }];
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      let x0 = points[i - 1].x;
      let y0 = points[i - 1].y;
      const x1 = points[i].x;
      const y1 = points[i].y;
      let dx = x1 - x0;
      let dy = y1 - y0;
      let dist = Math.hypot(dx, dy);
      if (dist === 0) continue;
      while (acc + dist >= spacing) {
        const t = (spacing - acc) / dist;
        x0 += dx * t;
        y0 += dy * t;
        out.push({ x: x0, y: y0, p: points[i].p });
        dx = x1 - x0;
        dy = y1 - y0;
        dist = Math.hypot(dx, dy);
        acc = 0;
      }
      acc += dist;
    }
    const last = points[points.length - 1];
    const tail = out[out.length - 1];
    if (Math.hypot(last.x - tail.x, last.y - tail.y) > 0.5) out.push({ x: last.x, y: last.y, p: last.p });
    return out;
  }

  function turnAbs(a, b, c) {
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-6 || l2 < 1e-6) return 0;
    const cross = v1x * v2y - v1y * v2x;
    const dot = v1x * v2x + v1y * v2y;
    return Math.abs(Math.atan2(cross, dot));
  }

  function findDominantCorners(rawPoints, diagonal, closed) {
    const spacing = Math.max(3, diagonal * 0.018);
    const pts = resampleByLength(rawPoints, spacing);
    const n = pts.length;
    if (n < 6) return rdpSimplify(rawPoints, diagonal * 0.05);

    const k = Math.max(2, Math.round((diagonal * 0.045) / spacing));
    const scores = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (!closed && (i < k || i >= n - k)) continue;
      const a = pts[(i - k + n) % n];
      const b = pts[i];
      const c = pts[(i + k) % n];
      scores[i] = turnAbs(a, b, c);
    }

    const minAngle = (40 * Math.PI) / 180;
    const minSep = Math.max(4, Math.round((diagonal * 0.12) / spacing));
    const peaks = [];
    for (let i = 0; i < n; i++) {
      if (scores[i] < minAngle) continue;
      let isMax = true;
      for (let d = 1; d <= minSep; d++) {
        const j = (i + d) % n;
        const h = (i - d + n) % n;
        if (scores[j] > scores[i] || scores[h] > scores[i]) {
          isMax = false;
          break;
        }
      }
      if (isMax) peaks.push({ i, score: scores[i], p: pts[i] });
    }
    peaks.sort((a, b) => b.score - a.score);

    const chosen = [];
    for (const peak of peaks) {
      const tooClose = chosen.some((c) => {
        const di = Math.abs(c.i - peak.i);
        return Math.min(di, n - di) < minSep;
      });
      if (!tooClose) chosen.push(peak);
    }
    chosen.sort((a, b) => a.i - b.i);

    if (chosen.length >= 3 && chosen.length <= 6) return chosen.map((c) => ({ x: c.p.x, y: c.p.y }));

    // Glatte Pfade (Kreise) nicht per RDP zu einem Polygon zusammenquetschen.
    const maxScore = scores.reduce((m, s) => (s > m ? s : m), 0);
    if (closed && maxScore < (40 * Math.PI) / 180) return [];

    // Fallback: RDP mit etwas groesserem Epsilon, damit zitternde Rechtecke
    // auf vier Ecken zusammenfallen statt in viele Mini-Knicke.
    const simplified = rdpSimplify(rawPoints, diagonal * 0.07);
    if (closed && simplified.length >= 4) return simplified.slice(0, simplified.length - 1);
    return simplified;
  }

  function collapseToQuad(corners, diagonal) {
    if (corners.length === 4) return corners;
    if (corners.length !== 5 && corners.length !== 6) return null;
    // Schwaechste / kuerzeste Ecke(n) weglassen, bis vier uebrig sind.
    let pts = corners.map((p) => ({ x: p.x, y: p.y }));
    while (pts.length > 4) {
      let drop = 0;
      let best = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i - 1 + pts.length) % pts.length];
        const b = pts[i];
        const c = pts[(i + 1) % pts.length];
        const ang = turnAbs(a, b, c);
        const arm = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y);
        const score = ang * arm;
        if (score < best) {
          best = score;
          drop = i;
        }
      }
      pts.splice(drop, 1);
    }
    const minSide = Math.min(
      ...pts.map((p, i) => {
        const q = pts[(i + 1) % 4];
        return Math.hypot(q.x - p.x, q.y - p.y);
      })
    );
    if (minSide < diagonal * 0.12) return null;
    return pts;
  }

  function orderCornersCcw(corners) {
    const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
    const cy = corners.reduce((s, p) => s + p.y, 0) / corners.length;
    return corners.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  }

  function fitOrientedRect(corners, avgPressure) {
    const pts = orderCornersCcw(corners);
    let bestLen = 0;
    let ux = 1, uy = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len > bestLen) {
        bestLen = len;
        ux = dx / len;
        uy = dy / len;
      }
    }
    // Nahezu achsenparallel: aufs Bounding-Box-Rechteck einrasten.
    const angle = Math.atan2(uy, ux);
    const snapped = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(angle - snapped) < (15 * Math.PI) / 180) {
      ux = Math.cos(snapped);
      uy = Math.sin(snapped);
    }
    const vx = -uy, vy = ux;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of pts) {
      const u = p.x * ux + p.y * uy;
      const v = p.x * vx + p.y * vy;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    let du = maxU - minU;
    let dv = maxV - minV;
    if (du > 0 && Math.abs(du - dv) / Math.max(du, dv) < 0.22) {
      const side = (du + dv) / 2;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      minU = cu - side / 2;
      maxU = cu + side / 2;
      minV = cv - side / 2;
      maxV = cv + side / 2;
    }
    const cornerAt = (u, v) => ({ x: u * ux + v * vx, y: u * uy + v * vy, p: avgPressure });
    const quad = [cornerAt(minU, minV), cornerAt(maxU, minV), cornerAt(maxU, maxV), cornerAt(minU, maxV)];
    return [...quad, quad[0]];
  }

  function bboxEdgeFraction(points, bbox) {
    const w = bbox.maxX - bbox.minX;
    const h = bbox.maxY - bbox.minY;
    const tol = Math.max(4, Math.min(w, h) * 0.055);
    let near = 0;
    for (const p of points) {
      const de = Math.min(
        Math.abs(p.x - bbox.minX),
        Math.abs(p.x - bbox.maxX),
        Math.abs(p.y - bbox.minY),
        Math.abs(p.y - bbox.maxY)
      );
      if (de <= tol) near++;
    }
    return near / points.length;
  }

  function makeEllipsePoints(cx, cy, rx, ry, avgPressure, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t), p: avgPressure });
    }
    return pts;
  }

  // Gleichmaessig nach Weglaenge verteilen: wer am Ende langsamer wird, erzeugt sonst
  // dort viel mehr Punkte, und die verziehen Mittelpunkt und Passung.
  function resampleByLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (len <= 0) return pts;
    const n = Math.max(32, Math.min(160, Math.round(len / 3)));
    const step = len / (n - 1);
    const out = [{ ...pts[0] }];
    let acc = 0;
    let target = step;
    for (let i = 1; i < pts.length && out.length < n - 1; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      while (seg > 0 && acc + seg >= target && out.length < n - 1) {
        const t = (target - acc) / seg;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p == null ? b.p : a.p + ((b.p || 0.5) - (a.p || 0.5)) * t });
        target += step;
      }
      acc += seg;
    }
    out.push({ ...pts[pts.length - 1] });
    return out;
  }

  // Kreise werden gern ueber den Startpunkt hinaus gezogen - das Ueberstehende abschneiden.
  function trimOvershoot(pts) {
    if (pts.length < 12) return pts;
    const s0 = pts[0];
    let best = -1;
    let bestD = Infinity;
    for (let i = Math.floor(pts.length * 0.7); i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - s0.x, pts[i].y - s0.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const b = makeBBox(pts);
    const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
    if (best > 0 && best < pts.length - 2 && bestD < diag * 0.2) return pts.slice(0, best + 1);
    return pts;
  }

  // Mittlere Abweichung von der Ellipse, die die Bounding-Box aufspannt (relativ zum Radius).
  function ellipseError(pts, bbox) {
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const rx = Math.max(1e-6, (bbox.maxX - bbox.minX) / 2);
    const ry = Math.max(1e-6, (bbox.maxY - bbox.minY) / 2);
    let sum = 0;
    for (const p of pts) sum += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
    return sum / pts.length;
  }

  let lastShapeMetrics = null; // {ellipse, line, closed} der letzten Erkennung (fuers Lernen)

  function detectShape(inputPoints) {
    if (inputPoints.length < 6) return null;
    let rawPoints = resampleByLength(inputPoints);
    const pre = makeBBox(rawPoints);
    const preDiag = Math.hypot(pre.maxX - pre.minX, pre.maxY - pre.minY);
    const preGap = Math.hypot(rawPoints[0].x - rawPoints[rawPoints.length - 1].x, rawPoints[0].y - rawPoints[rawPoints.length - 1].y);
    if (preGap < preDiag * 0.38) rawPoints = trimOvershoot(rawPoints);
    const bbox = makeBBox(rawPoints);
    const w = bbox.maxX - bbox.minX, h = bbox.maxY - bbox.minY;
    const diagonal = Math.hypot(w, h);
    if (diagonal < 20) return null;

    const avgPressure = rawPoints.reduce((s, p) => s + (p.p || 0.5), 0) / rawPoints.length;
    const start = rawPoints[0], end = rawPoints[rawPoints.length - 1];
    const startEndDist = Math.hypot(end.x - start.x, end.y - start.y);

    let pathLength = 0;
    for (let i = 1; i < rawPoints.length; i++) pathLength += Math.hypot(rawPoints[i].x - rawPoints[i - 1].x, rawPoints[i].y - rawPoints[i - 1].y);

    const closed = startEndDist < diagonal * 0.38;
    const ellErr = ellipseError(rawPoints, bbox);
    lastShapeMetrics = {
      closed,
      ellipse: closed ? ellErr : null,
      line: !closed && startEndDist > 0 ? pathLength / startEndDist : null,
    };

    if (!closed) {
      let maxDev = 0;
      for (const p of rawPoints) {
        const d = perpDist(p, start, end);
        if (d > maxDev) maxDev = d;
      }
      // Nur wirklich gerade Striche: Weg kaum laenger als die Luftlinie und kaum Ausschlag.
      // Wellen/Handschrift (m, w, ~) haben deutlich mehr Weg als Luftlinie und bleiben Tinte.
      const chord = startEndDist;
      if (chord > 0 && pathLength / chord < shapeParams.lineTol && maxDev / chord < 0.08) {
        return { type: "line", points: [{ x: start.x, y: start.y, p: avgPressure }, { x: end.x, y: end.y, p: avgPressure }] };
      }
      return null;
    }

    const cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2;
    const centroid = rawPoints.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    centroid.x /= rawPoints.length;
    centroid.y /= rawPoints.length;
    const radii = rawPoints.map((p) => Math.hypot(p.x - centroid.x, p.y - centroid.y));
    const meanR = radii.reduce((a, b) => a + b, 0) / radii.length;
    const variance = radii.reduce((a, r) => a + (r - meanR) * (r - meanR), 0) / radii.length;
    const circleFit = meanR > 0 ? Math.sqrt(variance) / meanR : 1;
    const periFit = meanR > 0 ? Math.abs(pathLength - 2 * Math.PI * meanR) / (2 * Math.PI * meanR) : 1;
    const aspectDiff = Math.max(w, h) > 0 ? Math.abs(w - h) / Math.max(w, h) : 1;
    const boxy = bboxEdgeFraction(rawPoints, bbox);
    const rectPeri = 2 * (w + h);
    const rectFit = rectPeri > 0 ? Math.abs(pathLength - rectPeri) / rectPeri : 1;
    const circular = circleFit < 0.26 && periFit < 0.30 && rectFit > 0.10 && boxy < 0.72;

    const corners = findDominantCorners(rawPoints, diagonal, true);
    const quad = collapseToQuad(corners, diagonal);
    const hasSharpQuad = !!(quad && quad.length === 4 && corners.length >= 3 && corners.length <= 6);

    // Sehr deutliche Ellipse/Kreis zuerst - sonst findet die Eckensuche bei Ovalen
    // an den Enden der langen Achse "Ecken" und macht ein Rechteck daraus.
    const ellipseLike = ellErr <= shapeParams.ellipseTol && boxy < 0.72 && rectFit > 0.06;
    if (ellipseLike && ellErr <= shapeParams.ellipseTol * 0.75) {
      const round = aspectDiff < 0.18;
      const r = (w + h) / 4;
      return { type: "circle", round, points: makeEllipsePoints(cx, cy, round ? r : w / 2, round ? r : h / 2, avgPressure, 96) };
    }

    // Rechteck/Quadrat hat Vorrang, sobald vier echte Ecken da sind
    // (auch wenn die Winkel nicht sauber 90° sind) — aber nicht bei runden Pfaden.
    if (hasSharpQuad) {
      return { type: "rectangle", points: fitOrientedRect(quad, avgPressure) };
    }
    if (boxy >= 0.72 && rectFit < 0.16 && !circular) {
      const aabb = [
        { x: bbox.minX, y: bbox.minY, p: avgPressure },
        { x: bbox.maxX, y: bbox.minY, p: avgPressure },
        { x: bbox.maxX, y: bbox.maxY, p: avgPressure },
        { x: bbox.minX, y: bbox.maxY, p: avgPressure },
      ];
      return { type: "rectangle", points: [...aabb, aabb[0]] };
    }

    if (corners.length === 3 && !(circular && circleFit < 0.18)) {
      return {
        type: "triangle",
        points: [...corners, corners[0]].map((p) => ({ x: p.x, y: p.y, p: avgPressure })),
      };
    }

    if (ellipseLike || circular || (circleFit < 0.20 && periFit < 0.26 && rectFit > 0.08)) {
      const useCircle = aspectDiff < 0.18;
      const rx = useCircle ? meanR : w / 2;
      const ry = useCircle ? meanR : h / 2;
      return { type: "circle", round: useCircle, points: makeEllipsePoints(cx, cy, rx, ry, avgPressure, 96) };
    }
    if (quad && quad.length === 4) {
      return { type: "rectangle", points: fitOrientedRect(quad, avgPressure) };
    }
    return null;
  }

  function straightenOpenStroke(rawPoints) {
    if (!rawPoints || rawPoints.length < 4) return null;
    const start = rawPoints[0];
    const end = rawPoints[rawPoints.length - 1];
    const chord = Math.hypot(end.x - start.x, end.y - start.y);
    if (chord < 28) return null;
    const bbox = makeBBox(rawPoints);
    const diagonal = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
    if (chord < diagonal * 0.38) return null;
    const avgPressure = rawPoints.reduce((s, p) => s + (p.p || 0.5), 0) / rawPoints.length;
    return {
      type: "line",
      points: [
        { x: start.x, y: start.y, p: avgPressure },
        { x: end.x, y: end.y, p: avgPressure },
      ],
    };
  }

  function tryShapeSnap() {
    holdTimer = null;
    const shapePoints = currentStroke ? pointsBeforeHold(currentStroke.points) : null;
    clearHoldTimer();
    if (!currentStroke || !isHoldSnapTool(currentStroke.tool) || currentStroke.locked) return;
    const detected = detectHoldShape(shapePoints, currentStroke.tool);
    const learn = currentStroke.tool === "pen"; // Lernen nur fuer die Stift-Formen
    if (!detected) {
      if (learn) watchShapeMiss(currentStroke.id, lastShapeMetrics);
      return;
    }
    if (learn) watchShapeSnap(currentStroke.id, detected.type === "circle" && detected.round === false ? "ellipse" : detected.type, lastShapeMetrics);
    const grab = currentStroke.points[currentStroke.points.length - 1];
    currentStroke.points = detected.points;
    currentStroke.unsent = [];
    currentStroke.locked = true;
    const shapeName = detected.type === "circle" && detected.round === false ? "ellipse" : detected.type;
    currentStroke.extra = Object.assign({}, currentStroke.extra || {}, { shape: shapeName });
    currentStroke.shape = shapeName;
    currentStroke.shapeBase = detected.points.map((p) => ({ x: p.x, y: p.y, p: p.p }));
    currentStroke.shapeHandle = null;
    currentStroke.shapeHandleLocked = false;
    currentStroke.shapeGeom = makeShapeGeom(shapeName, detected.points, grab);
    wsSend({
      type: "stroke_replace",
      strokeId: currentStroke.id,
      points: detected.points,
      extra: currentStroke.extra,
    });
    requestRedraw();
  }

  function closedRing(pts) {
    if (!pts || pts.length < 2) return pts || [];
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1.5) return pts.slice(0, -1);
    return pts.slice();
  }

  function uniqueRectCorners(pts) {
    const ring = closedRing(pts);
    const p0 = (pts && pts[0] && pts[0].p) || 0.5;
    const four = ring.length >= 4 && ring.length <= 5 ? ring.slice(0, 4) : null;
    if (four && four.length === 4) {
      return orderCornersCcw(four.map((p) => ({ x: p.x, y: p.y, p: p.p == null ? p0 : p.p })));
    }
    const b = makeBBox(pts || []);
    return [
      { x: b.minX, y: b.minY, p: p0 },
      { x: b.maxX, y: b.minY, p: p0 },
      { x: b.maxX, y: b.maxY, p: p0 },
      { x: b.minX, y: b.maxY, p: p0 },
    ];
  }

  function rebuildClosed(corners, pressure) {
    const p = pressure == null ? 0.5 : pressure;
    return corners.map((c) => ({ x: c.x, y: c.y, p })).concat([{ x: corners[0].x, y: corners[0].y, p }]);
  }

  function moveRectCorner(ordered, i, world, pressure) {
    const opp = ordered[(i + 2) % 4];
    const prev = ordered[(i + 3) % 4];
    const next = ordered[(i + 1) % 4];
    let ax = prev.x - opp.x;
    let ay = prev.y - opp.y;
    let bx = next.x - opp.x;
    let by = next.y - opp.y;
    const al = Math.hypot(ax, ay) || 1;
    const bl = Math.hypot(bx, by) || 1;
    ax /= al;
    ay /= al;
    bx /= bl;
    by /= bl;
    const dx = world.x - opp.x;
    const dy = world.y - opp.y;
    const ua = Math.max(10, dx * ax + dy * ay);
    const vb = Math.max(10, dx * bx + dy * by);
    const out = ordered.map((c) => ({ x: c.x, y: c.y, p: pressure }));
    out[(i + 2) % 4] = { x: opp.x, y: opp.y, p: pressure };
    out[(i + 3) % 4] = { x: opp.x + ax * ua, y: opp.y + ay * ua, p: pressure };
    out[(i + 1) % 4] = { x: opp.x + bx * vb, y: opp.y + by * vb, p: pressure };
    out[i] = { x: opp.x + ax * ua + bx * vb, y: opp.y + ay * ua + by * vb, p: pressure };
    return rebuildClosed(out, pressure);
  }

  function moveRectSide(ordered, i, world, pressure) {
    const a = ordered[i];
    const b = ordered[(i + 1) % 4];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let ex = b.x - a.x;
    let ey = b.y - a.y;
    const el = Math.hypot(ex, ey) || 1;
    ex /= el;
    ey /= el;
    let nx = -ey;
    let ny = ex;
    const cx = ordered.reduce((s, p) => s + p.x, 0) / 4;
    const cy = ordered.reduce((s, p) => s + p.y, 0) / 4;
    if ((mx - cx) * nx + (my - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const dist = (world.x - mx) * nx + (world.y - my) * ny;
    const out = ordered.map((c) => ({ x: c.x, y: c.y, p: pressure }));
    out[i] = { x: a.x + nx * dist, y: a.y + ny * dist, p: pressure };
    out[(i + 1) % 4] = { x: b.x + nx * dist, y: b.y + ny * dist, p: pressure };
    const w = Math.hypot(out[i].x - out[(i + 3) % 4].x, out[i].y - out[(i + 3) % 4].y);
    const h = Math.hypot(out[i].x - out[(i + 1) % 4].x, out[i].y - out[(i + 1) % 4].y);
    if (w < 10 || h < 10) return rebuildClosed(ordered, pressure);
    return rebuildClosed(out, pressure);
  }

  function ellipseGeomFromPoints(pts) {
    const b = makeBBox(pts);
    return {
      cx: (b.minX + b.maxX) / 2,
      cy: (b.minY + b.maxY) / 2,
      rx: Math.max(8, (b.maxX - b.minX) / 2),
      ry: Math.max(8, (b.maxY - b.minY) / 2),
    };
  }

  function inferShape(stroke) {
    if (!stroke || stroke.tool === "image" || stroke.tool === "text" || stroke.tool === "table") return null;
    const tagged = stroke.extra && stroke.extra.shape;
    if (tagged) return tagged;
    const pts = stroke.points || [];
    if (pts.length === 2) return "line";
    const ring = closedRing(pts);
    if (pts.length >= 4 && pts.length <= 6) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 14) {
        if (ring.length === 4) return "rectangle";
        if (ring.length === 3) return "triangle";
      }
    }
    if (looksLikePolygon(pts)) {
      const n = ring.length;
      if (n === 4) return "rectangle";
      if (n === 3) return "triangle";
    }
    if (pts.length >= 24) {
      const g = ellipseGeomFromPoints(pts);
      let sum = 0;
      for (const p of pts) {
        const rx = g.rx || 1;
        const ry = g.ry || 1;
        const nx = (p.x - g.cx) / rx;
        const ny = (p.y - g.cy) / ry;
        sum += Math.abs(Math.hypot(nx, ny) - 1);
      }
      // Nur maschinell exakte Ellipsen (eingerastete Formen ohne Etikett aus aelteren Daten).
      // Frueher 0.22 - damit galten auch handgeschriebene "o"/"0" als Kreis und wurden beim
      // Antippen mit dem Stift ploetzlich markiert.
      if (sum / pts.length < 0.03) return Math.abs(g.rx - g.ry) / Math.max(g.rx, g.ry) < 0.18 ? "circle" : "ellipse";
    }
    return null;
  }

  function tagShape(stroke) {
    const shape = inferShape(stroke);
    if (!shape) return null;
    stroke.extra = Object.assign({}, stroke.extra || {}, { shape });
    return shape;
  }

  function pickLockedHandle(shape, pts, grab) {
    if (!grab) return { kind: "scale", i: 0 };
    if (shape === "rectangle") {
      const corners = uniqueRectCorners(pts);
      let best = { kind: "corner", i: 0, d: Infinity };
      for (let i = 0; i < corners.length; i++) {
        const d = Math.hypot(corners[i].x - grab.x, corners[i].y - grab.y);
        if (d < best.d) best = { kind: "corner", i, d };
      }
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const d = Math.min(Math.hypot(mid.x - grab.x, mid.y - grab.y), distPointToSeg(grab, a, b));
        if (d < best.d + 24) best = { kind: "side", i, d };
      }
      return best;
    }
    if (shape === "line") {
      const a = pts[0];
      const b = pts[pts.length - 1];
      const da = Math.hypot(a.x - grab.x, a.y - grab.y);
      const db = Math.hypot(b.x - grab.x, b.y - grab.y);
      return { kind: "end", i: da <= db ? 0 : pts.length - 1 };
    }
    return { kind: "scale", i: 0 };
  }

  function makeShapeGeom(shape, pts, grab) {
    const g = ellipseGeomFromPoints(pts);
    g.grabX = grab ? grab.x : g.cx + g.rx;
    g.grabY = grab ? grab.y : g.cy;
    g.grabR = Math.max(8, Math.hypot(g.grabX - g.cx, g.grabY - g.cy));
    g.base = (pts || []).map((p) => ({ x: p.x, y: p.y, p: p.p }));
    g.shape = shape;
    return g;
  }

  function reshapeLockedStroke(wx, wy) {
    const s = currentStroke;
    if (!s || !s.locked || !s.shape) return;
    const p = (s.points[0] && s.points[0].p) || 0.5;
    const world = { x: wx, y: wy };
    if (s.shape === "rectangle") {
      const base = uniqueRectCorners(s.shapeBase || s.points);
      if (!s.shapeHandleLocked) {
        const gx = s.shapeGeom ? s.shapeGeom.grabX : world.x;
        const gy = s.shapeGeom ? s.shapeGeom.grabY : world.y;
        if (Math.hypot(wx - gx, wy - gy) < 8) return;
        s.shapeHandle = pickLockedHandle("rectangle", s.shapeBase || s.points, world);
        s.shapeHandleLocked = true;
      }
      const h = s.shapeHandle || { kind: "corner", i: 0 };
      s.points = h.kind === "side" ? moveRectSide(base, h.i, world, p) : moveRectCorner(base, h.i, world, p);
    } else if (s.shape === "circle" || s.shape === "ellipse") {
      const g = s.shapeGeom || ellipseGeomFromPoints(s.shapeBase || s.points);
      const d = Math.max(8, Math.hypot(wx - g.cx, wy - g.cy));
      if (s.shape === "circle") s.points = makeEllipsePoints(g.cx, g.cy, d, d, p, 96);
      else {
        const f = d / (g.grabR || 1);
        s.points = makeEllipsePoints(g.cx, g.cy, Math.max(8, g.rx * f), Math.max(8, g.ry * f), p, 96);
      }
    } else if (s.shape === "line") {
      const pts = (s.shapeBase || s.points).map((pt) => ({ x: pt.x, y: pt.y, p: pt.p }));
      const i = (s.shapeHandle && s.shapeHandle.i) || pts.length - 1;
      pts[i] = { x: wx, y: wy, p };
      s.points = pts;
    } else if (s.shape === "triangle") {
      const g = s.shapeGeom;
      const d = Math.max(8, Math.hypot(wx - g.cx, wy - g.cy));
      const f = d / (g.grabR || 1);
      s.points = g.base.map((pt) => ({ x: g.cx + (pt.x - g.cx) * f, y: g.cy + (pt.y - g.cy) * f, p }));
    }
    s.bbox = makeBBox(s.points);
    wsSend({ type: "stroke_replace", strokeId: s.id, points: s.points, extra: s.extra });
    requestRedraw();
  }

  function shapeEditKnots(stroke) {
    const shape = inferShape(stroke);
    const pts = stroke.points || [];
    const p0 = pts[0] || { p: 0.5 };
    if (shape === "rectangle") {
      const corners = uniqueRectCorners(pts);
      const knots = corners.map((c, i) => ({ kind: "corner", corner: i, i, x: c.x, y: c.y }));
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        knots.push({ kind: "side", side: i, i: 100 + i, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
      return knots;
    }
    if (shape === "circle" || shape === "ellipse") {
      const g = ellipseGeomFromPoints(pts);
      return [
        { kind: "radius", axis: "x", i: 0, x: g.cx + g.rx, y: g.cy },
        { kind: "radius", axis: "y", i: 1, x: g.cx, y: g.cy - g.ry },
        { kind: "radius", axis: "x", i: 2, x: g.cx - g.rx, y: g.cy },
        { kind: "radius", axis: "y", i: 3, x: g.cx, y: g.cy + g.ry },
      ];
    }
    if (shape === "triangle") {
      return closedRing(pts)
        .slice(0, 3)
        .map((c, i) => ({ kind: "corner", corner: i, i, x: c.x, y: c.y }));
    }
    if (shape === "line" && pts.length >= 2) {
      const last = pts.length - 1;
      return [
        { kind: "end", i: 0, x: pts[0].x, y: pts[0].y },
        { kind: "end", i: last, x: pts[last].x, y: pts[last].y },
      ];
    }
    return null;
  }

  function grabSelectedShapeWithPen(e, world) {
    if (!selection.bbox || !selection.ids.size || cropState) return false;
    const shapes = selectedStrokes().filter((s) => s.extra && s.extra.shape);
    if (shapes.length !== selection.ids.size) return false;
    const pad = SELECT_PAD_PX / scale;
    const knot = pickEditKnot(world);
    if (knot) {
      startPointEdit(e.pointerId, world, knot);
      return true;
    }
    const handle = pickScaleHandle(world, selection.bbox, pad);
    if (handle) {
      startSelectionScale(e.pointerId, world, handle);
      return true;
    }
    if (pickRotateHandle(world, selection.bbox, pad)) {
      startSelectionRotate(e.pointerId, world);
      return true;
    }
    const hit = pickStrokeAt(world);
    if (hit && selection.ids.has(hit.id)) {
      beginStrokeInteraction(e.pointerId, world, hit, e.clientX, e.clientY);
      return true;
    }
    return false;
  }

  function beginStrokeInteraction(pointerId, world, stroke, clientX, clientY) {
    selectStrokeIds([stroke.id]);
    const pad = 10 / scale;
    const knot = pickEditKnot(world);
    if (knot) {
      startPointEdit(pointerId, world, knot);
      return;
    }
    if (selection.bbox) {
      const handle = pickScaleHandle(world, selection.bbox, pad);
      if (handle) {
        startSelectionScale(pointerId, world, handle);
        return;
      }
      if (pickRotateHandle(world, selection.bbox, pad)) {
        startSelectionRotate(pointerId, world);
        return;
      }
    }
    pendingShapeDrag = { pointerId, startWorld: world, clientX, clientY, strokeId: stroke.id };
  }

  // ---- Textfelder & Tabellen ------------------------------------------------
  // Textfeld: tool "text" mit extra.box. points[0] = Grundlinie der 1. Zeile (+ text),
  // points[1]/[2] spannen die Box fuer bbox/Auswahl auf. extra.width = Umbruchbreite (oder null).
  // Tabelle: tool "table", points = [oben links, unten rechts], extra = {rows, cols, cw, rh, cells}
  // (cw/rh sind relative Gewichte, damit Skalieren per Auswahl einfach mitzieht).
  const TEXT_LINE = 1.3;
  const measureCtx = document.createElement("canvas").getContext("2d");
  const textEditorEl = document.getElementById("text-editor");
  let textEdit = null; // laufende Eingabe: {kind:"text"|"cell", ...}
  let textDrag = null; // {pointerId, startWorld, cur} - Ziehen/Tippen mit dem Text-Werkzeug
  let textTapSuppressed = null;

  function isObjectStroke(s) {
    return !!s && (s.tool === "image" || s.tool === "text" || s.tool === "table");
  }
  function isBoxText(s) {
    return !!s && s.tool === "text" && !!(s.extra && s.extra.box);
  }
  function textFont(size) {
    return `400 ${size}px Inter, sans-serif`;
  }

  function wrapText(text, size, width) {
    measureCtx.font = textFont(size);
    const out = [];
    for (const para of String(text || "").split("\n")) {
      if (!width) {
        out.push(para);
        continue;
      }
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        const next = line + word;
        if (!line || measureCtx.measureText(next).width <= width) {
          line = next;
          continue;
        }
        out.push(line.trimEnd());
        line = word.trimStart();
        // einzelnes ueberlanges Wort hart umbrechen
        while (line && measureCtx.measureText(line).width > width) {
          let cut = line.length - 1;
          while (cut > 1 && measureCtx.measureText(line.slice(0, cut)).width > width) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      out.push(line);
    }
    return out.length ? out : [""];
  }

  // ---- Formatierter Text: runs = [{t, b, i, s, u}] (fett, kursiv, durchgestrichen,
  // unterstrichen). points[0].text bleibt der reine Text (Suche, KI, aeltere Clients).
  function runFont(run, size) {
    return `${run.i ? "italic " : ""}${run.b ? 700 : 400} ${size}px Inter, sans-serif`;
  }
  function sameStyle(a, b) {
    return !!a.b === !!b.b && !!a.i === !!b.i && !!a.s === !!b.s && !!a.u === !!b.u;
  }
  function normalizeRuns(runs) {
    const out = [];
    for (const r of runs || []) {
      if (!r || !r.t) continue;
      const clean = { t: String(r.t) };
      for (const k of ["b", "i", "s", "u"]) if (r[k]) clean[k] = 1;
      const last = out[out.length - 1];
      if (last && sameStyle(last, clean)) last.t += clean.t;
      else out.push(clean);
    }
    return out;
  }
  function runsText(runs) {
    return (runs || []).map((r) => r.t).join("");
  }
  function strokeRuns(s) {
    const ex = s.extra || {};
    if (Array.isArray(ex.runs) && ex.runs.length) return ex.runs;
    return [{ t: (s.points[0] && s.points[0].text) || "" }];
  }

  // Zeilen aus Wort-Stuecken mit eigener Schrift; bricht bei width um (null = nur bei \n).
  function layoutRuns(runs, size, width) {
    const lines = [[]];
    const widths = [0];
    for (const run of runs) {
      measureCtx.font = runFont(run, size);
      const parts = String(run.t).split(/(\n|\s+)/);
      for (const part of parts) {
        if (!part) continue;
        if (part === "\n") {
          lines.push([]);
          widths.push(0);
          continue;
        }
        let w = measureCtx.measureText(part).width;
        const li = lines.length - 1;
        const isSpace = /^\s+$/.test(part);
        if (width && !isSpace && widths[li] > 0 && widths[li] + w > width) {
          // Leerzeichen am Zeilenende gehoeren nicht in die Breite
          while (lines[li].length && /^\s+$/.test(lines[li][lines[li].length - 1].t)) widths[li] -= lines[li].pop().w;
          lines.push([]);
          widths.push(0);
        }
        let text = part;
        // einzelnes ueberlanges Wort hart umbrechen
        while (width && !isSpace && w > width && text.length > 1) {
          let cut = text.length - 1;
          while (cut > 1 && measureCtx.measureText(text.slice(0, cut)).width > width) cut--;
          const head = text.slice(0, cut);
          const hw = measureCtx.measureText(head).width;
          lines[lines.length - 1].push({ t: head, w: hw, run });
          widths[widths.length - 1] += hw;
          lines.push([]);
          widths.push(0);
          text = text.slice(cut);
          w = measureCtx.measureText(text).width;
        }
        if (isSpace && widths[lines.length - 1] === 0 && lines.length > 1 && width) continue;
        lines[lines.length - 1].push({ t: text, w, run });
        widths[widths.length - 1] += w;
      }
    }
    return { lines, widths };
  }

  function boxTextPoints(x, y, text, size, width, runs) {
    const lay = layoutRuns(runs && runs.length ? runs : [{ t: text }], size, width);
    const w = width || Math.max(size * 0.6, ...lay.widths);
    const lh = size * TEXT_LINE;
    return [
      { x, y, p: 1, text },
      { x: x + w, y: y - size * 0.95, p: 1 },
      { x, y: y + (lay.lines.length - 1) * lh + size * 0.35, p: 1 },
    ];
  }

  function relayoutBoxText(s) {
    const a = s.points[0];
    const width = s.extra && s.extra.width ? s.extra.width : null;
    s.points = boxTextPoints(a.x, a.y, a.text || "", s.size, width, strokeRuns(s));
    s.bbox = strokeWorldBBox(s);
  }

  function drawBoxText(c, s) {
    if (textEdit && textEdit.kind === "text" && textEdit.strokeId === s.id) return;
    const a = s.points[0];
    const width = s.extra && s.extra.width ? s.extra.width : null;
    const lay = layoutRuns(strokeRuns(s), s.size, width);
    c.save();
    c.fillStyle = s.color || "#1E1F22";
    c.strokeStyle = s.color || "#1E1F22";
    c.lineWidth = Math.max(0.5, s.size * 0.06);
    c.textBaseline = "alphabetic";
    c.textAlign = "left";
    c.translate(a.x, a.y);
    const rot = strokeRotation(s);
    if (rot) c.rotate(rot);
    const lh = s.size * TEXT_LINE;
    lay.lines.forEach((line, li) => {
      let x = 0;
      const y = li * lh;
      for (const piece of line) {
        c.font = runFont(piece.run, s.size);
        c.fillText(piece.t, x, y);
        if (piece.run.u) {
          c.beginPath();
          c.moveTo(x, y + s.size * 0.12);
          c.lineTo(x + piece.w, y + s.size * 0.12);
          c.stroke();
        }
        if (piece.run.s) {
          c.beginPath();
          c.moveTo(x, y - s.size * 0.3);
          c.lineTo(x + piece.w, y - s.size * 0.3);
          c.stroke();
        }
        x += piece.w;
      }
    });
    c.restore();
  }

  function tableGeom(t) {
    const x0 = Math.min(t.points[0].x, t.points[1].x);
    const y0 = Math.min(t.points[0].y, t.points[1].y);
    const W = Math.abs(t.points[1].x - t.points[0].x);
    const H = Math.abs(t.points[1].y - t.points[0].y);
    const ex = t.extra || {};
    const cw = ex.cw && ex.cw.length === ex.cols ? ex.cw : new Array(ex.cols || 1).fill(1);
    const rh = ex.rh && ex.rh.length === ex.rows ? ex.rh : new Array(ex.rows || 1).fill(1);
    const sw = cw.reduce((a, b) => a + b, 0) || 1;
    const sh = rh.reduce((a, b) => a + b, 0) || 1;
    const xs = [x0];
    for (const w of cw) xs.push(xs[xs.length - 1] + (w / sw) * W);
    const ys = [y0];
    for (const h of rh) ys.push(ys[ys.length - 1] + (h / sh) * H);
    return { x0, y0, W, H, xs, ys, rows: rh.length, cols: cw.length };
  }

  function cellAt(t, world) {
    const g = tableGeom(t);
    if (world.x < g.x0 || world.x > g.x0 + g.W || world.y < g.y0 || world.y > g.y0 + g.H) return null;
    let c = 0;
    while (c < g.cols - 1 && world.x > g.xs[c + 1]) c++;
    let r = 0;
    while (r < g.rows - 1 && world.y > g.ys[r + 1]) r++;
    return { r, c };
  }

  function cellPad(t) {
    return t.size * 0.4;
  }

  function drawTable(c, t) {
    const g = tableGeom(t);
    const cells = (t.extra && t.extra.cells) || {};
    c.save();
    c.fillStyle = "rgba(255,255,255,0.92)";
    c.fillRect(g.x0, g.y0, g.W, g.H);
    c.strokeStyle = t.color || "#5f6368";
    c.lineWidth = Math.max(1 / scale, t.size * 0.05);
    c.beginPath();
    for (const x of g.xs) {
      c.moveTo(x, g.y0);
      c.lineTo(x, g.y0 + g.H);
    }
    for (const y of g.ys) {
      c.moveTo(g.x0, y);
      c.lineTo(g.x0 + g.W, y);
    }
    c.stroke();
    c.fillStyle = "#1E1F22";
    c.font = textFont(t.size);
    c.textBaseline = "alphabetic";
    const pad = cellPad(t);
    const lh = t.size * TEXT_LINE;
    for (let r = 0; r < g.rows; r++) {
      for (let col = 0; col < g.cols; col++) {
        const text = cells[r + "," + col];
        if (!text) continue;
        if (textEdit && textEdit.kind === "cell" && textEdit.tableId === t.id && textEdit.r === r && textEdit.c === col) continue;
        const lines = wrapText(text, t.size, Math.max(4, g.xs[col + 1] - g.xs[col] - pad * 2));
        lines.forEach((line, i) => c.fillText(line, g.xs[col] + pad, g.ys[r] + pad + t.size * 0.95 + i * lh));
      }
    }
    c.restore();
  }

  function withTableContents(ids) {
    const set = new Set(ids);
    for (const id of ids) {
      const t = boardStrokes.get(id);
      if (!t || t.tool !== "table") continue;
      const b = t.bbox || strokeWorldBBox(t);
      for (const s of boardStrokes.values()) {
        if (set.has(s.id) || s.tool === "image" || s.tool === "table") continue;
        const sb = s.bbox || strokeWorldBBox(s);
        if (!sb) continue;
        const cx = (sb.minX + sb.maxX) / 2;
        const cy = (sb.minY + sb.maxY) / 2;
        if (cx >= b.minX && cx <= b.maxX && cy >= b.minY && cy <= b.maxY) set.add(s.id);
      }
    }
    return Array.from(set);
  }

  function selectedTextBoxes() {
    const all = selectedStrokes();
    const texts = all.filter((s) => s.tool === "text");
    return texts.length && texts.length === all.length ? texts : [];
  }

  // Fett/kursiv/... fuer ganze ausgewaehlte Textfelder umschalten (alle an -> alle aus)
  function toggleTextFlag(flag) {
    const texts = selectedTextBoxes();
    if (!texts.length) return;
    const allOn = texts.every((t) => strokeRuns(t).every((r) => r[flag]));
    for (const t of texts) {
      const before = cloneStroke(t);
      const runs = normalizeRuns(strokeRuns(t).map((r) => ({ ...r, [flag]: allOn ? 0 : 1 })));
      const ex = Object.assign({}, t.extra || {}, { box: true });
      if (runs.every((r) => !r.b && !r.i && !r.s && !r.u)) delete ex.runs;
      else ex.runs = runs;
      t.extra = ex;
      relayoutBoxText(t);
      wsSend({ type: "stroke_move", stroke: serializeStroke(t) });
      pushUndo({ type: "replace", before, after: cloneStroke(t) });
    }
    selectStrokeIds(Array.from(selection.ids));
    syncSelectionToolbar();
    requestRedraw();
  }
  document.querySelectorAll(".txt-btn").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTextFlag(b.dataset.flag);
    })
  );

  function selectedTable() {
    const tables = selectedStrokes().filter((s) => s.tool === "table");
    return tables.length === 1 ? tables[0] : null;
  }

  function insertTable(spec) {
    if (textEdit) commitTextEditor();
    const center = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    const k = 1 / Math.max(scale, 0.25);
    const cols = spec ? spec.cw.length : 3;
    const rows = spec ? spec.rh.length : 3;
    const cwAbs = spec ? spec.cw.slice() : new Array(cols).fill(150 * k);
    const rhAbs = spec ? spec.rh.slice() : new Array(rows).fill(46 * k);
    const W = cwAbs.reduce((a, b) => a + b, 0);
    const H = rhAbs.reduce((a, b) => a + b, 0);
    const x0 = center.x - W / 2;
    const y0 = center.y - H / 2;
    const t = {
      id: uuid(),
      tool: "table",
      color: "#5f6368",
      size: 20 * k,
      points: [
        { x: x0, y: y0, p: 1 },
        { x: x0 + W, y: y0 + H, p: 1 },
      ],
      extra: { rows, cols, cw: cwAbs, rh: rhAbs, cells: {} },
    };
    putStroke(t);
    pushUndo({ type: "replace", before: null, after: cloneStroke(t) });
    lastTableId = t.id;
    // direkt in die erste Zelle schreiben (Text-Modus bleibt)
    if (currentTool !== "text") setTool("text");
    openCellEditor(boardStrokes.get(t.id), { r: 0, c: 0 });
    syncModeBar();
    requestRedraw();
  }

  // Zeile/Spalte anfuegen oder die letzte entfernen. Gewichte werden dabei in absolute
  // Weltgroessen umgerechnet, damit die vorhandenen Zellen ihre Groesse behalten.
  function changeTable(kind, delta, explicit) {
    const t = explicit || selectedTable();
    if (!t) return;
    lastTableId = t.id;
    const before = cloneStroke(t);
    const g = tableGeom(t);
    const ex = JSON.parse(JSON.stringify(t.extra || {}));
    let cw = g.xs.slice(1).map((x, i) => x - g.xs[i]);
    let rh = g.ys.slice(1).map((y, i) => y - g.ys[i]);
    const cells = ex.cells || {};
    if (kind === "row") {
      if (delta > 0) rh.push(rh[rh.length - 1] || t.size * 2.3);
      else if (rh.length > 1) {
        rh.pop();
        for (const key of Object.keys(cells)) if (Number(key.split(",")[0]) >= rh.length) delete cells[key];
      } else return;
    } else {
      if (delta > 0) cw.push(cw[cw.length - 1] || t.size * 7);
      else if (cw.length > 1) {
        cw.pop();
        for (const key of Object.keys(cells)) if (Number(key.split(",")[1]) >= cw.length) delete cells[key];
      } else return;
    }
    ex.cw = cw;
    ex.rh = rh;
    ex.rows = rh.length;
    ex.cols = cw.length;
    ex.cells = cells;
    t.extra = ex;
    t.points = [
      { x: g.x0, y: g.y0, p: 1 },
      { x: g.x0 + cw.reduce((a, b) => a + b, 0), y: g.y0 + rh.reduce((a, b) => a + b, 0), p: 1 },
    ];
    t.bbox = strokeWorldBBox(t);
    wsSend({ type: "stroke_move", stroke: serializeStroke(t) });
    pushUndo({ type: "replace", before, after: cloneStroke(t) });
    if (selection.ids.size) selectStrokeIds(Array.from(selection.ids));
    syncSelectionToolbar();
  }

  // Tabelle, auf die sich die Zeilen/Spalten-Knoepfe beziehen: ausgewaehlt (Lasso), gerade in
  // einer Zelle in Bearbeitung, oder zuletzt eingefuegt/angetippt
  let lastTableId = null;
  function activeTable() {
    const sel = typeof selectedTable === "function" ? selectedTable() : null;
    if (sel) return sel;
    if (textEdit && textEdit.kind === "cell") return boardStrokes.get(textEdit.tableId) || null;
    const last = lastTableId && boardStrokes.get(lastTableId);
    return last && last.tool === "table" ? last : null;
  }

  // Waechst der Text in einer Zelle ueber ihre Hoehe hinaus, wird die Zeile hoeher.
  function growTableRows(t) {
    const g = tableGeom(t);
    const pad = cellPad(t);
    const lh = t.size * TEXT_LINE;
    const cells = (t.extra && t.extra.cells) || {};
    const rh = g.ys.slice(1).map((y, i) => y - g.ys[i]);
    const cw = g.xs.slice(1).map((x, i) => x - g.xs[i]);
    let changed = false;
    for (let r = 0; r < rh.length; r++) {
      let need = 0;
      for (let col = 0; col < cw.length; col++) {
        const text = cells[r + "," + col];
        if (!text) continue;
        const n = wrapText(text, t.size, Math.max(4, cw[col] - pad * 2)).length;
        need = Math.max(need, pad * 2 + t.size * 0.35 + (n - 1) * lh + t.size * 0.95);
      }
      if (need > rh[r] + 0.5) {
        rh[r] = need;
        changed = true;
      }
    }
    if (!changed) return;
    t.extra = Object.assign({}, t.extra, { rh, cw });
    t.points = [
      { x: g.x0, y: g.y0, p: 1 },
      { x: g.x0 + cw.reduce((a, b) => a + b, 0), y: g.y0 + rh.reduce((a, b) => a + b, 0), p: 1 },
    ];
  }

  // innere Tabellenlinie unter dem Punkt (Toleranz in Bildschirm-Pixeln)
  function tableLineAt(t, world, tolPx) {
    const g = tableGeom(t);
    const tol = tolPx / scale;
    let best = null;
    const grip = tol;
    if (world.y >= g.y0 - grip && world.y <= g.y0 + g.H + tol) {
      for (let i = 1; i < g.xs.length - 1; i++) {
        const d = Math.abs(world.x - g.xs[i]);
        if (d <= tol && (!best || d < best.d)) best = { axis: "x", i, d };
      }
    }
    if (world.x >= g.x0 - grip && world.x <= g.x0 + g.W + tol) {
      for (let i = 1; i < g.ys.length - 1; i++) {
        const d = Math.abs(world.y - g.ys[i]);
        if (d <= tol && (!best || d < best.d)) best = { axis: "y", i, d };
      }
    }
    return best;
  }
  function updateTableLineDrag(world) {
    const t = boardStrokes.get(dragState.tableId);
    if (!t) return;
    const x = dragState.axis === "x";
    const arr = (x ? dragState.cw0 : dragState.rh0).slice();
    const delta = x ? world.x - dragState.startWorld.x : world.y - dragState.startWorld.y;
    const min = t.size * (x ? 1.6 : 1.5);
    const i = dragState.i - 1;
    const sum = arr[i] + arr[i + 1];
    const a = Math.max(min, Math.min(sum - min, arr[i] + delta));
    arr[i] = a;
    arr[i + 1] = sum - a;
    const ex = Object.assign({}, t.extra);
    if (x) {
      ex.cw = arr;
      ex.rh = dragState.rh0.slice();
    } else {
      ex.rh = arr;
      ex.cw = dragState.cw0.slice();
    }
    t.extra = ex;
    requestRedraw();
  }

  // ---- Tabellen-Dialog: Spalten/Zeilen, Breiten ziehen, Vorschau mit vorhandenem Text ----
  const tableDialog = document.getElementById("table-dialog");
  const tdPreview = document.getElementById("td-preview");
  let tdState = null; // {tableId|null, size, cw[], rh[], cells{}}
  let tdDrag = null;

  function openTableDialog(t) {
    if (!tableDialog) return;
    if (textEdit) commitTextEditor();
    hidePopovers();
    const k = 1 / Math.max(scale, 0.25);
    if (t) {
      const g = tableGeom(t);
      tdState = {
        tableId: t.id,
        size: t.size,
        cw: g.xs.slice(1).map((x, i) => x - g.xs[i]),
        rh: g.ys.slice(1).map((y, i) => y - g.ys[i]),
        cells: JSON.parse(JSON.stringify((t.extra && t.extra.cells) || {})),
      };
    } else {
      tdState = { tableId: null, size: 20 * k, cw: [150 * k, 150 * k, 150 * k], rh: [46 * k, 46 * k, 46 * k], cells: {} };
    }
    document.getElementById("td-title").textContent = t ? "Tabelle bearbeiten" : "Tabelle einfügen";
    document.getElementById("td-ok").textContent = t ? "Übernehmen" : "Einfügen";
    tableDialog.classList.remove("hidden");
    renderTableDialog();
  }
  function closeTableDialog() {
    if (!tableDialog) return;
    tableDialog.classList.add("hidden");
    tdState = null;
    tdDrag = null;
  }
  function tdMinCol() {
    return tdState.size * 1.6;
  }
  function tdMinRow() {
    return tdState.size * 1.5;
  }
  // Vorschau-Layout: Tabelle passend in die Flaeche skaliert
  function tdLayout() {
    const r = tdPreview.getBoundingClientRect();
    const W = tdState.cw.reduce((a, b) => a + b, 0);
    const H = tdState.rh.reduce((a, b) => a + b, 0);
    const m = 14;
    const f = Math.min((r.width - m * 2) / W, (r.height - m * 2) / H, 2.5);
    const ox = (r.width - W * f) / 2;
    const oy = (r.height - H * f) / 2;
    const xs = [ox];
    for (const w of tdState.cw) xs.push(xs[xs.length - 1] + w * f);
    const ys = [oy];
    for (const h of tdState.rh) ys.push(ys[ys.length - 1] + h * f);
    return { r, f, xs, ys };
  }
  function renderTableDialog() {
    if (!tdState) return;
    document.getElementById("td-cols").textContent = String(tdState.cw.length);
    document.getElementById("td-rows").textContent = String(tdState.rh.length);
    const d = window.devicePixelRatio || 1;
    const L = tdLayout();
    tdPreview.width = Math.round(L.r.width * d);
    tdPreview.height = Math.round(L.r.height * d);
    const c = tdPreview.getContext("2d");
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, L.r.width, L.r.height);
    const x0 = L.xs[0], x1 = L.xs[L.xs.length - 1], y0 = L.ys[0], y1 = L.ys[L.ys.length - 1];
    c.fillStyle = "#fff";
    c.fillRect(x0, y0, x1 - x0, y1 - y0);
    // Text wie auf dem Blatt (gleicher Umbruch, nur verkleinert)
    const size = tdState.size;
    const pad = size * 0.4;
    const lh = size * TEXT_LINE;
    c.save();
    c.scale(L.f, L.f);
    c.fillStyle = "#1E1F22";
    c.font = textFont(size);
    c.textBaseline = "alphabetic";
    for (let r = 0; r < tdState.rh.length; r++) {
      for (let col = 0; col < tdState.cw.length; col++) {
        const text = tdState.cells[r + "," + col];
        if (!text) continue;
        const cx = L.xs[col] / L.f, cy = L.ys[r] / L.f;
        c.save();
        c.beginPath();
        c.rect(cx, cy, tdState.cw[col], tdState.rh[r]);
        c.clip();
        wrapText(text, size, Math.max(4, tdState.cw[col] - pad * 2)).forEach((line, i) =>
          c.fillText(line, cx + pad, cy + pad + size * 0.95 + i * lh)
        );
        c.restore();
      }
    }
    c.restore();
    c.strokeStyle = "#5f6368";
    c.lineWidth = 1.2;
    c.beginPath();
    for (const x of L.xs) {
      c.moveTo(x, y0);
      c.lineTo(x, y1);
    }
    for (const y of L.ys) {
      c.moveTo(x0, y);
      c.lineTo(x1, y);
    }
    c.stroke();
    // gezogene / greifbare Linie hervorheben
    if (tdDrag) {
      c.strokeStyle = "#1A73E8";
      c.lineWidth = 3;
      c.beginPath();
      if (tdDrag.axis === "x") {
        c.moveTo(L.xs[tdDrag.i], y0 - 6);
        c.lineTo(L.xs[tdDrag.i], y1 + 6);
      } else {
        c.moveTo(x0 - 6, L.ys[tdDrag.i]);
        c.lineTo(x1 + 6, L.ys[tdDrag.i]);
      }
      c.stroke();
    }
    // kleine Griffe an jeder Linie
    c.fillStyle = "#1A73E8";
    for (let i = 1; i < L.xs.length; i++) {
      c.beginPath();
      c.arc(L.xs[i], y0 - 7, 4, 0, Math.PI * 2);
      c.fill();
    }
    for (let i = 1; i < L.ys.length; i++) {
      c.beginPath();
      c.arc(x0 - 7, L.ys[i], 4, 0, Math.PI * 2);
      c.fill();
    }
  }
  function tdStep(kind, d) {
    if (!tdState) return;
    const arr = kind === "cols" ? tdState.cw : tdState.rh;
    if (d > 0) {
      if (arr.length >= 30) return;
      arr.push(arr[arr.length - 1] || (kind === "cols" ? tdState.size * 7 : tdState.size * 2.3));
    } else {
      if (arr.length <= 1) return;
      arr.pop();
      const n = arr.length;
      for (const key of Object.keys(tdState.cells)) {
        const [r, col] = key.split(",").map(Number);
        if ((kind === "rows" && r >= n) || (kind === "cols" && col >= n)) delete tdState.cells[key];
      }
    }
    renderTableDialog();
  }
  if (tableDialog) {
    tableDialog.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (e.target === tableDialog) closeTableDialog();
    });
    tableDialog.querySelectorAll(".td-step").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        tdStep(b.dataset.k, Number(b.dataset.d));
      })
    );
    document.getElementById("td-even").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!tdState) return;
      const W = tdState.cw.reduce((a, b) => a + b, 0);
      const H = tdState.rh.reduce((a, b) => a + b, 0);
      tdState.cw = tdState.cw.map(() => W / tdState.cw.length);
      tdState.rh = tdState.rh.map(() => H / tdState.rh.length);
      renderTableDialog();
    });
    document.getElementById("td-close").addEventListener("click", closeTableDialog);
    document.getElementById("td-cancel").addEventListener("click", closeTableDialog);
    document.getElementById("td-ok").addEventListener("click", (e) => {
      e.stopPropagation();
      applyTableDialog();
    });
    tableDialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeTableDialog();
      if (e.key === "Enter") applyTableDialog();
    });
    // Linien in der Vorschau ziehen
    tdPreview.addEventListener("pointerdown", (e) => {
      if (!tdState) return;
      e.preventDefault();
      const r = tdPreview.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const L = tdLayout();
      const tol = e.pointerType === "touch" ? 16 : 9;
      let best = null;
      for (let i = 1; i < L.xs.length; i++) {
        const dd = Math.abs(px - L.xs[i]);
        if (dd <= tol && py >= L.ys[0] - 16 && py <= L.ys[L.ys.length - 1] + 16 && (!best || dd < best.dd)) best = { axis: "x", i, dd };
      }
      for (let i = 1; i < L.ys.length; i++) {
        const dd = Math.abs(py - L.ys[i]);
        if (dd <= tol && px >= L.xs[0] - 16 && px <= L.xs[L.xs.length - 1] + 16 && (!best || dd < best.dd)) best = { axis: "y", i, dd };
      }
      if (!best) return;
      tdDrag = { axis: best.axis, i: best.i, id: e.pointerId, start: best.axis === "x" ? px : py, f: L.f, cw: tdState.cw.slice(), rh: tdState.rh.slice() };
      try {
        tdPreview.setPointerCapture(e.pointerId);
      } catch (err) {}
      renderTableDialog();
    });
    tdPreview.addEventListener("pointermove", (e) => {
      if (!tdDrag || tdDrag.id !== e.pointerId) {
        // Zeiger ueber einer Linie: passender Cursor
        if (tdState && e.pointerType === "mouse") {
          const r = tdPreview.getBoundingClientRect();
          const L = tdLayout();
          const px = e.clientX - r.left, py = e.clientY - r.top;
          const onX = L.xs.slice(1).some((x) => Math.abs(px - x) <= 9);
          const onY = L.ys.slice(1).some((y) => Math.abs(py - y) <= 9);
          tdPreview.style.cursor = onX ? "col-resize" : onY ? "row-resize" : "default";
        }
        return;
      }
      const r = tdPreview.getBoundingClientRect();
      const cur = tdDrag.axis === "x" ? e.clientX - r.left : e.clientY - r.top;
      const delta = (cur - tdDrag.start) / tdDrag.f;
      const arr = tdDrag.axis === "x" ? tdDrag.cw.slice() : tdDrag.rh.slice();
      const min = tdDrag.axis === "x" ? tdMinCol() : tdMinRow();
      const i = tdDrag.i - 1; // Linie rechts/unter Feld i
      if (i < arr.length - 1) {
        // innere Linie: Nachbarfelder tauschen Platz, Gesamtgroesse bleibt
        const sum = arr[i] + arr[i + 1];
        const a = Math.max(min, Math.min(sum - min, arr[i] + delta));
        arr[i] = a;
        arr[i + 1] = sum - a;
      } else {
        // aeussere Linie: letztes Feld waechst/schrumpft
        arr[i] = Math.max(min, arr[i] + delta);
      }
      if (tdDrag.axis === "x") tdState.cw = arr;
      else tdState.rh = arr;
      renderTableDialog();
    });
    const endTd = (e) => {
      if (!tdDrag || tdDrag.id !== e.pointerId) return;
      tdDrag = null;
      renderTableDialog();
    };
    tdPreview.addEventListener("pointerup", endTd);
    tdPreview.addEventListener("pointercancel", endTd);
    window.addEventListener("resize", () => tdState && renderTableDialog());
  }
  function applyTableDialog() {
    if (!tdState) return;
    const st = tdState;
    closeTableDialog();
    if (!st.tableId) {
      insertTable({ cw: st.cw, rh: st.rh });
      return;
    }
    const t = boardStrokes.get(st.tableId);
    if (!t) return;
    const before = cloneStroke(t);
    const g = tableGeom(t);
    const ex = JSON.parse(JSON.stringify(t.extra || {}));
    ex.cw = st.cw.slice();
    ex.rh = st.rh.slice();
    ex.cols = ex.cw.length;
    ex.rows = ex.rh.length;
    ex.cells = st.cells;
    t.extra = ex;
    t.points = [
      { x: g.x0, y: g.y0, p: 1 },
      { x: g.x0 + ex.cw.reduce((a, b) => a + b, 0), y: g.y0 + ex.rh.reduce((a, b) => a + b, 0), p: 1 },
    ];
    growTableRows(t);
    t.bbox = strokeWorldBBox(t);
    lastTableId = t.id;
    wsSend({ type: "stroke_move", stroke: serializeStroke(t) });
    pushUndo({ type: "replace", before, after: cloneStroke(t) });
    if (selection.ids.size) selectStrokeIds(Array.from(selection.ids));
    syncSelectionToolbar();
    syncModeBar();
    requestRedraw();
  }

  function topTextAt(world) {
    const list = Array.from(boardStrokes.values());
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s.tool !== "text") continue;
      const b = s.bbox || strokeWorldBBox(s);
      const pad = 6 / scale;
      if (b && world.x >= b.minX - pad && world.x <= b.maxX + pad && world.y >= b.minY - pad && world.y <= b.maxY + pad) return s;
    }
    return null;
  }
  function topTableAt(world) {
    const list = Array.from(boardStrokes.values());
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s.tool === "table" && cellAt(s, world)) return s;
    }
    return null;
  }

  // Tippen: bestehendes Textfeld bearbeiten, Tabellenzelle bearbeiten oder neues Feld.
  // Ziehen: neues Feld mit dieser Breite (Text bricht dann automatisch um).
  function finishTextDrag(drag) {
    const a = drag.startWorld;
    const b = drag.cur || a;
    const dragged = Math.hypot(b.x - a.x, b.y - a.y) * scale > 24;
    if (!dragged) {
      const text = topTextAt(a);
      if (text) return openTextEditorFor(text);
      const table = topTableAt(a);
      if (table) return openCellEditor(table, cellAt(table, a));
    }
    clearSelection();
    const size = textSize / Math.max(scale, 0.25);
    const x = dragged ? Math.min(a.x, b.x) : a.x;
    const top = dragged ? Math.min(a.y, b.y) : a.y - size * 0.6;
    textEdit = {
      kind: "text",
      strokeId: null,
      x,
      y: top + size * 0.95,
      size,
      color: currentColor,
      width: dragged ? Math.abs(b.x - a.x) : null,
      before: null,
    };
    showTextEditor("");
    // voreingestellte Formate (Text-Leiste ohne offenes Feld) direkt am Cursor setzen
    for (const [cmd, f] of Object.entries(FMT)) if (textDefaults[f.flag]) toggleAtCaret(cmd);
    syncFormatBar();
  }

  function openTextEditorFor(s) {
    clearSelection();
    const a = s.points[0];
    const bold = !isBoxText(s); // aeltere KI-Texte: einzeilig fett -> beim Bearbeiten zum normalen Textfeld
    textEdit = {
      kind: "text",
      strokeId: s.id,
      x: a.x,
      y: a.y,
      size: s.size,
      color: s.color,
      width: (s.extra && s.extra.width) || null,
      before: cloneStroke(s),
      fromLabel: bold,
    };
    showTextEditor(a.text || "", strokeRuns(s));
    requestRedraw();
  }

  function openCellEditor(t, cell) {
    if (!cell) return;
    lastTableId = t.id;
    clearSelection();
    textEdit = { kind: "cell", tableId: t.id, r: cell.r, c: cell.c, before: cloneStroke(t), size: t.size, color: "#1E1F22" };
    const text = ((t.extra && t.extra.cells) || {})[cell.r + "," + cell.c] || "";
    showTextEditor(text);
    requestRedraw();
  }

  function escapeHtml(t) {
    return String(t).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }
  function runsToHtml(runs) {
    let html = "";
    for (const r of runs) {
      let inner = escapeHtml(r.t).replace(/\n/g, "<br>");
      if (r.u) inner = "<u>" + inner + "</u>";
      if (r.s) inner = "<s>" + inner + "</s>";
      if (r.i) inner = "<i>" + inner + "</i>";
      if (r.b) inner = "<b>" + inner + "</b>";
      html += inner;
    }
    // ein abschliessender Zeilenumbruch braucht im Editor ein zweites <br>, sonst ist er unsichtbar
    if (/\n$/.test(runsText(runs))) html += "<br>";
    return html;
  }

  // Liest den Editor-Inhalt als Runs: Stil aus den umgebenden Tags/Styles, Zeilen aus
  // <br> und Block-Elementen (Chrome/Safari legen pro Zeile ein <div> an).
  function serializeEditor(trim = true) {
    const root = textEditorEl;
    const runs = [];
    const styleOf = (node) => {
      const st = { b: 0, i: 0, s: 0, u: 0 };
      for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
        const tag = el.tagName;
        const cs = getComputedStyle(el);
        if (tag === "B" || tag === "STRONG" || Number(cs.fontWeight) >= 600) st.b = 1;
        if (tag === "I" || tag === "EM" || cs.fontStyle === "italic" || cs.fontStyle === "oblique") st.i = 1;
        const deco = cs.textDecorationLine || cs.textDecoration || "";
        if (tag === "S" || tag === "STRIKE" || tag === "DEL" || deco.includes("line-through")) st.s = 1;
        if (tag === "U" || deco.includes("underline")) st.u = 1;
        if (el === root) break;
      }
      // die Grundschrift des Editors selbst ist nicht "fett"
      return st;
    };
    let any = false;
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          if (child.nodeValue) {
            runs.push({ t: child.nodeValue.replace(/\u00a0/g, " ").replace(/\u200B/g, ""), ...styleOf(child) });
            any = true;
          }
        } else if (child.nodeName === "BR") {
          // <div><br></div> ist nur der Platzhalter einer leeren Zeile (die zaehlt schon
          // ueber den Block) - ein <br> allein in <u>/<b> & Co. ist dagegen ein echter Umbruch
          const parent = child.parentNode;
          const placeholder = parent !== root && /^(DIV|P)$/.test(parent.nodeName) && parent.childNodes.length === 1;
          if (!placeholder) runs.push({ t: "\n" });
        } else if (child.nodeType === 1) {
          const block = /^(DIV|P)$/.test(child.nodeName);
          if (block && any) runs.push({ t: "\n" });
          walk(child);
          if (block) any = true;
        }
      }
    };
    walk(root);
    const out = normalizeRuns(runs);
    if (!trim) return out;
    // trailing Leerraum/Umbrueche weg
    while (out.length) {
      const last = out[out.length - 1];
      last.t = last.t.replace(/\s+$/, "");
      if (last.t) break;
      out.pop();
    }
    return out;
  }

  function editorPlainText() {
    return runsText(serializeEditor());
  }

  function showTextEditor(value, runs) {
    const rich = runs && runs.length ? normalizeRuns(runs) : [{ t: value || "" }];
    textEditorEl.innerHTML = runsToHtml(rich);
    textEditorEl.classList.remove("hidden");
    textFormatBar.classList.toggle("hidden", !textEdit || textEdit.kind !== "text");
    positionTextEditor();
    textEditorEl.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(textEditorEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    editorRange = range.cloneRange();
    syncFormatBar();
  }

  function applyTextEditStyle(patch) {
    if (!textEdit) return;
    if (patch.color && textEdit.kind === "text") textEdit.color = patch.color;
    if (patch.size && textEdit.kind === "text") {
      const old = textEdit.size;
      textEdit.size = patch.size / Math.max(scale, 0.25);
      textEdit.y += (textEdit.size - old) * 0.95;
    }
    positionTextEditor();
  }

  function positionTextEditor() {
    if (!textEdit || !textEditorEl || textEditorEl.classList.contains("hidden")) return;
    let left;
    let top;
    let width;
    let minH;
    let size;
    let color;
    if (textEdit.kind === "cell") {
      const t = boardStrokes.get(textEdit.tableId);
      if (!t) return cancelTextEditor();
      const g = tableGeom(t);
      const pad = cellPad(t);
      const p = worldToScreen(g.xs[textEdit.c] + pad, g.ys[textEdit.r] + pad);
      left = p.x;
      top = p.y;
      width = (g.xs[textEdit.c + 1] - g.xs[textEdit.c] - pad * 2) * scale;
      minH = (g.ys[textEdit.r + 1] - g.ys[textEdit.r] - pad * 2) * scale;
      size = t.size * scale;
      color = "#1E1F22";
    } else {
      const p = worldToScreen(textEdit.x, textEdit.y - textEdit.size * 0.95);
      left = p.x;
      top = p.y;
      size = textEdit.size * scale;
      color = textEdit.color;
      if (textEdit.width) width = textEdit.width * scale;
      else {
        measureCtx.font = textFont(size);
        const lay = layoutRuns(serializeEditor(), size, null);
        width = Math.max(...lay.widths, size * 3) + size;
      }
      minH = size * TEXT_LINE;
    }
    const st = textEditorEl.style;
    st.left = left + "px";
    st.top = top + "px";
    st.width = Math.max(24, width) + "px";
    st.fontSize = size + "px";
    st.lineHeight = TEXT_LINE;
    st.color = color;
    st.height = "auto";
    st.height = Math.max(minH, textEditorEl.scrollHeight) + "px";
    syncTextHandles(left, top, Math.max(24, width), textEditorEl.offsetHeight);
    if (!textFormatBar.classList.contains("hidden")) {
      const bw = textFormatBar.offsetWidth || 260;
      const bh = textFormatBar.offsetHeight || 44;
      let bx = Math.max(8, Math.min(window.innerWidth - bw - 8, left));
      let by = top - bh - 14;
      if (by < 8) by = top + textEditorEl.offsetHeight + 14;
      textFormatBar.style.left = bx + "px";
      textFormatBar.style.top = by + "px";
    }
  }

  // Griffe links/rechts am offenen Textfeld: Breite ziehen, der Text bricht dann um
  const teHandleL = document.getElementById("te-handle-l");
  const teHandleR = document.getElementById("te-handle-r");
  let teHandleDrag = null;
  function syncTextHandles(left, top, width, height) {
    const show = !!(textEdit && textEdit.kind === "text") && left != null;
    for (const h of [teHandleL, teHandleR]) if (h) h.classList.toggle("hidden", !show);
    if (!show) return;
    const cy = top + height / 2;
    teHandleL.style.left = left - 6 + "px";
    teHandleL.style.top = cy + "px";
    teHandleR.style.left = left + width + 6 + "px";
    teHandleR.style.top = cy + "px";
  }
  for (const [h, side] of [
    [teHandleL, "l"],
    [teHandleR, "r"],
  ]) {
    if (!h) continue;
    // Fokus im Textfeld lassen (sonst schliesst die Tastatur)
    h.addEventListener("mousedown", (e) => e.preventDefault());
    h.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    h.addEventListener("pointerdown", (e) => {
      if (!textEdit || textEdit.kind !== "text") return;
      e.preventDefault();
      e.stopPropagation();
      try {
        h.setPointerCapture(e.pointerId);
      } catch (err) {}
      const r = textEditorEl.getBoundingClientRect();
      teHandleDrag = { id: e.pointerId, side, left: r.left, right: r.right, x0: textEdit.x };
    });
    h.addEventListener("pointermove", (e) => {
      const d = teHandleDrag;
      if (!d || d.id !== e.pointerId || !textEdit) return;
      const min = textEdit.size * scale * 2;
      if (d.side === "r") {
        textEdit.width = Math.max(min, e.clientX - d.left) / scale;
      } else {
        const newLeft = Math.min(e.clientX, d.right - min);
        textEdit.width = (d.right - newLeft) / scale;
        textEdit.x = d.x0 + (newLeft - d.left) / scale;
      }
      positionTextEditor();
    });
    const end = (e) => {
      if (teHandleDrag && teHandleDrag.id === e.pointerId) teHandleDrag = null;
      if (textEdit) textEditorEl.focus({ preventScroll: true });
    };
    h.addEventListener("pointerup", end);
    h.addEventListener("pointercancel", end);
  }

  function cancelTextEditor() {
    textEdit = null;
    syncTextHandles();
    textFormatBar.classList.add("hidden");
    textEditorEl.classList.add("hidden");
    textEditorEl.blur();
    requestRedraw();
  }

  function commitTextEditor() {
    if (!textEdit) return;
    const ed = textEdit;
    const runs = serializeEditor();
    const value = runsText(runs);
    textEdit = null;
    syncTextHandles();
    textFormatBar.classList.add("hidden");
    textEditorEl.classList.add("hidden");
    textEditorEl.blur();
    if (ed.kind === "cell") {
      const t = boardStrokes.get(ed.tableId);
      const value = runsText(runs);
      if (!t) return requestRedraw();
      const key = ed.r + "," + ed.c;
      const cells = Object.assign({}, (t.extra && t.extra.cells) || {});
      if ((cells[key] || "") === value) return requestRedraw();
      if (value) cells[key] = value;
      else delete cells[key];
      t.extra = Object.assign({}, t.extra, { cells });
      growTableRows(t);
      t.bbox = strokeWorldBBox(t);
      wsSend({ type: "stroke_move", stroke: serializeStroke(t) });
      pushUndo({ type: "replace", before: ed.before, after: cloneStroke(t) });
      return requestRedraw();
    }
    if (!value.trim()) {
      if (ed.before) {
        removeStrokes([ed.before.id]);
        pushUndo({ type: "replace", before: ed.before, after: null });
      }
      return requestRedraw();
    }
    const plainRuns = runs.every((r) => !r.b && !r.i && !r.s && !r.u);
    const beforeRuns = ed.before ? JSON.stringify(normalizeRuns(strokeRuns(ed.before))) : null;
    const unchanged =
      ed.before &&
      !ed.fromLabel &&
      JSON.stringify(runs) === beforeRuns &&
      ed.before.size === ed.size &&
      ed.before.color === ed.color &&
      ((ed.before.extra && ed.before.extra.width) || null) === (ed.width || null) &&
      ed.before.points[0].x === ed.x;
    if (unchanged) return requestRedraw();
    const extra = Object.assign({}, (ed.before && ed.before.extra) || {}, { box: true, width: ed.width || null });
    if (plainRuns) delete extra.runs;
    else extra.runs = runs;
    const stroke = {
      id: ed.strokeId || uuid(),
      tool: "text",
      color: ed.color,
      size: ed.size,
      points: boxTextPoints(ed.x, ed.y, value, ed.size, ed.width, runs),
      extra,
    };
    putStroke(stroke);
    pushUndo({ type: "replace", before: ed.before, after: cloneStroke(stroke) });
    requestRedraw();
  }

  const textFormatBar = document.getElementById("text-format-bar");

  // ---- Formatieren ohne "schwebenden" Browser-Zustand -----------------------
  // execCommand merkt sich Fett & Co. fuer die naechsten Buchstaben nur als Typing-Style;
  // den verwirft Safari auf dem iPad, sobald Wortvorschlaege/Autokorrektur eingreifen.
  // Darum setzen wir bei Cursor ohne Markierung ein echtes Element (mit unsichtbarem
  // Platzhalter \u200B) ein bzw. teilen es auf - das ueberlebt jede Tastatur.
  const FMT = {
    bold: { flag: "b", tag: "B", tags: ["B", "STRONG"] },
    italic: { flag: "i", tag: "I", tags: ["I", "EM"] },
    strikeThrough: { flag: "s", tag: "S", tags: ["S", "STRIKE", "DEL"] },
    underline: { flag: "u", tag: "U", tags: ["U"] },
  };
  const ZWSP = "\u200B";

  // Welche Formate setzt genau dieses Element (Tag oder Inline-Style)?
  function elementFlags(el) {
    const out = {};
    const st = el.style || {};
    for (const [cmd, f] of Object.entries(FMT)) {
      if (f.tags.includes(el.tagName)) out[cmd] = true;
    }
    if (st.fontWeight && (st.fontWeight === "bold" || Number(st.fontWeight) >= 600)) out.bold = true;
    if (st.fontStyle === "italic" || st.fontStyle === "oblique") out.italic = true;
    const deco = (st.textDecorationLine || st.textDecoration || "") + "";
    if (deco.includes("line-through")) out.strikeThrough = true;
    if (deco.includes("underline")) out.underline = true;
    return out;
  }

  function formatAt(node) {
    const state = {};
    for (let el = node && (node.nodeType === 1 ? node : node.parentElement); el && el !== textEditorEl; el = el.parentElement) {
      Object.assign(state, elementFlags(el));
    }
    return state;
  }

  function placeCaret(textNode, offset) {
    const r = document.createRange();
    r.setStart(textNode, offset);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    editorRange = r.cloneRange();
  }

  function toggleAtCaret(cmd) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!textEditorEl.contains(range.startContainer)) return;
    const on = !!formatAt(range.startContainer)[cmd];
    const holder = document.createTextNode(ZWSP);
    if (!on) {
      const wrap = document.createElement(FMT[cmd].tag);
      wrap.appendChild(holder);
      range.insertNode(wrap);
    } else {
      // aeusserstes Element finden, das dieses Format setzt, und am Cursor aufteilen
      let outer = null;
      const between = [];
      for (let el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement; el && el !== textEditorEl; el = el.parentElement) {
        if (elementFlags(el)[cmd]) outer = el;
      }
      if (!outer) return;
      for (let el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement; el && el !== outer; el = el.parentElement) {
        between.push(el);
      }
      const tail = document.createRange();
      tail.setStart(range.startContainer, range.startOffset);
      tail.setEndAfter(outer.lastChild || outer);
      const rest = tail.extractContents();
      // andere Formate innerhalb des aufgeteilten Elements beibehalten
      let inner = holder;
      for (const el of between) {
        const flags = elementFlags(el);
        if (flags[cmd] && Object.keys(flags).length === 1) continue;
        const clone = el.cloneNode(false);
        if (clone.style) {
          if (cmd === "bold") clone.style.fontWeight = "";
          if (cmd === "italic") clone.style.fontStyle = "";
        }
        clone.appendChild(inner);
        inner = clone;
      }
      const after = outer.nextSibling;
      outer.parentNode.insertBefore(inner, after);
      // den Rest (falls nicht leer) wieder im alten Format dahinter
      if (rest.textContent.replace(new RegExp(ZWSP, "g"), "")) {
        const restWrap = outer.cloneNode(false);
        restWrap.appendChild(rest);
        outer.parentNode.insertBefore(restWrap, inner.nextSibling);
      }
    }
    placeCaret(holder, 1);
  }

  // Zeichen-Position eines DOM-Punkts im Editor - zaehlt genau wie serializeEditor
  // (Text ohne \u200B, <br> = 1, neuer Block = 1).
  function editorOffsetOf(targetNode, targetOffset) {
    const root = textEditorEl;
    let count = 0;
    let any = false;
    let found = null;
    const walk = (node) => {
      for (let idx = 0; idx <= node.childNodes.length; idx++) {
        if (found !== null) return;
        if (node === targetNode && idx === targetOffset) {
          found = count;
          return;
        }
        const child = node.childNodes[idx];
        if (!child) return;
        if (child.nodeType === 3) {
          const v = child.nodeValue || "";
          if (child === targetNode) {
            found = count + v.slice(0, targetOffset).replace(/\u200B/g, "").length;
            return;
          }
          if (v) {
            count += v.replace(/\u200B/g, "").length;
            any = true;
          }
        } else if (child.nodeName === "BR") {
          const parent = child.parentNode;
          if (!(parent !== root && /^(DIV|P)$/.test(parent.nodeName) && parent.childNodes.length === 1)) count += 1;
        } else if (child.nodeType === 1) {
          const block = /^(DIV|P)$/.test(child.nodeName);
          if (block && any) count += 1;
          walk(child);
          if (block) any = true;
        }
      }
    };
    walk(root);
    return found === null ? count : found;
  }

  // DOM-Punkt zu einer Zeichen-Position im (von runsToHtml erzeugten) Editor-Inhalt
  function editorPointAt(off) {
    const root = textEditorEl;
    let count = 0;
    let result = null;
    const walk = (node) => {
      for (let idx = 0; idx < node.childNodes.length && !result; idx++) {
        const child = node.childNodes[idx];
        if (child.nodeType === 3) {
          const len = child.nodeValue.length;
          if (off <= count + len) result = { node: child, offset: off - count };
          count += len;
        } else if (child.nodeName === "BR") {
          if (off === count) result = { node, offset: idx };
          count += 1;
        } else if (child.nodeType === 1) {
          walk(child);
        }
      }
    };
    walk(root);
    return result || { node: root, offset: root.childNodes.length };
  }

  // Format fuer einen markierten Bereich selbst umschalten (statt execCommand): alle
  // markierten Zeichen haben es schon -> aus, sonst -> an. Markierung bleibt danach stehen.
  function toggleRange(cmd, range) {
    const a = editorOffsetOf(range.startContainer, range.startOffset);
    const b = editorOffsetOf(range.endContainer, range.endOffset);
    if (b <= a) return false;
    const flag = FMT[cmd].flag;
    const pieces = [];
    let pos = 0;
    for (const r of serializeEditor(false)) {
      const end = pos + r.t.length;
      const cuts = [pos, Math.max(pos, Math.min(end, a)), Math.max(pos, Math.min(end, b)), end];
      for (let k = 0; k < 3; k++) {
        const s0 = cuts[k];
        const s1 = cuts[k + 1];
        if (s1 > s0) pieces.push({ ...r, t: r.t.slice(s0 - pos, s1 - pos), sel: s0 >= a && s1 <= b });
      }
      pos = end;
    }
    const chosen = pieces.filter((p) => p.sel && p.t.trim());
    if (!chosen.length) return false;
    const allOn = chosen.every((p) => p[flag]);
    for (const p of pieces) {
      if (p.sel) {
        if (allOn) delete p[flag];
        else p[flag] = 1;
      }
      delete p.sel;
    }
    textEditorEl.innerHTML = runsToHtml(normalizeRuns(pieces));
    const start = editorPointAt(a);
    const stop = editorPointAt(b);
    const r = document.createRange();
    r.setStart(start.node, start.offset);
    r.setEnd(stop.node, stop.offset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    editorRange = r.cloneRange();
    return true;
  }

  let pressRange = null; // Markierung im Moment, in dem ein Format-Knopf beruehrt wurde
  let lastExpandedRange = null; // letzte echte Markierung (iPad hebt sie beim Tippen auf den Knopf auf)
  let lastExpandedAt = 0;

  function capturePressRange() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && textEditorEl.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      if (!r.collapsed || !pressRange) pressRange = r.cloneRange();
    }
  }

  // Sobald in einem Platzhalter-Knoten echter Text steht, wird \u200B entfernt (sonst waere
  // es ein unsichtbarer Extra-Schritt beim Cursor-Bewegen/Markieren). Cursor bleibt stehen.
  function cleanupPlaceholders() {
    const sel = window.getSelection();
    const caret = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const walker = document.createTreeWalker(textEditorEl, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const v = node.nodeValue;
      if (!v.includes(ZWSP) || v.replace(/\u200B/g, "") === "") continue;
      let caretOffset = null;
      if (caret && caret.collapsed && caret.startContainer === node) {
        caretOffset = v.slice(0, caret.startOffset).replace(/\u200B/g, "").length;
      }
      node.nodeValue = v.replace(/\u200B/g, "");
      if (caretOffset !== null) placeCaret(node, caretOffset);
    }
  }

  function applyFormat(cmd) {
    let range = pressRange && !pressRange.collapsed ? pressRange : null;
    if (!range && lastExpandedRange && performance.now() - lastExpandedAt < 1500) {
      const sel = window.getSelection();
      const cur = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!cur || cur.collapsed) range = lastExpandedRange;
    }
    if (!range) {
      const sel = window.getSelection();
      const cur = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (cur && !cur.collapsed && textEditorEl.contains(cur.startContainer)) range = cur;
    }
    pressRange = null;
    if (range && textEditorEl.contains(range.startContainer) && toggleRange(cmd, range)) {
      lastExpandedRange = null;
      return;
    }
    restoreEditorRange();
    toggleAtCaret(cmd);
    rememberEditorRange();
  }

  function syncFormatBar() {
    const sel = window.getSelection();
    const node = textEdit && sel && sel.rangeCount && textEditorEl.contains(sel.anchorNode) ? sel.anchorNode : null;
    const state = node ? formatAt(node) : {};
    if (textFormatBar && !textFormatBar.classList.contains("hidden")) {
      textFormatBar.querySelectorAll("[data-cmd]").forEach((b) => b.classList.toggle("active", !!state[b.dataset.cmd]));
    }
    syncModeBar();
  }

  let editorRange = null; // letzte Cursor-Position/Markierung im Editor
  function rememberEditorRange() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && textEditorEl.contains(sel.anchorNode)) editorRange = sel.getRangeAt(0).cloneRange();
  }
  function restoreEditorRange() {
    // Hat der Editor den Fokus noch, ist seine aktuelle Markierung die richtige
    if (document.activeElement === textEditorEl) return;
    textEditorEl.focus({ preventScroll: true });
    if (!editorRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(editorRange);
  }

  if (textFormatBar) {
    const runFormatButton = (b) => {
      if (!textEdit) {
        // kein offenes Textfeld: ausgewaehlte Textfelder ganz umschalten, sonst gilt es
        // als Voreinstellung fuer das naechste neue Textfeld
        if (b.dataset.cmd) {
          const flag = FMT[b.dataset.cmd].flag;
          if (selectedTextBoxes().length) toggleTextFlag(flag);
          else textDefaults[flag] = !textDefaults[flag];
          syncModeBar();
        }
        return;
      }
      if (b.dataset.cmd) {
        applyFormat(b.dataset.cmd);
      } else if (b.dataset.size) {
        const cfg = toolConfigs.text;
        const cur = textEdit.size * scale;
        const next = Math.max(cfg.min, Math.min(cfg.max, Math.round(cur * (b.dataset.size === "up" ? 1.2 : 1 / 1.2))));
        textSize = next;
        applyTextEditStyle({ size: next });
      }
      positionTextEditor();
      syncFormatBar();
    };
    const formatButtons = [
      ...textFormatBar.querySelectorAll("button"),
      ...toolbarEl.querySelectorAll(".fmt-btn"),
    ];
    formatButtons.forEach((b) => {
      // Fokus und Markierung muessen im Textfeld bleiben -> Standardaktion beim Druecken
      // verhindern. Auf dem iPad unterdrueckt das aber den "click" - darum loesen die Knoepfe
      // selbst beim Loslassen aus (Finger, Stift, Maus), "click" nur noch fuer Tastatur.
      let pressedId = null;
      b.addEventListener("pointerdown", (e) => {
        capturePressRange();
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        pressedId = e.pointerId;
      });
      b.addEventListener("pointerup", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pressedId !== e.pointerId) return;
        pressedId = null;
        runFormatButton(b);
      });
      b.addEventListener("pointercancel", () => {
        pressedId = null;
      });
      for (const type of ["mousedown", "touchstart"]) {
        b.addEventListener(
          type,
          (e) => {
            capturePressRange();
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
          },
          { passive: false }
        );
      }
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // echte Zeiger-Klicks wurden schon bei pointerup erledigt; detail === 0 = Tastatur
        if (e.detail === 0) runFormatButton(b);
      });
    });
    document.addEventListener("selectionchange", () => {
      if (!textEdit) return;
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed && textEditorEl.contains(sel.anchorNode)) {
        lastExpandedRange = sel.getRangeAt(0).cloneRange();
        lastExpandedAt = performance.now();
      }
      rememberEditorRange();
      syncFormatBar();
    });
  }

  if (textEditorEl) {
    textEditorEl.addEventListener("input", positionTextEditor);
    // Einfuegen nur als reiner Text - fremdes HTML (Farben, Schriften) bleibt draussen
    textEditorEl.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
      document.execCommand("insertText", false, text);
    });
    textEditorEl.addEventListener("keydown", (e) => {
      e.stopPropagation(); // Strg+Z, Entf usw. gehoeren hier dem Text, nicht dem Blatt
      if (e.key === "Escape") {
        e.preventDefault();
        commitTextEditor();
        return;
      }
      // Strg/Cmd+B/I/U wie gewohnt; Tabellenzellen bleiben unformatiert
      const meta = e.ctrlKey || e.metaKey;
      if (meta && textEdit && textEdit.kind === "cell" && /^[biu]$/i.test(e.key)) e.preventDefault();
      if (meta && textEdit && textEdit.kind === "text" && /^[biu]$/i.test(e.key)) {
        e.preventDefault();
        applyFormat({ b: "bold", i: "italic", u: "underline" }[e.key.toLowerCase()]);
        syncFormatBar();
      }
    });
    textEditorEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      lastExpandedRange = null; // bewusst neu in den Text getippt
    });
    textEditorEl.addEventListener("input", () => {
      lastExpandedRange = null;
      cleanupPlaceholders();
    });
  }

  function drawTextDragPreview() {
    if (!textDrag || !textDrag.cur) return;
    const a = textDrag.startWorld;
    const b = textDrag.cur;
    if (Math.hypot(b.x - a.x, b.y - a.y) * scale <= 24) return;
    ctx.save();
    ctx.setLineDash([6 / scale, 5 / scale]);
    ctx.strokeStyle = "#1A73E8";
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.max(Math.abs(b.y - a.y), (textSize * TEXT_LINE) / scale));
    ctx.restore();
  }

  const insertTableBtn = document.getElementById("btn-insert-table");
  if (insertTableBtn) insertTableBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openTableDialog(null);
  });
  document.getElementById("btn-tbl-edit")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const t = selectedTable();
    if (t) openTableDialog(t);
  });

  // ---- Zoom-Fenster (wie GoodNotes) ----------------------------------------
  // Ein Rahmen auf dem Blatt wird unten gross dargestellt. Man schreibt in der grossen
  // Flaeche, die Tinte landet klein im Rahmen. Wer weit genug rechts schreibt, bekommt links
  // einen blauen Kasten mit der Fortsetzung; dort ansetzen springt ohne Versatz weiter
  // (am rechten Rand in die naechste Zeile).
  const zoomPaneEl = document.getElementById("zoom-pane");
  const zoomCanvas = document.getElementById("zoom-canvas");
  const zctx = zoomCanvas ? zoomCanvas.getContext("2d") : null;
  const zoomWinBtn = document.getElementById("btn-zoom-window");
  const zoomBoxEl = document.getElementById("zoom-box");
  // GoodNotes-Verhalten: Hat man weit genug rechts geschrieben, erscheint links in der
  // Schreibflaeche ein blauer Kasten mit einer Vorschau der Fortsetzung (Ende des letzten
  // Worts). Setzt man dort an, springt der Rahmen in demselben Moment hin - massstabsgleich,
  // also ohne Versatz. Kein automatisches Weiterruecken beim Absetzen.
  const ZOOM_PREVIEW_W = 0.28; // Breite des blauen Kastens (Anteil der Schreibflaeche)
  const ZOOM_OFFER_FROM = 0.55; // ab hier rechts geschrieben -> Fortsetzung anbieten
  const ZOOM_LEAD = 0.05; // so viel vom Wortende ist im Kasten noch zu sehen
  let zoomNext = null; // {x, y} Weltursprung des naechsten Ausschnitts
  let zoomHover = null; // {px, py} Stift-/Radierer-Position in der Schreibflaeche (Pixel)
  let zoomWin = null; // {x, y, w, left, right} in Weltkoordinaten
  let zoomPointer = null; // pointerId, der gerade im Zoom-Fenster schreibt/radiert
  let zoomAdvanceTimer = null;
  let zoomBoxDrag = null;

  function zoomPaneRect() {
    return zoomCanvas.getBoundingClientRect();
  }
  function zoomRatio() {
    const r = zoomPaneRect();
    return r.width / Math.max(1e-6, zoomWin.w);
  }
  function zoomBoxH() {
    const r = zoomPaneRect();
    return r.height / zoomRatio();
  }
  // Schreibhoehe in Kaestchen: das Fenster zeigt immer drei Zeilen dieser Hoehe, in der
  // mittleren wird geschrieben. Standard aus den Einstellungen, +/- gilt bis zum Schliessen.
  // Zeilenwechsel: um wie viele Kaestchen es runtergeht (0 = so hoch wie die Schreibhoehe)
  // Raster unter dem Zoom-Fenster: im Notizbuch die echten Kaestchen/Zeilen der Seite
  function zoomGrid() {
    if (!notebook || !zoomWin) return { unit: GRID_SIZE, base: 0 };
    const yc = zoomWin.y;
    const rects = pageRects(notebook);
    const r = rects.find((q) => yc >= q.y - PAGE_GAP && yc <= q.y + q.h) || rects[0];
    if (!r) return { unit: GRID_SIZE, base: 0 };
    if (r.page.paper === "lines" && !r.page.mediaId) return { unit: NB_LINE, base: r.y + NB_LINE_TOP };
    return { unit: NB_GRID, base: r.y };
  }
  function zoomLineStep() {
    return zoomStepDefault > 0 ? zoomStepDefault * zoomGrid().unit : zoomRowH();
  }
  function zoomRowH() {
    return (zoomWin && zoomWin.rows ? zoomWin.rows : zoomRowsDefault) * zoomGrid().unit;
  }
  function zoomFitRows() {
    if (!zoomWin) return;
    const r = zoomPaneRect();
    if (!r.width || !r.height) return;
    zoomWin.w = (3 * zoomRowH() * r.width) / r.height;
  }
  // Rahmen so legen, dass die mittlere Zeile auf einer Kaestchenlinie beginnt
  function snapZoomY(y) {
    const rh = zoomRowH();
    const g = zoomGrid();
    const unit = Number.isInteger(zoomWin.rows) && Number.isInteger(zoomStepDefault) ? g.unit : g.unit / 2;
    return g.base + Math.round((y + rh - g.base) / unit) * unit - rh;
  }
  function paneToWorld(clientX, clientY) {
    const r = zoomPaneRect();
    const k = zoomRatio();
    return { x: zoomWin.x + (clientX - r.left) / k, y: zoomWin.y + (clientY - r.top) / k };
  }

  // Lage der Schreibflaeche: Anteil (0 = ganz oben, 1 = ganz unten) im freien Bereich
  // zwischen den Leisten. Pro Geraet gemerkt; Standard unten wie in GoodNotes.
  let zoomPaneFrac = (() => {
    try {
      const v = parseFloat(localStorage.getItem("sofianotes-zoompane-pos"));
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    } catch (err) {
      return 1;
    }
  })();
  let zoomPaneDrag = null;

  function zoomPaneBounds(h) {
    const tb = toolbarEl.getBoundingClientRect();
    const dock = currentDock();
    const tbPos = topBarPos();
    const topBarRect = topBar ? topBar.getBoundingClientRect() : { bottom: 0, top: window.innerHeight };
    const undoRect = undoDock ? undoDock.getBoundingClientRect() : { bottom: 0 };
    let minTop = Math.max(tbPos === "top" ? topBarRect.bottom : 0, undoRect.top < window.innerHeight / 2 ? undoRect.bottom : 0) + 10;
    let maxBottom = window.innerHeight - 12;
    if (tbPos === "bottom") maxBottom = topBarRect.top - 10;
    if (dock === "bottom") maxBottom = Math.min(maxBottom, tb.top - 10);
    if (dock === "top") minTop = Math.max(minTop, tb.bottom + 10);
    return { minTop, maxTop: Math.max(minTop, maxBottom - h) };
  }

  function layoutZoomPane() {
    if (!zoomPaneEl) return;
    const h = Math.round(Math.max(170, Math.min(320, window.innerHeight * 0.3)));
    const { minTop, maxTop } = zoomPaneBounds(h);
    zoomPaneEl.style.bottom = "auto";
    zoomPaneEl.style.top = Math.round(minTop + (maxTop - minTop) * zoomPaneFrac) + "px";
    zoomPaneEl.style.height = h + "px";
    const r = zoomCanvas.getBoundingClientRect();
    const d = Math.max(1, window.devicePixelRatio || 1);
    const W = Math.round(r.width * d);
    const H = Math.round(r.height * d);
    if (zoomCanvas.width !== W || zoomCanvas.height !== H) {
      zoomCanvas.width = W;
      zoomCanvas.height = H;
    }
  }

  // Sichtbarer Teil des Hauptblatts: der groessere freie Bereich ober- oder unterhalb
  // der Schreibflaeche (je nachdem, wohin man sie geschoben hat)
  function visibleWorldArea() {
    if (!zoomPaneEl) return { a: screenToWorld(0, 70), b: screenToWorld(window.innerWidth, window.innerHeight) };
    const r = zoomPaneEl.getBoundingClientRect();
    const above = r.top - 70;
    const below = window.innerHeight - 80 - r.bottom;
    if (above >= below) return { a: screenToWorld(0, 70), b: screenToWorld(window.innerWidth, r.top - 10) };
    return { a: screenToWorld(0, r.bottom + 10), b: screenToWorld(window.innerWidth, window.innerHeight - 80) };
  }

  function openZoomWindow() {
    if (textEdit) commitTextEditor();
    if (currentTool !== "pen" && currentTool !== "marker" && currentTool !== "eraser") setTool("pen");
    zoomPaneEl.classList.remove("hidden");
    layoutZoomPane();
    const { a, b } = visibleWorldArea();
    const left = a.x + (b.x - a.x) * 0.08;
    const right = b.x - (b.x - a.x) * 0.08;
    zoomWin = { x: left, y: 0, w: 100, left, right, rows: zoomRowsDefault };
    zoomFitRows();
    zoomWin.y = snapZoomY(a.y + (b.y - a.y) * 0.18);
    // Notizbuch: Rahmen und Raender an der aktuellen A4-Seite ausrichten
    if (notebook && window.sofiaCurrentPage) zoomToPage(window.sofiaCurrentPage(), false);
    if (zoomWinBtn) zoomWinBtn.classList.add("active");
    requestRedraw();
  }
  // Zoom-Fenster auf eine Notizbuch-Seite setzen: Raender = Seitenraender (bzw. Randlinie),
  // Rahmen oben links in der ersten Zeile
  function zoomToPage(i, keepRow) {
    if (!zoomWin || !notebook) return;
    const r = pageRects(notebook)[i];
    if (!r) return;
    const lines = r.page.paper === "lines" && !r.page.mediaId;
    zoomWin.left = r.x + (lines ? NB_MARGIN + 4 : NB_GRID);
    zoomWin.right = r.x + r.w - NB_GRID;
    zoomFitRows();
    const top = r.y + (lines ? NB_LINE_TOP - zoomRowH() : NB_GRID);
    let y = top;
    if (keepRow) {
      // gleiche Zeile wie auf der alten Seite (relativ zum Seitenanfang)
      y = Math.max(top, Math.min(r.y + r.h - zoomRowH() * 3, r.y + keepRow));
    }
    zoomNext = null;
    zoomWin.x = zoomWin.left;
    zoomWin.y = snapZoomY(y);
    requestRedraw();
  }
  window.sofiaZoomToPage = zoomToPage;

  function closeZoomWindow() {
    clearTimeout(zoomAdvanceTimer);
    zoomAdvanceTimer = null;
    zoomAnim = null;
    zoomHover = null;
    zoomNext = null;
    zoomWin = null;
    zoomPointer = null;
    if (zoomPaneEl) zoomPaneEl.classList.add("hidden");
    if (zoomBoxEl) zoomBoxEl.classList.add("hidden");
    if (zoomWinBtn) zoomWinBtn.classList.remove("active");
    requestRedraw();
  }

  function keepZoomBoxVisible() {
    if (!zoomWin) return;
    const { a, b } = visibleWorldArea();
    const h = zoomBoxH();
    let dx = 0;
    let dy = 0;
    if (zoomWin.y + h > b.y) dy = b.y - (zoomWin.y + h) - h * 0.5;
    else if (zoomWin.y < a.y) dy = a.y - zoomWin.y + h * 0.5;
    if (zoomWin.x + zoomWin.w > b.x) dx = b.x - (zoomWin.x + zoomWin.w) - zoomWin.w * 0.2;
    else if (zoomWin.x < a.x) dx = a.x - zoomWin.x + zoomWin.w * 0.2;
    offsetX += dx * scale;
    offsetY += dy * scale;
  }

  // Kurzes Gleiten (~0,1 s) statt Sprung: fuehlt sich sofort an, man sieht aber wohin.
  // Setzt man waehrenddessen wieder an, springt der Rahmen sofort ans Ziel (finishZoomAnim).
  const ZOOM_ANIM_MS = 110;
  let zoomAnim = null; // {fromX, fromY, toX, toY, t0}

  function finishZoomAnim() {
    if (!zoomAnim || !zoomWin) {
      zoomAnim = null;
      return;
    }
    zoomWin.x = zoomAnim.toX;
    zoomWin.y = zoomAnim.toY;
    zoomAnim = null;
    keepZoomBoxVisible();
    requestRedraw();
  }

  function stepZoomAnim() {
    if (!zoomAnim || !zoomWin) return;
    const t = Math.min(1, (performance.now() - zoomAnim.t0) / ZOOM_ANIM_MS);
    const e = 1 - Math.pow(1 - t, 3);
    zoomWin.x = zoomAnim.fromX + (zoomAnim.toX - zoomAnim.fromX) * e;
    zoomWin.y = zoomAnim.fromY + (zoomAnim.toY - zoomAnim.fromY) * e;
    requestRedraw();
    if (t >= 1) finishZoomAnim();
    else requestAnimationFrame(stepZoomAnim);
  }

  function moveZoomBox(nx, ny, animate) {
    zoomNext = null;
    if (!animate) {
      zoomAnim = null;
      zoomWin.x = nx;
      zoomWin.y = ny;
      keepZoomBoxVisible();
      requestRedraw();
      return;
    }
    zoomAnim = { fromX: zoomWin.x, fromY: zoomWin.y, toX: nx, toY: ny, t0: performance.now() };
    requestAnimationFrame(stepZoomAnim);
  }

  function zoomNextLine(animate) {
    moveZoomBox(zoomWin.left, snapZoomY(zoomWin.y + zoomLineStep()), animate);
  }
  function zoomStep(dir) {
    const step = zoomWin.w * 0.6;
    let nx = zoomWin.x + dir * step;
    if (dir > 0 && nx + zoomWin.w > zoomWin.right + zoomWin.w * 0.25) return zoomNextLine();
    if (dir < 0 && nx < zoomWin.left) {
      if (zoomWin.x <= zoomWin.left + 1) {
        // am linken Rand: zurueck ans Ende der vorigen Zeile
        return moveZoomBox(Math.max(zoomWin.left, zoomWin.right - zoomWin.w), snapZoomY(zoomWin.y - zoomLineStep()));
      }
      nx = zoomWin.left;
    }
    moveZoomBox(nx, zoomWin.y);
  }

  // Nach einem Strich weit rechts: Fortsetzung vorbereiten (Kasten links). Kurze Striche
  // weiter links (i-Punkt, Korrektur) lassen ein vorhandenes Angebot stehen.
  function offerZoomContinuation(stroke) {
    if (!zoomWin || !stroke || !stroke.points || !stroke.points.length) return;
    const b = makeBBox(stroke.points);
    // an (oder ueber) der rechten Randlinie: wie am Zeilenende -> naechste Zeile links
    const atMargin = b.maxX >= zoomWin.right - zoomWin.w * 0.06 && b.minX < zoomWin.right + zoomWin.w * 0.1;
    if (atMargin) {
      zoomNext = { x: zoomWin.left, y: snapZoomY(zoomWin.y + zoomLineStep()) };
      requestRedraw();
      return;
    }
    if (b.maxX < zoomWin.x + zoomWin.w * ZOOM_OFFER_FROM) return;
    const nx = b.maxX - zoomWin.w * ZOOM_LEAD;
    // die Fortsetzung soll nicht ueber die Randlinie hinausragen
    if (nx > zoomWin.right - zoomWin.w * 0.15) zoomNext = { x: zoomWin.left, y: snapZoomY(zoomWin.y + zoomLineStep()) };
    else zoomNext = { x: Math.max(zoomWin.left, nx), y: zoomWin.y };
    requestRedraw();
  }

  function drawZoomBoxOnPage() {
    if (!zoomWin) {
      if (zoomBoxEl) zoomBoxEl.classList.add("hidden");
      return;
    }
    const h = zoomBoxH();
    ctx.save();
    ctx.fillStyle = "rgba(26,115,232,0.06)";
    ctx.fillRect(zoomWin.x, zoomWin.y, zoomWin.w, h);
    ctx.strokeStyle = "#1A73E8";
    ctx.lineWidth = 2 / scale;
    ctx.strokeRect(zoomWin.x, zoomWin.y, zoomWin.w, h);
    // Raender als kurze Markierungen in Zeilenhoehe
    ctx.strokeStyle = "rgba(26,115,232,0.55)";
    ctx.setLineDash([4 / scale, 4 / scale]);
    for (const mx of [zoomWin.left, zoomWin.right]) {
      ctx.beginPath();
      ctx.moveTo(mx, zoomWin.y - h * 0.5);
      ctx.lineTo(mx, zoomWin.y + h * 1.5);
      ctx.stroke();
    }
    ctx.restore();
    if (zoomBoxEl) {
      const tl = worldToScreen(zoomWin.x, zoomWin.y);
      const lm = worldToScreen(zoomWin.left, zoomWin.y + h / 2);
      const rm = worldToScreen(zoomWin.right, zoomWin.y + h / 2);
      zoomBoxEl.classList.remove("hidden");
      const grip = document.getElementById("zoom-grip");
      const lh = document.getElementById("zoom-margin-left");
      const rh = document.getElementById("zoom-margin-right");
      grip.style.left = tl.x + "px";
      grip.style.top = tl.y + "px";
      lh.style.left = lm.x + "px";
      lh.style.top = lm.y + "px";
      rh.style.left = rm.x + "px";
      rh.style.top = rm.y + "px";
    }
  }

  // Zeichnet den Welt-Ausschnitt ab (ox, oy) im Massstab k in die Schreibflaeche
  function renderZoomRegion(ox, oy, wWorld, hWorld, k, d) {
    zctx.setTransform(k * d, 0, 0, k * d, -ox * k * d, -oy * k * d);
    if (notebook) {
      // Notizbuch: die echte Seite (Hintergrund und Raster), daneben grau
      zctx.fillStyle = "#e8e6ed";
      zctx.fillRect(ox, oy, wWorld, hWorld);
      for (const r of pageRects(notebook)) {
        if (r.x > ox + wWorld || r.x + r.w < ox || r.y > oy + hWorld || r.y + r.h < oy) continue;
        zctx.save();
        zctx.beginPath();
        zctx.rect(r.x, r.y, r.w, r.h);
        zctx.clip();
        zctx.fillStyle = "#ffffff";
        zctx.fillRect(r.x, r.y, r.w, r.h);
        const img = r.page.mediaId ? ensureMedia(r.page.mediaId) : null;
        if (img && img.complete && img.naturalWidth) zctx.drawImage(img, r.x, r.y, r.w, r.h);
        else if (!r.page.mediaId) drawPagePattern(r.page.paper || "graph", r, zctx, k);
        zctx.restore();
      }
    } else drawGrid(zctx, { minX: ox, minY: oy, maxX: ox + wWorld, maxY: oy + hWorld }, k);
    const inView = (st) => {
      const b = st.bbox || strokeWorldBBox(st);
      return !b || (b.maxX >= ox && b.minX <= ox + wWorld && b.maxY >= oy && b.minY <= oy + hWorld);
    };
    const all = Array.from(boardStrokes.values()).filter(inView);
    for (const st of all) if (st.tool === "image" || st.tool === "table") drawStroke(st, zctx);
    for (const st of all) if (st.tool === "marker") drawStroke(st, zctx, { alpha: 0.38 });
    for (const st of remoteInProgress.values()) if (st.tool === "marker") drawStroke(st, zctx, { alpha: 0.38 });
    if (currentStroke && currentStroke.tool === "marker") drawStroke(currentStroke, zctx, { alpha: 0.38 });
    for (const st of all) if (st.tool !== "marker" && st.tool !== "image" && st.tool !== "table") drawStroke(st, zctx);
    for (const st of remoteInProgress.values()) if (st.tool !== "marker") drawStroke(st, zctx);
    if (currentStroke && currentStroke.tool && currentStroke.tool !== "marker") drawStroke(currentStroke, zctx);
  }

  function zoomPreviewWidthPx() {
    return zoomPaneRect().width * ZOOM_PREVIEW_W;
  }

  function drawZoomPane() {
    if (!zoomWin || !zctx) return;
    layoutZoomPane();
    zoomFitRows();
    const d = Math.max(1, window.devicePixelRatio || 1);
    const k = zoomRatio();
    const h = zoomBoxH();
    const r = zoomPaneRect();
    zctx.setTransform(1, 0, 0, 1, 0, 0);
    zctx.fillStyle = "#ffffff";
    zctx.fillRect(0, 0, zoomCanvas.width, zoomCanvas.height);
    renderZoomRegion(zoomWin.x, zoomWin.y, zoomWin.w, h, k, d);

    // Nachbarzeilen oben/unten leicht abgedunkelt: geschrieben wird in der Mitte
    zctx.setTransform(d, 0, 0, d, 0, 0);
    const rowPx = zoomRowH() * k;
    zctx.fillStyle = "rgba(60,64,67,0.05)";
    zctx.fillRect(0, 0, r.width, rowPx);
    zctx.fillRect(0, rowPx * 2, r.width, Math.max(0, r.height - rowPx * 2));

    // Raender (rot gestrichelt), falls im Bild
    zctx.setTransform(d, 0, 0, d, 0, 0);
    zctx.lineWidth = 1;
    zctx.setLineDash([5, 5]);
    for (const mx of [zoomWin.left, zoomWin.right]) {
      const px = (mx - zoomWin.x) * k;
      if (px < 0 || px > r.width) continue;
      zctx.strokeStyle = "rgba(234,67,53,0.45)";
      zctx.beginPath();
      zctx.moveTo(px, 0);
      zctx.lineTo(px, r.height);
      zctx.stroke();
    }
    zctx.setLineDash([]);

    // Fortsetzungs-Kasten links: zeigt den naechsten Ausschnitt im selben Massstab
    if (zoomNext) {
      const bw = zoomPreviewWidthPx();
      zctx.save();
      zctx.setTransform(d, 0, 0, d, 0, 0);
      zctx.beginPath();
      if (zctx.roundRect) zctx.roundRect(0, 0, bw, r.height, 12);
      else zctx.rect(0, 0, bw, r.height);
      zctx.clip();
      zctx.fillStyle = "#ffffff";
      zctx.fillRect(0, 0, bw, r.height);
      renderZoomRegion(zoomNext.x, zoomNext.y, bw / k, h, k, d);
      zctx.setTransform(d, 0, 0, d, 0, 0);
      zctx.fillStyle = "rgba(26,115,232,0.13)";
      zctx.fillRect(0, 0, bw, r.height);
      zctx.restore();
      zctx.setTransform(d, 0, 0, d, 0, 0);
      zctx.strokeStyle = "#1A73E8";
      zctx.lineWidth = 2;
      zctx.beginPath();
      if (zctx.roundRect) zctx.roundRect(1, 1, bw - 2, r.height - 2, 12);
      else zctx.rect(1, 1, bw - 2, r.height - 2);
      zctx.stroke();
    }

    // Punkt / Radierer-Kreis zuletzt, damit er auch ueber dem Kasten sichtbar ist
    if (zoomHover) {
      zctx.setTransform(d, 0, 0, d, 0, 0);
      zctx.beginPath();
      if (currentTool === "eraser") {
        zctx.arc(zoomHover.px, zoomHover.py, (eraserSize / 2) * k, 0, Math.PI * 2);
        zctx.fillStyle = "rgba(255,255,255,0.35)";
        zctx.fill();
        zctx.lineWidth = 1.5;
        zctx.strokeStyle = "rgba(0,0,0,0.55)";
        zctx.stroke();
      } else if (!(currentStroke && zoomPointer != null)) {
        zctx.arc(zoomHover.px, zoomHover.py, Math.max((activeSize() / 2) * k, 2.5), 0, Math.PI * 2);
        zctx.fillStyle = currentTool === "marker" ? hexToRgba(currentColor, 0.45) : hexToRgba(currentColor, 0.6);
        zctx.fill();
      }
    }
  }

  if (zoomCanvas) {
    zoomCanvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!zoomWin || zoomPointer != null) return;
      // Finger nur, wenn Finger-Zeichnen an ist (sonst Handballen)
      if (e.pointerType === "touch" && !fingerDrawEnabled) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      try {
        zoomCanvas.setPointerCapture(e.pointerId);
      } catch (err) {
        // egal - Schreiben geht trotzdem
      }
      clearTimeout(zoomAdvanceTimer);
      zoomAdvanceTimer = null;
      finishZoomAnim(); // Rahmen steht, bevor der neue Strich beginnt
      if (zoomNext) {
        const rr = zoomPaneRect();
        if (e.clientX - rr.left <= zoomPreviewWidthPx()) {
          // im Kasten angesetzt: sofort dorthin - gleicher Massstab, also kein Versatz
          zoomWin.x = zoomNext.x;
          zoomWin.y = zoomNext.y;
          zoomNext = null;
          keepZoomBoxVisible();
        }
      }
      if (textEdit) commitTextEditor();
      zoomPointer = e.pointerId;
      const w = paneToWorld(e.clientX, e.clientY);
      if (currentTool === "eraser") {
        erasedThisGesture.clear();
        erasedStrokesThisGesture.clear();
        currentStroke = { pointerId: e.pointerId, eraser: true, lastX: w.x, lastY: w.y };
        eraseSegment(w.x, w.y, w.x, w.y);
      } else {
        if (currentTool !== "pen" && currentTool !== "marker") setTool("pen");
        startStroke(e.pointerId, e.pointerType, w.x, w.y, pointerPressure(e));
      }
      requestRedraw();
    });
    zoomCanvas.addEventListener("pointermove", (e) => {
      // Punkt/Radierer-Kreis zeigt, wo Stift oder Maus gerade ist (auch beim Schweben)
      if (zoomWin && (e.pointerType !== "touch" || fingerDrawEnabled)) {
        const rr = zoomPaneRect();
        zoomHover = { px: e.clientX - rr.left, py: e.clientY - rr.top };
        requestRedraw();
      }
      if (zoomPointer !== e.pointerId || !currentStroke) return;
      for (const ev of coalescedEvents(e)) {
        const w = paneToWorld(ev.clientX, ev.clientY);
        if (currentStroke.eraser) {
          eraseSegment(currentStroke.lastX, currentStroke.lastY, w.x, w.y);
          currentStroke.lastX = w.x;
          currentStroke.lastY = w.y;
        } else extendStroke(w.x, w.y, pointerPressure(ev));
      }
      requestRedraw();
    });
    const endZoomPointer = (e) => {
      if (zoomPointer !== e.pointerId) return;
      zoomPointer = null;
      if (!currentStroke) return;
      if (currentStroke.eraser) {
        if (pendingErase.size > 0) {
          wsSend({ type: "erase", strokeIds: Array.from(pendingErase) });
          pendingErase.clear();
        }
        if (erasedStrokesThisGesture.size > 0) {
          pushUndo({ type: "erase", strokes: Array.from(erasedStrokesThisGesture.values()) });
          erasedStrokesThisGesture.clear();
        }
        currentStroke = null;
        requestRedraw();
        return;
      }
      if (e.type === "pointercancel") return abortStroke();
      const finished = currentStroke;
      endStroke();
      if (boardStrokes.has(finished.id)) offerZoomContinuation(finished);
    };
    zoomCanvas.addEventListener("pointerup", endZoomPointer);
    zoomCanvas.addEventListener("pointerleave", (e) => {
      if (zoomPointer === e.pointerId) return;
      zoomHover = null;
      requestRedraw();
    });
    zoomCanvas.addEventListener("pointercancel", endZoomPointer);
  }

  if (zoomPaneEl) {
    const act = (id, fn) => {
      const b = document.getElementById(id);
      if (b) b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (zoomWin) fn();
      });
    };
    act("btn-zw-back", () => zoomStep(-1));
    act("btn-zw-fwd", () => zoomStep(1));
    act("btn-zw-return", () => zoomNextLine());
    const setRows = (rows) => {
      zoomNext = null;
      const mid = zoomWin.y + zoomRowH();
      zoomWin.rows = Math.max(0.5, Math.min(4, rows));
      zoomFitRows();
      zoomWin.y = snapZoomY(mid - zoomRowH());
      requestRedraw();
    };
    act("btn-zw-in", () => setRows(zoomWin.rows - 0.5));
    act("btn-zw-out", () => setRows(zoomWin.rows + 0.5));
    act("btn-zw-close", closeZoomWindow);

    // Griff: Schreibflaeche nach oben/unten ziehen (Finger, Stift oder Maus)
    const grip = document.getElementById("btn-zw-move");
    if (grip) {
      grip.addEventListener("pointerdown", (e) => {
        if (!zoomWin) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          grip.setPointerCapture(e.pointerId);
        } catch (err) {
          // egal
        }
        const r = zoomPaneEl.getBoundingClientRect();
        zoomPaneDrag = { pointerId: e.pointerId, offset: e.clientY - r.top, h: r.height };
        zoomPaneEl.classList.add("moving");
      });
      grip.addEventListener("pointermove", (e) => {
        if (!zoomPaneDrag || zoomPaneDrag.pointerId !== e.pointerId) return;
        const { minTop, maxTop } = zoomPaneBounds(zoomPaneDrag.h);
        const top = Math.max(minTop, Math.min(maxTop, e.clientY - zoomPaneDrag.offset));
        zoomPaneFrac = maxTop > minTop ? (top - minTop) / (maxTop - minTop) : 1;
        requestRedraw();
      });
      const endDrag = (e) => {
        if (!zoomPaneDrag || zoomPaneDrag.pointerId !== e.pointerId) return;
        zoomPaneDrag = null;
        zoomPaneEl.classList.remove("moving");
        // nahe oben/unten/Mitte einrasten
        for (const snap of [0, 0.5, 1]) if (Math.abs(zoomPaneFrac - snap) < 0.08) zoomPaneFrac = snap;
        try {
          localStorage.setItem("sofianotes-zoompane-pos", String(zoomPaneFrac));
        } catch (err) {
          // privater Modus o.ae.
        }
        keepZoomBoxVisible();
        requestRedraw();
      };
      grip.addEventListener("pointerup", endDrag);
      grip.addEventListener("pointercancel", endDrag);
    }
  }
  if (zoomWinBtn) zoomWinBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (zoomWin) closeZoomWindow();
    else openZoomWindow();
  });

  // Rahmen und Raender auf dem Blatt verschieben (Stift, Maus oder Finger)
  for (const [id, kind] of [
    ["zoom-grip", "box"],
    ["zoom-margin-left", "left"],
    ["zoom-margin-right", "right"],
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("pointerdown", (e) => {
      if (!zoomWin) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {
        // ignorieren
      }
      zoomBoxDrag = { kind, pointerId: e.pointerId, start: screenToWorld(e.clientX, e.clientY), win: { ...zoomWin } };
      zoomNext = null;
    });
    el.addEventListener("pointermove", (e) => moveZoomBoxDrag(e));
    const end = (e) => {
      if (zoomBoxDrag && zoomBoxDrag.pointerId === e.pointerId) {
        if (zoomBoxDrag.kind === "box" && zoomWin) {
          zoomWin.y = snapZoomY(zoomWin.y);
          requestRedraw();
        }
        zoomBoxDrag = null;
      }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  function moveZoomBoxDrag(e) {
      if (!zoomBoxDrag || zoomBoxDrag.pointerId !== e.pointerId || !zoomWin) return;
      const kind = zoomBoxDrag.kind;
      const w = screenToWorld(e.clientX, e.clientY);
      const dx = w.x - zoomBoxDrag.start.x;
      const dy = w.y - zoomBoxDrag.start.y;
      const o = zoomBoxDrag.win;
      if (kind === "box") {
        zoomWin.x = o.x + dx;
        zoomWin.y = o.y + dy;
      } else if (kind === "left") {
        zoomWin.left = Math.min(o.left + dx, zoomWin.right - zoomWin.w * 0.5);
      } else {
        zoomWin.right = Math.max(o.right + dx, zoomWin.left + zoomWin.w * 0.5);
      }
      requestRedraw();
  }
  // Stift/Finger direkt im blauen Rahmen auf dem Blatt: Rahmen verschieben statt schreiben
  function zoomFrameHit(clientX, clientY) {
    if (!zoomWin) return false;
    const w = screenToWorld(clientX, clientY);
    return w.x >= zoomWin.x && w.x <= zoomWin.x + zoomWin.w && w.y >= zoomWin.y && w.y <= zoomWin.y + zoomBoxH();
  }
  function startCanvasZoomDrag(e) {
    zoomBoxDrag = { kind: "box", canvas: true, pointerId: e.pointerId, start: screenToWorld(e.clientX, e.clientY), win: { ...zoomWin } };
    zoomNext = null;
    finishZoomAnim();
    requestRedraw();
  }
  window.addEventListener("resize", () => {
    if (zoomWin) requestRedraw();
  });

  // ---- Lernende Formen-Erkennung (Rueckmeldungen an den Server) ---------------
  const shapeWatch = new Map(); // strokeId -> {kind: "snap"|"miss", shape, metrics, t, timer}
  const SNAP_KEPT_MS = 20000; // so lange muss eine Form ueberleben, um als "behalten" zu gelten
  const MISS_WINDOW_MS = 8000; // wird ein ungewollt ungeformter Strich so schnell entfernt -> verpasst
  let shapeStats = null;
  const shapeInfoEl = document.getElementById("shape-learn-info");

  function sendShapeFeedback(ev) {
    fetch("/api/shape-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(ev),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((st) => st && applyShapeState(st))
      .catch(() => {});
  }

  function applyShapeState(st) {
    if (!st) return;
    if (st.params) {
      for (const k of Object.keys(shapeParams)) {
        const v = Number(st.params[k]);
        if (Number.isFinite(v)) shapeParams[k] = v;
      }
    }
    if (st.stats) shapeStats = st.stats;
    renderShapeInfo();
  }

  function renderShapeInfo() {
    if (!shapeInfoEl) return;
    const sec = (ms) => (ms / 1000).toFixed(1).replace(".", ",") + " s";
    const st = shapeStats;
    let text = "Lernt mit allen Geräten mit. Haltezeit gerade " + sec(shapeParams.holdMs) + ".";
    if (st && st.snaps) {
      text =
        `Lernt mit allen Geräten mit: ${st.snaps} erkannt · ${st.kept} behalten · ${st.edited} bearbeitet · ` +
        `${st.undone} zurückgenommen${st.avgUndoMs ? " (Ø nach " + sec(st.avgUndoMs) + ")" : ""} · ${st.missed} verpasst. ` +
        `Haltezeit gerade ${sec(shapeParams.holdMs)}.`;
    }
    shapeInfoEl.textContent = text;
  }

  function metricPayload(m, onlyRelevant) {
    if (!m) return {};
    if (onlyRelevant) return m.closed ? { ellipse: m.ellipse } : { line: m.line };
    return { ellipse: m.ellipse, line: m.line };
  }

  function watchShapeSnap(id, shape, metrics) {
    unwatchShape(id);
    const w = { kind: "snap", shape, metrics, t: performance.now() };
    w.timer = setTimeout(() => {
      shapeWatch.delete(id);
      if (boardStrokes.has(id)) sendShapeFeedback({ event: "snap_kept", shape, ...metricPayload(metrics) });
    }, SNAP_KEPT_MS);
    shapeWatch.set(id, w);
  }

  // Nur form-aehnliche Striche beobachten, sonst zaehlt jede Korrektur von Handschrift.
  function watchShapeMiss(id, metrics) {
    if (!metrics) return;
    const shapeish = metrics.closed ? metrics.ellipse != null && metrics.ellipse < 0.3 : metrics.line != null && metrics.line < 1.3;
    if (!shapeish) return;
    unwatchShape(id);
    const w = { kind: "miss", metrics, t: performance.now() };
    w.timer = setTimeout(() => shapeWatch.delete(id), MISS_WINDOW_MS);
    shapeWatch.set(id, w);
  }

  function unwatchShape(id) {
    const w = shapeWatch.get(id);
    if (!w) return null;
    clearTimeout(w.timer);
    shapeWatch.delete(id);
    return w;
  }

  function noteShapeRemoved(id) {
    const w = unwatchShape(id);
    if (!w) return;
    const ms = Math.round(performance.now() - w.t);
    if (w.kind === "snap") sendShapeFeedback({ event: "snap_undone", shape: w.shape, ms, ...metricPayload(w.metrics) });
    else sendShapeFeedback({ event: "missed", ms, ...metricPayload(w.metrics, true) });
  }

  function noteShapeEdited(id) {
    const w = shapeWatch.get(id);
    if (!w || w.kind !== "snap") return;
    unwatchShape(id);
    sendShapeFeedback({ event: "snap_edited", shape: w.shape, ...metricPayload(w.metrics) });
  }

  fetch("/api/shape-params", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then(applyShapeState)
    .catch(() => renderShapeInfo());

  // ---- Lineal -----------------------------------------------------------------
  // Liegt im Bildschirm (wie in GoodNotes), nicht auf dem Papier. Ein Finger schiebt,
  // zwei Finger drehen; der Stift zieht an der naeheren Kante eine exakt gerade Linie.
  const RULER_HALF = 42; // halbe Linealbreite in Bildschirm-px
  const RULER_SNAP = 26; // so nah an der Kante (ausserhalb) rastet der Stift noch ein
  const TRI_HALF = 250; // Geodreieck: halbe Laenge der langen Kante (Bildschirm-px)
  const ruler = { visible: false, kind: "ruler", cx: window.innerWidth / 2, cy: window.innerHeight * 0.45, angle: 0 };
  let rulerGesture = null; // {start: Map(id->{x,y}), cx, cy, angle}
  let mouseRulerDrag = null;
  const rulerBtn = document.getElementById("btn-ruler");

  function rulerAxes() {
    return { u: { x: Math.cos(ruler.angle), y: Math.sin(ruler.angle) }, n: { x: -Math.sin(ruler.angle), y: Math.cos(ruler.angle) } };
  }
  function rulerLocal(x, y) {
    const { u, n } = rulerAxes();
    const dx = x - ruler.cx;
    const dy = y - ruler.cy;
    return { along: dx * u.x + dy * u.y, across: dx * n.x + dy * n.y };
  }
  // Kanten als Strecken im Bildschirm: {a, b, out} (out = nach aussen zeigende Normale).
  // Lineal: zwei sehr lange Kanten. Geodreieck: lange Kante + zwei Schenkel (rechtwinklig,
  // Spitze auf der Seite von n).
  function rulerShape() {
    const { u, n } = rulerAxes();
    const c = { x: ruler.cx, y: ruler.cy };
    const at = (along, across) => ({ x: c.x + u.x * along + n.x * across, y: c.y + u.y * along + n.y * across });
    if (ruler.kind === "triangle") {
      const A = at(-TRI_HALF, 0);
      const B = at(TRI_HALF, 0);
      const C = at(0, TRI_HALF);
      const s2 = Math.SQRT1_2;
      return {
        poly: [A, B, C],
        edges: [
          { a: A, b: B, out: { x: -n.x, y: -n.y } },
          { a: B, b: C, out: { x: (u.x + n.x) * s2, y: (u.y + n.y) * s2 } },
          { a: C, b: A, out: { x: (-u.x + n.x) * s2, y: (-u.y + n.y) * s2 } },
        ],
      };
    }
    const L = Math.hypot(window.innerWidth, window.innerHeight) * 1.2;
    return {
      poly: [at(-L, -RULER_HALF), at(L, -RULER_HALF), at(L, RULER_HALF), at(-L, RULER_HALF)],
      edges: [
        { a: at(-L, -RULER_HALF), b: at(L, -RULER_HALF), out: { x: -n.x, y: -n.y } },
        { a: at(-L, RULER_HALF), b: at(L, RULER_HALF), out: { x: n.x, y: n.y } },
      ],
    };
  }

  function rulerHit(x, y, extra = 6) {
    if (!ruler.visible) return false;
    const shape = rulerShape();
    const q = { x, y };
    if (pointInPolygon(q, shape.poly)) return true;
    return shape.edges.some((e) => distPointToSeg(q, e.a, e.b) <= extra);
  }

  // Kante, an der der Stift gerade zeichnen wuerde: innen nahe an einer Kante oder knapp
  // ausserhalb. Beim Lineal zaehlt das ganze Band (wie bisher).
  function rulerEdgesAt(x, y) {
    if (!ruler.visible) return [];
    const shape = rulerShape();
    const q = { x, y };
    const inside = pointInPolygon(q, shape.poly);
    const limit = inside ? (ruler.kind === "ruler" ? RULER_HALF + 1 : RULER_SNAP) : RULER_SNAP;
    return shape.edges
      .map((e) => ({ e, d: distPointToSeg(q, e.a, e.b) }))
      .filter((c) => c.d <= limit)
      .sort((a, b) => a.d - b.d)
      .map((c) => c.e);
  }
  function rulerEdgeAt(x, y) {
    return rulerEdgesAt(x, y)[0] || null;
  }
  // An einer Ecke des Geodreiecks liegen zwei Kanten nah: die Zugrichtung entscheidet.
  function resolveRulerEdge(stroke, x, y) {
    const c = stroke.rulerCands;
    if (!c) return;
    const mx = x - stroke.rulerStart.x;
    const my = y - stroke.rulerStart.y;
    const m = Math.hypot(mx, my);
    if (m < 10) return;
    stroke.rulerCands = null;
    let best = stroke.rulerEdge;
    let bestScore = -1;
    for (const e of c) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const score = Math.abs(dx * mx + dy * my) / ((Math.hypot(dx, dy) || 1) * m);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best === stroke.rulerEdge) return;
    stroke.rulerEdge = best;
    const q = rulerProject(stroke.rulerStart.x, stroke.rulerStart.y, best);
    const w = screenToWorld(q.x, q.y);
    const p0 = stroke.points[0];
    stroke.points = [{ x: w.x, y: w.y, p: p0 ? p0.p : 0.5 }];
    stroke.unsent = [];
  }

  function rulerProject(x, y, edge) {
    const dx = edge.b.x - edge.a.x;
    const dy = edge.b.y - edge.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const t = (x - edge.a.x) * ux + (y - edge.a.y) * uy;
    // Strichmitte knapp ausserhalb der Kante, damit die Linie am Lineal anliegt
    const half = ((currentStroke && currentStroke.size) || activeSize()) * scale * 0.5;
    return { x: edge.a.x + ux * t + edge.out.x * half, y: edge.a.y + uy * t + edge.out.y * half };
  }

  // Angezeigter/eingegebener Winkel: 0-179°, gegen den Uhrzeigersinn wie im Matheheft
  function rulerDegrees() {
    let deg = Math.round((-ruler.angle * 180) / Math.PI) % 180;
    if (deg < 0) deg += 180;
    return deg;
  }
  function setRulerDegrees(deg) {
    if (!Number.isFinite(deg)) return;
    ruler.angle = (-deg * Math.PI) / 180;
    requestRedraw();
    syncRulerBar();
  }

  function snapRulerAngle(a) {
    const deg = ((a * 180) / Math.PI) % 360;
    for (const t of [-180, -135, -90, -45, 0, 45, 90, 135, 180]) {
      if (Math.abs(deg - t) < 2) return (t * Math.PI) / 180;
    }
    return a;
  }

  function startRulerGesture() {
    const start = new Map();
    for (const [id, p] of touchPointers) start.set(id, { x: p.x, y: p.y });
    const first = rulerGesture && rulerGesture.tap;
    rulerGesture = { start, cx: ruler.cx, cy: ruler.cy, angle: ruler.angle, tap: first || null, moved: !!(rulerGesture && rulerGesture.moved) };
    if (!rulerGesture.tap && touchPointers.size === 1) {
      const [p] = touchPointers.values();
      rulerGesture.tap = { x: p.x, y: p.y, t: performance.now() };
    }
    if (touchPointers.size >= 2) rulerGesture.moved = true;
    pinchState = null;
    panState = null;
  }
  function updateRulerGesture() {
    const ids = Array.from(rulerGesture.start.keys()).filter((id) => touchPointers.has(id));
    if (!ids.length) return;
    const a0 = rulerGesture.start.get(ids[0]);
    const a1 = touchPointers.get(ids[0]);
    if (Math.hypot(a1.x - a0.x, a1.y - a0.y) > 8) rulerGesture.moved = true;
    if (ids.length >= 2) {
      const b0 = rulerGesture.start.get(ids[1]);
      const b1 = touchPointers.get(ids[1]);
      const ang0 = Math.atan2(b0.y - a0.y, b0.x - a0.x);
      const ang1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
      const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
      const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
      const d = ang1 - ang0;
      // Lineal um den Fingermittelpunkt drehen und mitschieben
      const rx = rulerGesture.cx - m0.x;
      const ry = rulerGesture.cy - m0.y;
      ruler.cx = m1.x + rx * Math.cos(d) - ry * Math.sin(d);
      ruler.cy = m1.y + rx * Math.sin(d) + ry * Math.cos(d);
      ruler.angle = snapRulerAngle(rulerGesture.angle + d);
      syncRulerBar();
    } else {
      ruler.cx = rulerGesture.cx + (a1.x - a0.x);
      ruler.cy = rulerGesture.cy + (a1.y - a0.y);
    }
    requestRedraw();
  }

  function drawRulerScale(ctx, from, to, edgeY, dirSign) {
    // cm/mm-Striche entlang einer Kante (lokale x-Achse), Striche zeigen nach dirSign
    const cm = 37.8 * scale; // 1 cm ~ 38 Welt-px (96 dpi)
    const mm = cm / 10;
    const showMm = mm >= 4;
    const step = showMm ? mm : cm / 2;
    const i0 = Math.ceil(from / step);
    const i1 = Math.floor(to / step);
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const isCm = showMm ? i % 10 === 0 : i % 2 === 0;
      const isHalf = showMm ? i % 5 === 0 : false;
      const h = isCm ? 14 : isHalf ? 9 : 5;
      ctx.moveTo(i * step, edgeY);
      ctx.lineTo(i * step, edgeY + dirSign * h);
    }
    ctx.stroke();
    for (let i = i0; i <= i1; i++) {
      const isCm = showMm ? i % 10 === 0 : i % 2 === 0;
      if (!isCm) continue;
      const label = Math.round(Math.abs(i * step) / cm);
      if (label !== 0) ctx.fillText(String(label), i * step, edgeY + dirSign * 25 + (dirSign > 0 ? 0 : 0));
    }
  }

  function drawRuler() {
    if (!ruler.visible) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, -viewLeft * dpr, 0);
    ctx.translate(ruler.cx, ruler.cy);
    ctx.rotate(ruler.angle);
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.strokeStyle = "rgba(60,64,67,0.55)";
    ctx.lineWidth = 1;
    ctx.font = "600 10px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const deg = rulerDegrees();
    if (ruler.kind === "triangle") {
      const H = TRI_HALF;
      ctx.beginPath();
      ctx.moveTo(-H, 0);
      ctx.lineTo(H, 0);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "rgba(60,64,67,0.7)";
      ctx.fillStyle = "rgba(60,64,67,0.85)";
      // cm-Skala auf der langen Kante, 0 in der Mitte (wie beim echten Geodreieck)
      drawRulerScale(ctx, -H + 8, H - 8, 0, 1);
      // Winkelmesser: Halbkreis um die Mitte der langen Kante
      const R = H * 0.62;
      ctx.beginPath();
      for (let a = 0; a <= 180; a++) {
        const th = (a * Math.PI) / 180;
        const len = a % 10 === 0 ? 12 : a % 5 === 0 ? 8 : 4;
        const cx = Math.cos(th);
        const cy = Math.sin(th);
        ctx.moveTo(cx * R, cy * R);
        ctx.lineTo(cx * (R - len), cy * (R - len));
      }
      ctx.stroke();
      ctx.font = "600 9px Inter, sans-serif";
      for (let a = 10; a < 180; a += 10) {
        const th = (a * Math.PI) / 180;
        ctx.fillText(String(a), Math.cos(th) * (R - 22), Math.sin(th) * (R - 22));
      }
      // Mittelmarke und Hilfslinie zur Spitze
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.moveTo(0, 0);
      ctx.lineTo(0, H * 0.25);
      ctx.stroke();
      ctx.font = "700 13px Inter, sans-serif";
      ctx.fillStyle = "#1a73e8";
      ctx.fillText(deg + "°", 0, H * 0.78);
    } else {
      const len = Math.hypot(window.innerWidth, window.innerHeight) * 1.2;
      ctx.fillRect(-len, -RULER_HALF, len * 2, RULER_HALF * 2);
      ctx.beginPath();
      ctx.moveTo(-len, -RULER_HALF);
      ctx.lineTo(len, -RULER_HALF);
      ctx.moveTo(-len, RULER_HALF);
      ctx.lineTo(len, RULER_HALF);
      ctx.stroke();
      ctx.strokeStyle = "rgba(60,64,67,0.7)";
      ctx.fillStyle = "rgba(60,64,67,0.85)";
      drawRulerScale(ctx, -len, len, -RULER_HALF, 1);
      ctx.beginPath();
      const cm = 37.8 * scale;
      const step = cm / 10 >= 4 ? cm / 10 : cm / 2;
      const n = Math.ceil(len / step);
      for (let i = -n; i <= n; i++) {
        const isCm = cm / 10 >= 4 ? i % 10 === 0 : i % 2 === 0;
        const isHalf = cm / 10 >= 4 ? i % 5 === 0 : false;
        const h = isCm ? 14 : isHalf ? 9 : 5;
        ctx.moveTo(i * step, RULER_HALF);
        ctx.lineTo(i * step, RULER_HALF - h);
      }
      ctx.stroke();
      ctx.font = "700 13px Inter, sans-serif";
      ctx.fillStyle = "#1a73e8";
      ctx.fillText(deg + "°", 0, 8);
    }
    ctx.restore();
  }

  if (rulerBtn) rulerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    ruler.visible = !ruler.visible;
    if (ruler.visible) {
      ruler.cx = window.innerWidth / 2;
      ruler.cy = window.innerHeight * 0.45;
      ruler.angle = 0;
    }
    setRulerVisible(ruler.visible);
  });

  // ---- zweite Leiste fuer Lineal/Geodreieck ----------------------------------
  const rulerBar = document.getElementById("ruler-bar");
  const rulerBarInput = document.getElementById("ruler-bar-angle");
  const rulerAngleOverlay = document.getElementById("ruler-angle-input");

  function setRulerVisible(on) {
    ruler.visible = on;
    if (rulerBtn) rulerBtn.classList.toggle("active", on);
    if (rulerBar) rulerBar.classList.toggle("hidden", !on);
    if (!on && rulerAngleOverlay) rulerAngleOverlay.classList.add("hidden");
    syncRulerBar();
    requestRedraw();
  }

  // Eigene Position (lange halten + ziehen), pro Geraet gemerkt; sonst neben der Werkzeugleiste
  let rulerBarPos = null;
  try {
    const v = JSON.parse(localStorage.getItem("sofianotes-rulerbar-pos") || "null");
    if (v && Number.isFinite(v.fx) && Number.isFinite(v.fy)) rulerBarPos = v;
  } catch (err) {}
  let rulerBarDrag = null;

  function rulerBarDefaultPos() {
    const tb = toolbarEl.getBoundingClientRect();
    const w = rulerBar.offsetWidth;
    const dock = currentDock();
    let left = tb.left + tb.width / 2 - w / 2;
    let top;
    if (dock === "bottom") top = tb.top - 10 - rulerBar.offsetHeight;
    else if (dock === "top") top = tb.bottom + 10;
    else {
      left = window.innerWidth / 2 - w / 2;
      top = window.innerHeight - rulerBar.offsetHeight - 20;
    }
    return { left, top };
  }

  function positionRulerBar() {
    if (!rulerBar || rulerBar.classList.contains("hidden")) return;
    if (rulerBarDrag && rulerBarDrag.live) return;
    if (rulerBarPos) {
      const w = rulerBar.offsetWidth;
      const h = rulerBar.offsetHeight;
      const left = rulerBarPos.fx * window.innerWidth - w / 2;
      const top = rulerBarPos.fy * window.innerHeight - h / 2;
      rulerBar.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, left)) + "px";
      rulerBar.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, top)) + "px";
      return;
    }
    const tb = toolbarEl.getBoundingClientRect();
    const w = rulerBar.offsetWidth;
    const dock = currentDock();
    let left = tb.left + tb.width / 2 - w / 2;
    let top;
    if (dock === "bottom") top = tb.top - 10 - rulerBar.offsetHeight;
    else if (dock === "top") top = tb.bottom + 10;
    else {
      left = window.innerWidth / 2 - w / 2;
      top = window.innerHeight - rulerBar.offsetHeight - 20;
    }
    rulerBar.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, left)) + "px";
    rulerBar.style.top = top + "px";
  }

  function syncRulerBar() {
    if (!rulerBar) return;
    const deg = rulerDegrees();
    rulerBar.querySelectorAll(".kind-btn").forEach((b) => b.classList.toggle("active", b.dataset.kind === ruler.kind));
    rulerBar.querySelectorAll(".angle-btn").forEach((b) => b.classList.toggle("active", Number(b.dataset.angle) === deg));
    if (rulerBarInput && document.activeElement !== rulerBarInput) rulerBarInput.value = String(deg);
    positionRulerBar();
  }

  if (rulerBar) {
    rulerBar.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (e.target.closest("input")) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const r = rulerBar.getBoundingClientRect();
      rulerBarDrag = {
        id: e.pointerId,
        live: false,
        dx: e.clientX - r.left,
        dy: e.clientY - r.top,
        sx: e.clientX,
        sy: e.clientY,
        timer: setTimeout(() => {
          if (!rulerBarDrag) return;
          rulerBarDrag.live = true;
          rulerBar.classList.add("dragging");
          try {
            rulerBar.setPointerCapture(rulerBarDrag.id);
          } catch (err) {}
          try {
            if (navigator.vibrate) navigator.vibrate(12);
          } catch (err) {}
        }, DOCK_HOLD_MS),
      };
    });
    rulerBar.addEventListener("pointermove", (e) => {
      const d = rulerBarDrag;
      if (!d || d.id !== e.pointerId) return;
      if (!d.live) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 10) {
          clearTimeout(d.timer);
          rulerBarDrag = null;
        }
        return;
      }
      const w = rulerBar.offsetWidth;
      const h = rulerBar.offsetHeight;
      rulerBar.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, e.clientX - d.dx)) + "px";
      rulerBar.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, e.clientY - d.dy)) + "px";
    });
    const endBarDrag = (e) => {
      const d = rulerBarDrag;
      if (!d || d.id !== e.pointerId) return;
      clearTimeout(d.timer);
      rulerBarDrag = null;
      if (!d.live) return;
      rulerBar.classList.remove("dragging");
      // Klick auf den Knopf unter dem Finger nach dem Ziehen nicht ausloesen
      rulerBar.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      }, { capture: true, once: true });
      const r = rulerBar.getBoundingClientRect();
      const def = rulerBarDefaultPos();
      if (Math.hypot(r.left - def.left, r.top - def.top) < 40) {
        // zurueck an den Standardplatz gezogen: wieder automatisch neben der Leiste
        rulerBarPos = null;
        try {
          localStorage.removeItem("sofianotes-rulerbar-pos");
        } catch (err) {}
      } else {
        rulerBarPos = { fx: (r.left + r.width / 2) / window.innerWidth, fy: (r.top + r.height / 2) / window.innerHeight };
        try {
          localStorage.setItem("sofianotes-rulerbar-pos", JSON.stringify(rulerBarPos));
        } catch (err) {}
      }
      positionRulerBar();
    };
    rulerBar.addEventListener("pointerup", endBarDrag);
    rulerBar.addEventListener("pointercancel", endBarDrag);
    rulerBar.querySelectorAll(".kind-btn").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        ruler.kind = b.dataset.kind;
        syncRulerBar();
        requestRedraw();
      })
    );
    rulerBar.querySelectorAll(".angle-btn").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        setRulerDegrees(Number(b.dataset.angle));
      })
    );
    document.getElementById("ruler-bar-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      setRulerVisible(false);
    });
  }
  // Gradzahl eintippen: im Feld der Leiste oder direkt im Lineal (Antippen)
  function bindAngleInput(input, onDone) {
    if (!input) return;
    const apply = () => {
      const v = parseFloat(String(input.value).replace(",", "."));
      if (Number.isFinite(v)) setRulerDegrees(((v % 360) + 360) % 360);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        apply();
        input.blur();
      } else if (e.key === "Escape") {
        input.value = String(rulerDegrees());
        input.blur();
      }
    });
    input.addEventListener("change", apply);
    input.addEventListener("blur", () => {
      apply();
      if (onDone) onDone();
    });
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
  }
  bindAngleInput(rulerBarInput);
  bindAngleInput(rulerAngleOverlay, () => rulerAngleOverlay.classList.add("hidden"));

  function openRulerAngleInput(x, y) {
    if (!rulerAngleOverlay) return;
    rulerAngleOverlay.value = String(rulerDegrees());
    rulerAngleOverlay.classList.remove("hidden");
    rulerAngleOverlay.style.left = Math.max(8, Math.min(window.innerWidth - 110, x - 50)) + "px";
    rulerAngleOverlay.style.top = Math.max(8, y - 60) + "px";
    rulerAngleOverlay.focus();
    rulerAngleOverlay.select();
  }

  // ---- Modi: Stift / Text / Tabelle / Lineal / Lasso -----------------------
  // Die Modus-Knoepfe sitzen oben neben dem Blattnamen; die Werkzeugleiste unten zeigt
  // per CSS (data-mode / data-modes) nur, was zum Modus gehoert.
  let currentMode = "pen";
  let lastInkTool = "pen";
  let modeSyncing = false;
  const textDefaults = { b: false, i: false, s: false, u: false };
  const modeButtons = Array.from(document.querySelectorAll(".mode-btn"));

  function showMode(mode) {
    currentMode = mode;
    toolbarEl.dataset.mode = mode;
    modeButtons.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    syncModeBar();
    if (typeof syncSelectionToolbar === "function") syncSelectionToolbar();
    if (!toolPopover.classList.contains("hidden")) positionToolPopover();
  }

  function setMode(mode) {
    if (textEdit) commitTextEditor();
    // Auswahl gehoert zu Lasso/Tabelle - beim Wechsel zu Stift/Text aufheben
    if (mode !== "lasso" && selection.ids.size) clearSelection();
    modeSyncing = true;
    try {
      if (mode === "pen") {
        if (!["pen", "marker"].includes(currentTool)) setTool(lastInkTool || "pen");
      } else if (mode === "eraser") {
        if (currentTool !== "eraser") setTool("eraser");
      } else if (mode === "text") {
        if (currentTool !== "text") setTool("text");
      } else if (currentTool !== "select") {
        setTool("select");
      }
    } finally {
      modeSyncing = false;
    }
    toolPopover.classList.add("hidden");
    showMode(mode);
  }

  // Wird ein Werkzeug anders gewaehlt (Tastatur, Radierer-Ruecksprung, Tabelle einfuegen ...),
  // folgt der Modus - Tabelle bleibt bei der Auswahl. Das Lineal ist ein eigener Schalter.
  function syncModeFromTool(tool) {
    if (modeSyncing || !toolbarEl.dataset) return;
    let mode = currentMode;
    if (tool === "pen" || tool === "marker") mode = "pen";
    else if (tool === "eraser") mode = "eraser";
    else if (tool === "text") mode = "text";
    else if (tool === "select") mode = "lasso";
    if (mode !== currentMode) showMode(mode);
  }

  function syncModeBar() {
    if (!toolbarEl) return;
    const mode = toolbarEl.dataset.mode;
    if (mode === "text") {
      // Groesse: naechster Vorschlag zur aktuellen Groesse (offenes Feld > Auswahl > Voreinstellung)
      const boxes = typeof selectedTextBoxes === "function" ? selectedTextBoxes() : [];
      const cur = textEdit && textEdit.kind === "text" ? textEdit.size * scale : boxes.length ? boxes[0].size * scale : textSize;
      let best = null;
      toolbarEl.querySelectorAll(".size-btn").forEach((b) => {
        const v = Number(b.dataset.textSize);
        if (!best || Math.abs(v - cur) < Math.abs(Number(best.dataset.textSize) - cur)) best = b;
      });
      toolbarEl.querySelectorAll(".size-btn").forEach((b) => b.classList.toggle("active", b === best));
      const sel = window.getSelection();
      const node = textEdit && sel && sel.rangeCount && textEditorEl.contains(sel.anchorNode) ? sel.anchorNode : null;
      toolbarEl.querySelectorAll(".fmt-btn").forEach((b) => {
        const f = FMT[b.dataset.cmd].flag;
        let on;
        if (node) on = !!formatAt(node)[b.dataset.cmd];
        else if (boxes.length) on = boxes.every((t) => strokeRuns(t).every((r) => r[f]));
        else on = !!textDefaults[f];
        b.classList.toggle("active", on);
      });
      const table = activeTable();
      if (barTblEditBtn) barTblEditBtn.disabled = !table;
    } else if (mode === "eraser") {
      let best = null;
      toolbarEl.querySelectorAll(".eraser-size-btn").forEach((b) => {
        const v = Number(b.dataset.eraserSize);
        if (!best || Math.abs(v - eraserSize) < Math.abs(Number(best.dataset.eraserSize) - eraserSize)) best = b;
      });
      toolbarEl.querySelectorAll(".eraser-size-btn").forEach((b) => b.classList.toggle("active", b === best));
    }
  }

  modeButtons.forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      setMode(b.dataset.mode);
    })
  );

  toolbarEl.querySelectorAll(".size-btn").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = Number(b.dataset.textSize);
      textSize = v;
      if (textEdit && textEdit.kind === "text") applyTextEditStyle({ size: v });
      else if (selectedTextBoxes().length) restyleSelection({ size: v / Math.max(scale, 0.25) });
      syncModeBar();
    })
  );
  // Groessen-Knoepfe sollen das offene Textfeld nicht schliessen/den Fokus nehmen
  toolbarEl.querySelectorAll(".size-btn").forEach((b) =>
    b.addEventListener("pointerdown", (e) => {
      if (textEdit && e.cancelable) e.preventDefault();
      e.stopPropagation();
    })
  );

  const barTblEditBtn = document.getElementById("btn-bar-tbl-edit");
  if (barTblEditBtn) {
    barTblEditBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    barTblEditBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openTableDialog(activeTable());
    });
  }

  toolbarEl.querySelectorAll(".eraser-size-btn").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      eraserSize = Number(b.dataset.eraserSize);
      savePrefs();
      updateEraserCursorVisibility();
      syncModeBar();
    })
  );
  document.getElementById("btn-bar-erase-all")?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearAllInk();
  });


  // ---- drawing (pointer handling with palm rejection) -------------------
  const activePointers = new Map(); // pointerId -> {type,x,y}
  const touchPointers = new Map(); // pointerId -> {x,y}
  // ---- Handballen-Erkennung ----
  // Ein aufgelegter Handballen darf weder zoomen noch verschieben:
  //  - grosse Kontaktflaeche (Safari meldet width/height der Beruehrung) -> Handballen
  //  - solange der Stift aufliegt und kurz danach zaehlen Beruehrungen nicht
  //  - setzt der Stift auf, waehrend noch eine Finger-Geste laeuft, war das der Ballen:
  //    Ansicht auf den Stand vor der Geste zuruecksetzen
  const palmIds = new Set();
  const PALM_CONTACT_PX = 38;
  const PEN_GRACE_MS = 350; // kuerzer: direkt nach dem Schreiben/Wegkritzeln laesst sich wieder scrollen
  let lastPenActivity = -Infinity;
  let touchGestureView = null; // {scale, offsetX, offsetY} beim Start der Finger-Geste
  // Groesse allein ist auf dem iPad unzuverlaessig (Finger melden teils grosse Flaechen):
  // nur kurz nach Stift-Benutzung zaehlt eine breite Beruehrung als Handballen.
  function penRecentlyUsed() {
    return performance.now() - lastPenActivity < 4000;
  }
  function looksLikePalm(e) {
    if (penRecentlyUsed() && ((e.width || 0) >= PALM_CONTACT_PX || (e.height || 0) >= PALM_CONTACT_PX)) return true;
    for (const p of activePointers.values()) if (p.type === "pen") return true;
    return performance.now() - lastPenActivity < PEN_GRACE_MS;
  }
  function notePenActivity() {
    lastPenActivity = performance.now();
  }
  // Stift setzt auf: alle aufliegenden Finger sind ab jetzt Handballen; eine laufende
  // Zoom-/Verschiebe-Geste wird rueckgaengig gemacht.
  function penTookOver() {
    notePenActivity();
    if (!touchPointers.size) return;
    if (touchGestureView && (pinchState || panState)) {
      scale = touchGestureView.scale;
      offsetX = touchGestureView.offsetX;
      offsetY = touchGestureView.offsetY;
      requestRedraw();
    }
    for (const id of touchPointers.keys()) palmIds.add(id);
    touchPointers.clear();
    pinchState = null;
    if (panState && panState.pointerId === undefined) panState = null;
    tapState = null;
    touchGestureView = null;
  }
  let pinchState = null; // {initialDist, anchorWorld:{x,y}}
  let panState = null; // {lastX,lastY, pointerId|null}
  // Schwung: nach schnellem Wischen laeuft das Blatt weiter und bremst sanft ab
  let fling = null;
  function startFling(ps) {
    const age = performance.now() - (ps.t || 0);
    let vx = ps.vx || 0;
    let vy = ps.vy || 0;
    if (age > 80 || Math.hypot(vx, vy) < 0.25) return;
    vx *= 1.15;
    vy *= 1.15;
    let last = performance.now();
    const f = { stop: false };
    fling = f;
    const step = (now) => {
      if (f.stop || fling !== f) return;
      const dt = Math.min(40, now - last);
      last = now;
      offsetX += vx * dt;
      offsetY += vy * dt;
      const decay = Math.exp(-dt / 330);
      vx *= decay;
      vy *= decay;
      requestRedraw();
      if (Math.hypot(vx, vy) > 0.02) requestAnimationFrame(step);
      else fling = null;
    };
    requestAnimationFrame(step);
  }
  function stopFling() {
    if (fling) fling.stop = true;
    fling = null;
  }
  let tapState = null; // {pointerId, x, y, t} - moeglicher Finger-Tap (kurz, kaum bewegt)
  const TAP_MAX_MOVE_PX = 10; // ein Finger-Tap darf sich hoechstens so weit bewegen (Bildschirm-px) ...
  const TAP_MAX_MS = 350; // ... und hoechstens so lange dauern, sonst ist es ein Pan
  const TOUCH_SLOP = 1.6; // Finger sind ungenauer als Stift/Maus -> groessere Greifbereiche
  const SELECT_PAD_PX = 10;
  const SELECT_PAD_TOUCH_PX = 22;
  let spacePressed = false;

  // ---- Auswahl-Werkzeug (Lasso markieren + verschieben) -----------------
  let lassoPoints = null;
  let lassoPointerId = null;
  let dragState = null; // {pointerId, startWorld, snapshot: Map(id -> points[])}
  let pendingShapeDrag = null;

  function distPointToSeg(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-8) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function selectionInkStrokes() {
    return Array.from(selection.ids)
      .map((id) => boardStrokes.get(id))
      .filter((s) => s && (s.tool === "pen" || s.tool === "marker" || s.tool === "text"));
  }

  function selectedImageStroke() {
    if (selection.ids.size !== 1) return null;
    const s = boardStrokes.get(Array.from(selection.ids)[0]);
    return s && s.tool === "image" ? s : null;
  }

  function selectStrokeIds(ids) {
    const present = withTableContents(ids.filter((id) => boardStrokes.get(id)));
    if (!present.length) {
      clearSelection();
      return;
    }
    for (const id of present) {
      const s = boardStrokes.get(id);
      if (!s) continue;
      const shape = tagShape(s);
      if (shape === "rectangle" && (s.points || []).length > 6) {
        const p = (s.points[0] && s.points[0].p) || 0.5;
        s.points = rebuildClosed(uniqueRectCorners(s.points), p);
        s.bbox = strokeWorldBBox(s);
      }
    }
    selection = {
      ids: new Set(present),
      bbox: unionBBox(present.map((id) => {
        const s = boardStrokes.get(id);
        return s && (s.bbox || strokeWorldBBox(s));
      }).filter(Boolean)),
    };
    renderToolPopover();
    syncMediaToolbar();
    requestRedraw();
  }

  function restyleSelection(patch, mergeKey) {
    const strokes = selectionInkStrokes();
    if (!strokes.length) return;
    const changes = [];
    for (const s of strokes) {
      const before = { color: s.color, size: s.size };
      if (patch.color) s.color = patch.color;
      if (patch.size != null && Number.isFinite(patch.size)) {
        const cfg = toolConfigs[s.tool] || toolConfigs.pen;
        s.size = Math.max(cfg.min, Math.min(cfg.max, patch.size));
        if (isBoxText(s)) relayoutBoxText(s);
      }
      if (before.color === s.color && before.size === s.size) continue;
      changes.push({ id: s.id, before, after: { color: s.color, size: s.size } });
      wsSend({
        type: "stroke_move",
        stroke: serializeStroke(s),
      });
    }
    if (!changes.length) return;
    const last = undoStack[undoStack.length - 1];
    const sameIds =
      last &&
      last.type === "style" &&
      last.mergeKey &&
      last.mergeKey === mergeKey &&
      last.changes.length === changes.length &&
      last.changes.every((c, i) => c.id === changes[i].id);
    if (mergeKey && sameIds) {
      last.changes.forEach((c, i) => {
        c.after = changes[i].after;
      });
      redoStack.length = 0;
    } else {
      pushUndo({ type: "style", changes, mergeKey: mergeKey || null });
    }
    requestRedraw();
  }

  function strokeHitsPoint(stroke, pt, pad) {
    const r = (stroke.size || 6) / 2 + pad;
    const b = stroke.bbox || strokeWorldBBox(stroke);
    if (!pointInBBox(pt, b, r)) return false;
    if (stroke.tool === "image") {
      const quad = imageRotatedCorners(stroke);
      if (quad.length === 4) return pointInPolygon(pt, quad);
      return true;
    }
    if (stroke.tool === "text" || stroke.tool === "table") return true;
    const pts = stroke.points || [];
    if (pts.length === 1) return Math.hypot(pts[0].x - pt.x, pts[0].y - pt.y) <= r;
    for (let i = 1; i < pts.length; i++) {
      if (distPointToSeg(pt, pts[i - 1], pts[i]) <= r) return true;
    }
    const shape = inferShape(stroke);
    if (shape === "rectangle" || shape === "triangle") {
      const poly = shape === "rectangle" ? uniqueRectCorners(pts) : closedRing(pts).slice(0, 3);
      if (poly.length >= 3 && pointInPolygon(pt, poly)) return true;
    }
    if (shape === "circle" || shape === "ellipse") {
      const g = ellipseGeomFromPoints(pts);
      const nx = (pt.x - g.cx) / (g.rx || 1);
      const ny = (pt.y - g.cy) / (g.ry || 1);
      if (nx * nx + ny * ny <= 1) return true;
    }
    return false;
  }

  function pickStrokeAt(world, padPx = 12) {
    const pad = padPx / Math.max(scale, 0.25);
    let best = null;
    let bestD = Infinity;
    for (const s of boardStrokes.values()) {
      if (!strokeHitsPoint(s, world, pad)) continue;
      const b = s.bbox || makeBBox(s.points || []);
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      const d = Math.hypot(world.x - cx, world.y - cy);
      if (d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  function clearSelection() {
    selection = { ids: new Set(), bbox: null };
    lassoPoints = null;
    lassoPointerId = null;
    dragState = null;
    cancelCropMode(true);
    if (toolPopover && !toolPopover.classList.contains("hidden")) renderToolPopover();
    syncMediaToolbar();
    requestRedraw();
  }

  function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      const intersect = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function pointInBBox(pt, b, pad) {
    return pt.x >= b.minX - pad && pt.x <= b.maxX + pad && pt.y >= b.minY - pad && pt.y <= b.maxY + pad;
  }

  function finalizeLasso() {
    const pts = lassoPoints;
    lassoPoints = null;
    const tap = !pts || pts.length < 3 || strokePathLength(pts) < 16 / Math.max(scale, 0.25);
    if (tap) {
      const hit = pts && pts[0] ? pickStrokeAt(pts[0]) : null;
      if (hit) selectStrokeIds([hit.id]);
      else clearSelection();
      return;
    }
    const ids = new Set();
    for (const stroke of boardStrokes.values()) {
      if (stroke.tool === "table" || isBoxText(stroke)) {
        const b = stroke.bbox || strokeWorldBBox(stroke);
        const probes = [
          { x: b.minX, y: b.minY },
          { x: b.maxX, y: b.minY },
          { x: b.minX, y: b.maxY },
          { x: b.maxX, y: b.maxY },
          { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
        ];
        if (probes.some((p) => pointInPolygon(p, pts))) ids.add(stroke.id);
        continue;
      }
      if (stroke.tool === "image") {
        const corners = imageRotatedCorners(stroke);
        const b = stroke.bbox || makeBBox(corners.length ? corners : stroke.points || []);
        const hits = corners.length
          ? corners.concat([{ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }])
          : [
              { x: b.minX, y: b.minY },
              { x: b.maxX, y: b.minY },
              { x: b.minX, y: b.maxY },
              { x: b.maxX, y: b.maxY },
              { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
            ];
        if (hits.some((p) => pointInPolygon(p, pts))) ids.add(stroke.id);
        continue;
      }
      for (const p of stroke.points) {
        if (pointInPolygon(p, pts)) {
          ids.add(stroke.id);
          break;
        }
      }
    }
    if (ids.size === 0) {
      clearSelection();
      return;
    }
    selectStrokeIds(Array.from(ids));
  }

  function snapshotSelection() {
    const snapshot = new Map();
    const extras = new Map();
    const sizes = new Map();
    for (const id of selection.ids) {
      const s = boardStrokes.get(id);
      if (!s) continue;
      snapshot.set(id, s.points.map((p) => ({ x: p.x, y: p.y, p: p.p, text: p.text })));
      sizes.set(id, s.size);
      extras.set(id, s.extra ? JSON.parse(JSON.stringify(s.extra)) : null);
    }
    return { snapshot, extras, sizes };
  }

  function startSelectionDrag(pointerId, world) {
    const snap = snapshotSelection();
    dragState = { pointerId, startWorld: world, kind: "move", ...snap };
  }

  function startSelectionScale(pointerId, world, corner) {
    const snap = snapshotSelection();
    const pad = 10 / scale;
    const b = selection.bbox;
    const mx = (b.minX + b.maxX) / 2, my = (b.minY + b.maxY) / 2;
    const originMap = {
      nw: { x: b.maxX + pad, y: b.maxY + pad },
      ne: { x: b.minX - pad, y: b.maxY + pad },
      sw: { x: b.maxX + pad, y: b.minY - pad },
      se: { x: b.minX - pad, y: b.minY - pad },
      n: { x: mx, y: b.maxY + pad },
      s: { x: mx, y: b.minY - pad },
      w: { x: b.maxX + pad, y: my },
      e: { x: b.minX - pad, y: my },
    };
    dragState = {
      pointerId,
      startWorld: world,
      kind: "scale",
      corner,
      axis: corner === "n" || corner === "s" ? "y" : corner === "w" || corner === "e" ? "x" : null,
      origin: originMap[corner],
      ...snap,
    };
  }

  function startSelectionRotate(pointerId, world) {
    const snap = snapshotSelection();
    const b = selection.bbox;
    dragState = {
      pointerId,
      startWorld: world,
      kind: "rotate",
      center: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
      ...snap,
    };
  }

  function startPointEdit(pointerId, world, knot) {
    const snap = snapshotSelection();
    dragState = {
      pointerId,
      startWorld: world,
      kind: "point",
      strokeId: knot.strokeId,
      index: knot.i,
      knots: knot.knots,
      knot,
      ...snap,
    };
  }

  function updateSelectionScale(world) {
    const origin = dragState.origin;
    const s0x = dragState.startWorld.x - origin.x;
    const s0y = dragState.startWorld.y - origin.y;
    const s1x = world.x - origin.x;
    const s1y = world.y - origin.y;
    if (dragState.axis) return updateSelectionStretch(s0x, s0y, s1x, s1y);
    let factor = Math.abs(s0x) > Math.abs(s0y) ? s1x / s0x : s1y / s0y;
    if (!Number.isFinite(factor)) factor = 1;
    factor = Math.max(0.08, Math.min(12, factor));
    const boxes = [];
    for (const [id, pts] of dragState.snapshot) {
      const s = boardStrokes.get(id);
      if (!s) continue;
      s.points = pts.map((p) => ({
        x: origin.x + (p.x - origin.x) * factor,
        y: origin.y + (p.y - origin.y) * factor,
        p: p.p,
        text: p.text,
      }));
      const baseSize = dragState.sizes && dragState.sizes.get(id);
      if (baseSize != null) s.size = Math.max(1, baseSize * factor);
      const baseExtra = dragState.extras && dragState.extras.get(id);
      if (isBoxText(s) && baseExtra && baseExtra.width) s.extra = Object.assign({}, s.extra, { width: baseExtra.width * factor });
      s.bbox = strokeWorldBBox(s);
      boxes.push(s.bbox);
    }
    selection.bbox = unionBBox(boxes);
    requestRedraw();
  }

  // Seitengriffe: nur eine Richtung strecken. Tinte, Formen, Tabellen und Bilder werden
  // verzerrt; Strichstaerke bleibt; Textfelder wandern nur mit (Text verzerrt nicht).
  function updateSelectionStretch(s0x, s0y, s1x, s1y) {
    const origin = dragState.origin;
    const axisX = dragState.axis === "x";
    let f = axisX ? s1x / s0x : s1y / s0y;
    if (!Number.isFinite(f)) f = 1;
    f = Math.max(0.05, Math.min(20, f));
    const fx = axisX ? f : 1;
    const fy = axisX ? 1 : f;
    const boxes = [];
    for (const [id, pts] of dragState.snapshot) {
      const s = boardStrokes.get(id);
      if (!s) continue;
      if (s.tool === "text" && axisX && isBoxText(s) && !strokeRotation(s)) {
        // Textfeld seitlich ziehen = Umbruchbreite aendern (Schrift bleibt gleich gross)
        const a = pts[0];
        const baseExtra = (dragState.extras && dragState.extras.get(id)) || {};
        let w0 = baseExtra.width;
        if (!w0) {
          let maxX = a.x;
          for (const p of pts) maxX = Math.max(maxX, p.x);
          w0 = Math.max(maxX - a.x, s.size);
        }
        // die gezogene Seite folgt dem Finger, die andere bleibt stehen
        const move = s1x - s0x;
        const min = s.size * 2;
        let left = a.x;
        let w = w0;
        if (dragState.corner === "w") {
          w = Math.max(min, w0 - move);
          left = a.x + w0 - w;
        } else {
          w = Math.max(min, w0 + move);
        }
        s.extra = Object.assign({}, baseExtra, { width: w });
        s.points = [{ x: left, y: a.y, p: a.p, text: a.text }].concat(pts.slice(1).map((p) => ({ ...p })));
        relayoutBoxText(s);
      } else if (s.tool === "text") {
        const a = pts[0];
        const dx = origin.x + (a.x - origin.x) * fx - a.x;
        const dy = origin.y + (a.y - origin.y) * fy - a.y;
        s.points = pts.map((p) => ({ x: p.x + dx, y: p.y + dy, p: p.p, text: p.text }));
      } else {
        s.points = pts.map((p) => ({
          x: origin.x + (p.x - origin.x) * fx,
          y: origin.y + (p.y - origin.y) * fy,
          p: p.p,
          text: p.text,
        }));
        const baseExtra = dragState.extras && dragState.extras.get(id);
        const tag = baseExtra && baseExtra.shape;
        if (tag === "circle" && Math.abs(f - 1) > 0.02) s.extra = Object.assign({}, s.extra, { shape: "ellipse" });
      }
      s.bbox = strokeWorldBBox(s);
      boxes.push(s.bbox);
    }
    selection.bbox = unionBBox(boxes);
    requestRedraw();
  }

  function updateSelectionDrag(world) {
    const dx = world.x - dragState.startWorld.x;
    const dy = world.y - dragState.startWorld.y;
    const boxes = [];
    for (const [id, pts] of dragState.snapshot) {
      const s = boardStrokes.get(id);
      if (!s) continue;
      s.points = pts.map((p) => ({ x: p.x + dx, y: p.y + dy, p: p.p, text: p.text }));
      s.bbox = strokeWorldBBox(s);
      boxes.push(s.bbox);
    }
    selection.bbox = unionBBox(boxes);
    requestRedraw();
  }

  function updateSelectionRotate(world) {
    const c = dragState.center;
    const a0 = Math.atan2(dragState.startWorld.y - c.y, dragState.startWorld.x - c.x);
    let ang = Math.atan2(world.y - c.y, world.x - c.x) - a0;
    const step = Math.PI / 12;
    const snapped = Math.round(ang / step) * step;
    if (Math.abs(ang - snapped) < (3.5 * Math.PI) / 180) ang = snapped;
    const boxes = [];
    for (const [id, pts] of dragState.snapshot) {
      const s = boardStrokes.get(id);
      if (!s) continue;
      if ((s.tool === "image" || s.tool === "table") && pts.length >= 2) {
        // Tabellen drehen nicht mit, sie wandern nur mit (Zellen bleiben waagrecht).
        const minX = Math.min(pts[0].x, pts[1].x);
        const minY = Math.min(pts[0].y, pts[1].y);
        const maxX = Math.max(pts[0].x, pts[1].x);
        const maxY = Math.max(pts[0].y, pts[1].y);
        const ocx = (minX + maxX) / 2;
        const ocy = (minY + maxY) / 2;
        const nc = rotatePoint({ x: ocx, y: ocy }, c.x, c.y, ang);
        const dx = nc.x - ocx;
        const dy = nc.y - ocy;
        s.points = pts.map((p) => ({ x: p.x + dx, y: p.y + dy, p: p.p, text: p.text }));
      } else {
        s.points = pts.map((p) => rotatePoint(p, c.x, c.y, ang));
      }
      const baseExtra = dragState.extras && dragState.extras.get(id);
      if (s.tool === "image" || s.tool === "text") {
        const baseRot = baseExtra && Number.isFinite(baseExtra.rotation) ? baseExtra.rotation : 0;
        s.extra = Object.assign({}, baseExtra || s.extra || {}, { rotation: baseRot + ang });
      } else if (baseExtra) {
        s.extra = JSON.parse(JSON.stringify(baseExtra));
      }
      s.bbox = strokeWorldBBox(s);
      boxes.push(s.bbox);
    }
    selection.bbox = unionBBox(boxes);
    requestRedraw();
  }

  function updatePointEdit(world) {
    const dx = world.x - dragState.startWorld.x;
    const dy = world.y - dragState.startWorld.y;
    const id = dragState.strokeId;
    const pts = dragState.snapshot.get(id);
    const s = boardStrokes.get(id);
    if (!s || !pts) return;
    const knot = dragState.knot || { kind: "free", i: dragState.index, knots: dragState.knots };
    const pressure = (pts[0] && pts[0].p) || 0.5;
    const shape = inferShape({ ...s, points: pts, extra: s.extra });
    if (shape === "rectangle" && (knot.kind === "corner" || knot.kind === "side")) {
      const corners = uniqueRectCorners(pts);
      s.points =
        knot.kind === "side"
          ? moveRectSide(corners, knot.side, world, pressure)
          : moveRectCorner(corners, knot.corner, world, pressure);
      s.extra = Object.assign({}, s.extra || {}, { shape: "rectangle" });
    } else if ((shape === "circle" || shape === "ellipse") && knot.kind === "radius") {
      const g = ellipseGeomFromPoints(pts);
      if (shape === "circle") {
        const r = Math.max(8, Math.hypot(world.x - g.cx, world.y - g.cy));
        s.points = makeEllipsePoints(g.cx, g.cy, r, r, pressure, 96);
        s.extra = Object.assign({}, s.extra || {}, { shape: "circle" });
      } else {
        let rx = g.rx;
        let ry = g.ry;
        if (knot.axis === "x") rx = Math.max(8, Math.abs(world.x - g.cx));
        else ry = Math.max(8, Math.abs(world.y - g.cy));
        s.points = makeEllipsePoints(g.cx, g.cy, rx, ry, pressure, 96);
        s.extra = Object.assign({}, s.extra || {}, { shape: "ellipse" });
      }
    } else if (shape === "triangle" && knot.kind === "corner") {
      const ring = closedRing(pts).slice(0, 3).map((p) => ({ x: p.x, y: p.y, p: pressure }));
      ring[knot.corner] = { x: world.x, y: world.y, p: pressure };
      s.points = rebuildClosed(ring, pressure);
      s.extra = Object.assign({}, s.extra || {}, { shape: "triangle" });
    } else if (shape === "line" && knot.kind === "end") {
      const next = pts.map((p) => ({ x: p.x, y: p.y, p: p.p }));
      next[knot.i] = { x: world.x, y: world.y, p: pressure };
      s.points = next;
      s.extra = Object.assign({}, s.extra || {}, { shape: "line" });
    } else {
      const k = dragState.index;
      const knotIdx = dragState.knots || [k];
      const pos = knotIdx.indexOf(k);
      const k0 = pos > 0 ? knotIdx[pos - 1] : k;
      const k1 = pos >= 0 && pos < knotIdx.length - 1 ? knotIdx[pos + 1] : k;
      s.points = pts.map((p, i) => {
        let w = 0;
        if (i === k) w = 1;
        else if (k !== k0 && i > k0 && i < k) w = (i - k0) / (k - k0);
        else if (k !== k1 && i > k && i < k1) w = (k1 - i) / (k1 - k);
        if (w <= 0) return { x: p.x, y: p.y, p: p.p, text: p.text };
        return { x: p.x + dx * w, y: p.y + dy * w, p: p.p, text: p.text };
      });
    }
    s.bbox = strokeWorldBBox(s);
    const boxes = [];
    for (const sid of selection.ids) {
      const st = boardStrokes.get(sid);
      if (st && st.bbox) boxes.push(st.bbox);
    }
    selection.bbox = unionBBox(boxes);
    requestRedraw();
  }

  function finalizeSelectionDrag() {
    const moves = [];
    for (const [id, beforePts] of dragState.snapshot) {
      const s = boardStrokes.get(id);
      if (s) {
        wsSend({ type: "stroke_move", stroke: serializeStroke(s) });
        const extra = dragState.extras && dragState.extras.get(id);
        const beforeSize = dragState.sizes && dragState.sizes.get(id);
        moves.push({
          id,
          before: beforePts,
          after: s.points.map((p) => ({ ...p })),
          beforeExtra: extra || null,
          afterExtra: s.extra ? JSON.parse(JSON.stringify(s.extra)) : null,
          beforeSize: beforeSize != null ? beforeSize : s.size,
          afterSize: s.size,
        });
      }
    }
    if (moves.length > 0) {
      const changed = moves.some((m) => {
        if (m.before.length !== m.after.length) return true;
        for (let i = 0; i < m.before.length; i++) {
          if (Math.hypot(m.before[i].x - m.after[i].x, m.before[i].y - m.after[i].y) > 0.35) return true;
        }
        const be = JSON.stringify(m.beforeExtra || null);
        const ae = JSON.stringify(m.afterExtra || null);
        if (be !== ae) return true;
        if (m.beforeSize != null && m.afterSize != null && Math.abs(m.beforeSize - m.afterSize) > 0.05) return true;
        return false;
      });
      if (changed) {
        pushUndo({ type: "move", moves });
        for (const m of moves) noteShapeEdited(m.id);
      } else if (dragState.kind === "move") {
        // Antippen einer ausgewaehlten Tabelle: direkt in diese Zelle tippen
        const table = selectedTable();
        const start = dragState.startWorld;
        if (table && cellAt(table, start)) {
          dragState = null;
          openCellEditor(table, cellAt(table, start));
          return;
        }
      }
    }
    dragState = null;
  }
  function cancelSelectionDrag() {
    for (const [id, pts] of dragState.snapshot) {
      const s = boardStrokes.get(id);
      if (!s) continue;
      s.points = pts.map((p) => ({ ...p }));
      if (dragState.extras && dragState.extras.has(id)) {
        const ex = dragState.extras.get(id);
        if (ex) s.extra = JSON.parse(JSON.stringify(ex));
        else if (s.extra && s.extra.rotation != null) {
          const next = Object.assign({}, s.extra);
          delete next.rotation;
          s.extra = Object.keys(next).length ? next : undefined;
        }
      }
      const beforeSize = dragState.sizes && dragState.sizes.get(id);
      if (beforeSize != null) s.size = beforeSize;
      s.bbox = strokeWorldBBox(s);
    }
    dragState = null;
    requestRedraw();
  }

  function selectedEditKnots() {
    const ink = selectedStrokes().filter((s) => s.tool === "pen" || s.tool === "marker");
    if (!ink.length || ink.length > 10) return [];
    const out = [];
    for (const s of ink) {
      const shaped = shapeEditKnots(s);
      if (shaped) {
        tagShape(s);
        for (const k of shaped) out.push(Object.assign({ strokeId: s.id, knots: [] }, k));
        continue;
      }
      // Handschrift bekommt keine Verbiege-Punkte - die gibt es nur fuer Formen und Linien
    }
    return out.length > 80 ? [] : out;
  }

  function pickEditKnot(world) {
    const r = 14 / Math.max(scale, 0.25);
    let best = null;
    let bestD = r;
    for (const k of selectedEditKnots()) {
      const d = Math.hypot(world.x - k.x, world.y - k.y);
      if (d <= bestD) {
        best = k;
        bestD = d;
      }
    }
    return best;
  }

  function pickScaleHandle(world, bbox, pad, slop = 1) {
    const r = (14 * slop) / Math.max(scale, 0.25);
    for (const p of selectionHandlePoints(bbox, pad)) {
      if (Math.hypot(world.x - p.x, world.y - p.y) <= r) return p.name;
    }
    return null;
  }

  function pickRotateHandle(world, bbox, pad, slop = 1) {
    if (!bbox) return false;
    const h = selectionRotateHandle(bbox, pad);
    const r = (16 * slop) / Math.max(scale, 0.25);
    return Math.hypot(world.x - h.x, world.y - h.y) <= r;
  }

  function pickCropHandle(world, slop = 1) {
    if (!cropState || !cropState.full) return null;
    const r = (16 * slop) / Math.max(scale, 0.25);
    for (const p of cropHandlePoints(cropState.full, cropState.crop)) {
      if (Math.hypot(world.x - p.x, world.y - p.y) <= r) return p.name;
    }
    return null;
  }

  function clampCrop(c) {
    const min = 0.04;
    let l = Math.max(0, Math.min(1 - min, c.l));
    let t = Math.max(0, Math.min(1 - min, c.t));
    let r = Math.max(l + min, Math.min(1, c.r));
    let b = Math.max(t + min, Math.min(1, c.b));
    return { l, t, r, b };
  }

  function updateCropDrag(world) {
    if (!cropState || !cropState.handle || !cropState.startCrop) return;
    const full = cropState.full;
    const start = cropState.startCrop;
    const dx = (world.x - cropState.startWorld.x) / full.w;
    const dy = (world.y - cropState.startWorld.y) / full.h;
    const next = { ...start };
    const h = cropState.handle;
    if (h === "move") {
      const w = start.r - start.l;
      const ht = start.b - start.t;
      next.l = start.l + dx;
      next.t = start.t + dy;
      next.r = next.l + w;
      next.b = next.t + ht;
      if (next.l < 0) {
        next.r -= next.l;
        next.l = 0;
      }
      if (next.t < 0) {
        next.b -= next.t;
        next.t = 0;
      }
      if (next.r > 1) {
        next.l -= next.r - 1;
        next.r = 1;
      }
      if (next.b > 1) {
        next.t -= next.b - 1;
        next.b = 1;
      }
    } else {
      if (h.indexOf("w") >= 0) next.l = start.l + dx;
      if (h.indexOf("e") >= 0) next.r = start.r + dx;
      if (h.indexOf("n") >= 0) next.t = start.t + dy;
      if (h.indexOf("s") >= 0) next.b = start.b + dy;
    }
    cropState.crop = clampCrop(next);
  }

  function enterCropMode() {
    const s = selectedImageStroke();
    if (!s) return;
    const full = imageFullRect(s);
    if (!full) return;
    cropState = {
      strokeId: s.id,
      full,
      crop: imageCrop(s),
      before: cloneStroke(s),
      pointerId: null,
      handle: null,
    };
    setTool("select");
    syncMediaToolbar();
    requestRedraw();
  }

  function cancelCropMode(silent) {
    if (!cropState) {
      if (!silent) syncMediaToolbar();
      return;
    }
    cropState = null;
    syncMediaToolbar();
    requestRedraw();
  }

  function applyCropMode() {
    if (!cropState) return;
    const s = boardStrokes.get(cropState.strokeId);
    if (!s) {
      cropState = null;
      syncMediaToolbar();
      return;
    }
    const full = cropState.full;
    const crop = clampCrop(cropState.crop);
    const minX = full.minX + crop.l * full.w;
    const minY = full.minY + crop.t * full.h;
    const maxX = full.minX + crop.r * full.w;
    const maxY = full.minY + crop.b * full.h;
    const before = cropState.before;
    s.points = [
      { x: minX, y: minY, p: 1 },
      { x: maxX, y: maxY, p: 1 },
    ];
    s.extra = s.extra || {};
    s.extra.crop = crop;
    s.bbox = strokeWorldBBox(s);
    selection.bbox = s.bbox;
    wsSend({ type: "stroke_move", stroke: serializeStroke(s) });
    pushUndo({
      type: "move",
      moves: [
        {
          id: s.id,
          before: before.points.map((p) => ({ ...p })),
          after: s.points.map((p) => ({ ...p })),
          beforeExtra: before.extra || null,
          afterExtra: JSON.parse(JSON.stringify(s.extra)),
        },
      ],
    });
    cropState = null;
    syncMediaToolbar();
    requestRedraw();
  }

  function selectedStrokes() {
    return Array.from(selection.ids)
      .map((id) => boardStrokes.get(id))
      .filter(Boolean);
  }

  function selectedHandwriting() {
    return selectedStrokes().filter((s) => s.tool === "pen" || s.tool === "marker");
  }

  function copySelection() {
    const clones = selectedStrokes().map(cloneStroke);
    if (!clones.length) return;
    strokeClipboard = clones;
    syncSelectionToolbar();
  }

  function deleteSelection() {
    const clones = selectedStrokes().map(cloneStroke);
    if (!clones.length) return;
    removeStrokes(clones.map((s) => s.id));
    pushUndo({ type: "erase", strokes: clones });
    clearSelection();
    requestRedraw();
  }

  function cutSelection() {
    const clones = selectedStrokes().map(cloneStroke);
    if (!clones.length) return;
    strokeClipboard = clones.map(cloneStroke);
    const ids = clones.map((s) => s.id);
    removeStrokes(ids);
    pushUndo({ type: "erase", strokes: clones });
    clearSelection();
    requestRedraw();
  }

  function pasteClipboard() {
    if (!strokeClipboard.length) return;
    hidePasteMenu();
    const boxes = strokeClipboard.map((s) => makeBBox(s.points));
    const union = unionBBox(boxes);
    if (!union) return;
    const target =
      pasteAnchorWorld || lastPointerWorld || screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    pasteAnchorWorld = null;
    const dx = target.x - (union.minX + union.maxX) / 2;
    const dy = target.y - (union.minY + union.maxY) / 2;
    const pasted = [];
    for (const src of strokeClipboard) {
      const n = cloneStroke(src);
      n.id = uuid();
      n.points = n.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
      n.bbox = makeBBox(n.points);
      putStroke(n);
      pasted.push(cloneStroke(n));
    }
    if (!pasted.length) return;
    pushUndo({ type: "add_many", strokes: pasted });
    setTool("select");
    selectStrokeIds(pasted.map((s) => s.id));
    requestRedraw();
  }

  const mediaToolbar = document.getElementById("selection-toolbar");
  const importFileInput = document.getElementById("import-file");

  function syncSelectionToolbar() {
    if (!mediaToolbar) return;
    const cropping = !!cropState;
    const hasSel = selection.ids.size > 0 || cropping;
    if (!hasSel) {
      mediaToolbar.classList.add("hidden");
      syncModeBar();
      return;
    }
    mediaToolbar.classList.remove("hidden");
    const img = selectedImageStroke();
    const pens = selectedHandwriting();
    const kiBtn = document.getElementById("btn-sel-ki");
    const copyBtn = document.getElementById("btn-sel-copy");
    const cutBtn = document.getElementById("btn-sel-cut");
    const pasteBtn = document.getElementById("btn-sel-paste");
    const cropBtn = document.getElementById("btn-media-crop");
    const doneBtn = document.getElementById("btn-media-crop-done");
    const cancelBtn = document.getElementById("btn-media-crop-cancel");
    if (kiBtn) kiBtn.classList.toggle("hidden", cropping || pens.length === 0);
    if (copyBtn) copyBtn.classList.toggle("hidden", cropping || !selection.ids.size);
    if (cutBtn) cutBtn.classList.toggle("hidden", cropping || !selection.ids.size);
    const delBtn = document.getElementById("btn-sel-delete");
    if (delBtn) delBtn.classList.toggle("hidden", cropping || !selection.ids.size);
    if (pasteBtn) pasteBtn.classList.toggle("hidden", cropping || !strokeClipboard.length);
    if (cropBtn) cropBtn.classList.toggle("hidden", cropping || !img);
    const table = cropping ? null : selectedTable();
    // im Tabellen-/Text-Modus stehen diese Knoepfe schon unten in der Leiste
    const inTableMode = toolbarEl.dataset.mode === "text";
    document.querySelectorAll(".tbl-btn").forEach((b) => b.classList.toggle("hidden", !table || inTableMode));
    syncModeBar();
    const texts = cropping ? [] : selectedTextBoxes();
    const inTextMode = toolbarEl.dataset.mode === "text";
    document.querySelectorAll(".txt-btn").forEach((b) => {
      b.classList.toggle("hidden", !texts.length || inTextMode);
      if (texts.length) b.classList.toggle("active", texts.every((t) => strokeRuns(t).every((r) => r[b.dataset.flag])));
    });
    if (doneBtn) doneBtn.classList.toggle("hidden", !cropping);
    if (cancelBtn) cancelBtn.classList.toggle("hidden", !cropping);
    positionMediaToolbar();
  }

  function syncMediaToolbar() {
    syncSelectionToolbar();
  }

  function positionMediaToolbar() {
    if (!mediaToolbar || mediaToolbar.classList.contains("hidden")) return;
    const s = selectedImageStroke() || (cropState && boardStrokes.get(cropState.strokeId));
    const b =
      cropState && cropState.full
        ? cropState.full
        : selection.bbox || (s && (s.bbox || imageDestRect(s)));
    if (!b) return;
    const top = worldToScreen((b.minX + b.maxX) / 2, b.minY);
    const bottom = worldToScreen((b.minX + b.maxX) / 2, b.maxY);
    mediaToolbar.style.left = Math.round(top.x) + "px";
    const extraLift = cropState ? 0 : 8;
    if (top.y < 78 + extraLift) {
      mediaToolbar.style.top = Math.round(bottom.y + (cropState ? 8 : 48)) + "px";
      mediaToolbar.style.transform = "translate(-50%, 0)";
    } else {
      mediaToolbar.style.top = Math.round(top.y - 8 - extraLift) + "px";
      mediaToolbar.style.transform = "translate(-50%, -100%)";
    }
  }

  function bitmapToJpeg(source, maxEdge) {
    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;
    const fit = Math.min(1, maxEdge / Math.max(w, h, 1));
    const cw = Math.max(1, Math.round(w * fit));
    const ch = Math.max(1, Math.round(h * fit));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const c = canvas.getContext("2d");
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, cw, ch);
    c.drawImage(source, 0, 0, cw, ch);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.82), w: cw, h: ch };
  }

  async function uploadJpeg(dataUrl) {
    const id = uuid();
    try {
      const blob = await (await fetch(dataUrl)).blob();
      if (window.SofiaOffline) await SofiaOffline.putMedia(id, blob);
    } catch (err) {
      /* blob cache optional */
    }
    try {
      const resp = await fetch("/api/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, image: dataUrl }),
      });
      if (!resp.ok) throw new Error("upload");
      const data = await resp.json();
      if (!data || !data.id) throw new Error("upload");
      return data.id;
    } catch (err) {
      await enqueueOp({ type: "media", id, image: dataUrl });
      return id;
    }
  }

  function placeImageStroke(mediaId, w, h, name, origin) {
    const maxW = Math.min(720, window.innerWidth * 0.62) / scale;
    const maxH = Math.min(860, window.innerHeight * 0.7) / scale;
    const fit = Math.min(maxW / w, maxH / h, 1);
    const dw = w * fit;
    const dh = h * fit;
    if (origin.center) origin = { x: origin.x - dw / 2, y: origin.y - dh / 2 };
    const id = uuid();
    const stroke = {
      id,
      tool: "image",
      color: "#000000",
      size: 1,
      points: [
        { x: origin.x, y: origin.y, p: 1 },
        { x: origin.x + dw, y: origin.y + dh, p: 1 },
      ],
      extra: {
        mediaId,
        crop: { l: 0, t: 0, r: 1, b: 1 },
        nw: w,
        nh: h,
        name: name || "Bild",
      },
    };
    stroke.bbox = makeBBox(stroke.points);
    boardStrokes.set(id, stroke);
    ensureMedia(mediaId);
    wsSend({ type: "stroke_move", stroke: serializeStroke(stroke) });
    pushUndo({ type: "add", stroke: cloneStroke(stroke) });
    return stroke;
  }

  async function importImageFile(file, origin) {
    const bmp = await createImageBitmap(file);
    const jpeg = bitmapToJpeg(bmp, 1600);
    if (bmp.close) bmp.close();
    const mediaId = await uploadJpeg(jpeg.dataUrl);
    return placeImageStroke(mediaId, jpeg.w, jpeg.h, file.name, origin);
  }

  async function importPdfFile(file, origin) {
    if (window.ensurePdf) await window.ensurePdf().catch(() => null);
    if (!window.pdfjsLib) throw new Error("pdfjs");
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const n = Math.min(pdf.numPages, 6);
    const placed = [];
    let y = origin.y;
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scalePdf = Math.min(1.5, 1600 / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale: scalePdf });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      const jpeg = bitmapToJpeg(canvas, 1600);
      const mediaId = await uploadJpeg(jpeg.dataUrl);
      const stroke = placeImageStroke(mediaId, jpeg.w, jpeg.h, file.name + " S." + i, { x: origin.x, y });
      placed.push(stroke);
      y = stroke.points[1].y + 28;
    }
    return placed;
  }

  async function importFiles(fileList) {
    let files = Array.from(fileList || []);
    for (const f of files.filter(isBoardFile)) await importBoardFile(f);
    files = files.filter((f) => !isBoardFile(f));
    if (!files.length) return;
    const worldOrigin = screenToWorld(window.innerWidth * 0.18, window.innerHeight * 0.16);
    let x = worldOrigin.x;
    let y = worldOrigin.y;
    const ids = [];
    statusTextEl.textContent = "Importiere…";
    try {
      for (const file of files) {
        const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
        const origin = { x, y };
        if (isPdf && notebook && window.sofiaInsertPdfPages) {
          await window.sofiaInsertPdfPages(file);
        } else if (isPdf) {
          const placed = await importPdfFile(file, origin);
          placed.forEach((s) => ids.push(s.id));
          if (placed.length) {
            y = placed[placed.length - 1].points[1].y + 40;
          }
        } else if (/^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|heic)$/i.test(file.name)) {
          const s = await importImageFile(file, origin);
          ids.push(s.id);
          y = s.points[1].y + 40;
        }
      }
      if (ids.length) {
        setTool("select");
        selectStrokeIds(ids);
      }
    } catch (err) {
      console.warn("import failed", err);
      statusTextEl.textContent = "Import fehlgeschlagen";
      setTimeout(() => setConnected(!!(ws && ws.readyState === 1)), 1800);
      return;
    }
    setConnected(!!(ws && ws.readyState === 1));
    requestRedraw();
  }

  // ---- Einfuegen-Menue oben: Tabelle, Bild, PDF ----
  const insertMenu = document.getElementById("insert-menu");
  const insertBtn = document.getElementById("btn-insert");
  function pickImportFiles(accept) {
    if (!importFileInput) return;
    importFileInput.accept = accept;
    importFileInput.value = "";
    importFileInput.click();
  }
  insertBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    hidePopovers();
    insertMenu.classList.toggle("hidden");
  });
  document.getElementById("insert-table")?.addEventListener("click", (e) => {
    e.stopPropagation();
    insertMenu.classList.add("hidden");
    openTableDialog(null);
  });
  document.getElementById("insert-image")?.addEventListener("click", (e) => {
    e.stopPropagation();
    insertMenu.classList.add("hidden");
    pickImportFiles("image/*");
  });
  document.getElementById("insert-pdf")?.addEventListener("click", (e) => {
    e.stopPropagation();
    insertMenu.classList.add("hidden");
    pickImportFiles("application/pdf,.pdf,image/*");
  });
  document.addEventListener("pointerdown", (e) => {
    if (insertMenu && !insertMenu.classList.contains("hidden") && !e.target.closest(".insert-menu-wrap")) insertMenu.classList.add("hidden");
  }, true);
  importFileInput?.addEventListener("change", () => importFiles(importFileInput.files));
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    importFiles(e.dataTransfer.files);
  });
  document.getElementById("btn-media-crop")?.addEventListener("click", (e) => {
    e.stopPropagation();
    enterCropMode();
  });
  document.getElementById("btn-media-crop-done")?.addEventListener("click", (e) => {
    e.stopPropagation();
    applyCropMode();
  });
  document.getElementById("btn-media-crop-cancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    cancelCropMode();
  });
  document.getElementById("btn-sel-ki")?.addEventListener("click", (e) => {
    e.stopPropagation();
    recognizeSelection();
  });
  document.getElementById("btn-sel-copy")?.addEventListener("click", (e) => {
    e.stopPropagation();
    copySelection();
  });
  document.getElementById("btn-sel-cut")?.addEventListener("click", (e) => {
    e.stopPropagation();
    cutSelection();
  });
  document.getElementById("btn-sel-paste")?.addEventListener("click", (e) => {
    e.stopPropagation();
    pasteClipboard();
  });
  document.getElementById("btn-sel-delete")?.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteSelection();
  });
  document.getElementById("btn-paste-here")?.addEventListener("click", (e) => {
    e.stopPropagation();
    pasteClipboard();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cropState) {
      e.preventDefault();
      cancelCropMode();
    }
    // Entf/Backspace loescht die Auswahl (nicht beim Tippen in Feldern)
    const typing = e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.target.tagName));
    if (!typing && !textEdit && selection.ids.size && !cropState && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      deleteSelection();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") spacePressed = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") spacePressed = false;
  });

  function pointerPressure(e) {
    if (e.pointerType === "pen") return e.pressure > 0 ? e.pressure : 0.5;
    if (e.pointerType === "mouse") return 1;
    return e.pressure > 0 ? e.pressure : 0.5;
  }

  function startStroke(pointerId, pointerType, wx, wy, pressure) {
    clearSelection();
    const id = uuid();
    const tool = currentTool === "marker" ? "marker" : "pen";
    const size = activeSize();
    currentStroke = {
      id,
      tool,
      color: currentColor,
      size,
      points: [{ x: wx, y: wy, p: pressure }],
      ownerId: myClientId,
      unsent: [],
      pointerId,
      pointerType,
      locked: false,
    };
    wsSend({ type: "stroke_start", strokeId: id, tool, color: currentColor, size, points: currentStroke.points });
    if (isHoldSnapTool(tool)) armHoldTimer();
    requestRedraw();
  }

  function extendStroke(wx, wy, pressure) {
    if (!currentStroke) return;
    if (currentStroke.locked) {
      reshapeLockedStroke(wx, wy);
      return;
    }
    const last = currentStroke.points[currentStroke.points.length - 1];
    const dist = last ? Math.hypot(wx - last.x, wy - last.y) : 0;
    if (last && dist < MIN_MOVE_WORLD) return;
    if (last && dist > GAP_FILL_WORLD) {
      const steps = Math.min(12, Math.ceil(dist / GAP_FILL_WORLD));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const pt = {
          x: last.x + (wx - last.x) * t,
          y: last.y + (wy - last.y) * t,
          p: (last.p || 0.5) * (1 - t) + pressure * t,
        };
        currentStroke.points.push(pt);
        currentStroke.unsent.push(pt);
      }
    }
    const point = { x: wx, y: wy, p: pressure };
    currentStroke.points.push(point);
    currentStroke.unsent.push(point);
    if (isHoldSnapTool(currentStroke.tool)) armHoldTimer();
    requestRedraw();
  }

  // Safari auf dem iPad liefert in getCoalescedEvents() oft auch die Punkte des vorigen
  // pointermove noch einmal mit. Ohne Filter landete jeder Abschnitt doppelt im Strich
  // (vor - zurueck - nochmal vor), was u. a. die Kritzel-Erkennung unbrauchbar machte.
  // Darum nur Punkte nehmen, die neuer sind als der zuletzt verarbeitete dieses Zeigers.
  const lastCoalescedT = new Map(); // pointerId -> timeStamp
  function coalescedEvents(e) {
    let list = [];
    if (typeof e.getCoalescedEvents === "function") {
      try {
        list = e.getCoalescedEvents();
      } catch (err) {
        list = [];
      }
    }
    if (!list || list.length === 0) list = [e];
    const last = lastCoalescedT.get(e.pointerId);
    let maxT = last == null ? -Infinity : last;
    const out = [];
    for (const ev of list) {
      const t = ev.timeStamp;
      if (!t) {
        out.push(ev); // ohne Zeitstempel nicht filtern
        continue;
      }
      if (last != null && !(t > last)) continue;
      out.push(ev);
      if (t > maxT) maxT = t;
    }
    if (Number.isFinite(maxT)) lastCoalescedT.set(e.pointerId, maxT);
    return out;
  }

  function strokePathLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return len;
  }

  function countDirectionReversals(pts) {
    const dirs = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const len = Math.hypot(dx, dy);
      if (len < 5) continue;
      dirs.push({ dx: dx / len, dy: dy / len });
    }
    let n = 0;
    for (let i = 1; i < dirs.length; i++) {
      if (dirs[i].dx * dirs[i - 1].dx + dirs[i].dy * dirs[i - 1].dy < -0.12) n++;
    }
    return n;
  }

  function looksLikeStrikeGesture(pts) {
    const pointerType = (currentStroke && currentStroke.pointerType) || "pen";
    return window.SofiaInk && SofiaInk.looksLikeStrikeGesture
      ? SofiaInk.looksLikeStrikeGesture(pts, pointerType)
      : false;
  }

  function strikeCrossesStroke(poly, stroke) {
    const b = stroke.bbox;
    if (!b) return false;
    const mouse = currentStroke && currentStroke.pointerType === "mouse";
    if (stroke.tool === "text" || stroke.tool === "image") {
      for (const q of poly) {
        if (q.x >= b.minX && q.x <= b.maxX && q.y >= b.minY && q.y <= b.maxY) return true;
      }
      return false;
    }
    const hitR = Math.max(mouse ? 8 : 10, stroke.size * 0.65 + (mouse ? 4 : 6));
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    const diag = Math.hypot(bw, bh);
    const innerPadX = bw * (mouse ? 0.08 : 0.2);
    const innerPadY = bh * (mouse ? 0.08 : 0.2);
    let hits = 0;
    let interiorHits = 0;
    let firstI = -1;
    let lastI = -1;
    for (let i = 0; i < poly.length; i++) {
      const q = poly[i];
      if (q.x < b.minX - hitR || q.x > b.maxX + hitR || q.y < b.minY - hitR || q.y > b.maxY + hitR) continue;
      let near = false;
      for (const p of stroke.points) {
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        if (dx * dx + dy * dy <= hitR * hitR) {
          near = true;
          break;
        }
      }
      if (!near && stroke.points.length >= 2) {
        for (let j = 1; j < stroke.points.length; j++) {
          if (perpDist(q, stroke.points[j - 1], stroke.points[j]) <= hitR) {
            near = true;
            break;
          }
        }
      }
      if (!near) continue;
      hits++;
      if (firstI < 0) firstI = i;
      lastI = i;
      if (q.x >= b.minX + innerPadX && q.x <= b.maxX - innerPadX && q.y >= b.minY + innerPadY && q.y <= b.maxY - innerPadY) {
        interiorHits++;
      }
    }
    if (hits === 0) return false;
    if (diag < 18) return hits >= 1;
    if (mouse && hits >= 2) return true;
    if (interiorHits === 0) return false;
    return lastI > firstI || hits >= 2;
  }

  // Durchkritzeln loescht nur Tinte, die das Gekritzel ueberwiegend ueberdeckt (mind. die
  // Haelfte ihrer Punkte im Gekritzel-Bereich und tatsaechlich beruehrt) - lange Striche,
  // die nur am Rand gestreift werden, bleiben.
  function findStruckStrokes(pts) {
    if (!looksLikeStrikeGesture(pts)) return [];
    const mouse = currentStroke && currentStroke.pointerType === "mouse";
    const ink = [];
    for (const stroke of boardStrokes.values()) if (!isObjectStroke(stroke)) ink.push(stroke);
    if (mouse) return ink.filter((stroke) => strikeCrossesStroke(pts, stroke));
    // nur Tinte in der Naehe pruefen (schnell auch bei vollen Blaettern)
    const sb = makeBBox(pts);
    const m = 40;
    const near = ink.filter((st) => {
      const b = st.bbox || strokeWorldBBox(st);
      return b && b.maxX >= sb.minX - m && b.minX <= sb.maxX + m && b.maxY >= sb.minY - m && b.minY <= sb.maxY + m;
    });
    return SofiaInk.scribbleTargets(pts, near);
  }

  function endStroke() {
    if (!currentStroke) return;
    clearHoldTimer();
    // Durchstreichen loescht - aber nicht bei Lineal-Strichen (die sind immer gerade und
    // laufen oft absichtlich an anderer Tinte entlang)
    if (currentStroke.tool === "pen" && !currentStroke.locked && !currentStroke.rulerEdge) {
      const struck = findStruckStrokes(currentStroke.points);
      if (struck.length > 0) {
        wsSend({ type: "stroke_abort", strokeId: currentStroke.id });
        const clones = struck.map((s) => cloneStroke(s));
        const ids = struck.map((s) => s.id);
        for (const id of ids) {
          noteShapeRemoved(id);
          boardStrokes.delete(id);
          pendingErase.add(id);
        }
        wsSend({ type: "erase", strokeIds: ids });
        pendingErase.clear();
        pushUndo({ type: "erase", strokes: clones });
        currentStroke = null;
        requestRedraw();
        return;
      }
    }
    if (currentStroke.unsent.length > 0) {
      wsSend({ type: "stroke_points", strokeId: currentStroke.id, points: currentStroke.unsent });
      currentStroke.unsent = [];
    }
    // Am Lineal gezogen: als echte Linie speichern (zwei Endpunkte, spaeter verschiebbar)
    if (currentStroke.rulerEdge && !currentStroke.locked && currentStroke.points.length >= 2) {
      const pts = currentStroke.points;
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 2) {
        const p = pts.reduce((sum, q) => sum + (q.p || 0.5), 0) / pts.length;
        currentStroke.points = [{ x: a.x, y: a.y, p }, { x: b.x, y: b.y, p }];
        currentStroke.extra = Object.assign({}, currentStroke.extra || {}, { shape: "line" });
        wsSend({ type: "stroke_replace", strokeId: currentStroke.id, points: currentStroke.points, extra: currentStroke.extra });
      }
    }
    wsSend({ type: "stroke_end", strokeId: currentStroke.id, extra: currentStroke.extra || null });
    tagShape(currentStroke);
    currentStroke.bbox = makeBBox(currentStroke.points);
    currentStroke.endedAt = performance.now();
    const finishedId = currentStroke.id;
    const selectShape = !!(currentStroke.locked && currentStroke.extra && currentStroke.extra.shape);
    boardStrokes.set(currentStroke.id, currentStroke);
    pushUndo({ type: "add", stroke: cloneStroke(currentStroke) });
    currentStroke = null;
    if (selectShape) selectStrokeIds([finishedId]);
    requestRedraw();
  }

  function abortStroke() {
    if (!currentStroke) return;
    clearHoldTimer();
    wsSend({ type: "stroke_abort", strokeId: currentStroke.id });
    currentStroke = null;
    requestRedraw();
  }

  function eraseHitsStroke(stroke, sx, sy, r) {
    const b = stroke.bbox || strokeWorldBBox(stroke);
    if (!b) return false;
    if (sx < b.minX - r || sx > b.maxX + r || sy < b.minY - r || sy > b.maxY + r) return false;
    if (stroke.tool === "image") {
      const quad = imageRotatedCorners(stroke);
      if (quad.length === 4) return pointInPolygon({ x: sx, y: sy }, quad);
      return sx >= b.minX && sx <= b.maxX && sy >= b.minY && sy <= b.maxY;
    }
    if (stroke.tool === "text") {
      return sx >= b.minX - r && sx <= b.maxX + r && sy >= b.minY - r && sy <= b.maxY + r;
    }
    const hitR = r + (stroke.size || 6) / 2;
    const pts = stroke.points || [];
    if (pts.length === 0) return false;
    if (pts.length === 1) return Math.hypot(pts[0].x - sx, pts[0].y - sy) <= hitR;
    for (let i = 1; i < pts.length; i++) {
      if (distPointToSeg({ x: sx, y: sy }, pts[i - 1], pts[i]) <= hitR) return true;
    }
    return false;
  }

  function eraseSegment(x0, y0, x1, y1) {
    const r = eraserSize / 2;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / Math.max(4, r * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = x0 + (x1 - x0) * t;
      const sy = y0 + (y1 - y0) * t;
      for (const stroke of boardStrokes.values()) {
        if (erasedThisGesture.has(stroke.id)) continue;
        // Eingefuegte Bilder/PDFs, Textfelder und Tabellen sind keine Tinte: der Radierer
        // laesst sie stehen (loeschen geht ueber Auswahl -> Ausschneiden).
        if (isObjectStroke(stroke)) continue;
        if (!eraseHitsStroke(stroke, sx, sy, r)) continue;
        erasedThisGesture.add(stroke.id);
        erasedStrokesThisGesture.set(stroke.id, cloneStroke(stroke));
      }
    }
    if (erasedThisGesture.size > 0) {
      for (const id of erasedThisGesture) {
        noteShapeRemoved(id);
        boardStrokes.delete(id);
        pendingErase.add(id);
      }
      requestRedraw();
    }
  }

  function updateEraserCursor(clientX, clientY) {
    eraserCursorEl.style.display = "block";
    eraserCursorEl.style.left = clientX + "px";
    eraserCursorEl.style.top = clientY + "px";
    const diameterScreen = eraserSize * scale;
    eraserCursorEl.style.width = diameterScreen + "px";
    eraserCursorEl.style.height = diameterScreen + "px";
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function cropRectWorld() {
    const full = cropState.full;
    const crop = cropState.crop;
    return {
      minX: full.minX + crop.l * full.w,
      minY: full.minY + crop.t * full.h,
      maxX: full.minX + crop.r * full.w,
      maxY: full.minY + crop.b * full.h,
    };
  }

  // Trifft dieser Punkt die bestehende Auswahl (Rahmen, Griffe, Knoten) bzw. den Zuschnitt?
  // Fuer Finger mit groesserem Greifbereich.
  function selectionHitAt(world, pointerType) {
    const touch = pointerType === "touch";
    const slop = touch ? TOUCH_SLOP : 1;
    if (cropState && (pickCropHandle(world, slop) || pointInBBox(world, cropRectWorld(), 0))) return true;
    if (!selection.bbox) return false;
    const pad = SELECT_PAD_PX / scale;
    return (
      (!cropState &&
        ((!touch && !!pickEditKnot(world)) ||
          !!pickScaleHandle(world, selection.bbox, pad, slop) ||
          pickRotateHandle(world, selection.bbox, pad, slop))) ||
      pointInBBox(world, selection.bbox, (touch ? SELECT_PAD_TOUCH_PX : SELECT_PAD_PX) / scale)
    );
  }

  // Startet eine Interaktion mit der bestehenden Auswahl (Zuschnitt, Knoten, Skalieren, Drehen,
  // Verschieben). Rueckgabe: "crop" | "handle" | "move" oder null, wenn nichts getroffen wurde.
  function grabSelectionAt(e, world) {
    const touch = e.pointerType === "touch";
    const slop = touch ? TOUCH_SLOP : 1;
    if (cropState) {
      const handle = pickCropHandle(world, slop);
      if (handle || pointInBBox(world, cropRectWorld(), 0)) {
        cropState.pointerId = e.pointerId;
        cropState.handle = handle || "move";
        cropState.startCrop = { ...cropState.crop };
        cropState.startWorld = world;
        return "crop";
      }
    }
    if (!selection.bbox) return null;
    const pad = SELECT_PAD_PX / scale;
    let kind = null;
    // ausgewaehlte Tabelle: innere Linien greifen -> Spalte/Zeile breiter oder schmaler
    const selTable = cropState ? null : selectedTable();
    const tline = selTable && !pickScaleHandle(world, selection.bbox, pad, slop) ? tableLineAt(selTable, world, touch ? 14 : 8) : null;
    if (tline) {
      const g = tableGeom(selTable);
      dragState = {
        pointerId: e.pointerId,
        startWorld: world,
        kind: "tblline",
        tableId: selTable.id,
        axis: tline.axis,
        i: tline.i,
        cw0: g.xs.slice(1).map((x, i) => x - g.xs[i]),
        rh0: g.ys.slice(1).map((y, i) => y - g.ys[i]),
        pointerType: e.pointerType,
        ...snapshotSelection(),
      };
      return "handle";
    }
    // Einzelne Knoten verbiegen ist Feinarbeit fuer Stift/Maus; ein Finger wuerde dabei
    // ungewollt die Form verziehen statt die Auswahl zu verschieben.
    const knot = cropState || touch ? null : pickEditKnot(world);
    const handle = cropState || knot ? null : pickScaleHandle(world, selection.bbox, pad, slop);
    if (knot) {
      startPointEdit(e.pointerId, world, knot);
      kind = "handle";
    } else if (handle) {
      startSelectionScale(e.pointerId, world, handle);
      kind = "handle";
    } else if (!cropState && pickRotateHandle(world, selection.bbox, pad, slop)) {
      startSelectionRotate(e.pointerId, world);
      kind = "handle";
    } else if (pointInBBox(world, selection.bbox, (touch ? SELECT_PAD_TOUCH_PX : SELECT_PAD_PX) / scale)) {
      startSelectionDrag(e.pointerId, world);
      kind = "move";
    }
    if (kind && dragState) dragState.pointerType = e.pointerType;
    return kind;
  }

  function penIsDown() {
    for (const p of activePointers.values()) if (p.type === "pen") return true;
    return false;
  }

  // Finger-Tap (ohne Finger-Zeichnen) im Auswahl-Werkzeug: auf einen Strich tippen waehlt ihn aus,
  // daneben tippen hebt die Auswahl auf, in die Auswahl tippen laesst sie stehen.
  function handleFingerTap(e) {
    if (currentTool === "text") {
      if (textTapSuppressed === e.pointerId) {
        textTapSuppressed = null;
        return;
      }
      const world = screenToWorld(e.clientX, e.clientY);
      finishTextDrag({ startWorld: world, cur: world });
      return;
    }
    const world = screenToWorld(e.clientX, e.clientY);
    if (currentTool !== "select") {
      // in jedem Werkzeug: Finger-Tipp neben die Auswahl (oder den Zuschnitt) hebt sie auf
      if ((selection.ids.size > 0 || cropState) && !selectionHitAt(world, "touch")) {
        clearSelection();
        requestRedraw();
      }
      return;
    }
    if (selectionHitAt(world, "touch")) return;
    const hit = pickStrokeAt(world, SELECT_PAD_TOUCH_PX);
    if (hit) selectStrokeIds([hit.id]);
    else if (selection.ids.size > 0 || cropState) clearSelection();
  }

  function onSomePage(w) {
    return pageRects(notebook).some((r) => w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h);
  }
  function dispatchPrimaryDown(e) {
    if (historyView) return;
    const world = screenToWorld(e.clientX, e.clientY);
    // Notizbuch: neben den Seiten wird nicht geschrieben (Radierer und Lasso gehen ueberall)
    if (notebook && currentTool !== "eraser" && currentTool !== "select" && !onSomePage(world)) return;
    lastPointerWorld = world;
    if (currentTool === "text") {
      textDrag = { pointerId: e.pointerId, startWorld: world, cur: world };
      return;
    }
    // Stift/Marker greifen nur eine gerade eingerastete, noch ausgewaehlte Form (an ihren
    // Griffen oder am Strich selbst), um sie direkt weiterzuziehen. Ein Tap auf geschriebenen
    // Text markiert dagegen nie etwas - der Stift schreibt einfach.
    if (currentTool !== "eraser" && currentTool !== "select" && grabSelectedShapeWithPen(e, world)) {
      sendCursor(world.x, world.y, currentTool, activeSize());
      return;
    }
    if (currentTool === "select") {
      if (dragState && dragState.pointerId !== e.pointerId) {
        // Setzt der Stift auf, waehrend ein "Finger" die Auswahl zieht, war das fast
        // sicher der Handballen -> dessen Verschiebung verwerfen statt uebernehmen.
        if (e.pointerType === "pen" && dragState.pointerType === "touch") cancelSelectionDrag();
        else finalizeSelectionDrag();
      }
      const grabbed = grabSelectionAt(e, world);
      if (grabbed && grabbed !== "move") return;
      if (!grabbed) {
        clearSelection();
        lassoPointerId = e.pointerId;
        lassoPoints = [world];
      }
    } else if (currentTool === "eraser") {
      erasedThisGesture.clear();
      erasedStrokesThisGesture.clear();
      currentStroke = { pointerId: e.pointerId, eraser: true, lastX: world.x, lastY: world.y, startX: e.clientX, startY: e.clientY };
      eraseSegment(world.x, world.y, world.x, world.y);
      updateEraserCursor(e.clientX, e.clientY);
    } else {
      const edges = e.pointerType === "touch" && !fingerDrawEnabled ? [] : rulerEdgesAt(e.clientX, e.clientY);
      const edge = edges[0];
      if (edge) {
        const q = rulerProject(e.clientX, e.clientY, edge);
        const w0 = screenToWorld(q.x, q.y);
        startStroke(e.pointerId, e.pointerType, w0.x, w0.y, pointerPressure(e));
        currentStroke.rulerEdge = edge;
        if (edges.length > 1) {
          currentStroke.rulerCands = edges;
          currentStroke.rulerStart = { x: e.clientX, y: e.clientY };
        }
        clearHoldTimer();
      } else {
        startStroke(e.pointerId, e.pointerType, world.x, world.y, pointerPressure(e));
      }
    }
    sendCursor(world.x, world.y, currentTool, activeSize());
    armPasteHold(e, world);
  }

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    stopFling();
    // Vorschau einer alten Version: nur ansehen (Finger/Maus verschieben, nicht schreiben)
    if (historyView && e.pointerType !== "touch") {
      if (e.pointerType === "mouse") {
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch (err) {}
        panState = { lastX: e.clientX, lastY: e.clientY, pointerId: e.pointerId };
      }
      return;
    }
    // Laufende Texteingabe: ein Tap aufs Blatt schliesst sie ab. Im Text-Werkzeug ist das
    // alles, was der Tap tut (wie in GoodNotes) - sonst entstuende sofort das naechste Feld.
    if (textEdit) {
      commitTextEditor();
      if (currentTool === "text") {
        if (e.pointerType !== "touch" || fingerDrawEnabled) return;
        textTapSuppressed = e.pointerId; // dieser Finger-Tap hat nur die Eingabe beendet
      }
    }
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount) sel.removeAllRanges();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      // manche Browser/synthetische Events lehnen Pointer Capture ab - Zeichnen soll trotzdem funktionieren
    }
    if (e.pointerType === "touch" && looksLikePalm(e)) {
      palmIds.add(e.pointerId);
      return;
    }
    if (e.pointerType === "pen") penTookOver();
    activePointers.set(e.pointerId, { type: e.pointerType, x: e.clientX, y: e.clientY });

    if (e.pointerType === "touch") {
      if (!touchPointers.size) touchGestureView = { scale, offsetX, offsetY };
      touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (rulerGesture && touchPointers.size === 2) {
        // zweiter Finger zum ersten aufs Lineal: drehen statt zoomen
        tapState = null;
        startRulerGesture();
        return;
      }
      if (touchPointers.size === 1 && ruler.visible && !fingerDrawEnabled && rulerHit(e.clientX, e.clientY)) {
        tapState = null;
        panState = null;
        startRulerGesture();
        return;
      }
      if (touchPointers.size >= 2 && zoomBoxDrag && zoomBoxDrag.canvas) zoomBoxDrag = null;
      if (touchPointers.size === 2) {
        tapState = null;
        if (currentStroke) abortStroke();
        if (dragState) cancelSelectionDrag();
        pendingShapeDrag = null;
        lassoPoints = null;
        lassoPointerId = null;
        erasedThisGesture.clear();
        panState = null;
        const pts = Array.from(touchPointers.values());
        const mid = midpoint(pts[0], pts[1]);
        pinchState = {
          initialDist: distance(pts[0], pts[1]),
          initialScale: scale,
          anchorWorld: screenToWorld(mid.x, mid.y),
        };
        return;
      }
      if (touchPointers.size === 1) {
        const world = screenToWorld(e.clientX, e.clientY);
        if (!pinchState && currentTool !== "select" && !penIsDown() && zoomFrameHit(e.clientX, e.clientY)) {
          tapState = null;
          panState = null;
          startCanvasZoomDrag(e);
          return;
        }
        if (fingerDrawEnabled && !pinchState) {
          dispatchPrimaryDown(e);
          return;
        }
        if (!pinchState) {
          // Liegt der Stift gerade auf, ist dieser Touch der Handballen: nicht greifen, nicht tippen.
          const palm = penIsDown();
          // Auswahl laesst sich auch ohne Finger-Zeichnen mit dem Finger verschieben,
          // skalieren, drehen und zuschneiden.
          if (!palm && (currentTool === "select" || selection.ids.size > 0 || cropState) && !dragState && grabSelectionAt(e, world)) {
            requestRedraw();
            return;
          }
          panState = { lastX: e.clientX, lastY: e.clientY };
          if (!palm) tapState = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
        }
        if (!fingerDrawEnabled) armPasteHold(e, screenToWorld(e.clientX, e.clientY));
      }
      return;
    }

    tapState = null; // Stift/Maus beruehrt -> ein laufender Finger-Kontakt ist kein Tap mehr
    if (e.pointerType === "mouse" && e.button === 0 && ruler.visible && rulerHit(e.clientX, e.clientY, 0)) {
      mouseRulerDrag = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY };
      return;
    }
    if (e.pointerType === "mouse" && (spacePressed || e.button === 1)) {
      panState = { lastX: e.clientX, lastY: e.clientY, pointerId: e.pointerId };
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (currentTool !== "select" && zoomFrameHit(e.clientX, e.clientY)) {
      startCanvasZoomDrag(e);
      return;
    }

    dispatchPrimaryDown(e);
  }, { passive: false });

  canvas.addEventListener("pointermove", (e) => {
    if (palmIds.has(e.pointerId)) return;
    if (e.pointerType === "touch" && penRecentlyUsed() && (e.width || 0) >= PALM_CONTACT_PX * 1.3 && !currentStroke) {
      // Kontakt ist beim Auflegen gewachsen -> doch Handballen: Geste abbrechen
      palmIds.add(e.pointerId);
      penTookOverTouchOnly(e.pointerId);
      return;
    }
    if (e.pointerType === "pen") notePenActivity();
    notePasteHoldMove(e);
    activePointers.set(e.pointerId, { type: e.pointerType, x: e.clientX, y: e.clientY });
    if (zoomBoxDrag && zoomBoxDrag.canvas && zoomBoxDrag.pointerId === e.pointerId) {
      if (e.pointerType === "touch") touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moveZoomBoxDrag(e);
      return;
    }

    if (e.pointerType === "touch") {
      touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (tapState && tapState.pointerId === e.pointerId && Math.hypot(e.clientX - tapState.x, e.clientY - tapState.y) > TAP_MAX_MOVE_PX) {
        tapState = null;
      }
      if (rulerGesture) {
        updateRulerGesture();
        return;
      }
      if (pinchState && touchPointers.size === 2) {
        const pts = Array.from(touchPointers.values());
        const mid = midpoint(pts[0], pts[1]);
        const dist = distance(pts[0], pts[1]);
        const newScale = clampZoom(pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist)));
        scale = newScale;
        offsetX = mid.x - pinchState.anchorWorld.x * scale;
        offsetY = mid.y - pinchState.anchorWorld.y * scale;
        requestRedraw();
        return;
      }
      const isActiveDrawTouch =
        (textDrag && textDrag.pointerId === e.pointerId) ||
        (dragState && dragState.pointerId === e.pointerId) ||
        (pendingShapeDrag && pendingShapeDrag.pointerId === e.pointerId) ||
        (cropState && cropState.pointerId === e.pointerId) ||
        lassoPointerId === e.pointerId ||
        (currentStroke && currentStroke.pointerId === e.pointerId);
      if (!isActiveDrawTouch) {
        if (panState && touchPointers.size === 1) {
          const dx = e.clientX - panState.lastX;
          const dy = e.clientY - panState.lastY;
          offsetX += dx;
          offsetY += dy;
          // Geschwindigkeit fuer das Weiterlaufen nach dem Loslassen
          const now = performance.now();
          const dt = Math.max(1, now - (panState.t || now - 16));
          panState.vx = 0.7 * (dx / dt) + 0.3 * (panState.vx || 0);
          panState.vy = 0.7 * (dy / dt) + 0.3 * (panState.vy || 0);
          panState.t = now;
          panState.lastX = e.clientX;
          panState.lastY = e.clientY;
          requestRedraw();
        }
        return;
      }
      // aktiver Finger-Zeichnen-Pointer: faellt durch zur gemeinsamen Logik unten
    } else if (mouseRulerDrag && mouseRulerDrag.pointerId === e.pointerId) {
      ruler.cx += e.clientX - mouseRulerDrag.lastX;
      ruler.cy += e.clientY - mouseRulerDrag.lastY;
      mouseRulerDrag.lastX = e.clientX;
      mouseRulerDrag.lastY = e.clientY;
      requestRedraw();
      return;
    } else if (panState && (panState.pointerId === undefined || panState.pointerId === e.pointerId)) {
      offsetX += e.clientX - panState.lastX;
      offsetY += e.clientY - panState.lastY;
      panState.lastX = e.clientX;
      panState.lastY = e.clientY;
      requestRedraw();
      return;
    }

    const world = screenToWorld(e.clientX, e.clientY);
    lastPointerWorld = world;

    if (currentTool === "eraser") {
      updateEraserCursor(e.clientX, e.clientY);
    }

    if (textDrag && textDrag.pointerId === e.pointerId) {
      textDrag.cur = world;
      requestRedraw();
    } else if (pendingShapeDrag && pendingShapeDrag.pointerId === e.pointerId) {
      const moved = Math.hypot(e.clientX - pendingShapeDrag.clientX, e.clientY - pendingShapeDrag.clientY);
      if (moved > 9) {
        startSelectionDrag(pendingShapeDrag.pointerId, pendingShapeDrag.startWorld);
        pendingShapeDrag = null;
        if (touchPointers.size >= 2) {
          cancelSelectionDrag();
          return;
        }
        updateSelectionDrag(world);
      }
    } else if (cropState && cropState.pointerId === e.pointerId) {
      updateCropDrag(world);
      requestRedraw();
    } else if (dragState && dragState.pointerId === e.pointerId) {
      if (touchPointers.size >= 2) {
        cancelSelectionDrag();
        return;
      }
      if (dragState.kind === "scale") updateSelectionScale(world);
      else if (dragState.kind === "rotate") updateSelectionRotate(world);
      else if (dragState.kind === "point") updatePointEdit(world);
      else if (dragState.kind === "tblline") updateTableLineDrag(world);
      else updateSelectionDrag(world);
    } else if (lassoPointerId === e.pointerId && lassoPoints) {
      if (touchPointers.size >= 2) {
        lassoPoints = null;
        lassoPointerId = null;
        return;
      }
      lassoPoints.push(world);
      requestRedraw();
    } else if (currentStroke && currentStroke.pointerId === e.pointerId) {
      if (touchPointers.size >= 2) {
        if (currentStroke.eraser) currentStroke = null;
        else abortStroke();
        return;
      }
      if (currentStroke.eraser) {
        for (const ev of coalescedEvents(e)) {
          const w = screenToWorld(ev.clientX, ev.clientY);
          eraseSegment(currentStroke.lastX, currentStroke.lastY, w.x, w.y);
          currentStroke.lastX = w.x;
          currentStroke.lastY = w.y;
        }
      } else {
        for (const ev of coalescedEvents(e)) {
          // am Lineal: jeder Punkt wird exakt auf die Kante gelegt
          if (currentStroke.rulerCands) resolveRulerEdge(currentStroke, ev.clientX, ev.clientY);
          const q = currentStroke.rulerEdge ? rulerProject(ev.clientX, ev.clientY, currentStroke.rulerEdge) : { x: ev.clientX, y: ev.clientY };
          const w = screenToWorld(q.x, q.y);
          extendStroke(w.x, w.y, pointerPressure(ev));
        }
      }
    }

    sendCursor(world.x, world.y, currentTool, activeSize());
  });

  // ein einzelner Finger stellt sich als Handballen heraus: seine Geste zuruecknehmen
  function penTookOverTouchOnly(id) {
    if (!touchPointers.has(id)) return;
    if (touchGestureView && (pinchState || panState)) {
      scale = touchGestureView.scale;
      offsetX = touchGestureView.offsetX;
      offsetY = touchGestureView.offsetY;
      requestRedraw();
    }
    touchPointers.delete(id);
    activePointers.delete(id);
    pinchState = null;
    if (panState && panState.pointerId === undefined) panState = null;
    tapState = null;
  }

  function endPointer(e) {
    if (palmIds.has(e.pointerId)) {
      palmIds.delete(e.pointerId);
      return;
    }
    if (e.pointerType === "pen") notePenActivity();
    const consumed = pasteHoldConsumed;
    clearPasteHold();
    activePointers.delete(e.pointerId);
    if (zoomBoxDrag && zoomBoxDrag.canvas && zoomBoxDrag.pointerId === e.pointerId) {
      zoomBoxDrag = null;
      if (zoomWin) zoomWin.y = snapZoomY(zoomWin.y);
      touchPointers.delete(e.pointerId);
      requestRedraw();
      return;
    }

    if (consumed) {
      pasteHoldConsumed = false;
      tapState = null;
      if (e.pointerType === "touch") {
        touchPointers.delete(e.pointerId);
        if (touchPointers.size < 2) pinchState = null;
        if (touchPointers.size === 0) panState = null;
      } else if (panState && (panState.pointerId === undefined || panState.pointerId === e.pointerId)) {
        panState = null;
      }
      if (lassoPointerId === e.pointerId) {
        lassoPointerId = null;
        lassoPoints = null;
      }
      if (currentStroke && currentStroke.pointerId === e.pointerId) {
        if (currentStroke.eraser) currentStroke = null;
        else abortStroke();
      }
      if (currentTool === "eraser") eraserCursorEl.style.display = "none";
      requestRedraw();
      return;
    }

    if (e.pointerType === "touch") {
      touchPointers.delete(e.pointerId);
      if (rulerGesture) {
        if (touchPointers.size === 0) {
          // kurzes Antippen ohne Verschieben: Gradzahl direkt eintippen
          const g = rulerGesture;
          rulerGesture = null;
          if (g.tap && !g.moved && performance.now() - g.tap.t < 400) openRulerAngleInput(g.tap.x, g.tap.y);
        } else startRulerGesture(); // mit dem verbliebenen Finger nahtlos weiterschieben
        return;
      }
      if (touchPointers.size < 2) pinchState = null;
      if (touchPointers.size === 0) {
        if (panState && e.type === "pointerup" && !(window.sofiaPageSnap && window.sofiaPageSnap(panState))) startFling(panState);
        else if (!panState && window.sofiaPageSnap) window.sofiaPageSnap({}); // nach dem Zoomen mit zwei Fingern
        panState = null;
      }
      if (tapState && tapState.pointerId === e.pointerId) {
        const isTap =
          e.type === "pointerup" &&
          performance.now() - tapState.t <= TAP_MAX_MS &&
          Math.hypot(e.clientX - tapState.x, e.clientY - tapState.y) <= TAP_MAX_MOVE_PX;
        tapState = null;
        if (isTap) handleFingerTap(e);
      }
      const wasActiveDrawTouch =
        (textDrag && textDrag.pointerId === e.pointerId) ||
        (dragState && dragState.pointerId === e.pointerId) ||
        (pendingShapeDrag && pendingShapeDrag.pointerId === e.pointerId) ||
        (cropState && cropState.pointerId === e.pointerId) ||
        lassoPointerId === e.pointerId ||
        (currentStroke && currentStroke.pointerId === e.pointerId);
      if (!wasActiveDrawTouch) {
        if (pendingShapeDrag && pendingShapeDrag.pointerId === e.pointerId) pendingShapeDrag = null;
        return;
      }
      // aktiver Finger-Zeichnen-Pointer: faellt durch zur gemeinsamen Abschluss-Logik unten
    } else if (mouseRulerDrag && mouseRulerDrag.pointerId === e.pointerId) {
      const md = mouseRulerDrag;
      mouseRulerDrag = null;
      if (Math.hypot(e.clientX - md.startX, e.clientY - md.startY) < 4) openRulerAngleInput(e.clientX, e.clientY);
      return;
    } else if (panState && (panState.pointerId === undefined || panState.pointerId === e.pointerId)) {
      panState = null;
      return;
    }

    if (pendingShapeDrag && pendingShapeDrag.pointerId === e.pointerId) {
      pendingShapeDrag = null;
    }

    if (textDrag && textDrag.pointerId === e.pointerId) {
      const drag = textDrag;
      textDrag = null;
      if (e.type === "pointerup") finishTextDrag(drag);
      requestRedraw();
      return;
    }

    if (cropState && cropState.pointerId === e.pointerId) {
      cropState.pointerId = null;
      cropState.handle = null;
      return;
    }
    if (dragState && dragState.pointerId === e.pointerId) {
      finalizeSelectionDrag();
      requestRedraw();
      return;
    }
    if (lassoPointerId === e.pointerId) {
      lassoPointerId = null;
      finalizeLasso();
      return;
    }

    if (currentStroke && currentStroke.pointerId === e.pointerId) {
      if (currentStroke.eraser) {
        let keepEraser = false;
        if (pendingErase.size > 0) {
          wsSend({ type: "erase", strokeIds: Array.from(pendingErase) });
          pendingErase.clear();
        }
        if (erasedStrokesThisGesture.size > 0) {
          pushUndo({ type: "erase", strokes: Array.from(erasedStrokesThisGesture.values()) });
          erasedStrokesThisGesture.clear();
        } else {
          const tap =
            currentStroke.startX != null &&
            Math.hypot(e.clientX - currentStroke.startX, e.clientY - currentStroke.startY) < 18;
          if (tap && boardStrokes.size) {
            showEraseAllMenu(e.clientX, e.clientY);
            keepEraser = true;
          }
        }
        currentStroke = null;
        restoreToolAfterEraser({ keepEraser });
      } else {
        endStroke();
      }
    }
    if (currentTool === "eraser") {
      eraserCursorEl.style.display = "none";
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  // Sicherheitsnetz: geht ein "Finger hoch" verloren (Pointer-Capture weg, Overlay,
  // iOS-Gesten), bliebe ein Geister-Finger in touchPointers haengen - dann gaebe es nie
  // wieder genau zwei Finger und Zoomen/Verschieben mit den Fingern ginge nicht mehr.
  const dropTouch = (e) => {
    if (e.pointerType !== "touch" || e.target === canvas) return;
    if (touchPointers.has(e.pointerId)) {
      touchPointers.delete(e.pointerId);
      activePointers.delete(e.pointerId);
      if (touchPointers.size < 2) pinchState = null;
      if (touchPointers.size === 0) panState = null;
    }
  };
  window.addEventListener("pointerup", dropTouch, true);
  window.addEventListener("pointercancel", dropTouch, true);
  const resetTouches = (e) => {
    if (e.touches && e.touches.length > 0) return;
    palmIds.clear();
    if (!touchPointers.size) return;
    touchPointers.clear();
    for (const [id, p] of activePointers) if (p.type === "touch") activePointers.delete(id);
    pinchState = null;
    panState = null;
    rulerGesture = null;
  };
  window.addEventListener("touchend", (e) => setTimeout(() => resetTouches(e), 0), { capture: true, passive: true });
  window.addEventListener("touchcancel", (e) => setTimeout(() => resetTouches(e), 0), { capture: true, passive: true });
  canvas.addEventListener("pointerleave", (e) => {
    if (currentTool === "eraser" && !activePointers.has(e.pointerId)) {
      eraserCursorEl.style.display = "none";
    }
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // Shift + Mausrad ueber dem Lineal dreht es (Desktop)
      if (ruler.visible && e.shiftKey && rulerHit(e.clientX, e.clientY, 0)) {
        ruler.angle = snapRulerAngle(ruler.angle + Math.sign(e.deltaY || e.deltaX) * (Math.PI / 180));
        syncRulerBar();
        requestRedraw();
        return;
      }
      const anchor = screenToWorld(e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * 0.0015);
      scale = clampZoom(scale * factor);
      offsetX = e.clientX - anchor.x * scale;
      offsetY = e.clientY - anchor.y * scale;
      requestRedraw();
      // Notizbuch: kurz nach dem letzten Drehen wieder auf eine Seite einrasten
      clearTimeout(wheelSnapTimer);
      wheelSnapTimer = setTimeout(() => window.sofiaPageSnap && window.sofiaPageSnap({}), 260);
    },
    { passive: false }
  );
  let wheelSnapTimer = null;

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // Textfelder auf dem Blatt sind contenteditable - dort muss Markieren erlaubt bleiben
  const EDITABLE = "input, textarea, [contenteditable]";
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest && e.target.closest(EDITABLE)) return;
    e.preventDefault();
  });
  document.addEventListener("selectstart", (e) => {
    const el = e.target.nodeType === 1 ? e.target : e.target.parentElement;
    if (el && el.closest(EDITABLE)) return;
    e.preventDefault();
  });
  document.addEventListener("selectionchange", () => {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount) sel.removeAllRanges();
  });

  // ---- EMNIST / Cloudflare ink-on recognition overlay ----------------------
  const inkOverlay = document.getElementById("ink-overlay");
  let inkGroups = [];
  let recognizeTimer = null;
  let recognizeBusy = false;
  let recognizeAgain = false;
  let lastRecognizeFocus = null;
  let cloudOcrEnabled = null;
  let recognizeAbort = null;
  const dismissedInk = new Set();
  const ocrCache = new Map();
  let scanBoxes = [];
  let recognizeWide = false;
  let ocrRemaining = Infinity;
  const RECOGNIZE_PAUSE_MS = 1600;
  const CONTEXT_WAIT_MS = 1800;
  const WIDE_BURST_MS = 8000;
  const PX_PER_CM = 96 / 2.54;

  fetch("/api/recognize")
    .then((r) => r.json())
    .then((d) => {
      cloudOcrEnabled = !!(d && d.enabled);
      if (typeof d.remainingNeurons === "number") ocrRemaining = d.remainingNeurons;
    })
    .catch(() => {});

  function ensureEmnistLoaded() {
    if (typeof SofiaInk === "undefined") return;
    // TensorFlow erst nach dem Start im Hintergrund laden
    const go = () => SofiaInk.loadEmnistModel("/models/emnist/model.json");
    if (window.tf || !window.ensureTf) go();
    else window.ensureTf().then(go, () => {});
    SofiaInk.loadMemory();
  }

  function recognizeSelection() {
    const burst = selectedHandwriting();
    if (!burst.length) return;
    ensureEmnistLoaded();
    runRecognize(burst);
  }

  function positionInkChips() {
    if (!inkOverlay) return;
    const chips = inkOverlay.querySelectorAll(".ink-chip");
    const visible = inkGroups.filter((g) => !scanBoxes.some((b) => boxesOverlapBBox(b.bbox, g.bbox)));
    chips.forEach((el, i) => {
      const g = visible[i];
      if (!g) return;
      const s = worldToScreen(g.bbox.maxX + 8, g.bbox.minY - 6);
      el.style.left = Math.round(s.x) + "px";
      el.style.top = Math.round(s.y) + "px";
    });
  }

  function inkGroupKey(g) {
    return (g.strokeIds || []).slice().sort().join(",");
  }

  function renderInkCrop(strokes) {
    const boxes = strokes.map((s) => s.bbox || SofiaInk.bboxOfPoints(s.points || []));
    const b = unionBBox(boxes);
    const pad = 18;
    const w = Math.max(12, b.maxX - b.minX);
    const h = Math.max(12, b.maxY - b.minY);
    const scale = Math.min(4, 512 / Math.max(w, h));
    const cw = Math.max(32, Math.ceil((w + pad * 2) * scale));
    const ch = Math.max(32, Math.ceil((h + pad * 2) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const c = canvas.getContext("2d");
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, cw, ch);
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = "#111111";
    const toX = (x) => (x - b.minX + pad) * scale;
    const toY = (y) => (y - b.minY + pad) * scale;
    for (const s of strokes) {
      const pts = s.points || [];
      if (!pts.length) continue;
      c.lineWidth = Math.max(3.2, (s.size || 6) * scale * 0.55);
      const x0 = toX(pts[0].x);
      const y0 = toY(pts[0].y);
      if (pts.length === 1) {
        c.beginPath();
        c.fillStyle = "#111111";
        c.arc(x0, y0, c.lineWidth / 2, 0, Math.PI * 2);
        c.fill();
        continue;
      }
      c.beginPath();
      c.moveTo(x0, y0);
      for (let i = 1; i < pts.length; i++) c.lineTo(toX(pts[i].x), toY(pts[i].y));
      c.stroke();
    }
    return { dataUrl: canvas.toDataURL("image/png"), bbox: b };
  }

  function mergeInkGroups(local, cloud) {
    if (!cloud.length) return local;
    const cloudIds = new Set(cloud.flatMap((g) => g.strokeIds || []));
    const out = cloud.slice();
    for (const l of local) {
      const overlap = (l.strokeIds || []).some((id) => cloudIds.has(id));
      if (!overlap) out.push(l);
    }
    return out;
  }

  function insertTextStroke(text, x, y, color, size) {
    const id = uuid();
    const fontSize = size || 22;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    const w = ctx.measureText(text).width;
    ctx.restore();
    const stroke = {
      id,
      tool: "text",
      color: color || "#0b57d0",
      size: fontSize,
      points: [
        { x, y, p: 1, text },
        { x: x + w / Math.max(scale, 0.25), y: y - fontSize, p: 1 },
      ],
    };
    stroke.bbox = makeBBox(stroke.points);
    boardStrokes.set(id, stroke);
    wsSend({
      type: "stroke_move",
      stroke: serializeStroke(stroke),
    });
    pushUndo({ type: "add", stroke: cloneStroke(stroke) });
    requestRedraw();
  }

  function fillSpelledText(el, text, miss) {
    el.textContent = "";
    const spans = miss || [];
    if (!text) {
      el.textContent = "?";
      return;
    }
    if (!spans.length) {
      el.textContent = text;
      return;
    }
    let i = 0;
    for (const s of spans) {
      if (s.start > i) el.appendChild(document.createTextNode(text.slice(i, s.start)));
      const u = document.createElement("span");
      u.className = "ink-spell-err";
      u.textContent = text.slice(s.start, s.end);
      u.title = "Mögliche Rechtschreibung";
      el.appendChild(u);
      i = s.end;
    }
    if (i < text.length) el.appendChild(document.createTextNode(text.slice(i)));
  }

  async function attachSpelling(g, ac) {
    if (!g || !g.text) {
      if (g) g.misspelled = [];
      return;
    }
    const local = SofiaInk.correctText(g.text);
    if (local.changes.length) g.text = local.text;
    g.misspelled = SofiaInk.misspelledSpans(g.text);
    if (!/[A-Za-zÄÖÜäöüß]{3,}/.test(g.text)) return;
    try {
      const resp = await fetch("/api/spell", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ac && ac.signal,
        body: JSON.stringify({ text: g.text }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && data.suggestions && Object.keys(data.suggestions).length) {
        const hun = SofiaInk.correctText(g.text, data.suggestions);
        if (hun.changes.length) g.text = hun.text;
      }
      const extra = data && data.misspelled ? data.misspelled : [];
      g.misspelled = SofiaInk.misspelledSpans(g.text, extra);
    } catch (_err) {
      /* hunspell optional */
    }
  }

  function positionScanBoxes() {
    if (!inkOverlay) return;
    const boxes = inkOverlay.querySelectorAll(".ink-scan-box");
    boxes.forEach((el, i) => {
      const b = scanBoxes[i];
      if (!b || !b.bbox) return;
      const a = worldToScreen(b.bbox.minX, b.bbox.minY);
      const c = worldToScreen(b.bbox.maxX, b.bbox.maxY);
      el.style.left = Math.round(Math.min(a.x, c.x) - 8) + "px";
      el.style.top = Math.round(Math.min(a.y, c.y) - 8) + "px";
      el.style.width = Math.round(Math.abs(c.x - a.x) + 16) + "px";
      el.style.height = Math.round(Math.abs(c.y - a.y) + 16) + "px";
    });
  }

  function boxesOverlapBBox(a, b) {
    if (!a || !b) return false;
    return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
  }

  function renderInkOverlay() {
    if (!inkOverlay) return;
    inkOverlay.innerHTML = "";
    scanBoxes.forEach((b) => {
      const el = document.createElement("div");
      el.className = "ink-scan-box";
      const label = document.createElement("div");
      label.className = "ink-scan-label";
      label.textContent = b.label || "KI liest …";
      el.appendChild(label);
      inkOverlay.appendChild(el);
    });
    positionScanBoxes();
    inkGroups.forEach((g) => {
      if (scanBoxes.some((b) => boxesOverlapBBox(b.bbox, g.bbox))) return;
      const el = document.createElement("div");
      el.className = "ink-chip" + (g.result && mathSolveEnabled ? " ink-chip-math" : "");
      const textBtn = document.createElement("button");
      textBtn.type = "button";
      textBtn.className = "ink-chip-text";
      fillSpelledText(textBtn, g.text || "?", g.misspelled);
      textBtn.lang = "de";
      textBtn.title = "Tippen zum Korrigieren — merkt sich deine Schrift";
      textBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      textBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const input = document.createElement("input");
        input.className = "ink-chip-edit";
        input.value = g.text || "";
        input.maxLength = 80;
        el.replaceChild(input, textBtn);
        input.focus();
        input.select();
        const commit = async () => {
          const next = input.value.trim();
          if (next && next !== g.text) {
            if (next.length === g.glyphs.length) {
              for (let i = 0; i < g.glyphs.length; i++) {
                const gly = g.glyphs[i];
                if (gly.pixels) await SofiaInk.rememberGlyph(gly.pixels, next[i]);
              }
            }
            g.text = next;
            g.result = mathSolveEnabled ? SofiaInk.solveFromBurst(next) : null;
            g.misspelled = SofiaInk.misspelledSpans(next);
            attachSpelling(g).then(() => renderInkOverlay());
          }
          renderInkOverlay();
        };
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            commit();
          }
          if (ev.key === "Escape") renderInkOverlay();
        });
        input.addEventListener("blur", commit);
      });
      el.appendChild(textBtn);
      if (g.result && mathSolveEnabled) {
        const eq = document.createElement("button");
        eq.type = "button";
        eq.className = "ink-chip-eq";
        eq.textContent = "= " + g.result.text;
        eq.title = "Ergebnis aufs Blatt setzen";
        eq.addEventListener("pointerdown", (e) => e.stopPropagation());
        eq.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          insertTextStroke(g.result.text, g.bbox.maxX + 16, g.bbox.maxY, "#0b57d0", Math.max(18, (g.bbox.maxY - g.bbox.minY) * 0.85));
          dismissedInk.add(inkGroupKey(g));
          renderInkOverlay();
        });
        el.appendChild(eq);
      }
      const hide = document.createElement("button");
      hide.type = "button";
      hide.className = "ink-chip-hide";
      hide.textContent = "×";
      hide.title = "Ausblenden";
      hide.addEventListener("pointerdown", (e) => e.stopPropagation());
      hide.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dismissedInk.add(inkGroupKey(g));
        renderInkOverlay();
      });
      el.appendChild(hide);
      inkOverlay.appendChild(el);
    });
    positionInkChips();
  }

  function recognizeWordGap() {
    return Math.max(48, (2 * PX_PER_CM) / Math.max(scale, 0.2));
  }

  function pruneOcrCache(liveIds) {
    for (const key of Array.from(ocrCache.keys())) {
      const ids = key.split(",").filter(Boolean);
      if (ids.some((id) => !liveIds.has(id))) ocrCache.delete(key);
    }
    if (ocrCache.size > 48) {
      const extra = Array.from(ocrCache.keys()).slice(0, ocrCache.size - 48);
      for (const k of extra) ocrCache.delete(k);
    }
  }

  async function runRecognize(burst) {
    if (!burst || !burst.length || typeof SofiaInk === "undefined") return;
    if (recognizeBusy) return;
    recognizeBusy = true;
    recognizeAgain = false;
    recognizeWide = false;
    if (recognizeAbort) recognizeAbort.abort();
    const ac = new AbortController();
    recognizeAbort = ac;
    const wordGap = recognizeWordGap();
    let groups = [];
    try {
      pruneOcrCache(new Set(burst.map((s) => s.id)));
      const bbox = unionBBox(burst.map((s) => s.bbox || makeBBox(s.points)));
      const blocks = bbox ? [{ strokes: burst, bbox }] : [];
      scanBoxes = bbox ? [{ bbox, label: "KI liest …" }] : [];
      renderInkOverlay();

      const cloudGroups = [];
      const canCloud =
        cloudOcrEnabled !== false &&
        ocrRemaining > 1 &&
        recognizeAbort === ac &&
        !ac.signal.aborted;
      if (canCloud && burst.length) {
        const ocrBlock = async (block) => {
          const strokes = block.strokes;
          const key = inkGroupKey({ strokeIds: strokes.map((s) => s.id) });
          if (ocrCache.has(key)) {
            const hit = ocrCache.get(key);
            const text = SofiaInk.correctText(hit.text).text;
            const solved = mathSolveEnabled ? SofiaInk.solveFromBurst(text) : null;
            return {
              bbox: block.bbox,
              glyphs: [],
              text,
              math: !!(solved || SofiaInk.looksLikeMath(text)),
              result: solved,
              misspelled: SofiaInk.misspelledSpans(text),
              strokeIds: strokes.map((s) => s.id),
              source: "cloudflare",
            };
          }
          const crop = renderInkCrop(strokes);
          const resp = await fetch("/api/recognize", {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: ac.signal,
            body: JSON.stringify({
              image: crop.dataUrl,
              preferDigits: mathSolveEnabled,
            }),
          });
          if (resp.status === 429) {
            ocrRemaining = 0;
            return null;
          }
          if (!resp.ok) return null;
          const data = await resp.json();
          if (typeof data.remainingNeurons === "number") ocrRemaining = data.remainingNeurons;
          if (data && data.error === "not_configured") {
            cloudOcrEnabled = false;
            return null;
          }
          if (data && data.error === "quota") {
            ocrRemaining = 0;
            return null;
          }
          if (!data || !data.ok || !data.text) return null;
          cloudOcrEnabled = true;
          const text = SofiaInk.correctText(SofiaInk.cleanOcrText(data.text)).text;
          if (!text) return null;
          if (SofiaInk.ocrLooksPlausible(text, { strokes: strokes.length })) ocrCache.set(key, { text });
          const solved = mathSolveEnabled ? SofiaInk.solveFromBurst(text) : null;
          return {
            bbox: block.bbox,
            glyphs: [],
            text,
            math: !!(solved || SofiaInk.looksLikeMath(text)),
            result: solved,
            misspelled: SofiaInk.misspelledSpans(text),
            strokeIds: strokes.map((s) => s.id),
            source: "cloudflare",
          };
        };
        const g = await ocrBlock(blocks[0]).catch(() => null);
        if (g) cloudGroups.push(g);
      }

      if (cloudGroups.length) {
        groups = mergeInkGroups([], cloudGroups);
      } else {
        groups = await SofiaInk.recognizeStrokes(burst, {
          recentOnly: false,
          preferDigits: mathSolveEnabled,
          wordGap,
        });
        groups = SofiaInk.stitchBlockGroups(groups, blocks);
      }
      for (const g of groups) {
        const fix = SofiaInk.correctText(g.text);
        if (fix.changes.length) g.text = fix.text;
        if (!g.misspelled) g.misspelled = SofiaInk.misspelledSpans(g.text);
      }
      inkGroups = groups.filter((g) => !dismissedInk.has(inkGroupKey(g)));
      scanBoxes = [];
      renderInkOverlay();
    } catch (err) {
      scanBoxes = [];
      renderInkOverlay();
      if (!(err && err.name === "AbortError")) {
        /* Modelle optional — Board bleibt nutzbar */
      }
    }

    if (recognizeAbort === ac && !ac.signal.aborted && inkGroups.length) {
      await Promise.all(inkGroups.map((g) => attachSpelling(g, ac)));
      if (recognizeAbort === ac && !ac.signal.aborted) renderInkOverlay();
    }
    recognizeBusy = false;
  }

  // ---- boot ------------------------------------------------------
  function api(path, opts) {
    return fetch(path, opts).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  }

  function syncWhoChip() {
    if (whoChip) whoChip.textContent = personName(currentPersonId) || "Wer?";
    const libPerson = document.getElementById("library-person");
    if (libPerson) libPerson.textContent = personName(currentPersonId);
  }

  function showGate(title, text) {
    document.getElementById("gate-title").textContent = title;
    document.getElementById("gate-text").textContent = text || "";
    whoBackdrop.classList.remove("hidden");
    libraryBackdrop.classList.add("hidden");
  }

  function hideWho() {
    whoBackdrop.classList.add("hidden");
  }

  function showLibrary(opts) {
    hideWho();
    if (window.sofiaHistoryClose) window.sofiaHistoryClose();
    if (typeof hwPanel !== "undefined" && hwPanel) {
      hwPanel.classList.add("hidden");
      hwPill.classList.add("hidden");
      setViewInsets(0, 0);
    }
    libraryBackdrop.classList.remove("hidden");
    document.getElementById("btn-library-close").classList.toggle("hidden", !currentBoardId);
    if (!(opts && opts.fromHistory)) syncUrl(true);
    refreshLibrary();
    startSofiaNow();
    refreshHomework();
    if (typeof refreshInbox === "function") refreshInbox();
  }

  function hideLibrary(opts) {
    libraryBackdrop.classList.add("hidden");
    if (typeof hwBoard !== "undefined" && currentBoardId) applyHwPanelState(hwPanelState(currentBoardId));
    if (!(opts && opts.fromHistory) && currentBoardId) syncUrl(true);
  }

  // URL spiegelt immer, wo man gerade ist: ?folder=<Ordner>&board=<Blatt>.
  // Bibliothek offen -> nur der Ordner; Blatt offen -> Ordner + Blatt. So funktionieren
  // Zurueck/Vorwaerts im Browser, Neuladen und geteilte Links.
  function appUrl(folderId, boardId) {
    const url = new URL(location.href);
    if (folderId) url.searchParams.set("folder", folderId);
    else url.searchParams.delete("folder");
    if (boardId) url.searchParams.set("board", boardId);
    else url.searchParams.delete("board");
    return url.pathname + url.search;
  }

  function syncUrl(push) {
    const libOpen = !libraryBackdrop.classList.contains("hidden");
    const boardId = libOpen ? null : currentBoardId;
    const next = appUrl(currentFolderId, boardId);
    if (next === location.pathname + location.search) return;
    const state = { folderId: currentFolderId, boardId };
    if (push) history.pushState(state, "", next);
    else history.replaceState(state, "", next);
  }

  function navigateToFolder(folderId, push = true, hint) {
    const from = libraryCache;
    currentFolderId = folderId || null;
    if (push) syncUrl(true);
    closeItemMenu();
    const box = document.getElementById("library-backdrop");
    if (box) box.scrollTop = 0;
    // Noch nichts im Speicher: sofort Titel + Platzhalter zeigen, Inhalt kommt gleich
    if (!hint && currentFolderId && from) hint = (from.allFolders || []).find((f) => f.id === currentFolderId) || null;
    if (!libMem.has(libKey(currentFolderId)) && (hint || !currentFolderId)) {
      const crumbs = currentFolderId ? [...((from && from.crumbs) || []).filter((c) => c.id !== currentFolderId), { id: currentFolderId, parentId: hint.parentId || null, name: hint.name }] : [];
      libraryCache = { personId: currentPersonId, folderId: currentFolderId, folders: [], boards: [], crumbs, allFolders: (from && from.allFolders) || [], loading: true };
      renderLibrary();
    }
    refreshLibrary();
  }

  window.addEventListener("popstate", () => {
    const params = new URLSearchParams(location.search);
    const boardId = params.get("board");
    currentFolderId = params.get("folder") || null;
    if (boardId) {
      if (boardId !== currentBoardId) openBoard(boardId, null, { fromHistory: true });
      else hideLibrary({ fromHistory: true });
    } else {
      showLibrary({ fromHistory: true });
    }
  });

  // Bibliothek: Ordnerinhalte liegen im Speicher (und offline in IndexedDB). Angezeigt wird
  // sofort, was da ist; der Server wird im Hintergrund gefragt und nur bei Aenderungen neu
  // gezeichnet. Unterordner werden vorgeladen, damit sie beim Antippen sofort offen sind.
  const libMem = new Map(); // key -> library data
  let libSeq = 0;
  function libKey(folderId) {
    return "lib:" + currentPersonId + ":" + (folderId || "");
  }
  function libUrl(folderId) {
    return "/api/library?person=" + encodeURIComponent(currentPersonId) + (folderId ? "&folder=" + encodeURIComponent(folderId) : "");
  }
  const libInflight = new Map(); // key -> Promise
  function fetchLibrary(folderId) {
    const key = libKey(folderId);
    if (libInflight.has(key)) return libInflight.get(key);
    const pr = api(libUrl(folderId))
      .then((data) => {
        libMem.set(key, data);
        if (window.SofiaOffline) SofiaOffline.setKv(key, data).catch(() => {});
        return data;
      })
      .finally(() => libInflight.delete(key));
    libInflight.set(key, pr);
    return pr;
  }
  let prefetchTimer = null;
  function prefetchSubfolders() {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(async () => {
      const ids = ((libraryCache && libraryCache.folders) || []).map((f) => f.id).filter((id) => !libMem.has(libKey(id)));
      // ein paar gleichzeitig, der Rest danach - die Antworten sind klein
      for (let i = 0; i < ids.length; i += 4) {
        await Promise.all(ids.slice(i, i + 4).map((id) => fetchLibrary(id).catch(() => null)));
      }
    }, 150);
  }

  async function refreshLibrary() {
    if (!currentPersonId) return;
    const folderId = currentFolderId;
    const key = libKey(folderId);
    const seq = ++libSeq;
    let shown = libMem.get(key);
    if (!shown && window.SofiaOffline) {
      try {
        shown = await SofiaOffline.getKv(key);
        if (shown) libMem.set(key, shown);
      } catch (err) {}
    }
    if (shown && seq === libSeq) {
      libraryCache = shown;
      renderLibrary();
      prefetchSubfolders();
    }
    try {
      const fresh = await fetchLibrary(folderId);
      if (seq !== libSeq || (currentFolderId || null) !== (folderId || null)) return;
      if (!shown || JSON.stringify(fresh) !== JSON.stringify(shown)) {
        libraryCache = fresh;
        renderLibrary();
      }
      prefetchSubfolders();
    } catch (err) {
      if (seq !== libSeq) return;
      if (!shown) {
        libraryCache = { personId: currentPersonId, folderId, folders: [], boards: [], crumbs: (libraryCache && libraryCache.crumbs) || [], allFolders: [] };
        renderLibrary();
      }
      setConnState("offline");
    }
  }

  // Zeichnet die Bibliothek aus libraryCache (ohne Netz) - so koennen Aenderungen sofort
  // sichtbar werden und laufen im Hintergrund zum Server
  function persistLibraryCache() {
    if (!libraryCache) return;
    libMem.set(libKey(currentFolderId), libraryCache);
    if (!window.SofiaOffline) return;
    SofiaOffline.setKv("lib:" + currentPersonId + ":" + (currentFolderId || ""), libraryCache).catch(() => {});
  }
  // ---- Sofia: aktuelles Fach aus dem Stundenplan ----------------------------
  let sofiaNow = null;
  let sofiaNowTimer = null;
  async function refreshSofiaNow() {
    try {
      const r = await fetch("/api/sofia/now", { credentials: "same-origin" });
      if (!r.ok) return;
      const next = await r.json();
      const changed = JSON.stringify(next) !== JSON.stringify(sofiaNow);
      sofiaNow = next;
      if (changed && !libraryBackdrop.classList.contains("hidden")) renderLibrary();
    } catch (err) {
      /* offline - Hervorhebung bleibt einfach weg */
    }
  }
  function startSofiaNow() {
    refreshSofiaNow();
    clearInterval(sofiaNowTimer);
    sofiaNowTimer = setInterval(() => {
      if (!libraryBackdrop.classList.contains("hidden")) {
        refreshSofiaNow();
        refreshHomework();
      }
    }, 60000);
  }
  // Welcher Ordner leuchtet: das laufende Fach, sonst das naechste (in den naechsten 20 Min.)
  function sofiaHighlight() {
    if (!sofiaNow || !sofiaNow.enabled) return null;
    const c = sofiaNow.current;
    if (c && c.folderId) {
      return { kind: "now", folderId: c.folderId, label: "Jetzt bis " + c.end + (c.room ? " · " + c.room : "") };
    }
    const n = sofiaNow.next;
    if (n && n.folderId && n.start) {
      const [h, m] = n.start.split(":").map(Number);
      const d = new Date();
      const mins = h * 60 + m - (d.getHours() * 60 + d.getMinutes());
      if (mins >= 0 && mins <= 20) return { kind: "next", folderId: n.folderId, label: "Ab " + n.start + (n.room ? " · " + n.room : "") };
    }
    return null;
  }

  // ---- Hausaufgaben aus Sofia ---------------------------------------------------
  // Startseite: Knopf mit Anzahl offener Aufgaben -> Liste -> Detail (Text, Bilder).
  // "Auf Blatt bearbeiten" legt pro Aufgabe ein Blatt im Fach-Ordner an; dort steht die
  // Aufgabenstellung in einem verschiebbaren, minimierbaren Fenster neben dem Schreiben.
  const hwBtn = document.getElementById("btn-library-homework");
  const hwCountEl = document.getElementById("hw-count");
  const hwScrim = document.getElementById("hw-scrim");
  const hwListEl = document.getElementById("hw-list");
  const hwDetailEl = document.getElementById("hw-detail");
  let hwData = null;
  let hwDetailId = null;

  async function refreshHomework() {
    try {
      const r = await fetch("/api/sofia/homework", { credentials: "same-origin" });
      if (!r.ok) return;
      const data = await r.json();
      if (!data.enabled || data.error === "not_linked") {
        hwBtn?.classList.add("hidden");
        return;
      }
      hwData = data;
      hwBtn?.classList.remove("hidden");
      syncHomeworkBadge();
      if (!hwScrim.classList.contains("hidden")) {
        if (hwDetailId != null) {
          const hw = hwFind(hwDetailId);
          if (hw) renderHwDetail(hw);
        } else renderHwList();
      }
    } catch (err) {
      /* offline: Knopf bleibt wie er ist */
    }
  }
  function hwFind(id) {
    return ((hwData && hwData.items) || []).find((h) => h.id === id) || null;
  }
  function syncHomeworkBadge() {
    const open = ((hwData && hwData.items) || []).filter((h) => !h.done).length;
    if (!hwCountEl) return;
    hwCountEl.textContent = String(open);
    hwCountEl.classList.toggle("hidden", open === 0);
  }
  function hwDueLabel(due) {
    if (!due) return "Ohne Datum";
    const d = new Date(due.slice(0, 10) + "T12:00:00");
    const t = new Date();
    t.setHours(12, 0, 0, 0);
    const days = Math.round((d - t) / 86400000);
    if (days < 0) return "Überfällig";
    if (days === 0) return "Heute";
    if (days === 1) return "Morgen";
    return d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
  }
  function hwToggleDone(hw) {
    const was = hw.done;
    optimistic({
      apply: () => {
        hw.done = !was;
        syncHomeworkBadge();
        rerenderHw();
      },
      revert: () => {
        hw.done = was;
        syncHomeworkBadge();
        rerenderHw();
      },
      request: () =>
        api("/api/sofia/homework/" + hw.id + "/check", { method: "POST" }).then((res) => {
          if (res && typeof res.done === "boolean" && res.done !== hw.done) {
            hw.done = res.done;
            syncHomeworkBadge();
            rerenderHw();
          }
        }),
      failText: "Abhaken hat nicht geklappt",
    });
  }
  function rerenderHw() {
    if (hwScrim.classList.contains("hidden")) return;
    if (hwDetailId != null) {
      const hw = hwFind(hwDetailId);
      if (hw) renderHwDetail(hw);
    } else renderHwList();
  }
  function hwCheckBtn(hw) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hw-check" + (hw.done ? " done" : "");
    b.title = hw.done ? "Wieder als offen markieren" : "Als erledigt abhaken";
    b.innerHTML = '<span class="material-symbols-rounded">' + (hw.done ? "check_circle" : "radio_button_unchecked") + "</span>";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      hwToggleDone(hw);
    });
    return b;
  }
  function renderHwList() {
    hwDetailId = null;
    document.getElementById("hw-title").textContent = "Hausaufgaben";
    document.getElementById("hw-back").classList.add("hidden");
    hwDetailEl.classList.add("hidden");
    hwListEl.classList.remove("hidden");
    hwListEl.innerHTML = "";
    const items = (hwData && hwData.items) || [];
    if (!hwData) {
      hwListEl.innerHTML = '<div class="hw-empty">Lädt…</div>';
      return;
    }
    if (!items.length) {
      hwListEl.innerHTML = '<div class="hw-empty"><span class="material-symbols-rounded">check_circle</span><strong>Alles erledigt</strong><span>Gerade gibt es keine offenen Hausaufgaben.</span></div>';
      return;
    }
    let lastGroup = null;
    for (const hw of items) {
      const group = hw.done ? "Erledigt" : hwDueLabel(hw.due);
      if (group !== lastGroup) {
        const h = document.createElement("div");
        h.className = "hw-group" + (group === "Überfällig" ? " late" : "");
        h.textContent = group;
        hwListEl.appendChild(h);
        lastGroup = group;
      }
      const row = document.createElement("div");
      row.className = "hw-item" + (hw.done ? " done" : "");
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.style.setProperty("--subj", hw.color);
      row.appendChild(hwCheckBtn(hw));
      const text = document.createElement("div");
      text.className = "hw-item-text";
      text.innerHTML = '<span class="hw-item-subj"></span><span class="hw-item-desc"></span><span class="hw-item-meta"></span>';
      text.querySelector(".hw-item-subj").textContent = hw.subject || "Fach";
      text.querySelector(".hw-item-desc").textContent = hw.description || "(ohne Text)";
      const meta = [];
      const imgs = hw.attachments.filter((a) => a.type === "image").length;
      const files = hw.attachments.length - imgs;
      if (imgs) meta.push(imgs === 1 ? "1 Bild" : imgs + " Bilder");
      if (files) meta.push(files === 1 ? "1 Datei" : files + " Dateien");
      if (hw.boardId) meta.push("Blatt angelegt");
      text.querySelector(".hw-item-meta").textContent = meta.join(" · ");
      row.appendChild(text);
      row.insertAdjacentHTML("beforeend", '<span class="material-symbols-rounded hw-item-chev">chevron_right</span>');
      row.addEventListener("click", () => renderHwDetail(hw));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") renderHwDetail(hw);
      });
      hwListEl.appendChild(row);
    }
  }
  function hwAttachmentsHtml(container, hw) {
    const imgs = hw.attachments.filter((a) => a.type === "image");
    const files = hw.attachments.filter((a) => a.type !== "image");
    if (imgs.length) {
      const grid = document.createElement("div");
      grid.className = "hw-images";
      for (const a of imgs) {
        const im = document.createElement("img");
        im.src = a.url;
        im.alt = a.name || "Bild";
        im.loading = "lazy";
        im.addEventListener("click", (e) => {
          e.stopPropagation();
          openLightbox(a.url);
        });
        grid.appendChild(im);
      }
      container.appendChild(grid);
    }
    for (const a of files) {
      const l = document.createElement("a");
      l.className = "hw-file";
      l.href = a.url;
      l.target = "_blank";
      l.rel = "noopener";
      l.innerHTML = '<span class="material-symbols-rounded">attach_file</span><span></span>';
      l.lastChild.textContent = a.name || "Datei";
      container.appendChild(l);
    }
  }
  function renderHwDetail(hw) {
    hwDetailId = hw.id;
    document.getElementById("hw-title").textContent = hw.subject || "Hausaufgabe";
    document.getElementById("hw-back").classList.remove("hidden");
    hwListEl.classList.add("hidden");
    hwDetailEl.classList.remove("hidden");
    hwDetailEl.innerHTML = "";
    hwDetailEl.style.setProperty("--subj", hw.color);
    const head = document.createElement("div");
    head.className = "hw-detail-head";
    head.innerHTML = '<span class="hw-subject-chip"></span><span class="hw-due"></span>';
    head.firstChild.textContent = hw.subject || "Fach";
    head.lastChild.textContent = "Fällig: " + hwDueLabel(hw.due) + (hw.due ? " (" + new Date(hw.due.slice(0, 10) + "T12:00:00").toLocaleDateString("de-DE") + ")" : "");
    hwDetailEl.appendChild(head);
    const desc = document.createElement("div");
    desc.className = "hw-desc";
    desc.textContent = hw.description || "(ohne Text)";
    hwDetailEl.appendChild(desc);
    hwAttachmentsHtml(hwDetailEl, hw);
    const actions = document.createElement("div");
    actions.className = "m3-sheet-actions hw-actions";
    const done = document.createElement("button");
    done.type = "button";
    done.className = "m3-btn-outline";
    done.textContent = hw.done ? "Wieder offen" : "Erledigt";
    done.addEventListener("click", () => hwToggleDone(hw));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "m3-btn-primary";
    open.textContent = hw.boardId ? "Blatt öffnen" : "Auf Blatt bearbeiten";
    open.addEventListener("click", () => (hw.boardId ? openHomeworkBoard(hw, open) : renderHwBoardChoice(hw)));
    actions.append(done, open);
    hwDetailEl.appendChild(actions);
    if (hw.boardId) {
      const other = document.createElement("button");
      other.type = "button";
      other.className = "hw-link-btn";
      other.textContent = "Anderes Blatt für diese Aufgabe nehmen";
      other.addEventListener("click", () => renderHwBoardChoice(hw));
      hwDetailEl.appendChild(other);
    }
  }
  // Neues Blatt anlegen oder ein vorhandenes mit der Aufgabe verknuepfen
  function renderHwBoardChoice(hw) {
    hwDetailEl.innerHTML = "";
    document.getElementById("hw-title").textContent = "Blatt wählen";
    const mk = (icon, title, sub, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dlg-choice hw-choice";
      b.innerHTML = '<span class="dlg-folder-ico"><span class="material-symbols-rounded"></span></span><span class="dlg-choice-text"><strong></strong><small></small></span><span class="material-symbols-rounded hw-item-chev">chevron_right</span>';
      b.querySelector(".dlg-folder-ico .material-symbols-rounded").textContent = icon;
      b.querySelector("strong").textContent = title;
      b.querySelector("small").textContent = sub;
      b.addEventListener("click", () => fn(b));
      return b;
    };
    hwDetailEl.appendChild(
      mk("note_add", "Neues Blatt", "Wird im Ordner „" + (hw.subject || "Fach") + "“ angelegt", (b) => openHomeworkBoard(hw, b))
    );
    hwDetailEl.appendChild(mk("description", "Vorhandenes Blatt", "Ein Blatt, auf dem du schon angefangen hast", () => renderHwBoardPicker(hw)));
  }
  async function renderHwBoardPicker(hw) {
    hwDetailEl.innerHTML = "";
    document.getElementById("hw-title").textContent = "Blatt verknüpfen";
    const search = document.createElement("input");
    search.type = "text";
    search.className = "m3-input";
    search.placeholder = "Blatt suchen…";
    search.autocomplete = "off";
    hwDetailEl.appendChild(search);
    const list = document.createElement("div");
    list.className = "share-choices hw-board-list";
    list.innerHTML = '<div class="hw-empty">Lädt…</div>';
    hwDetailEl.appendChild(list);
    let boards = [];
    try {
      boards = (await api("/api/boards/recent")).boards || [];
    } catch (err) {
      list.innerHTML = '<div class="hw-empty">Konnte die Blätter nicht laden.</div>';
      return;
    }
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = "";
      const shown = boards.filter((b) => !q || (b.title || "").toLowerCase().includes(q) || (b.folder || "").toLowerCase().includes(q));
      if (!shown.length) list.innerHTML = '<div class="hw-empty">Kein passendes Blatt.</div>';
      for (const b of shown.slice(0, 40)) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "dlg-choice";
        row.innerHTML = '<span class="dlg-folder-ico"><span class="material-symbols-rounded">description</span></span><span class="dlg-choice-text"><strong></strong><small></small></span>';
        row.querySelector("strong").textContent = b.title || "Unbenanntes Blatt";
        const meta = [b.folder || "Ohne Ordner", relTime(b.updatedAt)];
        if (b.sofiaHomeworkId && b.sofiaHomeworkId !== hw.id) meta.push("gehört schon zu einer anderen Aufgabe");
        row.querySelector("small").textContent = meta.filter(Boolean).join(" · ");
        row.addEventListener("click", async () => {
          row.disabled = true;
          try {
            const res = await api("/api/sofia/homework/" + hw.id + "/link", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ boardId: b.id }),
            });
            hw.boardId = res.boardId;
            closeHomework();
            libMem.clear();
            await openBoard(res.boardId, res.title, { homework: hw });
          } catch (err) {
            row.disabled = false;
            showToast("Verknüpfen hat nicht geklappt");
          }
        });
        list.appendChild(row);
      }
    };
    search.addEventListener("input", draw);
    draw();
  }
  async function openHomeworkBoard(hw, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Öffne…";
    }
    try {
      const res = await api("/api/sofia/homework/" + hw.id + "/board", { method: "POST" });
      hw.boardId = res.boardId;
      closeHomework();
      libMem.clear();
      await openBoard(res.boardId, res.title, { homework: hw });
    } catch (err) {
      showToast(navigator.onLine ? "Blatt konnte nicht geöffnet werden" : "Keine Verbindung");
      if (btn) {
        btn.disabled = false;
        btn.textContent = hw.boardId ? "Blatt öffnen" : "Auf Blatt bearbeiten";
      }
    }
  }
  function openHomework() {
    hwScrim.classList.remove("hidden");
    renderHwList();
    refreshHomework();
  }
  function closeHomework() {
    hwScrim.classList.add("hidden");
    hwDetailId = null;
  }
  hwBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    openHomework();
  });
  document.getElementById("hw-close")?.addEventListener("click", closeHomework);
  document.getElementById("hw-back")?.addEventListener("click", () => {
    const hw = hwDetailId != null ? hwFind(hwDetailId) : null;
    const t = document.getElementById("hw-title").textContent;
    if (hw && (t === "Blatt wählen" || t === "Blatt verknüpfen")) renderHwDetail(hw);
    else renderHwList();
  });
  hwScrim?.addEventListener("click", (e) => {
    if (e.target === hwScrim) closeHomework();
  });

  // ---- Bild gross ansehen ----
  const lightboxEl = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");
  function openLightbox(src) {
    lightboxImg.src = src;
    lightboxEl.classList.remove("zoomed");
    lightboxEl.classList.remove("hidden");
  }
  function closeLightbox() {
    lightboxEl.classList.add("hidden");
    lightboxImg.removeAttribute("src");
  }
  lightboxEl?.addEventListener("click", (e) => {
    if (e.target === lightboxImg) {
      lightboxEl.classList.toggle("zoomed"); // antippen: Originalgroesse / einpassen
      return;
    }
    closeLightbox();
  });
  lightboxEl?.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.getElementById("lightbox-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!lightboxEl.classList.contains("hidden")) closeLightbox();
    else if (!hwScrim.classList.contains("hidden")) {
      if (hwDetailId != null) renderHwList();
      else closeHomework();
    }
  });

  // ---- Aufgaben-Fenster im Blatt ----
  // Zwei Arten: schwebendes Fenster (frei verschieb- und vergroesserbar) oder Seitenleiste
  // (links/rechts angedockt, Breite ziehbar - das Blatt wird dann schmaler statt verdeckt).
  // Minimiert bleibt eine kleine, verschiebbare Leiste. Bilder lassen sich im Fenster zoomen
  // und bleiben so stehen (pro Blatt gemerkt). Unten: Blatt als PDF-Loesung in Sofia teilen.
  const hwPanel = document.getElementById("hw-panel");
  const hwPanelBody = document.getElementById("hw-panel-body");
  const hwPill = document.getElementById("hw-pill");
  const hwPanelBtn = document.getElementById("btn-hw-panel");
  const hwViewer = document.getElementById("hw-viewer");
  const hwViewerStage = document.getElementById("hw-viewer-stage");
  const hwViewerImg = document.getElementById("hw-viewer-img");
  let hwBoard = null; // Hausaufgabe des offenen Blatts
  let hwPanelCurrent = "closed";
  const lsGet = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k) || "null");
      return v == null ? d : v;
    } catch (err) {
      return d;
    }
  };
  const lsSet = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (err) {}
  };
  let hwPanelGeo = lsGet("sofianotes-hwpanel", null);
  let hwLayout = lsGet("sofianotes-hwpanel-layout", { mode: "float", side: "right", width: 380 });
  function hwPanelState(boardId) {
    try {
      return localStorage.getItem("sofianotes-hwpanel-state:" + boardId) || (hwBoard ? "open" : "closed");
    } catch (err) {
      return hwBoard ? "open" : "closed";
    }
  }
  function setHwPanelState(state) {
    if (!currentBoardId) return;
    try {
      localStorage.setItem("sofianotes-hwpanel-state:" + currentBoardId, state);
    } catch (err) {}
    applyHwPanelState(state);
  }
  function hwDockWidth() {
    return Math.round(Math.max(260, Math.min(window.innerWidth * 0.7, hwLayout.width || 380)));
  }
  function applyHwPanelState(state) {
    const has = !!currentBoardId && libraryBackdrop.classList.contains("hidden");
    hwPanelCurrent = state;
    const open = has && state === "open";
    const docked = open && hwLayout.mode === "dock";
    hwPanel.classList.toggle("hidden", !open);
    hwPill.classList.toggle("hidden", !has || state !== "min");
    hwPanelBtn.classList.toggle("hidden", !currentBoardId);
    hwPanelBtn.classList.toggle("active", open);
    hwPanel.classList.toggle("docked", docked);
    hwPanel.classList.toggle("dock-left", docked && hwLayout.side === "left");
    hwPanel.classList.toggle("dock-right", docked && hwLayout.side !== "left");
    document.getElementById("hw-panel-side").classList.toggle("hidden", !docked);
    const modeBtn = document.getElementById("hw-panel-mode");
    modeBtn.title = docked ? "Als schwebendes Fenster lösen" : "Als Seitenleiste andocken";
    modeBtn.firstElementChild.textContent = docked ? "picture_in_picture" : hwLayout.side === "left" ? "dock_to_left" : "dock_to_right";
    if (docked) {
      const w = hwDockWidth();
      Object.assign(hwPanel.style, { top: "0px", height: window.innerHeight + "px", width: w + "px", left: hwLayout.side === "left" ? "0px" : window.innerWidth - w + "px" });
      setViewInsets(hwLayout.side === "left" ? w : 0, hwLayout.side === "left" ? 0 : w);
    } else {
      setViewInsets(0, 0);
      if (open) placeHwPanel();
    }
    if (state === "min") placeHwPill();
    if (open && hwViewerState().open) openHwViewer(hwViewerState().i, true);
    if (open) refreshSolutionStatus();
  }
  function placeHwPanel() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(vw - 16, Math.max(240, (hwPanelGeo && hwPanelGeo.w) || Math.min(360, vw * 0.36)));
    const h = Math.min(vh - 90, Math.max(160, (hwPanelGeo && hwPanelGeo.h) || Math.min(480, vh * 0.55)));
    let x = hwPanelGeo && Number.isFinite(hwPanelGeo.x) ? hwPanelGeo.x : vw - w - 16;
    let y = hwPanelGeo && Number.isFinite(hwPanelGeo.y) ? hwPanelGeo.y : 84;
    x = Math.max(8, Math.min(vw - w - 8, x));
    y = Math.max(8, Math.min(vh - 60, y));
    Object.assign(hwPanel.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  }
  function saveHwPanelGeo() {
    if (hwLayout.mode === "dock") return;
    const r = hwPanel.getBoundingClientRect();
    hwPanelGeo = { x: r.left, y: r.top, w: r.width, h: r.height };
    lsSet("sofianotes-hwpanel", hwPanelGeo);
  }
  function setHwLayout(patch) {
    hwLayout = Object.assign({}, hwLayout, patch);
    lsSet("sofianotes-hwpanel-layout", hwLayout);
    applyHwPanelState(hwPanelCurrent);
  }
  // Eigene Bilder am Blatt (Buchseite, Foto der Aufgabe ...) - auch ohne Hausaufgabe
  function boardRefs() {
    return (currentBoardMeta && currentBoardMeta.id === currentBoardId && currentBoardMeta.refs) || [];
  }
  // alle Bilder im Fenster: erst die der Aufgabe, dann die eigenen
  function panelImages() {
    const hw = hwBoard ? hwBoard.attachments.filter((a) => a.type === "image") : [];
    const own = boardRefs().filter((r) => r.mediaId).map((r) => ({ type: "image", url: "/api/media/" + encodeURIComponent(r.mediaId), name: r.name, mediaId: r.mediaId, own: true }));
    return hw.concat(own);
  }
  function isPdfItem(a) {
    return /pdf/i.test(a.mime || "") || /\.pdf$/i.test(a.name || "") || /\.pdf(%|$|\?)/i.test(a.url || "");
  }
  function ownFileUrl(r) {
    return "/api/files/" + encodeURIComponent(r.fileId);
  }
  // alles, was im Fenster geoeffnet werden kann: erst Bilder (Reihenfolge wie die
  // Vorschaubilder), dann PDFs der Aufgabe und eigene PDFs
  function panelItems() {
    const hwPdfs = hwBoard ? hwBoard.attachments.filter((a) => a.type !== "image" && isPdfItem(a)).map((a) => ({ ...a, kind: "pdf" })) : [];
    const ownPdfs = boardRefs()
      .filter((r) => r.fileId && isPdfItem(r))
      .map((r) => ({ kind: "pdf", url: ownFileUrl(r), name: r.name, fileId: r.fileId }));
    return panelImages().map((a) => ({ ...a, kind: "image" })).concat(hwPdfs, ownPdfs);
  }
  function saveBoardRefs(next, failText) {
    const bid = currentBoardId;
    const before = boardRefs().slice();
    optimistic({
      apply: () => {
        if (currentBoardMeta) currentBoardMeta.refs = next;
        renderHwPanel();
      },
      revert: () => {
        if (currentBoardMeta && bid === currentBoardId) currentBoardMeta.refs = before;
        renderHwPanel();
      },
      request: () =>
        api("/api/boards/" + encodeURIComponent(bid), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refs: next }),
        }),
      failText,
    });
  }
  const refFileInput = document.createElement("input");
  refFileInput.type = "file";
  // ohne Filter: Bilder, Kamera, PDFs und andere Dateien
  refFileInput.multiple = true;
  refFileInput.style.display = "none";
  document.body.appendChild(refFileInput);
  refFileInput.addEventListener("change", async () => {
    const files = Array.from(refFileInput.files || []);
    refFileInput.value = "";
    if (!files.length || !currentBoardId) return;
    showToast(files.length > 1 ? "Dateien werden hinzugefügt…" : "Wird hinzugefügt…");
    const added = [];
    try {
      for (const file of files) {
        const isImage = /^image\//i.test(file.type) && !/svg/i.test(file.type);
        if (!isImage) {
          // PDF und alle anderen Dateien bleiben die Originaldatei
          const r = await fetch("/api/files?name=" + encodeURIComponent(file.name || "Datei"), {
            method: "POST",
            headers: { "Content-Type": file.type || "application/octet-stream" },
            body: file,
          });
          if (!r.ok) throw new Error(r.status === 413 ? "big" : "upload");
          const meta = await r.json();
          added.push({ fileId: meta.id, name: meta.name, mime: meta.mime });
        } else {
          const bmp = await createImageBitmap(file);
          const jpeg = bitmapToJpeg(bmp, 2000);
          if (bmp.close) bmp.close();
          added.push({ mediaId: await uploadJpeg(jpeg.dataUrl), name: (file.name || "Foto").replace(/\.[a-z0-9]+$/i, "") });
        }
      }
    } catch (err) {
      showToast(String(err.message) === "big" ? "Die Datei ist zu groß (max. 60 MB)" : "Hinzufügen hat nicht geklappt");
    }
    if (added.length) saveBoardRefs(boardRefs().concat(added), "Speichern hat nicht geklappt");
  });
  function renderOwnRefs() {
    const sec = document.createElement("div");
    sec.className = "hw-own";
    const head = document.createElement("div");
    head.className = "hw-own-head";
    head.innerHTML = '<span>Eigenes Material</span><button type="button" class="hw-own-add"><span class="material-symbols-rounded">add</span>Foto / Datei</button>';
    head.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      refFileInput.click();
    });
    sec.appendChild(head);
    const all = boardRefs();
    const removeRef = (ref) => saveBoardRefs(boardRefs().filter((x) => x !== ref), "Entfernen hat nicht geklappt");
    const fileRefs = all.filter((r) => r.fileId);
    for (const r of fileRefs) {
      const row = document.createElement("div");
      row.className = "hw-file hw-own-file";
      const pdf = isPdfItem(r);
      row.innerHTML = '<span class="material-symbols-rounded"></span><span class="hw-own-file-name"></span><button type="button" class="hw-ref-del" title="Entfernen"><span class="material-symbols-rounded">close</span></button>';
      row.children[0].textContent = pdf ? "picture_as_pdf" : "description";
      row.children[1].textContent = r.name || "Datei";
      row.title = pdf ? "Antippen: hier im Fenster öffnen" : "Antippen: öffnen";
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pdf) openHwViewer(panelItems().findIndex((it) => it.fileId === r.fileId));
        else window.open(ownFileUrl(r), "_blank", "noopener");
      });
      row.querySelector(".hw-ref-del").addEventListener("click", (e) => {
        e.stopPropagation();
        removeRef(r);
      });
      sec.appendChild(row);
    }
    const refs = all.filter((r) => r.mediaId);
    if (refs.length) {
      const grid = document.createElement("div");
      grid.className = "hw-images hw-refs";
      refs.forEach((r, i) => {
        const wrap = document.createElement("div");
        wrap.className = "hw-ref";
        const im = document.createElement("img");
        im.src = "/api/media/" + encodeURIComponent(r.mediaId);
        im.alt = r.name || "Bild";
        im.loading = "lazy";
        const del = document.createElement("button");
        del.type = "button";
        del.className = "hw-ref-del";
        del.title = "Entfernen";
        del.innerHTML = '<span class="material-symbols-rounded">close</span>';
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          removeRef(r);
        });
        wrap.appendChild(im);
        wrap.appendChild(del);
        grid.appendChild(wrap);
      });
      sec.appendChild(grid);
    }
    if (!all.length) {
      const empty = document.createElement("div");
      empty.className = "hw-hint";
      empty.textContent = "Hier kannst du z. B. die Buchseite, ein Foto der Aufgabe oder ein PDF ablegen – mit der Kamera, aus deinen Bildern oder Dateien.";
      sec.appendChild(empty);
    }
    return sec;
  }
  function renderHwPanel() {
    if (!currentBoardId) return;
    const color = (hwBoard && hwBoard.color) || "#6750a4";
    hwPanel.style.setProperty("--subj", color);
    hwPill.style.setProperty("--subj", color);
    const chip = document.getElementById("hw-panel-subject");
    chip.textContent = hwBoard ? hwBoard.subject || "Aufgabe" : "";
    chip.classList.toggle("hidden", !hwBoard);
    hwPanel.querySelector(".hw-panel-title").textContent = hwBoard ? "Aufgabe" : "Material";
    document.getElementById("hw-pill-text").textContent = hwBoard ? (hwBoard.subject ? hwBoard.subject + " – Aufgabe" : "Aufgabe") : "Material";
    hwPanelBody.innerHTML = "";
    if (hwBoard) {
      const due = document.createElement("div");
      due.className = "hw-due";
      due.textContent = "Fällig: " + hwDueLabel(hwBoard.due);
      hwPanelBody.appendChild(due);
      const desc = document.createElement("div");
      desc.className = "hw-desc";
      desc.textContent = hwBoard.description || "(ohne Text)";
      hwPanelBody.appendChild(desc);
      hwAttachmentsHtml(hwPanelBody, hwBoard);
    }
    hwPanelBody.appendChild(renderOwnRefs());
    // PDF-Anhaenge der Aufgabe im Fenster oeffnen statt in einem neuen Tab
    hwPanelBody.querySelectorAll("a.hw-file").forEach((l) => {
      const name = l.lastChild ? l.lastChild.textContent : "";
      if (!isPdfItem({ name, url: l.getAttribute("href") })) return;
      l.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openHwViewer(panelItems().findIndex((it) => it.kind === "pdf" && it.url === l.getAttribute("href")));
      });
    });
    // Bilder im Fenster: Antippen -> im Fenster zoomen (statt Vollbild)
    const imgs = panelImages();
    hwPanelBody.querySelectorAll(".hw-images img").forEach((im, i) => {
      im.replaceWith(im.cloneNode(true));
    });
    hwPanelBody.querySelectorAll(".hw-images img").forEach((im, i) => {
      im.title = "Antippen: vergrößern · lange halten: ins Blatt ziehen";
      im.draggable = false;
      im.addEventListener("click", (e) => {
        e.stopPropagation();
        if (performance.now() - hwImgDragEndedAt < 400) return;
        openHwViewer(i);
      });
      armHwImgDrag(im, imgs[i]);
    });
    if (imgs.length) {
      const hint = document.createElement("div");
      hint.className = "hw-hint";
      hint.textContent = "Bild antippen, um es hier zu vergrößern. Lange halten und aufs Blatt ziehen fügt es ein.";
      hwPanelBody.appendChild(hint);
    }
  }
  // Bild aus der Aufgabe lange halten und aufs Blatt ziehen -> als Bild einfuegen
  let hwImgDrag = null;
  let hwImgDragEndedAt = 0;
  function armHwImgDrag(im, att) {
    im.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      endHwImgDrag(null);
      hwImgDrag = { im, att, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, active: false };
      hwImgDrag.timer = setTimeout(() => {
        if (!hwImgDrag) return;
        const g = document.createElement("img");
        g.src = im.currentSrc || im.src;
        g.className = "hw-img-ghost";
        document.body.appendChild(g);
        hwImgDrag.ghost = g;
        hwImgDrag.active = true;
        try {
          im.setPointerCapture(hwImgDrag.pointerId);
        } catch (err) {}
        moveHwImgGhost(hwImgDrag.x0, hwImgDrag.y0);
        if (navigator.vibrate) navigator.vibrate(12);
      }, e.pointerType === "mouse" ? 300 : 420);
    });
    im.addEventListener("pointermove", (e) => {
      if (!hwImgDrag || hwImgDrag.im !== im || e.pointerId !== hwImgDrag.pointerId) return;
      if (!hwImgDrag.active) {
        if (Math.hypot(e.clientX - hwImgDrag.x0, e.clientY - hwImgDrag.y0) > 8) endHwImgDrag(null);
        return;
      }
      moveHwImgGhost(e.clientX, e.clientY);
    });
    im.addEventListener("pointerup", (e) => endHwImgDrag(e));
    im.addEventListener("pointercancel", () => endHwImgDrag(null));
    im.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  function hwImgOverPanel(x, y) {
    const r = hwPanel.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  function moveHwImgGhost(x, y) {
    const g = hwImgDrag && hwImgDrag.ghost;
    if (!g) return;
    g.style.left = x + "px";
    g.style.top = y + "px";
    g.classList.toggle("can-drop", !hwImgOverPanel(x, y));
  }
  function endHwImgDrag(e) {
    const d = hwImgDrag;
    if (!d) return;
    hwImgDrag = null;
    clearTimeout(d.timer);
    if (d.ghost) d.ghost.remove();
    if (!d.active) return;
    hwImgDragEndedAt = performance.now();
    if (!e || hwImgOverPanel(e.clientX, e.clientY)) return;
    insertHwImage(d.att, screenToWorld(e.clientX, e.clientY));
  }
  async function insertHwImage(att, at) {
    try {
      const blob = await (await fetch(att.url)).blob();
      const bmp = await createImageBitmap(blob);
      const jpeg = bitmapToJpeg(bmp, 1600);
      if (bmp.close) bmp.close();
      const mediaId = await uploadJpeg(jpeg.dataUrl);
      placeImageStroke(mediaId, jpeg.w, jpeg.h, att.name || "Aufgabe", { x: at.x, y: at.y, center: true });
      requestRedraw();
    } catch (err) {
      showToast("Bild einfügen hat nicht geklappt");
    }
  }

  // Blatt geoeffnet: gehoert es zu einer Hausaufgabe, Aufgabenstellung dazu holen
  async function syncHomeworkPanel(board, known) {
    const hid = board && board.sofiaHomeworkId;
    closeHwViewer(true);
    if (!hid) {
      hwBoard = null;
      if (board && board.id === currentBoardId) {
        renderHwPanel();
        applyHwPanelState(hwPanelState(board.id));
      } else applyHwPanelState("closed");
      return;
    }
    if (known && known.id === hid) {
      hwBoard = known;
      renderHwPanel();
      applyHwPanelState(hwPanelState(board.id));
    }
    try {
      const fresh = await api("/api/sofia/homework/" + hid);
      if (!currentBoardMeta || currentBoardId !== board.id) return;
      hwBoard = fresh;
      renderHwPanel();
      applyHwPanelState(hwPanelState(board.id));
    } catch (err) {
      if (!hwBoard && currentBoardId === board.id) {
        renderHwPanel();
        applyHwPanelState(hwPanelState(board.id));
      }
    }
  }
  document.getElementById("hw-panel-min")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setHwPanelState("min");
  });
  document.getElementById("hw-panel-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setHwPanelState("closed");
  });
  document.getElementById("hw-panel-mode")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setHwLayout({ mode: hwLayout.mode === "dock" ? "float" : "dock" });
  });
  document.getElementById("hw-panel-side")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setHwLayout({ side: hwLayout.side === "left" ? "right" : "left" });
  });
  hwPanelBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    setHwPanelState(hwPanel.classList.contains("hidden") ? "open" : "min");
  });

  // Verschieben (Kopfzeile), Groesse (Ecke), Breite der Seitenleiste (Kante)
  let hwDrag = null;
  function hwStartDrag(e, kind) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = hwPanel.getBoundingClientRect();
    hwDrag = { kind, id: e.pointerId, sx: e.clientX, sy: e.clientY, r, w0: hwDockWidth() };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    hwPanel.classList.add("dragging");
  }
  function hwMoveDrag(e) {
    if (!hwDrag || hwDrag.id !== e.pointerId) return;
    const dx = e.clientX - hwDrag.sx;
    const dy = e.clientY - hwDrag.sy;
    const r = hwDrag.r;
    if (hwDrag.kind === "edge") {
      const w = Math.max(260, Math.min(window.innerWidth * 0.7, hwDrag.w0 + (hwLayout.side === "left" ? dx : -dx)));
      hwLayout.width = w;
      applyHwPanelState("open");
    } else if (hwDrag.kind === "move") {
      if (hwLayout.mode === "dock") {
        // angedockte Leiste an der Kopfzeile ziehen: weit genug weg -> wieder schwebend
        if (Math.abs(dx) > 60 || Math.abs(dy) > 60) {
          hwPanelGeo = { x: e.clientX - 140, y: Math.max(8, e.clientY - 20), w: (hwPanelGeo && hwPanelGeo.w) || 360, h: (hwPanelGeo && hwPanelGeo.h) || 480 };
          setHwLayout({ mode: "float" });
          hwDrag.r = hwPanel.getBoundingClientRect();
          hwDrag.sx = e.clientX;
          hwDrag.sy = e.clientY;
        }
        return;
      }
      const x = Math.max(8 - r.width + 80, Math.min(window.innerWidth - 80, r.left + dx));
      const y = Math.max(8, Math.min(window.innerHeight - 48, r.top + dy));
      hwPanel.style.left = x + "px";
      hwPanel.style.top = y + "px";
      // an den Rand gezogen -> als Seitenleiste andocken
      hwPanel.classList.toggle("dock-hint-left", e.clientX < 24);
      hwPanel.classList.toggle("dock-hint-right", e.clientX > window.innerWidth - 24);
    } else {
      hwPanel.style.width = Math.max(240, Math.min(window.innerWidth - r.left - 8, r.width + dx)) + "px";
      hwPanel.style.height = Math.max(160, Math.min(window.innerHeight - r.top - 8, r.height + dy)) + "px";
    }
  }
  function hwEndDrag(e) {
    if (!hwDrag || hwDrag.id !== e.pointerId) return;
    const kind = hwDrag.kind;
    hwDrag = null;
    hwPanel.classList.remove("dragging");
    const toLeft = hwPanel.classList.contains("dock-hint-left");
    const toRight = hwPanel.classList.contains("dock-hint-right");
    hwPanel.classList.remove("dock-hint-left", "dock-hint-right");
    if (kind === "edge") {
      lsSet("sofianotes-hwpanel-layout", hwLayout);
      return;
    }
    saveHwPanelGeo();
    if (kind === "move" && (toLeft || toRight)) setHwLayout({ mode: "dock", side: toLeft ? "left" : "right" });
  }
  const hwHead = document.getElementById("hw-panel-head");
  const hwResize = document.getElementById("hw-panel-resize");
  const hwEdge = document.getElementById("hw-dock-edge");
  hwHead?.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    hwStartDrag(e, "move");
  });
  hwResize?.addEventListener("pointerdown", (e) => hwStartDrag(e, "size"));
  hwEdge?.addEventListener("pointerdown", (e) => hwStartDrag(e, "edge"));
  for (const el of [hwHead, hwResize, hwEdge]) {
    el?.addEventListener("pointermove", hwMoveDrag);
    el?.addEventListener("pointerup", hwEndDrag);
    el?.addEventListener("pointercancel", hwEndDrag);
  }

  // Minimierte Leiste: antippen oeffnet, ziehen verschiebt
  let hwPillPos = lsGet("sofianotes-hwpill-pos", null);
  let hwPillDrag = null;
  function placeHwPill() {
    if (!hwPillPos) {
      hwPill.style.left = "";
      hwPill.style.top = "";
      hwPill.style.right = "";
      return;
    }
    const w = hwPill.offsetWidth || 220;
    const h = hwPill.offsetHeight || 44;
    hwPill.style.right = "auto";
    hwPill.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, hwPillPos.x)) + "px";
    hwPill.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, hwPillPos.y)) + "px";
  }
  hwPill?.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const r = hwPill.getBoundingClientRect();
    hwPillDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: r.left, y0: r.top, moved: false };
    try {
      hwPill.setPointerCapture(e.pointerId);
    } catch (err) {}
  });
  hwPill?.addEventListener("pointermove", (e) => {
    const d = hwPillDrag;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true;
    hwPillPos = { x: d.x0 + dx, y: d.y0 + dy };
    placeHwPill();
  });
  const endPill = (e) => {
    const d = hwPillDrag;
    if (!d || d.id !== e.pointerId) return;
    hwPillDrag = null;
    if (d.moved) lsSet("sofianotes-hwpill-pos", hwPillPos);
    else if (e.type === "pointerup") setHwPanelState("open");
  };
  hwPill?.addEventListener("pointerup", endPill);
  hwPill?.addEventListener("pointercancel", endPill);

  // ---- Bild im Fenster zoomen und so stehen lassen ----
  let hwView = null; // {i, s, tx, ty}
  const hwPtrs = new Map();
  let hwPinch = null;
  function hwViewerKey() {
    return "sofianotes-hwviewer:" + currentBoardId;
  }
  function hwViewerState() {
    return lsGet(hwViewerKey(), { open: false, i: 0 });
  }
  function saveHwViewer() {
    if (!hwView) return lsSet(hwViewerKey(), { open: false, i: 0 });
    lsSet(hwViewerKey(), { open: true, i: hwView.i, s: hwView.s, tx: hwView.tx, ty: hwView.ty });
  }
  // PDFs: Seiten untereinander als Bilder in einem Kasten, der wie ein Bild gezoomt wird
  const hwPdfBox = document.createElement("div");
  hwPdfBox.className = "hw-pdf-box hidden";
  hwViewerStage?.appendChild(hwPdfBox);
  const PDF_VIEW_W = 1000;
  const pdfViews = new Map(); // url -> {w, h, el, loading}
  function hwTarget() {
    return hwView && hwView.kind === "pdf" ? hwPdfBox : hwViewerImg;
  }
  function hwTargetSize() {
    if (hwView && hwView.kind === "pdf") {
      const v = pdfViews.get(hwView.url);
      return { w: PDF_VIEW_W, h: (v && v.h) || PDF_VIEW_W * 1.414 };
    }
    return { w: hwViewerImg.naturalWidth || 1, h: hwViewerImg.naturalHeight || 1 };
  }
  async function buildPdfView(url) {
    let v = pdfViews.get(url);
    if (v) return v;
    if (window.ensurePdf) await window.ensurePdf().catch(() => null);
    if (!window.pdfjsLib) throw new Error("pdfjs");
    const el = document.createElement("div");
    v = { w: PDF_VIEW_W, h: 0, el, ready: null };
    pdfViews.set(url, v);
    v.ready = (async () => {
      const buf = await (await fetch(url)).arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      const n = Math.min(pdf.numPages, 80);
      const pages = [];
      let y = 0;
      for (let i = 1; i <= n; i++) {
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const h = (PDF_VIEW_W * base.height) / base.width;
        const im = document.createElement("img");
        im.className = "hw-pdf-page";
        Object.assign(im.style, { top: y + "px", width: PDF_VIEW_W + "px", height: h + "px" });
        el.appendChild(im);
        pages.push({ page, im, base });
        y += h + 16;
      }
      v.h = Math.max(1, y - 16);
      el.style.height = v.h + "px";
      // Inhalte nacheinander zeichnen (scharf genug fuers Reinzoomen)
      (async () => {
        for (const p of pages) {
          const vp = p.page.getViewport({ scale: (PDF_VIEW_W * 1.6) / p.base.width });
          const c = document.createElement("canvas");
          c.width = Math.round(vp.width);
          c.height = Math.round(vp.height);
          await p.page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
          p.im.src = c.toDataURL("image/jpeg", 0.85);
          c.width = c.height = 0;
        }
      })();
      return v;
    })();
    try {
      await v.ready;
    } catch (err) {
      pdfViews.delete(url);
      throw err;
    }
    return v;
  }
  function hwApplyView() {
    if (!hwView) return;
    hwTarget().style.transform = `translate(${hwView.tx}px, ${hwView.ty}px) scale(${hwView.s})`;
  }
  function hwFit() {
    const r = hwViewerStage.getBoundingClientRect();
    const { w: iw, h: ih } = hwTargetSize();
    if (hwView.kind === "pdf") {
      // Seitenbreite einpassen, oben anfangen
      const s = (r.width - 16) / iw;
      hwView.s = s;
      hwView.tx = 8;
      hwView.ty = 8;
    } else {
      const s = Math.min(r.width / iw, r.height / ih);
      hwView.s = s;
      hwView.tx = (r.width - iw * s) / 2;
      hwView.ty = (r.height - ih * s) / 2;
    }
    hwApplyView();
    saveHwViewer();
  }
  function hwZoomAt(px, py, f) {
    const s = Math.max(0.05, Math.min(12, hwView.s * f));
    const k = s / hwView.s;
    hwView.tx = px - (px - hwView.tx) * k;
    hwView.ty = py - (py - hwView.ty) * k;
    hwView.s = s;
    hwApplyView();
  }
  function openHwViewer(i, restore) {
    const imgs = panelItems();
    if (!imgs.length || i < 0) return;
    i = Math.max(0, Math.min(imgs.length - 1, i || 0));
    const saved = restore ? hwViewerState() : null;
    const item = imgs[i];
    hwView = { i, s: 1, tx: 0, ty: 0, kind: item.kind, url: item.url };
    hwPanelBody.classList.add("hidden");
    hwViewer.classList.remove("hidden");
    document.getElementById("hw-viewer-name").textContent = item.name || (item.kind === "pdf" ? "PDF" : "Bild");
    hwViewerImg.classList.toggle("hidden", item.kind === "pdf");
    hwPdfBox.classList.toggle("hidden", item.kind !== "pdf");
    if (item.kind === "pdf") {
      const view = hwView;
      hwPdfBox.innerHTML = "";
      hwPdfBox.textContent = "";
      buildPdfView(item.url)
        .then((v) => {
          if (hwView !== view) return;
          hwPdfBox.innerHTML = "";
          hwPdfBox.appendChild(v.el);
          hwPdfBox.style.width = PDF_VIEW_W + "px";
          hwPdfBox.style.height = v.h + "px";
          if (saved && saved.s && saved.i === i) {
            Object.assign(hwView, { s: saved.s, tx: saved.tx, ty: saved.ty });
            hwApplyView();
          } else hwFit();
          saveHwViewer();
        })
        .catch(() => {
          showToast("PDF konnte nicht geöffnet werden");
          closeHwViewer();
        });
      return;
    }
    const done = () => {
      if (saved && saved.s && saved.i === i) {
        Object.assign(hwView, { s: saved.s, tx: saved.tx, ty: saved.ty });
        hwApplyView();
      } else hwFit();
      saveHwViewer();
    };
    if (hwViewerImg.getAttribute("src") === imgs[i].url && hwViewerImg.complete) done();
    else {
      hwViewerImg.onload = done;
      hwViewerImg.src = imgs[i].url;
    }
  }
  function closeHwViewer(keep) {
    hwView = null;
    hwViewer.classList.add("hidden");
    hwPanelBody.classList.remove("hidden");
    if (!keep && currentBoardId) saveHwViewer();
  }
  document.getElementById("hw-viewer-back")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeHwViewer();
  });
  const stageMid = () => {
    const r = hwViewerStage.getBoundingClientRect();
    return [r.width / 2, r.height / 2];
  };
  document.getElementById("hw-viewer-in")?.addEventListener("click", (e) => {
    e.stopPropagation();
    hwZoomAt(...stageMid(), 1.35);
    saveHwViewer();
  });
  document.getElementById("hw-viewer-out")?.addEventListener("click", (e) => {
    e.stopPropagation();
    hwZoomAt(...stageMid(), 1 / 1.35);
    saveHwViewer();
  });
  document.getElementById("hw-viewer-fit")?.addEventListener("click", (e) => {
    e.stopPropagation();
    hwFit();
  });
  hwViewerStage?.addEventListener(
    "wheel",
    (e) => {
      if (!hwView) return;
      e.preventDefault();
      const r = hwViewerStage.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) hwZoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022));
      else {
        hwView.tx -= e.deltaX;
        hwApplyView();
      }
      saveHwViewer();
    },
    { passive: false }
  );
  hwViewerStage?.addEventListener("pointerdown", (e) => {
    if (!hwView) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      hwViewerStage.setPointerCapture(e.pointerId);
    } catch (err) {}
    hwPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (hwPtrs.size === 2) {
      const [a, b] = Array.from(hwPtrs.values());
      hwPinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: hwView.s, tx: hwView.tx, ty: hwView.ty, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
  });
  hwViewerStage?.addEventListener("pointermove", (e) => {
    if (!hwView || !hwPtrs.has(e.pointerId)) return;
    const prev = hwPtrs.get(e.pointerId);
    hwPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = hwViewerStage.getBoundingClientRect();
    if (hwPtrs.size >= 2 && hwPinch) {
      const [a, b] = Array.from(hwPtrs.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const s = Math.max(0.05, Math.min(12, hwPinch.s * (d / Math.max(1, hwPinch.d))));
      const k = s / hwPinch.s;
      const ox = hwPinch.mx - r.left;
      const oy = hwPinch.my - r.top;
      hwView.s = s;
      hwView.tx = ox - (ox - hwPinch.tx) * k + (mx - hwPinch.mx);
      hwView.ty = oy - (oy - hwPinch.ty) * k + (my - hwPinch.my);
      hwApplyView();
    } else if (hwPtrs.size === 1) {
      hwView.tx += e.clientX - prev.x;
      hwView.ty += e.clientY - prev.y;
      hwApplyView();
    }
  });
  const hwPtrEnd = (e) => {
    if (!hwPtrs.has(e.pointerId)) return;
    hwPtrs.delete(e.pointerId);
    if (hwPtrs.size < 2) hwPinch = null;
    saveHwViewer();
  };
  hwViewerStage?.addEventListener("pointerup", hwPtrEnd);
  hwViewerStage?.addEventListener("pointercancel", hwPtrEnd);
  hwViewerStage?.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    const r = hwViewerStage.getBoundingClientRect();
    hwZoomAt(e.clientX - r.left, e.clientY - r.top, 2);
    saveHwViewer();
  });

  // ---- Blatt als Loesung in Sofia teilen ----
  // Wie geteilt wird, ist eine globale Einstellung (automatisch / per Knopf / nie).
  // Im Modus "Knopf" erscheint oben im Aufgaben-Fenster ein kleiner Upload-Knopf.
  const hwShareBtn = document.getElementById("hw-panel-share");
  let hwSolution = null;
  function renderSolution() {
    const st = hwSolution;
    const show = !!st && !!st.owner && mySettings.solutionMode === "manual";
    hwShareBtn.classList.toggle("hidden", !show);
    if (!show) return;
    hwShareBtn.classList.toggle("busy", !!st.uploading);
    hwShareBtn.firstElementChild.textContent = st.uploading ? "progress_activity" : st.error ? "sync_problem" : st.syncedAt ? "cloud_done" : "cloud_upload";
    hwShareBtn.title = st.syncedAt
      ? "Als Lösung in Sofia teilen · zuletzt " + new Date(st.syncedAt * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
      : "Als Lösung in Sofia teilen";
  }
  async function refreshSolutionStatus() {
    const bid = currentBoardId;
    if (!hwBoard || !bid) return;
    try {
      const st = await api("/api/boards/" + encodeURIComponent(bid) + "/solution");
      if (bid !== currentBoardId) return;
      hwSolution = st;
      renderSolution();
    } catch (err) {
      /* offline */
    }
  }
  hwShareBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!hwSolution || !currentBoardId || hwSolution.uploading) return;
    const bid = currentBoardId;
    hwSolution.uploading = true;
    renderSolution();
    try {
      const res = await api("/api/boards/" + encodeURIComponent(bid) + "/solution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload: true }),
      });
      if (res && res.error === "empty") showToast("Das Blatt ist noch leer");
      else if (res && res.ok === false) throw new Error(res.error || "fail");
      else showToast("Als Lösung in Sofia geteilt");
    } catch (err) {
      showToast("Hochladen hat nicht geklappt");
    }
    if (hwSolution) hwSolution.uploading = false;
    refreshSolutionStatus();
  });

  // Im Fenster scrollen/tippen darf nichts aufs Blatt malen
  hwPanel?.addEventListener("pointerdown", (e) => e.stopPropagation());
  window.addEventListener("resize", () => {
    if (!currentBoardId) return;
    if (!hwPanel.classList.contains("hidden")) applyHwPanelState(hwPanelCurrent);
    if (!hwPill.classList.contains("hidden")) placeHwPill();
  });

  function renderLibrary() {
    if (!libraryCache) return;
    const crumbs = document.getElementById("library-crumbs");
    const eyebrow = document.getElementById("library-person");
    const backBtn = document.getElementById("btn-library-home");
    const atRoot = !libraryCache.crumbs || !libraryCache.crumbs.length;
    if (atRoot) {
      crumbs.textContent = personName(currentPersonId) || "Bibliothek";
      eyebrow.classList.add("hidden");
      backBtn.classList.add("hidden");
    } else {
      crumbs.textContent = libraryCache.crumbs.map((c) => c.name).join(" › ");
      eyebrow.classList.remove("hidden");
      backBtn.classList.remove("hidden");
    }
    const list = document.getElementById("library-list");
    list.innerHTML = "";
    const searchQ = librarySearchQuery.trim().toLowerCase();
    const folders = (libraryCache.folders || []).filter((f) => !searchQ || f.name.toLowerCase().includes(searchQ));
    const boards = (libraryCache.boards || []).filter((b) => !searchQ || b.title.toLowerCase().includes(searchQ));
    const section = (title, count, cls) => {
      const head = document.createElement("div");
      head.className = "lib-section-title";
      head.innerHTML = "<span></span><span class=\"lib-count\"></span>";
      head.firstChild.textContent = title;
      head.lastChild.textContent = String(count);
      list.appendChild(head);
      const grid = document.createElement("div");
      grid.className = "lib-grid " + cls;
      list.appendChild(grid);
      return grid;
    };
    if (folders.length) {
      // Fach, das laut Sofia-Stundenplan gerade dran ist (oder als Naechstes), steht vorne
      const hl = atRoot && !searchQ ? sofiaHighlight() : null;
      if (hl) {
        const i = folders.findIndex((f) => f.id === hl.folderId);
        if (i > 0) folders.unshift(folders.splice(i, 1)[0]);
      }
      const grid = section("Ordner", folders.length, "lib-grid-folders");
      for (const folder of folders) grid.appendChild(folderCard(folder, hl && hl.folderId === folder.id ? hl : null));
    }
    if (boards.length) {
      const grid = section("Blätter", boards.length, "lib-grid-boards");
      for (const board of boards) grid.appendChild(boardCard(board));
    }
    if (!folders.length && !boards.length && libraryCache.loading) {
      // Inhalt kommt gleich: Platzhalter statt "leer"
      const grid = document.createElement("div");
      grid.className = "lib-grid lib-grid-boards lib-skeleton-grid";
      for (let i = 0; i < 6; i++) grid.insertAdjacentHTML("beforeend", '<div class="lib-skeleton"><span></span><span></span></div>');
      list.appendChild(grid);
    } else if (!folders.length && !boards.length) {
      const empty = document.createElement("div");
      empty.className = "library-empty";
      empty.innerHTML = searchQ
        ? '<i data-lucide="search-x"></i><strong>Nichts gefunden</strong><span>Probier einen anderen Suchbegriff.</span>'
        : '<i data-lucide="notebook-pen"></i><strong>Noch leer</strong><span>Leg über „Neu“ ein Blatt oder einen Ordner an.</span>';
      list.appendChild(empty);
    }
    if (window.lucide) lucide.createIcons();
  }

  function libRowIcon(name, color) {
    const box = document.createElement("div");
    box.className = "lib-row-icon";
    if (color) box.style.background = color;
    box.innerHTML = `<i data-lucide="${name}"></i>`;
    return box;
  }

  function starBtn(starred, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.title = starred ? "Favorit entfernen" : "Als Favorit markieren";
    b.className = "lib-star-btn" + (starred ? " starred" : "");
    b.innerHTML = `<i data-lucide="star"></i>`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function moreBtn(items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lib-more-btn";
    b.title = "Mehr";
    b.innerHTML = `<i data-lucide="ellipsis"></i>`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openItemMenu(b, items);
    });
    return b;
  }

  // "vor 5 Min." / "gestern" / Datum
  function relTime(ts) {
    if (!ts) return "";
    const d = Date.now() / 1000 - ts;
    if (d < 60) return "gerade eben";
    if (d < 3600) return "vor " + Math.round(d / 60) + " Min.";
    if (d < 86400) return "vor " + Math.round(d / 3600) + " Std.";
    if (d < 172800) return "gestern";
    if (d < 7 * 86400) return "vor " + Math.round(d / 86400) + " Tagen";
    return new Date(ts * 1000).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });
  }

  function libCard(kind, { icon, color, title, meta, starred, onOpen, onStar, menu, now, id }) {
    const el = document.createElement("div");
    if (id) {
      el.dataset.id = id;
      armLibDrag(el, kind, id);
    }
    el.className = "library-item lib-card lib-card-" + kind + (now ? " lib-card-now" + (now.kind === "next" ? " is-next" : "") : "");
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.appendChild(libRowIcon(icon, color));
    el.insertAdjacentHTML("beforeend", `<div class="lib-row-text"><strong></strong><span class="meta"></span></div>`);
    el.querySelector("strong").textContent = title;
    el.querySelector(".meta").textContent = now ? now.label : meta;
    if (now) {
      const chip = document.createElement("span");
      chip.className = "lib-now-chip";
      chip.textContent = now.kind === "next" ? "Als Nächstes" : "Jetzt";
      el.querySelector(".lib-row-text").prepend(chip);
    }
    el.addEventListener("click", (e) => {
      if (libDragJustEnded()) return;
      onOpen(e);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === el) onOpen();
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (libDrag) return; // langes Druecken mit dem Finger = ziehen, nicht Menue
      openItemMenu(el.querySelector(".lib-more-btn"), menu);
    });
    el.appendChild(starBtn(starred, onStar));
    el.appendChild(moreBtn(menu));
    return el;
  }

  function folderCard(folder, now) {
    return libCard("folder", {
      now,
      id: folder.id,
      icon: "folder",
      color: folder.color,
      title: folder.name,
      meta: "Ordner",
      starred: folder.starred,
      onOpen: () => navigateToFolder(folder.id, true, folder),
      onStar: () => {
        const want = !folder.starred;
        optimistic({
          apply: () => {
            folder.starred = want;
            renderLibrary();
          },
          revert: () => {
            folder.starred = !want;
            renderLibrary();
          },
          request: () =>
            api("/api/folders/" + encodeURIComponent(folder.id) + "/star", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ starred: want }),
            }).then(persistLibraryCache),
        });
      },
      menu: [
        { icon: "folder-open", label: "Öffnen", run: () => navigateToFolder(folder.id, true, folder) },
        { icon: "pencil", label: "Umbenennen & Farbe", run: () => renameFolder(folder) },
        { icon: "folder-input", label: "Verschieben", run: () => openMove("folder", folder.id) },
        { icon: "grid-3x3", label: "Papier für neue Blätter" + (folder.paper ? ": " + GRID_NAMES[folder.paper] : ""), run: () => folderPaperMenu(folder) },
        { icon: "trash-2", label: "Löschen", danger: true, run: () => deleteFolder(folder) },
      ],
    });
  }

  function boardCard(board) {
    const owner = personName(board.ownerId);
    const when = relTime(board.updatedAt);
    const meta = (board.shared ? "Geteilt von " + owner : board.notebook ? "Notizbuch" : "Blatt") + (when ? " · " + when : "");
    const menu = [
      { icon: "square-pen", label: "Öffnen", run: () => openBoard(board.id, board.title) },
      { icon: "folder-input", label: "In Ordner legen", run: () => openMove("board", board.id) },
      { icon: "download", label: "Exportieren", run: () => openExportDialog(board.id, board.title) },
    ];
    if (!board.shared) {
      menu.splice(1, 0, { icon: "pencil", label: "Umbenennen", run: () => renameBoard(board) });
      menu.push({ icon: "share-2", label: "Teilen", run: () => openShare(board) });
      menu.push({ icon: "trash-2", label: "Löschen", danger: true, run: () => deleteBoard(board) });
    }
    return libCard("board", {
      id: board.id,
      icon: board.shared ? "users" : board.notebook ? "notebook-pen" : "file-pen-line",
      title: board.title,
      meta,
      starred: board.starred,
      onOpen: () => openBoard(board.id, board.title),
      onStar: () => {
        const want = !board.starred;
        optimistic({
          apply: () => {
            board.starred = want;
            renderLibrary();
          },
          revert: () => {
            board.starred = !want;
            renderLibrary();
          },
          request: () =>
            api("/api/boards/" + encodeURIComponent(board.id) + "/star", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ starred: want }),
            }).then(persistLibraryCache),
        });
      },
      menu,
    });
  }

  // ⋯-Menue an einer Karte
  const libItemMenu = document.getElementById("lib-item-menu");
  function closeItemMenu() {
    if (libItemMenu) libItemMenu.classList.add("hidden");
  }
  let itemMenuAnchor = null;
  // Papier fuer neue Blaetter in diesem Ordner (und seinen Unterordnern)
  function folderPaperMenu(folder) {
    const set = (paper) => {
      const was = folder.paper || null;
      optimistic({
        apply: () => {
          folder.paper = paper;
        },
        revert: () => {
          folder.paper = was;
        },
        request: () =>
          api("/api/folders/" + encodeURIComponent(folder.id), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paper }),
          }).then(persistLibraryCache),
        failText: "Papier ändern hat nicht geklappt",
      });
    };
    const items = [{ icon: folder.paper ? "circle" : "circle-check", label: "Wie Standard (" + (GRID_NAMES[mySettings.defaultPaper] || "Kariert") + ")", run: () => set(null) }];
    for (const k of Object.keys(GRID_NAMES)) items.push({ icon: folder.paper === k ? "circle-check" : "circle", label: GRID_NAMES[k], run: () => set(k) });
    openItemMenu(itemMenuAnchor, items);
  }

  // ---- Startseite: Karte lange halten und auf einen Ordner ziehen ----
  let libDrag = null; // {el, kind, id, timer, x0, y0, active, ghost, target, pointerId}
  let libDragEndedAt = 0;
  function libDragJustEnded() {
    return performance.now() - libDragEndedAt < 400;
  }
  function libDropTarget(x, y, self) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    const card = hit.closest(".lib-card-folder[data-id]");
    if (card && card !== self) return { el: card, folderId: card.dataset.id };
    const back = hit.closest("#btn-library-home");
    if (back && currentFolderId && libraryCache && libraryCache.crumbs) {
      const c = libraryCache.crumbs;
      return { el: back, folderId: c.length > 1 ? c[c.length - 2].id : null };
    }
    return null;
  }
  function armLibDrag(el, kind, id) {
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest("button")) return;
      cancelLibDrag();
      libDrag = { el, kind, id, x0: e.clientX, y0: e.clientY, active: false, pointerId: e.pointerId };
      libDrag.timer = setTimeout(() => startLibDrag(e.clientX, e.clientY), e.pointerType === "mouse" ? 350 : 450);
    });
  }
  function startLibDrag(x, y) {
    if (!libDrag) return;
    const r = libDrag.el.getBoundingClientRect();
    const g = libDrag.el.cloneNode(true);
    g.classList.add("lib-drag-ghost");
    Object.assign(g.style, { width: r.width + "px", left: r.left + "px", top: r.top + "px" });
    document.body.appendChild(g);
    libDrag.ghost = g;
    libDrag.dx = x - r.left;
    libDrag.dy = y - r.top;
    libDrag.active = true;
    libDrag.el.classList.add("lib-dragging");
    if (navigator.vibrate) navigator.vibrate(12);
  }
  function cancelLibDrag() {
    if (!libDrag) return;
    clearTimeout(libDrag.timer);
    if (libDrag.ghost) libDrag.ghost.remove();
    libDrag.el.classList.remove("lib-dragging");
    if (libDrag.target) libDrag.target.el.classList.remove("lib-drop-target");
    if (libDrag.active) libDragEndedAt = performance.now();
    libDrag = null;
  }
  window.addEventListener("pointermove", (e) => {
    if (!libDrag || e.pointerId !== libDrag.pointerId) return;
    if (!libDrag.active) {
      if (Math.hypot(e.clientX - libDrag.x0, e.clientY - libDrag.y0) > 8) cancelLibDrag();
      return;
    }
    libDrag.ghost.style.left = e.clientX - libDrag.dx + "px";
    libDrag.ghost.style.top = e.clientY - libDrag.dy + "px";
    const t = libDropTarget(e.clientX, e.clientY, libDrag.el);
    if ((t && t.el) !== (libDrag.target && libDrag.target.el)) {
      if (libDrag.target) libDrag.target.el.classList.remove("lib-drop-target");
      if (t) t.el.classList.add("lib-drop-target");
    }
    libDrag.target = t;
  });
  const endLibDrag = (e) => {
    if (!libDrag || e.pointerId !== libDrag.pointerId) return;
    const d = libDrag;
    const drop = d.active && e.type === "pointerup" ? d.target : null;
    cancelLibDrag();
    if (drop) applyMove(d.kind, d.id, drop.folderId);
  };
  window.addEventListener("pointerup", endLibDrag);
  window.addEventListener("pointercancel", endLibDrag);
  // Waehrend des Ziehens darf die Liste nicht scrollen
  window.addEventListener(
    "touchmove",
    (e) => {
      if ((libDrag && libDrag.active) || (hwImgDrag && hwImgDrag.active)) e.preventDefault();
    },
    { passive: false }
  );

  function openItemMenu(anchor, items) {
    if (!libItemMenu || !anchor) return;
    itemMenuAnchor = anchor;
    libItemMenu.innerHTML = "";
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lib-add-opt" + (it.danger ? " danger" : "");
      b.innerHTML = `<i data-lucide="${it.icon}"></i><span></span>`;
      b.querySelector("span").textContent = it.label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        closeItemMenu();
        it.run();
      });
      libItemMenu.appendChild(b);
    }
    libItemMenu.classList.remove("hidden");
    if (window.lucide) lucide.createIcons();
    const r = anchor.getBoundingClientRect();
    const mw = libItemMenu.offsetWidth;
    const mh = libItemMenu.offsetHeight;
    let left = r.right - mw;
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
    libItemMenu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, left)) + "px";
    libItemMenu.style.top = Math.max(8, top) + "px";
  }
  document.addEventListener("pointerdown", (e) => {
    if (libItemMenu && !libItemMenu.classList.contains("hidden") && !e.target.closest("#lib-item-menu") && !e.target.closest(".lib-more-btn")) closeItemMenu();
  }, true);
  document.getElementById("library-backdrop")?.addEventListener("scroll", closeItemMenu, true);

  async function openBoard(id, title, opts) {
    if (window.sofiaHistoryClose && id !== currentBoardId) window.sofiaHistoryClose();
    // Immer trennen+neu verbinden, auch beim Wiedereroeffnen desselben
    // Boards: eine noch offene WS-Verbindung wuerde sonst keine frische
    // "init"-Nachricht mehr bekommen (connectWS() ist dann ein No-Op), und
    // currentBoardMeta bliebe fuer immer auf dem Platzhalter unten stehen -
    // z.B. eine Freigabe, die laengst besteht, wuerde nach dem Verlassen
    // und Wiederbetreten des Boards nicht mehr angezeigt.
    if (currentBoardId) {
      boardStrokes.clear();
      clearSelection();
      undoStack.length = 0;
      redoStack.length = 0;
      updateUndoRedoButtons();
      disconnectWS();
    }
    if (id !== notebookBoardId) {
      notebook = null;
      notebookBoardId = null;
    }
    currentBoardId = id;
    currentBoardMeta = { id, title, ownerId: currentPersonId, sharedWith: [] };
    if (!opts || opts.homework === undefined) syncHomeworkPanel(null);
    else syncHomeworkPanel({ id, sofiaHomeworkId: opts.homework.id }, opts.homework);
    if (filenameInput) filenameInput.value = title || "Unbenannte Skizze";
    fitFilename();
    if (title) document.title = title + " – sofianotes";
    hideLibrary({ fromHistory: true });
    if (!(opts && opts.fromHistory)) syncUrl(true);
    if (window.SofiaOffline) {
      const local = await SofiaOffline.getStrokes(id);
      if (local && local.length) applyStrokeList(local);
    }
    requestRedraw();
    wantWs = true;
    if (await probeOnline()) {
      await flushOutbox();
      connectWS();
    } else {
      setConnState("offline");
    }
  }

  // ---- Sofia-Style Bottom-Sheet fuer Namenseingabe (ersetzt window.prompt) --
  const FOLDER_COLORS = ["#eaddff", "#d3e3fd", "#c4eed0", "#ffdec1", "#ffd8e4", "#fff3c4"];
  const nameSheetScrim = document.getElementById("name-sheet-scrim");
  const nameSheetTitle = document.getElementById("name-sheet-title");
  const nameSheetLabel = document.getElementById("name-sheet-label");
  const nameSheetInput = document.getElementById("name-sheet-input");
  const nameSheetColorField = document.getElementById("name-sheet-color-field");
  const nameSheetColorsEl = document.getElementById("name-sheet-colors");
  const nameSheetCancel = document.getElementById("name-sheet-cancel");
  const nameSheetSave = document.getElementById("name-sheet-save");
  let nameSheetResolve = null;
  let nameSheetSelectedColor = null;

  function openNameSheet({ title, label, initial = "", placeholder = "", colors = false, initialColor = FOLDER_COLORS[0] }) {
    return new Promise((resolve) => {
      nameSheetResolve = resolve;
      nameSheetTitle.textContent = title;
      nameSheetLabel.textContent = label;
      nameSheetInput.value = initial;
      nameSheetInput.placeholder = placeholder;
      nameSheetColorField.classList.toggle("hidden", !colors);
      nameSheetSelectedColor = colors ? initialColor : null;
      nameSheetColorsEl.innerHTML = "";
      if (colors) {
        for (const c of FOLDER_COLORS) {
          const sw = document.createElement("button");
          sw.type = "button";
          sw.className = "name-sheet-color-swatch" + (c === initialColor ? " selected" : "");
          sw.style.background = c;
          sw.addEventListener("click", () => {
            nameSheetSelectedColor = c;
            nameSheetColorsEl.querySelectorAll(".name-sheet-color-swatch").forEach((el) => el.classList.remove("selected"));
            sw.classList.add("selected");
          });
          nameSheetColorsEl.appendChild(sw);
        }
      }
      nameSheetScrim.classList.remove("hidden");
      nameSheetInput.focus();
      nameSheetInput.select();
    });
  }
  function closeNameSheet(value) {
    nameSheetScrim.classList.add("hidden");
    const resolve = nameSheetResolve;
    nameSheetResolve = null;
    if (resolve) resolve(value === null ? null : { value, color: nameSheetSelectedColor });
  }
  nameSheetCancel.addEventListener("click", () => closeNameSheet(null));
  nameSheetSave.addEventListener("click", () => closeNameSheet(nameSheetInput.value));
  nameSheetScrim.addEventListener("click", (e) => {
    if (e.target === nameSheetScrim) closeNameSheet(null);
  });
  nameSheetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") closeNameSheet(nameSheetInput.value);
    else if (e.key === "Escape") closeNameSheet(null);
  });

  // ---- Sofort umschalten, im Hintergrund speichern ---------------------------
  // apply() aendert die Anzeige sofort. Lehnt der Server ab, springt revert() zurueck und
  // ein kurzer Hinweis erscheint. Ohne Netz geht die Aenderung (falls moeglich) in die
  // Warteschlange und wird spaeter nachgeholt.
  let toastEl = null;
  let toastTimer = null;
  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "app-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }
  async function optimistic({ apply, revert, request, offlineOp, failText }) {
    apply();
    try {
      await request();
      return true;
    } catch (err) {
      const status = Number(err && err.message);
      if (!status && offlineOp) {
        await enqueueOp(offlineOp);
        setConnState("offline");
        return true;
      }
      revert();
      showToast(status ? failText || "Hat nicht geklappt – zurückgesetzt" : "Keine Verbindung – zurückgesetzt");
      return false;
    }
  }

  // Bestaetigen (ersetzt window.confirm): Promise<boolean>
  const confirmScrim = document.getElementById("confirm-scrim");
  let confirmResolve = null;
  function askConfirm({ title, text, ok = "Löschen", icon = "delete", danger = true }) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      confirmScrim.querySelector(".dlg-confirm-icon .material-symbols-rounded").textContent = icon;
      confirmScrim.querySelector(".dlg-confirm").classList.toggle("is-safe", !danger);
      document.getElementById("confirm-ok").classList.toggle("danger", danger);
      document.getElementById("confirm-title").textContent = title;
      document.getElementById("confirm-text").textContent = text || "";
      document.getElementById("confirm-ok").textContent = ok;
      confirmScrim.classList.remove("hidden");
      document.getElementById("confirm-ok").focus({ preventScroll: true });
    });
  }
  function closeConfirm(v) {
    confirmScrim.classList.add("hidden");
    const r = confirmResolve;
    confirmResolve = null;
    if (r) r(v);
  }
  document.getElementById("confirm-cancel").addEventListener("click", () => closeConfirm(false));
  document.getElementById("confirm-ok").addEventListener("click", () => closeConfirm(true));
  confirmScrim.addEventListener("click", (e) => {
    if (e.target === confirmScrim) closeConfirm(false);
  });

  // Escape schliesst den obersten Dialog
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!confirmScrim.classList.contains("hidden")) closeConfirm(false);
    else if (!nameSheetScrim.classList.contains("hidden")) closeNameSheet(null);
    else if (!shareBackdrop.classList.contains("hidden")) shareBackdrop.classList.add("hidden");
    else if (!moveBackdrop.classList.contains("hidden")) moveBackdrop.classList.add("hidden");
    else closeItemMenu();
  });

  // Dialoge bleiben ueber der Bildschirmtastatur (iPad/Handy): sichtbare Hoehe als CSS-Variable
  (function trackVisualViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const upd = () => {
      document.documentElement.style.setProperty("--vvh", vv.height + "px");
      document.documentElement.style.setProperty("--vvt", vv.offsetTop + "px");
    };
    vv.addEventListener("resize", upd);
    vv.addEventListener("scroll", upd);
    upd();
  })();

  async function renameBoard(board) {
    const res = await openNameSheet({ title: "Blatt umbenennen", label: "Titel", initial: board.title });
    if (res === null) return;
    const title = res.value.trim() || board.title;
    const old = board.title;
    if (title === old) return;
    const setTitle = (t) => {
      board.title = t;
      if (board.id === currentBoardId && filenameInput) {
        filenameInput.value = t;
        fitFilename();
      }
      renderLibrary();
    };
    optimistic({
      apply: () => setTitle(title),
      revert: () => setTitle(old),
      request: () =>
        api("/api/boards/" + encodeURIComponent(board.id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personId: currentPersonId, title }),
        }).then(persistLibraryCache),
      offlineOp: { type: "board_rename", personId: currentPersonId, id: board.id, title },
      failText: "Umbenennen hat nicht geklappt",
    });
  }


  // Notizbuch mit A4-Seiten (Papier der ersten Seite = Standard fuer neue Blaetter)
  async function createNotebook() {
    const res = await openNameSheet({ title: "Neues Notizbuch", label: "Titel", placeholder: "z. B. Deutsch Heft" });
    if (res === null) return;
    const title = res.value.trim() || "Notizbuch";
    const paper = mySettings.defaultPaper || "graph";
    const notebookData = { layout: "vertical", template: { paper }, pages: [{ id: "p" + uuid().slice(0, 12), paper, w: 794, h: 1123 }] };
    try {
      const created = await api("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: currentPersonId, title, folderId: currentFolderId, notebook: notebookData }),
      });
      await openBoard(created.board.id, created.board.title);
    } catch (err) {
      showToast("Notizbuch anlegen geht nur mit Verbindung");
    }
  }

  async function createBoard() {
    const res = await openNameSheet({ title: "Neues Blatt", label: "Titel", placeholder: "z. B. Mathe Mitschrift" });
    if (res === null) return;
    const title = res.value.trim() || "Unbenannte Skizze";
    try {
      const created = await api("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: currentPersonId, title, folderId: currentFolderId }),
      });
      await openBoard(created.board.id, created.board.title);
    } catch (err) {
      const id = uuid();
      await enqueueOp({ type: "board_create", personId: currentPersonId, title, folderId: currentFolderId, id });
      if (libraryCache) {
        libraryCache.boards = libraryCache.boards || [];
        libraryCache.boards.unshift({
          id,
          ownerId: currentPersonId,
          title,
          folderId: currentFolderId,
          shared: false,
          sharedWith: [],
        });
        if (window.SofiaOffline) {
          await SofiaOffline.setKv("lib:" + currentPersonId + ":" + (currentFolderId || ""), libraryCache);
        }
      }
      await openBoard(id, title);
    }
  }

  async function createFolder() {
    const res = await openNameSheet({ title: "Neuer Ordner", label: "Name", initial: "Ordner", colors: true });
    if (res === null) return;
    const name = res.value.trim() || "Ordner";
    const color = res.color;
    const id = uuid();
    const folder = { id, parentId: currentFolderId, name, sortOrder: 0, color, starred: false };
    const parentId = currentFolderId;
    optimistic({
      apply: () => {
        libraryCache.folders = libraryCache.folders || [];
        libraryCache.folders.push(folder);
        libraryCache.allFolders = libraryCache.allFolders || [];
        libraryCache.allFolders.push({ id, parentId, name, color });
        renderLibrary();
      },
      revert: () => {
        libraryCache.folders = (libraryCache.folders || []).filter((f) => f.id !== id);
        libraryCache.allFolders = (libraryCache.allFolders || []).filter((f) => f.id !== id);
        renderLibrary();
      },
      request: () =>
        api("/api/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personId: currentPersonId, name, parentId, color, id }),
        }).then(persistLibraryCache),
      offlineOp: { type: "folder_create", personId: currentPersonId, name, parentId, id, color },
      failText: "Ordner konnte nicht angelegt werden",
    });
  }

  async function renameFolder(folder) {
    const res = await openNameSheet({
      title: "Ordner umbenennen",
      label: "Name",
      initial: folder.name,
      colors: true,
      initialColor: folder.color || FOLDER_COLORS[0],
    });
    if (res === null) return;
    const name = res.value.trim() || folder.name;
    const color = res.color;
    const before = { name: folder.name, color: folder.color };
    if (name === before.name && color === before.color) return;
    const set = (v) => {
      folder.name = v.name;
      folder.color = v.color;
      const f2 = (libraryCache.allFolders || []).find((f) => f.id === folder.id);
      if (f2) Object.assign(f2, v);
      renderLibrary();
    };
    optimistic({
      apply: () => set({ name, color }),
      revert: () => set(before),
      request: () =>
        api("/api/folders/" + encodeURIComponent(folder.id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personId: currentPersonId, name, color }),
        }).then(persistLibraryCache),
      offlineOp: { type: "folder_rename", personId: currentPersonId, id: folder.id, name, color },
      failText: "Umbenennen hat nicht geklappt",
    });
  }

  // Eintrag sofort aus der Liste nehmen; klappt es nicht, kommt er an dieselbe Stelle zurueck
  function removeFromCache(list, id) {
    const arr = libraryCache[list] || [];
    const idx = arr.findIndex((x) => x.id === id);
    const item = idx >= 0 ? arr.splice(idx, 1)[0] : null;
    return () => {
      if (item) arr.splice(Math.min(idx, arr.length), 0, item);
    };
  }

  async function deleteFolder(folder) {
    const ok = await askConfirm({ title: "Ordner „" + folder.name + "“ löschen?", text: "Die Blätter darin bleiben erhalten – nur der Ordner verschwindet." });
    if (!ok) return;
    let undo = null;
    optimistic({
      apply: () => {
        undo = removeFromCache("folders", folder.id);
        renderLibrary();
      },
      revert: () => {
        if (undo) undo();
        renderLibrary();
      },
      request: () =>
        api("/api/folders/" + encodeURIComponent(folder.id) + "?person=" + encodeURIComponent(currentPersonId), {
          method: "DELETE",
        }).then(() => {
          libraryCache.allFolders = (libraryCache.allFolders || []).filter((f) => f.id !== folder.id);
          persistLibraryCache();
        }),
      offlineOp: { type: "folder_delete", personId: currentPersonId, id: folder.id },
      failText: "Ordner konnte nicht gelöscht werden",
    });
  }

  async function deleteBoard(board) {
    const ok = await askConfirm({ title: "„" + board.title + "“ löschen?", text: "Das Blatt wird endgültig gelöscht – auch für alle, mit denen es geteilt ist." });
    if (!ok) return;
    let undo = null;
    const done = await optimistic({
      apply: () => {
        undo = removeFromCache("boards", board.id);
        renderLibrary();
      },
      revert: () => {
        if (undo) undo();
        renderLibrary();
      },
      request: () =>
        api("/api/boards/" + encodeURIComponent(board.id) + "?person=" + encodeURIComponent(currentPersonId), {
          method: "DELETE",
        }).then(persistLibraryCache),
      offlineOp: { type: "board_delete", personId: currentPersonId, id: board.id },
      failText: "Blatt konnte nicht gelöscht werden",
    });
    if (done && currentBoardId === board.id) {
      currentBoardId = "";
      boardStrokes.clear();
      disconnectWS();
    }
  }

  function openShare(board) {
    const box = document.getElementById("share-choices");
    box.innerHTML = "";
    for (const p of PEOPLE) {
      if (p.id === currentPersonId) continue;
      const on = (board.sharedWith || []).includes(p.id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dlg-choice" + (on ? " on" : "");
      b.innerHTML = '<span class="dlg-avatar"></span><span class="dlg-choice-text"><strong></strong><small></small></span><i data-lucide="' + (on ? "check" : "plus") + '"></i>';
      b.querySelector(".dlg-avatar").textContent = (p.name || "?").slice(0, 1).toUpperCase();
      b.querySelector("strong").textContent = p.name;
      b.querySelector("small").textContent = on ? "Hat Zugriff – antippen zum Entfernen" : "Antippen zum Teilen";
      b.addEventListener("click", () => {
        const isOn = (board.sharedWith || []).includes(p.id);
        const set = (v) => {
          board.sharedWith = v ? [...new Set([...(board.sharedWith || []), p.id])] : (board.sharedWith || []).filter((x) => x !== p.id);
          b.classList.toggle("on", v);
          b.querySelector("small").textContent = v ? "Hat Zugriff – antippen zum Entfernen" : "Antippen zum Teilen";
          b.lastElementChild.outerHTML = '<i data-lucide="' + (v ? "check" : "plus") + '"></i>';
          if (window.lucide) lucide.createIcons();
        };
        optimistic({
          apply: () => set(!isOn),
          revert: () => set(isOn),
          request: () =>
            isOn
              ? api(
                  "/api/boards/" + encodeURIComponent(board.id) + "/share/" + encodeURIComponent(p.id) + "?person=" + encodeURIComponent(currentPersonId),
                  { method: "DELETE" }
                )
              : api("/api/boards/" + encodeURIComponent(board.id) + "/share", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ personId: currentPersonId, withPersonId: p.id }),
                }),
          offlineOp: isOn
            ? { type: "unshare", personId: currentPersonId, boardId: board.id, withPersonId: p.id }
            : { type: "share", personId: currentPersonId, boardId: board.id, withPersonId: p.id },
          failText: "Teilen hat nicht geklappt",
        }).then(persistLibraryCache);
      });
      box.appendChild(b);
    }
    if (!box.children.length) box.innerHTML = '<p class="share-hint">Es gibt noch keine anderen Personen.</p>';
    shareBackdrop.classList.remove("hidden");
    if (window.lucide) lucide.createIcons();
  }

  function openMove(kind, id) {
    const box = document.getElementById("move-choices");
    box.innerHTML = "";
    const choice = (icon, label, color, target) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dlg-choice";
      b.innerHTML = '<span class="dlg-folder-ico"><i data-lucide="' + icon + '"></i></span><span class="dlg-choice-text"><strong></strong></span><i data-lucide="chevron-right"></i>';
      if (color) b.querySelector(".dlg-folder-ico").style.background = color;
      b.querySelector("strong").textContent = label;
      b.addEventListener("click", () => applyMove(kind, id, target));
      box.appendChild(b);
    };
    document.getElementById("move-title").textContent = kind === "folder" ? "Ordner verschieben nach" : "In Ordner legen";
    choice("house", "Ganz oben (kein Ordner)", null, null);
    const folders = (libraryCache && libraryCache.allFolders) || [];
    for (const f of folders) {
      if (kind === "folder" && f.id === id) continue;
      choice("folder", f.name, f.color, f.id);
    }
    moveBackdrop.classList.remove("hidden");
    if (window.lucide) lucide.createIcons();
  }

  async function applyMove(kind, id, folderId) {
    moveBackdrop.classList.add("hidden");
    if ((folderId || null) === (currentFolderId || null)) return;
    let undo = null;
    optimistic({
      apply: () => {
        undo = removeFromCache(kind === "board" ? "boards" : "folders", id);
        renderLibrary();
      },
      revert: () => {
        if (undo) undo();
        renderLibrary();
      },
      request: () =>
        (kind === "board"
          ? api("/api/placements", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ personId: currentPersonId, boardId: id, folderId }),
            })
          : api("/api/folders/" + encodeURIComponent(id), {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ personId: currentPersonId, parentId: folderId }),
            })
        ).then(persistLibraryCache),
      offlineOp:
        kind === "board"
          ? { type: "place", personId: currentPersonId, boardId: id, folderId }
          : { type: "folder_move", personId: currentPersonId, id, parentId: folderId },
      failText: "Verschieben hat nicht geklappt",
    });
  }

  // ---- Admin: Personen + Mail-Adressen verwalten -----------------------
  const adminBackdrop = document.getElementById("admin-backdrop");
  const adminPeopleListEl = document.getElementById("admin-people-list");

  function openAdminPanel() {
    if (!isAdmin) return;
    adminBackdrop.classList.remove("hidden");
    loadAdminPeople();
    syncSofiaAdminHint();
  }
  // Kommen die Personen aus Sofia, ist hier nur Ansehen + "jetzt abgleichen" moeglich
  async function syncSofiaAdminHint() {
    let st = null;
    try {
      st = await api("/api/sofia/status");
    } catch (err) {
      st = null;
    }
    const on = !!(st && st.enabled);
    adminBackdrop.classList.toggle("from-sofia", on);
    let hint = document.getElementById("admin-sofia-hint");
    if (!on) {
      if (hint) hint.remove();
      return;
    }
    if (!hint) {
      hint = document.createElement("div");
      hint.id = "admin-sofia-hint";
      hint.className = "admin-sofia-hint";
      hint.innerHTML = '<span class="material-symbols-rounded">sync</span><div><strong>Personen kommen aus Sofia</strong><small></small></div><button type="button">Jetzt abgleichen</button>';
      adminPeopleListEl.parentElement.insertBefore(hint, adminPeopleListEl);
      hint.querySelector("button").addEventListener("click", async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = "Gleiche ab…";
        try {
          await api("/api/sofia/sync", { method: "POST" });
          await loadAdminPeople();
          await refreshPeople();
          libMem.clear();
          refreshLibrary();
        } catch (err) {
          showToast("Abgleich mit Sofia hat nicht geklappt");
        }
        b.disabled = false;
        b.textContent = "Jetzt abgleichen";
        syncSofiaAdminHint();
      });
    }
    const when = st.lastSync ? new Date(st.lastSync * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "noch nie";
    hint.querySelector("small").textContent = st.lastError
      ? "Letzter Versuch fehlgeschlagen: " + st.lastError
      : "Neue Personen und Fächer in Sofia erscheinen hier automatisch · zuletzt " + when + " · " + (st.people || 0) + " Personen, " + (st.subjects || 0) + " Fächer";
  }
  function closeAdminPanel() {
    adminBackdrop.classList.add("hidden");
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  async function loadAdminPeople() {
    let people;
    try {
      people = await api("/api/admin/people");
    } catch (err) {
      adminPeopleListEl.textContent = "Konnte Personen nicht laden.";
      return;
    }
    adminPeopleListEl.innerHTML = "";
    for (const person of people) {
      const card = document.createElement("div");
      card.className = "admin-person-card";

      const head = document.createElement("div");
      head.className = "admin-person-head";
      head.innerHTML =
        `<span>${escapeHtml(person.name)}</span>` +
        (person.isAdmin ? `<span class="admin-badge">Admin</span>` : "");
      const renameBtn = document.createElement("button");
      renameBtn.className = "link";
      renameBtn.textContent = "Umbenennen";
      renameBtn.addEventListener("click", async () => {
        const res = await openNameSheet({ title: "Person umbenennen", label: "Name", initial: person.name });
        if (res === null || !res.value.trim()) return;
        await api("/api/admin/people/" + encodeURIComponent(person.id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: res.value.trim() }),
        });
        await loadAdminPeople();
        await refreshPeople();
      });
      head.appendChild(renameBtn);
      if (!person.isAdmin) {
        const delBtn = document.createElement("button");
        delBtn.className = "danger";
        delBtn.textContent = "Löschen";
        delBtn.addEventListener("click", async () => {
          if (!(await askConfirm({ title: "„" + person.name + "“ löschen?", text: "Die Person verliert den Zugang. Geht nur, wenn sie keine eigenen Blätter mehr hat." }))) return;
          try {
            await api("/api/admin/people/" + encodeURIComponent(person.id), { method: "DELETE" });
            await loadAdminPeople();
            await refreshPeople();
          } catch (err) {
            window.alert("Geht nicht: hat noch eigene Blätter oder existiert nicht mehr.");
          }
        });
        head.appendChild(delBtn);
      }
      card.appendChild(head);

      for (const email of person.emails) {
        const row = document.createElement("div");
        row.className = "admin-email-row";
        const span = document.createElement("span");
        span.textContent = email;
        row.appendChild(span);
        const rm = document.createElement("button");
        rm.textContent = "✕";
        rm.title = "Mail-Adresse entfernen";
        rm.addEventListener("click", async () => {
          await api("/api/admin/people/" + encodeURIComponent(person.id) + "/emails/" + encodeURIComponent(email), {
            method: "DELETE",
          });
          loadAdminPeople();
        });
        row.appendChild(rm);
        card.appendChild(row);
      }

      const addRow = document.createElement("div");
      addRow.className = "admin-add-email-row";
      const input = document.createElement("input");
      input.type = "email";
      input.placeholder = "weitere Mail-Adresse";
      const addBtn = document.createElement("button");
      addBtn.textContent = "+";
      addBtn.addEventListener("click", async () => {
        const email = input.value.trim();
        if (!email) return;
        try {
          await api("/api/admin/people/" + encodeURIComponent(person.id) + "/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
          });
          input.value = "";
          loadAdminPeople();
        } catch (err) {
          window.alert("Diese Mail-Adresse ist schon vergeben.");
        }
      });
      addRow.appendChild(input);
      addRow.appendChild(addBtn);
      card.appendChild(addRow);

      adminPeopleListEl.appendChild(card);
    }
  }

  async function refreshPeople() {
    try {
      const r = await api("/api/people");
      PEOPLE = r.people || [];
    } catch (err) {
      // offline oder Fehler: alte Liste behalten
    }
  }

  document.getElementById("btn-admin-close")?.addEventListener("click", closeAdminPanel);
  adminBackdrop?.addEventListener("click", (e) => {
    if (e.target === adminBackdrop) closeAdminPanel();
  });
  document.getElementById("btn-admin-new-person")?.addEventListener("click", async () => {
    const input = document.getElementById("admin-new-person-name");
    const name = input.value.trim();
    if (!name) return;
    await api("/api/admin/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    input.value = "";
    await loadAdminPeople();
    await refreshPeople();
  });

  document.getElementById("btn-open-library")?.addEventListener("click", () => showLibrary());
  document.getElementById("btn-library-close")?.addEventListener("click", () => hideLibrary());
  document.getElementById("btn-library-switch")?.addEventListener("click", openAdminPanel);
  const libSearchRow = document.getElementById("lib-search-row");
  const libSearchInput = document.getElementById("lib-search-input");
  document.getElementById("btn-library-search")?.addEventListener("click", () => {
    libSearchRow.classList.toggle("hidden");
    if (!libSearchRow.classList.contains("hidden")) {
      libSearchInput.focus();
    } else {
      libSearchInput.value = "";
      librarySearchQuery = "";
      renderLibrary();
    }
  });
  libSearchInput?.addEventListener("input", () => {
    librarySearchQuery = libSearchInput.value;
    renderLibrary();
  });
  document.getElementById("btn-library-home")?.addEventListener("click", () => {
    if (currentFolderId && libraryCache && libraryCache.crumbs.length) {
      const crumbs = libraryCache.crumbs;
      const prev = crumbs[crumbs.length - 1];
      const parent = crumbs[crumbs.length - 2];
      navigateToFolder(prev.parentId || null, true, parent ? { name: parent.name, parentId: parent.parentId } : null);
    } else navigateToFolder(null);
  });
  const libAddMenu = document.getElementById("lib-add-menu");
  document.getElementById("btn-library-add")?.addEventListener("click", (e) => {
    e.stopPropagation();
    libAddMenu.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!libAddMenu.classList.contains("hidden") && !document.querySelector(".lib-add-wrap").contains(e.target)) {
      libAddMenu.classList.add("hidden");
    }
  });
  document.getElementById("lib-add-board")?.addEventListener("click", () => {
    libAddMenu.classList.add("hidden");
    createBoard();
  });
  document.getElementById("lib-add-notebook")?.addEventListener("click", () => {
    libAddMenu.classList.add("hidden");
    createNotebook();
  });
  document.getElementById("lib-add-folder")?.addEventListener("click", () => {
    libAddMenu.classList.add("hidden");
    createFolder();
  });
  // ---- Eigenes Dateiformat .sofianotes: Blatt komplett sichern und wieder importieren ----
  function exportBoardFile(boardId) {
    if (!boardId) return;
    const a = document.createElement("a");
    a.href = "/api/boards/" + encodeURIComponent(boardId) + "/export.sofianotes";
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  async function importBoardFile(file) {
    showToast("Importiere „" + file.name + "“…");
    try {
      const r = await fetch("/api/import.sofianotes" + (currentFolderId ? "?folder=" + encodeURIComponent(currentFolderId) : ""), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (!r.ok) throw new Error(r.status === 400 ? "format" : "fail");
      const res = await r.json();
      refreshLibrary();
      const hwNote = { linked: " · mit Hausaufgabe verknüpft", exists: " · Hausaufgabe hat schon ein Blatt", no_access: "" }[res.homework] || "";
      showToast("Importiert: " + res.board.title + hwNote);
      openBoard(res.board.id, res.board.title);
    } catch (err) {
      showToast(String(err.message) === "format" ? "Das ist keine gültige .sofianotes-Datei" : "Import hat nicht geklappt");
    }
  }
  function isBoardFile(file) {
    return /\.sofianotes$/i.test(file.name || "");
  }
  const boardFileInput = document.createElement("input");
  boardFileInput.type = "file";
  // ohne Filter: iOS graut unbekannte Endungen sonst aus
  boardFileInput.multiple = true;
  boardFileInput.style.display = "none";
  document.body.appendChild(boardFileInput);
  boardFileInput.addEventListener("change", async () => {
    const files = Array.from(boardFileInput.files || []);
    boardFileInput.value = "";
    for (const f of files) await importBoardFile(f);
  });
  document.getElementById("lib-add-import")?.addEventListener("click", () => {
    libAddMenu.classList.add("hidden");
    boardFileInput.click();
  });
  // Exportieren: Auswahl PDF oder .sofianotes
  const exportScrim = document.getElementById("export-scrim");
  let exportBoardId = null;
  let exportTitle = "";
  const sendState = { to: new Set(), format: "sofianotes" };
  function showExportPane(send) {
    document.getElementById("export-main").classList.toggle("hidden", send);
    document.getElementById("export-send").classList.toggle("hidden", !send);
    document.getElementById("export-send-go").classList.toggle("hidden", !send);
    document.getElementById("export-title").textContent = send ? "An Person senden" : "Exportieren";
    document.getElementById("export-name").textContent = send ? "„" + exportTitle + "“" : "„" + exportTitle + "“ speichern als:";
    document.getElementById("export-cancel").textContent = send ? "Zurück" : "Abbrechen";
    if (send) renderSendPane();
  }
  function renderSendPane() {
    const box = document.getElementById("export-people");
    box.innerHTML = "";
    const others = PEOPLE.filter((p) => p.id !== currentPersonId);
    if (!others.length) box.innerHTML = '<p class="set-hint">Keine anderen Personen vorhanden.</p>';
    for (const p of others) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "export-person" + (sendState.to.has(p.id) ? " active" : "");
      b.innerHTML = '<span class="material-symbols-rounded"></span><span></span>';
      b.children[0].textContent = sendState.to.has(p.id) ? "check_circle" : "person";
      b.children[1].textContent = p.name;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (sendState.to.has(p.id)) sendState.to.delete(p.id);
        else sendState.to.add(p.id);
        renderSendPane();
      });
      box.appendChild(b);
    }
    document.querySelectorAll("#export-send-format [data-format]").forEach((b) => b.classList.toggle("active", b.dataset.format === sendState.format));
    document.getElementById("export-send-hint").textContent =
      sendState.format === "pdf" ? "Die Person bekommt ein PDF in ihren Eingang – zum Ansehen, nicht bearbeitbar." : "Die Person bekommt eine eigene Kopie des Blatts in ihre Bibliothek – voll bearbeitbar, mit Material.";
    const go = document.getElementById("export-send-go");
    go.disabled = !sendState.to.size;
    go.textContent = sendState.to.size > 1 ? "An " + sendState.to.size + " senden" : "Senden";
  }
  document.querySelectorAll("#export-send-format [data-format]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      sendState.format = b.dataset.format;
      renderSendPane();
    })
  );
  document.getElementById("export-to-person").addEventListener("click", (e) => {
    e.stopPropagation();
    showExportPane(true);
  });
  document.getElementById("export-send-go").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!sendState.to.size || !exportBoardId) return;
    const go = e.currentTarget;
    go.disabled = true;
    go.textContent = "Sende…";
    try {
      await api("/api/boards/" + encodeURIComponent(exportBoardId) + "/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: [...sendState.to], format: sendState.format }),
      });
      const names = [...sendState.to].map(personName).join(", ");
      closeExport();
      showToast("Gesendet an " + names);
    } catch (err) {
      showToast("Senden hat nicht geklappt");
      renderSendPane();
    }
  });
  function openExportDialog(boardId, title) {
    if (!boardId) return;
    exportBoardId = boardId;
    exportTitle = title || "Blatt";
    sendState.to.clear();
    showExportPane(false);
    exportScrim.classList.remove("hidden");
  }
  const closeExport = () => exportScrim.classList.add("hidden");
  exportScrim.addEventListener("click", (e) => {
    if (e.target === exportScrim) closeExport();
  });
  document.getElementById("export-cancel").addEventListener("click", () => {
    if (!document.getElementById("export-send").classList.contains("hidden")) showExportPane(false);
    else closeExport();
  });

  // ---- Eingang: Blaetter und PDFs, die einem jemand geschickt hat ----
  const inboxScrim = document.getElementById("inbox-scrim");
  let inboxData = { items: [], unseen: 0 };
  function renderInboxBadge() {
    const c = document.getElementById("inbox-count");
    c.textContent = inboxData.unseen > 9 ? "9+" : String(inboxData.unseen);
    c.classList.toggle("hidden", !inboxData.unseen);
  }
  async function refreshInbox() {
    try {
      inboxData = await api("/api/inbox");
    } catch (err) {
      return;
    }
    renderInboxBadge();
    if (!inboxScrim.classList.contains("hidden")) renderInbox();
  }
  function renderInbox() {
    const list = document.getElementById("inbox-list");
    list.innerHTML = "";
    if (!inboxData.items.length) {
      list.innerHTML = '<div class="inbox-empty"><span class="material-symbols-rounded">inbox</span><p>Noch nichts bekommen. Wenn dir jemand ein Blatt oder PDF schickt, landet es hier.</p></div>';
      return;
    }
    for (const it of inboxData.items) {
      const row = document.createElement("div");
      row.className = "inbox-item" + (it.seen ? "" : " unseen");
      row.innerHTML = '<span class="set-ico"><span class="material-symbols-rounded"></span></span><span class="set-nav-text"><strong></strong><small></small></span><button type="button" class="hw-panel-btn" title="Aus dem Eingang entfernen"><span class="material-symbols-rounded">close</span></button>';
      row.querySelector(".set-ico .material-symbols-rounded").textContent = it.kind === "pdf" ? "picture_as_pdf" : "description";
      row.querySelector("strong").textContent = it.title;
      row.querySelector("small").textContent = "Von " + (personName(it.from) || "?") + " · " + (it.kind === "pdf" ? "PDF" : "Blatt (Kopie)") + " · " + relTime(it.at);
      row.addEventListener("click", () => {
        inboxScrim.classList.add("hidden");
        if (it.kind === "pdf") window.open("/api/files/" + encodeURIComponent(it.fileId), "_blank", "noopener");
        else openBoard(it.boardId, it.title);
      });
      row.querySelector("button").addEventListener("click", async (e) => {
        e.stopPropagation();
        inboxData.items = inboxData.items.filter((x) => x.id !== it.id);
        renderInbox();
        try {
          await api("/api/inbox/" + it.id, { method: "DELETE" });
        } catch (err) {
          refreshInbox();
        }
      });
      list.appendChild(row);
    }
  }
  document.getElementById("btn-library-inbox").addEventListener("click", async (e) => {
    e.stopPropagation();
    renderInbox();
    inboxScrim.classList.remove("hidden");
    if (inboxData.unseen) {
      inboxData.unseen = 0;
      renderInboxBadge();
      api("/api/inbox/seen", { method: "POST" }).catch(() => {});
    }
  });
  document.getElementById("inbox-close").addEventListener("click", () => inboxScrim.classList.add("hidden"));
  inboxScrim.addEventListener("click", (e) => {
    if (e.target === inboxScrim) inboxScrim.classList.add("hidden");
  });
  exportScrim.querySelectorAll(".export-opt").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeExport();
      if (b.dataset.format === "pdf") window.location.href = "/api/export.pdf?board=" + encodeURIComponent(exportBoardId);
      else exportBoardFile(exportBoardId);
    })
  );
  document.getElementById("canvas-menu-export")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeCanvasMenus();
    openExportDialog(currentBoardId, filenameInput ? filenameInput.value : "");
  });

  // ---- Canvas-Kopfzeile: Teilen + Herunterladen in einem Menü ----------
  const canvasMenu = document.getElementById("canvas-menu");
  const canvasShareSubmenu = document.getElementById("canvas-share-submenu");

  function closeCanvasMenus() {
    canvasMenu.classList.add("hidden");
    canvasShareSubmenu.classList.add("hidden");
  }

  function currentOpenBoard() {
    return currentBoardMeta && currentBoardMeta.id === currentBoardId
      ? currentBoardMeta
      : { id: currentBoardId, sharedWith: [], ownerId: currentPersonId };
  }

  function openCanvasShareSubmenu(board) {
    canvasShareSubmenu.innerHTML = "";
    for (const p of PEOPLE) {
      if (p.id === currentPersonId) continue;
      const on = (board.sharedWith || []).includes(p.id);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "lib-add-opt" + (on ? " shared" : "");
      row.title = on ? "Freigabe entfernen" : "Freigeben";
      row.innerHTML =
        `<span class="material-symbols-rounded" style="visibility:${on ? "visible" : "hidden"};">check</span>` +
        `<span>${p.name}</span>`;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        const nowOn = (board.sharedWith || []).includes(p.id);
        const set = (v) => {
          board.sharedWith = v ? [...new Set([...(board.sharedWith || []), p.id])] : (board.sharedWith || []).filter((x) => x !== p.id);
          row.classList.toggle("shared", v);
          row.firstElementChild.style.visibility = v ? "visible" : "hidden";
        };
        optimistic({
          apply: () => set(!nowOn),
          revert: () => set(nowOn),
          request: () =>
            nowOn
              ? api(
                  "/api/boards/" + encodeURIComponent(board.id) + "/share/" + encodeURIComponent(p.id) + "?person=" + encodeURIComponent(currentPersonId),
                  { method: "DELETE" }
                )
              : api("/api/boards/" + encodeURIComponent(board.id) + "/share", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ personId: currentPersonId, withPersonId: p.id }),
                }),
          offlineOp: nowOn
            ? { type: "unshare", personId: currentPersonId, boardId: board.id, withPersonId: p.id }
            : { type: "share", personId: currentPersonId, boardId: board.id, withPersonId: p.id },
          failText: "Teilen hat nicht geklappt",
        });
      });
      canvasShareSubmenu.appendChild(row);
    }
    // links neben dem Hauptmenue oeffnen (mehr Platz zur Bildschirmmitte),
    // rechts wenn links kein Platz mehr ist. #top-filename-bar hat einen
    // transform/backdrop-filter, der fuer position:fixed-Kindelemente eine
    // eigene Bezugsbox aufmacht - deshalb bleibt es bei position:absolute
    // (wie schon bei .lib-add-menu) und wird relativ zum gemeinsamen
    // offsetParent (canvas-menu-wrap) in Pixeln berechnet, nicht relativ
    // zum Viewport.
    canvasShareSubmenu.style.right = "auto";
    canvasShareSubmenu.classList.remove("hidden");
    const wrapRect = canvasMenu.offsetParent.getBoundingClientRect();
    const menuRect = canvasMenu.getBoundingClientRect();
    const subRect = canvasShareSubmenu.getBoundingClientRect();
    const menuLeft = menuRect.left - wrapRect.left;
    if (menuRect.left - subRect.width - 8 >= 0) {
      canvasShareSubmenu.style.left = menuLeft - subRect.width - 8 + "px";
    } else {
      const maxLeft = window.innerWidth - wrapRect.left - subRect.width - 8;
      canvasShareSubmenu.style.left = Math.min(menuRect.right - wrapRect.left + 8, maxLeft) + "px";
    }
    canvasShareSubmenu.style.top = menuRect.top - wrapRect.top + "px";
  }

  document.getElementById("btn-canvas-menu")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!currentBoardId) {
      showLibrary();
      return;
    }
    canvasShareSubmenu.classList.add("hidden");
    renderHiddenMenu();
    canvasMenu.classList.toggle("hidden");
  });
  document.getElementById("canvas-menu-download")?.addEventListener("click", () => {
    closeCanvasMenus();
    downloadCurrentBoard();
  });
  document.getElementById("canvas-menu-share")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const board = currentOpenBoard();
    if (board.ownerId && board.ownerId !== currentPersonId) {
      window.alert("Nur " + personName(board.ownerId) + " kann dieses Blatt teilen.");
      return;
    }
    openCanvasShareSubmenu(board);
  });
  document.addEventListener("click", (e) => {
    if (!document.getElementById("btn-canvas-menu").contains(e.target) && !canvasMenu.contains(e.target) && !canvasShareSubmenu.contains(e.target)) {
      closeCanvasMenus();
    }
  });
  document.getElementById("btn-share-close")?.addEventListener("click", () => shareBackdrop.classList.add("hidden"));
  document.getElementById("btn-move-close")?.addEventListener("click", () => moveBackdrop.classList.add("hidden"));
  shareBackdrop?.addEventListener("click", (e) => {
    if (e.target === shareBackdrop) shareBackdrop.classList.add("hidden");
  });
  moveBackdrop?.addEventListener("click", (e) => {
    if (e.target === moveBackdrop) moveBackdrop.classList.add("hidden");
  });

  window.addEventListener("online", () => {
    goOnlineIfPossible();
  });
  window.addEventListener("offline", () => {
    setConnState("offline");
  });

  // ---- Notizbuch: Seiten-Leiste, Seiten anlegen/loeschen, Hintergruende, PDF-Seiten ----
  (() => {
    const menu = document.getElementById("page-menu");
    const addBig = document.getElementById("page-add-big");
    const PAPER_LABELS = { graph: "Kariert", lines: "Liniert", dots: "Punkte", blank: "Blanko" };
    const newId = () => "p" + uuid().slice(0, 12);

    function currentPage() {
      const rects = pageRects(notebook);
      if (!rects.length) return 0;
      const c = screenToWorld(viewLeft + (window.innerWidth - viewLeft - viewRight) / 2, window.innerHeight / 2);
      let best = 0;
      let bestD = Infinity;
      rects.forEach((r, i) => {
        const dx = Math.max(r.x - c.x, 0, c.x - (r.x + r.w));
        const dy = Math.max(r.y - c.y, 0, c.y - (r.y + r.h));
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    }
    // Seite i in die Mitte holen, Breite eingepasst
    // Ansicht: durchgehend (Seitenbreite einpassen) oder Seite fuer Seite (ganze Seite/Doppelseite)
    // Standard: immer auf eine Seite einrasten (nur "durchgehend" schaltet es ab)
    const nbPaging = () => lsGetRaw("sofianotes-nb-paging") !== "scroll";
    const nbSpread = () => !!notebook && notebook.layout === "horizontal" && lsGetRaw("sofianotes-nb-spread") === "2";
    window.sofiaNbSpread = nbSpread;
    function groupOf(i) {
      const n = notebook.pages.length;
      i = Math.max(0, Math.min(n - 1, i));
      if (!nbSpread()) return [i, i];
      const a = i - (i % 2);
      return [a, Math.min(n - 1, a + 1)];
    }
    function viewFor(i) {
      const rects = pageRects(notebook);
      if (!rects.length) return null;
      const [a, b] = groupOf(i);
      const x0 = rects[a].x;
      const y0 = Math.min(rects[a].y, rects[b].y);
      const x1 = rects[b].x + rects[b].w;
      const y1 = Math.max(rects[a].y + rects[a].h, rects[b].y + rects[b].h);
      const availW = window.innerWidth - viewLeft - viewRight;
      const top = 76;
      const availH = window.innerHeight - top - 16;
      let sc;
      let ox;
      let oy;
      if (nbPaging() || nbSpread()) {
        sc = clampZoom(Math.min((availW - 32) / (x1 - x0), (availH - 8) / (y1 - y0)));
        ox = viewLeft + (availW - (x1 - x0) * sc) / 2 - x0 * sc;
        oy = top + (availH - (y1 - y0) * sc) / 2 - y0 * sc;
      } else {
        sc = clampZoom(Math.min(1.25, (availW - 48) / (x1 - x0)));
        ox = viewLeft + (availW - (x1 - x0) * sc) / 2 - x0 * sc;
        oy = 84 - y0 * sc;
      }
      return { scale: sc, offsetX: ox, offsetY: oy };
    }
    let viewAnim = null;
    function animateView(v, ms) {
      if (!v) return;
      const from = { scale, offsetX, offsetY };
      const t0 = performance.now();
      const me = {};
      viewAnim = me;
      const step = (now) => {
        if (viewAnim !== me) return;
        const t = Math.min(1, (now - t0) / (ms || 260));
        const e = 1 - Math.pow(1 - t, 3);
        scale = from.scale + (v.scale - from.scale) * e;
        offsetX = from.offsetX + (v.offsetX - from.offsetX) * e;
        offsetY = from.offsetY + (v.offsetY - from.offsetY) * e;
        requestRedraw();
        if (t < 1) requestAnimationFrame(step);
        else viewAnim = null;
      };
      requestAnimationFrame(step);
    }
    canvas.addEventListener("pointerdown", () => (viewAnim = null), true);
    function fitPage(i, animate) {
      const v = viewFor(i);
      if (!v) return;
      if (animate) return animateView(v);
      viewAnim = null;
      scale = v.scale;
      offsetX = v.offsetX;
      offsetY = v.offsetY;
      requestRedraw();
    }
    window.sofiaFitPage = fitPage;
    window.sofiaCurrentPage = () => currentPage();
    // Seite fuer Seite: nach dem Wischen zur naechsten/vorigen Seite einrasten.
    // Rueckgabe false = normal weiterscrollen (z. B. wenn hineingezoomt).
    window.sofiaPageSnap = (ps) => {
      if (!notebook || !nbPaging()) return false;
      const cur = currentPage();
      const fit = viewFor(cur);
      if (!fit || scale > fit.scale * 1.08) return false;
      const horiz = notebook.layout === "horizontal";
      const v = horiz ? ps.vx || 0 : ps.vy || 0;
      const fresh = performance.now() - (ps.t || 0) < 120;
      const step = nbSpread() ? 2 : 1;
      const [a] = groupOf(cur);
      let target = a;
      if (fresh && v < -0.25) target = a + step;
      else if (fresh && v > 0.25) target = a - step;
      target = Math.max(0, Math.min(notebook.pages.length - 1, target));
      if (target !== a && window.sofiaZoomToPage) window.sofiaZoomToPage(target);
      animateView(viewFor(target));
      return true;
    };

    // Striche wandern mit ihrer Seite mit (bzw. verschwinden mit einer geloeschten Seite)
    function moveStrokesWithPages(oldRects, newRects) {
      const byId = new Map(newRects.map((r) => [r.id, r]));
      const erase = [];
      for (const st of boardStrokes.values()) {
        const b = st.bbox || strokeWorldBBox(st);
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        const old = oldRects.find((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
        if (!old) continue;
        const nw = byId.get(old.id);
        if (!nw) {
          erase.push(st.id);
          continue;
        }
        const dx = nw.x - old.x;
        const dy = nw.y - old.y;
        if (!dx && !dy) continue;
        for (const p of st.points) {
          p.x += dx;
          p.y += dy;
        }
        st.bbox = strokeWorldBBox(st);
        tagShape(st);
        wsSend({ type: "stroke_move", stroke: serializeStroke(st) });
      }
      if (erase.length) {
        for (const id of erase) boardStrokes.delete(id);
        wsSend({ type: "erase", strokeIds: erase });
      }
    }
    async function saveNotebook(next, opts) {
      const bid = currentBoardId;
      const before = notebook;
      if (opts && opts.moveStrokes) moveStrokesWithPages(pageRects(before), pageRects(next));
      notebook = next;
      if (currentBoardMeta) currentBoardMeta.notebook = next;
      requestRedraw();
      if (window.sofiaPagesChanged) window.sofiaPagesChanged();
      renderNbSettings();
      try {
        await api("/api/boards/" + encodeURIComponent(bid), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notebook: next }),
        });
      } catch (err) {
        showToast("Seiten speichern hat nicht geklappt");
      }
    }
    const clone = () => JSON.parse(JSON.stringify(notebook));
    function templatePage() {
      const t = (notebook && notebook.template) || { paper: "graph" };
      const pg = { id: newId(), paper: t.paper || "graph", w: A4_W, h: A4_H };
      if (t.mediaId) {
        pg.mediaId = t.mediaId;
        if (t.w && t.h) {
          pg.w = t.w;
          pg.h = t.h;
        }
      }
      return pg;
    }
    function addPages(afterIndex, pages) {
      const nb = clone();
      nb.pages.splice(afterIndex + 1, 0, ...pages);
      saveNotebook(nb, { moveStrokes: true });
      fitPage(afterIndex + 1);
    }
    async function deletePage(i) {
      if (notebook.pages.length <= 1) return showToast("Die letzte Seite kann nicht gelöscht werden");
      const ok = await askConfirm({ title: "Seite " + (i + 1) + " löschen?", text: "Alles, was auf dieser Seite steht, wird mitgelöscht.", ok: "Löschen" });
      if (!ok) return;
      const nb = clone();
      nb.pages.splice(i, 1);
      saveNotebook(nb, { moveStrokes: true });
      fitPage(Math.min(i, nb.pages.length - 1));
    }
    function setPageBg(i, bg) {
      const nb = clone();
      const pg = nb.pages[i];
      pg.paper = bg.paper || pg.paper || "graph";
      if (bg.mediaId) pg.mediaId = bg.mediaId;
      else delete pg.mediaId;
      saveNotebook(nb);
    }
    function setLayout(layout) {
      if (notebook.layout === layout) return;
      const i = currentPage();
      const nb = clone();
      nb.layout = layout;
      saveNotebook(nb, { moveStrokes: true });
      fitPage(i);
    }
    function setTemplate(t) {
      const nb = clone();
      nb.template = t;
      saveNotebook(nb);
    }
    window.sofiaSetPagePaper = (paper) => {
      if (!notebook) return false;
      setPageBg(currentPage(), { paper });
      return true;
    };

    // PDF oder Bild in Seitenbilder umwandeln
    async function fileToPageImages(file, maxPages) {
      const out = [];
      const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name || "");
      if (isPdf) {
        if (window.ensurePdf) await window.ensurePdf().catch(() => null);
        if (!window.pdfjsLib) throw new Error("pdfjs");
        const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        const n = Math.min(pdf.numPages, maxPages || 200);
        for (let i = 1; i <= n; i++) {
          showToast("PDF-Seite " + i + " von " + n + " …");
          const page = await pdf.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: Math.min(2.5, 2000 / Math.max(base.width, base.height)) });
          const c = document.createElement("canvas");
          c.width = Math.round(vp.width);
          c.height = Math.round(vp.height);
          await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
          const jpeg = bitmapToJpeg(c, 2000);
          c.width = c.height = 0;
          out.push({ mediaId: await uploadJpeg(jpeg.dataUrl), ratio: base.height / base.width });
        }
      } else {
        const bmp = await createImageBitmap(file);
        const jpeg = bitmapToJpeg(bmp, 2000);
        const ratio = bmp.height / bmp.width;
        if (bmp.close) bmp.close();
        out.push({ mediaId: await uploadJpeg(jpeg.dataUrl), ratio });
      }
      return out;
    }
    // PDF ins Notizbuch: jede PDF-Seite wird eine eigene Seite (in voller Seitengroesse)
    window.sofiaInsertPdfPages = async (file) => {
      if (!notebook) return false;
      try {
        const imgs = await fileToPageImages(file, 200);
        const pages = imgs.map((im) => ({ id: newId(), paper: "blank", mediaId: im.mediaId, w: A4_W, h: Math.round(A4_W * im.ratio) }));
        addPages(currentPage(), pages);
        showToast(pages.length + (pages.length === 1 ? " Seite" : " Seiten") + " eingefügt");
      } catch (err) {
        showToast("PDF einfügen hat nicht geklappt");
      }
      return true;
    };
    const bgInput = document.createElement("input");
    bgInput.type = "file";
    bgInput.accept = "image/*,application/pdf,.pdf";
    bgInput.style.display = "none";
    document.body.appendChild(bgInput);
    let bgTarget = null; // {kind: "page", index} | {kind: "template"}
    bgInput.addEventListener("change", async () => {
      const file = bgInput.files && bgInput.files[0];
      bgInput.value = "";
      if (!file || !bgTarget) return;
      try {
        showToast("Hintergrund wird geladen…");
        const [im] = await fileToPageImages(file, 1);
        if (!im) return;
        if (bgTarget.kind === "template") {
          setTemplate({ paper: "blank", mediaId: im.mediaId, w: A4_W, h: Math.round(A4_W * im.ratio) });
          showToast("Neue Seiten bekommen diesen Hintergrund");
        } else setPageBg(bgTarget.index, { paper: "blank", mediaId: im.mediaId });
      } catch (err) {
        showToast("Hintergrund laden hat nicht geklappt");
      }
    });

    // ---- Menue (an einem Anker) ----
    function closeMenu() {
      menu.classList.add("hidden");
    }
    function openMenu(items, anchor) {
      menu.innerHTML = "";
      for (const it of items) {
        if (it.head) {
          const h = document.createElement("div");
          h.className = "page-menu-head";
          h.textContent = it.head;
          menu.appendChild(h);
          continue;
        }
        const b = document.createElement("button");
        b.type = "button";
        b.className = "lib-add-opt" + (it.active ? " shared" : "") + (it.danger ? " danger" : "");
        b.innerHTML = '<span class="material-symbols-rounded"></span><span></span>';
        b.children[0].textContent = it.icon;
        b.children[1].textContent = it.label;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          closeMenu();
          it.run();
        });
        menu.appendChild(b);
      }
      menu.classList.remove("hidden");
      const r = anchor.getBoundingClientRect();
      const mh = menu.offsetHeight;
      const mw = menu.offsetWidth;
      let top = r.bottom + 6;
      if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
      menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.left)) + "px";
      menu.style.top = top + "px";
    }
    // Menue einer Seite (▾ unter dem Vorschaubild)
    function pageMenu(i, anchor) {
      const pg = notebook.pages[i];
      const items = [{ head: "Seite " + (i + 1) + " – Hintergrund" }];
      for (const k of Object.keys(PAPER_LABELS)) items.push({ icon: k === "graph" ? "grid_4x4" : k === "lines" ? "reorder" : k === "dots" ? "grain" : "crop_square", label: PAPER_LABELS[k], active: !pg.mediaId && pg.paper === k, run: () => setPageBg(i, { paper: k }) });
      for (const u of userTemplates()) items.push({ icon: "description", label: u.name, active: pg.mediaId === u.mediaId, run: () => setPageBg(i, { paper: "blank", mediaId: u.mediaId }) });
      items.push({ icon: "upload_file", label: "Andere Datei (Bild/PDF) …", active: !!pg.mediaId && !userTemplates().some((u) => u.mediaId === pg.mediaId), run: () => ((bgTarget = { kind: "page", index: i }), bgInput.click()) });
      items.push({ head: "Seite" });
      items.push({ icon: "note_add", label: "Neue Seite danach", run: () => addPages(i, [templatePage()]) });
      items.push({ icon: "content_copy", label: "Neue Seite davor", run: () => addPages(i - 1, [templatePage()]) });
      items.push({ icon: "delete", label: "Seite löschen", danger: true, run: () => deletePage(i) });
      openMenu(items, anchor);
    }
    // Menue des ganzen Notizbuchs (⋯ oben in der Seiten-Leiste)
    function notebookMenu(anchor) {
      const t = notebook.template || {};
      const items = [{ head: "Anordnung" }];
      items.push({ icon: "view_agenda", label: "Seiten untereinander", active: notebook.layout !== "horizontal", run: () => setLayout("vertical") });
      items.push({ icon: "view_column", label: "Seiten nebeneinander", active: notebook.layout === "horizontal", run: () => setLayout("horizontal") });
      items.push({ head: "Neue Seiten bekommen" });
      for (const k of Object.keys(PAPER_LABELS)) items.push({ icon: "note_add", label: PAPER_LABELS[k], active: !t.mediaId && (t.paper || "graph") === k, run: () => setTemplate({ paper: k }) });
      for (const u of userTemplates()) items.push({ icon: "description", label: u.name, active: t.mediaId === u.mediaId, run: () => setTemplate({ paper: "blank", mediaId: u.mediaId, w: u.w, h: u.h }) });
      items.push({ icon: "upload_file", label: "Andere Datei als Vorlage …", active: !!t.mediaId && !userTemplates().some((u) => u.mediaId === t.mediaId), run: () => ((bgTarget = { kind: "template" }), bgInput.click()) });
      items.push({ icon: "tune", label: "Notizbuch-Einstellungen …", run: () => { openSettings(); showSettingsPage("notebook"); renderNbSettings(); } });
      openMenu(items, anchor);
    }
    document.addEventListener("pointerdown", (e) => {
      if (!menu.classList.contains("hidden") && !e.target.closest("#page-menu") && !e.target.closest(".page-thumb-menu") && !e.target.closest("#pages-more")) closeMenu();
      if (!addPop.classList.contains("hidden") && !e.target.closest("#page-add-pop") && !e.target.closest(".page-thumb-add")) addPop.classList.add("hidden");
    }, true);
    menu.addEventListener("pointerdown", (e) => e.stopPropagation());
    addBig.addEventListener("pointerdown", (e) => e.stopPropagation());
    addBig.addEventListener("click", (e) => {
      e.stopPropagation();
      addPages(notebook.pages.length - 1, [templatePage()]);
    });

    // ---- Seiten-Leiste links (wie in GoodNotes) ----
    const panel = document.getElementById("pages-panel");
    const grid = document.getElementById("pages-grid");
    const pagesBtn = document.getElementById("btn-pages");
    const addPop = document.getElementById("page-add-pop");
    const PANEL_W = 300;
    let panelOpen = false;
    let thumbTimer = null;
    function setPanel(open) {
      panelOpen = open && !!notebook;
      panel.classList.toggle("hidden", !panelOpen);
      pagesBtn.classList.toggle("active", panelOpen);
      pagesInsetLeft = panelOpen ? Math.min(PANEL_W, Math.round(window.innerWidth * 0.4)) : 0;
      panel.style.width = pagesInsetLeft + "px";
      setViewInsets(requestedInsets[0], requestedInsets[1]);
      try {
        localStorage.setItem("sofianotes-pages-panel", panelOpen ? "1" : "0");
      } catch (err) {}
      if (panelOpen) renderPanel();
      else addPop.classList.add("hidden");
    }
    pagesBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const i = currentPage();
      setPanel(!panelOpen);
      fitPage(i);
    });
    document.getElementById("pages-close").addEventListener("click", (e) => {
      e.stopPropagation();
      setPanel(false);
    });
    document.getElementById("pages-more").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!menu.classList.contains("hidden")) return closeMenu();
      notebookMenu(e.currentTarget);
    });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    addPop.addEventListener("pointerdown", (e) => e.stopPropagation());

    // Vorschaubild einer Seite: Hintergrund + alles, was auf der Seite liegt
    function renderThumb(cv, r) {
      const W = cv.clientWidth || 120;
      const k = W / r.w;
      const d = Math.max(1, window.devicePixelRatio || 1);
      cv.width = Math.round(W * d);
      cv.height = Math.round(r.h * k * d);
      cv.style.height = r.h * k + "px";
      const c = cv.getContext("2d");
      c.setTransform(d, 0, 0, d, 0, 0);
      c.fillStyle = "#fff";
      c.fillRect(0, 0, W, r.h * k);
      c.setTransform(k * d, 0, 0, k * d, -r.x * k * d, -r.y * k * d);
      const img = r.page.mediaId ? ensureMedia(r.page.mediaId) : null;
      if (img && img.complete && img.naturalWidth) c.drawImage(img, r.x, r.y, r.w, r.h);
      else if (!r.page.mediaId) drawPagePattern(r.page.paper || "graph", r, c, k);
      c.save();
      c.beginPath();
      c.rect(r.x, r.y, r.w, r.h);
      c.clip();
      for (const st of boardStrokes.values()) {
        const b = st.bbox;
        if (!b || b.maxX < r.x || b.minX > r.x + r.w || b.maxY < r.y || b.minY > r.y + r.h) continue;
        try {
          drawStroke(st, c, st.tool === "marker" ? { alpha: 0.38 } : undefined);
        } catch (err) {}
      }
      c.restore();
    }
    let renderedSig = "";
    function renderPanel() {
      if (!panelOpen || !notebook) return;
      renderedSig = JSON.stringify(notebook.pages) + notebook.layout;
      const rects = pageRects(notebook);
      const cur = currentPage();
      grid.innerHTML = "";
      rects.forEach((r, i) => {
        const cell = document.createElement("div");
        cell.className = "page-thumb" + (i === cur ? " active" : "");
        cell.dataset.index = i;
        const cv = document.createElement("canvas");
        cv.className = "page-thumb-img";
        cell.appendChild(cv);
        const foot = document.createElement("div");
        foot.className = "page-thumb-foot";
        foot.innerHTML = '<span></span><button type="button" class="page-thumb-menu hw-panel-btn" title="Seite"><span class="material-symbols-rounded">expand_more</span></button>';
        foot.firstChild.textContent = i + 1;
        cell.appendChild(foot);
        cv.addEventListener("click", (e) => {
          e.stopPropagation();
          if (zoomWin && window.sofiaZoomToPage) window.sofiaZoomToPage(i);
          fitPage(i);
        });
        foot.querySelector("button").addEventListener("click", (e) => {
          e.stopPropagation();
          if (!menu.classList.contains("hidden")) return closeMenu();
          pageMenu(i, e.currentTarget);
        });
        grid.appendChild(cell);
        requestAnimationFrame(() => renderThumb(cv, r));
      });
      const add = document.createElement("button");
      add.type = "button";
      add.className = "page-thumb-add";
      add.title = "Seite hinzufügen";
      add.innerHTML = '<span class="material-symbols-rounded">add</span>';
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        openAddPop(add);
      });
      const addCell = document.createElement("div");
      addCell.className = "page-thumb";
      addCell.appendChild(add);
      grid.appendChild(addCell);
    }
    // nach Aenderungen die Vorschaubilder kurz verzoegert neu zeichnen
    // Nur bei geaenderten Seiten alles neu, sonst nur das Bild der aktuellen Seite (schnell)
    window.sofiaPagesChanged = () => {
      if (!panelOpen) return;
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(() => {
        if (!panelOpen || !notebook) return;
        if (JSON.stringify(notebook.pages) + notebook.layout !== renderedSig) return renderPanel();
        const i = currentPage();
        const cv = grid.querySelector('.page-thumb[data-index="' + i + '"] canvas');
        const r = pageRects(notebook)[i];
        if (cv && r) renderThumb(cv, r);
      }, 900);
    };

    // ---- Eigene Vorlagen (am Konto, ueber die Einstellungen synchron) ----
    function userTemplates() {
      try {
        const v = JSON.parse(lsGetRaw("sofianotes-templates") || "[]");
        return Array.isArray(v) ? v : [];
      } catch (err) {
        return [];
      }
    }
    function saveUserTemplates(list) {
      try {
        localStorage.setItem("sofianotes-templates", JSON.stringify(list));
      } catch (err) {}
      renderNbSettings();
    }
    const tplInput = document.createElement("input");
    tplInput.type = "file";
    tplInput.accept = "image/*,application/pdf,.pdf";
    tplInput.style.display = "none";
    document.body.appendChild(tplInput);
    let tplThenAdd = false;
    tplInput.addEventListener("change", async () => {
      const file = tplInput.files && tplInput.files[0];
      tplInput.value = "";
      if (!file) return;
      try {
        showToast("Vorlage wird gespeichert…");
        const imgs = await fileToPageImages(file, 10);
        const base = (file.name || "Vorlage").replace(/\.[a-z0-9]+$/i, "");
        const added = imgs.map((im, k) => ({ id: newId(), name: base + (imgs.length > 1 ? " S. " + (k + 1) : ""), mediaId: im.mediaId, w: A4_W, h: Math.round(A4_W * im.ratio) }));
        saveUserTemplates(userTemplates().concat(added));
        showToast(added.length > 1 ? added.length + " Vorlagen gespeichert" : "Vorlage gespeichert");
        if (tplThenAdd && notebook && added[0]) {
          const t = added[0];
          addPages(currentPage(), [{ id: newId(), paper: "blank", mediaId: t.mediaId, w: t.w, h: t.h }]);
        }
      } catch (err) {
        showToast("Vorlage speichern hat nicht geklappt");
      }
      tplThenAdd = false;
    });

    // ---- Einstellungen: Notizbuch ----
    function renderNbSettings() {
      const cur = document.getElementById("set-nb-current");
      if (!cur) return;
      cur.classList.toggle("hidden", !notebook);
      document.getElementById("set-nb-none").classList.toggle("hidden", !!notebook);
      document.querySelectorAll("#set-nb-layout [data-layout]").forEach((b) => b.classList.toggle("active", !!notebook && (notebook.layout || "vertical") === b.dataset.layout));
      const paging = nbPaging() ? "page" : "scroll";
      document.querySelectorAll("#set-nb-paging [data-paging]").forEach((b) => b.classList.toggle("active", b.dataset.paging === paging));
      const spread = lsGetRaw("sofianotes-nb-spread") === "2" ? "2" : "1";
      document.querySelectorAll("#set-nb-spread [data-spread]").forEach((b) => b.classList.toggle("active", b.dataset.spread === spread));
      const box = document.getElementById("set-nb-templates");
      box.innerHTML = "";
      for (const t of userTemplates()) {
        const row = document.createElement("div");
        row.className = "set-nb-tpl";
        const img = document.createElement("img");
        img.src = "/api/media/" + encodeURIComponent(t.mediaId);
        img.alt = "";
        row.appendChild(img);
        const name = document.createElement("span");
        name.textContent = t.name;
        row.appendChild(name);
        const del = document.createElement("button");
        del.type = "button";
        del.className = "hw-panel-btn";
        del.title = "Vorlage entfernen";
        del.innerHTML = '<span class="material-symbols-rounded">close</span>';
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          saveUserTemplates(userTemplates().filter((x) => x.id !== t.id));
        });
        row.appendChild(del);
        box.appendChild(row);
      }
      const sum = document.getElementById("set-sum-notebook");
      if (sum) sum.textContent = (paging === "page" ? "Seite für Seite" : "Durchgehend") + (spread === "2" ? " · Doppelseite" : "") + " · " + userTemplates().length + " eigene Vorlagen";
    }
    document.querySelector('.set-nav[data-go="notebook"]')?.addEventListener("click", () => setTimeout(renderNbSettings, 0));
    document.querySelectorAll("#set-nb-layout [data-layout]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (notebook) setLayout(b.dataset.layout);
        setTimeout(renderNbSettings, 0);
      })
    );
    const setPref = (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch (err) {}
    };
    document.querySelectorAll("#set-nb-paging [data-paging]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        setPref("sofianotes-nb-paging", b.dataset.paging);
        renderNbSettings();
        if (notebook) fitPage(currentPage(), true);
      })
    );
    document.querySelectorAll("#set-nb-spread [data-spread]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        setPref("sofianotes-nb-spread", b.dataset.spread);
        renderNbSettings();
        if (notebook) fitPage(currentPage(), true);
      })
    );
    document.getElementById("set-nb-tpl-add")?.addEventListener("click", (e) => {
      e.stopPropagation();
      tplThenAdd = false;
      tplInput.click();
    });
    renderNbSettings();

    // ---- "Seite hinzufuegen" ----
    const photoInput = document.createElement("input");
    photoInput.type = "file";
    photoInput.accept = "image/*";
    photoInput.setAttribute("capture", "environment");
    photoInput.style.display = "none";
    document.body.appendChild(photoInput);
    const imageInput = document.createElement("input");
    imageInput.type = "file";
    imageInput.accept = "image/*";
    imageInput.style.display = "none";
    document.body.appendChild(imageInput);
    const pdfInput = document.createElement("input");
    pdfInput.type = "file";
    pdfInput.accept = "application/pdf,.pdf";
    pdfInput.style.display = "none";
    document.body.appendChild(pdfInput);
    async function addFromFile(input) {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      try {
        showToast("Wird hinzugefügt…");
        const imgs = await fileToPageImages(file, 200);
        const pages = imgs.map((im) => ({ id: newId(), paper: "blank", mediaId: im.mediaId, w: A4_W, h: Math.round(A4_W * im.ratio) }));
        addPages(currentPage(), pages);
      } catch (err) {
        showToast("Hinzufügen hat nicht geklappt");
      }
    }
    photoInput.addEventListener("change", () => addFromFile(photoInput));
    imageInput.addEventListener("change", () => addFromFile(imageInput));
    pdfInput.addEventListener("change", () => addFromFile(pdfInput));
    function templateCard(label, sub, bg, onPick) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pap-card";
      const cv = document.createElement("canvas");
      cv.className = "pap-prev";
      b.appendChild(cv);
      const l = document.createElement("span");
      l.className = "pap-label";
      l.textContent = label;
      b.appendChild(l);
      if (sub) {
        const sm = document.createElement("small");
        sm.textContent = sub;
        b.appendChild(sm);
      }
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        addPop.classList.add("hidden");
        onPick();
      });
      requestAnimationFrame(() => {
        const W = 84;
        const H = Math.round((W * (bg.h || A4_H)) / (bg.w || A4_W));
        const d = Math.max(1, window.devicePixelRatio || 1);
        cv.width = W * d;
        cv.height = H * d;
        cv.style.width = W + "px";
        cv.style.height = H + "px";
        const c = cv.getContext("2d");
        const k = W / (bg.w || A4_W);
        c.setTransform(d, 0, 0, d, 0, 0);
        c.fillStyle = "#fff";
        c.fillRect(0, 0, W, H);
        c.setTransform(k * d, 0, 0, k * d, 0, 0);
        const r = { x: 0, y: 0, w: bg.w || A4_W, h: bg.h || A4_H };
        const img = bg.mediaId ? ensureMedia(bg.mediaId) : null;
        if (img && img.complete && img.naturalWidth) c.drawImage(img, 0, 0, r.w, r.h);
        else if (!bg.mediaId) drawPagePattern(bg.paper || "graph", r, c, k * 2.5);
      });
      return b;
    }
    function openAddPop(anchor) {
      const box = document.getElementById("pap-templates");
      box.innerHTML = "";
      const at = currentPage();
      const tpl = templatePage();
      box.appendChild(templateCard("Aktuelle Vorlage", "A4", tpl, () => addPages(at, [templatePage()])));
      for (const k of Object.keys(PAPER_LABELS)) {
        box.appendChild(templateCard(PAPER_LABELS[k], "", { paper: k }, () => addPages(at, [{ id: newId(), paper: k, w: A4_W, h: A4_H }])));
      }
      for (const t of userTemplates()) {
        box.appendChild(templateCard(t.name, "Eigene", t, () => addPages(at, [{ id: newId(), paper: "blank", mediaId: t.mediaId, w: t.w, h: t.h }])));
      }
      const own = document.createElement("button");
      own.type = "button";
      own.className = "pap-card pap-own";
      own.innerHTML = '<span class="pap-own-box"><span class="material-symbols-rounded">add</span></span><span class="pap-label">Eigene hinzufügen</span><small>PDF / Bild</small>';
      own.addEventListener("click", (e) => {
        e.stopPropagation();
        addPop.classList.add("hidden");
        tplThenAdd = true;
        tplInput.click();
      });
      box.appendChild(own);
      addPop.classList.remove("hidden");
      const r = anchor.getBoundingClientRect();
      const pw = addPop.offsetWidth;
      const ph = addPop.offsetHeight;
      addPop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.right + 14)) + "px";
      addPop.style.top = Math.max(8, Math.min(window.innerHeight - ph - 8, r.top + r.height / 2 - ph / 2)) + "px";
    }
    addPop.querySelectorAll(".pap-list [data-act]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        addPop.classList.add("hidden");
        if (b.dataset.act === "photo") photoInput.click();
        else if (b.dataset.act === "image") imageInput.click();
        else pdfInput.click();
      })
    );

    // bei jedem Zeichnen: Knopf oben, aktive Seite in der Leiste, "Neue Seite"-Knopf hinter der letzten Seite
    let lastCur = -1;
    let lastNb = null;
    window.sofiaPagesUi = () => {
      const show = !!notebook && !!currentBoardId && libraryBackdrop.classList.contains("hidden");
      pagesBtn.classList.toggle("hidden", !show);
      if (!show) {
        addBig.classList.add("hidden");
        closeMenu();
        if (panelOpen) setPanel(false);
        return;
      }
      if (!panelOpen && lastNb !== notebookBoardId) {
        lastNb = notebookBoardId;
        let want = false;
        try {
          want = localStorage.getItem("sofianotes-pages-panel") === "1";
        } catch (err) {}
        if (want) setTimeout(() => setPanel(true), 0);
      }
      if (panelOpen) {
        const cur = currentPage();
        if (cur !== lastCur) {
          lastCur = cur;
          grid.querySelectorAll(".page-thumb[data-index]").forEach((el) => el.classList.toggle("active", Number(el.dataset.index) === cur));
          const act = grid.querySelector(".page-thumb.active");
          if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest" });
        }
        if (grid.querySelectorAll(".page-thumb[data-index]").length !== notebook.pages.length) renderPanel();
      }
      const rects = pageRects(notebook);
      const last = rects[rects.length - 1];
      if (!last || historyView) {
        addBig.classList.add("hidden");
        return;
      }
      const horiz = notebook.layout === "horizontal";
      const p = horiz ? worldToScreen(last.x + last.w + PAGE_GAP / 2, last.y + last.h / 2) : worldToScreen(last.x + last.w / 2, last.y + last.h + PAGE_GAP / 2);
      const onScreen = p.x > viewLeft - 100 && p.x < window.innerWidth - viewRight + 100 && p.y > -60 && p.y < window.innerHeight + 60;
      addBig.classList.toggle("hidden", !onScreen);
      addBig.classList.toggle("vertical", horiz);
      if (onScreen) {
        addBig.style.left = p.x + "px";
        addBig.style.top = p.y + "px";
      }
    };
  })();

  // ---- Versionsverlauf (wie bei Google Docs) ----
  (() => {
    const panel = document.getElementById("history-panel");
    if (!panel) return;
    const listEl = document.getElementById("history-list");
    const legendEl = document.getElementById("history-legend");
    const foot = document.getElementById("history-foot");
    const footText = document.getElementById("history-foot-text");
    const marksBtn = document.getElementById("history-marks");
    const COLORS = ["#1a73e8", "#e8710a", "#188038", "#a142f4", "#d93025", "#12b5cb", "#e52592", "#f9ab00"];
    let groups = [];
    let selected = null; // Gruppe in der Vorschau
    let marksOn = false;
    let authorsTimer = null;
    function personColor(pid) {
      const ids = PEOPLE.map((p) => p.id).sort();
      const i = ids.indexOf(pid);
      if (i >= 0) return COLORS[i % COLORS.length];
      let h = 0;
      for (const ch of String(pid || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return COLORS[h % COLORS.length];
    }
    function whenLabel(g) {
      const a = new Date(g.start * 1000);
      const b = new Date(g.end * 1000);
      const today = new Date();
      const y = new Date(today);
      y.setDate(today.getDate() - 1);
      const sameDay = (x, z) => x.toDateString() === z.toDateString();
      const day = sameDay(a, today) ? "Heute" : sameDay(a, y) ? "Gestern" : a.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short", year: a.getFullYear() === today.getFullYear() ? undefined : "numeric" });
      const t = (d) => d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      return day + ", " + t(a) + (t(a) !== t(b) ? "–" + t(b) : "");
    }
    function summary(g) {
      const parts = [];
      if (g.added) parts.push("+" + g.added + " neu");
      if (g.changed) parts.push(g.changed + " geändert");
      if (g.removed) parts.push("−" + g.removed + " gelöscht");
      return parts.join(" · ") || "Änderungen";
    }
    function renderLegend(pids) {
      legendEl.innerHTML = "";
      for (const pid of pids) {
        const chip = document.createElement("span");
        chip.className = "history-chip";
        chip.innerHTML = '<i></i><span></span>';
        chip.firstChild.style.background = personColor(pid);
        chip.lastChild.textContent = personName(pid) || "Unbekannt";
        legendEl.appendChild(chip);
      }
    }
    function renderList() {
      listEl.innerHTML = "";
      const cur = document.createElement("button");
      cur.type = "button";
      cur.className = "history-item" + (selected ? "" : " active");
      cur.innerHTML = '<span class="history-dot now"></span><span class="history-item-text"><strong>Aktuelle Version</strong><small>So sieht das Blatt jetzt aus</small></span>';
      cur.addEventListener("click", (e) => {
        e.stopPropagation();
        leavePreview();
      });
      listEl.appendChild(cur);
      if (!groups.length) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        empty.textContent = "Noch keine Änderungen aufgezeichnet. Ab jetzt wird jede Änderung mit Person und Zeit gespeichert.";
        listEl.appendChild(empty);
      }
      let lastDay = "";
      for (const g of groups) {
        const day = new Date(g.start * 1000).toDateString();
        if (day !== lastDay) {
          lastDay = day;
          const h = document.createElement("div");
          h.className = "history-day";
          h.textContent = new Date(g.start * 1000).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
          listEl.appendChild(h);
        }
        const b = document.createElement("button");
        b.type = "button";
        b.className = "history-item" + (selected && selected.toId === g.toId ? " active" : "");
        b.innerHTML = '<span class="history-dot"></span><span class="history-item-text"><strong></strong><small></small><em></em></span>';
        b.querySelector(".history-dot").style.background = personColor(g.person);
        b.querySelector("strong").textContent = whenLabel(g);
        b.querySelector("small").textContent = personName(g.person) || "Unbekannt";
        b.querySelector("em").textContent = summary(g);
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          showVersion(g);
        });
        listEl.appendChild(b);
      }
    }
    async function load() {
      const bid = currentBoardId;
      if (!bid) return;
      try {
        const res = await api("/api/boards/" + encodeURIComponent(bid) + "/history");
        if (bid !== currentBoardId) return;
        groups = res.groups || [];
      } catch (err) {
        groups = [];
        showToast("Verlauf konnte nicht geladen werden");
      }
      renderList();
      renderLegend([...new Set(groups.map((g) => g.person))]);
    }
    function prep(list) {
      const m = new Map();
      for (const s of list) {
        tagShape(s);
        s.bbox = strokeWorldBBox(s);
        if (s.tool === "image" && s.extra && s.extra.mediaId) ensureMedia(s.extra.mediaId);
        m.set(s.id, s);
      }
      return m;
    }
    async function showVersion(g) {
      const bid = currentBoardId;
      try {
        const res = await api("/api/boards/" + encodeURIComponent(bid) + "/history/view?start=" + g.fromId + "&upto=" + g.toId);
        if (bid !== currentBoardId) return;
        const strokes = prep(res.strokes || []);
        const color = personColor(g.person);
        const marks = new Map();
        for (const id of (res.added || []).concat(res.changed || [])) marks.set(id, color);
        const ghosts = [...prep(res.removed || []).values()];
        if (textEdit) commitTextEditor();
        clearSelection();
        selected = g;
        historyView = { strokes, marks, ghosts };
        document.body.classList.add("history-preview");
        foot.classList.remove("hidden");
        footText.textContent = "Ansicht: " + whenLabel(g) + " · " + (personName(g.person) || "");
        renderList();
        requestRedraw();
      } catch (err) {
        showToast("Version konnte nicht geladen werden");
      }
    }
    function leavePreview() {
      selected = null;
      historyView = null;
      document.body.classList.remove("history-preview");
      foot.classList.add("hidden");
      renderList();
      requestRedraw();
    }
    async function loadAuthors() {
      clearTimeout(authorsTimer);
      if (!marksOn || !currentBoardId) return;
      const bid = currentBoardId;
      try {
        const res = await api("/api/boards/" + encodeURIComponent(bid) + "/authors");
        if (bid !== currentBoardId || !marksOn) return;
        const m = new Map();
        const pids = new Set();
        for (const [id, a] of Object.entries(res.authors || {})) {
          m.set(id, personColor(a.person));
          pids.add(a.person);
        }
        authorMarks = m;
        renderLegend([...pids]);
        requestRedraw();
      } catch (err) {}
    }
    // nach eigenen oder fremden Aenderungen die Markierung kurz verzoegert auffrischen
    window.sofiaHistoryChanged = () => {
      if (!marksOn) return;
      clearTimeout(authorsTimer);
      authorsTimer = setTimeout(loadAuthors, 1500);
    };
    function setMarks(on) {
      marksOn = on;
      marksBtn.classList.toggle("active", on);
      if (on) loadAuthors();
      else {
        authorMarks = null;
        renderLegend([...new Set(groups.map((g) => g.person))]);
        requestRedraw();
      }
    }
    marksBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setMarks(!marksOn);
    });
    function open() {
      panel.classList.remove("hidden");
      document.body.classList.add("history-open");
      load();
    }
    function close() {
      leavePreview();
      setMarks(false);
      panel.classList.add("hidden");
      document.body.classList.remove("history-open");
    }
    window.sofiaHistoryClose = () => {
      if (!panel.classList.contains("hidden")) close();
    };
    document.getElementById("canvas-menu-history")?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeCanvasMenus();
      if (!currentBoardId) return;
      open();
    });
    document.getElementById("history-close").addEventListener("click", (e) => {
      e.stopPropagation();
      close();
    });
    document.getElementById("history-back").addEventListener("click", (e) => {
      e.stopPropagation();
      leavePreview();
    });
    document.getElementById("history-restore").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!selected || !currentBoardId) return;
      const g = selected;
      const ok = await askConfirm({
        title: "Diese Version wiederherstellen?",
        text: "Das Blatt wird auf den Stand von " + whenLabel(g) + " zurückgesetzt. Das ist selbst ein Eintrag im Verlauf und lässt sich so wieder rückgängig machen.",
        ok: "Wiederherstellen",
        icon: "history",
        danger: false,
      });
      if (!ok) return;
      try {
        await api("/api/boards/" + encodeURIComponent(currentBoardId) + "/history/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ upto: g.toId }),
        });
        leavePreview();
        showToast("Version wiederhergestellt");
        setTimeout(load, 800);
      } catch (err) {
        showToast("Wiederherstellen hat nicht geklappt");
      }
    });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  })();

  // ---- Rechner & Umrechner (schwebendes Fenster) ----
  (() => {
    const win = document.getElementById("calc-win");
    const btn = document.getElementById("btn-calc");
    if (!win || !btn) return;
    const exprEl = document.getElementById("calc-expr");
    const liveEl = document.getElementById("calc-live");
    const prevEl = document.getElementById("calc-prev");
    let st = Object.assign({ open: false, tab: "calc", x: null, y: null, cat: "speed", from: "km/h", to: "m/s", hist: [], expr: "", ans: 0 }, lsGet("sofianotes-calc", {}));
    if (!Array.isArray(st.hist)) st.hist = [];
    // Eingabe, letztes Ergebnis und Verlauf bleiben auch nach dem Schliessen (und Neuladen) erhalten
    const save = () => {
      st.expr = expr;
      st.ans = ans;
      lsSet("sofianotes-calc", st);
    };
    let expr = typeof st.expr === "string" ? st.expr : "";
    let ans = Number.isFinite(st.ans) ? st.ans : 0;
    const histEl = document.getElementById("calc-hist");
    const histBtn = document.getElementById("calc-hist-btn");
    let showHist = false;
    function renderHist() {
      histEl.innerHTML = "";
      if (!st.hist.length) {
        const empty = document.createElement("div");
        empty.className = "calc-hist-empty";
        empty.textContent = "Noch nichts gerechnet.";
        histEl.appendChild(empty);
        return;
      }
      for (const h of st.hist.slice().reverse()) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "calc-hist-item";
        b.title = "Ergebnis übernehmen";
        b.innerHTML = "<small></small><strong></strong>";
        b.children[0].textContent = h.e + " =";
        b.children[1].textContent = h.r;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          expr += h.r.replace(/\./g, "");
          setHist(false);
          renderCalc();
          save();
        });
        histEl.appendChild(b);
      }
      const clr = document.createElement("button");
      clr.type = "button";
      clr.className = "calc-hist-clear";
      clr.textContent = "Verlauf löschen";
      clr.addEventListener("click", (e) => {
        e.stopPropagation();
        st.hist = [];
        save();
        renderHist();
      });
      histEl.appendChild(clr);
    }
    function setHist(on) {
      showHist = on;
      histEl.classList.toggle("hidden", !on);
      keysEl.classList.toggle("hidden", on);
      histBtn.classList.toggle("active", on);
      if (on) {
        renderHist();
        if (st.tab !== "calc") showTab("calc");
      }
    }
    histBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setHist(!showHist);
    });
    let calcFocused = false;

    // Zahlen deutsch: Komma, bis 10 gueltige Stellen, sehr gross/klein mit Exponent
    function fmt(v) {
      if (!Number.isFinite(v)) return "Fehler";
      if (v === 0) return "0";
      const a = Math.abs(v);
      if (a >= 1e15 || a < 1e-9) return v.toExponential(6).replace(".", ",").replace("e+", " · 10^").replace("e-", " · 10^-");
      const r = Number(v.toPrecision(12));
      return r.toLocaleString("de-DE", { maximumFractionDigits: 10, useGrouping: true });
    }
    // Kleiner Rechen-Parser (kein eval): + - × ÷ ^ % ( ) √ sin cos tan log ln π e Ans, Winkel in Grad
    function evaluate(src) {
      const s = src.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/,/g, ".");
      let i = 0;
      const peek = () => s[i];
      const ws = () => {
        while (s[i] === " ") i++;
      };
      const rad = (d) => (d * Math.PI) / 180;
      const FN = {
        sin: (x) => Math.sin(rad(x)),
        cos: (x) => Math.cos(rad(x)),
        tan: (x) => Math.tan(rad(x)),
        log: Math.log10,
        ln: Math.log,
        "√": Math.sqrt,
      };
      function primary() {
        ws();
        const c = peek();
        if (c === "(") {
          i++;
          const v = expr0();
          ws();
          if (peek() === ")") i++;
          return v;
        }
        if (c === "-") {
          i++;
          return -power();
        }
        if (c === "+") {
          i++;
          return power();
        }
        if (c === "π") {
          i++;
          return Math.PI;
        }
        if (s.startsWith("Ans", i)) {
          i += 3;
          return ans;
        }
        for (const name of Object.keys(FN)) {
          if (s.startsWith(name, i)) {
            i += name.length;
            return FN[name](power());
          }
        }
        if (c === "e" && !/[0-9]/.test(s[i + 1] || "")) {
          i++;
          return Math.E;
        }
        const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|^[0-9]+\./.exec(s.slice(i));
        if (!m) throw new Error("syntax");
        i += m[0].length;
        return parseFloat(m[0]);
      }
      function postfix() {
        let v = primary();
        for (;;) {
          ws();
          if (peek() === "%") {
            i++;
            v /= 100;
          } else if (peek() === "²") {
            i++;
            v *= v;
          } else if (peek() === "(" || peek() === "π" || peek() === "√" || /[a-zA-Z]/.test(peek() || "")) {
            v *= primary(); // 2π, 3(4+1), 2√9
          } else return v;
        }
      }
      function power() {
        const b = postfix();
        ws();
        if (peek() === "^") {
          i++;
          return Math.pow(b, power());
        }
        return b;
      }
      function term() {
        let v = power();
        for (;;) {
          ws();
          const c = peek();
          if (c === "*") {
            i++;
            v *= power();
          } else if (c === "/") {
            i++;
            v /= power();
          } else return v;
        }
      }
      function expr0() {
        let v = term();
        for (;;) {
          ws();
          const c = peek();
          if (c === "+") {
            i++;
            v += term();
          } else if (c === "-") {
            i++;
            v -= term();
          } else return v;
        }
      }
      const v = expr0();
      ws();
      if (i < s.length) throw new Error("syntax");
      return v;
    }
    function balance(e) {
      let open = 0;
      for (const ch of e) {
        if (ch === "(") open++;
        else if (ch === ")") open--;
      }
      return e + ")".repeat(Math.max(0, open));
    }
    function renderCalc() {
      exprEl.textContent = expr || "0";
      let live = "";
      if (expr && /[^0-9,]/.test(expr)) {
        try {
          live = "= " + fmt(evaluate(balance(expr)));
        } catch (err) {
          live = "";
        }
      }
      liveEl.textContent = live;
    }
    let justEvaluated = false;
    function press(k) {
      // nach "=" beginnt eine Zahl eine neue Rechnung, ein Rechenzeichen rechnet mit dem Ergebnis weiter
      if (justEvaluated && !["=", "⌫", "AC", "+", "−", "×", "÷", "xʸ", "x²", "%"].includes(k)) expr = "";
      justEvaluated = k === "=";
      if (k === "AC") expr = "";
      else if (k === "⌫") {
        const fn = /(sin\(|cos\(|tan\(|log\(|ln\(|Ans)$/.exec(expr);
        expr = fn ? expr.slice(0, -fn[0].length) : expr.slice(0, -1);
      } else if (k === "=") {
        if (!expr) return;
        try {
          const v = evaluate(balance(expr));
          prevEl.textContent = balance(expr) + " =";
          if (Number.isFinite(v)) {
            st.hist.push({ e: balance(expr), r: fmt(v) });
            if (st.hist.length > 60) st.hist.splice(0, st.hist.length - 60);
          }
          ans = v;
          const big = Math.abs(v) >= 1e15 || (v !== 0 && Math.abs(v) < 1e-9);
          expr = !Number.isFinite(v) ? "" : big ? String(v).replace(".", ",") : fmt(v).replace(/\./g, "");
          if (!Number.isFinite(v)) liveEl.textContent = "Fehler";
        } catch (err) {
          liveEl.textContent = "Fehler";
          return;
        }
      } else if (k === "x²") expr += "²";
      else if (k === "xʸ") expr += "^";
      else if (["sin", "cos", "tan", "log", "ln"].includes(k)) expr += k + "(";
      else if (k === "√") expr += "√(";
      else expr += k;
      renderCalc();
      save();
    }
    // Zwei Ansichten: Normal (gross, nur Grundrechenarten) und Wissenschaftlich
    const LAYOUTS = {
      basic: [
        ["AC", "⌫", "%", "÷"],
        ["7", "8", "9", "×"],
        ["4", "5", "6", "−"],
        ["1", "2", "3", "+"],
        ["0", ",", "="],
      ],
      sci: [
        ["sin", "cos", "tan", "√", "xʸ"],
        ["(", ")", "%", "AC", "⌫"],
        ["7", "8", "9", "÷", "π"],
        ["4", "5", "6", "×", "x²"],
        ["1", "2", "3", "−", "log"],
        ["0", ",", "Ans", "+", "="],
      ],
    };
    const keysEl = document.getElementById("calc-keys");
    function renderKeys() {
      const mode = st.mode === "sci" ? "sci" : "basic";
      keysEl.innerHTML = "";
      keysEl.className = "calc-keys calc-keys-" + mode + (showHist ? " hidden" : "");
      for (const row of LAYOUTS[mode])
        for (const k of row) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = k;
          b.className = "calc-key" + (/^[0-9,]$/.test(k) ? " num" : k === "=" ? " eq" : ["AC", "⌫"].includes(k) ? " clr" : " op") + (mode === "basic" && k === "0" ? " wide" : "");
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            press(k);
          });
          keysEl.appendChild(b);
        }
      document.querySelectorAll("#calc-mode [data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    }
    document.querySelectorAll("#calc-mode [data-mode]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        st.mode = b.dataset.mode;
        save();
        if (showHist) setHist(false);
        renderKeys();
      })
    );
    renderKeys();
    // Tastatur (wenn das Fenster offen ist und nichts anderes Eingaben hat)
    window.addEventListener("keydown", (e) => {
      if (win.classList.contains("hidden") || !calcFocused || st.tab !== "calc" || e.metaKey || e.ctrlKey) return;
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
      const map = { "*": "×", "/": "÷", "-": "−", Enter: "=", "=": "=", Backspace: "⌫", Escape: "AC", ".": "," };
      const k = map[e.key] || (/^[0-9+()%^,]$/.test(e.key) ? e.key : null);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      press(k === "^" ? "xʸ" : k);
    }, true);

    // ---- Umrechner ----
    const T = (c, f) => ({ toBase: c, fromBase: f });
    const CATS = {
      speed: { name: "Geschwindigkeit", units: { "km/h": 1 / 3.6, "m/s": 1, mph: 0.44704, Knoten: 1852 / 3600, "ft/s": 0.3048, "Mach": 343 } },
      length: { name: "Länge", units: { mm: 0.001, cm: 0.01, dm: 0.1, m: 1, km: 1000, Zoll: 0.0254, Fuß: 0.3048, Yard: 0.9144, Meile: 1609.344, Seemeile: 1852, Lichtjahr: 9.4607304725808e15 } },
      area: { name: "Fläche", units: { "mm²": 1e-6, "cm²": 1e-4, "dm²": 0.01, "m²": 1, a: 100, ha: 1e4, "km²": 1e6, Acre: 4046.8564224 } },
      volume: { name: "Volumen", units: { ml: 1e-6, cl: 1e-5, dl: 1e-4, l: 1e-3, "cm³": 1e-6, "dm³": 1e-3, "m³": 1, Gallone: 0.003785411784 } },
      mass: { name: "Masse", units: { mg: 1e-6, g: 1e-3, kg: 1, t: 1000, Pfund: 0.45359237, Unze: 0.028349523125 } },
      time: { name: "Zeit", units: { ms: 0.001, s: 1, min: 60, h: 3600, Tag: 86400, Woche: 604800, Jahr: 31557600 } },
      temp: { name: "Temperatur", units: { "°C": T((v) => v + 273.15, (k) => k - 273.15), "°F": T((v) => ((v - 32) * 5) / 9 + 273.15, (k) => ((k - 273.15) * 9) / 5 + 32), K: T((v) => v, (k) => k) } },
      pressure: { name: "Druck", units: { Pa: 1, hPa: 100, kPa: 1000, bar: 1e5, mbar: 100, atm: 101325, psi: 6894.757293168, mmHg: 133.322387415 } },
      energy: { name: "Energie", units: { J: 1, kJ: 1000, cal: 4.184, kcal: 4184, Wh: 3600, kWh: 3.6e6, eV: 1.602176634e-19 } },
      power: { name: "Leistung", units: { W: 1, kW: 1000, MW: 1e6, PS: 735.49875 } },
      angle: { name: "Winkel", units: { Grad: 1, rad: 180 / Math.PI, gon: 0.9, Umdrehung: 360 } },
      data: { name: "Datenmenge", units: { Bit: 0.125, Byte: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1048576, GiB: 1073741824 } },
    };
    // Eigene Auswahllisten statt der System-Dropdowns
    let ddOpen = null;
    function closeDd() {
      if (ddOpen) ddOpen.menu.remove();
      if (ddOpen) ddOpen.dd.btn.classList.remove("open");
      ddOpen = null;
    }
    function makeDd(id, onPick) {
      const btn = document.getElementById(id);
      const dd = { btn, options: [], val: null };
      dd.setOptions = (opts) => {
        dd.options = opts;
      };
      Object.defineProperty(dd, "value", {
        get: () => dd.val,
        set: (v) => {
          dd.val = v;
          const o = dd.options.find((x) => x.value === v);
          btn.querySelector(".conv-dd-label").textContent = o ? o.label : "";
        },
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (ddOpen && ddOpen.dd === dd) return closeDd();
        closeDd();
        const menu = document.createElement("div");
        menu.className = "conv-menu";
        for (const o of dd.options) {
          const it = document.createElement("button");
          it.type = "button";
          it.className = "conv-menu-item" + (o.value === dd.val ? " active" : "");
          it.innerHTML = '<span></span><span class="material-symbols-rounded">check</span>';
          it.firstChild.textContent = o.label;
          it.addEventListener("click", (ev) => {
            ev.stopPropagation();
            closeDd();
            dd.value = o.value;
            onPick(o.value);
          });
          menu.appendChild(it);
        }
        menu.addEventListener("pointerdown", (ev) => {
          calcFocused = true;
          ev.stopPropagation();
        });
        document.body.appendChild(menu);
        const r = btn.getBoundingClientRect();
        const w = Math.max(r.width, 170);
        const h = Math.min(menu.scrollHeight, 300);
        let top = r.bottom + 6;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
        Object.assign(menu.style, { left: Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + "px", top: top + "px", width: w + "px" });
        btn.classList.add("open");
        ddOpen = { dd, menu };
        menu.querySelector(".active")?.scrollIntoView({ block: "center" });
      });
      return dd;
    }
    window.addEventListener("pointerdown", (e) => {
      if (ddOpen && !e.target.closest(".conv-menu") && !ddOpen.dd.btn.contains(e.target)) closeDd();
    }, true);
    const catSel = makeDd("conv-cat", (v) => {
      st.cat = v;
      st.from = st.to = null;
      fillUnits();
      save();
      renderConv();
    });
    const fromSel = makeDd("conv-from", (v) => {
      st.from = v;
      save();
      renderConv();
    });
    const toSel = makeDd("conv-to", (v) => {
      st.to = v;
      save();
      renderConv();
    });
    const inEl = document.getElementById("conv-in");
    const outEl = document.getElementById("conv-out");
    const allEl = document.getElementById("conv-all");
    catSel.setOptions(Object.entries(CATS).map(([k, c]) => ({ value: k, label: c.name })));
    const toBase = (cat, u, v) => {
      const f = CATS[cat].units[u];
      return typeof f === "number" ? v * f : f.toBase(v);
    };
    const fromBase = (cat, u, b) => {
      const f = CATS[cat].units[u];
      return typeof f === "number" ? b / f : f.fromBase(b);
    };
    function fillUnits() {
      const units = Object.keys(CATS[st.cat].units);
      if (!units.includes(st.from)) st.from = units[0];
      if (!units.includes(st.to)) st.to = units[1] || units[0];
      for (const sel of [fromSel, toSel]) sel.setOptions(units.map((u) => ({ value: u, label: u })));
      catSel.value = st.cat;
      fromSel.value = st.from;
      toSel.value = st.to;
    }
    function renderConv() {
      let v;
      try {
        v = inEl.value.trim() ? evaluate(inEl.value) : NaN;
      } catch (err) {
        v = NaN;
      }
      allEl.innerHTML = "";
      if (!Number.isFinite(v)) {
        outEl.textContent = "–";
        return;
      }
      const base = toBase(st.cat, st.from, v);
      outEl.textContent = fmt(fromBase(st.cat, st.to, base));
      for (const u of Object.keys(CATS[st.cat].units)) {
        if (u === st.from) continue;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "conv-line" + (u === st.to ? " active" : "");
        row.innerHTML = "<span></span><strong></strong>";
        row.children[0].textContent = u;
        row.children[1].textContent = fmt(fromBase(st.cat, u, base));
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          st.to = u;
          toSel.value = u;
          save();
          renderConv();
        });
        allEl.appendChild(row);
      }
    }

    inEl.addEventListener("input", renderConv);
    document.getElementById("conv-swap").addEventListener("click", (e) => {
      e.stopPropagation();
      [st.from, st.to] = [st.to, st.from];
      const out = outEl.textContent;
      if (out && out !== "–" && !out.includes("10^")) inEl.value = out.replace(/\./g, "");
      fillUnits();
      save();
      renderConv();
    });

    // ---- Fenster: Reiter, Oeffnen, Verschieben ----
    function showTab(tab) {
      st.tab = tab;
      win.querySelectorAll(".calc-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
      win.querySelectorAll(".calc-body").forEach((b) => b.classList.toggle("hidden", b.dataset.tab !== tab));
      histBtn.classList.toggle("hidden", tab !== "calc");
      save();
      place();
    }
    win.querySelectorAll(".calc-tab").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        showTab(b.dataset.tab);
      })
    );
    function place() {
      const w = win.offsetWidth || 300;
      const h = win.offsetHeight || 420;
      const x = st.x == null ? window.innerWidth - w - 24 : st.x;
      const y = st.y == null ? 90 : st.y;
      win.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, x)) + "px";
      win.style.top = Math.max(6, Math.min(window.innerHeight - Math.min(h, 120), y)) + "px";
    }
    function setOpen(open) {
      closeDd();
      st.open = open;
      win.classList.toggle("hidden", !open);
      btn.classList.toggle("active", open);
      save();
      if (open) {
        showTab(st.tab);
        renderCalc();
      }
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(win.classList.contains("hidden"));
    });
    document.getElementById("calc-close").addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(false);
    });
    // nichts im Fenster darf aufs Blatt malen; Tastatur gehoert dem Rechner nur nach Klick hinein
    win.addEventListener("pointerdown", (e) => {
      calcFocused = true;
      e.stopPropagation();
    });
    window.addEventListener("pointerdown", () => (calcFocused = false), true);
    const head = document.getElementById("calc-head");
    let drag = null;
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      const r = win.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      try {
        head.setPointerCapture(e.pointerId);
      } catch (err) {}
    });
    head.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      st.x = e.clientX - drag.dx;
      st.y = e.clientY - drag.dy;
      place();
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      const r = win.getBoundingClientRect();
      st.x = r.left;
      st.y = r.top;
      save();
    };
    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", () => {
      if (!win.classList.contains("hidden")) place();
    });
    fillUnits();
    renderConv();
    if (st.hist.length) prevEl.textContent = st.hist[st.hist.length - 1].e + " =";
    if (st.open) setOpen(true);
  })();

  // Texterkennung im Hintergrund vorladen, wenn die App schon laeuft
  setTimeout(() => {
    if (window.ensureTf) window.ensureTf().catch(() => {});
  }, 6000);

  resizeCanvas();
  offsetX = window.innerWidth / 2;
  offsetY = window.innerHeight / 2;
  requestAnimationFrame(tick);

  (async () => {
    showGate("Lädt…", "");
    let me;
    try {
      me = await api("/api/me");
    } catch (err) {
      if (String(err.message) === "401") {
        showGate("Nicht angemeldet", "Bitte über den regulären Zugangslink erneut anmelden (Cloudflare Access).");
      } else if (String(err.message) === "403") {
        showGate("Kein Zugriff", "Diese Mail-Adresse ist noch keiner Person zugeordnet. Ein Admin muss dich erst freischalten.");
      } else {
        showGate("Verbindung fehlgeschlagen", "Bitte Seite neu laden.");
      }
      return;
    }
    currentPersonId = me.id;
    isAdmin = !!me.isAdmin;
    document.getElementById("btn-library-switch")?.classList.toggle("hidden", !isAdmin);
    localStorage.setItem("sofianotes-person", currentPersonId);
    const startParams = new URLSearchParams(location.search);
    currentFolderId = startParams.get("folder") || null;
    loadMySettings();
    prefSync.check(true);
    await refreshPeople();
    hideWho();
    syncWhoChip();
    showLibrary({ fromHistory: true });
    // Link mit ?board=... oeffnet direkt dieses Blatt (Titel kommt mit dem "init" vom Server)
    const startBoard = startParams.get("board");
    if (startBoard) await openBoard(startBoard, null, { fromHistory: true });
    syncUrl(false);
  })();
})();
