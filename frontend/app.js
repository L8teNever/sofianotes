(() => {
  "use strict";

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
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
  const POINTS_FLUSH_MS = 30;
  const ERASE_FLUSH_MS = 60;
  const CURSOR_SEND_MS = 45;
  const HOLD_MS = 450; // wie lange der Stift ruhig gehalten werden muss, damit eine Form erkannt wird
  const MIN_MOVE_WORLD = 1.2; // Punkte unterhalb dieser Bewegung gelten als "Zittern", nicht als echte Bewegung

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

  function resizeCanvas() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    requestRedraw();
  }
  window.addEventListener("resize", resizeCanvas);

  // ---- board state ------------------------------------------------------
  const boardStrokes = new Map(); // id -> stroke
  const remoteInProgress = new Map(); // strokeId -> stroke (owned by other client)
  let currentStroke = null; // own in-progress stroke
  let dirty = true;
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

  function widthAt(size, pressure) {
    const p = pressure && pressure > 0 ? pressure : 0.5;
    return Math.max(1, size * (0.3 + 0.7 * p));
  }

  function catmullRomPoint(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      p: (p1.p || 0.5) * (1 - t) + (p2.p || 0.5) * t,
    };
  }

  function densifyStroke(pts) {
    if (pts.length < 3) return pts;
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? 0 : i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const steps = Math.max(1, Math.min(10, Math.ceil(segLen / 3.5)));
      for (let s = 0; s < steps; s++) {
        out.push(catmullRomPoint(p0, p1, p2, p3, s / steps));
      }
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

  function drawRibbon(pts, size, color, alpha, constantWidth) {
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

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, radii[0], 0, Math.PI * 2);
    ctx.arc(pts[pts.length - 1].x, pts[pts.length - 1].y, radii[radii.length - 1], 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPolylineStroke(pts, size, color, alpha, constantWidth) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (constantWidth) {
      ctx.lineWidth = size;
      ctx.stroke();
    } else {
      // wenige Punkte (erkannte Formen): trotzdem eine durchgehende Linie,
      // Breite aus mittlerem Druck, keine Perlen durch Einzel-Segmente
      let pSum = 0;
      for (const p of pts) pSum += p.p || 0.5;
      ctx.lineWidth = widthAt(size, pSum / pts.length);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStroke(stroke) {
    const pts = stroke.points;
    if (pts.length === 0) return;
    const isMarker = stroke.tool === "marker";
    const alpha = isMarker ? 0.38 : 1;
    if (pts.length === 1) {
      const p = pts[0];
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.fillStyle = stroke.color;
      ctx.arc(p.x, p.y, (isMarker ? stroke.size : widthAt(stroke.size, p.p)) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (looksLikePolygon(pts)) {
      drawPolylineStroke(pts, stroke.size, stroke.color, alpha, isMarker);
      return;
    }
    const dense = densifyStroke(pts);
    drawRibbon(dense, stroke.size, stroke.color, alpha, isMarker);
  }

  function drawGrid() {
    const topLeft = screenToWorld(0, 0);
    const bottomRight = screenToWorld(window.innerWidth, window.innerHeight);
    const startX = Math.floor(topLeft.x / GRID_SIZE) * GRID_SIZE;
    const startY = Math.floor(topLeft.y / GRID_SIZE) * GRID_SIZE;

    ctx.lineWidth = 1 / scale;
    for (let x = startX; x <= bottomRight.x; x += GRID_SIZE) {
      const bold = Math.round(x / GRID_SIZE) % 4 === 0;
      ctx.strokeStyle = bold ? "rgba(70,90,150,0.28)" : "rgba(70,90,150,0.14)";
      ctx.beginPath();
      ctx.moveTo(x, topLeft.y);
      ctx.lineTo(x, bottomRight.y);
      ctx.stroke();
    }
    for (let y = startY; y <= bottomRight.y; y += GRID_SIZE) {
      const bold = Math.round(y / GRID_SIZE) % 4 === 0;
      ctx.strokeStyle = bold ? "rgba(70,90,150,0.28)" : "rgba(70,90,150,0.14)";
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
      ctx.restore();
    }
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ece9e3";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
    drawGrid();

    // Marker/Textmarker zuerst (liegt optisch unter der normalen Tinte).
    for (const stroke of boardStrokes.values()) if (stroke.tool === "marker") drawStroke(stroke);
    for (const stroke of remoteInProgress.values()) if (stroke.tool === "marker") drawStroke(stroke);
    if (currentStroke && currentStroke.tool === "marker") drawStroke(currentStroke);

    for (const stroke of boardStrokes.values()) if (stroke.tool !== "marker") drawStroke(stroke);
    for (const stroke of remoteInProgress.values()) if (stroke.tool !== "marker") drawStroke(stroke);
    if (currentStroke && currentStroke.tool && currentStroke.tool !== "marker") drawStroke(currentStroke);

    drawLassoAndSelection();

    zoomIndicatorEl.textContent = Math.round(scale * 100) + "%";
    repositionPresenceLabels();
  }

  function tick() {
    if (dirty) {
      draw();
      dirty = false;
    }
    flushNetworkBuffers();
    requestAnimationFrame(tick);
  }

  // ---- toolbar ------------------------------------------------------
  let currentTool = "pen"; // pen | marker | eraser | select
  let currentColor = "#1c1c1e";
  let penSize = 4;
  let markerSize = 18;
  let eraserSize = 24;
  let shapeRecognitionEnabled = true;
  let fingerDrawEnabled = false;

  function activeSize() {
    if (currentTool === "eraser") return eraserSize;
    if (currentTool === "marker") return markerSize;
    return penSize;
  }

  function isInkTool(tool) {
    return tool === "pen" || tool === "marker";
  }

  toolbarEl.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      toolbarEl.querySelectorAll(".tool-btn[data-tool]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentTool = btn.dataset.tool;
      sizeSlider.value = String(activeSize());
      updateEraserCursorVisibility();
      if (currentTool !== "select") clearSelection();
    });
  });
  toolbarEl.querySelectorAll(".swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      toolbarEl.querySelectorAll(".swatch").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentColor = btn.dataset.color;
    });
  });
  sizeSlider.addEventListener("input", () => {
    const v = Number(sizeSlider.value);
    if (currentTool === "eraser") eraserSize = v * 2;
    else if (currentTool === "marker") markerSize = v * 1.5;
    else penSize = v;
    updateEraserCursorVisibility();
  });
  sizeSlider.value = String(penSize);

  shapeToggleEl.addEventListener("click", () => {
    shapeRecognitionEnabled = !shapeRecognitionEnabled;
    shapeToggleEl.classList.toggle("active", shapeRecognitionEnabled);
  });

  fingerDrawToggleEl.addEventListener("click", () => {
    fingerDrawEnabled = !fingerDrawEnabled;
    fingerDrawToggleEl.classList.toggle("active", fingerDrawEnabled);
  });

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

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function setConnected(connected) {
    statusEl.classList.toggle("connected", connected);
    statusTextEl.textContent = connected ? "Live" : "Verbinde…";
  }

  function connectWS() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      setConnected(true);
      reconnectDelay = 1000;
    };
    ws.onclose = () => {
      setConnected(false);
      setTimeout(connectWS, reconnectDelay);
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
      s.bbox = makeBBox(s.points);
      boardStrokes.set(s.id, s);
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "init": {
        myClientId = msg.clientId;
        myColor = msg.color;
        boardStrokes.clear();
        for (const s of msg.strokes) {
          s.bbox = makeBBox(s.points);
          boardStrokes.set(s.id, s);
        }
        requestRedraw();
        break;
      }
      case "presence_join":
        ensurePresence(msg.id, msg.color);
        break;
      case "presence_leave":
        removePresence(msg.id);
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
        if (s) s.points = msg.points;
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
          s.bbox = makeBBox(s.points);
          boardStrokes.set(s.id, s);
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
      p.el.textContent = TOOL_LABELS[p.tool] || p.tool;
    }
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
    return { id: s.id, tool: s.tool, color: s.color, size: s.size, points: s.points.map((p) => ({ ...p })) };
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
  function putStroke(stroke) {
    const withBBox = { ...stroke, bbox: makeBBox(stroke.points) };
    boardStrokes.set(withBBox.id, withBBox);
    wsSend({ type: "stroke_move", stroke: { id: stroke.id, tool: stroke.tool, color: stroke.color, size: stroke.size, points: stroke.points } });
  }
  function removeStrokes(ids) {
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
          s.bbox = makeBBox(s.points);
          wsSend({ type: "stroke_move", stroke: { id: s.id, tool: s.tool, color: s.color, size: s.size, points: s.points } });
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
  window.addEventListener("keydown", (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (!meta || e.key.toLowerCase() !== "z") return;
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  });
  updateUndoRedoButtons();

  // ---- Formen-Erkennung (Linie/Rechteck/Dreieck/Kreis beim Halten) ------
  let holdTimer = null;

  function clearHoldTimer() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }
  function armHoldTimer() {
    clearHoldTimer();
    if (!shapeRecognitionEnabled) return;
    if (!currentStroke || currentStroke.tool !== "pen" || currentStroke.locked) return;
    holdTimer = setTimeout(tryShapeSnap, HOLD_MS);
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

    const minAngle = (28 * Math.PI) / 180;
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
    const tol = Math.max(5, Math.min(w, h) * 0.14);
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

  function detectShape(rawPoints) {
    if (rawPoints.length < 6) return null;
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

    if (!closed) {
      let maxDev = 0;
      for (const p of rawPoints) {
        const d = perpDist(p, start, end);
        if (d > maxDev) maxDev = d;
      }
      if (pathLength > 0 && maxDev / pathLength < 0.09) {
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
    const circular = circleFit < 0.28 && periFit < 0.32 && boxy < 0.55;

    const corners = findDominantCorners(rawPoints, diagonal, true);
    const quad = collapseToQuad(corners, diagonal);
    const preferCircleOverQuad = circular && boxy < 0.42 && circleFit < 0.16;

    // Rechteck/Quadrat hat Vorrang vor Kreis, sobald vier Ecken da sind
    // (auch wenn die Winkel nicht sauber 90° sind).
    if (quad && quad.length === 4 && !preferCircleOverQuad) {
      return { type: "rectangle", points: fitOrientedRect(quad, avgPressure) };
    }
    if (boxy >= 0.62 && !circular) {
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

    if (circular || (circleFit < 0.22 && periFit < 0.28)) {
      const useCircle = aspectDiff < 0.18;
      const rx = useCircle ? meanR : w / 2;
      const ry = useCircle ? meanR : h / 2;
      return { type: "circle", points: makeEllipsePoints(cx, cy, rx, ry, avgPressure, 96) };
    }
    return null;
  }

  function tryShapeSnap() {
    holdTimer = null;
    if (!currentStroke || currentStroke.tool !== "pen" || currentStroke.locked) return;
    const detected = detectShape(currentStroke.points);
    if (!detected) return;
    currentStroke.points = detected.points;
    currentStroke.unsent = [];
    currentStroke.locked = true;
    wsSend({ type: "stroke_replace", strokeId: currentStroke.id, points: detected.points });
    requestRedraw();
  }

  // ---- drawing (pointer handling with palm rejection) -------------------
  const activePointers = new Map(); // pointerId -> {type,x,y}
  const touchPointers = new Map(); // pointerId -> {x,y}
  let pinchState = null; // {initialDist, anchorWorld:{x,y}}
  let panState = null; // {lastX,lastY, pointerId|null}
  let spacePressed = false;

  // ---- Auswahl-Werkzeug (Lasso markieren + verschieben) -----------------
  let lassoPoints = null;
  let lassoPointerId = null;
  let selection = { ids: new Set(), bbox: null };
  let dragState = null; // {pointerId, startWorld, snapshot: Map(id -> points[])}

  function clearSelection() {
    selection = { ids: new Set(), bbox: null };
    lassoPoints = null;
    lassoPointerId = null;
    dragState = null;
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
    if (!lassoPoints || lassoPoints.length < 3) {
      clearSelection();
      lassoPoints = null;
      return;
    }
    const poly = lassoPoints;
    const ids = new Set();
    for (const stroke of boardStrokes.values()) {
      for (const p of stroke.points) {
        if (pointInPolygon(p, poly)) {
          ids.add(stroke.id);
          break;
        }
      }
    }
    lassoPoints = null;
    if (ids.size === 0) {
      clearSelection();
      return;
    }
    selection = { ids, bbox: unionBBox(Array.from(ids).map((id) => boardStrokes.get(id).bbox)) };
    requestRedraw();
  }

  function startSelectionDrag(pointerId, world) {
    const snapshot = new Map();
    for (const id of selection.ids) {
      const s = boardStrokes.get(id);
      if (s) snapshot.set(id, s.points.map((p) => ({ x: p.x, y: p.y, p: p.p })));
    }
    dragState = { pointerId, startWorld: world, snapshot };
  }

  function updateSelectionDrag(world) {
    const dx = world.x - dragState.startWorld.x;
    const dy = world.y - dragState.startWorld.y;
    const boxes = [];
    for (const [id, pts] of dragState.snapshot) {
      const s = boardStrokes.get(id);
      if (!s) continue;
      s.points = pts.map((p) => ({ x: p.x + dx, y: p.y + dy, p: p.p }));
      s.bbox = makeBBox(s.points);
      boxes.push(s.bbox);
    }
    selection.bbox = unionBBox(boxes);
    requestRedraw();
  }

  function finalizeSelectionDrag() {
    const moves = [];
    for (const [id, beforePts] of dragState.snapshot) {
      const s = boardStrokes.get(id);
      if (s) {
        wsSend({ type: "stroke_move", stroke: { id: s.id, tool: s.tool, color: s.color, size: s.size, points: s.points } });
        moves.push({ id, before: beforePts, after: s.points.map((p) => ({ ...p })) });
      }
    }
    if (moves.length > 0) pushUndo({ type: "move", moves });
    dragState = null;
  }
  function cancelSelectionDrag() {
    for (const [id, pts] of dragState.snapshot) {
      const s = boardStrokes.get(id);
      if (s) {
        s.points = pts;
        s.bbox = makeBBox(pts);
      }
    }
    dragState = null;
    requestRedraw();
  }

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
    const id = uuid();
    const tool = currentTool === "marker" ? "marker" : "pen";
    const size = activeSize();
    currentStroke = {
      id,
      tool,
      color: currentColor,
      size,
      points: [{ x: wx, y: wy, p: pressure }],
      unsent: [],
      pointerId,
      pointerType,
      locked: false,
    };
    wsSend({ type: "stroke_start", strokeId: id, tool, color: currentColor, size, points: currentStroke.points });
    if (tool === "pen") armHoldTimer();
    requestRedraw();
  }

  function extendStroke(wx, wy, pressure) {
    if (!currentStroke || currentStroke.locked) return;
    const last = currentStroke.points[currentStroke.points.length - 1];
    const moved = !last || Math.hypot(wx - last.x, wy - last.y) >= MIN_MOVE_WORLD;
    if (!moved) return; // Zittern ignorieren, Halte-Timer NICHT zuruecksetzen
    const point = { x: wx, y: wy, p: pressure };
    currentStroke.points.push(point);
    currentStroke.unsent.push(point);
    if (currentStroke.tool === "pen") armHoldTimer();
    requestRedraw();
  }

  function endStroke() {
    if (!currentStroke) return;
    clearHoldTimer();
    if (currentStroke.unsent.length > 0) {
      wsSend({ type: "stroke_points", strokeId: currentStroke.id, points: currentStroke.unsent });
      currentStroke.unsent = [];
    }
    wsSend({ type: "stroke_end", strokeId: currentStroke.id });
    currentStroke.bbox = makeBBox(currentStroke.points);
    boardStrokes.set(currentStroke.id, currentStroke);
    pushUndo({ type: "add", stroke: cloneStroke(currentStroke) });
    currentStroke = null;
    requestRedraw();
  }

  function abortStroke() {
    if (!currentStroke) return;
    clearHoldTimer();
    wsSend({ type: "stroke_abort", strokeId: currentStroke.id });
    currentStroke = null;
    requestRedraw();
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
        const b = stroke.bbox;
        if (sx < b.minX - r || sx > b.maxX + r || sy < b.minY - r || sy > b.maxY + r) continue;
        const hitR = r + stroke.size / 2;
        for (const p of stroke.points) {
          const dx = p.x - sx, dy = p.y - sy;
          if (dx * dx + dy * dy <= hitR * hitR) {
            erasedThisGesture.add(stroke.id);
            erasedStrokesThisGesture.set(stroke.id, cloneStroke(stroke));
            break;
          }
        }
      }
    }
    if (erasedThisGesture.size > 0) {
      for (const id of erasedThisGesture) {
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

  function dispatchPrimaryDown(e) {
    const world = screenToWorld(e.clientX, e.clientY);
    if (currentTool === "select") {
      if (selection.bbox && pointInBBox(world, selection.bbox, 10 / scale)) {
        startSelectionDrag(e.pointerId, world);
      } else {
        clearSelection();
        lassoPointerId = e.pointerId;
        lassoPoints = [world];
      }
    } else if (currentTool === "eraser") {
      erasedThisGesture.clear();
      erasedStrokesThisGesture.clear();
      currentStroke = { pointerId: e.pointerId, eraser: true, lastX: world.x, lastY: world.y };
      eraseSegment(world.x, world.y, world.x, world.y);
      updateEraserCursor(e.clientX, e.clientY);
    } else {
      startStroke(e.pointerId, e.pointerType, world.x, world.y, pointerPressure(e));
    }
    sendCursor(world.x, world.y, currentTool, activeSize());
  }

  canvas.addEventListener("pointerdown", (e) => {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      // manche Browser/synthetische Events lehnen Pointer Capture ab - Zeichnen soll trotzdem funktionieren
    }
    activePointers.set(e.pointerId, { type: e.pointerType, x: e.clientX, y: e.clientY });

    if (e.pointerType === "touch") {
      touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPointers.size === 2) {
        if (currentStroke) abortStroke();
        if (dragState) cancelSelectionDrag();
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
        if (fingerDrawEnabled && !pinchState) {
          dispatchPrimaryDown(e);
          return;
        }
        if (!pinchState) panState = { lastX: e.clientX, lastY: e.clientY };
      }
      return;
    }

    if (e.pointerType === "mouse" && (spacePressed || e.button === 1)) {
      panState = { lastX: e.clientX, lastY: e.clientY, pointerId: e.pointerId };
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;

    dispatchPrimaryDown(e);
  });

  canvas.addEventListener("pointermove", (e) => {
    activePointers.set(e.pointerId, { type: e.pointerType, x: e.clientX, y: e.clientY });

    if (e.pointerType === "touch") {
      touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
        (dragState && dragState.pointerId === e.pointerId) ||
        lassoPointerId === e.pointerId ||
        (currentStroke && currentStroke.pointerId === e.pointerId);
      if (!isActiveDrawTouch) {
        if (panState && touchPointers.size === 1) {
          offsetX += e.clientX - panState.lastX;
          offsetY += e.clientY - panState.lastY;
          panState.lastX = e.clientX;
          panState.lastY = e.clientY;
          requestRedraw();
        }
        return;
      }
      // aktiver Finger-Zeichnen-Pointer: faellt durch zur gemeinsamen Logik unten
    } else if (panState && (panState.pointerId === undefined || panState.pointerId === e.pointerId)) {
      offsetX += e.clientX - panState.lastX;
      offsetY += e.clientY - panState.lastY;
      panState.lastX = e.clientX;
      panState.lastY = e.clientY;
      requestRedraw();
      return;
    }

    const world = screenToWorld(e.clientX, e.clientY);

    if (currentTool === "eraser") {
      updateEraserCursor(e.clientX, e.clientY);
    }

    if (dragState && dragState.pointerId === e.pointerId) {
      if (touchPointers.size >= 2) {
        cancelSelectionDrag();
        return;
      }
      updateSelectionDrag(world);
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
        eraseSegment(currentStroke.lastX, currentStroke.lastY, world.x, world.y);
        currentStroke.lastX = world.x;
        currentStroke.lastY = world.y;
      } else {
        extendStroke(world.x, world.y, pointerPressure(e));
      }
    }

    sendCursor(world.x, world.y, currentTool, activeSize());
  });

  function endPointer(e) {
    activePointers.delete(e.pointerId);

    if (e.pointerType === "touch") {
      touchPointers.delete(e.pointerId);
      if (touchPointers.size < 2) pinchState = null;
      if (touchPointers.size === 0) panState = null;
      const wasActiveDrawTouch =
        (dragState && dragState.pointerId === e.pointerId) ||
        lassoPointerId === e.pointerId ||
        (currentStroke && currentStroke.pointerId === e.pointerId);
      if (!wasActiveDrawTouch) return;
      // aktiver Finger-Zeichnen-Pointer: faellt durch zur gemeinsamen Abschluss-Logik unten
    } else if (panState && (panState.pointerId === undefined || panState.pointerId === e.pointerId)) {
      panState = null;
      return;
    }

    if (dragState && dragState.pointerId === e.pointerId) {
      finalizeSelectionDrag();
      return;
    }
    if (lassoPointerId === e.pointerId) {
      lassoPointerId = null;
      finalizeLasso();
      return;
    }

    if (currentStroke && currentStroke.pointerId === e.pointerId) {
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
  canvas.addEventListener("pointerleave", (e) => {
    if (currentTool === "eraser" && !activePointers.has(e.pointerId)) {
      eraserCursorEl.style.display = "none";
    }
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const anchor = screenToWorld(e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * 0.0015);
      scale = clampZoom(scale * factor);
      offsetX = e.clientX - anchor.x * scale;
      offsetY = e.clientY - anchor.y * scale;
      requestRedraw();
    },
    { passive: false }
  );

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---- boot ------------------------------------------------------
  resizeCanvas();
  offsetX = window.innerWidth / 2;
  offsetY = window.innerHeight / 2;
  connectWS();
  requestAnimationFrame(tick);
})();
