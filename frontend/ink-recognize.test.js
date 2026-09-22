"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
require("./de-words.js");
const SofiaInk = require("./ink-recognize.js");

function pt(x, y) {
  return { x, y, p: 0.5 };
}

function stroke(id, points, extra) {
  return {
    id,
    tool: "pen",
    size: 6,
    color: "#111",
    points,
    bbox: SofiaInk.bboxOfPoints(points),
    ...extra,
  };
}

function line(id, x0, y0, x1, y1, n) {
  const pts = [];
  const steps = n || 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push(pt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t));
  }
  return stroke(id, pts);
}

test("mouse diagonal strikethrough is accepted", () => {
  const pts = [pt(0, 0), pt(6, 5), pt(13, 12), pt(22, 20)];
  assert.equal(SofiaInk.looksLikeStrikeGesture(pts, "mouse"), true);
  assert.equal(SofiaInk.looksLikeStrikeGesture(pts, "pen"), false);
});

test("pen still needs a longer strike", () => {
  const pts = [pt(0, 0), pt(10, 1), pt(20, 2), pt(40, 3), pt(55, 4)];
  assert.equal(SofiaInk.looksLikeStrikeGesture(pts, "pen"), true);
});

test("tiny mouse tick is not a strike", () => {
  const pts = [pt(0, 0), pt(2, 1), pt(4, 2)];
  assert.equal(SofiaInk.looksLikeStrikeGesture(pts, "mouse"), false);
});

test("mouse scribble with two reversals erases", () => {
  const pts = [pt(0, 0), pt(24, 6), pt(48, 0), pt(24, -6), pt(0, 2), pt(20, 8)];
  assert.equal(SofiaInk.looksLikeStrikeGesture(pts, "mouse"), true);
});

test("handwritten 7 is not a desktop strike", () => {
  const pts = [pt(0, 0), pt(22, 0), pt(20, 2), pt(4, 32)];
  assert.equal(SofiaInk.looksLikeStrikeGesture(pts, "mouse"), false);
});

test("solve plain arithmetic", () => {
  assert.equal(SofiaInk.solveMath("12+34").text, "46");
  assert.equal(SofiaInk.solveMath("12+34=").text, "46");
  assert.equal(SofiaInk.solveMath("2×3").text, "6");
  assert.equal(SofiaInk.solveMath("8/2").text, "4");
  assert.equal(SofiaInk.solveMath("(1+2)*3").text, "9");
  assert.equal(SofiaInk.solveMath("2^8").text, "256");
  assert.equal(SofiaInk.solveMath("10-3-2").text, "5");
  assert.equal(SofiaInk.parseMath("-4+9"), 5);
});

test("words are not solved", () => {
  assert.equal(SofiaInk.solveMath("Hallo"), null);
  assert.equal(SofiaInk.solveMath("abc"), null);
});

test("implicit multiply via x", () => {
  assert.ok(SofiaInk.looksLikeMath("2x3"));
  assert.equal(SofiaInk.solveMath("2x3").text, "6");
});

test("minus glyph is detected geometrically", () => {
  const g = { strokes: [line("a", 0, 20, 40, 20)] };
  const op = SofiaInk.detectOperator(g);
  assert.ok(op);
  assert.equal(op.char, "-");
});

test("equals is two stacked bars", () => {
  const g = {
    strokes: [line("a", 0, 10, 36, 10), line("b", 0, 22, 36, 22)],
  };
  const op = SofiaInk.detectOperator(g);
  assert.equal(op.char, "=");
});

test("plus is a cross", () => {
  const g = {
    strokes: [line("h", 0, 20, 30, 20), line("v", 15, 5, 15, 35)],
  };
  const op = SofiaInk.detectOperator(g);
  assert.equal(op.char, "+");
});

test("writing burst stops at a pause", () => {
  const a = line("a", 0, 0, 0, 20);
  const b = line("b", 12, 0, 12, 20);
  const c = line("c", 24, 0, 24, 20);
  a.endedAt = 1000;
  b.endedAt = 1500;
  c.endedAt = 5000;
  const burst = SofiaInk.writingBurst([a, b, c], { pauseMs: 2200, now: 5200 });
  assert.equal(burst.map((s) => s.id).join(","), "c");
  const mid = SofiaInk.writingBurst([a, b, c], { pauseMs: 2200, now: 1600 });
  assert.equal(mid.map((s) => s.id).join(","), "a,b");
});

test("ocrLooksPlausible rejects gibberish and keeps real notes", () => {
  assert.equal(SofiaInk.ocrLooksPlausible("Hallo"), true);
  assert.equal(SofiaInk.ocrLooksPlausible("Hausaufgaben"), true);
  assert.equal(SofiaInk.ocrLooksPlausible("12+34="), true);
  assert.equal(SofiaInk.ocrLooksPlausible("MHL"), false);
  assert.equal(SofiaInk.ocrLooksPlausible("xqz"), false);
  assert.equal(SofiaInk.ocrLooksPlausible("12+"), false);
  assert.equal(SofiaInk.ocrLooksPlausible("f", { strokes: 8 }), false);
  assert.equal(SofiaInk.ocrLooksPlausible("4", { strokes: 1 }), true);
});

test("cluster blocks keep stacked text and math, split far ink", () => {
  const top = line("t", 0, 0, 40, 0, 4);
  const bot = line("m", 8, 28, 36, 28, 4);
  const far = line("f", 220, 0, 250, 0, 4);
  const blocks = SofiaInk.clusterBlocks([top, bot, far], 76);
  assert.equal(blocks.length, 2);
});

test("solveFromBurst finds math under words", () => {
  assert.equal(SofiaInk.solveFromBurst("Haus √9").text, "3");
  assert.equal(SofiaInk.solveFromBurst("12+34=").text, "46");
});

test("stacked lines read left-to-right top-to-bottom", () => {
  const hi = [
    { char: "H", bbox: { minX: 40, minY: 0, maxX: 52, maxY: 16 } },
    { char: "i", bbox: { minX: 54, minY: 0, maxX: 60, maxY: 16 } },
  ];
  const welt = [
    { char: "W", bbox: { minX: 2, minY: 36, maxX: 18, maxY: 52 } },
    { char: "e", bbox: { minX: 20, minY: 36, maxX: 30, maxY: 52 } },
  ];
  const layout = SofiaInk.layoutInkOn(hi.concat(welt));
  assert.equal(layout.text, "Hi We");
});

test("stacked math lines concatenate left to right", () => {
  const layout = SofiaInk.layoutInkOn([
    { char: "1", bbox: { minX: 20, minY: 0, maxX: 28, maxY: 14 } },
    { char: "2", bbox: { minX: 30, minY: 0, maxX: 38, maxY: 14 } },
    { char: "+", bbox: { minX: 4, minY: 22, maxX: 14, maxY: 34 } },
    { char: "3", bbox: { minX: 20, minY: 22, maxX: 28, maxY: 34 } },
  ]);
  assert.equal(layout.text, "12+3");
  assert.equal(SofiaInk.solveMath(layout.text).text, "15");
});

test("joinReadingOrder is top-to-bottom then left-to-right", () => {
  const groups = [
    { text: "Welt", bbox: { minX: 0, minY: 40, maxX: 40, maxY: 56 } },
    { text: "Hallo", bbox: { minX: 8, minY: 0, maxX: 50, maxY: 16 } },
  ];
  assert.equal(SofiaInk.joinReadingOrder(groups), "Hallo Welt");
});

test("near misspellings are flagged", () => {
  const hits = SofiaInk.misspelledSpans("Hausaufgabn bitte");
  assert.ok(hits.some((h) => h.word === "Hausaufgabn"));
  assert.ok(!SofiaInk.misspelledSpans("Hallo Schule").length);
});

test("glyphs 2cm apart are separate words", () => {
  const strokes = [line("a", 0, 0, 0, 24, 6), line("b", 200, 0, 200, 24, 6)];
  const groups = SofiaInk.clusterGlyphs(strokes);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].glyphs.length, 1);
  assert.equal(groups[1].glyphs.length, 1);
});

test("word context turns 1 into l among letters", () => {
  const glyphs = [
    { char: "H", alts: [], source: "cnn" },
    { char: "a", alts: [], source: "cnn" },
    { char: "1", alts: ["l"], source: "cnn" },
    { char: "1", alts: ["l"], source: "cnn" },
    { char: "o", alts: [], source: "cnn" },
  ];
  SofiaInk.applyWordContext(glyphs);
  assert.equal(glyphs.map((g) => g.char).join(""), "Hallo");
});

test("math context turns O into 0", () => {
  const glyphs = [
    { char: "1", alts: [], source: "cnn" },
    { char: "+", alts: [], source: "geom", op: { char: "+", confidence: 0.9 } },
    { char: "O", alts: ["0"], source: "cnn" },
  ];
  SofiaInk.applyWordContext(glyphs);
  assert.equal(glyphs[2].char, "0");
});

test("plain digits stay digits without letter neighbors", () => {
  const glyphs = [
    { char: "1", alts: ["l"], source: "cnn" },
    { char: "2", alts: ["Z"], source: "cnn" },
  ];
  SofiaInk.applyWordContext(glyphs);
  assert.equal(glyphs.map((g) => g.char).join(""), "12");
});

test("cloud OCR cleanup keeps German letters", () => {
  assert.equal(SofiaInk.cleanOcrText("Übung Hausaufgaben"), "Übung Hausaufgaben");
});

test("adjacent 7 minus 1 stay three glyphs", () => {
  const strokes = [line("7", 0, 0, 0, 36, 6), line("-", 16, 18, 30, 18, 4), line("1", 46, 0, 46, 36, 6)];
  const groups = SofiaInk.clusterGlyphs(strokes);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].glyphs.length, 3);
});

test("tall thin stroke is a one", () => {
  const g = { strokes: [line("a", 8, 0, 8, 40)] };
  const op = SofiaInk.detectOperator(g);
  assert.ok(op);
  assert.equal(op.char, "1");
});

test("recent filter ignores old strokes without endedAt", () => {
  const old = line("old", 0, 0, 0, 20);
  const neu = line("new", 80, 0, 80, 20);
  neu.endedAt = 5000;
  const scoped = SofiaInk.filterRecentStrokes([old, neu], { now: 5200, windowMs: 12000 });
  assert.ok(scoped.some((s) => s.id === "new"));
  assert.ok(!scoped.some((s) => s.id === "old"));
});

test("cluster groups nearby strokes on one line", () => {
  const strokes = [
    line("1", 0, 0, 0, 24, 6),
    line("2", 18, 0, 18, 24, 6),
    line("3", 0, 80, 20, 80, 5),
  ];
  const groups = SofiaInk.clusterGlyphs(strokes);
  assert.ok(groups.length >= 2);
  const sizes = groups.map((g) => g.glyphs.length).sort((a, b) => b - a);
  assert.equal(sizes[0], 2);
});

test("rasterize returns 28x28 ink", () => {
  const buf = SofiaInk.rasterizeGlyph([line("a", 0, 0, 10, 18)]);
  assert.equal(buf.length, 28 * 28);
  let sum = 0;
  for (const v of buf) sum += v;
  assert.ok(sum > 8);
});

test("k-NN recalls a stored label", () => {
  const pixels = SofiaInk.rasterizeGlyph([line("a", 0, 0, 4, 20)]);
  const examples = [{ label: "1", pixels }];
  const hit = SofiaInk.knnPredict(pixels, examples);
  assert.ok(hit);
  assert.equal(hit.char, "1");
  assert.equal(hit.source, "memory");
});

test("slanted 1 is a one not a slash", () => {
  const g = { strokes: [line("a", 10, 0, 36, 40)] };
  const op = SofiaInk.detectOperator(g);
  assert.ok(op);
  assert.equal(op.char, "1");
});

test("diagonal slash stays a slash", () => {
  const g = { strokes: [line("a", 0, 0, 32, 32)] };
  const op = SofiaInk.detectOperator(g);
  assert.ok(op);
  assert.equal(op.char, "/");
});

test("wobbly minus is still a minus", () => {
  const pts = [];
  for (let i = 0; i <= 14; i++) {
    pts.push(pt(i * 3, 20 + Math.sin(i * 0.9) * 2.2));
  }
  const op = SofiaInk.detectOperator({ strokes: [stroke("m", pts)] });
  assert.ok(op);
  assert.equal(op.char, "-");
});

test("cloud OCR cleanup keeps math and strips chatter", () => {
  assert.equal(SofiaInk.cleanOcrText("The handwritten text says: 12 + 34"), "12+34");
  assert.equal(SofiaInk.cleanOcrText("`7`"), "7");
  assert.equal(SofiaInk.cleanOcrText("Hallo"), "Hallo");
});

test("dense sampled digit still counts as handwriting", () => {
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    pts.push(pt(8, i * 0.2));
  }
  assert.equal(SofiaInk.isLikelyHandwriting(stroke("d", pts)), true);
});

test("sqrt glyph is detected geometrically", () => {
  const pts = [];
  for (let i = 0; i <= 6; i++) pts.push(pt(8 + i, 18 + i * 4));
  for (let i = 1; i <= 14; i++) pts.push(pt(14 + i * 4, 42 - i * 2.1));
  const op = SofiaInk.detectOperator({ strokes: [stroke("r", pts)] });
  assert.ok(op);
  assert.equal(op.char, "√");
});

test("handwritten 7 is not a square root", () => {
  const pts = [pt(0, 0), pt(22, 0), pt(20, 2), pt(4, 32)];
  const op = SofiaInk.detectOperator({ strokes: [stroke("7", pts)] });
  assert.ok(!op || op.char !== "√");
});

test("paren glyphs are detected geometrically", () => {
  const left = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    left.push(pt(18 - Math.sin(t * Math.PI) * 12, 4 + t * 40));
  }
  const right = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    right.push(pt(6 + Math.sin(t * Math.PI) * 12, 4 + t * 40));
  }
  assert.equal(SofiaInk.detectOperator({ strokes: [stroke("lp", left)] }).char, "(");
  assert.equal(SofiaInk.detectOperator({ strokes: [stroke("rp", right)] }).char, ")");
});

test("percent is slash with two dots", () => {
  const g = {
    strokes: [
      line("a", 4, 6, 12, 14, 5),
      line("s", 0, 0, 32, 32, 8),
      line("b", 14, 22, 22, 30, 5),
    ],
  };
  const op = SofiaInk.detectOperator(g);
  assert.equal(op.char, "%");
});

test("stacked minuses cluster and layout as equals", () => {
  const strokes = [line("a", 0, 10, 36, 10, 6), line("b", 1, 24, 35, 24, 6)];
  const groups = SofiaInk.clusterGlyphs(strokes);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].glyphs.length, 1);
  const op = SofiaInk.detectOperator(groups[0].glyphs[0]);
  assert.equal(op.char, "=");
  const layout = SofiaInk.layoutInkOn([
    { char: "-", bbox: { minX: 0, minY: 10, maxX: 36, maxY: 13 }, op: null },
    { char: "-", bbox: { minX: 1, minY: 24, maxX: 35, maxY: 27 }, op: null },
  ]);
  assert.equal(layout.text, "=");
});

test("radicand stays its own glyph under a sqrt bar", () => {
  const rootPts = [];
  for (let i = 0; i <= 6; i++) rootPts.push(pt(8 + i, 18 + i * 4));
  for (let i = 1; i <= 16; i++) rootPts.push(pt(14 + i * 4, 42 - i * 2));
  const strokes = [stroke("r", rootPts), line("n", 40, 22, 40, 40, 6)];
  const groups = SofiaInk.clusterGlyphs(strokes);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].glyphs.length >= 2);
});

test("solve roots percents and pi", () => {
  assert.equal(SofiaInk.solveMath("√9").text, "3");
  assert.equal(SofiaInk.solveMath("√(9+7)").text, "4");
  assert.equal(SofiaInk.solveMath("50%").text, "0.5");
  assert.ok(Math.abs(SofiaInk.parseMath("2π") - 2 * Math.PI) < 1e-6);
  assert.equal(SofiaInk.solveMath("3+4=").text, "7");
  assert.ok(SofiaInk.looksLikeMath("√9"));
  assert.ok(SofiaInk.looksLikeMath("3+4="));
});

test("cloud OCR cleanup keeps roots and equals", () => {
  assert.equal(SofiaInk.cleanOcrText("sqrt 9 = 3"), "√9=3");
  assert.equal(SofiaInk.cleanOcrText("The handwritten text says: 2π"), "2π");
});

test("fraction layout becomes division", () => {
  const num = {
    char: "1",
    bbox: { minX: 10, minY: 0, maxX: 18, maxY: 12 },
    op: null,
  };
  const den = {
    char: "2",
    bbox: { minX: 10, minY: 28, maxX: 18, maxY: 40 },
    op: null,
  };
  const bar = {
    char: "—",
    bbox: { minX: 6, minY: 18, maxX: 22, maxY: 21 },
    op: { fractionBar: true },
  };
  const layout = SofiaInk.layoutInkOn([num, bar, den]);
  assert.equal(layout.text, "(1)/(2)");
  assert.equal(SofiaInk.solveMath(layout.text).text, "0.5");
});
