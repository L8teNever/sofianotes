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

  function detectOperator(glyph) {
    const strokes = glyph.strokes;
    const st = glyphStats(strokes);
    glyph.stats = st;
    const { w, h, path, aspect } = st;

    if (w < 11 && h < 11 && path < 22) {
      return { char: ".", confidence: 0.84, source: "geom" };
    }

    if (strokes.length === 2) {
      const a = glyphStats([strokes[0]]);
      const b = glyphStats([strokes[1]]);
      const ha = nearlyHorizontal([strokes[0]], a);
      const hb = nearlyHorizontal([strokes[1]], b);
      if (ha && hb) {
        const gap = Math.abs((a.bbox.minY + a.bbox.maxY) / 2 - (b.bbox.minY + b.bbox.maxY) / 2);
        if (gap > 3 && gap < Math.max(a.w, b.w) * 0.9) {
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

  function clusterGlyphs(strokes) {
    const ink = strokes.filter(isLikelyHandwriting).map((s) => {
      const bbox = s.bbox || bboxOfPoints(s.points || []);
      return { ...s, bbox };
    });
    if (ink.length === 0) return [];

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
            const contained =
              (b.minX >= box.minX - 8 && b.maxX <= box.maxX + 8) ||
              (box.minX >= b.minX - 8 && box.maxX <= b.maxX + 8);
            if ((sameColumn || stackedDot || contained) && closeY) {
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
      if (glyphs.length) {
        groups.push({
          bbox: unionBBox(glyphs.map((g) => g.bbox)),
          glyphs,
        });
      }
    }
    return groups;
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

  function biasMathChar(char, alts, mathish) {
    if (!mathish) return char;
    if (MATH_CONFUSIONS[char]) return MATH_CONFUSIONS[char];
    return char;
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
      .replace(/\s+/g, "")
      .replace(/=+$/g, "")
      .replace(/(\d)[xX](?=\d|\()/g, "$1*")
      .replace(/(\d)\(/g, "$1*(")
      .replace(/\)(\d)/g, ")*$1")
      .replace(/\)\(/g, ")*(");
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if ("+-*/^()".includes(c)) {
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
        return tok.v;
      }
      if (tok.t === "(") {
        eat("(");
        const v = parseAdd();
        eat(")");
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
    if (!/[0-9]/.test(text)) return false;
    const cleaned = text.replace(/[×÷—]/g, "*");
    if (/[A-WYZa-wyz]/.test(cleaned)) return false;
    return /[+\-*/^=xX]/.test(cleaned);
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

  function layoutInkOn(glyphs) {
    if (!glyphs.length) return { text: "", math: false };
    const bars = [];
    const rest = [];
    for (const g of glyphs) {
      const asBar = g.op && g.op.fractionBar && (g.char === "-" || g.char === "—");
      if (asBar) bars.push(g);
      else rest.push(g);
    }

    function pieceText(list) {
      const sorted = list.slice().sort((a, b) => a.bbox.minX - b.bbox.minX);
      let out = "";
      let prev = null;
      for (const g of sorted) {
        let ch = g.char || "?";
        if (prev) {
          const prevH = Math.max(6, prev.bbox.maxY - prev.bbox.minY);
          const gH = Math.max(4, g.bbox.maxY - g.bbox.minY);
          const gCy = (g.bbox.minY + g.bbox.maxY) / 2;
          const pCy = (prev.bbox.minY + prev.bbox.maxY) / 2;
          const gap = g.bbox.minX - prev.bbox.maxX;
          if (gCy < pCy - prevH * 0.32 && gH < prevH * 0.78 && gap < prevH * 0.55) {
            out += "^";
          }
        }
        out += ch;
        prev = g;
      }
      return out;
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
    if (geom && geom.confidence >= 0.8 && "-+=/.".includes(geom.char)) {
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
    const groups = clusterGlyphs(scoped);
    const pending = [];
    for (const group of groups) {
      const probe = group.glyphs.map((g) => detectOperator(g)).filter(Boolean);
      const mathish = preferDigits || probe.some((p) => "+-×/=—".includes(p.char));
      group.mathish = mathish;
      for (const g of group.glyphs) {
        const geom = detectOperator(g);
        g.op = geom;
        g.pixels = rasterizeGlyph(g.strokes);
        if (geom && geom.confidence >= 0.8 && "-+=/.".includes(geom.char)) {
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
    const batch = await cnnPredictBatch(
      pending.map((p) => p.g.pixels),
      { preferDigits }
    );
    pending.forEach((p, i) => {
      const cnn = batch[i];
      const pick =
        p.mem && p.mem.confidence >= 0.55 && (!cnn || p.mem.confidence >= cnn.confidence) ? p.mem : cnn;
      applyPick(p.g, pick, p.geom, p.mathish);
    });
    const out = [];
    for (const group of groups) {
      const layout = layoutInkOn(group.glyphs);
      const solved = layout.math ? solveMath(layout.text) : null;
      const avg =
        group.glyphs.reduce((s, g) => s + (g.confidence || 0), 0) / Math.max(1, group.glyphs.length);
      const hasSymbol = /[0-9A-Za-z]/.test(layout.text.replace(/\?/g, ""));
      if (!hasSymbol && !solved) continue;
      if (avg < 0.38 && !solved) continue;
      out.push({
        bbox: group.bbox,
        glyphs: group.glyphs,
        text: layout.text,
        math: layout.math,
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
    s = s.replace(/[×]/g, "x").replace(/[÷]/g, "/").replace(/[—–]/g, "-");
    if (/[0-9+\-*/=xX^]/.test(s)) s = s.replace(/\s+/g, "");
    else s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/[^0-9A-Za-z+\-*/=xX^()., ]/g, "");
    if (s.length > 48) s = s.slice(0, 48);
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
    parseMath,
    solveMath,
    looksLikeMath,
    layoutInkOn,
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
