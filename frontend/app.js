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

  function resizeCanvas() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    requestRedraw();
  }
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
    if (stroke.tool === "text") {
      const label = (pts[0] && pts[0].text) || "";
      if (!label) return;
      c.save();
      c.globalAlpha = 1;
      c.fillStyle = stroke.color || "#0b57d0";
      c.font = `600 ${Math.max(14, stroke.size || 22)}px Inter, sans-serif`;
      c.textBaseline = "alphabetic";
      c.textAlign = "left";
      c.fillText(label, pts[0].x, pts[0].y);
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
    if (looksLikePolygon(pts)) {
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
      c.drawImage(img, sx, sy, sw, sh, dest.minX, dest.minY, dest.w, dest.h);
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

  function drawGrid() {
    if (gridStyle === "blank") return;
    const topLeft = screenToWorld(0, 0);
    const bottomRight = screenToWorld(window.innerWidth, window.innerHeight);
    const startX = Math.floor(topLeft.x / GRID_SIZE) * GRID_SIZE;
    const startY = Math.floor(topLeft.y / GRID_SIZE) * GRID_SIZE;

    if (gridStyle === "dots") {
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      const r = 1.15 / scale;
      for (let x = startX; x <= bottomRight.x; x += GRID_SIZE) {
        for (let y = startY; y <= bottomRight.y; y += GRID_SIZE) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return;
    }

    ctx.lineWidth = 1 / scale;
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
        ctx.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
        ctx.strokeRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
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

  function selectionHandlePoints(b, pad) {
    const x0 = b.minX - pad, y0 = b.minY - pad, x1 = b.maxX + pad, y1 = b.maxY + pad;
    return [
      { name: "nw", x: x0, y: y0 },
      { name: "ne", x: x1, y: y0 },
      { name: "sw", x: x0, y: y1 },
      { name: "se", x: x1, y: y1 },
    ];
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f8f9fa";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
    drawGrid();

    // Marker auf eigenem Layer in voller Deckkraft, dann einmalig mit Alpha
    // draufgelegt — so entstehen keine dunklen Perlen durch Selbstueberlagerung.
    syncMarkerLayer();
    markerCtx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
    for (const stroke of boardStrokes.values()) if (stroke.tool === "marker") drawStroke(stroke, markerCtx, { alpha: 1 });
    for (const stroke of remoteInProgress.values()) if (stroke.tool === "marker") drawStroke(stroke, markerCtx, { alpha: 1 });
    if (currentStroke && currentStroke.tool === "marker") drawStroke(currentStroke, markerCtx, { alpha: 1 });
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 0.38;
    ctx.drawImage(markerLayer, 0, 0, window.innerWidth, window.innerHeight);
    ctx.restore();
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);

    for (const stroke of boardStrokes.values()) if (stroke.tool === "image") drawStroke(stroke);
    for (const stroke of boardStrokes.values()) if (stroke.tool !== "marker" && stroke.tool !== "image") drawStroke(stroke);
    for (const stroke of remoteInProgress.values()) if (stroke.tool !== "marker") drawStroke(stroke);
    if (currentStroke && currentStroke.tool && currentStroke.tool !== "marker") drawStroke(currentStroke);

    drawLassoAndSelection();
    positionInkChips();
    positionScanBoxes();

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
  let currentColor = "#1E1F22";
  let penSize = 6;
  let markerSize = 24;
  let eraserSize = 28;
  let selection = { ids: new Set(), bbox: null };
  let shapeRecognitionEnabled = true;
  let fingerDrawEnabled = false;
  let recognizeEnabled = localStorage.getItem("sofianotes-recognize") !== "0";
  let mathSolveEnabled = localStorage.getItem("sofianotes-math") !== "0";

  const toolConfigs = {
    pen: { label: "Stift", min: 1, max: 45, presets: [3, 8, 20] },
    marker: { label: "Marker", min: 6, max: 60, presets: [12, 24, 40] },
    eraser: { label: "Radierer", min: 5, max: 80, presets: [12, 28, 55] },
    select: { label: "Auswahl", min: 1, max: 20, presets: [] },
  };

  const toolPopover = document.getElementById("tool-popover");
  const popoverTitle = document.getElementById("popover-tool-title");
  const popoverSizeText = document.getElementById("popover-size-text");
  const popoverPresets = document.getElementById("popover-presets");
  const popoverPreview = document.getElementById("popover-brush-preview");
  const settingsToggleBtn = document.getElementById("btn-settings-toggle");
  const settingsPopover = document.getElementById("settings-popover");
  const zoomToggleBtn = document.getElementById("btn-zoom-toggle");
  const zoomPopover = document.getElementById("zoom-popover");
  const filenameInput = document.getElementById("canvas-filename");
  const topBar = document.getElementById("top-filename-bar");
  const undoDock = document.getElementById("undo-redo-dock");

  function activeSize() {
    if (currentTool === "eraser") return eraserSize;
    if (currentTool === "marker") return markerSize;
    return penSize;
  }

  function setActiveSize(v) {
    const n = Number(v);
    if (currentTool === "eraser") eraserSize = n;
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

  function hidePopovers() {
    toolPopover.classList.add("hidden");
    settingsPopover.classList.add("hidden");
    zoomPopover.classList.add("hidden");
    hideEraseAllMenu();
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
    popoverTitle.textContent = usingSel ? "Auswahl Stärke" : cfg.label + " Stärke";
    popoverSizeText.textContent = Math.round(size) + " px";
    sizeSlider.min = String(cfg.min);
    sizeSlider.max = String(cfg.max);
    sizeSlider.value = String(size);
    popoverPresets.innerHTML = "";
    const names = ["Dünn", "Mittel", "Dick"];
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
    const already = currentTool === tool;
    currentTool = tool;
    toolbarEl.querySelectorAll(".tool-btn[data-tool]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tool === tool);
    });
    updateEraserCursorVisibility();
    if (tool === "eraser") clearSelection();
    settingsPopover.classList.add("hidden");
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

  toolbarEl.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    let ignoreClick = false;
    btn.addEventListener("pointerup", (e) => {
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
  toolbarEl.querySelectorAll(".swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      toolbarEl.querySelectorAll(".swatch").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentColor = btn.dataset.color;
      restyleSelection({ color: currentColor });
      renderToolPopover();
    });
  });
  const customColorInput = document.getElementById("custom-color-input");
  customColorInput.addEventListener("input", (e) => {
    currentColor = e.target.value;
    toolbarEl.querySelectorAll(".swatch").forEach((b) => b.classList.remove("active"));
    restyleSelection({ color: currentColor }, "color");
    renderToolPopover();
  });
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
  });

  fingerDrawToggleEl.addEventListener("click", (e) => {
    e.stopPropagation();
    fingerDrawEnabled = !fingerDrawEnabled;
    fingerDrawToggleEl.classList.toggle("active", fingerDrawEnabled);
  });

  const recognizeToggleEl = document.getElementById("recognize-toggle");
  const mathToggleEl = document.getElementById("math-toggle");
  const kiToggleBtn = document.getElementById("btn-ki-toggle");
  function syncKiButtons() {
    if (kiToggleBtn) kiToggleBtn.classList.toggle("active", recognizeEnabled);
    if (recognizeToggleEl) recognizeToggleEl.classList.toggle("active", recognizeEnabled);
    if (mathToggleEl) mathToggleEl.classList.toggle("ki-off", !recognizeEnabled);
  }
  syncKiButtons();
  function onKiToggleClick(e) {
    e.stopPropagation();
    applyKiEnabled(!recognizeEnabled);
  }
  if (recognizeToggleEl) recognizeToggleEl.addEventListener("click", onKiToggleClick);
  if (kiToggleBtn) kiToggleBtn.addEventListener("click", onKiToggleClick);
  if (mathToggleEl) {
    mathToggleEl.classList.toggle("active", mathSolveEnabled);
    mathToggleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      mathSolveEnabled = !mathSolveEnabled;
      localStorage.setItem("sofianotes-math", mathSolveEnabled ? "1" : "0");
      mathToggleEl.classList.toggle("active", mathSolveEnabled);
      if (recognizeEnabled) scheduleRecognize();
      else renderInkOverlay();
    });
  }

  settingsToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toolPopover.classList.add("hidden");
    zoomPopover.classList.add("hidden");
    settingsPopover.classList.toggle("hidden");
  });

  document.querySelectorAll(".btn-grid-style").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      gridStyle = btn.dataset.grid;
      localStorage.setItem("sofianotes-grid", gridStyle);
      document.querySelectorAll(".btn-grid-style").forEach((b) => b.classList.toggle("active", b === btn));
      requestRedraw();
    });
  });

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
    settingsPopover.classList.add("hidden");
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
    topBar.classList.toggle("pushed", pos === "top");
    localStorage.setItem("sofianotes-dock", pos);
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
    e.preventDefault();
    e.stopPropagation();
    hidePopovers();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    const el = kind === "dock" ? toolbarEl : undoDock;
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
        const r = liftDock(el, kind);
        dockDrag.live = true;
        dockDrag.grabDX = dockDrag.lastX - r.left;
        dockDrag.grabDY = dockDrag.lastY - r.top;
        moveDockDrag(dockDrag.lastX, dockDrag.lastY);
      }, DOCK_HOLD_MS),
    };
  }

  function moveDockDrag(x, y) {
    if (!dockDrag || !dockDrag.live) return;
    const el = dockDrag.el;
    if (dockDrag.kind === "dock") {
      const edge = nearestEdge(x, y);
      applyToolbarOrient(edge);
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
    dockDrag = null;
    hideGuides();
    if (!live) return;
    if (kind === "dock") {
      setDockPosition(nearestEdge(lastX, lastY));
    } else {
      setUndoCorner(nearestCorner(lastX, lastY));
    }
    el.classList.remove("free-drag", "dragging");
    positionToolPopover();
  }

  document.getElementById("dock-drag-handle").addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    armDockDrag("dock", e);
  });
  document.getElementById("undo-drag-handle").addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    armDockDrag("undo", e);
  });
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

  document.querySelectorAll(".btn-dock-quick").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setDockPosition(btn.dataset.pos);
      settingsPopover.classList.add("hidden");
    });
  });

  document.addEventListener("pointerdown", (e) => {
    if (
      e.target.closest("#toolbar") ||
      e.target.closest("#tool-popover") ||
      e.target.closest("#erase-all-menu") ||
      e.target.closest("#undo-redo-dock") ||
      e.target.closest("#top-filename-bar")
    ) {
      return;
    }
    hidePopovers();
  });

  const savedDock = localStorage.getItem("sofianotes-dock") || "bottom";
  const savedCorner = localStorage.getItem("sofianotes-undo-corner") || "top-left";
  const savedGrid = localStorage.getItem("sofianotes-grid");
  setDockPosition(savedDock);
  setUndoCorner(savedCorner);
  if (savedGrid) {
    gridStyle = savedGrid;
    document.querySelectorAll(".btn-grid-style").forEach((b) => b.classList.toggle("active", b.dataset.grid === gridStyle));
  }
  if (filenameInput) {
    const savedName = localStorage.getItem("sofianotes-filename");
    if (savedName) filenameInput.value = savedName;
    filenameInput.addEventListener("change", () => {
      const v = filenameInput.value.trim() || "Unbenannte Skizze";
      filenameInput.value = v;
      localStorage.setItem("sofianotes-filename", v);
      document.title = v + " – sofianotes";
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
      s.endedAt = performance.now();
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
          if (s.tool === "image" && s.extra && s.extra.mediaId) ensureMedia(s.extra.mediaId);
        }
        requestRedraw();
        break;
      }
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
        scheduleRecognize();
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
  function clearAllInk() {
    const clones = Array.from(boardStrokes.values()).map(cloneStroke);
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
    const withBBox = { ...stroke, bbox: makeBBox(stroke.points), endedAt: performance.now() };
    boardStrokes.set(withBBox.id, withBBox);
    wsSend({ type: "stroke_move", stroke: serializeStroke(stroke) });
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
          const extra = direction === 1 ? m.afterExtra : m.beforeExtra;
          if (extra) s.extra = JSON.parse(JSON.stringify(extra));
          wsSend({ type: "stroke_move", stroke: serializeStroke(s) });
        }
      }
    } else if (action.type === "style") {
      for (const c of action.changes) {
        const s = boardStrokes.get(c.id);
        const st = direction === 1 ? c.after : c.before;
        if (s && st) {
          s.color = st.color;
          s.size = st.size;
          wsSend({ type: "stroke_move", stroke: serializeStroke(s) });
        }
      }
    }
    requestRedraw();
    scheduleRecognize();
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
  const exportBtn = document.getElementById("export-btn");
  exportBtn.addEventListener("click", () => {
    // GoodNotes importiert PDF; das eigene .goodnotes-ZIP ist kein natives GN-Dokument.
    window.location.href = "/api/export.pdf";
  });
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
    const rectPeri = 2 * (w + h);
    const rectFit = rectPeri > 0 ? Math.abs(pathLength - rectPeri) / rectPeri : 1;
    const circular = circleFit < 0.26 && periFit < 0.30 && rectFit > 0.10 && boxy < 0.72;

    const corners = findDominantCorners(rawPoints, diagonal, true);
    const quad = collapseToQuad(corners, diagonal);
    const hasSharpQuad = !!(quad && quad.length === 4 && corners.length >= 3 && corners.length <= 6);

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

    if (circular || (circleFit < 0.20 && periFit < 0.26 && rectFit > 0.08)) {
      const useCircle = aspectDiff < 0.18;
      const rx = useCircle ? meanR : w / 2;
      const ry = useCircle ? meanR : h / 2;
      return { type: "circle", points: makeEllipsePoints(cx, cy, rx, ry, avgPressure, 96) };
    }
    if (quad && quad.length === 4) {
      return { type: "rectangle", points: fitOrientedRect(quad, avgPressure) };
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
  let dragState = null; // {pointerId, startWorld, snapshot: Map(id -> points[])}

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
    const present = ids.filter((id) => boardStrokes.get(id));
    if (!present.length) {
      clearSelection();
      return;
    }
    selection = {
      ids: new Set(present),
      bbox: unionBBox(present.map((id) => boardStrokes.get(id).bbox)),
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
        const cfg = toolConfigs[s.tool === "text" ? "pen" : s.tool] || toolConfigs.pen;
        s.size = Math.max(cfg.min, Math.min(cfg.max, patch.size));
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
    const b = stroke.bbox || makeBBox(stroke.points || []);
    if (!pointInBBox(pt, b, r)) return false;
    if (stroke.tool === "text" || stroke.tool === "image") return true;
    const pts = stroke.points || [];
    if (pts.length === 1) return Math.hypot(pts[0].x - pt.x, pts[0].y - pt.y) <= r;
    for (let i = 1; i < pts.length; i++) {
      if (distPointToSeg(pt, pts[i - 1], pts[i]) <= r) return true;
    }
    return false;
  }

  function pickStrokeAt(world) {
    const pad = 12 / Math.max(scale, 0.25);
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
      if (stroke.tool === "image") {
        const b = stroke.bbox || makeBBox(stroke.points || []);
        const corners = [
          { x: b.minX, y: b.minY },
          { x: b.maxX, y: b.minY },
          { x: b.minX, y: b.maxY },
          { x: b.maxX, y: b.maxY },
          { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
        ];
        if (corners.some((p) => pointInPolygon(p, pts))) ids.add(stroke.id);
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

  function startSelectionDrag(pointerId, world) {
    const snapshot = new Map();
    for (const id of selection.ids) {
      const s = boardStrokes.get(id);
      if (s) snapshot.set(id, s.points.map((p) => ({ x: p.x, y: p.y, p: p.p, text: p.text })));
    }
    dragState = { pointerId, startWorld: world, snapshot, kind: "move" };
  }

  function startSelectionScale(pointerId, world, corner) {
    const snapshot = new Map();
    const extras = new Map();
    for (const id of selection.ids) {
      const s = boardStrokes.get(id);
      if (!s) continue;
      snapshot.set(id, s.points.map((p) => ({ x: p.x, y: p.y, p: p.p, text: p.text })));
      if (s.extra) extras.set(id, JSON.parse(JSON.stringify(s.extra)));
    }
    const pad = 10 / scale;
    const b = selection.bbox;
    const originMap = {
      nw: { x: b.maxX + pad, y: b.maxY + pad },
      ne: { x: b.minX - pad, y: b.maxY + pad },
      sw: { x: b.maxX + pad, y: b.minY - pad },
      se: { x: b.minX - pad, y: b.minY - pad },
    };
    dragState = {
      pointerId,
      startWorld: world,
      snapshot,
      extras,
      kind: "scale",
      corner,
      origin: originMap[corner],
    };
  }

  function updateSelectionScale(world) {
    const origin = dragState.origin;
    const s0x = dragState.startWorld.x - origin.x;
    const s0y = dragState.startWorld.y - origin.y;
    const s1x = world.x - origin.x;
    const s1y = world.y - origin.y;
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
      s.bbox = makeBBox(s.points);
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
        wsSend({ type: "stroke_move", stroke: serializeStroke(s) });
        const extra = dragState.extras && dragState.extras.get(id);
        moves.push({
          id,
          before: beforePts,
          after: s.points.map((p) => ({ ...p })),
          beforeExtra: extra || null,
          afterExtra: s.extra ? JSON.parse(JSON.stringify(s.extra)) : null,
        });
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

  function pickScaleHandle(world, bbox, pad) {
    const r = 14 / Math.max(scale, 0.25);
    for (const p of selectionHandlePoints(bbox, pad)) {
      if (Math.hypot(world.x - p.x, world.y - p.y) <= r) return p.name;
    }
    return null;
  }

  function pickCropHandle(world) {
    if (!cropState || !cropState.full) return null;
    const r = 16 / Math.max(scale, 0.25);
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
    s.bbox = makeBBox(s.points);
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

  const mediaToolbar = document.getElementById("media-toolbar");
  const importFileInput = document.getElementById("import-file");

  function syncMediaToolbar() {
    if (!mediaToolbar) return;
    const img = selectedImageStroke();
    const cropping = !!cropState;
    if (!img && !cropping) {
      mediaToolbar.classList.add("hidden");
      return;
    }
    mediaToolbar.classList.remove("hidden");
    const cropBtn = document.getElementById("btn-media-crop");
    const doneBtn = document.getElementById("btn-media-crop-done");
    const cancelBtn = document.getElementById("btn-media-crop-cancel");
    if (cropBtn) cropBtn.classList.toggle("hidden", cropping);
    if (doneBtn) doneBtn.classList.toggle("hidden", !cropping);
    if (cancelBtn) cancelBtn.classList.toggle("hidden", !cropping);
    positionMediaToolbar();
  }

  function positionMediaToolbar() {
    if (!mediaToolbar || mediaToolbar.classList.contains("hidden")) return;
    const s = selectedImageStroke() || (cropState && boardStrokes.get(cropState.strokeId));
    const b = cropState && cropState.full ? cropState.full : s && (s.bbox || imageDestRect(s));
    if (!b) return;
    const top = worldToScreen((b.minX + b.maxX) / 2, b.minY);
    mediaToolbar.style.left = Math.round(top.x) + "px";
    mediaToolbar.style.top = Math.round(top.y - 48) + "px";
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
    const resp = await fetch("/api/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
    });
    if (!resp.ok) throw new Error("upload");
    const data = await resp.json();
    if (!data || !data.id) throw new Error("upload");
    return data.id;
  }

  function placeImageStroke(mediaId, w, h, name, origin) {
    const maxW = Math.min(720, window.innerWidth * 0.62) / scale;
    const maxH = Math.min(860, window.innerHeight * 0.7) / scale;
    const fit = Math.min(maxW / w, maxH / h, 1);
    const dw = w * fit;
    const dh = h * fit;
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
    const files = Array.from(fileList || []);
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
        if (isPdf) {
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

  document.getElementById("btn-import")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hidePopovers();
    if (importFileInput) {
      importFileInput.value = "";
      importFileInput.click();
    }
  });
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
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cropState) {
      e.preventDefault();
      cancelCropMode();
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
    if (tool === "pen") armHoldTimer();
    requestRedraw();
  }

  function extendStroke(wx, wy, pressure) {
    if (!currentStroke || currentStroke.locked) return;
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
    if (currentStroke.tool === "pen") armHoldTimer();
    requestRedraw();
  }

  function coalescedEvents(e) {
    let list = [];
    if (typeof e.getCoalescedEvents === "function") {
      try {
        list = e.getCoalescedEvents();
      } catch (err) {
        list = [];
      }
    }
    if (!list || list.length === 0) return [e];
    return list;
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

  function findStruckStrokes(pts) {
    if (!looksLikeStrikeGesture(pts)) return [];
    const hit = [];
    for (const stroke of boardStrokes.values()) {
      if (strikeCrossesStroke(pts, stroke)) hit.push(stroke);
    }
    return hit;
  }

  function endStroke() {
    if (!currentStroke) return;
    clearHoldTimer();
    if (currentStroke.tool === "pen" && !currentStroke.locked) {
      const struck = findStruckStrokes(currentStroke.points);
      if (struck.length > 0) {
        wsSend({ type: "stroke_abort", strokeId: currentStroke.id });
        const clones = struck.map((s) => cloneStroke(s));
        const ids = struck.map((s) => s.id);
        for (const id of ids) {
          boardStrokes.delete(id);
          pendingErase.add(id);
        }
        wsSend({ type: "erase", strokeIds: ids });
        pendingErase.clear();
        pushUndo({ type: "erase", strokes: clones });
        currentStroke = null;
        requestRedraw();
        scheduleRecognize();
        return;
      }
    }
    if (currentStroke.unsent.length > 0) {
      wsSend({ type: "stroke_points", strokeId: currentStroke.id, points: currentStroke.unsent });
      currentStroke.unsent = [];
    }
    wsSend({ type: "stroke_end", strokeId: currentStroke.id });
    currentStroke.bbox = makeBBox(currentStroke.points);
    currentStroke.endedAt = performance.now();
    boardStrokes.set(currentStroke.id, currentStroke);
    pushUndo({ type: "add", stroke: cloneStroke(currentStroke) });
    const finishedId = currentStroke.id;
    currentStroke = null;
    selectStrokeIds([finishedId]);
    requestRedraw();
    scheduleRecognize(finishedId);
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
        if (stroke.tool === "text" || stroke.tool === "image") {
          if (sx >= b.minX && sx <= b.maxX && sy >= b.minY && sy <= b.maxY) {
            erasedThisGesture.add(stroke.id);
            erasedStrokesThisGesture.set(stroke.id, cloneStroke(stroke));
          }
          continue;
        }
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
      if (cropState) {
        const handle = pickCropHandle(world);
        if (handle) {
          cropState.pointerId = e.pointerId;
          cropState.handle = handle;
          cropState.startCrop = { ...cropState.crop };
          cropState.startWorld = world;
          return;
        }
        const full = cropState.full;
        const crop = cropState.crop;
        const rect = {
          minX: full.minX + crop.l * full.w,
          minY: full.minY + crop.t * full.h,
          maxX: full.minX + crop.r * full.w,
          maxY: full.minY + crop.b * full.h,
        };
        if (pointInBBox(world, rect, 0)) {
          cropState.pointerId = e.pointerId;
          cropState.handle = "move";
          cropState.startCrop = { ...cropState.crop };
          cropState.startWorld = world;
          return;
        }
      }
      if (selection.bbox) {
        const pad = 10 / scale;
        const handle = pickScaleHandle(world, selection.bbox, pad);
        if (handle) {
          startSelectionScale(e.pointerId, world, handle);
          return;
        }
      }
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
      currentStroke = { pointerId: e.pointerId, eraser: true, lastX: world.x, lastY: world.y, startX: e.clientX, startY: e.clientY };
      eraseSegment(world.x, world.y, world.x, world.y);
      updateEraserCursor(e.clientX, e.clientY);
    } else {
      startStroke(e.pointerId, e.pointerType, world.x, world.y, pointerPressure(e));
    }
    sendCursor(world.x, world.y, currentTool, activeSize());
  }

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount) sel.removeAllRanges();
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
  }, { passive: false });

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
        (cropState && cropState.pointerId === e.pointerId) ||
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

    if (cropState && cropState.pointerId === e.pointerId) {
      updateCropDrag(world);
      requestRedraw();
    } else if (dragState && dragState.pointerId === e.pointerId) {
      if (touchPointers.size >= 2) {
        cancelSelectionDrag();
        return;
      }
      if (dragState.kind === "scale") updateSelectionScale(world);
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
          const w = screenToWorld(ev.clientX, ev.clientY);
          extendStroke(w.x, w.y, pointerPressure(ev));
        }
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
        (cropState && cropState.pointerId === e.pointerId) ||
        lassoPointerId === e.pointerId ||
        (currentStroke && currentStroke.pointerId === e.pointerId);
      if (!wasActiveDrawTouch) return;
      // aktiver Finger-Zeichnen-Pointer: faellt durch zur gemeinsamen Abschluss-Logik unten
    } else if (panState && (panState.pointerId === undefined || panState.pointerId === e.pointerId)) {
      panState = null;
      return;
    }

    if (cropState && cropState.pointerId === e.pointerId) {
      cropState.pointerId = null;
      cropState.handle = null;
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
        } else {
          const tap =
            currentStroke.startX != null &&
            Math.hypot(e.clientX - currentStroke.startX, e.clientY - currentStroke.startY) < 18;
          if (tap && boardStrokes.size) showEraseAllMenu(e.clientX, e.clientY);
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
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest("input, textarea")) return;
    e.preventDefault();
  });
  document.addEventListener("selectstart", (e) => {
    if (e.target.closest("input, textarea")) return;
    e.preventDefault();
  });
  document.addEventListener("selectionchange", () => {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
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

  function applyKiEnabled(on) {
    recognizeEnabled = !!on;
    localStorage.setItem("sofianotes-recognize", recognizeEnabled ? "1" : "0");
    syncKiButtons();
    clearTimeout(recognizeTimer);
    recognizeTimer = null;
    recognizeAgain = false;
    recognizeWide = false;
    if (recognizeAbort) {
      recognizeAbort.abort();
      recognizeAbort = null;
    }
    recognizeBusy = false;
    if (!recognizeEnabled) {
      inkGroups = [];
      scanBoxes = [];
      renderInkOverlay();
      return;
    }
    scheduleRecognize(null, 200);
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
    if (!recognizeEnabled) return;
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

  function scheduleRecognize(focusId, delayMs) {
    if (typeof SofiaInk === "undefined") return;
    if (focusId) lastRecognizeFocus = focusId;
    clearTimeout(recognizeTimer);
    recognizeTimer = setTimeout(runRecognize, delayMs == null ? RECOGNIZE_PAUSE_MS : delayMs);
  }

  async function runRecognize() {
    if (!recognizeEnabled || currentStroke) {
      if (recognizeEnabled && currentStroke) recognizeAgain = true;
      return;
    }
    if (typeof SofiaInk === "undefined") return;
    if (recognizeBusy) {
      recognizeAgain = true;
      return;
    }
    recognizeBusy = true;
    recognizeAgain = false;
    if (recognizeAbort) recognizeAbort.abort();
    const ac = new AbortController();
    recognizeAbort = ac;
    const wordGap = recognizeWordGap();
    const now = performance.now();
    let all = [];
    let burst = [];
    let groups = [];
    try {
      all = Array.from(boardStrokes.values());
      pruneOcrCache(new Set(all.map((s) => s.id)));
      const pauseMs = recognizeWide ? WIDE_BURST_MS : RECOGNIZE_PAUSE_MS;
      const pad = recognizeWide ? 80 : 36;
      const mine = all.filter(
        (s) => s.ownerId === myClientId || s.id === lastRecognizeFocus
      );
      burst = SofiaInk.writingBurst(mine.length ? mine : all, { pauseMs, now });
      if (!burst.length && lastRecognizeFocus) {
        const focus = all.find((s) => s.id === lastRecognizeFocus);
        if (focus) burst = [focus];
      }
      const region = burst.length ? SofiaInk.contextRegion(all, burst, pad) : { strokes: [], bbox: null };
      const blocks = region.bbox
        ? [{ strokes: region.strokes, bbox: region.bbox }]
        : [];
      scanBoxes = region.bbox ? [{ bbox: region.bbox, label: "KI liest …" }] : [];
      renderInkOverlay();

      const cloudGroups = [];
      const canCloud =
        burst.length &&
        cloudOcrEnabled !== false &&
        ocrRemaining > 1 &&
        recognizeAbort === ac &&
        !ac.signal.aborted;
      if (canCloud && region.strokes.length) {
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
        const cloudIds = new Set(cloudGroups.flatMap((g) => g.strokeIds || []));
        const leftover = burst.filter((s) => !cloudIds.has(s.id));
        if (leftover.length) {
          let local = await SofiaInk.recognizeStrokes(leftover, {
            recentOnly: false,
            preferDigits: mathSolveEnabled,
            wordGap,
          });
          local = SofiaInk.stitchBlockGroups(local, blocks);
          groups = mergeInkGroups(local, cloudGroups);
        }
      } else if (burst.length) {
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
      const plausible = groups.filter((g) =>
        SofiaInk.ocrLooksPlausible(g.text, { strokes: (g.strokeIds || []).length })
      );
      const dubious = groups.filter(
        (g) => !SofiaInk.ocrLooksPlausible(g.text, { strokes: (g.strokeIds || []).length })
      );
      const emptyRead = burst.length && !groups.length;
      const shown = recognizeWide || !dubious.length ? groups : plausible;
      inkGroups = shown.filter((g) => !dismissedInk.has(inkGroupKey(g)));
      const live = new Set(shown.map(inkGroupKey));
      for (const key of Array.from(dismissedInk)) {
        if (!live.has(key)) dismissedInk.delete(key);
      }
      if (!recognizeWide && (dubious.length || emptyRead)) {
        recognizeWide = true;
        scanBoxes = region.bbox
          ? [{ bbox: region.bbox, label: "Wartet …" }]
          : (dubious.length ? dubious : blocks).map((g) => ({
              bbox: g.bbox,
              label: "Wartet …",
            }));
        renderInkOverlay();
      } else {
        recognizeWide = false;
        scanBoxes = [];
        renderInkOverlay();
      }
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
    if (!recognizeEnabled) return;
    if (recognizeAgain) scheduleRecognize(lastRecognizeFocus, RECOGNIZE_PAUSE_MS);
    else if (recognizeWide) scheduleRecognize(lastRecognizeFocus, CONTEXT_WAIT_MS);
  }

  if (recognizeEnabled && window.SofiaInk) {
    SofiaInk.loadEmnistModel("/models/emnist/model.json");
    SofiaInk.loadMemory();
  }

  // ---- boot ------------------------------------------------------
  resizeCanvas();
  offsetX = window.innerWidth / 2;
  offsetY = window.innerHeight / 2;
  connectWS();
  requestAnimationFrame(tick);
})();
