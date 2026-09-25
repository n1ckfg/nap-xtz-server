import * as THREE from 'three';

// There used to be a fixed trim here -- the first point and the last five of
// every stroke -- to lose the few frames in which a hand changes sign. Five
// frames was 80 ms at sixty frames a second and two seconds at the two and a
// half a Pi managed with the recognizer on the main thread, which cut most of
// a stroke off; it also clipped attract mode's replays and the mouse, neither
// of which has a sign to change. Points now carry the time they were measured,
// and whoever ends a stroke says where it ended (see endStroke).

// Points of a stroke closer together than this, in the stroke's own units, are
// one point: a hand held still would otherwise pile up samples on one spot,
// which cost bytes and bunch the taper.
const MIN_POINT_SPACING = 0.01;

// refine() puts a smooth curve through a stroke's samples, at about this
// spacing (in the stroke's own units: the view is ~10 across). A hand tracked
// five times a second draws a circle as a pentagon; this is what rounds it.
const CURVE_SPACING = 0.04;
const CURVE_MAX_STEPS = 16; // per segment between samples

// Flicker duration and interval for undo/clear animations
const FLICKER_DURATION = 300; // ms
const FLICKER_INTERVAL = 50; // ms

// The pinch at each end of a stroke, in the stroke's own units, so a brush
// doesn't start or stop with a flare.
const TIP_RADIUS = 0.01;

// The next few are in frame widths -- the 0..1 space toBrushShapes works in,
// where 1 is the whole drawing, so 0.005 is about three pixels of a 640-wide one.
export const MIN_STEP = 0.002;//0.0005; // 1/2048: a shorter step is a rounding error to the encoder
const MIN_RADIUS = 0.0005;      // keeps a piece from collapsing into a line

// Where the byte ladder in convertToNAPLPS() starts, not where it settles: the
// finest tolerance the format can carry, since a point the encoder cannot tell
// from its neighbour is one simplification may as well drop. Fidelity is the
// first call on the budget and the ladder coarsens from here only when a drawing
// won't fit -- the other way round from thinning the brush to a fixed 0.002
// before anyone had asked whether there was room for more.
//
// That thinning was costing far more than the polygon shapes ever did. Measured
// against the ideal brush over the harness corpus, rebuilding the geometry
// exactly is worth about two points of fidelity and the tolerance is worth ten
// to thirty: a hairpin came back at 0.643 of the ideal at 0.002 and 0.965 here.
//
// This is the only simplification tolerance in the project, and every path that
// gets simplified reads it from here: the ladder in convertToNAPLPS(), the
// defaults on toBrushShapes() and toBrushPolygons() below, the SVG importer in
// index.html (via the module script that puts it on `window`, since that script
// is not a module and cannot import), and `--tolerance` in
// tools/brush-geometry. The importer used to carry its own 0.02 in three
// places, which simplified an imported drawing forty times more coarsely than a
// drawn one for no reason anybody had written down.
//
// MIN_STEP is not a second knob for the same thing. It is the 4-byte domain's
// quantum, 1/2048, and the geometry guards below are multiples of it because
// they are about what the format can represent, not about how much detail to
// keep. It is also the ladder's floor: doubling cannot leave zero, and zero is
// what this constant means when set to keep every point.
export const BRUSH_SIMPLIFY = MIN_STEP;

export class Stroke {
    constructor(color = 0xffffff) {
        this.points = [];
        this.times = [];       // when each point was measured, ms (NaN if nobody said)
        this.color = color;
        this.smoothReps = 4;   // light smoothing after the curve fit (see refine)
        this.thickness = 0.25; // Brush thickness
        this.pressures = [];   // Pressure values per point (0-1)
        this.taperPower = 0.4; // Taper exponent for ends
        this.minThickness = 0.3; // Minimum thickness multiplier
        this.normalOffset = 0; // 3D preview only -- see offsetAlongNormal()
        this.closed = false;   // When true the polyline is a closed filled polygon
        this._arc = [];        // distance along the stroke to each point
        this._length = 0;
        this._near = null;     // the last point too close to keep (see keepDot)
    }

    /**
     * Adds a point to the stroke, unless it is on top of the last one
     * @param {THREE.Vector3} point - Position to add
     * @param {number} [time] - When it was measured, ms
     * @returns {boolean} True if the point was kept
     */
    addPoint(point, time = NaN) {
        const last = this.points[this.points.length - 1];
        if (last && last.distanceToSquared(point) < MIN_POINT_SPACING * MIN_POINT_SPACING) {
            // Kept aside: if the stroke never gets further than this, it is a
            // dot, and a dot is still a mark (see keepDot).
            this._near = { point: point.clone(), time };
            return false;
        }
        this.points.push(point.clone());
        this.times.push(time);
        this._near = null;
        return true;
    }

    /**
     * A stroke that never left the spot it started on is a dot: give it back
     * the second point addPoint() set aside, so it is drawn rather than lost.
     * Replayed drawings are full of them.
     */
    keepDot() {
        if (this.points.length === 1 && this._near) {
            this.points.push(this._near.point);
            this.times.push(this._near.time);
        }
    }

    /**
     * Drops the points measured after `time` -- the tail a hand draws while it
     * changes to the sign that ends the stroke.
     * @param {number} time - ms; points with no time are kept
     */
    trimAfter(time) {
        if (this._near && this._near.time > time) this._near = null;
        let n = this.points.length;
        while (n > 0 && this.times[n - 1] > time) n--;
        this.points.length = n;
        this.times.length = n;
        this.pressures = [];
    }

    /**
     * Converts points to line segments format (pairs of points)
     * @returns {THREE.Vector3[]} Array of points in line segments format
     */
    toLineSegments() {
        const segments = [];
        for (let i = 1; i < this.points.length; i++) {
            segments.push(this.points[i - 1]);
            segments.push(this.points[i]);
        }
        // Close the loop back to origin
        if (this.points.length > 2) {
            segments.push(this.points[this.points.length - 1]);
            segments.push(this.points[0]);
        }
        return segments;
    }

    /**
     * Creates a filled mesh geometry using ear-clipping triangulation
     * Projects points to 2D for triangulation, then uses indices on 3D points
     * @returns {THREE.BufferGeometry} The fill geometry
     */
    toFillGeometry() {
        return toGeometry(this.fillArrays());
    }

    /**
     * The fill as raw arrays, for toFillGeometry() or the Frame's batch.
     * @returns {?{positions: Float32Array, indices: number[]}}
     */
    fillArrays() {
        if (this.points.length < 3) return null;

        // Calculate best-fit plane normal using Newell's method
        const normal = new THREE.Vector3(0, 0, 0);
        for (let i = 0; i < this.points.length; i++) {
            const curr = this.points[i];
            const next = this.points[(i + 1) % this.points.length];
            normal.x += (curr.y - next.y) * (curr.z + next.z);
            normal.y += (curr.z - next.z) * (curr.x + next.x);
            normal.z += (curr.x - next.x) * (curr.y + next.y);
        }
        normal.normalize();

        // Create basis vectors for projection
        let up = new THREE.Vector3(0, 1, 0);
        if (Math.abs(normal.dot(up)) > 0.9) {
            up = new THREE.Vector3(1, 0, 0);
        }
        const basisX = new THREE.Vector3().crossVectors(up, normal).normalize();
        const basisY = new THREE.Vector3().crossVectors(normal, basisX).normalize();

        // Project points to 2D
        const points2D = this.points.map(p => new THREE.Vector2(
            p.dot(basisX),
            p.dot(basisY)
        ));

        // Use Three.js ShapeUtils for triangulation
        const triangles = THREE.ShapeUtils.triangulateShape(points2D, []);

        // Build geometry with original 3D points
        const positions = new Float32Array(this.points.length * 3);
        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            positions[i * 3] = p.x;
            positions[i * 3 + 1] = p.y;
            positions[i * 3 + 2] = p.z;
        }
        // No normals: every material that draws strokes is unlit.
        return { positions, indices: triangles.flat() };
    }

    /**
     * Smooths the stroke using weighted average of neighboring points
     */
    smoothStroke() {
        const weight = 18;
        const scale = 1.0 / (weight + 2);
        const nPointsMinusTwo = this.points.length - 2;

        for (let i = 1; i < nPointsMinusTwo; i++) {
            const lower = this.points[i - 1];
            const center = this.points[i];
            const upper = this.points[i + 1];

            center.x = (lower.x + weight * center.x + upper.x) * scale;
            center.y = (lower.y + weight * center.y + upper.y) * scale;
            center.z = (lower.z + weight * center.z + upper.z) * scale;
        }
    }

    /**
     * Refines the stroke: a smooth curve through its samples, then a little
     * smoothing.
     *
     * It used to split every segment in half twice and smooth ten times, which
     * rounded a stroke sampled sixty times a second nicely enough but left one
     * sampled five times a second -- a hand on a Pi -- as the polygon it was
     * sampled as, only with more points. A centripetal Catmull-Rom spline goes
     * through every sample the hand gave and bends between them the way the
     * hand did, however far apart they are (see catmullRom below).
     */
    refine() {
        if (this.points.length < 2) return;

        this.points = catmullRom(this.points, CURVE_SPACING, CURVE_MAX_STEPS);
        this.times = [];
        for (let i = 0; i < this.smoothReps; i++) {
            this.smoothStroke();
        }
        this.pressures = [];
    }

    /**
     * Calculates the best-fit plane normal for this stroke using Newell's method
     * @returns {THREE.Vector3} The normalized normal vector
     */
    computeNormal() {
        if (this.points.length < 3) return new THREE.Vector3(0, 0, 1);

        const normal = new THREE.Vector3(0, 0, 0);
        for (let i = 0; i < this.points.length; i++) {
            const curr = this.points[i];
            const next = this.points[(i + 1) % this.points.length];
            normal.x += (curr.y - next.y) * (curr.z + next.z);
            normal.y += (curr.z - next.z) * (curr.x + next.x);
            normal.z += (curr.x - next.x) * (curr.y + next.y);
        }
        normal.normalize();

        // Fallback if normal is zero
        if (normal.lengthSq() < 0.001) {
            return new THREE.Vector3(0, 0, 1);
        }
        return normal;
    }

    /**
     * Records how far the 3D preview should stand this stroke off along its own
     * normal, so two strokes drawn in the same place don't z-fight on screen.
     *
     * It is deliberately not applied to the points. Moving them moved the
     * encoded drawing too, and by a distance that grows with every stroke added
     * -- measured over the harness corpus at 3.4px by the fortieth stroke and
     * 16.7px by the eightieth, on an artwork 640 across. The polyline is what
     * the hand drew and what NAPLPS is regenerated from; a trick for the depth
     * buffer belongs on the mesh, where Frame._refreshGeometry() now puts it.
     *
     * @param {number} amount - Distance to offset
     */
    offsetAlongNormal(amount) {
        this.normalOffset = amount;
    }

    /**
     * Where the 3D preview mesh sits to keep clear of the strokes under it.
     * @returns {THREE.Vector3} Zero unless offsetAlongNormal() asked for more
     */
    previewOffset() {
        if (!this.normalOffset || this.points.length < 3) return new THREE.Vector3();
        return this.computeNormal().multiplyScalar(this.normalOffset);
    }

    /**
     * Computes pressure values for each point based on position in stroke
     * Tapers at both ends using a sine-based falloff
     *
     * Position is distance along the stroke, not point count. By count, a
     * stroke's width followed how often it happened to be sampled -- a slow
     * start crowded with samples came out long and thin, a fast finish short
     * and fat -- and the samples come at whatever rate the machine manages.
     */
    computePressures() {
        this.pressures = [];
        this._measure();
        const n = this.points.length;

        for (let i = 0; i < n; i++) {
            // Sine-based pressure: peaks in middle, tapers at ends
            const t = this._position(i) * Math.PI;
            const pressure = Math.sqrt((1.0 - Math.cos(t)) * 0.5);
            this.pressures.push(pressure);
        }
    }

    // Distance along the stroke to each point.
    _measure() {
        this._arc = [];
        let s = 0;
        for (let i = 0; i < this.points.length; i++) {
            if (i > 0) s += this.points[i].distanceTo(this.points[i - 1]);
            this._arc.push(s);
        }
        this._length = s;
    }

    // How far along the stroke point i is, 0..1 (by count if it has no length).
    _position(i) {
        const n = this.points.length;
        if (this._arc.length !== n) this._measure();
        if (this._length > 1e-9) return this._arc[i] / this._length;
        return i / Math.max(1, n - 1);
    }

    /**
     * Brush radius at one point: tapered along the stroke and scaled by pressure,
     * with both tips pinched to TIP_RADIUS
     * @param {number} i - Point index
     * @returns {number} Radius in the stroke's own units
     */
    radiusAt(i) {
        const lastIndex = this.points.length - 1;
        if (i <= 0 || i >= lastIndex) return TIP_RADIUS;

        if (this.pressures.length !== this.points.length) {
            this.computePressures();
        }
        const taper = Math.pow(1 - this._position(i), this.taperPower);
        const pressure = this.pressures[i] || 1.0;
        return Math.max(this.minThickness * this.thickness, taper * pressure * this.thickness);
    }

    /**
     * Creates brush stroke geometry using quads perpendicular to stroke direction
     * Based on Yellowtail's compile() method by Golan Levin
     * @returns {THREE.BufferGeometry} The brush geometry
     */
    toBrushGeometry() {
        return toGeometry(this.brushArrays());
    }

    /**
     * The brush ribbon as raw arrays, for toBrushGeometry() or the Frame's batch.
     * Left edge then right edge, two triangles per segment; built into typed
     * arrays with scratch vectors, since the stroke being drawn is rebuilt every
     * time it gains a point.
     * @returns {?{positions: Float32Array, indices: Uint32Array}}
     */
    brushArrays() {
        if (this.points.length < 2) return null;

        // Compute pressures if not already set
        if (this.pressures.length !== this.points.length) {
            this.computePressures();
        }

        const normal = this.computeNormal();
        const nPoints = this.points.length;
        const lastIndex = nPoints - 1;
        const positions = new Float32Array(nPoints * 6);
        const indices = new Uint32Array((nPoints - 1) * 6);
        const tangent = _tangent;
        const perp = _perp;

        for (let i = 0; i < nPoints; i++) {
            const p = this.points[i];
            const radius = this.radiusAt(i);

            // Calculate tangent direction
            if (i === 0) {
                // First point: direction to next
                tangent.subVectors(this.points[1], p);
            } else if (i === lastIndex) {
                // Last point: direction from previous
                tangent.subVectors(p, this.points[i - 1]);
            } else {
                // Middle points: average direction (prev to next)
                tangent.subVectors(this.points[i + 1], this.points[i - 1]);
            }

            const tangentLength = tangent.length();
            if (tangentLength < 0.0001) {
                tangent.set(1, 0, 0);
            } else {
                tangent.divideScalar(tangentLength);
            }

            // Calculate perpendicular in the stroke plane. A stroke running
            // along its own normal -- drawn straight at the camera, say -- has no
            // perpendicular there, so fall back to one across the tangent rather
            // than let the ribbon collapse to nothing.
            perp.crossVectors(tangent, normal);
            if (perp.lengthSq() < 1e-8) {
                perp.set(-tangent.y, tangent.x, 0);
                if (perp.lengthSq() < 1e-8) perp.set(0, 1, 0);
            }
            perp.normalize();

            // Left edge at i, right edge at nPoints + i
            const l = i * 3;
            const r = (nPoints + i) * 3;
            positions[l] = p.x + perp.x * radius;
            positions[l + 1] = p.y + perp.y * radius;
            positions[l + 2] = p.z + perp.z * radius;
            positions[r] = p.x - perp.x * radius;
            positions[r + 1] = p.y - perp.y * radius;
            positions[r + 2] = p.z - perp.z * radius;
        }

        // Build quad indices (two triangles per quad)
        for (let i = 0; i < nPoints - 1; i++) {
            const l0 = i;               // left edge, current
            const l1 = i + 1;           // left edge, next
            const r0 = nPoints + i;     // right edge, current
            const r1 = nPoints + i + 1; // right edge, next
            const k = i * 6;

            // Triangle 1: l0, r0, l1
            indices[k] = l0; indices[k + 1] = r0; indices[k + 2] = l1;
            // Triangle 2: l1, r0, r1
            indices[k + 3] = l1; indices[k + 4] = r0; indices[k + 5] = r1;
        }

        // No normals: every material that draws strokes is unlit.
        return { positions, indices };
    }

    /**
     * Projects the stroke into the flat 0..1 space the NAPLPS encoder works in,
     * measuring the brush width there rather than in 3D: a point offset along
     * widthAxis is projected beside each centre point, so the width follows
     * perspective and survives however the stroke was drawn -- including one
     * drawn straight at the camera, which has no width in its own plane at all.
     *
     * @param {(point: THREE.Vector3) => {x: number, y: number}} project - a point of this stroke to 2D
     * @param {THREE.Vector3} widthAxis - a direction across the view, in this stroke's own space
     * @returns {{points: {x: number, y: number}[], radii: number[]}} Centreline and its 2D radii
     */
    toScreenPath(project, widthAxis) {
        const points = [];
        const radii = [];
        const probe = new THREE.Vector3();
        const lastIndex = this.points.length - 1;

        for (let i = 0; i <= lastIndex; i++) {
            const centre = project(this.points[i]);

            probe.copy(this.points[i]).addScaledVector(widthAxis, this.radiusAt(i));
            const edge = project(probe);
            const radius = Math.hypot(edge.x - centre.x, edge.y - centre.y);

            // A point the encoder can't tell from the last one costs four bytes
            // and says nothing -- but never drop the tip, or the stroke shortens,
            // and keep the widest radius of the points that fall together so a
            // slow passage doesn't come out thin.
            const previous = points[points.length - 1];
            if (previous && i !== lastIndex &&
                Math.hypot(centre.x - previous.x, centre.y - previous.y) < MIN_STEP) {
                radii[radii.length - 1] = Math.max(radii[radii.length - 1], radius);
                continue;
            }

            points.push(centre);
            radii.push(radius);
        }

        return { points, radii };
    }

    /**
     * Projects the polyline as a closed polygon for the NAPLPS encoder.
     * The last vertex connects back to the first — no brush expansion.
     *
     * @param {(point: THREE.Vector3) => {x: number, y: number}} project
     * @returns {{x: number, y: number}[]}
     */
    toScreenPolygon(project) {
        const verts = [];
        for (let i = 0; i < this.points.length; i++) {
            const p = project(this.points[i]);
            const prev = verts[verts.length - 1];
            if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < MIN_STEP) continue;
            verts.push(p);
        }
        if (verts.length > 1) {
            const first = verts[0];
            const last = verts[verts.length - 1];
            if (Math.hypot(first.x - last.x, first.y - last.y) >= MIN_STEP) {
                verts.push({ x: first.x, y: first.y });
            }
        }
        return verts;
    }
}

// Scratch vectors for brushArrays(), which runs once per point drawn.
const _tangent = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _color = new THREE.Color();

function toGeometry(arrays) {
    if (!arrays) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
    geometry.setIndex(Array.isArray(arrays.indices) ? arrays.indices : new THREE.BufferAttribute(arrays.indices, 1));
    return geometry;
}

/**
 * A centripetal Catmull-Rom spline through `points`, sampled every `spacing`
 * or so (at most `maxSteps` pieces between two points). It passes through
 * every point it is given, and the centripetal form (alpha 0.5) neither loops
 * nor overshoots where samples bunch up or a stroke turns sharply -- which the
 * uniform form does, and which a slow machine's widely spaced samples ask for.
 * @param {THREE.Vector3[]} points
 * @param {number} spacing
 * @param {number} maxSteps
 * @returns {THREE.Vector3[]} New points (the input is left alone)
 */
export function catmullRom(points, spacing, maxSteps) {
    const n = points.length;
    if (n < 3) return points.map(p => p.clone());

    const out = [points[0].clone()];
    const p0 = new THREE.Vector3();
    const p3 = new THREE.Vector3();
    for (let i = 0; i < n - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        // Past either end, a phantom point continuing the end segment.
        if (i > 0) p0.copy(points[i - 1]); else p0.copy(p1).multiplyScalar(2).sub(p2);
        if (i < n - 2) p3.copy(points[i + 2]); else p3.copy(p2).multiplyScalar(2).sub(p1);

        const steps = Math.min(maxSteps, Math.max(1, Math.ceil(p1.distanceTo(p2) / spacing)));
        const t1 = Math.sqrt(Math.max(p0.distanceTo(p1), 1e-9));
        const t2 = t1 + Math.sqrt(Math.max(p1.distanceTo(p2), 1e-9));
        const t3 = t2 + Math.sqrt(Math.max(p2.distanceTo(p3), 1e-9));
        for (let k = 1; k <= steps; k++) {
            if (k === steps) {
                out.push(p2.clone());
                break;
            }
            const t = t1 + (t2 - t1) * k / steps;
            out.push(barryGoldman(p0, p1, p2, p3, 0, t1, t2, t3, t));
        }
    }
    return out;
}

// One point of a Catmull-Rom segment, by Barry and Goldman's pyramid, with
// the knots at t0..t3. Worked per axis rather than with vectors, since the
// stroke being drawn is refitted every time it gains a point.
function barryGoldman(p0, p1, p2, p3, t0, t1, t2, t3, t) {
    const a1 = (t1 - t) / (t1 - t0), a1b = (t - t0) / (t1 - t0);
    const a2 = (t2 - t) / (t2 - t1), a2b = (t - t1) / (t2 - t1);
    const a3 = (t3 - t) / (t3 - t2), a3b = (t - t2) / (t3 - t2);
    const b1 = (t2 - t) / (t2 - t0), b1b = (t - t0) / (t2 - t0);
    const b2 = (t3 - t) / (t3 - t1), b2b = (t - t1) / (t3 - t1);
    const axis = (v0, v1, v2, v3) => {
        const A1 = a1 * v0 + a1b * v1;
        const A2 = a2 * v1 + a2b * v2;
        const A3 = a3 * v2 + a3b * v3;
        return a2 * (b1 * A1 + b1b * A2) + a2b * (b2 * A2 + b2b * A3);
    };
    return new THREE.Vector3(
        axis(p0.x, p1.x, p2.x, p3.x),
        axis(p0.y, p1.y, p2.y, p3.y),
        axis(p0.z, p1.z, p2.z, p3.z)
    );
}

/**
 * Every completed stroke in one mesh: one buffer of positions and colours,
 * one draw call.
 *
 * Each stroke had a mesh of its own, and each mesh is a draw call. Attract
 * mode replays drawings of 600 to 1900 polygons, and on a Raspberry Pi 4 six
 * hundred draw calls cost 10 ms of every frame before the GPU drew a pixel.
 * Strokes only ever come and go at the end -- endStroke() appends, undo()
 * pops -- so a stroke is written once, into the space after the last one, and
 * only that part of the buffer goes to the GPU.
 */
class StrokeBatch {
    constructor(parent) {
        this.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
        this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
        this.mesh.frustumCulled = false;
        parent.add(this.mesh);

        this.vertexCount = 0;
        this.indexCount = 0;
        this.ranges = [];     // per appended stroke: where it starts
        this._positions = new Float32Array(0);
        this._colors = new Float32Array(0);
        this._indices = new Uint32Array(0);
        this._reserve(8192, 16384);
    }

    get count() {
        return this.ranges.length;
    }

    /**
     * @param {?{positions: Float32Array, indices: ArrayLike<number>}} arrays
     *   null for a stroke with no geometry, which still takes a place so the
     *   batch stays in step with Frame.strokes
     * @param {number} color - hex
     * @param {THREE.Vector3} offset - added to every position (the preview offset)
     */
    append(arrays, color, offset) {
        this.ranges.push({ vertex: this.vertexCount, index: this.indexCount });
        if (!arrays) return;

        const vn = arrays.positions.length / 3;
        const inCount = arrays.indices.length;
        this._reserve(this.vertexCount + vn, this.indexCount + inCount);

        // Colours as the material would have held them: MeshBasicMaterial's
        // colour is converted out of sRGB, vertex colours are used as given.
        _color.setHex(color);
        const v0 = this.vertexCount;
        const pos = this._positions;
        const col = this._colors;
        const src = arrays.positions;
        for (let i = 0; i < vn; i++) {
            const k = (v0 + i) * 3;
            pos[k] = src[i * 3] + offset.x;
            pos[k + 1] = src[i * 3 + 1] + offset.y;
            pos[k + 2] = src[i * 3 + 2] + offset.z;
            col[k] = _color.r;
            col[k + 1] = _color.g;
            col[k + 2] = _color.b;
        }
        const idx = this._indices;
        const i0 = this.indexCount;
        for (let i = 0; i < inCount; i++) idx[i0 + i] = arrays.indices[i] + v0;

        const geometry = this.mesh.geometry;
        const position = geometry.getAttribute('position');
        const colorAttr = geometry.getAttribute('color');
        position.addUpdateRange(v0 * 3, vn * 3);
        colorAttr.addUpdateRange(v0 * 3, vn * 3);
        geometry.index.addUpdateRange(i0, inCount);
        position.needsUpdate = true;
        colorAttr.needsUpdate = true;
        geometry.index.needsUpdate = true;

        this.vertexCount += vn;
        this.indexCount += inCount;
        geometry.setDrawRange(0, this.indexCount);
    }

    /** Removes the last stroke appended. */
    pop() {
        const range = this.ranges.pop();
        if (!range) return;
        this.vertexCount = range.vertex;
        this.indexCount = range.index;
        this.mesh.geometry.setDrawRange(0, this.indexCount);
    }

    clear() {
        this.ranges.length = 0;
        this.vertexCount = 0;
        this.indexCount = 0;
        this.mesh.geometry.setDrawRange(0, 0);
    }

    // Grows the buffers (doubling) to hold this many vertices and indices. A
    // new geometry each time, since a GL buffer can't be resized in place and
    // disposing the old geometry is what frees its buffers.
    _reserve(vertices, indices) {
        if (vertices <= this._positions.length / 3 && indices <= this._indices.length) return;

        const vCap = Math.max(vertices, this._positions.length / 3 * 2);
        const iCap = Math.max(indices, this._indices.length * 2);
        const positions = new Float32Array(vCap * 3);
        const colors = new Float32Array(vCap * 3);
        const index = new Uint32Array(iCap);
        positions.set(this._positions.subarray(0, this.vertexCount * 3));
        colors.set(this._colors.subarray(0, this.vertexCount * 3));
        index.set(this._indices.subarray(0, this.indexCount));
        this._positions = positions;
        this._colors = colors;
        this._indices = index;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setIndex(new THREE.BufferAttribute(index, 1).setUsage(THREE.DynamicDrawUsage));
        geometry.setDrawRange(0, this.indexCount);
        this.mesh.geometry.dispose();
        this.mesh.geometry = geometry;
    }
}

export class Frame extends THREE.Group {
    /**
     * @param {THREE.Object3D} worldOrigin - The world origin node this frame is parented to
     * @param {number} [color=0xffffff] - Default stroke color
     */
    constructor(worldOrigin, color = 0xffffff) {
        super();
        this.strokes = [];
        this.worldOrigin = worldOrigin;
        this.activeStroke = null;
        this.defaultColor = color;

        // Create the line segments geometry and mesh with vertex colors
        this.geometry = new THREE.BufferGeometry();
        this.material = new THREE.LineBasicMaterial({ vertexColors: true });
        this.lineMesh = new THREE.LineSegments(this.geometry, this.material);
        this.lineMesh.frustumCulled = false;
        this.add(this.lineMesh);

        // Per-controller active stroke state (keyed by controller ID)
        this._activeStrokes = new Map();  // controllerId -> Stroke

        // Completed strokes, all in one mesh -- see StrokeBatch. It holds one
        // entry per stroke, in step with `strokes` (see _refreshGeometry).
        this._batch = new StrokeBatch(this);
        this._tempFillMeshes = new Map(); // controllerId -> temp fill mesh
        this._dirty = new Set();          // controllerIds whose temp mesh is stale
        // Shared materials for the strokes being drawn, one per colour (see _materialFor).
        this._materials = new Map();      // colour -> MeshBasicMaterial

        // Stroke counter for Z-offset to prevent z-fighting
        this._strokeCounter = 0;
        this._zOffsetPerStroke = 0.002;

        // Parent this frame to the world origin
        worldOrigin.add(this);
    }

    /**
     * Check if a specific controller has an active stroke
     * @param {number|string} controllerId
     * @returns {boolean}
     */
    hasActiveStroke(controllerId) {
        return this._activeStrokes.has(controllerId);
    }

    /**
     * Begins a new stroke at the given position for a specific controller
     * @param {THREE.Vector3} worldPosition - Starting world position
     * @param {number|string} controllerId - Controller identifier
     * @param {number} [color] - Stroke color (optional)
     * @param {number} [time] - When the point was measured, ms (see endStroke)
     * @returns {Stroke} The new stroke
     */
    beginStroke(worldPosition, controllerId, color, time) {
        const stroke = new Stroke(color ?? this.defaultColor);
        this._activeStrokes.set(controllerId, stroke);
        stroke.addPoint(this.worldToLocal(worldPosition.clone()), time);
        this._dirty.add(controllerId);
        return stroke;
    }

    /**
     * Continues the active stroke with a new point for a specific controller
     * @param {THREE.Vector3} worldPosition - World position to add
     * @param {number|string} controllerId - Controller identifier
     * @param {number} [time] - When the point was measured, ms (see endStroke)
     */
    continueStroke(worldPosition, controllerId, time) {
        const activeStroke = this._activeStrokes.get(controllerId);
        if (!activeStroke) return;
        if (activeStroke.addPoint(this.worldToLocal(worldPosition.clone()), time)) {
            this._dirty.add(controllerId);
        }
    }

    /**
     * Ends the current stroke for a specific controller
     * @param {number|string} controllerId - Controller identifier
     * @param {number} [cutTime] - Drop the points measured after this (ms): the
     *   part of the stroke drawn while the hand was changing to the sign that
     *   ended it. Left out, every point is kept.
     */
    endStroke(controllerId, cutTime) {
        const activeStroke = this._activeStrokes.get(controllerId);

        if (activeStroke && cutTime !== undefined) activeStroke.trimAfter(cutTime);
        if (activeStroke) activeStroke.keepDot();

        if (activeStroke && activeStroke.points.length > 1) {
            // Refine the stroke (curve fit + smooth) before finalizing
            activeStroke.refine();

            // Offset along normal to prevent z-fighting with other strokes
            activeStroke.offsetAlongNormal(this._strokeCounter * this._zOffsetPerStroke);
            this._strokeCounter++;

            this.strokes.push(activeStroke);
        }

        this._activeStrokes.delete(controllerId);
        this._dirty.delete(controllerId);

        // Clean up temp fill mesh
        const tempFill = this._tempFillMeshes.get(controllerId);
        if (tempFill) {
            this.remove(tempFill);
            tempFill.geometry.dispose();
            this._tempFillMeshes.delete(controllerId);
        }

        // Final refresh with completed stroke
        this._refreshGeometry();
    }

    /**
     * Rebuilds the meshes of the strokes being drawn, if they have changed.
     * Call once a frame, before rendering: a stroke can gain several points
     * between frames, and it used to be rebuilt after each of them.
     */
    flush() {
        if (!this._dirty.size) return;
        for (const controllerId of this._dirty) this._updateTempFill(controllerId);
        this._dirty.clear();
    }

    /**
     * Brings the batch in line with `strokes`.
     *
     * A completed stroke never changes again -- endStroke() refines it and
     * fixes its z-offset before pushing it -- so it goes into the batch once
     * and stays. The two ways `strokes` moves are cheap to follow: endStroke()
     * appends, undo() pops.
     *
     * This used to dispose and rebuild every stroke's geometry on every call,
     * and continueStroke() called it once per point -- so a drawing of N
     * strokes cost O(N^2) triangulations. Attract mode replays files of
     * 600-1900 polygons, so it met that wall every time it ran.
     * @private
     */
    _refreshGeometry() {
        const batch = this._batch;
        while (batch.count > this.strokes.length) batch.pop();
        for (let i = batch.count; i < this.strokes.length; i++) {
            const stroke = this.strokes[i];
            const arrays = stroke.closed ? stroke.fillArrays() : stroke.brushArrays();
            batch.append(arrays, stroke.color, stroke.previewOffset());
        }
    }

    /**
     * One material per colour, shared by every mesh that draws in it and owned
     * by the Frame -- meshes come and go far too often to each own one. clear()
     * is the only thing that disposes them.
     * @private
     */
    _materialFor(color) {
        let mat = this._materials.get(color);
        if (!mat) {
            mat = new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide });
            this._materials.set(color, mat);
        }
        return mat;
    }

    /**
     * Rebuilds the temp mesh for a stroke being drawn: the same curve refine()
     * will give it, so what is drawn is what stays.
     * @private
     */
    _updateTempFill(controllerId) {
        const existing = this._tempFillMeshes.get(controllerId);
        if (existing) {
            this.remove(existing);
            existing.geometry.dispose();   // the material is shared; clear() owns it
            this._tempFillMeshes.delete(controllerId);
        }

        const activeStroke = this._activeStrokes.get(controllerId);
        if (!activeStroke || activeStroke.points.length < 2) return;

        const preview = new Stroke(activeStroke.color);
        preview.closed = activeStroke.closed;
        preview.points = catmullRom(activeStroke.points, CURVE_SPACING, CURVE_MAX_STEPS);

        const geometry = preview.closed ? preview.toFillGeometry() : preview.toBrushGeometry();
        if (!geometry) return;

        const mesh = new THREE.Mesh(geometry, this._materialFor(activeStroke.color));
        mesh.frustumCulled = false;
        this.add(mesh);
        this._tempFillMeshes.set(controllerId, mesh);
    }

    /**
     * Removes the last completed stroke
     * @returns {boolean} True if a stroke was removed, false if no strokes to undo
     */
    undo() {
        if (this.strokes.length === 0) {
            return false;
        }
        this.strokes.pop();
        this._refreshGeometry();
        return true;
    }

    /**
     * Flickers the last stroke for 0.3 seconds then removes it
     * @param {Function} [onComplete] - Callback when flicker and removal complete
     * @returns {boolean} True if undo started, false if no strokes
     */
    undoWithFlicker(onComplete) {
        if (this.strokes.length === 0) {
            if (onComplete) onComplete(false);
            return false;
        }

        // Get the last stroke and create a temporary mesh for it
        const strokeToRemove = this.strokes[this.strokes.length - 1];
        const segments = strokeToRemove.toLineSegments();
        const tempGeometry = new THREE.BufferGeometry().setFromPoints(segments);
        const tempMaterial = new THREE.LineBasicMaterial({ color: strokeToRemove.color });
        const tempMesh = new THREE.LineSegments(tempGeometry, tempMaterial);
        tempMesh.frustumCulled = false;
        this.add(tempMesh);

        // Remove the stroke from main geometry immediately (temp mesh shows it)
        this.strokes.pop();
        this._refreshGeometry();

        // Flicker the temp mesh
        const startTime = performance.now();
        const flicker = () => {
            const elapsed = performance.now() - startTime;
            if (elapsed < FLICKER_DURATION) {
                tempMesh.visible = Math.floor(elapsed / FLICKER_INTERVAL) % 2 === 0;
                requestAnimationFrame(flicker);
            } else {
                // Cleanup temp mesh
                this.remove(tempMesh);
                tempGeometry.dispose();
                tempMaterial.dispose();
                if (onComplete) onComplete(true);
            }
        };
        flicker();
        return true;
    }

    /**
     * Clears all strokes and resets the world origin
     */
    clear() {
        this.strokes = [];
        this._activeStrokes.clear();
        this._dirty.clear();
        this._batch.clear();

        for (const mesh of this._tempFillMeshes.values()) {
            this.remove(mesh);
            mesh.geometry.dispose();
        }
        this._tempFillMeshes.clear();

        // The meshes above shared these, so they outlive any one of them and
        // are the Frame's to release. Nothing disposed them before, which left
        // one material per stroke behind on every clear.
        for (const mat of this._materials.values()) mat.dispose();
        this._materials.clear();

        // Reset stroke counter
        this._strokeCounter = 0;

        // Clear geometry
        this.geometry.setFromPoints([]);

        // Reset world origin transform
        this.worldOrigin.position.set(0, 0, 0);
        this.worldOrigin.quaternion.identity();
        this.worldOrigin.scale.set(1, 1, 1);
    }

    /**
     * Flickers the entire Frame for 0.3 seconds then clears everything
     * @param {Function} [onComplete] - Callback when flicker and clear complete
     */
    clearWithFlicker(onComplete) {
        const startTime = performance.now();
        const flicker = () => {
            const elapsed = performance.now() - startTime;
            if (elapsed < FLICKER_DURATION) {
                const vis = Math.floor(elapsed / FLICKER_INTERVAL) % 2 === 0;
                this.lineMesh.visible = vis;
                this._batch.mesh.visible = vis;
                requestAnimationFrame(flicker);
            } else {
                this.lineMesh.visible = true;
                this._batch.mesh.visible = true;
                this.clear();
                if (onComplete) onComplete();
            }
        };
        flicker();
    }
}
