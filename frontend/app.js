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

  function selectionHandlePoints(b, pad) {
    const x0 = b.minX - pad, y0 = b.minY - pad, x1 = b.maxX + pad, y1 = b.maxY + pad;
    return [
      { name: "nw", x: x0, y: y0 },
      { name: "ne", x: x1, y: y0 },
      { name: "sw", x: x0, y: y1 },
      { name: "se", x: x1, y: y1 },
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f8f9fa";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
    drawGrid();

    for (const stroke of boardStrokes.values()) if (stroke.tool === "image") drawStroke(stroke);
    for (const stroke of remoteInProgress.values()) if (stroke.tool === "image") drawStroke(stroke);
    // Tabellen liegen wie Papier unter der Tinte, damit man direkt in die Zellen schreiben kann.
    for (const stroke of boardStrokes.values()) if (stroke.tool === "table") drawStroke(stroke);

    // Marker auf eigenem Layer in voller Deckkraft, dann einmalig mit Alpha
    // draufgelegt — so entstehen keine dunklen Perlen durch Selbstueberlagerung.
    // Nach den Bildern, damit Textmarker auf Fotos und PDFs liegt.
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

    for (const stroke of boardStrokes.values()) if (stroke.tool !== "marker" && stroke.tool !== "image" && stroke.tool !== "table") drawStroke(stroke);
    for (const stroke of remoteInProgress.values()) if (stroke.tool !== "marker" && stroke.tool !== "image") drawStroke(stroke);
    if (currentStroke && currentStroke.tool && currentStroke.tool !== "marker") drawStroke(currentStroke);

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

  function setActiveSize(v) {
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
  toolbarEl.querySelectorAll(".swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      toolbarEl.querySelectorAll(".swatch").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentColor = btn.dataset.color;
      if (textEdit) applyTextEditStyle({ color: currentColor });
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
    if (window.SofiaUpdates && window.SofiaUpdates.refreshInfo) {
      window.SofiaUpdates.refreshInfo();
    }
  }

  settingsToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (settingsBackdrop && !settingsBackdrop.classList.contains("hidden")) hideSettings();
    else openSettings();
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
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest("input, textarea, .popover, .tool-popover, .settings-modal, .settings-backdrop")) return;
    e.preventDefault();
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
    if (live) suppressDockClick = true;
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
    filenameInput.addEventListener("change", () => {
      const v = filenameInput.value.trim() || "Unbenannte Skizze";
      filenameInput.value = v;
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
    switch (msg.type) {
      case "init": {
        myClientId = msg.clientId;
        myColor = msg.color;
        if (msg.board) {
          currentBoardId = msg.board.id;
          currentBoardMeta = msg.board;
          if (filenameInput) filenameInput.value = msg.board.title || "Unbenannte Skizze";
          document.title = (msg.board.title || "sofianotes") + " – sofianotes";
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
      hideSettings();
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
  function armHoldTimer() {
    if (!shapeRecognitionEnabled) return clearHoldTimer();
    if (!currentStroke || !isHoldSnapTool(currentStroke.tool) || currentStroke.locked || currentStroke.rulerEdge) return clearHoldTimer();
    const tip = currentStroke.points[currentStroke.points.length - 1];
    if (holdAnchor && tip && Math.hypot(tip.x - holdAnchor.x, tip.y - holdAnchor.y) <= shapeParams.stillPx / scale) return;
    clearHoldTimer();
    if (!tip) return;
    holdAnchor = { x: tip.x, y: tip.y, index: currentStroke.points.length - 1 };
    holdStartedAt = performance.now();
    holdHintTimer = setTimeout(showHoldHint, HOLD_HINT_MS);
    holdTimer = setTimeout(tryShapeSnap, shapeParams.holdMs);
  }

  // Die Zitter-Punkte, die waehrend des Haltens dazukommen, gehoeren nicht zur Form -
  // sonst verfaelschen sie bei Kreisen den Mittelpunkt und die Erkennung scheitert.
  function pointsBeforeHold(points) {
    if (!holdAnchor || holdAnchor.index == null) return points;
    return points.slice(0, holdAnchor.index + 1);
  }

  function detectHoldShape(points, tool) {
    let detected = detectShape(points);
    if (!detected && tool === "marker") detected = straightenOpenStroke(points);
    return detected;
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
    const progress = Math.min(1, (performance.now() - holdStartedAt) / shapeParams.holdMs);
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
    if (!detected) {
      watchShapeMiss(currentStroke.id, lastShapeMetrics);
      return;
    }
    watchShapeSnap(currentStroke.id, detected.type === "circle" && detected.round === false ? "ellipse" : detected.type, lastShapeMetrics);
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

  function insertTable() {
    if (textEdit) commitTextEditor();
    const center = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    const k = 1 / Math.max(scale, 0.25);
    const cols = 3;
    const rows = 3;
    const W = 150 * cols * k;
    const H = 46 * rows * k;
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
      extra: { rows, cols, cw: [1, 1, 1], rh: [1, 1, 1], cells: {} },
    };
    putStroke(t);
    pushUndo({ type: "replace", before: null, after: cloneStroke(t) });
    setTool("select");
    selectStrokeIds([t.id]);
    syncSelectionToolbar();
    requestRedraw();
  }

  // Zeile/Spalte anfuegen oder die letzte entfernen. Gewichte werden dabei in absolute
  // Weltgroessen umgerechnet, damit die vorhandenen Zellen ihre Groesse behalten.
  function changeTable(kind, delta) {
    const t = selectedTable();
    if (!t) return;
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
    selectStrokeIds(Array.from(selection.ids));
    syncSelectionToolbar();
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
  function serializeEditor() {
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
            runs.push({ t: child.nodeValue.replace(/\u00a0/g, " "), ...styleOf(child) });
            any = true;
          }
        } else if (child.nodeName === "BR") {
          const parent = child.parentNode;
          const onlyChild = parent !== root && parent.childNodes.length === 1;
          if (!onlyChild) runs.push({ t: "\n" });
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

  function cancelTextEditor() {
    textEdit = null;
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
      ed.before && !ed.fromLabel && JSON.stringify(runs) === beforeRuns && ed.before.size === ed.size && ed.before.color === ed.color;
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

  function syncFormatBar() {
    if (!textFormatBar || textFormatBar.classList.contains("hidden")) return;
    const state = {
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      strikeThrough: document.queryCommandState("strikeThrough"),
      underline: document.queryCommandState("underline"),
    };
    textFormatBar.querySelectorAll("[data-cmd]").forEach((b) => b.classList.toggle("active", !!state[b.dataset.cmd]));
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
    textFormatBar.querySelectorAll("button").forEach((b) => {
      // pointer-/mousedown verhindern, sonst verliert der Editor Fokus und Markierung
      for (const type of ["pointerdown", "mousedown", "touchstart"]) {
        b.addEventListener(
          type,
          (e) => {
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
          },
          { passive: false }
        );
      }
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!textEdit) return;
        if (b.dataset.cmd) {
          restoreEditorRange();
          document.execCommand(b.dataset.cmd, false, null);
          rememberEditorRange();
        } else if (b.dataset.size) {
          const cfg = toolConfigs.text;
          const cur = textEdit.size * scale;
          const next = Math.max(cfg.min, Math.min(cfg.max, Math.round(cur * (b.dataset.size === "up" ? 1.2 : 1 / 1.2))));
          textSize = next;
          applyTextEditStyle({ size: next });
        }
        positionTextEditor();
        syncFormatBar();
      });
    });
    document.addEventListener("selectionchange", () => {
      if (!textEdit) return;
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
      if (meta && textEdit && textEdit.kind === "text" && /^[biu]$/i.test(e.key)) setTimeout(syncFormatBar, 0);
    });
    textEditorEl.addEventListener("pointerdown", (e) => e.stopPropagation());
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
    insertTable();
  });
  for (const [id, kind, delta] of [
    ["btn-tbl-row-add", "row", 1],
    ["btn-tbl-col-add", "col", 1],
    ["btn-tbl-row-del", "row", -1],
    ["btn-tbl-col-del", "col", -1],
  ]) {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", (e) => {
      e.stopPropagation();
      changeTable(kind, delta);
    });
  }

  // ---- Zoom-Fenster (wie GoodNotes) ----------------------------------------
  // Ein Rahmen auf dem Blatt wird unten gross dargestellt. Man schreibt in der grossen
  // Flaeche, die Tinte landet klein im Rahmen. Endet ein Strich im blauen Bereich rechts,
  // rueckt der Rahmen kurz nach dem Absetzen weiter; am rechten Rand geht es in die
  // naechste Zeile. Ein neuer Strich vor dem Weiterruecken bricht es ab (z.B. i-Punkt).
  const zoomPaneEl = document.getElementById("zoom-pane");
  const zoomCanvas = document.getElementById("zoom-canvas");
  const zctx = zoomCanvas ? zoomCanvas.getContext("2d") : null;
  const zoomWinBtn = document.getElementById("btn-zoom-window");
  const zoomBoxEl = document.getElementById("zoom-box");
  const ZOOM_ADVANCE_ZONE = 0.22; // rechter Anteil der Schreibflaeche, der das Weiterruecken ausloest
  const ZOOM_ADVANCE_DELAY = 550;
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
  function paneToWorld(clientX, clientY) {
    const r = zoomPaneRect();
    const k = zoomRatio();
    return { x: zoomWin.x + (clientX - r.left) / k, y: zoomWin.y + (clientY - r.top) / k };
  }

  function layoutZoomPane() {
    if (!zoomPaneEl) return;
    const tb = toolbarEl.getBoundingClientRect();
    const dockBottom = currentDock() === "bottom";
    const bottom = dockBottom ? window.innerHeight - tb.top + 10 : 12;
    const h = Math.round(Math.max(170, Math.min(320, window.innerHeight * 0.3)));
    zoomPaneEl.style.bottom = bottom + "px";
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

  // Sichtbarer Teil des Hauptblatts (oberhalb der Schreibflaeche)
  function visibleWorldArea() {
    const paneTop = zoomPaneEl ? zoomPaneEl.getBoundingClientRect().top : window.innerHeight;
    return { a: screenToWorld(0, 70), b: screenToWorld(window.innerWidth, paneTop - 10) };
  }

  function openZoomWindow() {
    if (textEdit) commitTextEditor();
    if (currentTool !== "pen" && currentTool !== "marker" && currentTool !== "eraser") setTool("pen");
    zoomPaneEl.classList.remove("hidden");
    layoutZoomPane();
    const { a, b } = visibleWorldArea();
    const left = a.x + (b.x - a.x) * 0.08;
    const right = b.x - (b.x - a.x) * 0.08;
    const w = Math.max(80, (right - left) / 3.2);
    zoomWin = { x: left, y: a.y + (b.y - a.y) * 0.18, w, left, right };
    if (zoomWinBtn) zoomWinBtn.classList.add("active");
    requestRedraw();
  }

  function closeZoomWindow() {
    clearTimeout(zoomAdvanceTimer);
    zoomAdvanceTimer = null;
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

  function moveZoomBox(nx, ny) {
    zoomWin.x = nx;
    zoomWin.y = ny;
    keepZoomBoxVisible();
    requestRedraw();
  }

  function zoomNextLine() {
    moveZoomBox(zoomWin.left, zoomWin.y + zoomBoxH());
  }
  function zoomStep(dir) {
    const step = zoomWin.w * 0.6;
    let nx = zoomWin.x + dir * step;
    if (dir > 0 && nx + zoomWin.w > zoomWin.right + zoomWin.w * 0.25) return zoomNextLine();
    if (dir < 0 && nx < zoomWin.left) {
      if (zoomWin.x <= zoomWin.left + 1) {
        // am linken Rand: zurueck ans Ende der vorigen Zeile
        return moveZoomBox(Math.max(zoomWin.left, zoomWin.right - zoomWin.w), zoomWin.y - zoomBoxH());
      }
      nx = zoomWin.left;
    }
    moveZoomBox(nx, zoomWin.y);
  }

  function scheduleZoomAdvance(stroke) {
    clearTimeout(zoomAdvanceTimer);
    zoomAdvanceTimer = null;
    if (!zoomWin || !stroke || !stroke.points || !stroke.points.length) return;
    const b = makeBBox(stroke.points);
    const zoneStart = zoomWin.x + zoomWin.w * (1 - ZOOM_ADVANCE_ZONE);
    if (b.maxX < zoneStart) return;
    zoomAdvanceTimer = setTimeout(() => {
      zoomAdvanceTimer = null;
      if (!zoomWin) return;
      // so weiterruecken, dass das Geschriebene links im Fenster noch sichtbar bleibt
      const nx = b.maxX - zoomWin.w * 0.3;
      if (nx + zoomWin.w > zoomWin.right + zoomWin.w * 0.25) zoomNextLine();
      else moveZoomBox(Math.max(zoomWin.left, nx), zoomWin.y);
    }, ZOOM_ADVANCE_DELAY);
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

  function drawZoomPane() {
    if (!zoomWin || !zctx) return;
    layoutZoomPane();
    const d = Math.max(1, window.devicePixelRatio || 1);
    const k = zoomRatio();
    const h = zoomBoxH();
    zctx.setTransform(1, 0, 0, 1, 0, 0);
    zctx.fillStyle = "#ffffff";
    zctx.fillRect(0, 0, zoomCanvas.width, zoomCanvas.height);
    zctx.setTransform(k * d, 0, 0, k * d, -zoomWin.x * k * d, -zoomWin.y * k * d);
    drawGrid(zctx, { minX: zoomWin.x, minY: zoomWin.y, maxX: zoomWin.x + zoomWin.w, maxY: zoomWin.y + h }, k);
    const inView = (st) => {
      const b = st.bbox || strokeWorldBBox(st);
      return !b || (b.maxX >= zoomWin.x && b.minX <= zoomWin.x + zoomWin.w && b.maxY >= zoomWin.y && b.minY <= zoomWin.y + h);
    };
    const all = Array.from(boardStrokes.values()).filter(inView);
    for (const st of all) if (st.tool === "image" || st.tool === "table") drawStroke(st, zctx);
    for (const st of all) if (st.tool === "marker") drawStroke(st, zctx, { alpha: 0.38 });
    for (const st of remoteInProgress.values()) if (st.tool === "marker") drawStroke(st, zctx, { alpha: 0.38 });
    if (currentStroke && currentStroke.tool === "marker") drawStroke(currentStroke, zctx, { alpha: 0.38 });
    for (const st of all) if (st.tool !== "marker" && st.tool !== "image" && st.tool !== "table") drawStroke(st, zctx);
    for (const st of remoteInProgress.values()) if (st.tool !== "marker") drawStroke(st, zctx);
    if (currentStroke && currentStroke.tool && currentStroke.tool !== "marker") drawStroke(currentStroke, zctx);
    // Weiterrueck-Bereich und Raender
    zctx.setTransform(d, 0, 0, d, 0, 0);
    const r = zoomPaneRect();
    const zoneX = r.width * (1 - ZOOM_ADVANCE_ZONE);
    zctx.fillStyle = "rgba(26,115,232,0.07)";
    zctx.fillRect(zoneX, 0, r.width - zoneX, r.height);
    zctx.strokeStyle = "rgba(26,115,232,0.35)";
    zctx.lineWidth = 1;
    zctx.setLineDash([5, 5]);
    zctx.beginPath();
    zctx.moveTo(zoneX, 0);
    zctx.lineTo(zoneX, r.height);
    zctx.stroke();
    zctx.setLineDash([]);
    for (const mx of [zoomWin.left, zoomWin.right]) {
      const px = (mx - zoomWin.x) * k;
      if (px < 0 || px > r.width) continue;
      zctx.strokeStyle = "rgba(234,67,53,0.5)";
      zctx.beginPath();
      zctx.moveTo(px, 0);
      zctx.lineTo(px, r.height);
      zctx.stroke();
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
      if (boardStrokes.has(finished.id)) scheduleZoomAdvance(finished);
    };
    zoomCanvas.addEventListener("pointerup", endZoomPointer);
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
    act("btn-zw-in", () => {
      zoomWin.w = Math.max(30, zoomWin.w * 0.8);
      requestRedraw();
    });
    act("btn-zw-out", () => {
      zoomWin.w = Math.min(zoomWin.right - zoomWin.left, zoomWin.w * 1.25);
      requestRedraw();
    });
    act("btn-zw-close", closeZoomWindow);
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
    });
    el.addEventListener("pointermove", (e) => {
      if (!zoomBoxDrag || zoomBoxDrag.pointerId !== e.pointerId || !zoomWin) return;
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
    });
    const end = (e) => {
      if (zoomBoxDrag && zoomBoxDrag.pointerId === e.pointerId) zoomBoxDrag = null;
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
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
  const ruler = { visible: false, cx: window.innerWidth / 2, cy: window.innerHeight * 0.45, angle: 0 };
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
  function rulerHit(x, y, extra = 6) {
    return ruler.visible && Math.abs(rulerLocal(x, y).across) <= RULER_HALF + extra;
  }
  // Kante (+1 = unten/rechts, -1 = oben/links), an der der Stift gerade zeichnen wuerde
  function rulerEdgeAt(x, y) {
    if (!ruler.visible) return null;
    const { across } = rulerLocal(x, y);
    if (Math.abs(across) > RULER_HALF + RULER_SNAP) return null;
    return { side: across >= 0 ? 1 : -1 };
  }
  function rulerProject(x, y, edge) {
    const { u, n } = rulerAxes();
    const { along } = rulerLocal(x, y);
    // Strichmitte knapp ausserhalb der Kante, damit die Linie am Lineal anliegt
    const half = ((currentStroke && currentStroke.size) || activeSize()) * scale * 0.5;
    const off = edge.side * (RULER_HALF + half);
    return { x: ruler.cx + n.x * off + u.x * along, y: ruler.cy + n.y * off + u.y * along };
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
    rulerGesture = { start, cx: ruler.cx, cy: ruler.cy, angle: ruler.angle };
    pinchState = null;
    panState = null;
  }
  function updateRulerGesture() {
    const ids = Array.from(rulerGesture.start.keys()).filter((id) => touchPointers.has(id));
    if (!ids.length) return;
    const a0 = rulerGesture.start.get(ids[0]);
    const a1 = touchPointers.get(ids[0]);
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
    } else {
      ruler.cx = rulerGesture.cx + (a1.x - a0.x);
      ruler.cy = rulerGesture.cy + (a1.y - a0.y);
    }
    requestRedraw();
  }

  function drawRuler() {
    if (!ruler.visible) return;
    const len = Math.hypot(window.innerWidth, window.innerHeight) * 1.2;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(ruler.cx, ruler.cy);
    ctx.rotate(ruler.angle);
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.strokeStyle = "rgba(60,64,67,0.55)";
    ctx.lineWidth = 1;
    ctx.fillRect(-len, -RULER_HALF, len * 2, RULER_HALF * 2);
    ctx.beginPath();
    ctx.moveTo(-len, -RULER_HALF);
    ctx.lineTo(len, -RULER_HALF);
    ctx.moveTo(-len, RULER_HALF);
    ctx.lineTo(len, RULER_HALF);
    ctx.stroke();
    // Skala in Papier-Massstab: 1 cm ~ 38 Welt-px (96 dpi), mm-Striche ab genug Zoom
    const cm = 37.8 * scale;
    const mm = cm / 10;
    const showMm = mm >= 4;
    const step = showMm ? mm : cm / 2;
    const n = Math.ceil(len / step);
    ctx.strokeStyle = "rgba(60,64,67,0.7)";
    ctx.fillStyle = "rgba(60,64,67,0.85)";
    ctx.font = "600 10px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.beginPath();
    for (let i = -n; i <= n; i++) {
      const x = i * step;
      const isCm = showMm ? i % 10 === 0 : i % 2 === 0;
      const isHalf = showMm ? i % 5 === 0 : false;
      const h = isCm ? 14 : isHalf ? 9 : 5;
      ctx.moveTo(x, -RULER_HALF);
      ctx.lineTo(x, -RULER_HALF + h);
      ctx.moveTo(x, RULER_HALF);
      ctx.lineTo(x, RULER_HALF - h);
    }
    ctx.stroke();
    for (let i = -n; i <= n; i++) {
      const isCm = showMm ? i % 10 === 0 : i % 2 === 0;
      if (!isCm) continue;
      const label = Math.round((i * step) / cm);
      if (label !== 0) ctx.fillText(String(label), i * step, -RULER_HALF + 26);
    }
    // Winkel in der Mitte
    // Winkel zur Waagrechten, 0-90° (wie in GoodNotes)
    let deg = Math.abs(Math.round((ruler.angle * 180) / Math.PI)) % 180;
    if (deg > 90) deg = 180 - deg;
    ctx.font = "700 13px Inter, sans-serif";
    ctx.fillStyle = "#1a73e8";
    ctx.fillText(deg + "°", 0, 6);
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
    rulerBtn.classList.toggle("active", ruler.visible);
    requestRedraw();
  });

  // ---- drawing (pointer handling with palm rejection) -------------------
  const activePointers = new Map(); // pointerId -> {type,x,y}
  const touchPointers = new Map(); // pointerId -> {x,y}
  let pinchState = null; // {initialDist, anchorWorld:{x,y}}
  let panState = null; // {lastX,lastY, pointerId|null}
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
    const originMap = {
      nw: { x: b.maxX + pad, y: b.maxY + pad },
      ne: { x: b.minX - pad, y: b.maxY + pad },
      sw: { x: b.maxX + pad, y: b.minY - pad },
      se: { x: b.minX - pad, y: b.minY - pad },
    };
    dragState = {
      pointerId,
      startWorld: world,
      kind: "scale",
      corner,
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

  function knotIndicesForStroke(stroke) {
    const pts = stroke.points || [];
    if (pts.length < 2) return pts.length === 1 ? [0] : [];
    if (pts.length <= 16) return pts.map((_, i) => i);
    const b = stroke.bbox || makeBBox(pts);
    const diag = Math.max(32, Math.hypot(b.maxX - b.minX, b.maxY - b.minY));
    const simple = rdpSimplify(pts, Math.max(5, diag * 0.04));
    const idx = [];
    const seen = new Set();
    for (const sp of simple) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - sp.x, pts[i].y - sp.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (!seen.has(best)) {
        seen.add(best);
        idx.push(best);
      }
    }
    if (!seen.has(0)) idx.unshift(0);
    if (!seen.has(pts.length - 1)) idx.push(pts.length - 1);
    idx.sort((a, b) => a - b);
    if (idx.length > 22) {
      const out = [idx[0]];
      const step = Math.ceil((idx.length - 2) / 18);
      for (let i = step; i < idx.length - 1; i += step) out.push(idx[i]);
      out.push(idx[idx.length - 1]);
      return out;
    }
    return idx;
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
      if (s.extra && s.extra.shape) continue;
      const knots = knotIndicesForStroke(s);
      for (const i of knots) {
        const p = s.points[i];
        if (!p) continue;
        out.push({ strokeId: s.id, i, x: p.x, y: p.y, knots, kind: "free" });
      }
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
    if (pasteBtn) pasteBtn.classList.toggle("hidden", cropping || !strokeClipboard.length);
    if (cropBtn) cropBtn.classList.toggle("hidden", cropping || !img);
    const table = cropping ? null : selectedTable();
    document.querySelectorAll(".tbl-btn").forEach((b) => b.classList.toggle("hidden", !table));
    const texts = cropping ? [] : selectedTextBoxes();
    document.querySelectorAll(".txt-btn").forEach((b) => {
      b.classList.toggle("hidden", !texts.length);
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
  document.getElementById("btn-paste-here")?.addEventListener("click", (e) => {
    e.stopPropagation();
    pasteClipboard();
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
      if (isObjectStroke(stroke)) continue;
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
    if (currentTool !== "select") return;
    const world = screenToWorld(e.clientX, e.clientY);
    if (selectionHitAt(world, "touch")) return;
    const hit = pickStrokeAt(world, SELECT_PAD_TOUCH_PX);
    if (hit) selectStrokeIds([hit.id]);
    else if (selection.ids.size > 0 || cropState) clearSelection();
  }

  function dispatchPrimaryDown(e) {
    const world = screenToWorld(e.clientX, e.clientY);
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
      const edge = e.pointerType === "touch" && !fingerDrawEnabled ? null : rulerEdgeAt(e.clientX, e.clientY);
      if (edge) {
        const q = rulerProject(e.clientX, e.clientY, edge);
        const w0 = screenToWorld(q.x, q.y);
        startStroke(e.pointerId, e.pointerType, w0.x, w0.y, pointerPressure(e));
        currentStroke.rulerEdge = edge;
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
    activePointers.set(e.pointerId, { type: e.pointerType, x: e.clientX, y: e.clientY });

    if (e.pointerType === "touch") {
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
        if (fingerDrawEnabled && !pinchState) {
          dispatchPrimaryDown(e);
          return;
        }
        if (!pinchState) {
          // Liegt der Stift gerade auf, ist dieser Touch der Handballen: nicht greifen, nicht tippen.
          const palm = penIsDown();
          // Auswahl laesst sich auch ohne Finger-Zeichnen mit dem Finger verschieben,
          // skalieren, drehen und zuschneiden.
          if (!palm && currentTool === "select" && !dragState && grabSelectionAt(e, world)) {
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
      mouseRulerDrag = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
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
    notePasteHoldMove(e);
    activePointers.set(e.pointerId, { type: e.pointerType, x: e.clientX, y: e.clientY });

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
          offsetX += e.clientX - panState.lastX;
          offsetY += e.clientY - panState.lastY;
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
          const q = currentStroke.rulerEdge ? rulerProject(ev.clientX, ev.clientY, currentStroke.rulerEdge) : { x: ev.clientX, y: ev.clientY };
          const w = screenToWorld(q.x, q.y);
          extendStroke(w.x, w.y, pointerPressure(ev));
        }
      }
    }

    sendCursor(world.x, world.y, currentTool, activeSize());
  });

  function endPointer(e) {
    const consumed = pasteHoldConsumed;
    clearPasteHold();
    activePointers.delete(e.pointerId);

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
        if (touchPointers.size === 0) rulerGesture = null;
        else startRulerGesture(); // mit dem verbliebenen Finger nahtlos weiterschieben
        return;
      }
      if (touchPointers.size < 2) pinchState = null;
      if (touchPointers.size === 0) panState = null;
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
      mouseRulerDrag = null;
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
        requestRedraw();
        return;
      }
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
    SofiaInk.loadEmnistModel("/models/emnist/model.json");
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
    libraryBackdrop.classList.remove("hidden");
    document.getElementById("btn-library-close").classList.toggle("hidden", !currentBoardId);
    if (!(opts && opts.fromHistory)) syncUrl(true);
    refreshLibrary();
  }

  function hideLibrary(opts) {
    libraryBackdrop.classList.add("hidden");
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

  function navigateToFolder(folderId, push = true) {
    currentFolderId = folderId || null;
    if (push) syncUrl(true);
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

  async function refreshLibrary() {
    if (!currentPersonId) return;
    const key = "lib:" + currentPersonId + ":" + (currentFolderId || "");
    const q = currentFolderId ? "&folder=" + encodeURIComponent(currentFolderId) : "";
    try {
      libraryCache = await api("/api/library?person=" + encodeURIComponent(currentPersonId) + q);
      if (window.SofiaOffline) await SofiaOffline.setKv(key, libraryCache);
    } catch (err) {
      libraryCache = (window.SofiaOffline && (await SofiaOffline.getKv(key))) || {
        personId: currentPersonId,
        folderId: currentFolderId,
        folders: [],
        boards: [],
        crumbs: [],
        allFolders: [],
      };
      setConnState("offline");
    }
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
    for (const folder of folders) {
      list.appendChild(folderCard(folder));
    }
    for (const board of boards) {
      list.appendChild(boardCard(board));
    }
    if (!folders.length && !boards.length) {
      const empty = document.createElement("div");
      empty.className = "library-empty";
      empty.textContent = searchQ ? "Nichts gefunden." : "Noch leer. Leg ein Blatt oder einen Ordner an.";
      list.appendChild(empty);
    }
    if (window.lucide) lucide.createIcons();
  }

  function iconBtn(name, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.title = title;
    b.innerHTML = `<i data-lucide="${name}"></i>`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
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

  function folderCard(folder) {
    const el = document.createElement("div");
    el.className = "library-item";
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.appendChild(libRowIcon("folder", folder.color));
    el.insertAdjacentHTML("beforeend", `<div class="lib-row-text"><strong></strong><span class="meta">Ordner</span></div>`);
    el.querySelector("strong").textContent = folder.name;
    el.addEventListener("click", () => {
      navigateToFolder(folder.id);
    });
    el.appendChild(
      starBtn(folder.starred, async () => {
        folder.starred = !folder.starred;
        await api("/api/folders/" + encodeURIComponent(folder.id) + "/star", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: folder.starred }),
        });
        refreshLibrary();
      })
    );
    const row = document.createElement("div");
    row.className = "row";
    row.appendChild(iconBtn("pencil", "Umbenennen", () => renameFolder(folder)));
    row.appendChild(iconBtn("folder-open", "Verschieben", () => openMove("folder", folder.id)));
    row.appendChild(iconBtn("trash-2", "Löschen", () => deleteFolder(folder)));
    el.appendChild(row);
    return el;
  }

  function boardCard(board) {
    const el = document.createElement("div");
    el.className = "library-item";
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    const owner = personName(board.ownerId);
    const meta = board.shared ? "Geteilt von " + owner : "Eigenes Blatt";
    el.appendChild(libRowIcon("layout-dashboard"));
    el.insertAdjacentHTML("beforeend", `<div class="lib-row-text"><strong></strong><span class="meta"></span></div>`);
    el.querySelector("strong").textContent = board.title;
    el.querySelector(".meta").textContent = meta;
    el.addEventListener("click", () => openBoard(board.id, board.title));
    el.appendChild(
      starBtn(board.starred, async () => {
        board.starred = !board.starred;
        await api("/api/boards/" + encodeURIComponent(board.id) + "/star", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: board.starred }),
        });
        refreshLibrary();
      })
    );
    const row = document.createElement("div");
    row.className = "row";
    row.appendChild(iconBtn("folder-open", "In Ordner legen", () => openMove("board", board.id)));
    if (!board.shared) {
      row.appendChild(iconBtn("share-2", "Teilen", () => openShare(board)));
      row.appendChild(iconBtn("trash-2", "Löschen", () => deleteBoard(board)));
    }
    el.appendChild(row);
    return el;
  }

  async function openBoard(id, title, opts) {
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
    currentBoardId = id;
    currentBoardMeta = { id, title, ownerId: currentPersonId, sharedWith: [] };
    if (filenameInput) filenameInput.value = title || "Unbenannte Skizze";
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
    try {
      await api("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: currentPersonId, name, parentId: currentFolderId, color }),
      });
    } catch (err) {
      const id = uuid();
      await enqueueOp({ type: "folder_create", personId: currentPersonId, name, parentId: currentFolderId, id, color });
      if (libraryCache) {
        libraryCache.folders = libraryCache.folders || [];
        libraryCache.folders.push({ id, parentId: currentFolderId, name, sortOrder: 0, color });
        libraryCache.allFolders = libraryCache.allFolders || [];
        libraryCache.allFolders.push({ id, parentId: currentFolderId, name });
      }
    }
    refreshLibrary();
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
    try {
      await api("/api/folders/" + encodeURIComponent(folder.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: currentPersonId, name, color }),
      });
    } catch (err) {
      await enqueueOp({ type: "folder_rename", personId: currentPersonId, id: folder.id, name, color });
    }
    refreshLibrary();
  }

  async function deleteFolder(folder) {
    if (!window.confirm("Ordner löschen? Blätter bleiben, nur der Ordner geht weg.")) return;
    try {
      await api("/api/folders/" + encodeURIComponent(folder.id) + "?person=" + encodeURIComponent(currentPersonId), {
        method: "DELETE",
      });
    } catch (err) {
      await enqueueOp({ type: "folder_delete", personId: currentPersonId, id: folder.id });
    }
    refreshLibrary();
  }

  async function deleteBoard(board) {
    if (!window.confirm("Dieses Blatt wirklich löschen?")) return;
    try {
      await api("/api/boards/" + encodeURIComponent(board.id) + "?person=" + encodeURIComponent(currentPersonId), {
        method: "DELETE",
      });
    } catch (err) {
      await enqueueOp({ type: "board_delete", personId: currentPersonId, id: board.id });
    }
    if (currentBoardId === board.id) {
      currentBoardId = "";
      boardStrokes.clear();
      disconnectWS();
    }
    refreshLibrary();
  }

  function openShare(board) {
    const box = document.getElementById("share-choices");
    box.innerHTML = "";
    for (const p of PEOPLE) {
      if (p.id === currentPersonId) continue;
      const on = (board.sharedWith || []).includes(p.id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = on ? "on" : "";
      b.textContent = on ? "Geteilt mit " + p.name : "Teilen mit " + p.name;
      b.addEventListener("click", async () => {
        try {
          if (on) {
            await api(
              "/api/boards/" + encodeURIComponent(board.id) + "/share/" + encodeURIComponent(p.id) + "?person=" + encodeURIComponent(currentPersonId),
              { method: "DELETE" }
            );
          } else {
            await api("/api/boards/" + encodeURIComponent(board.id) + "/share", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ personId: currentPersonId, withPersonId: p.id }),
            });
          }
        } catch (err) {
          await enqueueOp(
            on
              ? { type: "unshare", personId: currentPersonId, boardId: board.id, withPersonId: p.id }
              : { type: "share", personId: currentPersonId, boardId: board.id, withPersonId: p.id }
          );
        }
        shareBackdrop.classList.add("hidden");
        refreshLibrary();
      });
      box.appendChild(b);
    }
    shareBackdrop.classList.remove("hidden");
  }

  function openMove(kind, id) {
    const box = document.getElementById("move-choices");
    box.innerHTML = "";
    const root = document.createElement("button");
    root.type = "button";
    root.textContent = "Ganz oben (kein Ordner)";
    root.addEventListener("click", () => applyMove(kind, id, null));
    box.appendChild(root);
    const folders = (libraryCache && libraryCache.allFolders) || [];
    for (const f of folders) {
      if (kind === "folder" && f.id === id) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = f.name;
      b.addEventListener("click", () => applyMove(kind, id, f.id));
      box.appendChild(b);
    }
    moveBackdrop.classList.remove("hidden");
  }

  async function applyMove(kind, id, folderId) {
    moveBackdrop.classList.add("hidden");
    try {
      if (kind === "board") {
        await api("/api/placements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personId: currentPersonId, boardId: id, folderId }),
        });
      } else {
        await api("/api/folders/" + encodeURIComponent(id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personId: currentPersonId, parentId: folderId }),
        });
      }
    } catch (err) {
      await enqueueOp(
        kind === "board"
          ? { type: "place", personId: currentPersonId, boardId: id, folderId }
          : { type: "folder_move", personId: currentPersonId, id, parentId: folderId }
      );
    }
    refreshLibrary();
  }

  // ---- Admin: Personen + Mail-Adressen verwalten -----------------------
  const adminBackdrop = document.getElementById("admin-backdrop");
  const adminPeopleListEl = document.getElementById("admin-people-list");

  function openAdminPanel() {
    if (!isAdmin) return;
    adminBackdrop.classList.remove("hidden");
    loadAdminPeople();
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
      renameBtn.className = "danger";
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
          if (!window.confirm(`"${person.name}" wirklich löschen?`)) return;
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
      refreshLibrary();
    }
  });
  libSearchInput?.addEventListener("input", () => {
    librarySearchQuery = libSearchInput.value;
    refreshLibrary();
  });
  document.getElementById("btn-library-home")?.addEventListener("click", () => {
    if (currentFolderId && libraryCache && libraryCache.crumbs.length) {
      const prev = libraryCache.crumbs[libraryCache.crumbs.length - 1];
      navigateToFolder(prev.parentId || null);
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
  document.getElementById("lib-add-folder")?.addEventListener("click", () => {
    libAddMenu.classList.add("hidden");
    createFolder();
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

  async function toggleShareWith(board, personId, on) {
    try {
      if (on) {
        await api(
          "/api/boards/" + encodeURIComponent(board.id) + "/share/" + encodeURIComponent(personId) + "?person=" + encodeURIComponent(currentPersonId),
          { method: "DELETE" }
        );
      } else {
        await api("/api/boards/" + encodeURIComponent(board.id) + "/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personId: currentPersonId, withPersonId: personId }),
        });
      }
    } catch (err) {
      await enqueueOp(
        on
          ? { type: "unshare", personId: currentPersonId, boardId: board.id, withPersonId: personId }
          : { type: "share", personId: currentPersonId, boardId: board.id, withPersonId: personId }
      );
    }
    if (on) board.sharedWith = (board.sharedWith || []).filter((id) => id !== personId);
    else board.sharedWith = [...(board.sharedWith || []), personId];
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
      row.addEventListener("click", async (e) => {
        e.stopPropagation();
        const nowOn = (board.sharedWith || []).includes(p.id);
        await toggleShareWith(board, p.id, nowOn);
        openCanvasShareSubmenu(board);
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
