/*
Ways of turning a drawing-mode Stroke into filled NAPLPS polygons: the one the
code ships with, the one it used to, and the alternatives that were weighed
against them. Every candidate returns [{ color: [r,g,b], points: [{x,y}] }] in
the normalised 0..1 space the format draws in.

Adding a candidate is a function here plus a line in CANDIDATES at the bottom;
`compare` picks the table up from that list.
*/
import * as THREE from "three";
import { Stroke } from "../../public/js/drawing/tools.js";

const DRAW_ASPECT = 640 / 480;
const V_SCALE = 1 / DRAW_ASPECT;

/** The camera drawing mode sets up: 75° on a 4:3 frame, 5 units out on the z axis. */
export function makeCamera() {
  const camera = new THREE.PerspectiveCamera(75, DRAW_ASPECT, 0.1, 1000);
  camera.position.set(0, 0, 5); // updateCameraFromSpherical() at rest
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** convertToNAPLPS()'s projection: NDC to 0..1, y flipped, the 4:3 band inside the square. */
export function project(point, camera, { clamp = false } = {}) {
  const projected = point.clone().project(camera);
  const x = (projected.x + 1) / 2;
  const y = ((1 - projected.y) / 2) * V_SCALE + (1 - V_SCALE);
  return clamp
    ? { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
    : { x, y };
}

/** The width axis drawing.js passes: the camera's right vector, in the stroke's space. */
export function widthAxisFor(camera, frame) {
  const axis = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  if (!frame) return axis.normalize();

  frame.updateWorldMatrix(true, false);
  const toStrokeSpace = new THREE.Matrix3().setFromMatrix4(frame.matrixWorld).invert();
  return axis.applyMatrix3(toStrokeSpace).normalize();
}

/* ── shared helpers ────────────────────────────────────────────────────── */
function unit(x, y) {
  const length = Math.hypot(x, y);
  return length < 1e-9 ? null : { x: x / length, y: y / length };
}

function clampPoint(p) {
  return { x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) };
}

function pointLineDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// RDP over indices, so a radius measured per point can follow the centreline.
export function simplifyIndices(points, epsilon, first = 0, last = points.length - 1) {
  if (last - first < 2) return [first, last];

  let maxDist = 0;
  let maxIdx = first;
  for (let i = first + 1; i < last; i++) {
    const dist = pointLineDist(points[i], points[first], points[last]);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }
  if (maxDist > epsilon) {
    const left = simplifyIndices(points, epsilon, first, maxIdx);
    const right = simplifyIndices(points, epsilon, maxIdx, last);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// The radius rule tools.js uses, so every candidate draws the same weight.
function worldRadii(stroke) {
  return stroke.points.map((_, i) => stroke.radiusAt(i));
}

/**
 * Centreline and radii in 2D: width is measured by projecting a point offset
 * along widthAxis beside each centre point, which is what Stroke.toScreenPath()
 * does. The candidates below all start here, so they differ only in how they
 * turn a path into polygons.
 */
export function toScreenPath(stroke, camera, { minStep = 1e-4 } = {}) {
  const axis = widthAxisFor(camera);
  const radii3D = worldRadii(stroke);
  const centre = [];
  const radii = [];

  for (let i = 0; i < stroke.points.length; i++) {
    const p = stroke.points[i];
    const flat = project(p, camera);
    const edge = project(p.clone().addScaledVector(axis, radii3D[i]), camera);

    const previous = centre[centre.length - 1];
    if (previous && i !== stroke.points.length - 1 &&
        Math.hypot(flat.x - previous.x, flat.y - previous.y) < minStep) {
      continue;
    }
    centre.push(flat);
    radii.push(Math.hypot(edge.x - flat.x, edge.y - flat.y));
  }
  return { centre, radii };
}

function simplify(path, epsilon) {
  const keep = simplifyIndices(path.centre, epsilon);
  return { centre: keep.map((i) => path.centre[i]), radii: keep.map((i) => path.radii[i]) };
}

function vertexNormal(centre, i) {
  const a = centre[i - 1] || centre[i];
  const b = centre[i + 1] || centre[i];
  const t = unit(b.x - a.x, b.y - a.y);
  return t ? { x: -t.y, y: t.x } : null;
}

/* ── the shape the code ships ──────────────────────────────────────────── */
/** Stroke.toBrushQuads() itself, driven the way drawing.js drives it. */
export function shipped(stroke, camera, color, epsilon) {
  const axis = widthAxisFor(camera);
  return stroke
    .toBrushQuads((p) => project(p, camera), axis, epsilon)
    .map((points) => ({ color, points }));
}

/* ── polygon soup: one filled polygon per triangle ─────────────────────── */
/**
 * The shipped quads, each cut along a diagonal into two triangles, every
 * triangle its own POLY FILLED. Same geometry, so what this measures is the
 * cost and effect of the split alone: three-point polygons hold the encoder's
 * delta cursor to an even shorter run, and a triangle cannot be anything but
 * convex, where a quad relies on its construction for that.
 */
export function soup(stroke, camera, color, epsilon) {
  const out = [];
  for (const { points } of shipped(stroke, camera, color, epsilon)) {
    if (points.length !== 4) {
      out.push({ color, points });
      continue;
    }
    const [a, b, c, d] = points;
    out.push({ color, points: [a, b, c] });
    out.push({ color, points: [a, c, d] });
  }
  return out;
}

/**
 * The soup with the corner reach replaced by an explicit wedge triangle at each
 * joint: two triangles per segment, one per corner. Once every polygon is a
 * triangle anyway, the wedge costs no more than the overlap it replaces, and it
 * fills the corner exactly rather than by covering it over.
 */
export function soupJoints(stroke, camera, color, epsilon = 0.002) {
  const { centre, radii } = simplify(toScreenPath(stroke, camera), epsilon);
  const out = [];

  for (let i = 0; i < centre.length - 1; i++) {
    const a = centre[i];
    const b = centre[i + 1];
    const t = unit(b.x - a.x, b.y - a.y);
    if (!t) continue;

    const ra = Math.max(radii[i], 1e-4);
    const rb = Math.max(radii[i + 1], 1e-4);
    const al = clampPoint({ x: a.x - t.y * ra, y: a.y + t.x * ra });
    const ar = clampPoint({ x: a.x + t.y * ra, y: a.y - t.x * ra });
    const bl = clampPoint({ x: b.x - t.y * rb, y: b.y + t.x * rb });
    const br = clampPoint({ x: b.x + t.y * rb, y: b.y - t.x * rb });

    out.push({ color, points: [al, bl, br] });
    out.push({ color, points: [al, br, ar] });
  }

  // The wedge each pair of segments leaves on the outside of its corner
  for (let i = 1; i < centre.length - 1; i++) {
    const into = unit(centre[i].x - centre[i - 1].x, centre[i].y - centre[i - 1].y);
    const outOf = unit(centre[i + 1].x - centre[i].x, centre[i + 1].y - centre[i].y);
    if (!into || !outOf) continue;

    const cross = into.x * outOf.y - into.y * outOf.x;
    if (Math.abs(cross) < 1e-6) continue;

    const side = cross > 0 ? -1 : 1; // the outside of the turn
    const r = Math.max(radii[i], 1e-4);
    out.push({
      color,
      points: [
        clampPoint(centre[i]),
        clampPoint({ x: centre[i].x - side * into.y * r, y: centre[i].y + side * into.x * r }),
        clampPoint({ x: centre[i].x - side * outOf.y * r, y: centre[i].y + side * outOf.x * r })
      ]
    });
  }

  return out;
}

/* ── the shape it used to ship ─────────────────────────────────────────── */
/**
 * The stroke as one closed outline offset in its own best-fit plane -- the
 * pre-2026 Stroke.toBrushOutline(), kept here so the baseline stays measurable
 * after the method itself was replaced.
 */
export function legacyOutline(stroke, camera, color, epsilon = 0.002) {
  if (stroke.points.length < 2) return [];
  if (stroke.pressures.length !== stroke.points.length) stroke.computePressures();

  const normal = stroke.computeNormal();
  const lastIndex = stroke.points.length - 1;
  const left = [];
  const right = [];

  for (let i = 0; i <= lastIndex; i++) {
    const p = stroke.points[i];
    const radius = stroke.radiusAt(i);

    const tangent = new THREE.Vector3();
    if (i === 0) tangent.subVectors(stroke.points[1], p);
    else if (i === lastIndex) tangent.subVectors(p, stroke.points[i - 1]);
    else tangent.subVectors(stroke.points[i + 1], stroke.points[i - 1]);

    const length = tangent.length();
    if (length < 0.0001) tangent.set(1, 0, 0);
    else tangent.divideScalar(length);

    // No fallback here: this is the line that collapses when a stroke runs
    // along its own normal, and the harness is here to show it.
    const perp = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    left.push(p.clone().addScaledVector(perp, radius));
    right.push(p.clone().addScaledVector(perp, -radius));
  }

  const outline = [...left, ...right.reverse()].map((p) => project(p, camera, { clamp: true }));
  const points = simplifyIndices(outline, epsilon).map((i) => outline[i]);
  return points.length < 3 ? [] : [{ color, points }];
}

/* ── the alternatives that were weighed ────────────────────────────────── */
/** The same ribbon built in 2D, still emitted as one long polygon. */
export function ribbon(stroke, camera, color, epsilon = 0.005) {
  const { centre, radii } = simplify(toScreenPath(stroke, camera), epsilon);
  const left = [];
  const right = [];

  for (let i = 0; i < centre.length; i++) {
    const normal = vertexNormal(centre, i);
    if (!normal) continue;
    left.push(clampPoint({ x: centre[i].x + normal.x * radii[i], y: centre[i].y + normal.y * radii[i] }));
    right.push(clampPoint({ x: centre[i].x - normal.x * radii[i], y: centre[i].y - normal.y * radii[i] }));
  }
  const points = [...left, ...right.reverse()];
  return points.length < 3 ? [] : [{ color, points }];
}

/** The ribbon cut into chunks of `chunkSegments`, each overlapping the last by one. */
export function chunks(stroke, camera, color, epsilon = 0.005, chunkSegments = 8) {
  const { centre, radii } = simplify(toScreenPath(stroke, camera), epsilon);
  const out = [];

  for (let start = 0; start < centre.length - 1; start += chunkSegments) {
    const from = Math.max(0, start - (start > 0 ? 1 : 0));
    const to = Math.min(centre.length - 1, start + chunkSegments);
    const left = [];
    const right = [];

    for (let i = from; i <= to; i++) {
      const normal = vertexNormal(centre, i);
      if (!normal) continue;
      const r = Math.max(radii[i], 1e-4);
      left.push(clampPoint({ x: centre[i].x + normal.x * r, y: centre[i].y + normal.y * r }));
      right.push(clampPoint({ x: centre[i].x - normal.x * r, y: centre[i].y - normal.y * r }));
    }
    const points = [...left, ...right.reverse()];
    if (points.length >= 3) out.push({ color, points });
  }
  return out;
}

/**
 * One quad per segment, cornered by a mitre instead of by reaching past the
 * joint: the ribbon's edges stay exactly continuous, at the cost of a quad that
 * can invert at a hairpin -- which is the crossings column earning its keep.
 */
export function mitred(stroke, camera, color, epsilon = 0.005, miterLimit = 2.5) {
  const { centre, radii } = simplify(toScreenPath(stroke, camera), epsilon);
  const n = centre.length;
  if (n < 2) return [];

  const offsets = [];
  for (let i = 0; i < n; i++) {
    const into = i > 0 ? unit(centre[i].x - centre[i - 1].x, centre[i].y - centre[i - 1].y) : null;
    const outOf = i < n - 1 ? unit(centre[i + 1].x - centre[i].x, centre[i + 1].y - centre[i].y) : null;
    const r = Math.max(radii[i], 1e-4);

    if (!into || !outOf) {
      const t = into || outOf || { x: 1, y: 0 };
      offsets.push({ x: -t.y * r, y: t.x * r });
      continue;
    }
    const bisector = unit(into.x + outOf.x, into.y + outOf.y);
    if (!bisector) {
      offsets.push({ x: -outOf.y * r, y: outOf.x * r }); // a reversal: take the outgoing side
      continue;
    }
    const nx = -bisector.y;
    const ny = bisector.x;
    const cos = Math.max(0.05, nx * -into.y + ny * into.x);
    const scale = Math.min(miterLimit, 1 / cos) * r;
    offsets.push({ x: nx * scale, y: ny * scale });
  }

  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const a = centre[i];
    const b = centre[i + 1];
    const oa = offsets[i];
    const ob = offsets[i + 1];
    out.push({
      color,
      points: [
        clampPoint({ x: a.x + oa.x, y: a.y + oa.y }),
        clampPoint({ x: b.x + ob.x, y: b.y + ob.y }),
        clampPoint({ x: b.x - ob.x, y: b.y - ob.y }),
        clampPoint({ x: a.x - oa.x, y: a.y - oa.y })
      ]
    });
  }
  return out;
}

/* ── the ideal to score against ────────────────────────────────────────── */
/**
 * The brush as it should look: every segment of the unsimplified centreline
 * stamped as a trapezoid, with a disc at each point for the joins. Filled one
 * polygon at a time, so no winding rule has an opinion about it.
 */
export function brushReference(stroke, camera, color = [255, 255, 255]) {
  const { centre, radii } = toScreenPath(stroke, camera, { minStep: 1e-5 });
  const out = [];

  for (let i = 0; i < centre.length - 1; i++) {
    const t = unit(centre[i + 1].x - centre[i].x, centre[i + 1].y - centre[i].y);
    if (!t) continue;
    out.push({
      color,
      points: [
        { x: centre[i].x - t.y * radii[i], y: centre[i].y + t.x * radii[i] },
        { x: centre[i + 1].x - t.y * radii[i + 1], y: centre[i + 1].y + t.x * radii[i + 1] },
        { x: centre[i + 1].x + t.y * radii[i + 1], y: centre[i + 1].y - t.x * radii[i + 1] },
        { x: centre[i].x + t.y * radii[i], y: centre[i].y - t.x * radii[i] }
      ]
    });
  }

  for (let i = 0; i < centre.length; i++) {
    const disc = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      disc.push({ x: centre[i].x + Math.cos(a) * radii[i], y: centre[i].y + Math.sin(a) * radii[i] });
    }
    out.push({ color, points: disc });
  }
  return out;
}

/* ── the table `compare` prints ────────────────────────────────────────── */
export const CANDIDATES = [
  ["legacy outline .002", (s, cam, col) => legacyOutline(s, cam, col, 0.002)],
  ["legacy outline .01", (s, cam, col) => legacyOutline(s, cam, col, 0.01)],
  ["ribbon 2D .005", (s, cam, col) => ribbon(s, cam, col, 0.005)],
  ["chunks(8) .005", (s, cam, col) => chunks(s, cam, col, 0.005, 8)],
  ["mitred .005", (s, cam, col) => mitred(s, cam, col, 0.005)],
  ["mitred .002", (s, cam, col) => mitred(s, cam, col, 0.002)],
  // The first of these is tools.js's own BRUSH_SIMPLIFY, whatever it is set to;
  // the other two bracket it, so the cost of that tolerance stays visible.
  ["SHIPPED toBrushQuads", (s, cam, col) => shipped(s, cam, col)],
  ["SHIPPED at .005", (s, cam, col) => shipped(s, cam, col, 0.005)],
  ["SHIPPED at .01", (s, cam, col) => shipped(s, cam, col, 0.01)],
  ["soup (split quads)", (s, cam, col) => soup(s, cam, col)],
  ["soup at .005", (s, cam, col) => soup(s, cam, col, 0.005)],
  ["soup + joint wedges", (s, cam, col) => soupJoints(s, cam, col)]
];

export { Stroke };
