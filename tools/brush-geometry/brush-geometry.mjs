#!/usr/bin/env node
/*
brush-geometry — measures how a drawing-mode brush stroke survives NAPLPS.

    node tools/brush-geometry/brush-geometry.mjs compare
    node tools/brush-geometry/brush-geometry.mjs compare scribble --encoder truncate
    node tools/brush-geometry/brush-geometry.mjs checks
    node tools/brush-geometry/brush-geometry.mjs sheets hairpin depth
    node tools/brush-geometry/brush-geometry.mjs draw
    node tools/brush-geometry/brush-geometry.mjs loss

Every stroke is encoded and decoded by public/js/telidon/naplps.js itself, so
what the table reports is what the browser and the Pi will get.
*/
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import dotenv from "dotenv";

import { Canvas } from "../thumbnail-maker/raster.mjs";
import { renderNap } from "../thumbnail-maker/render.mjs";
import { encodePNG } from "../thumbnail-maker/png.mjs";
import { encodePolys, decodePolys, encoderInFile, maskOf, napContext, score, selfIntersections, ART } from "./naplps.mjs";
import { CANDIDATES, Stroke, brushReference, makeCamera, pieces, project, shipped, widthAxisFor } from "./candidates.mjs";
import { STROKES, buildStroke, selectStrokes, stressStrokes } from "./strokes.mjs";
import { Frame, BRUSH_SIMPLIFY, MIN_STEP, BRUSH_OVERLAP_PASSES } from "../../public/js/drawing/tools.js";
import { readMintLimit } from "../../mint-limit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(here, "out");
const COLOR = [255, 255, 255];

// The mint limit the server holds drawings to, read with the server's own code
// (mint-limit.js): TEZOS_MAX_BYTES from the environment, else from the repo's
// .env (dotenv leaves a variable that is already set alone), else the default.
// --limit overrides it for a run.
const setInShell = Boolean(process.env.TEZOS_MAX_BYTES && process.env.TEZOS_MAX_BYTES.trim());
dotenv.config({ path: path.resolve(here, "../../.env") });
const mintLimit = readMintLimit();
const serverLimit = {
  value: mintLimit.value,   // undefined when the setting won't read -- main() says why
  error: mintLimit.error,
  source: mintLimit.fromDefault ? "the server's default"
        : setInShell ? "TEZOS_MAX_BYTES from the environment"
        : "TEZOS_MAX_BYTES from .env"
};

const USAGE = `Usage: brush-geometry <command> [stroke ...] [options]

Commands:
  compare [stroke ...]   score every candidate geometry against the ideal brush
  checks                 assert the shipped toBrushShapes holds up at the edges
  sheets [stroke ...]    write side-by-side PNGs: ideal, the old outline, shipped
  draw                   draw strokes through a real Frame, end to end, with
                         the byte budget ladder convertToNAPLPS() runs
  loss [stroke ...]      how much of a stroke survives when polygons go missing,
                         at each BRUSH_OVERLAP_PASSES setting
  inspect <file ...>     what a .nap file actually contains: opcodes, points per
                         polygon, operand alignment, off-frame and folded points

Strokes: ${Object.keys(STROKES).join(", ")} (default: all)

Options:
  -e, --encoder <mode>   file (default), round, or truncate — rewrites
                         makeNapVector2's quantisation while measuring
  -o, --out <dir>        where sheets and draw write (default: tools/brush-geometry/out)
  -l, --limit <bytes>    draw: the mint limit to fit under (default: the server's,
                         TEZOS_MAX_BYTES — now ${serverLimit.error ? "unreadable" : serverLimit.value}, ${serverLimit.source})
  -t, --tolerance <n>    draw: where the ladder starts (default: tools.js's
                         BRUSH_SIMPLIFY); 0 is the brush that keeps every point
  -s, --strokes <n>      draw: how many strokes to draw (default: 4)
  -h, --help             show this message

What the columns mean:
  drift px      furthest a decoded vertex landed from the one that was encoded
  dropped       decoded points outside the frame, which both renderers discard
  crossings     times a polygon crosses itself; above zero, the fill depends on
                the renderer's winding rule
  roundtrip     decoded shape vs the shape that went in (1.0 is perfect)
  shape         decoded shape vs the ideal brush, which is the stroke stamped at
                full resolution — a candidate loses ground here by simplifying
  rule-agree    the same decoded shape filled nonzero vs even-odd; below 1.0 the
                drawing looks different in a browser and in openFrameworks
`;

/* ── compare ───────────────────────────────────────────────────────────── */
const HEAD =
  "candidate              polys   pts   bytes  drift px  dropped  crossings  roundtrip   shape  rule-agree";

function row(name, r) {
  return (
    `${name.padEnd(21)} ${String(r.polys).padStart(5)} ${String(r.points).padStart(5)} ` +
    `${String(r.bytes).padStart(7)} ${r.maxDrift.toFixed(1).padStart(9)} ${String(r.dropped).padStart(8)} ` +
    `${String(r.crossings).padStart(10)} ${r.roundTrip.toFixed(3).padStart(10)} ` +
    `${r.shape.toFixed(3).padStart(7)} ${r.ruleAgreement.toFixed(3).padStart(11)}`
  );
}

function compare(names, { encoder }) {
  const camera = makeCamera();
  const totals = new Map(
    CANDIDATES.map(([name]) => [name, { polys: 0, bytes: 0, drift: 0, crossings: 0, roundTrip: 0, shape: 0, agree: 0 }])
  );
  const strokes = selectStrokes(names);

  console.log(`encoder: ${encoder === "file" ? `${encoderInFile()} (as naplps.js has it)` : encoder}`);

  for (const [name, stroke] of strokes) {
    const reference = maskOf(brushReference(stroke, camera).map((p) => p.points), { rule: "nonzero" });
    console.log(`\n## ${name}  (${stroke.points.length} points after refine)`);
    console.log(HEAD);

    for (const [label, build] of CANDIDATES) {
      const polys = build(stroke, camera, COLOR);
      if (polys.length === 0) {
        console.log(`${label.padEnd(21)}  (nothing produced)`);
        continue;
      }
      const result = score(polys, reference, { encoder });
      console.log(row(label, result));

      const total = totals.get(label);
      total.polys += result.polys;
      total.bytes += result.bytes;
      total.drift = Math.max(total.drift, result.maxDrift);
      total.crossings += result.crossings;
      total.roundTrip += result.roundTrip;
      total.shape += result.shape;
      total.agree += result.ruleAgreement;
    }
  }

  console.log(`\n## all ${strokes.length} strokes  (drift is the worst seen, the ratios are means)`);
  console.log(HEAD.replace("  pts   bytes", "        bytes"));
  for (const [label, t] of totals) {
    console.log(
      row(label, {
        polys: t.polys,
        points: "",
        bytes: t.bytes,
        maxDrift: t.drift,
        dropped: "",
        crossings: t.crossings,
        roundTrip: t.roundTrip / strokes.length,
        shape: t.shape / strokes.length,
        ruleAgreement: t.agree / strokes.length
      })
    );
  }
}

/* ── checks ────────────────────────────────────────────────────────────── */
function checks({ encoder }) {
  const camera = makeCamera();
  const projectPoint = (p) => project(p, camera);
  const axis = widthAxisFor(camera);
  let failed = 0;

  // Raw, not refined: an edge case should meet the code as the user drew it.
  const rawStroke = (points) => {
    const stroke = new Stroke();
    for (const p of points) stroke.addPoint(new THREE.Vector3(...p));
    return stroke;
  };
  const polygonsOf = (points) => rawStroke(points).toBrushPolygons(projectPoint, axis);

  const check = (name, fn) => {
    try {
      const note = fn();
      console.log(`  ok   ${name}${note ? "  — " + note : ""}`);
    } catch (err) {
      console.log(`  FAIL ${name}  — ${err.message}`);
      failed++;
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  check("empty stroke", () => {
    assert(polygonsOf([]).length === 0, "expected no polygons");
  });

  check("single point", () => {
    assert(polygonsOf([[0, 0, 0]]).length === 0, "expected no polygons");
  });

  check("two points", () => {
    const polys = polygonsOf([[-1, 0, 0], [1, 0, 0]]);
    assert(polys.length >= 1, `expected a polygon, got ${polys.length}`);
    assert(polys.every((p) => p.length >= 3), "every polygon needs three points");
    return `one segment, ${polys.length} polygon(s) of ${polys.map((p) => p.length).join("+")} points`;
  });

  check("held still: a dab, not nothing", () => {
    const polys = polygonsOf(Array(20).fill([0.5, 0.5, 0]));
    assert(polys.every((t) => t.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))), "NaN in the output");
    assert(polys.length >= 1, `a held stroke should leave a dab, got ${polys.length}`);
    const xs = polys.flat().map((p) => p.x);
    return `${((Math.max(...xs) - Math.min(...xs)) * ART).toFixed(1)}px across`;
  });

  check("drawn straight at the camera", () => {
    const points = [];
    for (let i = 0; i < 30; i++) points.push([0, 0, -3 + (6 * i) / 29]);
    const polys = polygonsOf(points);
    assert(polys.length > 0, "the whole stroke vanished");
    const areas = polys.map((q) => {
      const xs = q.map((p) => p.x);
      const ys = q.map((p) => p.y);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    });
    assert(Math.max(...areas) > 1e-6, `nothing visible: largest area ${Math.max(...areas)}`);
    return `${polys.length} polygon(s), largest ${(Math.sqrt(Math.max(...areas)) * ART).toFixed(1)}px across`;
  });

  check("entirely off screen", () => {
    const polys = polygonsOf([[-40, 20, 0], [-38, 22, 0], [-36, 20, 0]]);
    assert(polys.length === 0, `expected nothing, got ${polys.length} polygons`);
  });

  check("half off screen: every point inside the frame, encoded and decoded", () => {
    // Strokes leaving the frame in every direction: a point pinned to the edge
    // has to still be inside it after the round trip, or the renderer drops it.
    let polyCount = 0;
    let decodedPoints = 0;

    for (let trial = 0; trial < 16; trial++) {
      const angle = (trial / 16) * Math.PI * 2;
      const points = [];
      for (let i = 0; i < 60; i++) {
        const t = i / 59;
        points.push([
          Math.cos(angle) * (-6 + 14 * t) + Math.sin(t * 9) * 0.6,
          Math.sin(angle) * (-6 + 14 * t) + Math.cos(t * 7) * 0.6,
          0
        ]);
      }
      const stroke = rawStroke(points);
      stroke.refine();
      const polys = stroke.toBrushPolygons(projectPoint, axis);
      if (polys.length === 0) continue;
      polyCount += polys.length;

      for (const poly of polys) {
        for (const p of poly) {
          assert(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `encoded point outside the frame: ${p.x}, ${p.y}`);
        }
      }

      const nap = encodePolys(polys.map((points2D) => ({ color: COLOR, points: points2D })), { encoder });
      for (const cmd of decodePolys(nap, { encoder })) {
        for (const p of cmd.points) {
          decodedPoints++;
          assert(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `decoded point outside the frame: ${p.x}, ${p.y}`);
        }
      }
    }
    return `${polyCount} polygons over 16 directions, ${decodedPoints} points all inside`;
  });

  check("the encoder drops nothing", () => {
    const stroke = buildStroke(STROKES.scribble);
    const stressPolys = stroke.toBrushPolygons(projectPoint, axis);
    const nap = encodePolys(stressPolys.map((points) => ({ color: COLOR, points })), { encoder });
    const decoded = decodePolys(nap, { encoder });
    assert(decoded.length === stressPolys.length, `encoded ${stressPolys.length} polygons, decoded ${decoded.length}`);
    decoded.forEach((cmd, i) => {
      assert(cmd.points.length === stressPolys[i].length,
             `a ${stressPolys[i].length}-point polygon came back with ${cmd.points.length}`);
    });
    return `${stressPolys.length} polygons, ${nap.length} bytes`;
  });

  check("nothing decodes folded over itself", () => {
    // The one thing the split is for: a quad the encoder rounds into a bowtie
    // fills differently under the canvas's nonzero rule than under the even-odd
    // rule ofPath uses on the Pi. Strokes drawn where quads are most fragile.
    let polygons = 0;
    let folded = 0;
    let split = 0;

    for (const stroke of stressStrokes()) {
      const built = stroke.toBrushPolygons(projectPoint, axis);
      if (built.length === 0) continue;
      split += built.filter((p) => p.length === 3).length;

      for (const cmd of decodePolys(encodePolys(built.map((points) => ({ color: COLOR, points })), { encoder }), { encoder })) {
        polygons++;
        if (selfIntersections(cmd.points) > 0) folded++;
      }
    }
    assert(folded === 0, `${folded} of ${polygons} decoded polygons came back folded`);
    return `${polygons} polygons from 240 awkward strokes, ${((100 * split) / polygons).toFixed(1)}% split`;
  });

  check("the pieces themselves never cross as built", () => {
    // A triangle is convex whatever you do to it, so checking the split output
    // proves nothing; the piece builder is where the guarantee has to hold.
    let crossings = 0;
    for (const [, stroke] of selectStrokes([])) {
      const reference = maskOf(brushReference(stroke, camera).map((p) => p.points), { rule: "nonzero" });
      crossings += score(pieces(stroke, camera, COLOR), reference, { encoder }).crossings;
    }
    assert(crossings === 0, `${crossings} self-intersections across the corpus`);
    return "over the whole corpus";
  });

  check("the frame's own transform is carried through", () => {
    const worldOrigin = new THREE.Group();
    const frame = new Frame(worldOrigin);
    const points = [];
    for (let i = 0; i < 20; i++) points.push([-1 + (2 * i) / 19, Math.sin(i / 3) * 0.5, 0]);

    const measure = () => {
      frame.updateWorldMatrix(true, false);
      const built = rawStroke(points).toBrushShapes(
        (p) => project(frame.localToWorld(p.clone()), camera),
        widthAxisFor(camera, frame)
      );
      const xs = built.flat().map((p) => p.x);
      // Measured on the trapezoids, where a width is one edge: the widest, not
      // the middle one, since simplification keeps different points at each
      // zoom. Fans and caps are skipped -- their points sit on an arc, so no
      // pair of them spans the brush.
      const widths = built
        .filter((piece) => piece.length === 4)
        .map((q) => Math.hypot(q[0].x - q[3].x, q[0].y - q[3].y));
      return { span: Math.max(...xs) - Math.min(...xs), width: Math.max(...widths) };
    };

    const plain = measure();
    worldOrigin.scale.set(2, 2, 2); // what the two-handed zoom does
    const zoomed = measure();
    const span = zoomed.span / plain.span;
    const width = zoomed.width / plain.width;
    assert(Math.abs(span - 2) < 0.15, `zoomed span should double, got ${span.toFixed(2)}x`);
    assert(Math.abs(width - 2) < 0.15, `zoomed width should double, got ${width.toFixed(2)}x`);
    return `zoom 2x -> span ${span.toFixed(2)}x, width ${width.toFixed(2)}x`;
  });

  if (failed > 0) {
    console.log(`\n${failed} check(s) failed`);
    process.exitCode = 1;
  }
}

/* ── sheets ────────────────────────────────────────────────────────────── */
const TILE = 400;

// The ideal brush, drawn straight to a canvas with no encoder in the way.
function idealTile(stroke, camera) {
  const canvas = new Canvas(TILE, TILE);
  canvas.clear([0, 0, 0]);
  for (const poly of brushReference(stroke, camera)) {
    canvas.fill([poly.points.map((p) => [p.x * TILE, p.y * TILE])], [255, 255, 255]);
  }
  return canvas.data;
}

// renderNap draws the 640x480 screen; crop back to the artwork square inside it.
function napTile(napRaw) {
  const { width, height, pixels } = renderNap(napRaw, { width: TILE });
  const tile = new Uint8ClampedArray(TILE * TILE * 3);
  const yShift = Math.round(((480 - 640) * TILE) / 640); // render.mjs: translate(0, sH - sW)
  for (let y = 0; y < TILE; y++) {
    const source = y + yShift;
    if (source < 0 || source >= height) continue;
    tile.set(pixels.subarray(source * width * 3, source * width * 3 + TILE * 3), y * TILE * 3);
  }
  return tile;
}

function contactSheet(tiles) {
  const width = tiles.length * TILE;
  const sheet = new Uint8ClampedArray(width * TILE * 3);
  tiles.forEach((tile, i) => {
    const ox = i * TILE;
    for (let y = 0; y < TILE; y++) {
      sheet.set(tile.subarray(y * TILE * 3, (y + 1) * TILE * 3), (y * width + ox) * 3);
      const divider = (y * width + ox) * 3; // hairline, so the tiles read apart
      sheet[divider] = 40;
      sheet[divider + 1] = 40;
      sheet[divider + 2] = 60;
    }
  });
  return { width, height: TILE, pixels: sheet };
}

function sheets(names, { out, encoder }) {
  const camera = makeCamera();
  const shown = CANDIDATES.filter(([label]) => /legacy outline \.002|SHIPPED hybrid/.test(label));
  fs.mkdirSync(out, { recursive: true });

  for (const [name, stroke] of selectStrokes(names)) {
    const tiles = [idealTile(stroke, camera)];
    for (const [, build] of shown) {
      tiles.push(napTile(encodePolys(build(stroke, camera, COLOR), { encoder })));
    }
    const { width, height, pixels } = contactSheet(tiles);
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, encodePNG(width, height, pixels));
    console.log(`${file}   ideal | ${shown.map(([label]) => label).join(" | ")}`);
  }
}

/* ── draw ──────────────────────────────────────────────────────────────── */
// Strokes fed through the real Frame API — trimming, refine, the per-stroke
// z-offset — then exported the way drawing.js's convertToNAPLPS() does it,
// budget ladder included. The limit is the one that function reads from
// GET /api/config -- the server's TEZOS_MAX_BYTES, unless --limit says
// otherwise, and lowering it is how the ladder gets exercised on a drawing
// small enough to look at.
const MAX_SIMPLIFY_PASSES = 8; // convertToNAPLPS() allows itself this many

function drawnStrokes(count) {
  const palette = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];
  const shapes = [
    (t) => [-3 + 6 * t, 2 + Math.sin(t * 7) * 0.4, 0],
    (t) => [Math.cos(t * 6) * 2, Math.sin(t * 6) * 1.5, Math.sin(t * 3) * 1.5],
    (t) => [-2.5 + 5 * t, -2 + Math.sin(t * 20) * 0.8, 0],
    (t) => [1.5 + t * 0.2, 1 - 3 * t, -2 + 4 * t]
  ];
  // Past the four, strokes are the same shapes shifted along, so a big drawing
  // is a plausible one rather than four strokes drawn on top of each other.
  return Array.from({ length: count }, (_, i) => {
    const shape = shapes[i % shapes.length];
    const lane = Math.floor(i / shapes.length); // the first four sit where they were drawn
    const shift = lane === 0 ? 0 : ((lane % 7) - 3) * 0.5;
    return { color: palette[i % palette.length], at: (t) => {
      const [x, y, z] = shape(t);
      return [x + shift, y - shift * 0.4, z];
    } };
  });
}

function draw({ out, encoder, limit, limitSource, strokes: strokeCount, tolerance }) {
  const camera = makeCamera();
  const worldOrigin = new THREE.Group();
  const frame = new Frame(worldOrigin);

  drawnStrokes(strokeCount).forEach((stroke, id) => {
    const samples = 90;
    for (let i = 0; i < samples; i++) {
      const point = new THREE.Vector3(...stroke.at(i / (samples - 1)));
      if (i === 0) frame.beginStroke(point, id, stroke.color);
      else frame.continueStroke(point, id);
    }
    frame.endStroke(id);
  });

  frame.updateWorldMatrix(true, false);
  const projectPoint = (p) => project(frame.localToWorld(p.clone()), camera);
  const axis = widthAxisFor(camera, frame);

  const buildInput = (epsilon, passes) => {
    const polys = [];
    for (const stroke of frame.strokes) {
      if (!stroke.points || stroke.points.length < 2) continue;
      const hex = stroke.color;
      const color = [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
      for (const points of stroke.toBrushPolygons(projectPoint, axis, epsilon, passes)) polys.push({ color, points });
    }
    return polys;
  };

  // Fidelity first, insurance second, exactly as convertToNAPLPS() spends it:
  // the centreline is fitted with no cover run at all, and only what is left
  // over buys the cover run back.
  let epsilon = tolerance;
  let polys = buildInput(epsilon, 0);
  let napRaw = encodePolys(polys, { encoder });
  console.log(`pass 1  tolerance ${epsilon.toFixed(4)}  ${polys.length} polygons  ${napRaw.length} bytes`);

  for (let pass = 1; pass < MAX_SIMPLIFY_PASSES && napRaw.length > limit; pass++) {
    epsilon = Math.max(epsilon * 2, MIN_STEP); // doubling alone can't leave zero

    const simpler = buildInput(epsilon, 0);
    if (simpler.length === 0) break;
    polys = simpler;
    napRaw = encodePolys(polys, { encoder });
    console.log(`pass ${pass + 1}  tolerance ${epsilon.toFixed(4)}  ${polys.length} polygons  ${napRaw.length} bytes`);
  }

  let coverRuns = 0;
  if (BRUSH_OVERLAP_PASSES > 0 && napRaw.length <= limit) {
    const covered = buildInput(epsilon, BRUSH_OVERLAP_PASSES);
    const coveredRaw = covered.length > 0 ? encodePolys(covered, { encoder }) : null;

    if (coveredRaw && coveredRaw.length <= limit) {
      polys = covered;
      napRaw = coveredRaw;
      coverRuns = BRUSH_OVERLAP_PASSES;
      console.log(`cover   ${BRUSH_OVERLAP_PASSES} run(s) fit too   ${polys.length} polygons  ${napRaw.length} bytes`);
    } else if (coveredRaw) {
      console.log(`cover   ${BRUSH_OVERLAP_PASSES} run(s) would be ${coveredRaw.length} bytes -- no room, detail kept instead`);
    }
  }

  const decoded = decodePolys(napRaw, { encoder });
  const offFrame = decoded.reduce(
    (n, cmd) => n + cmd.points.filter((p) => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1).length,
    0
  );
  // Trapezoids have four points, a split one three, and a corner fan or a cap as
  // many as its arc needed -- so the only malformed length is one too short to
  // fill at all.
  const wrongLength = decoded.filter((cmd) => cmd.points.length < 3).length;

  console.log(`\n${frame.strokes.length} strokes -> ${polys.length} polygons, ${napRaw.length} bytes`);
  const split = polys.filter((p) => p.points.length === 3).length;
  console.log(`decoded ${decoded.length} polygons (${split} split for safety); malformed: ${wrongLength}, outside the frame: ${offFrame}`);
  console.log(`tolerance ${epsilon.toFixed(4)}, ${coverRuns > 0 ? `${coverRuns} cover run(s)` : "no cover run"}`);
  console.log(`within the ${limit}-byte limit (${limitSource}): ${napRaw.length <= limit ? "yes" : "NO — too much to mint"}`);

  fs.mkdirSync(out, { recursive: true });
  const { width, height, pixels } = renderNap(napRaw, { width: 640 });
  fs.writeFileSync(path.join(out, "draw.png"), encodePNG(width, height, pixels));
  fs.writeFileSync(path.join(out, "draw.nap"), napRaw);
  console.log(path.join(out, "draw.png"));
}

/* ── loss ──────────────────────────────────────────────────────────────── */
/**
 * What survives when polygons go missing between here and the Pi.
 *
 * The overlap runs in toBrushShapes() are there on the premise that a stroke
 * covered twice keeps its shape when part of it is lost. This is that premise
 * measured: build a stroke at each pass count, throw polygons away, and see how
 * much of the intended paint is still on the canvas.
 *
 * Two ways of losing them, because they punish redundancy differently. Random
 * loss takes polygons independently, which staggering covers well -- the quad
 * over a gap is a different draw from the one that went. Burst loss takes a
 * contiguous run of the command stream, which is what a parser giving up partway
 * looks like, and it can only be covered if the two runs are far enough apart in
 * the stream, which is why the staggered run follows the plain one whole rather
 * than interleaving with it.
 */
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function covered(survivors, intendedMask) {
  const mask = maskOf(survivors, { rule: "nonzero" });
  let kept = 0;
  let want = 0;
  for (let i = 0; i < mask.length; i++) {
    if (intendedMask[i]) {
      want++;
      if (mask[i]) kept++;
    }
  }
  return want === 0 ? 1 : kept / want;
}

const LOSS_RATES = [0.05, 0.1, 0.2];
const LOSS_TRIALS = 24;
const LOSS_PASSES = [0, 1, 2];

function loss(names, { encoder }) {
  const camera = makeCamera();
  const projectPoint = (p) => project(p, camera);
  const axis = widthAxisFor(camera);
  const strokes = selectStrokes(names);

  console.log(`encoder: ${encoder === "file" ? `${encoderInFile()} (as naplps.js has it)` : encoder}`);
  console.log(`\nPaint still on the canvas after polygons are lost, ${LOSS_TRIALS} trials each.`);
  console.log("1.000 is the whole stroke; passes 1 is what tools.js ships.\n");

  const head =
    "passes  polys   bytes   " + LOSS_RATES.map((r) => `rand ${(r * 100).toFixed(0)}%`).join("  ") +
    "   " + LOSS_RATES.map((r) => `burst ${(r * 100).toFixed(0)}%`).join("  ");

  const totals = new Map(LOSS_PASSES.map((n) => [n, { polys: 0, bytes: 0, rand: LOSS_RATES.map(() => 0), burst: LOSS_RATES.map(() => 0) }]));

  for (const [name, stroke] of strokes) {
    console.log(`## ${name}`);
    console.log(head);

    for (const passes of LOSS_PASSES) {
      const polys = stroke
        .toBrushPolygons(projectPoint, axis, BRUSH_SIMPLIFY, passes)
        .map((points) => ({ color: COLOR, points }));
      if (polys.length === 0) continue;

      // The shape as sent, decoded, which is the most any loss could leave
      const sent = decodePolys(encodePolys(polys, { encoder }), { encoder });
      const intended = maskOf(sent.map((p) => p.points), { rule: "nonzero" });
      const bytes = encodePolys(polys, { encoder }).length;

      const random = [];
      const bursts = [];

      for (const rate of LOSS_RATES) {
        const drop = Math.max(1, Math.round(sent.length * rate));
        let randSum = 0;
        let burstSum = 0;

        for (let trial = 0; trial < LOSS_TRIALS; trial++) {
          const rng = mulberry32(trial * 7919 + passes * 104729 + Math.round(rate * 1000));

          // Independent loss: each polygon takes its own chance
          const kept = sent.filter(() => rng() >= rate).map((p) => p.points);
          randSum += covered(kept, intended);

          // Burst loss: one contiguous run of the command stream goes
          const start = Math.floor(rng() * Math.max(1, sent.length - drop));
          const survived = sent.filter((_, i) => i < start || i >= start + drop).map((p) => p.points);
          burstSum += covered(survived, intended);
        }

        random.push(randSum / LOSS_TRIALS);
        bursts.push(burstSum / LOSS_TRIALS);
      }

      const total = totals.get(passes);
      total.polys += sent.length;
      total.bytes += bytes;
      random.forEach((v, i) => (total.rand[i] += v));
      bursts.forEach((v, i) => (total.burst[i] += v));

      console.log(
        `${String(passes).padStart(6)} ${String(sent.length).padStart(6)} ${String(bytes).padStart(7)}   ` +
        random.map((v) => v.toFixed(3).padStart(8)).join("  ") + "   " +
        bursts.map((v) => v.toFixed(3).padStart(9)).join("  ")
      );
    }
    console.log("");
  }

  console.log(`## all ${strokes.length} strokes  (means)`);
  console.log(head);
  for (const [passes, t] of totals) {
    console.log(
      `${String(passes).padStart(6)} ${String(t.polys).padStart(6)} ${String(t.bytes).padStart(7)}   ` +
      t.rand.map((v) => (v / strokes.length).toFixed(3).padStart(8)).join("  ") + "   " +
      t.burst.map((v) => (v / strokes.length).toFixed(3).padStart(9)).join("  ")
    );
  }
}

/* ── inspect ───────────────────────────────────────────────────────────── */
/**
 * What a .nap file actually contains, for a drawing that came back wrong.
 *
 * Every check here was hand-rolled at least once while chasing polygons that
 * went missing on the Pi, so it lives in the tool now rather than in a scratch
 * file. Point it at a drawing captured on its way out (RPI_CAPTURE_DIR in
 * app.js) and compare it with one of public/images, which are the files that
 * have always played cleanly.
 *
 * The two columns that separate the browser from the Pi:
 *
 *  - a POLY whose operand bytes don't divide evenly by pointBytes is dropped
 *    WHOLE by the Pi (Naplps.cpp, NapCmd::setPoints), where the browser keeps
 *    what it could read -- chunks missing on one screen and not the other;
 *  - a polygon that crosses itself fills differently under the nonzero rule a
 *    canvas uses and the even-odd rule ofPath defaults to, and the Pi's
 *    setPolyWindingMode(NONZERO) is currently commented out.
 *
 * @param {string[]} files - paths to .nap files
 */
function inspect(files) {
  if (files.length === 0) {
    throw new Error("inspect needs a file: brush-geometry inspect path/to/drawing.nap");
  }

  for (const file of files) {
    const napRaw = fs.readFileSync(file, "latin1").replace(/[\r\n]/g, "");
    const decoder = new (napContext({}).NapDecoder)([napRaw]);

    const opcodes = new Map();
    const perPoly = new Map();
    let polys = 0;
    let uneven = 0;
    let offFrame = 0;
    let folded = 0;

    for (const cmd of decoder.cmds) {
      const id = (cmd.opcode && cmd.opcode.id) || "(blank)";
      opcodes.set(id, (opcodes.get(id) || 0) + 1);

      for (const p of cmd.points || []) {
        if (!(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) offFrame++;
      }

      if (!id.includes("POLY")) continue;
      polys++;
      perPoly.set(cmd.points.length, (perPoly.get(cmd.points.length) || 0) + 1);
      if (cmd.pointBytes > 0 && cmd.data.length % cmd.pointBytes !== 0) uneven++;
      if (selfIntersections(cmd.points) > 0) folded++;
    }

    const sizes = [...perPoly.keys()].sort((a, b) => a - b);
    console.log(`\n## ${file}  (${napRaw.length} bytes, ${decoder.cmds.length} commands, ${polys} POLY)`);
    for (const [id, n] of [...opcodes].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(n).padStart(6)}  ${id}`);
    }
    console.log(`   points per polygon: ${sizes.map((s) => `${s}:${perPoly.get(s)}`).join("  ") || "none"}`);
    console.log(`   POLY with uneven operand bytes: ${uneven}${uneven ? "   <-- the Pi drops these whole" : ""}`);
    console.log(`   decoded points outside the frame: ${offFrame}   (both renderers drop these)`);
    console.log(`   decoded polygons that cross themselves: ${folded}${folded ? "   <-- nonzero and even-odd will differ" : ""}`);
  }
}

/* ── cli ───────────────────────────────────────────────────────────────── */
function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      encoder: { type: "string", short: "e", default: "file" },
      out: { type: "string", short: "o", default: DEFAULT_OUT },
      limit: { type: "string", short: "l" },   // absent: the server's own figure
      tolerance: { type: "string", short: "t" },
      strokes: { type: "string", short: "s", default: "4" },
      help: { type: "boolean", short: "h", default: false }
    }
  });

  const [command, ...names] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  if (!["file", "round", "truncate"].includes(values.encoder)) {
    console.error(`Invalid --encoder: ${values.encoder}`);
    process.exit(2);
  }

  const limitSource = values.limit === undefined ? serverLimit.source : "--limit";
  const limit = values.limit === undefined ? serverLimit.value : Number(values.limit);
  const strokes = Number(values.strokes);
  if (!Number.isFinite(limit) || limit < 1) {
    console.error(values.limit === undefined ? serverLimit.error : `Invalid --limit: ${values.limit}`);
    process.exit(2);
  }
  if (!Number.isInteger(strokes) || strokes < 1) {
    console.error(`Invalid --strokes: ${values.strokes}`);
    process.exit(2);
  }

  const tolerance = values.tolerance === undefined ? BRUSH_SIMPLIFY : Number(values.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    console.error(`Invalid --tolerance: ${values.tolerance}`);
    process.exit(2);
  }

  const options = { encoder: values.encoder, out: values.out, limit, limitSource, strokes, tolerance };
  try {
    switch (command) {
      case "compare":
        compare(names, options);
        break;
      case "checks":
        checks(options);
        break;
      case "sheets":
        sheets(names, options);
        break;
      case "draw":
        draw(options);
        break;
      case "loss":
        loss(names, options);
        break;
      case "inspect":
        inspect(names);
        break;
      default:
        console.error(`Unknown command: ${command}\n`);
        console.error(USAGE);
        process.exit(2);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
