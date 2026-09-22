/* sofianotes handwriting: EMNIST + TensorFlow.js, ink-on math layout, local k-NN learning. */
(function (root) {
  "use strict";

  const EMNIST_CHARS =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const SIZE = 28;
  const PAD = 4;
  const INNER = SIZE - PAD * 2;
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
    const scribble =
      countDirectionReversals(pts) >= (mouse ? 1 : 2) && pathLength > (mouse ? 22 : 48);
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

  function rasterizeGlyph(strokes, opts) {
    const transpose = !opts || opts.transpose !== false;
    const all = [];
    for (const s of strokes) {
      for (const p of s.points || []) all.push(p);
    }
    if (all.length === 0) return new Float32Array(SIZE * SIZE);
    const b = bboxOfPoints(all);
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const scale = INNER / Math.max(w, h);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const toX = (x) => SIZE / 2 + (x - cx) * scale;
    const toY = (y) => SIZE / 2 + (y - cy) * scale;
    const meanSize =
      strokes.reduce((acc, s) => acc + (s.size || 6), 0) / Math.max(1, strokes.length);
    const r = Math.max(1.05, Math.min(2.35, meanSize * scale * 0.55));
    const buf = new Float32Array(SIZE * SIZE);
    for (const s of strokes) {
      const pts = s.points || [];
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
    if (pts.length >= 48) return false;
    const b = stroke.bbox || bboxOfPoints(pts);
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (w > 260 && h > 180) return false;
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
    if (h > w * 0.42 && h > 10) return false;
    if (path > 0 && maxDev / Math.max(path, w) > 0.22) return false;
    return h < 14 || h / w < 0.38;
  }

  function nearlyVertical(stats) {
    return stats.h > 10 && stats.w / stats.h < 0.38;
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
      const start = pts[0];
      const end = pts[pts.length - 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const chord = hypot(dx, dy);
      const slope = Math.abs(dy) / Math.max(1, Math.abs(dx));
      if (chord > 16 && path > 0 && chord / path > 0.72 && slope > 0.35 && slope < 2.8 && aspect > 0.35 && aspect < 2.4) {
        return { char: "/", confidence: 0.8, source: "geom" };
      }
      if (nearlyVertical(st) && w < 12) {
        return { char: "1", confidence: 0.55, source: "geom" };
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
          const pad = Math.max(4, medianH * 0.18);
          for (let j = 0; j < items.length; j++) {
            if (used.has(j)) continue;
            const b = items[j].bbox;
            const closeX = xOverlapRatio(box, b) > 0.28 || boxesOverlap(box, b, pad);
            const closeY = boxesOverlap(
              { minX: box.minX, maxX: box.maxX, minY: box.minY - pad, maxY: box.maxY + pad },
              b,
              0
            );
            if (closeX && closeY) {
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

  function biasMathChar(char, alts, mathish) {
    if (!mathish) return char;
    if (MATH_CONFUSIONS[char]) return MATH_CONFUSIONS[char];
    if (alts) {
      for (const a of alts) {
        if (/[0-9+\-*/=.]/.test(a.char)) return a.char;
      }
    }
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

  function loadEmnistModel(url) {
    if (tfModel) return Promise.resolve(tfModel);
    if (tfLoad) return tfLoad;
    const tf = root.tf;
    if (!tf || typeof tf.loadLayersModel !== "function") {
      return Promise.resolve(null);
    }
    tfLoad = tf
      .loadLayersModel(url || "/models/emnist/model.json")
      .then((m) => {
        tfModel = m;
        return m;
      })
      .catch(() => {
        tfLoad = null;
        return null;
      });
    return tfLoad;
  }

  async function cnnPredict(pixels) {
    const model = tfModel || (await loadEmnistModel());
    const tf = root.tf;
    if (!model || !tf) return null;
    const t = tf.tensor4d(pixels, [1, SIZE, SIZE, 1]);
    const pred = model.predict(t);
    const data = pred.dataSync();
    t.dispose();
    pred.dispose();
    const top = topFromProbs(data, 4);
    return top[0] ? { ...top[0], alts: top } : null;
  }

  async function classifyGlyph(glyph, mathish) {
    const geom = detectOperator(glyph);
    glyph.op = geom;
    if (geom && geom.confidence >= 0.78) {
      glyph.char = geom.char;
      glyph.confidence = geom.confidence;
      glyph.source = geom.source;
      glyph.alts = [];
      glyph.pixels = rasterizeGlyph(glyph.strokes);
      return glyph;
    }
    const pixels = rasterizeGlyph(glyph.strokes);
    glyph.pixels = pixels;
    const examples = memoryCache.map((ex) => ({
      label: ex.label,
      pixels: ex.pixels instanceof Float32Array ? ex.pixels : Float32Array.from(ex.pixels),
    }));
    const mem = knnPredict(pixels, examples);
    const cnn = await cnnPredict(pixels);
    let pick = mem && (!cnn || mem.confidence >= 0.55) ? mem : cnn;
    if (!pick && geom) pick = geom;
    if (!pick) {
      glyph.char = "?";
      glyph.confidence = 0;
      glyph.source = "none";
      glyph.alts = [];
      return glyph;
    }
    const alts = (cnn && cnn.alts) || [];
    glyph.char = biasMathChar(pick.char, alts, mathish);
    glyph.confidence = pick.confidence;
    glyph.source = pick.source;
    glyph.alts = alts.map((a) => a.char).filter((c, i, arr) => arr.indexOf(c) === i && c !== glyph.char);
    if (geom && geom.char && glyph.char !== geom.char) glyph.alts.unshift(geom.char);
    return glyph;
  }

  async function recognizeStrokes(strokes) {
    await loadMemory();
    const groups = clusterGlyphs(strokes);
    const out = [];
    for (const group of groups) {
      const probe = group.glyphs.map((g) => detectOperator(g)).filter(Boolean);
      const mathish = probe.some((p) => "+-×/=—".includes(p.char));
      for (const g of group.glyphs) {
        await classifyGlyph(g, mathish);
      }
      const layout = layoutInkOn(group.glyphs);
      const solved = layout.math ? solveMath(layout.text) : null;
      const avg =
        group.glyphs.reduce((s, g) => s + (g.confidence || 0), 0) / Math.max(1, group.glyphs.length);
      const hasSymbol = /[0-9A-Za-z]/.test(layout.text.replace(/\?/g, ""));
      if (!hasSymbol && !solved) continue;
      if (avg < 0.28 && !solved) continue;
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
    formatNumber,
  };

  root.SofiaInk = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
