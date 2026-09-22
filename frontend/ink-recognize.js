/* sofianotes handwriting: EMNIST + TensorFlow.js, ink-on math layout, local k-NN learning. */
(function (root) {
  "use strict";

  const EMNIST_CHARS =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const SIZE = 28;
  const PAD = 4;
  const INNER = SIZE - PAD * 2 - 2;
  const MAX_MEMORY = 220;
  const KNN_K = 3;
  const KNN_MAX_DIST = 7.2;

  function hypot(dx, dy) {
    return Math.hypot(dx, dy);
  }

  function bboxOfPoints(pts) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX, minY, maxX, maxY };
  }

  function unionBBox(boxes) {
    if (!boxes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const u = { ...boxes[0] };
    for (const b of boxes.slice(1)) {
      if (b.minX < u.minX) u.minX = b.minX;
      if (b.minY < u.minY) u.minY = b.minY;
      if (b.maxX > u.maxX) u.maxX = b.maxX;
      if (b.maxY > u.maxY) u.maxY = b.maxY;
    }
    return u;
  }

  function strokePathLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return len;
  }

  function perpDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-8) return hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function countDirectionReversals(pts) {
    const dirs = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const len = hypot(dx, dy);
      if (len < 5) continue;
      dirs.push({ dx: dx / len, dy: dy / len });
    }
    let n = 0;
    for (let i = 1; i < dirs.length; i++) {
      if (dirs[i].dx * dirs[i - 1].dx + dirs[i].dy * dirs[i - 1].dy < -0.12) n++;
    }
    return n;
  }

  function looksLikeStrikeGesture(pts, pointerType) {
    const mouse = pointerType === "mouse";
    if (!pts || pts.length < (mouse ? 3 : 4)) return false;
    const pathLength = strokePathLength(pts);
    if (pathLength < (mouse ? 16 : 36)) return false;
    const start = pts[0];
    const end = pts[pts.length - 1];
    const chord = hypot(end.x - start.x, end.y - start.y);
    let maxDev = 0;
    for (const p of pts) {
      const d = perpDist(p, start, end);
      if (d > maxDev) maxDev = d;
    }
    const minChord = mouse ? 12 : 28;
    const straightRatio = mouse ? 0.58 : 0.7;
    const maxDevRatio = mouse ? 0.32 : 0.18;
    const straight =
      chord > minChord &&
      pathLength > 0 &&
      chord / pathLength > straightRatio &&
      maxDev / pathLength < maxDevRatio;
    const scribble = countDirectionReversals(pts) >= 2 && pathLength > (mouse ? 22 : 48);
    return straight || scribble;
  }

  function paintDisk(buf, cx, cy, r) {
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const x1 = Math.min(SIZE - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const y1 = Math.min(SIZE - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = hypot(x + 0.5 - cx, y + 0.5 - cy);
        const a = Math.max(0, Math.min(1, r + 0.55 - d));
        const i = y * SIZE + x;
        if (a > buf[i]) buf[i] = a;
      }
    }
  }

  function paintSegment(buf, x0, y0, x1, y1, r) {
    const dist = hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / 0.45));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      paintDisk(buf, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r);
    }
  }

  function smoothPoints(pts) {
    if (!pts || pts.length < 4) return pts || [];
    let cur = pts;
    for (let pass = 0; pass < 2; pass++) {
      const next = [cur[0]];
      for (let i = 1; i < cur.length - 1; i++) {
        next.push({
          x: cur[i - 1].x * 0.22 + cur[i].x * 0.56 + cur[i + 1].x * 0.22,
          y: cur[i - 1].y * 0.22 + cur[i].y * 0.56 + cur[i + 1].y * 0.22,
          p: cur[i].p,
        });
      }
      next.push(cur[cur.length - 1]);
      cur = next;
    }
    return cur;
  }

  function estimateSlantDeg(pointLists, w, h) {
    if (h < 12 || w / h > 0.78) return 0;
    let acc = 0;
    let wsum = 0;
    for (const pts of pointLists) {
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        const len = hypot(dx, dy);
        if (len < 3) continue;
        if (Math.abs(dy) <= Math.abs(dx) * 0.62) continue;
        acc += Math.atan2(dx, dy) * len;
        wsum += len;
      }
    }
    if (wsum < 10) return 0;
    return Math.max(-26, Math.min(26, (acc / wsum) * (180 / Math.PI)));
  }

  function rasterizeGlyph(strokes, opts) {
    const transpose = !!(opts && opts.transpose);
    const raw = [];
    for (const s of strokes) {
      const pts = smoothPoints(s.points || []);
      if (pts.length) raw.push(pts);
    }
    if (raw.length === 0) return new Float32Array(SIZE * SIZE);
    const all0 = [];
    for (const pts of raw) for (const p of pts) all0.push(p);
    const b0 = bboxOfPoints(all0);
    const w0 = Math.max(1, b0.maxX - b0.minX);
    const h0 = Math.max(1, b0.maxY - b0.minY);
    const slant = estimateSlantDeg(raw, w0, h0);
    const rad = (-slant * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const ox = (b0.minX + b0.maxX) / 2;
    const oy = (b0.minY + b0.maxY) / 2;
    const rotated =
      Math.abs(slant) < 3
        ? raw
        : raw.map((pts) =>
            pts.map((p) => ({
              x: ox + (p.x - ox) * cos - (p.y - oy) * sin,
              y: oy + (p.x - ox) * sin + (p.y - oy) * cos,
              p: p.p,
            }))
          );
    const all = [];
    for (const pts of rotated) for (const p of pts) all.push(p);
    const b = bboxOfPoints(all);
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const scale = INNER / Math.max(w, h);
    const mass = { x: 0, y: 0, n: 0 };
    for (const p of all) {
      mass.x += p.x;
      mass.y += p.y;
      mass.n++;
    }
    const bboxCx = (b.minX + b.maxX) / 2;
    const bboxCy = (b.minY + b.maxY) / 2;
    const cx = mass.n ? bboxCx * 0.35 + (mass.x / mass.n) * 0.65 : bboxCx;
    const cy = mass.n ? bboxCy * 0.35 + (mass.y / mass.n) * 0.65 : bboxCy;
    const toX = (x) => SIZE / 2 + (x - cx) * scale;
    const toY = (y) => SIZE / 2 + (y - cy) * scale;
    const r = 2.35;
    const buf = new Float32Array(SIZE * SIZE);
    for (const pts of rotated) {
      if (pts.length === 0) continue;
      if (pts.length === 1) {
        paintDisk(buf, toX(pts[0].x), toY(pts[0].y), r);
        continue;
      }
      for (let i = 1; i < pts.length; i++) {
        paintSegment(buf, toX(pts[i - 1].x), toY(pts[i - 1].y), toX(pts[i].x), toY(pts[i].y), r);
      }
    }
    if (!transpose) return buf;
    const out = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        out[x * SIZE + y] = buf[y * SIZE + x];
      }
    }
    return out;
  }

  function euclid(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }

  function knnPredict(pixels, examples, k) {
    if (!examples || examples.length === 0) return null;
    const kk = k || KNN_K;
    const scored = examples.map((ex) => ({
      label: ex.label,
      dist: euclid(pixels, ex.pixels),
    }));
    scored.sort((a, b) => a.dist - b.dist);
    const nearest = scored.slice(0, Math.min(kk, scored.length));
    if (nearest[0].dist > KNN_MAX_DIST) return null;
    const votes = new Map();
    for (const n of nearest) {
      const w = 1 / (0.15 + n.dist);
      votes.set(n.label, (votes.get(n.label) || 0) + w);
    }
    let best = nearest[0].label;
    let bestW = -1;
    for (const [lab, w] of votes) {
      if (w > bestW) {
        bestW = w;
        best = lab;
      }
    }
    const conf = Math.max(0.35, Math.min(0.99, 1 - nearest[0].dist / (KNN_MAX_DIST + 2)));
    return { char: best, confidence: conf, source: "memory" };
  }

  function isLikelyHandwriting(stroke) {
    if (!stroke || stroke.tool !== "pen") return false;
    const pts = stroke.points || [];
    if (pts.length === 0) return false;
    const b = stroke.bbox || bboxOfPoints(pts);
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (w > 260 && h > 180) return false;
    const path = strokePathLength(pts);
    if (path > 720 && w > 200 && h > 150) return false;
    return true;
  }

  function glyphStats(strokes) {
    const boxes = strokes.map((s) => s.bbox || bboxOfPoints(s.points || []));
    const bbox = unionBBox(boxes);
    const w = Math.max(0.5, bbox.maxX - bbox.minX);
    const h = Math.max(0.5, bbox.maxY - bbox.minY);
    let path = 0;
    let reversals = 0;
    for (const s of strokes) {
      path += strokePathLength(s.points || []);
      reversals += countDirectionReversals(s.points || []);
    }
    const start = strokes[0].points[0];
    const lastStroke = strokes[strokes.length - 1];
    const end = lastStroke.points[lastStroke.points.length - 1];
    const chord = hypot(end.x - start.x, end.y - start.y);
    let maxDev = 0;
    const a = { x: bbox.minX, y: (bbox.minY + bbox.maxY) / 2 };
    const b = { x: bbox.maxX, y: a.y };
    for (const s of strokes) {
      for (const p of s.points || []) {
        const d = perpDist(p, a, b);
        if (d > maxDev) maxDev = d;
      }
    }
    return { bbox, w, h, path, reversals, chord, maxDev, aspect: w / h };
  }

  function nearlyHorizontal(strokes, stats) {
    const { w, h, path, maxDev } = stats;
    if (w < 8) return false;
    if (h > w * 0.72 && h > 18) return false;
    if (path > 0 && maxDev / Math.max(path, w) > 0.46) return false;
    return h < 26 || h / w < 0.6;
  }

  function nearlyVertical(stats) {
    return stats.h > 10 && stats.w / stats.h < 0.5;
  }

  function sampleBilinear(buf, x, y) {
    if (x < 0 || y < 0 || x >= SIZE - 1 || y >= SIZE - 1) return 0;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const a = buf[y0 * SIZE + x0];
    const b = buf[y0 * SIZE + x0 + 1];
    const c = buf[(y0 + 1) * SIZE + x0];
    const d = buf[(y0 + 1) * SIZE + x0 + 1];
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  function rotatePixels(src, deg) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const out = new Float32Array(SIZE * SIZE);
    const c = (SIZE - 1) / 2;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const dx = x - c;
        const dy = y - c;
        const sx = cos * dx + sin * dy + c;
        const sy = -sin * dx + cos * dy + c;
        out[y * SIZE + x] = sampleBilinear(src, sx, sy);
      }
    }
    return out;
  }

  function shiftPixels(src, dx, dy) {
    const out = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        out[y * SIZE + x] = sampleBilinear(src, x - dx, y - dy);
      }
    }
    return out;
  }

  function looksLikeOne(pts, st) {
    if (!pts || pts.length < 2 || st.h < 14) return false;
    if (st.w > st.h * 0.82) return false;
    const start = pts[0];
    const end = pts[pts.length - 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const chord = hypot(dx, dy);
    if (chord < 12) return false;
    const fromVert = Math.abs(Math.atan2(dx, dy));
    const thin = st.w / st.h < 0.48;
    const maxTilt = ((thin ? 42 : 38) * Math.PI) / 180;
    if (fromVert > maxTilt) return false;
    if (st.path / chord > 1.85) return false;
    const mid = pts[Math.floor(pts.length / 2)];
    const bulge = Math.abs(mid.x - (start.x + end.x) / 2);
    if (bulge > Math.max(5, st.w * 0.32) && st.w / st.h > 0.2) return false;
    return true;
  }

  function looksLikeSlash(pts, st) {
    if (!pts || pts.length < 2) return false;
    if (st.w / st.h < 0.5) return false;
    const start = pts[0];
    const end = pts[pts.length - 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const chord = hypot(dx, dy);
    if (chord < 16 || st.path <= 0) return false;
    if (chord / st.path < 0.7) return false;
    const fromVert = Math.abs(Math.atan2(dx, dy));
    return fromVert > (40 * Math.PI) / 180 && fromVert < (58 * Math.PI) / 180;
  }

  function looksLikeSqrt(pts, st) {
    if (!pts || pts.length < 6) return false;
    if (st.h < 12 || st.w < 14) return false;
    let minI = 0;
    let minY = pts[0].y;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].y > minY) {
        minY = pts[i].y;
        minI = i;
      }
    }
    if (minI < 1 || minI > pts.length * 0.58) return false;
    const start = pts[0];
    const valley = pts[minI];
    const end = pts[pts.length - 1];
    if (valley.x < start.x - 6) return false;
    if (end.x < valley.x + 8) return false;
    if (end.x - valley.x < valley.x - start.x + 4) return false;
    if (start.y > valley.y - 5) return false;
    if (end.y > valley.y - st.h * 0.22) return false;
    return true;
  }

  function looksLikeParen(pts, st) {
    if (!pts || pts.length < 5) return null;
    if (st.h < 16 || st.w / st.h > 0.72 || st.w / st.h < 0.16) return null;
    const start = pts[0];
    const end = pts[pts.length - 1];
    const mid = pts[Math.floor(pts.length / 2)];
    const bulge = Math.abs(mid.x - (start.x + end.x) / 2);
    if (bulge < Math.max(3.5, st.w * 0.22)) return null;
    const leftOpen = mid.x < start.x - 2 && mid.x < end.x - 2;
    const rightOpen = mid.x > start.x + 2 && mid.x > end.x + 2;
    if (leftOpen && !rightOpen) return "(";
    if (rightOpen && !leftOpen) return ")";
    return null;
  }

  function looksLikePercent(strokes) {
    if (!strokes || strokes.length !== 3) return false;
    const parts = strokes.map((s) => ({ s, st: glyphStats([s]) }));
    let slash = -1;
    for (let i = 0; i < parts.length; i++) {
      if (looksLikeSlash(parts[i].s.points, parts[i].st)) {
        slash = i;
        break;
      }
    }
    if (slash < 0) return false;
    const dots = parts.filter((_, i) => i !== slash);
    if (dots.length !== 2) return false;
    const slashSt = parts[slash].st;
    return dots.every((d) => d.st.h < slashSt.h * 0.72 && d.st.w < slashSt.w * 1.35 && d.st.h < 22);
  }

  function detectOperator(glyph) {
    const strokes = glyph.strokes;
    const st = glyphStats(strokes);
    glyph.stats = st;
    const { w, h, path, aspect } = st;

    if (w < 11 && h < 11 && path < 22) {
      return { char: ".", confidence: 0.84, source: "geom" };
    }

    if (looksLikePercent(strokes)) {
      return { char: "%", confidence: 0.86, source: "geom" };
    }

    if (strokes.length === 2) {
      const a = glyphStats([strokes[0]]);
      const b = glyphStats([strokes[1]]);
      const ha = nearlyHorizontal([strokes[0]], a);
      const hb = nearlyHorizontal([strokes[1]], b);
      if (ha && hb) {
        const gap = Math.abs((a.bbox.minY + a.bbox.maxY) / 2 - (b.bbox.minY + b.bbox.maxY) / 2);
        const xo = xOverlapRatio(a.bbox, b.bbox);
        if (xo > 0.35 && gap > 2 && gap < Math.max(a.w, b.w, 16) * 1.2) {
          return { char: "=", confidence: 0.9, source: "geom" };
        }
      }
      const va = nearlyVertical(a);
      const vb = nearlyVertical(b);
      const crosses =
        a.bbox.minX < b.bbox.maxX &&
        b.bbox.minX < a.bbox.maxX &&
        a.bbox.minY < b.bbox.maxY &&
        b.bbox.minY < a.bbox.maxY;
      if (((ha && vb) || (hb && va)) && crosses) {
        return { char: "+", confidence: 0.88, source: "geom" };
      }
      const diag =
        Math.abs(a.aspect - 1) < 0.85 &&
        Math.abs(b.aspect - 1) < 0.85 &&
        crosses &&
        a.path > a.w * 0.7 &&
        b.path > b.w * 0.7;
      if (diag && !ha && !hb) {
        return { char: "×", confidence: 0.8, source: "geom" };
      }
    }

    if (strokes.length === 1) {
      const pts = strokes[0].points;
      if (looksLikeSqrt(pts, st)) {
        return { char: "√", confidence: 0.86, source: "geom" };
      }
      const paren = looksLikeParen(pts, st);
      if (paren) {
        return { char: paren, confidence: 0.78, source: "geom" };
      }
    }

    if (nearlyHorizontal(strokes, st) && strokes.length === 1) {
      return { char: "-", confidence: 0.86, source: "geom", fractionBar: w > 22 };
    }

    if (strokes.length === 1) {
      const pts = strokes[0].points;
      if (looksLikeOne(pts, st)) {
        return { char: "1", confidence: 0.72, source: "geom" };
      }
      if (looksLikeSlash(pts, st)) {
        const fromVert = Math.abs(Math.atan2(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y));
        const clear = fromVert > (44 * Math.PI) / 180 && st.w / st.h > 0.7;
        return { char: "/", confidence: clear ? 0.84 : 0.76, source: "geom" };
      }
    }
    return null;
  }

  function trustGeom(geom) {
    if (!geom || !geom.char) return false;
    if (geom.confidence >= 0.8 && "-+=/.√%π".includes(geom.char)) return true;
    if (geom.confidence >= 0.74 && "()√".includes(geom.char)) return true;
    return false;
  }

  function boxesOverlap(a, b, pad) {
    return !(
      a.maxX + pad < b.minX ||
      b.maxX + pad < a.minX ||
      a.maxY + pad < b.minY ||
      b.maxY + pad < a.minY
    );
  }

  function xOverlapRatio(a, b) {
    const lo = Math.max(a.minX, b.minX);
    const hi = Math.min(a.maxX, b.maxX);
    const ov = Math.max(0, hi - lo);
    const minW = Math.max(1, Math.min(a.maxX - a.minX, b.maxX - b.minX));
    return ov / minW;
  }

  const DEFAULT_WORD_GAP = 76;

  function clusterGlyphs(strokes, opts) {
    const ink = strokes.filter(isLikelyHandwriting).map((s) => {
      const bbox = s.bbox || bboxOfPoints(s.points || []);
      return { ...s, bbox };
    });
    if (ink.length === 0) return [];

    const wordGap = Math.max(36, (opts && opts.wordGap) || DEFAULT_WORD_GAP);
    const heights = ink.map((s) => Math.max(4, s.bbox.maxY - s.bbox.minY)).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)] || 24;
    const lineGap = Math.max(18, medianH * 0.85);

    const remaining = ink.slice().sort((a, b) => (a.bbox.minY + a.bbox.maxY) / 2 - (b.bbox.minY + b.bbox.maxY) / 2);
    const lines = [];
    for (const s of remaining) {
      const cy = (s.bbox.minY + s.bbox.maxY) / 2;
      let placed = false;
      for (const line of lines) {
        if (Math.abs(cy - line.cy) <= lineGap) {
          line.strokes.push(s);
          line.cy = line.cy * 0.7 + cy * 0.3;
          placed = true;
          break;
        }
      }
      if (!placed) lines.push({ cy, strokes: [s] });
    }

    const groups = [];
    for (const line of lines) {
      const items = line.strokes.slice().sort((a, b) => a.bbox.minX - b.bbox.minX);
      const used = new Set();
      const glyphs = [];
      for (let i = 0; i < items.length; i++) {
        if (used.has(i)) continue;
        const member = [items[i]];
        used.add(i);
        let changed = true;
        while (changed) {
          changed = false;
          const box = unionBBox(member.map((m) => m.bbox));
          const pad = Math.max(3, medianH * 0.1);
          for (let j = 0; j < items.length; j++) {
            if (used.has(j)) continue;
            const b = items[j].bbox;
            const xo = xOverlapRatio(box, b);
            const gapX = Math.max(0, Math.max(box.minX, b.minX) - Math.min(box.maxX, b.maxX));
            const sameColumn = xo > 0.38;
            const stackedDot = xo > 0.18 && gapX < medianH * 0.06;
            const closeY = boxesOverlap(
              { minX: box.minX, maxX: box.maxX, minY: box.minY - pad, maxY: box.maxY + pad },
              b,
              0
            );
            const boxH = Math.max(1, box.maxY - box.minY);
            const bH = Math.max(1, b.maxY - b.minY);
            const vGap = Math.max(0, Math.max(box.minY, b.minY) - Math.min(box.maxY, b.maxY));
            const stackedBars =
              xo > 0.4 &&
              vGap > 1 &&
              vGap < Math.max(18, medianH * 0.55) &&
              bH < medianH * 0.42 &&
              boxH < medianH * 0.55;
            const accessory =
              (bH < medianH * 0.32 && boxH > bH * 1.35) || (boxH < medianH * 0.32 && bH > boxH * 1.35);
            const contained =
              accessory &&
              ((b.minX >= box.minX - 8 && b.maxX <= box.maxX + 8) ||
                (box.minX >= b.minX - 8 && box.maxX <= b.maxX + 8));
            if ((sameColumn || stackedDot || stackedBars || contained) && (closeY || stackedBars)) {
              member.push(items[j]);
              used.add(j);
              changed = true;
            }
          }
        }
        glyphs.push({
          strokes: member,
          bbox: unionBBox(member.map((m) => m.bbox)),
        });
      }
      glyphs.sort((a, b) => a.bbox.minX - b.bbox.minX);
      let bucket = [];
      const flush = () => {
        if (!bucket.length) return;
        groups.push({
          bbox: unionBBox(bucket.map((g) => g.bbox)),
          glyphs: bucket,
        });
        bucket = [];
      };
      for (const g of glyphs) {
        if (bucket.length) {
          const prev = bucket[bucket.length - 1];
          const gap = g.bbox.minX - prev.bbox.maxX;
          if (gap > wordGap) flush();
        }
        bucket.push(g);
      }
      flush();
    }
    return groups;
  }

  function writingBurst(strokes, opts) {
    const pauseMs = (opts && opts.pauseMs) || 2200;
    const now = (opts && opts.now) || (typeof performance !== "undefined" ? performance.now() : Date.now());
    const ink = (strokes || [])
      .filter(isLikelyHandwriting)
      .filter((s) => s.endedAt && s.endedAt <= now)
      .slice()
      .sort((a, b) => a.endedAt - b.endedAt);
    if (!ink.length) return [];
    const last = ink[ink.length - 1];
    if (now - last.endedAt > 30000) return [];
    const burst = [last];
    for (let i = ink.length - 2; i >= 0; i--) {
      if (ink[i + 1].endedAt - ink[i].endedAt > pauseMs) break;
      burst.push(ink[i]);
    }
    burst.reverse();
    return burst;
  }

  function boxGapXY(a, b) {
    const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
    const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
    return { dx, dy };
  }

  function clusterBlocks(strokes, gap) {
    const ink = (strokes || [])
      .filter(isLikelyHandwriting)
      .map((s) => ({ ...s, bbox: s.bbox || bboxOfPoints(s.points || []) }));
    if (!ink.length) return [];
    const lim = Math.max(36, gap || DEFAULT_WORD_GAP);
    const parent = ink.map((_, i) => i);
    const find = (i) => {
      if (parent[i] !== i) parent[i] = find(parent[i]);
      return parent[i];
    };
    const unite = (i, j) => {
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[a] = b;
    };
    for (let i = 0; i < ink.length; i++) {
      for (let j = i + 1; j < ink.length; j++) {
        const g = boxGapXY(ink[i].bbox, ink[j].bbox);
        if (g.dx <= lim && g.dy <= lim) unite(i, j);
      }
    }
    const buckets = new Map();
    ink.forEach((s, i) => {
      const p = find(i);
      if (!buckets.has(p)) buckets.set(p, []);
      buckets.get(p).push(s);
    });
    return Array.from(buckets.values()).map((member) => ({
      strokes: member,
      bbox: unionBBox(member.map((m) => m.bbox)),
    }));
  }

  const MATH_CONFUSIONS = {
    O: "0",
    o: "0",
    D: "0",
    Q: "0",
    I: "1",
    l: "1",
    i: "1",
    "|": "1",
    Z: "2",
    z: "2",
    S: "5",
    s: "5",
    G: "6",
    g: "9",
    q: "9",
    B: "8",
    x: "×",
    X: "×",
  };

  const LETTER_TO_DIGIT = {
    O: 0,
    o: 0,
    D: 0,
    Q: 0,
    I: 1,
    l: 1,
    i: 1,
    "|": 1,
    Z: 2,
    z: 2,
    S: 5,
    s: 5,
    G: 6,
    B: 8,
    g: 9,
    q: 9,
  };

  function digitScores(probs) {
    const d = new Float64Array(10);
    for (let i = 0; i < 10; i++) d[i] = probs[i] || 0;
    for (let i = 10; i < probs.length; i++) {
      const mapped = LETTER_TO_DIGIT[EMNIST_CHARS[i]];
      if (mapped != null) d[mapped] += (probs[i] || 0) * 0.9;
    }
    return d;
  }

  function pickFromProbs(probs, preferDigits) {
    if (preferDigits) {
      const d = digitScores(probs);
      let bestI = 0;
      let bestV = -1;
      for (let i = 0; i < 10; i++) {
        if (d[i] > bestV) {
          bestV = d[i];
          bestI = i;
        }
      }
      const alts = [];
      const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort((a, b) => d[b] - d[a]);
      for (let i = 0; i < 4; i++) {
        alts.push({ char: String(order[i]), confidence: d[order[i]], source: "cnn" });
      }
      return { char: String(bestI), confidence: Math.min(0.99, bestV), source: "cnn", alts };
    }
    const top = topFromProbs(probs, 4);
    return top[0] ? { ...top[0], alts: top } : null;
  }

  const DIGIT_TO_LETTER = {
    "0": "O",
    "1": "l",
    "2": "Z",
    "5": "S",
    "6": "G",
    "8": "B",
    "9": "g",
  };

  function biasMathChar(char, alts, mathish) {
    if (!mathish) return char;
    if (MATH_CONFUSIONS[char]) return MATH_CONFUSIONS[char];
    return char;
  }

  function applyWordContext(glyphs) {
    if (!glyphs || glyphs.length < 2) return glyphs;
    let letters = 0;
    let digits = 0;
    let ops = 0;
    for (const g of glyphs) {
      const ch = g.char || "";
      if (/[+\-*/=√^%×]/.test(ch)) ops++;
      else if (/[A-Za-zÄÖÜäöüß]/.test(ch)) letters++;
      else if (/[0-9]/.test(ch)) digits++;
    }
    if (ops) {
      for (const g of glyphs) {
        if (g.source === "geom" && g.op && trustGeom(g.op)) continue;
        if (MATH_CONFUSIONS[g.char]) g.char = MATH_CONFUSIONS[g.char];
      }
      return glyphs;
    }
    if (letters >= digits && letters >= 1) {
      for (const g of glyphs) {
        if (g.source === "geom" && g.op && trustGeom(g.op)) continue;
        const mapped = DIGIT_TO_LETTER[g.char];
        if (!mapped) continue;
        const alts = g.alts || [];
        if (alts.includes(mapped) || letters >= 2) g.char = mapped;
      }
    }
    return glyphs;
  }

  function topFromProbs(probs, n) {
    const idx = [];
    for (let i = 0; i < probs.length; i++) idx.push(i);
    idx.sort((a, b) => probs[b] - probs[a]);
    const out = [];
    for (let i = 0; i < Math.min(n || 3, idx.length); i++) {
      out.push({
        char: EMNIST_CHARS[idx[i]] || "?",
        confidence: probs[idx[i]],
        source: "cnn",
      });
    }
    return out;
  }

  function tokenizeMath(src) {
    const s = String(src)
      .replace(/×/g, "*")
      .replace(/÷/g, "/")
      .replace(/·/g, "*")
      .replace(/—/g, "/")
      .replace(/sqrt/gi, "√")
      .replace(/pi/gi, "π")
      .replace(/\s+/g, "")
      .replace(/=+$/g, "")
      .replace(/(\d)[xX](?=\d|\(|√|π)/g, "$1*")
      .replace(/(\d|π|\))(?=√|π|\()/g, "$1*")
      .replace(/(\d)\(/g, "$1*(")
      .replace(/\)(\d)/g, ")*$1")
      .replace(/\)\(/g, ")*(");
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if ("+-*/^()√π%".includes(c)) {
        tokens.push({ t: c });
        i++;
        continue;
      }
      if (c >= "0" && c <= "9") {
        let n = c;
        i++;
        while (i < s.length && ((s[i] >= "0" && s[i] <= "9") || s[i] === ".")) {
          n += s[i++];
        }
        const v = Number(n);
        if (!Number.isFinite(v)) throw new Error("bad number");
        tokens.push({ t: "n", v });
        continue;
      }
      throw new Error("bad token " + c);
    }
    return tokens;
  }

  function parseMath(src) {
    const tokens = tokenizeMath(src);
    let i = 0;
    const peek = () => tokens[i];
    const eat = (t) => {
      if (!peek() || peek().t !== t) throw new Error("expected " + t);
      i++;
    };

    function parsePrimary() {
      const tok = peek();
      if (!tok) throw new Error("eof");
      if (tok.t === "n") {
        i++;
        let v = tok.v;
        if (peek() && peek().t === "%") {
          eat("%");
          v /= 100;
        }
        return v;
      }
      if (tok.t === "π") {
        eat("π");
        return Math.PI;
      }
      if (tok.t === "√") {
        eat("√");
        const inner = parsePow();
        if (inner < 0) throw new Error("sqrt");
        return Math.sqrt(inner);
      }
      if (tok.t === "(") {
        eat("(");
        const v = parseAdd();
        eat(")");
        if (peek() && peek().t === "%") {
          eat("%");
          return v / 100;
        }
        return v;
      }
      if (tok.t === "-") {
        eat("-");
        return -parsePow();
      }
      if (tok.t === "+") {
        eat("+");
        return parsePow();
      }
      throw new Error("bad primary");
    }

    function parsePow() {
      let left = parsePrimary();
      while (peek() && peek().t === "^") {
        eat("^");
        const right = parsePow();
        if (Math.abs(right) > 12) throw new Error("exp");
        left = Math.pow(left, right);
      }
      return left;
    }

    function parseMul() {
      let left = parsePow();
      while (peek() && (peek().t === "*" || peek().t === "/")) {
        const op = peek().t;
        i++;
        const right = parsePow();
        left = op === "*" ? left * right : left / right;
      }
      return left;
    }

    function parseAdd() {
      let left = parseMul();
      while (peek() && (peek().t === "+" || peek().t === "-")) {
        const op = peek().t;
        i++;
        const right = parseMul();
        left = op === "+" ? left + right : left - right;
      }
      return left;
    }

    const value = parseAdd();
    if (i !== tokens.length) throw new Error("trailing");
    if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error("range");
    return value;
  }

  function looksLikeMath(text) {
    if (!text) return false;
    if (!/[0-9π]/.test(text) && !/√/.test(text)) return false;
    const cleaned = text.replace(/[×÷—]/g, "*");
    if (/[A-WYZa-wyz]/.test(cleaned)) return false;
    return /[+\-*/^=xX√π%()]/.test(cleaned);
  }

  function formatNumber(n) {
    if (Number.isInteger(n)) return String(n);
    const s = n.toFixed(6).replace(/\.?0+$/, "");
    return s;
  }

  function solveMath(text) {
    if (!looksLikeMath(text)) return null;
    try {
      const value = parseMath(text);
      return { value, text: formatNumber(value) };
    } catch (_err) {
      return null;
    }
  }

  function solveFromBurst(text) {
    if (!text) return null;
    const direct = solveMath(text);
    if (direct) return direct;
    const parts = String(text).split(/\s+/);
    let last = null;
    for (const p of parts) {
      const hit = solveMath(p);
      if (hit) last = hit;
    }
    const m = String(text).match(/[0-9√π(][0-9+\-*/=√π%().^x×]*[0-9π)]=?/);
    if (m) {
      const hit = solveMath(m[0]);
      if (hit) last = hit;
    }
    return last;
  }

  function splitGlyphLines(glyphs) {
    if (!glyphs.length) return [];
    const heights = glyphs.map((g) => Math.max(4, (g.bbox.maxY || 0) - (g.bbox.minY || 0))).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)] || 24;
    const lineGap = Math.max(14, medianH * 0.62);
    const items = glyphs.slice().sort((a, b) => {
      const ay = (a.bbox.minY + a.bbox.maxY) / 2;
      const by = (b.bbox.minY + b.bbox.maxY) / 2;
      return ay - by;
    });
    const lines = [];
    for (const g of items) {
      const cy = (g.bbox.minY + g.bbox.maxY) / 2;
      let hit = null;
      for (const line of lines) {
        if (Math.abs(cy - line.cy) <= lineGap) {
          hit = line;
          break;
        }
      }
      if (!hit) {
        hit = { cy, glyphs: [] };
        lines.push(hit);
      }
      hit.glyphs.push(g);
      hit.cy = hit.cy * 0.65 + cy * 0.35;
    }
    lines.sort((a, b) => a.cy - b.cy);
    for (const line of lines) {
      line.glyphs.sort((a, b) => a.bbox.minX - b.bbox.minX);
    }
    return lines;
  }

  function pieceTextLTR(list) {
    if (!list.length) return "";
    const heights = list.map((g) => Math.max(4, g.bbox.maxY - g.bbox.minY));
    const medianH = heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)] || 24;
    let out = "";
    let prev = null;
    for (const g of list) {
      const ch = g.char || "?";
      if (prev) {
        const prevH = Math.max(6, prev.bbox.maxY - prev.bbox.minY);
        const gH = Math.max(4, g.bbox.maxY - g.bbox.minY);
        const gCy = (g.bbox.minY + g.bbox.maxY) / 2;
        const pCy = (prev.bbox.minY + prev.bbox.maxY) / 2;
        const gap = g.bbox.minX - prev.bbox.maxX;
        if (gCy < pCy - prevH * 0.32 && gH < prevH * 0.78 && gap < prevH * 0.55) {
          out += "^";
        } else if (gap > medianH * 0.32) {
          const mathPair = /^[0-9+\-×*/=√π%().,^]$/.test(prev.char || "") && /^[0-9+\-×*/=√π%().,^]$/.test(ch);
          if (!mathPair) out += " ";
        }
      }
      out += ch;
      prev = g;
    }
    return out;
  }

  function lineTextsAreMath(texts) {
    return texts.every((t) => looksLikeMath(t) || /^[+\-×*/=√π%()0-9.,\s]+$/.test(t));
  }

  function coalesceEqualsGlyphs(glyphs) {
    const sorted = glyphs.slice().sort((a, b) => a.bbox.minX - b.bbox.minX);
    const out = [];
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (
        b &&
        (a.char === "-" || a.char === "—") &&
        (b.char === "-" || b.char === "—") &&
        !(a.op && a.op.fractionBar) &&
        !(b.op && b.op.fractionBar)
      ) {
        const xo = xOverlapRatio(a.bbox, b.bbox);
        const vGap = Math.max(
          0,
          Math.max(a.bbox.minY, b.bbox.minY) - Math.min(a.bbox.maxY, b.bbox.maxY)
        );
        const maxW = Math.max(a.bbox.maxX - a.bbox.minX, b.bbox.maxX - b.bbox.minX, 12);
        if (xo > 0.38 && vGap < maxW * 1.15) {
          out.push({
            ...a,
            char: "=",
            bbox: unionBBox([a.bbox, b.bbox]),
            op: { char: "=", confidence: 0.9, source: "geom" },
          });
          i++;
          continue;
        }
      }
      out.push(a);
    }
    return out;
  }

  function layoutInkOn(glyphs) {
    if (!glyphs.length) return { text: "", math: false };
    glyphs = coalesceEqualsGlyphs(glyphs);
    const bars = [];
    const rest = [];
    for (const g of glyphs) {
      const asBar = g.op && g.op.fractionBar && (g.char === "-" || g.char === "—");
      if (asBar) bars.push(g);
      else rest.push(g);
    }

    function pieceText(list) {
      const lines = splitGlyphLines(list);
      const texts = lines.map((ln) => pieceTextLTR(ln.glyphs));
      if (lineTextsAreMath(texts)) return texts.join("");
      return texts.join(" ");
    }

    if (bars.length === 1 && rest.length >= 2) {
      const bar = bars[0];
      const above = [];
      const below = [];
      const side = [];
      for (const g of rest) {
        const cx = (g.bbox.minX + g.bbox.maxX) / 2;
        const onBar = cx >= bar.bbox.minX - 4 && cx <= bar.bbox.maxX + 4;
        const cy = (g.bbox.minY + g.bbox.maxY) / 2;
        const barCy = (bar.bbox.minY + bar.bbox.maxY) / 2;
        if (onBar && cy < barCy - 2) above.push(g);
        else if (onBar && cy > barCy + 2) below.push(g);
        else side.push(g);
      }
      if (above.length && below.length) {
        const frac = "(" + pieceText(above) + ")/(" + pieceText(below) + ")";
        const left = side.filter((g) => g.bbox.maxX <= bar.bbox.minX + 2);
        const right = side.filter((g) => g.bbox.minX >= bar.bbox.maxX - 2);
        const text = pieceText(left) + frac + pieceText(right);
        return { text, math: true };
      }
    }

    const text = pieceText(glyphs);
    return { text, math: looksLikeMath(text) };
  }

  function orderGroupsReading(groups) {
    return (groups || []).slice().sort((a, b) => {
      const ay = (a.bbox.minY + a.bbox.maxY) / 2;
      const by = (b.bbox.minY + b.bbox.maxY) / 2;
      const ah = Math.max(8, a.bbox.maxY - a.bbox.minY);
      if (Math.abs(ay - by) > ah * 0.55) return ay - by;
      return a.bbox.minX - b.bbox.minX;
    });
  }

  function joinReadingOrder(groups) {
    const ordered = orderGroupsReading(groups);
    if (!ordered.length) return "";
    const lines = [];
    for (const g of ordered) {
      if (!lines.length) {
        lines.push([g]);
        continue;
      }
      const lastLine = lines[lines.length - 1];
      const prev = lastLine[lastLine.length - 1];
      const ay = (g.bbox.minY + g.bbox.maxY) / 2;
      const py = (prev.bbox.minY + prev.bbox.maxY) / 2;
      const ph = Math.max(8, prev.bbox.maxY - prev.bbox.minY);
      if (Math.abs(ay - py) > ph * 0.55) lines.push([g]);
      else lastLine.push(g);
    }
    const lineTexts = lines
      .map((line) => {
        line.sort((a, b) => a.bbox.minX - b.bbox.minX);
        return line
          .map((g) => g.text || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      })
      .filter(Boolean);
    if (lineTextsAreMath(lineTexts)) return lineTexts.join("");
    return lineTexts.join(" ");
  }

  function stitchBlockGroups(groups, blocks) {
    const list = groups || [];
    if (!blocks || !blocks.length) {
      if (!list.length) return [];
      const text = joinReadingOrder(list);
      const solved = solveFromBurst(text);
      return [
        {
          bbox: unionBBox(list.map((g) => g.bbox)),
          glyphs: orderGroupsReading(list).flatMap((g) => g.glyphs || []),
          text,
          math: !!(solved || looksLikeMath(text)),
          mathish: list.some((g) => g.mathish),
          result: solved,
          strokeIds: list.flatMap((g) => g.strokeIds || []),
        },
      ];
    }
    return blocks
      .map((block) => {
        const ids = new Set((block.strokes || []).map((s) => s.id));
        const part = list.filter((g) => (g.strokeIds || []).some((id) => ids.has(id)));
        if (!part.length && !ids.size) return null;
        const text = joinReadingOrder(part);
        if (!text) return null;
        const solved = solveFromBurst(text);
        return {
          bbox: block.bbox,
          glyphs: orderGroupsReading(part).flatMap((g) => g.glyphs || []),
          text,
          math: !!(solved || looksLikeMath(text)),
          mathish: part.some((g) => g.mathish),
          result: solved,
          strokeIds: Array.from(ids),
        };
      })
      .filter(Boolean);
  }

  const SPELL_DICT = new Set(
    String(root.SOFIA_DE_WORDS || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
  );

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const row = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) row[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
        prev = cur;
      }
    }
    return row[b.length];
  }

  function closeDictHit(word) {
    const w = word.toLowerCase();
    const maxd = w.length >= 6 ? 2 : 1;
    for (const d of SPELL_DICT) {
      if (Math.abs(d.length - w.length) > maxd) continue;
      if (d[0] !== w[0] && d.length > 3) continue;
      if (levenshtein(w, d) <= maxd) return d;
    }
    return null;
  }

  function misspelledSpans(text, extra) {
    const src = String(text || "");
    const extraSet = new Set((extra || []).map((w) => String(w).toLowerCase()));
    const out = [];
    const re = /[A-Za-zÄÖÜäöüß]+/g;
    let m;
    while ((m = re.exec(src))) {
      const word = m[0];
      if (word.length < 3) continue;
      const low = word.toLowerCase();
      if (SPELL_DICT.has(low)) continue;
      const close = closeDictHit(word);
      if (close || extraSet.has(low)) {
        out.push({ word, start: m.index, end: m.index + word.length });
      }
    }
    return out;
  }

  let memoryCache = [];
  let memoryReady = false;

  function openLearnDb() {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("sofianotes-learn", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("glyphs")) {
          db.createObjectStore("glyphs", { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function loadMemory() {
    if (memoryReady) return memoryCache;
    memoryReady = true;
    try {
      const db = await openLearnDb();
      if (!db) return memoryCache;
      memoryCache = await new Promise((resolve, reject) => {
        const tx = db.transaction("glyphs", "readonly");
        const req = tx.objectStore("glyphs").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      db.close();
    } catch (_err) {
      memoryCache = [];
    }
    return memoryCache;
  }

  async function rememberGlyph(pixels, label) {
    const lab = String(label || "").slice(0, 4);
    if (!lab) return;
    const rec = { label: lab, pixels: Array.from(pixels), ts: Date.now() };
    memoryCache.push(rec);
    if (memoryCache.length > MAX_MEMORY) memoryCache = memoryCache.slice(-MAX_MEMORY);
    try {
      const db = await openLearnDb();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction("glyphs", "readwrite");
        const store = tx.objectStore("glyphs");
        store.add(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      const all = await new Promise((resolve, reject) => {
        const tx = db.transaction("glyphs", "readonly");
        const req = tx.objectStore("glyphs").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      if (all.length > MAX_MEMORY) {
        const extra = all.slice(0, all.length - MAX_MEMORY);
        await new Promise((resolve, reject) => {
          const tx = db.transaction("glyphs", "readwrite");
          const store = tx.objectStore("glyphs");
          for (const row of extra) store.delete(row.id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
      db.close();
    } catch (_err) {
      /* memory still works in-session */
    }
  }

  let tfModel = null;
  let tfLoad = null;
  let warmed = false;

  async function ensureTfBackend() {
    const tf = root.tf;
    if (!tf) return null;
    try {
      if (typeof tf.enableProdMode === "function") tf.enableProdMode();
      await tf.ready();
    } catch (_err) {
      /* cpu/webgl fallback happens inside tf */
    }
    return tf;
  }

  function loadEmnistModel(url) {
    if (tfModel) return Promise.resolve(tfModel);
    if (tfLoad) return tfLoad;
    const tf = root.tf;
    if (!tf || typeof tf.loadLayersModel !== "function") {
      return Promise.resolve(null);
    }
    tfLoad = ensureTfBackend()
      .then(() => tf.loadLayersModel(url || "/models/emnist/model.json"))
      .then(async (m) => {
        tfModel = m;
        try {
          const z = tf.zeros([1, SIZE, SIZE, 1]);
          const p = m.predict(z);
          await p.data();
          z.dispose();
          p.dispose();
          warmed = true;
        } catch (_err) {
          warmed = true;
        }
        return m;
      })
      .catch(() => {
        tfLoad = null;
        return null;
      });
    return tfLoad;
  }

  async function cnnPredictBatch(pixelsList, opts) {
    const model = tfModel || (await loadEmnistModel());
    const tf = root.tf;
    if (!model || !tf || !pixelsList.length) return pixelsList.map(() => null);
    const preferDigits = !opts || opts.preferDigits !== false;
    const views = [];
    const owners = [];
    for (let i = 0; i < pixelsList.length; i++) {
      const p = pixelsList[i];
      const vars = preferDigits
        ? [p, rotatePixels(p, -16), rotatePixels(p, 16), shiftPixels(p, 0, 1)]
        : [p, rotatePixels(p, -10), rotatePixels(p, 10)];
      for (const v of vars) {
        views.push(v);
        owners.push(i);
      }
    }
    const n = views.length;
    const flat = new Float32Array(n * SIZE * SIZE);
    for (let i = 0; i < n; i++) flat.set(views[i], i * SIZE * SIZE);
    const t = tf.tensor4d(flat, [n, SIZE, SIZE, 1]);
    const pred = model.predict(t);
    const data = pred.dataSync ? pred.dataSync() : await pred.data();
    t.dispose();
    pred.dispose();
    const stride = EMNIST_CHARS.length;
    const acc = pixelsList.map(() => new Float64Array(stride));
    const counts = pixelsList.map(() => 0);
    for (let i = 0; i < n; i++) {
      const owner = owners[i];
      counts[owner]++;
      for (let k = 0; k < stride; k++) acc[owner][k] += data[i * stride + k];
    }
    return acc.map((sum, i) => {
      const c = Math.max(1, counts[i]);
      for (let k = 0; k < stride; k++) sum[k] /= c;
      return pickFromProbs(sum, preferDigits);
    });
  }

  async function cnnPredict(pixels, opts) {
    const [one] = await cnnPredictBatch([pixels], opts);
    return one;
  }

  function applyPick(glyph, pick, geom, mathish) {
    if (!pick && geom) pick = geom;
    if (!pick) {
      glyph.char = "?";
      glyph.confidence = 0;
      glyph.source = "none";
      glyph.alts = [];
      return glyph;
    }
    const alts = (pick.alts || []).slice();
    glyph.char = biasMathChar(pick.char, alts, mathish);
    glyph.confidence = pick.confidence;
    glyph.source = pick.source;
    glyph.alts = alts.map((a) => a.char).filter((c, i, arr) => arr.indexOf(c) === i && c !== glyph.char);
    if (geom && geom.char && glyph.char !== geom.char) glyph.alts.unshift(geom.char);
    return glyph;
  }

  function memoryExamples() {
    return memoryCache.map((ex) => ({
      label: ex.label,
      pixels: ex.pixels instanceof Float32Array ? ex.pixels : Float32Array.from(ex.pixels),
    }));
  }

  async function classifyGlyph(glyph, mathish) {
    const geom = detectOperator(glyph);
    glyph.op = geom;
    glyph.pixels = rasterizeGlyph(glyph.strokes);
    if (trustGeom(geom)) {
      glyph.char = geom.char;
      glyph.confidence = geom.confidence;
      glyph.source = geom.source;
      glyph.alts = [];
      return glyph;
    }
    const mem = knnPredict(glyph.pixels, memoryExamples());
    if (mem && mem.confidence >= 0.7) return applyPick(glyph, mem, geom, mathish);
    const cnn = await cnnPredict(glyph.pixels, { preferDigits: mathish });
    return applyPick(glyph, mem && mem.confidence >= 0.55 && (!cnn || mem.confidence >= cnn.confidence) ? mem : cnn, geom, mathish);
  }

  function filterRecentStrokes(strokes, opts) {
    const list = Array.isArray(strokes) ? strokes : [];
    const now = (opts && opts.now) || (typeof performance !== "undefined" ? performance.now() : Date.now());
    const windowMs = (opts && opts.windowMs) || 15000;
    const focusId = opts && opts.focusId;
    return list.filter((s) => {
      if (!isLikelyHandwriting(s)) return false;
      if (focusId && s.id === focusId) return true;
      return !!(s.endedAt && now - s.endedAt <= windowMs);
    });
  }

  async function recognizeStrokes(strokes, opts) {
    await loadMemory();
    const preferDigits = !opts || opts.preferDigits !== false;
    const scoped = opts && opts.recentOnly === false ? strokes.filter(isLikelyHandwriting) : filterRecentStrokes(strokes, opts);
    const groups = clusterGlyphs(scoped, { wordGap: opts && opts.wordGap });
    const pending = [];
    for (const group of groups) {
      const probe = group.glyphs.map((g) => detectOperator(g)).filter(Boolean);
      const hasOp = probe.some((p) => "+-×/=—√%π".includes(p.char));
      const mathish = hasOp || (preferDigits && group.glyphs.length <= 3 && !hasOp);
      group.mathish = mathish;
      for (const g of group.glyphs) {
        const geom = detectOperator(g);
        g.op = geom;
        g.pixels = rasterizeGlyph(g.strokes);
        if (trustGeom(geom)) {
          g.char = geom.char;
          g.confidence = geom.confidence;
          g.source = geom.source;
          g.alts = [];
          continue;
        }
        const mem = knnPredict(g.pixels, memoryExamples());
        if (mem && mem.confidence >= 0.7) {
          applyPick(g, mem, geom, mathish);
          continue;
        }
        pending.push({ g, geom, mem, mathish });
      }
    }
    const digitPend = pending.filter((p) => p.mathish);
    const textPend = pending.filter((p) => !p.mathish);
    const digitBatch = await cnnPredictBatch(
      digitPend.map((p) => p.g.pixels),
      { preferDigits: true }
    );
    const textBatch = await cnnPredictBatch(
      textPend.map((p) => p.g.pixels),
      { preferDigits: false }
    );
    digitPend.forEach((p, i) => {
      const cnn = digitBatch[i];
      const pick =
        p.mem && p.mem.confidence >= 0.55 && (!cnn || p.mem.confidence >= cnn.confidence) ? p.mem : cnn;
      applyPick(p.g, pick, p.geom, true);
    });
    textPend.forEach((p, i) => {
      const cnn = textBatch[i];
      const pick =
        p.mem && p.mem.confidence >= 0.55 && (!cnn || p.mem.confidence >= cnn.confidence) ? p.mem : cnn;
      applyPick(p.g, pick, p.geom, false);
    });
    const out = [];
    for (const group of groups) {
      applyWordContext(group.glyphs);
      const layout = layoutInkOn(group.glyphs);
      const solved = layout.math ? solveMath(layout.text) : null;
      const avg =
        group.glyphs.reduce((s, g) => s + (g.confidence || 0), 0) / Math.max(1, group.glyphs.length);
      const hasSymbol = /[0-9A-Za-zÄÖÜäöüß=√π%()+]/.test(layout.text.replace(/\?/g, ""));
      if (!hasSymbol && !solved) continue;
      if (avg < 0.38 && !solved) continue;
      out.push({
        bbox: group.bbox,
        glyphs: group.glyphs,
        text: layout.text,
        math: layout.math,
        mathish: group.mathish,
        result: solved,
        strokeIds: group.glyphs.flatMap((g) => g.strokes.map((s) => s.id)),
      });
    }
    return out;
  }

  function cleanOcrText(raw) {
    let s = String(raw || "")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "");
    const lines = s
      .split(/\n/)
      .map((ln) => ln.trim())
      .filter(Boolean);
    if (lines.length) s = lines[lines.length - 1];
    s = s.replace(
      /^(the\s+)?((handwritten|written)\s+)?(text|ink|characters?|transcription|answer)(\s+(is|says|reads|shown))?\s*[:\-–]\s*/i,
      ""
    );
    s = s.replace(/^["'`]+|["'`]+$/g, "");
    s = s.replace(/sqrt/gi, "√").replace(/\bpi\b/gi, "π");
    s = s.replace(/[×]/g, "x").replace(/[÷]/g, "/").replace(/[—–]/g, "-");
    const hasOp = /[+\-*/=√^%]/.test(s);
    const hasLetters = /[A-Za-zÄÖÜäöüß]/.test(s);
    if (hasOp && !hasLetters) s = s.replace(/\s+/g, "");
    else s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/[^0-9A-Za-zÄÖÜäöüß+\-*/=xX^().,√π% ]/g, "");
    if (s.length > 96) s = s.slice(0, 96);
    return s.trim();
  }

  const api = {
    EMNIST_CHARS,
    SIZE,
    strokePathLength,
    countDirectionReversals,
    looksLikeStrikeGesture,
    bboxOfPoints,
    rasterizeGlyph,
    knnPredict,
    isLikelyHandwriting,
    detectOperator,
    clusterGlyphs,
    writingBurst,
    clusterBlocks,
    DEFAULT_WORD_GAP,
    parseMath,
    solveMath,
    solveFromBurst,
    looksLikeMath,
    layoutInkOn,
    orderGroupsReading,
    joinReadingOrder,
    stitchBlockGroups,
    misspelledSpans,
    applyWordContext,
    loadEmnistModel,
    loadMemory,
    rememberGlyph,
    recognizeStrokes,
    classifyGlyph,
    filterRecentStrokes,
    formatNumber,
    cleanOcrText,
  };

  root.SofiaInk = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
