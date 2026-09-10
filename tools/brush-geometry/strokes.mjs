/*
The stroke corpus: eight synthetic strokes in the world space drawing mode uses,
each chosen for something it does to a brush geometry.

The drawing plane sits about 5 units from the camera and the visible band there
is roughly 10.2 x 7.7 units, so these span the distances a hand covers. Points
are fed through Stroke.refine() the way Frame.endStroke() does, which is what
turns a hundred sampled points into four hundred.
*/
import * as THREE from "three";
import { Stroke } from "./candidates.mjs";

function sampled(n, fn) {
  const points = [];
  for (let i = 0; i < n; i++) points.push(fn(i / (n - 1), i));
  return points;
}

// Hand tremor: enough to matter to simplification, not enough to see.
const jitter = (amp, i) => Math.sin(i * 2.3) * amp + Math.sin(i * 7.1) * amp * 0.4;

export const STROKES = {
  // A plain hand-drawn line: the case everything should get right
  squiggle: sampled(120, (t, i) =>
    new THREE.Vector3(-3.5 + 7 * t + jitter(0.02, i), Math.sin(t * Math.PI * 3) * 1.2 + jitter(0.02, i), 0)
  ),

  // Long, and curving the same way throughout: where delta drift accumulates
  spiral: sampled(200, (t, i) => {
    const angle = t * Math.PI * 6;
    const r = 2.6 * (1 - t * 0.92);
    return new THREE.Vector3(Math.cos(angle) * r + jitter(0.01, i), Math.sin(angle) * r + jitter(0.01, i), 0);
  }),

  // Out, tight U-turn, back: the turn is tighter than the brush is wide, so an
  // outline of the whole stroke crosses itself and fills the gap between the arms
  hairpin: sampled(90, (t, i) => {
    const x = -2 + 4 * Math.min(1, t * 2);
    return t < 0.5
      ? new THREE.Vector3(x, 0.3 + jitter(0.01, i), 0)
      : new THREE.Vector3(2 - 4 * (t - 0.5) * 2 + Math.sin(t * Math.PI) * 0.25, -0.3 + jitter(0.01, i), 0);
  }),

  // Closes on itself: the ends nearly meet, which an outline reads as one shape
  loop: sampled(110, (t, i) => {
    const angle = t * Math.PI * 2.2;
    return new THREE.Vector3(Math.cos(angle) * 2 + jitter(0.015, i), Math.sin(angle) * 1.6 + jitter(0.015, i), 0);
  }),

  // Real z travel, as hand tracking gives: the brush should thicken as it nears
  depth: sampled(110, (t, i) =>
    new THREE.Vector3(-3 + 6 * t + jitter(0.02, i), Math.sin(t * Math.PI * 2) * 0.9, -2.5 + 4.5 * t)
  ),

  // Drawn almost along the view axis: the stroke's own plane is nearly degenerate,
  // so a width measured in it collapses to a hairline
  edgeOn: sampled(90, (t, i) =>
    new THREE.Vector3(-1 + 2 * t + jitter(0.02, i), Math.sin(t * Math.PI * 2) * 0.35, -3 + 6 * t)
  ),

  // Barely any points: nothing should crash, and the taper shouldn't eat it
  flick: sampled(14, (t) => new THREE.Vector3(-1 + 2 * t, 0.5 * t * t, 0)),

  // Long, dense, self-overlapping: the worst case for both drift and fill rules
  scribble: sampled(300, (t) =>
    new THREE.Vector3(
      -3 + 6 * t + Math.sin(t * 40) * 0.5,
      Math.cos(t * 33) * 1.6 + Math.sin(t * 11) * 0.6,
      Math.sin(t * 5) * 0.8
    )
  )
};

/**
 * @param {THREE.Vector3[]} points
 * @returns {Stroke} A stroke refined the way a finished one is
 */
export function buildStroke(points) {
  const stroke = new Stroke(0xffffff);
  for (const point of points) stroke.addPoint(point);
  stroke.refine(); // Frame.endStroke() does this before a stroke is kept
  return stroke;
}

/**
 * @param {string[]} names - Empty for all of them
 * @returns {[string, Stroke][]}
 */
export function selectStrokes(names) {
  const wanted = names.length > 0 ? names : Object.keys(STROKES);
  return wanted.map((name) => {
    if (!STROKES[name]) {
      throw new Error(`no such stroke "${name}": try ${Object.keys(STROKES).join(", ")}`);
    }
    return [name, buildStroke(STROKES[name])];
  });
}
