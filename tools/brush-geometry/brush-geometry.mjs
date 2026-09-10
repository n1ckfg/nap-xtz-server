#!/usr/bin/env node
/*
brush-geometry — measures how a drawing-mode brush stroke survives NAPLPS.

    node tools/brush-geometry/brush-geometry.mjs compare
    node tools/brush-geometry/brush-geometry.mjs compare scribble --encoder truncate
    node tools/brush-geometry/brush-geometry.mjs checks
    node tools/brush-geometry/brush-geometry.mjs sheets hairpin depth
    node tools/brush-geometry/brush-geometry.mjs draw

Every stroke is encoded and decoded by public/js/telidon/naplps.js itself, so
what the table reports is what the browser and the Pi will get.
*/
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import { Canvas } from "../thumbnail-maker/raster.mjs";
import { renderNap } from "../thumbnail-maker/render.mjs";
import { encodePNG } from "../thumbnail-maker/png.mjs";
import { encodePolys, decodePolys, encoderInFile, maskOf, score, ART } from "./naplps.mjs";
import { CANDIDATES, Stroke, brushReference, makeCamera, project, shipped, widthAxisFor } from "./candidates.mjs";
import { STROKES, buildStroke, selectStrokes } from "./strokes.mjs";
import { Frame, BRUSH_SIMPLIFY } from "../../public/js/drawing/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(here, "out");
const COLOR = [255, 255, 255];

const USAGE = `Usage: brush-geometry <command> [stroke ...] [options]

Commands:
  compare [stroke ...]   score every candidate geometry against the ideal brush
  checks                 assert the shipped toBrushQuads holds up at the edges
  sheets [stroke ...]    write side-by-side PNGs: ideal, legacy outline, shipped
  draw                   draw strokes through a real Frame, end to end, with
                         the byte budget ladder convertToNAPLPS() runs

Strokes: ${Object.keys(STROKES).join(", ")} (default: all)

Options:
  -e, --encoder <mode>   file (default), round, or truncate — rewrites
                         makeNapVector2's quantisation while measuring
  -o, --out <dir>        where sheets and draw write (default: tools/brush-geometry/out)
  -l, --limit <bytes>    draw: the mint limit to fit under (default: 30000)
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
  const quadsOf = (points) => rawStroke(points).toBrushQuads(projectPoint, axis);

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
    assert(quadsOf([]).length === 0, "expected no quads");
  });

  check("single point", () => {
    assert(quadsOf([[0, 0, 0]]).length === 0, "expected no quads");
  });

  check("two points", () => {
    const quads = quadsOf([[-1, 0, 0], [1, 0, 0]]);
    assert(quads.length === 1, `expected 1 quad, got ${quads.length}`);
    assert(quads[0].length === 4, "a quad should have four points");
    return "1 quad";
  });

  check("held still: a dab, not nothing", () => {
    const quads = quadsOf(Array(20).fill([0.5, 0.5, 0]));
    assert(quads.every((q) => q.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))), "NaN in the output");
    assert(quads.length === 1, `expected one dab, got ${quads.length}`);
    const xs = quads[0].map((p) => p.x);
    return `${((Math.max(...xs) - Math.min(...xs)) * ART).toFixed(1)}px across`;
  });

  check("drawn straight at the camera", () => {
    const points = [];
    for (let i = 0; i < 30; i++) points.push([0, 0, -3 + (6 * i) / 29]);
    const quads = quadsOf(points);
    assert(quads.length > 0, "the whole stroke vanished");
    const areas = quads.map((q) => {
      const xs = q.map((p) => p.x);
      const ys = q.map((p) => p.y);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    });
    assert(Math.max(...areas) > 1e-6, `nothing visible: largest area ${Math.max(...areas)}`);
    return `${quads.length} quad(s), largest ${(Math.sqrt(Math.max(...areas)) * ART).toFixed(1)}px across`;
  });

  check("entirely off screen", () => {
    const quads = quadsOf([[-40, 20, 0], [-38, 22, 0], [-36, 20, 0]]);
    assert(quads.length === 0, `expected nothing, got ${quads.length} quads`);
  });

  check("half off screen: every point inside the frame, encoded and decoded", () => {
    // Strokes leaving the frame in every direction: a point pinned to the edge
    // has to still be inside it after the round trip, or the renderer drops it.
    let quadCount = 0;
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
      const quads = stroke.toBrushQuads(projectPoint, axis);
      if (quads.length === 0) continue;
      quadCount += quads.length;

      for (const quad of quads) {
        for (const p of quad) {
          assert(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `encoded point outside the frame: ${p.x}, ${p.y}`);
        }
      }

      const nap = encodePolys(quads.map((points2D) => ({ color: COLOR, points: points2D })), { encoder });
      for (const cmd of decodePolys(nap, { encoder })) {
        for (const p of cmd.points) {
          decodedPoints++;
          assert(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `decoded point outside the frame: ${p.x}, ${p.y}`);
        }
      }
    }
    return `${quadCount} quads over 16 directions, ${decodedPoints} points all inside`;
  });

  check("the encoder drops nothing", () => {
    const stroke = buildStroke(STROKES.scribble);
    const quads = stroke.toBrushQuads(projectPoint, axis);
    const nap = encodePolys(quads.map((points) => ({ color: COLOR, points })), { encoder });
    const decoded = decodePolys(nap, { encoder });
    assert(decoded.length === quads.length, `encoded ${quads.length} polygons, decoded ${decoded.length}`);
    for (const cmd of decoded) {
      assert(cmd.points.length === 4, `a polygon came back with ${cmd.points.length} points`);
    }
    return `${quads.length} quads, ${nap.length} bytes`;
  });

  check("no polygon crosses itself", () => {
    let crossings = 0;
    for (const [, stroke] of selectStrokes([])) {
      const reference = maskOf(brushReference(stroke, camera).map((p) => p.points), { rule: "nonzero" });
      crossings += score(shipped(stroke, camera, COLOR), reference, { encoder }).crossings;
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
      const quads = rawStroke(points).toBrushQuads(
        (p) => project(frame.localToWorld(p.clone()), camera),
        widthAxisFor(camera, frame)
      );
      const xs = quads.flat().map((p) => p.x);
      // The widest quad, not the middle one: simplification keeps different
      // points at different zooms, so an index into the run isn't comparable.
      const widths = quads.map((q) => Math.hypot(q[0].x - q[3].x, q[0].y - q[3].y));
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
  const shown = CANDIDATES.filter(([label]) => /legacy outline \.002|SHIPPED toBrushQuads|soup \(split quads\)/.test(label));
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
// budget ladder included. `--limit` is what that function reads from
// GET /api/config; lowering it is how the ladder gets exercised on a drawing
// small enough to look at.
const MAX_SIMPLIFY_PASSES = 5; // convertToNAPLPS() allows itself this many

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

function draw({ out, encoder, limit, strokes: strokeCount }) {
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

  const buildInput = (epsilon) => {
    const polys = [];
    for (const stroke of frame.strokes) {
      if (!stroke.points || stroke.points.length < 2) continue;
      const hex = stroke.color;
      const color = [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
      for (const points of stroke.toBrushQuads(projectPoint, axis, epsilon)) polys.push({ color, points });
    }
    return polys;
  };

  let epsilon = BRUSH_SIMPLIFY;
  let polys = buildInput(epsilon);
  let napRaw = encodePolys(polys, { encoder });
  console.log(`pass 1  tolerance ${epsilon.toFixed(4)}  ${polys.length} polygons  ${napRaw.length} bytes`);

  for (let pass = 1; pass < MAX_SIMPLIFY_PASSES && napRaw.length > limit; pass++) {
    epsilon *= 2;
    const simpler = buildInput(epsilon);
    if (simpler.length === 0) break;
    polys = simpler;
    napRaw = encodePolys(polys, { encoder });
    console.log(`pass ${pass + 1}  tolerance ${epsilon.toFixed(4)}  ${polys.length} polygons  ${napRaw.length} bytes`);
  }

  const decoded = decodePolys(napRaw, { encoder });
  const offFrame = decoded.reduce(
    (n, cmd) => n + cmd.points.filter((p) => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1).length,
    0
  );
  const wrongLength = decoded.filter((cmd) => cmd.points.length !== 4).length;

  console.log(`\n${frame.strokes.length} strokes -> ${polys.length} polygons, ${napRaw.length} bytes`);
  console.log(`decoded ${decoded.length} polygons; not four points: ${wrongLength}, outside the frame: ${offFrame}`);
  console.log(`within the ${limit}-byte limit: ${napRaw.length <= limit ? "yes" : "NO — too much to mint"}`);

  fs.mkdirSync(out, { recursive: true });
  const { width, height, pixels } = renderNap(napRaw, { width: 640 });
  fs.writeFileSync(path.join(out, "draw.png"), encodePNG(width, height, pixels));
  fs.writeFileSync(path.join(out, "draw.nap"), napRaw);
  console.log(path.join(out, "draw.png"));
}

/* ── cli ───────────────────────────────────────────────────────────────── */
function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      encoder: { type: "string", short: "e", default: "file" },
      out: { type: "string", short: "o", default: DEFAULT_OUT },
      limit: { type: "string", short: "l", default: "30000" },
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

  const limit = Number(values.limit);
  const strokes = Number(values.strokes);
  if (!Number.isFinite(limit) || limit < 1) {
    console.error(`Invalid --limit: ${values.limit}`);
    process.exit(2);
  }
  if (!Number.isInteger(strokes) || strokes < 1) {
    console.error(`Invalid --strokes: ${values.strokes}`);
    process.exit(2);
  }

  const options = { encoder: values.encoder, out: values.out, limit, strokes };
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
