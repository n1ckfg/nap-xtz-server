/*
The measuring end of the harness: runs public/js/telidon/naplps.js — the
browser's own encoder AND decoder, unmodified — in a vm context, so a candidate
geometry is scored against the code that will actually carry it.

`--encoder round|truncate` rewrites makeNapVector2's quantisation while
measuring, whichever way naplps.js currently has it, which is how the drift
columns separate what the geometry costs from what the encoder costs. Rounding
is the accurate one: truncation always shortens a delta, and since every point
after the first is a delta, that error marches one way along a polygon.

Polygons are rasterised here rather than by tools/thumbnail-maker/raster.mjs
because the scoring needs two things that renderer has no reason to offer: a
plain coverage mask to compare with, and the even-odd winding rule, which is
what an openFrameworks fill uses where a canvas fill uses nonzero.
*/
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const NAPLPS_JS = path.resolve(here, "../../public/js/telidon/naplps.js");

// Both forms of the quantisation live in naplps.js, one of them commented out;
// which one is live has changed over the file's history, so match on the live
// pair (a commented line can't start with `const`) rather than on fixed text.
const QUANTISERS = {
  truncate: {
    live: /^([ \t]*)const int([XY]) = parseInt\(Math\.abs\(input\.[xy]\) \* this\.maxBitVals\);$/gm,
    write: (indent, axis) =>
      `${indent}const int${axis} = parseInt(Math.abs(input.${axis.toLowerCase()}) * this.maxBitVals);`
  },
  round: {
    live: /^([ \t]*)const int([XY]) = Math\.min\(this\.maxBitVals - 1, Math\.round\(Math\.abs\(input\.[xy]\) \* this\.maxBitVals\)\);$/gm,
    write: (indent, axis) =>
      `${indent}const int${axis} = Math.min(this.maxBitVals - 1, ` +
      `Math.round(Math.abs(input.${axis.toLowerCase()}) * this.maxBitVals));`
  }
};

/** Which quantisation naplps.js is currently built with. */
export function encoderInFile() {
  const source = fs.readFileSync(NAPLPS_JS, "utf8");
  for (const [name, form] of Object.entries(QUANTISERS)) {
    form.live.lastIndex = 0;
    if (form.live.test(source)) return name;
  }
  return "unknown";
}

const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
const scripts = new Map();

// p5's int(): booleans become 1/0, everything else truncates toward zero.
function int(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : 0;
}

function scriptFor(encoder) {
  if (!scripts.has(encoder)) {
    let source = fs.readFileSync(NAPLPS_JS, "utf8");

    if (encoder !== "file") {
      const wanted = QUANTISERS[encoder];
      if (!wanted) throw new Error(`unknown encoder "${encoder}": expected round or truncate`);

      const from = encoder === "round" ? QUANTISERS.truncate : QUANTISERS.round;
      from.live.lastIndex = 0;
      source = source.replace(from.live, (_, indent, axis) => wanted.write(indent, axis));

      wanted.live.lastIndex = 0;
      if (!wanted.live.test(source)) {
        throw new Error(`could not switch makeNapVector2 to ${encoder} in ${NAPLPS_JS}`);
      }
    }
    scripts.set(encoder, new vm.Script(source, { filename: NAPLPS_JS }));
  }
  return scripts.get(encoder);
}

/**
 * A fresh naplps.js context. The decoder keeps its parser state in module-level
 * variables, so one encode or decode must not inherit another's.
 * @param {{encoder?: "file"|"round"|"truncate"}} options
 */
export function napContext({ encoder = "file" } = {}) {
  const sandbox = { console: quiet, pow: Math.pow, int, window: {} };
  scriptFor(encoder).runInContext(vm.createContext(sandbox));
  return sandbox.window;
}

/**
 * @param {{color: number[], points: {x: number, y: number}[]}[]} polys - 0..1 space, y down
 * @returns {string} NAPLPS text
 */
export function encodePolys(polys, { encoder = "file" } = {}) {
  const w = napContext({ encoder });
  const input = polys.map(
    (p) =>
      new w.NapInputWrapper(
        new w.Vector3(p.color[0], p.color[1], p.color[2]),
        p.points.map((pt) => new w.Vector2(pt.x, pt.y)), // the encoder mutates these
        true
      )
  );
  return new w.NapEncoder(input).napRaw;
}

/**
 * @returns {{id: string, points: {x: number, y: number}[]}[]} The POLY commands, in order
 */
export function decodePolys(napRaw, { encoder = "file" } = {}) {
  const w = napContext({ encoder });
  return new w.NapDecoder([napRaw]).cmds
    .filter((cmd) => cmd.opcode && cmd.opcode.id.includes("POLY"))
    .map((cmd) => ({ id: cmd.opcode.id, points: cmd.points.map((p) => ({ x: p.x, y: p.y })) }));
}

/* ── rasterising ───────────────────────────────────────────────────────── */
export const ART = 640; // index.html maps the unit square onto 640 artwork units

function span(mask, y, xa, xb, size) {
  const a = Math.max(0, Math.round(xa));
  const b = Math.min(size - 1, Math.round(xb) - 1);
  for (let x = a; x <= b; x++) mask[y * size + x] = 1;
}

// One polygon's coverage, unioned into `mask` the way a renderer paints each
// POLY FILLED over what is already on screen.
function fillInto(mask, poly, size, rule) {
  if (poly.length < 3) return;
  const pts = poly.map((p) => [p.x * size, p.y * size]);
  const ys = pts.map((p) => p[1]);
  const yStart = Math.max(0, Math.floor(Math.min(...ys)));
  const yEnd = Math.min(size - 1, Math.ceil(Math.max(...ys)));

  for (let y = yStart; y <= yEnd; y++) {
    const yc = y + 0.5;
    const crossings = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if (ay === by || yc < Math.min(ay, by) || yc >= Math.max(ay, by)) continue;
      crossings.push({ x: ax + ((yc - ay) / (by - ay)) * (bx - ax), dir: by > ay ? 1 : -1 });
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a.x - b.x);

    if (rule === "evenodd") {
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        span(mask, y, crossings[i].x, crossings[i + 1].x, size);
      }
      continue;
    }
    let winding = 0;
    let spanStart = 0;
    for (const c of crossings) {
      const before = winding;
      winding += c.dir;
      if (before === 0 && winding !== 0) spanStart = c.x;
      else if (before !== 0 && winding === 0) span(mask, y, spanStart, c.x, size);
    }
  }
}

/**
 * @param {{x: number, y: number}[][]} polys
 * @param {{size?: number, rule?: "nonzero"|"evenodd", clip?: boolean}} options
 * @returns {Uint8Array} One byte per pixel, 1 where the polygons cover
 */
export function maskOf(polys, { size = ART, rule = "nonzero", clip = true } = {}) {
  const mask = new Uint8Array(size * size);
  for (const poly of polys) {
    // TelidonP5 and Telidon.cpp both drop a decoded point outside the unit square
    const pts = clip ? poly.filter((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) : poly;
    fillInto(mask, pts, size, rule);
  }
  return mask;
}

/**
 * Intersection over union: 1 is identical coverage, 0 is no overlap at all
 */
export function iou(a, b) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] | b[i]) union++;
    if (a[i] & b[i]) intersection++;
  }
  return union === 0 ? 1 : intersection / union;
}

/* ── geometry checks ───────────────────────────────────────────────────── */
function segmentsCross(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/**
 * How many times a closed polygon crosses itself. Anything above zero is a shape
 * whose filled area depends on the renderer's winding rule.
 */
export function selfIntersections(poly) {
  let count = 0;
  for (let i = 0; i < poly.length; i++) {
    for (let j = i + 2; j < poly.length; j++) {
      if (i === 0 && j === poly.length - 1) continue; // adjacent through the closing edge
      if (segmentsCross(poly[i], poly[(i + 1) % poly.length], poly[j], poly[(j + 1) % poly.length])) {
        count++;
      }
    }
  }
  return count;
}

/* ── scoring one candidate ─────────────────────────────────────────────── */
/**
 * Encodes a candidate's polygons, decodes them back, and reports what survived.
 *
 * @param {{color: number[], points: {x: number, y: number}[]}[]} polys
 * @param {Uint8Array} referenceMask - the ideal brush, from brushReference()
 * @returns {object} Counts, byte size, drift, and three fidelity ratios
 */
export function score(polys, referenceMask, { encoder = "file" } = {}) {
  const napRaw = encodePolys(polys, { encoder });
  const decoded = decodePolys(napRaw, { encoder });

  // Drift: how far a decoded vertex sits from the one we asked for, in artwork pixels
  let maxDrift = 0;
  let points = 0;
  for (let i = 0; i < polys.length; i++) {
    const want = polys[i].points;
    const got = decoded[i] ? decoded[i].points : [];
    points += want.length;
    for (let j = 0; j < Math.min(want.length, got.length); j++) {
      maxDrift = Math.max(maxDrift, Math.hypot(want[j].x - got[j].x, want[j].y - got[j].y) * ART);
    }
  }

  const dropped = decoded.reduce(
    (n, cmd) => n + cmd.points.filter((p) => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1).length,
    0
  );
  const crossings = polys.reduce((n, p) => n + selfIntersections(p.points), 0);

  const shapes = decoded.map((cmd) => cmd.points);
  const nonzero = maskOf(shapes, { rule: "nonzero" });
  const evenodd = maskOf(shapes, { rule: "evenodd" });
  const intended = maskOf(polys.map((p) => p.points), { rule: "nonzero" });

  return {
    polys: polys.length,
    points,
    bytes: napRaw.length,
    maxDrift,
    dropped,
    crossings,
    roundTrip: iou(nonzero, intended), // encoder fidelity: what came back vs what went in
    shape: iou(nonzero, referenceMask), // brush fidelity: what came back vs the ideal brush
    ruleAgreement: iou(nonzero, evenodd), // renderer safety: canvas fill vs even-odd fill
    napRaw,
  };
}
