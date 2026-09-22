"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
