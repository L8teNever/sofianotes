// Koordinatensystem-Generator: Achsen, Gitter, Funktionen, besondere Punkte, eigene Punkte,
// Flaechen. Alles in echten Millimetern (1 Kaestchen = 5 mm), damit es auf karierten Seiten
// genau auf den Linien sitzt. window.SofiaKoord.open(spec, onDone) oeffnet das Fenster,
// window.SofiaKoord.render(spec, pxPerMM) zeichnet es auf ein Canvas.
(() => {
  "use strict";

  // ---------- Formel-Parser (ohne eval) ----------
  const FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, arcsin: Math.asin, acos: Math.acos, arccos: Math.acos, atan: Math.atan, arctan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: Math.sqrt, wurzel: Math.sqrt, abs: Math.abs, betrag: Math.abs,
    ln: Math.log, log: Math.log10, lg: Math.log10, exp: Math.exp,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, sgn: Math.sign, sign: Math.sign,
  };
  const CONSTS = { pi: Math.PI, "π": Math.PI, e: Math.E };

  function normalize(src) {
    let s = String(src || "").trim();
    s = s.replace(/^\s*(?:[a-zA-Z]\s*\(\s*x\s*\)|y)\s*=\s*/, ""); // "f(x) =" bzw. "y =" weg
    s = s.replace(/²/g, "^2").replace(/³/g, "^3").replace(/[·×∙]/g, "*").replace(/÷|:/g, "/").replace(/−/g, "-");
    s = s.replace(/√/g, "sqrt");
    s = s.replace(/(\d),(\d)/g, "$1.$2"); // deutsches Komma
    return s;
  }
  function tokenize(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s[j])) j++;
        const v = parseFloat(s.slice(i, j));
        if (!Number.isFinite(v)) throw new Error("Zahl");
        out.push({ t: "num", v });
        i = j;
        continue;
      }
      if (/[a-zA-Zπ]/.test(c)) {
        let j = i;
        while (j < s.length && /[a-zA-Zπ]/.test(s[j])) j++;
        let w = s.slice(i, j).toLowerCase();
        // "xsin" / "2pix" usw.: bekannte Namen vorne abtrennen
        while (w) {
          let hit = null;
          for (const name of [...Object.keys(FUNCS), ...Object.keys(CONSTS), "x"].sort((a, b) => b.length - a.length)) {
            if (w.startsWith(name)) { hit = name; break; }
          }
          if (!hit) throw new Error("Unbekannt: " + w);
          out.push({ t: "id", v: hit });
          w = w.slice(hit.length);
        }
        i = j;
        continue;
      }
      if ("+-*/^()".includes(c)) { out.push({ t: c }); i++; continue; }
      throw new Error("Zeichen " + c);
    }
    // Mal-Zeichen ergaenzen: 2x, 3(x+1), (x+1)(x-1), x(x+2), 2sin(x)
    const res = [];
    for (let k = 0; k < out.length; k++) {
      const a = res[res.length - 1];
      const b = out[k];
      const aEnds = a && (a.t === "num" || a.t === ")" || (a.t === "id" && !FUNCS[a.v]));
      const bStarts = b.t === "num" || b.t === "(" || b.t === "id";
      if (aEnds && bStarts) res.push({ t: "*" });
      res.push(b);
    }
    return res;
  }
  function compile(src) {
    const toks = tokenize(normalize(src));
    if (!toks.length) throw new Error("leer");
    let p = 0;
    const peek = () => toks[p];
    const eat = (t) => {
      if (!toks[p] || toks[p].t !== t) throw new Error("erwartet " + t);
      return toks[p++];
    };
    function expr() {
      let f = term();
      while (peek() && (peek().t === "+" || peek().t === "-")) {
        const op = toks[p++].t;
        const a = f, b = term();
        f = op === "+" ? (x) => a(x) + b(x) : (x) => a(x) - b(x);
      }
      return f;
    }
    function term() {
      let f = unary();
      while (peek() && (peek().t === "*" || peek().t === "/")) {
        const op = toks[p++].t;
        const a = f, b = unary();
        f = op === "*" ? (x) => a(x) * b(x) : (x) => a(x) / b(x);
      }
      return f;
    }
    function unary() {
      if (peek() && peek().t === "-") { p++; const a = unary(); return (x) => -a(x); }
      if (peek() && peek().t === "+") { p++; return unary(); }
      return power();
    }
    function power() {
      const base = atom();
      if (peek() && peek().t === "^") {
        p++;
        const ex = unary(); // rechtsassoziativ, -x^2 = -(x^2)
        return (x) => {
          const b = base(x), e = ex(x);
          // ungerade Wurzeln aus negativen Zahlen (x^(1/3))
          if (b < 0 && !Number.isInteger(e)) {
            const inv = 1 / e;
            if (Number.isInteger(Math.round(inv)) && Math.abs(inv - Math.round(inv)) < 1e-9 && Math.round(inv) % 2) return -Math.pow(-b, e);
          }
          return Math.pow(b, e);
        };
      }
      return base;
    }
    function atom() {
      const t = peek();
      if (!t) throw new Error("unvollständig");
      if (t.t === "num") { p++; const v = t.v; return () => v; }
      if (t.t === "(") { p++; const f = expr(); eat(")"); return f; }
      if (t.t === "id") {
        p++;
        if (t.v === "x") return (x) => x;
        if (CONSTS[t.v] != null) { const v = CONSTS[t.v]; return () => v; }
        const fn = FUNCS[t.v];
        // sin(x) oder sin x / sin 2x
        const arg = peek() && peek().t === "(" ? (p++, ((f) => (eat(")"), f))(expr())) : power();
        return (x) => fn(arg(x));
      }
      throw new Error("unerwartet " + t.t);
    }
    const f = expr();
    if (p < toks.length) throw new Error("zu viel");
    return f;
  }

  // ---------- Zahlen ----------
  const fmt = (v, d = 2) => {
    if (!Number.isFinite(v)) return "–";
    let r = Math.round(v * 10 ** d) / 10 ** d;
    if (Object.is(r, -0)) r = 0;
    return String(r).replace(".", ",");
  };
  function piLabel(k) {
    // k = Vielfache von pi/2
    if (k === 0) return "0";
    const sign = k < 0 ? "−" : "";
    const a = Math.abs(k);
    if (a % 2 === 0) return sign + (a / 2 === 1 ? "" : a / 2) + "π";
    return sign + (a === 1 ? "" : a) + "π/2";
  }
  function niceStep(span, target) {
    const raw = span / Math.max(1, target);
    const p10 = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (m * p10 >= raw) return m * p10;
    return 10 * p10;
  }

  // ---------- Besondere Punkte ----------
  function bisect(g, a, b, it = 60) {
    let fa = g(a);
    for (let i = 0; i < it; i++) {
      const m = (a + b) / 2;
      const fm = g(m);
      if (!Number.isFinite(fm)) return null;
      if ((fa <= 0 && fm >= 0) || (fa >= 0 && fm <= 0)) b = m;
      else { a = m; fa = fm; }
    }
    return (a + b) / 2;
  }
  // tol: Vorzeichenwechsel nur zaehlen, wenn die Werte ueber dem Rechenrauschen liegen
  // (sonst findet eine Gerade lauter "Wendepunkte" in ihrer zweiten Ableitung ~ 0)
  function signChanges(g, x0, x1, n, tol) {
    const out = [];
    tol = tol || 0;
    let px = x0, pv = g(x0);
    for (let i = 1; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const v = g(x);
      if (Number.isFinite(pv) && Number.isFinite(v)) {
        if (v === 0) {
          // genau 0: nur zaehlen, wenn es kein Dauer-Null ist (Gerade -> 2. Ableitung immer 0)
          if (!tol || Math.abs(pv) > tol || Math.abs(g(x + (x1 - x0) / n)) > tol) out.push(x);
        }
        else if (pv !== 0 && (pv < 0) !== (v < 0) && Math.max(Math.abs(pv), Math.abs(v)) > tol) {
          // keine Polstelle (1/x): dort springt der Wert riesig
          if (Math.abs(pv) + Math.abs(v) < 1e6) {
            const r = bisect(g, px, x);
            if (r != null && Math.abs(g(r)) < 1e-3 * Math.max(1, Math.abs(pv), Math.abs(v))) out.push(r);
          }
        }
      }
      px = x;
      pv = v;
    }
    // doppelte (beieinanderliegende) entfernen
    return out.filter((x, i) => i === 0 || Math.abs(x - out[i - 1]) > (x1 - x0) / n);
  }
  const deriv = (f, h) => (x) => (f(x + h) - f(x - h)) / (2 * h);

  // ---------- Standard ----------
  const COLORS = ["#1a73e8", "#d93025", "#188038", "#9334e6", "#e37400", "#00838f", "#202124"];
  function defaults() {
    return {
      v: 1,
      xmin: -5, xmax: 5, ymin: -5, ymax: 5,
      unit: 10, // mm pro Einheit (1 cm)
      xstep: 1, ystep: 1, // Beschriftung alle ... Einheiten
      xpi: false,
      grid: "mm5", // "mm5" (Kaestchen), "unit", "none"
      gridStrong: false,
      labels: true, arrows: true, xname: "x", yname: "y", origin0: true,
      title: "",
      lineWidth: 0.5, // mm
      font: 3.2, // mm
      fns: [],
      special: { zeros: false, extrema: false, inflection: false, yint: false, cross: false, coords: true },
      points: [],
      guides: true,
      area: { on: false, fn: 0, a: 0, b: 1, color: "#1a73e8" },
      legend: true,
    };
  }
  const PRESETS = [
    { name: "Leer – 4 Quadranten", spec: { xmin: -5, xmax: 5, ymin: -5, ymax: 5, fns: [] } },
    { name: "Leer – 1. Quadrant", spec: { xmin: 0, xmax: 10, ymin: 0, ymax: 8, fns: [] } },
    { name: "Gerade", spec: { xmin: -5, xmax: 5, ymin: -5, ymax: 5, fns: [{ expr: "0,5x + 1" }], special: { zeros: true, yint: true, coords: true } } },
    { name: "Parabel", spec: { xmin: -4, xmax: 4, ymin: -3, ymax: 7, fns: [{ expr: "x^2 - 2" }], special: { zeros: true, extrema: true, coords: true } } },
    { name: "Kubisch", spec: { xmin: -4, xmax: 4, ymin: -6, ymax: 6, fns: [{ expr: "0,25x^3 - 2x" }], special: { zeros: true, extrema: true, inflection: true, coords: true } } },
    { name: "Sinus / Kosinus", spec: { xmin: -7, xmax: 7, ymin: -2, ymax: 2, xpi: true, unit: 10, fns: [{ expr: "sin(x)" }, { expr: "cos(x)" }], special: { coords: false } } },
    { name: "Exponential", spec: { xmin: -4, xmax: 4, ymin: -1, ymax: 8, fns: [{ expr: "2^x" }, { expr: "e^x" }], special: { yint: true, coords: true } } },
  ];
  function mergeSpec(base, over) {
    const out = JSON.parse(JSON.stringify(base));
    for (const k of Object.keys(over || {})) {
      if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k])) out[k] = Object.assign({}, out[k] || {}, over[k]);
      else out[k] = JSON.parse(JSON.stringify(over[k]));
    }
    out.fns = (out.fns || []).map((f, i) => Object.assign({ expr: "", color: COLORS[i % COLORS.length], width: 0.6, dash: "solid", name: "fghkpq"[i] || "f" }, f));
    out.points = (out.points || []).map((q) => Object.assign({ x: 0, y: 0, label: "", color: "#d93025" }, q));
    return out;
  }

  // ---------- Zeichnen ----------
  // Gibt { canvas, wMM, hMM, ox, oy } zurueck: Groesse in mm und wo der Ursprung (0|0) liegt
  function geometry(s) {
    const pad = 10; // mm Rand (Vielfaches von 5 -> Achsen auf den Kaestchen)
    const top = s.title ? 15 : pad;
    const pw = (s.xmax - s.xmin) * s.unit;
    const ph = (s.ymax - s.ymin) * s.unit;
    return { pad, top, pw, ph, wMM: pw + pad * 2, hMM: ph + top + pad };
  }
  function render(spec, pxPerMM, opts) {
    const s = spec;
    const G = geometry(s);
    const k = pxPerMM;
    const cv = (opts && opts.canvas) || document.createElement("canvas");
    cv.width = Math.max(1, Math.round(G.wMM * k));
    cv.height = Math.max(1, Math.round(G.hMM * k));
    const c = cv.getContext("2d");
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, cv.width, cv.height);
    c.scale(k, k); // ab hier in mm
    const X = (x) => G.pad + (x - s.xmin) * s.unit;
    const Y = (y) => G.top + (s.ymax - y) * s.unit;
    const L = G.pad, R = G.pad + G.pw, T = G.top, B = G.top + G.ph;
    const font = (sz, w) => (w || 500) + " " + sz + "px Inter, 'Google Sans', system-ui, sans-serif";

    // Gitter
    c.lineWidth = 0.15;
    if (s.grid !== "none") {
      const step = s.grid === "unit" ? s.unit : 5;
      c.strokeStyle = s.gridStrong ? "rgba(70,90,140,0.42)" : "rgba(80,100,150,0.26)";
      c.beginPath();
      // an den Achsen ausgerichtet (Ursprung liegt auf einer Gitterlinie)
      const x0 = X(0), y0 = Y(0);
      for (let x = x0 - Math.ceil((x0 - L) / step) * step; x <= R + 1e-6; x += step) if (x >= L - 1e-6) { c.moveTo(x, T); c.lineTo(x, B); }
      for (let y = y0 - Math.ceil((y0 - T) / step) * step; y <= B + 1e-6; y += step) if (y >= T - 1e-6) { c.moveTo(L, y); c.lineTo(R, y); }
      c.stroke();
    }

    // Flaeche unter einem Graphen
    const compiled = s.fns.map((f) => {
      try {
        return f.expr && f.expr.trim() ? compile(f.expr) : null;
      } catch (err) {
        return null;
      }
    });
    if (s.area && s.area.on && compiled[s.area.fn]) {
      const f = compiled[s.area.fn];
      const a = Math.max(s.xmin, Math.min(s.area.a, s.area.b));
      const b = Math.min(s.xmax, Math.max(s.area.a, s.area.b));
      if (b > a) {
        c.save();
        c.beginPath();
        c.rect(L, T, G.pw, G.ph);
        c.clip();
        c.fillStyle = hexA(s.fns[s.area.fn].color || s.area.color, 0.22);
        c.beginPath();
        c.moveTo(X(a), Y(0));
        const n = 400;
        for (let i = 0; i <= n; i++) {
          const x = a + ((b - a) * i) / n;
          const v = f(x);
          c.lineTo(X(x), Y(Number.isFinite(v) ? Math.max(s.ymin - 1, Math.min(s.ymax + 1, v)) : 0));
        }
        c.lineTo(X(b), Y(0));
        c.closePath();
        c.fill();
        c.restore();
        // Integral (Simpson)
        let sum = 0;
        const n2 = 1000;
        const h = (b - a) / n2;
        for (let i = 0; i <= n2; i++) {
          const v = f(a + i * h);
          if (!Number.isFinite(v)) continue;
          sum += v * (i === 0 || i === n2 ? 1 : i % 2 ? 4 : 2);
        }
        const A = (sum * h) / 3;
        c.fillStyle = darken(s.fns[s.area.fn].color);
        c.font = font(s.font, 700);
        c.textAlign = "center";
        c.textBaseline = "middle";
        const mx = (a + b) / 2;
        const mv = f(mx);
        const ly = Number.isFinite(mv) ? Math.max(T + 4, Math.min(B - 4, (Y(0) + Y(mv)) / 2)) : Y(0) - 4;
        halo(c, "A ≈ " + fmt(A), X(mx), ly);
      }
    }

    // Achsen (bei 0, sonst am Rand)
    const ax = s.ymin <= 0 && s.ymax >= 0 ? Y(0) : s.ymin > 0 ? B : T;
    const ay = s.xmin <= 0 && s.xmax >= 0 ? X(0) : s.xmin > 0 ? L : R;
    c.strokeStyle = "#202124";
    c.fillStyle = "#202124";
    c.lineWidth = Math.max(0.2, s.lineWidth);
    c.lineCap = "round";
    const ext = s.arrows ? 4 : 0;
    c.beginPath();
    c.moveTo(L, ax);
    c.lineTo(R + ext, ax);
    c.moveTo(ay, B);
    c.lineTo(ay, T - ext);
    c.stroke();
    if (s.arrows) {
      const al = 2.4, aw = 1.3;
      c.beginPath();
      c.moveTo(R + ext + 0.6, ax);
      c.lineTo(R + ext - al, ax - aw);
      c.lineTo(R + ext - al, ax + aw);
      c.closePath();
      c.moveTo(ay, T - ext - 0.6);
      c.lineTo(ay - aw, T - ext + al);
      c.lineTo(ay + aw, T - ext + al);
      c.closePath();
      c.fill();
    }
    // Achsennamen
    c.font = font(s.font * 1.15, 600);
    c.textBaseline = "alphabetic";
    if (s.xname) {
      c.textAlign = "right";
      c.fillText(s.xname, R + ext + 1, ax - 2.2);
    }
    if (s.yname) {
      c.textAlign = "left";
      c.fillText(s.yname, ay + 2.2, T - ext + 1.5);
    }
    // Striche und Zahlen
    c.lineWidth = Math.max(0.18, s.lineWidth * 0.8);
    c.font = font(s.font, 500);
    const tick = 1.2;
    if (s.xpi) {
      const st = Math.PI / 2;
      for (let kk = Math.ceil(s.xmin / st); kk * st <= s.xmax + 1e-9; kk++) {
        const x = X(kk * st);
        c.beginPath();
        c.moveTo(x, ax - tick);
        c.lineTo(x, ax + tick);
        c.stroke();
        if (s.labels && kk !== 0) {
          c.textAlign = "center";
          c.textBaseline = "top";
          halo(c, piLabel(kk), x, ax + tick + 0.8);
        }
      }
    } else {
      const xs = s.xstep > 0 ? s.xstep : niceStep(s.xmax - s.xmin, 10);
      for (let v = Math.ceil(s.xmin / xs) * xs; v <= s.xmax + 1e-9; v += xs) {
        const vv = Math.round(v / xs) * xs;
        const x = X(vv);
        c.beginPath();
        c.moveTo(x, ax - tick);
        c.lineTo(x, ax + tick);
        c.stroke();
        if (s.labels && Math.abs(vv) > 1e-9) {
          c.textAlign = "center";
          c.textBaseline = "top";
          halo(c, fmt(vv, 3), x, ax + tick + 0.8);
        }
      }
    }
    const ys = s.ystep > 0 ? s.ystep : niceStep(s.ymax - s.ymin, 10);
    for (let v = Math.ceil(s.ymin / ys) * ys; v <= s.ymax + 1e-9; v += ys) {
      const vv = Math.round(v / ys) * ys;
      const y = Y(vv);
      c.beginPath();
      c.moveTo(ay - tick, y);
      c.lineTo(ay + tick, y);
      c.stroke();
      if (s.labels && Math.abs(vv) > 1e-9) {
        c.textAlign = "right";
        c.textBaseline = "middle";
        halo(c, fmt(vv, 3), ay - tick - 0.8, y);
      }
    }
    if (s.labels && s.origin0 && s.xmin <= 0 && s.xmax >= 0 && s.ymin <= 0 && s.ymax >= 0) {
      c.textAlign = "right";
      c.textBaseline = "top";
      halo(c, "0", ay - 0.9, ax + 0.9);
    }

    // Graphen
    const dashOf = (d, w) => (d === "dash" ? [w * 6, w * 4] : d === "dot" ? [w * 0.1, w * 3] : []);
    c.save();
    c.beginPath();
    c.rect(L, T, G.pw, G.ph);
    c.clip();
    s.fns.forEach((fd, i) => {
      const f = compiled[i];
      if (!f) return;
      c.strokeStyle = fd.color;
      c.lineWidth = fd.width;
      c.setLineDash(dashOf(fd.dash, fd.width));
      c.lineJoin = "round";
      c.beginPath();
      const n = Math.max(400, Math.round(G.pw * 4));
      let pen = false;
      let prev = null;
      const span = s.ymax - s.ymin;
      for (let j = 0; j <= n; j++) {
        const x = s.xmin + ((s.xmax - s.xmin) * j) / n;
        const v = f(x);
        if (!Number.isFinite(v) || Math.abs(v) > 1e6) {
          pen = false;
          prev = null;
          continue;
        }
        // Sprung (Polstelle, tan): nicht verbinden
        if (prev != null && Math.abs(v - prev) > span * 1.5 && (Math.abs(v) > span || Math.abs(prev) > span)) pen = false;
        const yy = Y(Math.max(s.ymin - span, Math.min(s.ymax + span, v)));
        if (pen) c.lineTo(X(x), yy);
        else c.moveTo(X(x), yy);
        pen = true;
        prev = v;
      }
      c.stroke();
    });
    c.setLineDash([]);
    c.restore();

    // besondere Punkte
    const sp = s.special || {};
    const marks = [];
    const n = Math.max(600, Math.round((s.xmax - s.xmin) * 120));
    const h = (s.xmax - s.xmin) / 2e4;
    // Rauschgrenzen fuer Ableitungen (relativ zur Groesse der Werte im Bild)
    const span = Math.max(1, s.ymax - s.ymin);
    const tol1 = 1e-6 * span;
    const tol2 = 1e-4 * span;
    compiled.forEach((f, i) => {
      if (!f) return;
      const nm = s.fns[i].name || "f";
      const col = s.fns[i].color;
      if (sp.zeros) {
        const zs = signChanges(f, s.xmin, s.xmax, n);
        // Beruehrstellen (x^2): Extrema mit Wert 0
        const d1 = deriv(f, h);
        for (const xe of signChanges(d1, s.xmin, s.xmax, n, tol1)) if (Math.abs(f(xe)) < 1e-6 && !zs.some((z) => Math.abs(z - xe) < 1e-3)) zs.push(xe);
        zs.sort((a, b) => a - b);
        zs.forEach((x, k) => marks.push({ x, y: 0, label: "N" + sub(k + 1, zs.length), col }));
      }
      if (sp.extrema) {
        const d1 = deriv(f, h);
        const d2 = deriv(d1, h * 10);
        for (const x of signChanges(d1, s.xmin, s.xmax, n, tol1)) {
          const y = f(x);
          if (!Number.isFinite(y)) continue;
          const curv = d2(x);
          marks.push({ x, y, label: curv < 0 ? "H" : curv > 0 ? "T" : "S", col });
        }
      }
      if (sp.inflection) {
        const d2 = deriv(deriv(f, h * 10), h * 10);
        for (const x of signChanges(d2, s.xmin, s.xmax, Math.round(n / 2), tol2)) {
          const y = f(x);
          if (Number.isFinite(y)) marks.push({ x, y, label: "W", col });
        }
      }
      if (sp.yint && s.xmin <= 0 && s.xmax >= 0) {
        const y = f(0);
        if (Number.isFinite(y)) marks.push({ x: 0, y, label: "S" + (s.fns.length > 1 ? nm : "") + "y", col });
      }
      if (sp.cross) {
        for (let j = i + 1; j < compiled.length; j++) {
          const g = compiled[j];
          if (!g) continue;
          for (const x of signChanges((t) => f(t) - g(t), s.xmin, s.xmax, n)) {
            const y = f(x);
            if (Number.isFinite(y)) marks.push({ x, y, label: "S", col: "#202124" });
          }
        }
      }
    });
    // Nummern fuer mehrere gleichnamige Punkte (H1, H2 ...)
    const counts = {};
    for (const m of marks) counts[m.label] = (counts[m.label] || 0) + 1;
    const seen = {};
    for (const m of marks) {
      if (counts[m.label] > 1 && !/[₀-₉]$/.test(m.label)) {
        seen[m.label] = (seen[m.label] || 0) + 1;
        m.label += sub(seen[m.label], 2);
      }
    }
    const allPts = marks.concat(
      (s.points || []).filter((q) => Number.isFinite(+q.x) && Number.isFinite(+q.y)).map((q) => ({ x: +q.x, y: +q.y, label: q.label || "", col: q.color || "#d93025", own: true }))
    );
    for (const m of allPts) {
      if (m.x < s.xmin - 1e-9 || m.x > s.xmax + 1e-9 || m.y < s.ymin - 1e-9 || m.y > s.ymax + 1e-9) continue;
      const px = X(m.x), py = Y(m.y);
      if (m.own && s.guides) {
        c.strokeStyle = hexA(m.col, 0.75);
        c.lineWidth = 0.25;
        c.setLineDash([1.2, 1]);
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(px, ax);
        c.moveTo(px, py);
        c.lineTo(ay, py);
        c.stroke();
        c.setLineDash([]);
      }
      c.fillStyle = m.col;
      c.strokeStyle = "#ffffff";
      c.lineWidth = 0.35;
      c.beginPath();
      c.arc(px, py, 1.1, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      let text = m.label || "";
      if (sp.coords || m.own) text += (text ? "" : "") + "(" + fmt(m.x) + " | " + fmt(m.y) + ")";
      if (!text) continue;
      c.font = font(s.font * 0.92, 600);
      c.fillStyle = darken(m.col);
      const right = px < R - 22;
      c.textAlign = right ? "left" : "right";
      c.textBaseline = py > T + 6 ? "bottom" : "top";
      halo(c, text, px + (right ? 1.6 : -1.6), py + (py > T + 6 ? -1.2 : 1.2));
    }

    // Legende (Funktionsterme)
    const named = s.fns.filter((f, i) => compiled[i]);
    if (s.legend && named.length) {
      c.font = font(s.font, 600);
      let y = T + 2;
      for (const fd of named) {
        const text = (fd.name || "f") + "(x) = " + prettyExpr(fd.expr);
        const w = c.measureText(text).width;
        const x0 = R - w - 7;
        c.fillStyle = "rgba(255,255,255,0.9)";
        c.fillRect(x0 - 1.5, y - 0.5, w + 8.5, s.font + 2);
        c.strokeStyle = fd.color;
        c.lineWidth = fd.width;
        c.setLineDash(dashOf(fd.dash, fd.width));
        c.beginPath();
        c.moveTo(x0, y + s.font / 2 + 0.5);
        c.lineTo(x0 + 4, y + s.font / 2 + 0.5);
        c.stroke();
        c.setLineDash([]);
        c.fillStyle = darken(fd.color);
        c.textAlign = "left";
        c.textBaseline = "top";
        c.fillText(text, x0 + 5.5, y + 0.4);
        y += s.font + 2.5;
      }
    }
    // Titel
    if (s.title) {
      c.font = font(s.font * 1.35, 700);
      c.fillStyle = "#202124";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(s.title, G.wMM / 2, 6.5);
    }
    return { canvas: cv, wMM: G.wMM, hMM: G.hMM };
  }
  function halo(c, text, x, y) {
    const fill = c.fillStyle;
    c.lineWidth = 1.1;
    c.strokeStyle = "rgba(255,255,255,0.92)";
    c.lineJoin = "round";
    c.strokeText(text, x, y);
    c.fillStyle = fill;
    c.fillText(text, x, y);
  }
  function sub(n, total) {
    if (total <= 1) return "";
    return String(n).replace(/\d/g, (d) => "₀₁₂₃₄₅₆₇₈₉"[d]);
  }
  function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "rgba(26,115,232," + a + ")";
    const n = parseInt(m[1], 16);
    return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  function darken(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#202124";
    const n = parseInt(m[1], 16);
    const f = 0.8;
    return "rgb(" + Math.round((n >> 16) * f) + "," + Math.round(((n >> 8) & 255) * f) + "," + Math.round((n & 255) * f) + ")";
  }
  function prettyExpr(e) {
    return normalize(e).replace(/\*/g, "·").replace(/\^2(?!\d)/g, "²").replace(/\^3(?!\d)/g, "³").replace(/\./g, ",").replace(/sqrt/g, "√").replace(/pi/g, "π");
  }

  // ---------- Fenster ----------
  let dlg = null;
  let state = null;
  let doneCb = null;
  let editing = false;
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function build() {
    dlg = el("div", "kd-scrim hidden");
    dlg.innerHTML = `
      <div class="kd-card" role="dialog" aria-label="Koordinatensystem">
        <div class="kd-head">
          <span class="kd-title">Koordinatensystem</span>
          <div class="kd-head-btns">
            <button type="button" class="kd-btn kd-cancel">Abbrechen</button>
            <button type="button" class="kd-btn primary kd-ok">Einfügen</button>
          </div>
        </div>
        <div class="kd-body">
          <div class="kd-preview-wrap"><canvas class="kd-preview"></canvas><div class="kd-size"></div></div>
          <div class="kd-side">
            <div class="kd-tabs" role="tablist">
              <button type="button" class="kd-tab active" data-tab="axes"><span class="material-symbols-rounded">straighten</span>Achsen</button>
              <button type="button" class="kd-tab" data-tab="fns"><span class="material-symbols-rounded">show_chart</span>Funktionen</button>
              <button type="button" class="kd-tab" data-tab="pts"><span class="material-symbols-rounded">scatter_plot</span>Punkte</button>
              <button type="button" class="kd-tab" data-tab="look"><span class="material-symbols-rounded">palette</span>Aussehen</button>
            </div>
            <div class="kd-panel"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("pointerdown", (e) => e.stopPropagation());
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.querySelector(".kd-cancel").addEventListener("click", () => close(null));
    dlg.querySelector(".kd-ok").addEventListener("click", () => close(state));
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close(null);
    });
    dlg.querySelectorAll(".kd-tab").forEach((t) =>
      t.addEventListener("click", () => {
        dlg.querySelectorAll(".kd-tab").forEach((x) => x.classList.toggle("active", x === t));
        renderPanel(t.dataset.tab);
      })
    );
  }
  let previewTimer = 0;
  function preview() {
    cancelAnimationFrame(previewTimer);
    previewTimer = requestAnimationFrame(() => {
      const wrap = dlg.querySelector(".kd-preview-wrap");
      const cv = dlg.querySelector(".kd-preview");
      const G = geometry(state);
      const maxW = wrap.clientWidth - 24;
      const maxH = wrap.clientHeight - 48;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const k = Math.max(0.5, Math.min(maxW / G.wMM, maxH / G.hMM));
      render(state, k * dpr, { canvas: cv });
      cv.style.width = Math.round(G.wMM * k) + "px";
      cv.style.height = Math.round(G.hMM * k) + "px";
      dlg.querySelector(".kd-size").textContent = fmt(G.wMM / 10, 1) + " × " + fmt(G.hMM / 10, 1) + " cm  ·  1 Einheit = " + fmt(state.unit / 10, 2) + " cm";
    });
  }
  const parseNum = (v, d) => {
    const n = parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : d;
  };
  // kleine Bausteine
  function row(label, ctrl, hint) {
    const r = el("div", "kd-row");
    const l = el("label", "kd-label");
    l.textContent = label;
    r.appendChild(l);
    r.appendChild(ctrl);
    if (hint) {
      const h = el("div", "kd-hint");
      h.textContent = hint;
      r.appendChild(h);
    }
    return r;
  }
  function numInput(val, on, opt) {
    const i = el("input", "kd-num");
    i.type = "text";
    i.inputMode = "decimal";
    i.value = String(val).replace(".", ",");
    if (opt && opt.ph) i.placeholder = opt.ph;
    i.addEventListener("input", () => {
      on(i.value);
      preview();
    });
    return i;
  }
  function stepper(val, on, step, min, max, fmtFn) {
    const w = el("div", "kd-stepper");
    const minus = el("button", "kd-step", '<span class="material-symbols-rounded">remove</span>');
    const plus = el("button", "kd-step", '<span class="material-symbols-rounded">add</span>');
    minus.type = plus.type = "button";
    const v = el("span", "kd-step-val");
    let cur = val;
    const show = () => (v.textContent = fmtFn ? fmtFn(cur) : fmt(cur));
    const set = (n) => {
      cur = Math.max(min, Math.min(max, Math.round(n * 1000) / 1000));
      show();
      on(cur);
      preview();
    };
    minus.addEventListener("click", () => set(cur - step));
    plus.addEventListener("click", () => set(cur + step));
    show();
    w.append(minus, v, plus);
    return w;
  }
  function toggle(val, on) {
    const b = el("button", "kd-toggle" + (val ? " on" : ""), "<span></span>");
    b.type = "button";
    b.addEventListener("click", () => {
      val = !val;
      b.classList.toggle("on", val);
      on(val);
      preview();
    });
    return b;
  }
  function seg(options, val, on) {
    const w = el("div", "kd-seg");
    for (const [v, label] of options) {
      const b = el("button", "kd-seg-btn" + (v === val ? " active" : ""));
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => {
        w.querySelectorAll(".kd-seg-btn").forEach((x) => x.classList.toggle("active", x === b));
        on(v);
        preview();
      });
      w.appendChild(b);
    }
    return w;
  }
  function colorDots(val, on) {
    const w = el("div", "kd-colors");
    for (const col of COLORS) {
      const b = el("button", "kd-color" + (col === val ? " active" : ""));
      b.type = "button";
      b.style.background = col;
      b.addEventListener("click", () => {
        w.querySelectorAll(".kd-color").forEach((x) => x.classList.toggle("active", x === b));
        on(col);
        preview();
      });
      w.appendChild(b);
    }
    return w;
  }
  function textInput(val, on, ph) {
    const i = el("input", "kd-text");
    i.type = "text";
    i.value = val || "";
    i.placeholder = ph || "";
    i.addEventListener("input", () => {
      on(i.value);
      preview();
    });
    return i;
  }
  function section(title) {
    const s = el("div", "kd-sec");
    const h = el("div", "kd-sec-title");
    h.textContent = title;
    s.appendChild(h);
    return s;
  }

  function renderPanel(tab) {
    const p = dlg.querySelector(".kd-panel");
    p.innerHTML = "";
    p.dataset.tab = tab;
    const s = state;
    if (tab === "axes") {
      const pre = section("Vorlagen");
      const chips = el("div", "kd-chips");
      for (const pr of PRESETS) {
        const b = el("button", "kd-chip");
        b.type = "button";
        b.textContent = pr.name;
        b.addEventListener("click", () => {
          const keep = { unit: s.unit, grid: s.grid, title: s.title, font: s.font, lineWidth: s.lineWidth };
          state = mergeSpec(defaults(), Object.assign({}, keep, pr.spec));
          renderPanel("axes");
          preview();
        });
        chips.appendChild(b);
      }
      pre.appendChild(chips);
      p.appendChild(pre);

      const rng = section("Bereich");
      const xr = el("div", "kd-pair");
      xr.append(numInput(s.xmin, (v) => (s.xmin = Math.min(parseNum(v, s.xmin), s.xmax - 0.5))), el("span", "kd-to", "bis"), numInput(s.xmax, (v) => (s.xmax = Math.max(parseNum(v, s.xmax), s.xmin + 0.5))));
      rng.appendChild(row("x von", xr));
      const yr = el("div", "kd-pair");
      yr.append(numInput(s.ymin, (v) => (s.ymin = Math.min(parseNum(v, s.ymin), s.ymax - 0.5))), el("span", "kd-to", "bis"), numInput(s.ymax, (v) => (s.ymax = Math.max(parseNum(v, s.ymax), s.ymin + 0.5))));
      rng.appendChild(row("y von", yr));
      rng.appendChild(
        row(
          "1 Einheit",
          seg([[5, "0,5 cm"], [10, "1 cm"], [15, "1,5 cm"], [20, "2 cm"]], s.unit, (v) => (s.unit = v)),
          "Auf karierten Seiten passen 0,5 / 1 / 1,5 / 2 cm genau auf die Kästchen"
        )
      );
      p.appendChild(rng);

      const ax = section("Achsen");
      ax.appendChild(row("Zahlen an den Achsen", toggle(s.labels, (v) => (s.labels = v))));
      ax.appendChild(row("Schritt x", stepper(s.xstep, (v) => (s.xstep = v), 0.5, 0.5, 50)));
      ax.appendChild(row("Schritt y", stepper(s.ystep, (v) => (s.ystep = v), 0.5, 0.5, 50)));
      ax.appendChild(row("x-Achse in π", toggle(s.xpi, (v) => (s.xpi = v)), "Für Sinus/Kosinus: π/2, π, 3π/2 …"));
      ax.appendChild(row("Pfeile", toggle(s.arrows, (v) => (s.arrows = v))));
      ax.appendChild(row("„0“ am Ursprung", toggle(s.origin0, (v) => (s.origin0 = v))));
      const names = el("div", "kd-pair");
      names.append(textInput(s.xname, (v) => (s.xname = v), "x"), textInput(s.yname, (v) => (s.yname = v), "y"));
      ax.appendChild(row("Achsennamen", names));
      p.appendChild(ax);

      const gr = section("Gitter");
      gr.appendChild(row("Gitter", seg([["mm5", "Kästchen"], ["unit", "Pro Einheit"], ["none", "Aus"]], s.grid, (v) => (s.grid = v))));
      gr.appendChild(row("Kräftiger", toggle(s.gridStrong, (v) => (s.gridStrong = v))));
      p.appendChild(gr);
    } else if (tab === "fns") {
      const sec = section("Funktionen");
      s.fns.forEach((fd, i) => {
        const card = el("div", "kd-fn");
        const top = el("div", "kd-fn-top");
        const name = el("span", "kd-fn-name");
        name.textContent = (fd.name || "f") + "(x) =";
        name.style.color = darken(fd.color);
        const inp = textInput(fd.expr, (v) => {
          fd.expr = v;
          check();
        }, "z. B. 0,5x² - 2x + 1");
        inp.classList.add("kd-expr");
        const del = el("button", "kd-icon-btn", '<span class="material-symbols-rounded">delete</span>');
        del.type = "button";
        del.title = "Funktion entfernen";
        del.addEventListener("click", () => {
          s.fns.splice(i, 1);
          if (s.area.fn >= s.fns.length) s.area.fn = 0;
          renderPanel("fns");
          preview();
        });
        top.append(name, inp, del);
        const err = el("div", "kd-err");
        const check = () => {
          try {
            if (fd.expr.trim()) compile(fd.expr);
            err.textContent = "";
            inp.classList.remove("bad");
          } catch (e) {
            err.textContent = "Formel nicht verstanden";
            inp.classList.add("bad");
          }
        };
        check();
        card.append(top, err);
        card.appendChild(colorDots(fd.color, (v) => {
          fd.color = v;
          name.style.color = darken(v);
        }));
        const opts = el("div", "kd-fn-opts");
        opts.append(
          seg([["solid", "———"], ["dash", "– – –"], ["dot", "· · ·"]], fd.dash, (v) => (fd.dash = v)),
          stepper(fd.width, (v) => (fd.width = v), 0.2, 0.2, 2, (v) => fmt(v, 1) + " mm")
        );
        card.appendChild(opts);
        sec.appendChild(card);
      });
      const add = el("button", "kd-add", '<span class="material-symbols-rounded">add</span>Funktion hinzufügen');
      add.type = "button";
      add.addEventListener("click", () => {
        const i = s.fns.length;
        s.fns.push({ expr: "", color: COLORS[i % COLORS.length], width: 0.6, dash: "solid", name: "fghkpq"[i] || "f" });
        renderPanel("fns");
        const all = dlg.querySelectorAll(".kd-expr");
        if (all.length) all[all.length - 1].focus();
      });
      sec.appendChild(add);
      const help = el("div", "kd-hint");
      help.textContent = "Schreibweise: x^2 oder x², 2x, sqrt(x) bzw. √x, sin(x), ln(x), e^x, pi, Kommazahlen mit Komma.";
      sec.appendChild(help);
      p.appendChild(sec);

      const spc = section("Besondere Punkte einzeichnen");
      const sp = s.special;
      spc.appendChild(row("Nullstellen (N)", toggle(sp.zeros, (v) => (sp.zeros = v))));
      spc.appendChild(row("Hoch-/Tiefpunkte (H/T)", toggle(sp.extrema, (v) => (sp.extrema = v))));
      spc.appendChild(row("Wendepunkte (W)", toggle(sp.inflection, (v) => (sp.inflection = v))));
      spc.appendChild(row("Schnitt mit y-Achse", toggle(sp.yint, (v) => (sp.yint = v))));
      spc.appendChild(row("Schnittpunkte der Graphen", toggle(sp.cross, (v) => (sp.cross = v))));
      spc.appendChild(row("Koordinaten dazuschreiben", toggle(sp.coords, (v) => (sp.coords = v))));
      p.appendChild(spc);

      const ar = section("Fläche unter dem Graphen");
      ar.appendChild(row("Fläche zeigen", toggle(s.area.on, (v) => (s.area.on = v)), "Mit Flächeninhalt A (Integral)"));
      if (s.fns.length > 1) ar.appendChild(row("Funktion", seg(s.fns.map((f, i) => [i, (f.name || "f") + "(x)"]), s.area.fn, (v) => (s.area.fn = v))));
      const ab = el("div", "kd-pair");
      ab.append(numInput(s.area.a, (v) => (s.area.a = parseNum(v, s.area.a))), el("span", "kd-to", "bis"), numInput(s.area.b, (v) => (s.area.b = parseNum(v, s.area.b))));
      ar.appendChild(row("von x =", ab));
      p.appendChild(ar);
    } else if (tab === "pts") {
      const sec = section("Eigene Punkte");
      s.points.forEach((q, i) => {
        const card = el("div", "kd-pt");
        const nm = textInput(q.label, (v) => (q.label = v), "A");
        nm.classList.add("kd-pt-name");
        const xs = numInput(q.x, (v) => (q.x = parseNum(v, q.x)));
        const ys = numInput(q.y, (v) => (q.y = parseNum(v, q.y)));
        const del = el("button", "kd-icon-btn", '<span class="material-symbols-rounded">delete</span>');
        del.type = "button";
        del.addEventListener("click", () => {
          s.points.splice(i, 1);
          renderPanel("pts");
          preview();
        });
        card.append(nm, el("span", "kd-to", "("), xs, el("span", "kd-to", "|"), ys, el("span", "kd-to", ")"), del);
        sec.appendChild(card);
        sec.appendChild(colorDots(q.color, (v) => (q.color = v)));
      });
      const add = el("button", "kd-add", '<span class="material-symbols-rounded">add</span>Punkt hinzufügen');
      add.type = "button";
      add.addEventListener("click", () => {
        const names = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        s.points.push({ x: 1, y: 1, label: names[s.points.length % 26], color: "#d93025" });
        renderPanel("pts");
        preview();
      });
      sec.appendChild(add);
      sec.appendChild(row("Hilfslinien zu den Achsen", toggle(s.guides, (v) => (s.guides = v))));
      p.appendChild(sec);
    } else if (tab === "look") {
      const sec = section("Aussehen");
      sec.appendChild(row("Überschrift", textInput(s.title, (v) => (s.title = v), "optional")));
      sec.appendChild(row("Funktionsterme als Legende", toggle(s.legend, (v) => (s.legend = v))));
      sec.appendChild(row("Schriftgröße", seg([[2.6, "Klein"], [3.2, "Mittel"], [4, "Groß"]], s.font, (v) => (s.font = v))));
      sec.appendChild(row("Achsen-Strichstärke", seg([[0.35, "Fein"], [0.5, "Normal"], [0.8, "Kräftig"]], s.lineWidth, (v) => (s.lineWidth = v))));
      p.appendChild(sec);
    }
  }
  function open(spec, onDone) {
    if (!dlg) build();
    editing = !!spec;
    state = mergeSpec(defaults(), spec || {});
    doneCb = onDone;
    dlg.querySelector(".kd-ok").textContent = editing ? "Übernehmen" : "Einfügen";
    dlg.querySelectorAll(".kd-tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === "axes"));
    renderPanel("axes");
    dlg.classList.remove("hidden");
    requestAnimationFrame(preview);
  }
  function close(result) {
    dlg.classList.add("hidden");
    const cb = doneCb;
    doneCb = null;
    if (cb && result) cb(JSON.parse(JSON.stringify(result)));
  }
  window.addEventListener("resize", () => dlg && !dlg.classList.contains("hidden") && preview());

  window.SofiaKoord = { open, render, compile, geometry, defaults, mergeSpec, isOpen: () => !!dlg && !dlg.classList.contains("hidden") };
})();
