import * as THREE from 'three';

// Number of points to trim from start and end of each stroke
const pointsTrimStart = 1;
const pointsTrimEnd = 5;

// Flicker duration and interval for undo/clear animations
const FLICKER_DURATION = 300; // ms
const FLICKER_INTERVAL = 50; // ms

// The pinch at each end of a stroke, in the stroke's own units, so a brush
// doesn't start or stop with a flare.
const TIP_RADIUS = 0.01;

// The next few are in frame widths -- the 0..1 space toBrushShapes works in,
// where 1 is the whole drawing, so 0.005 is about three pixels of a 640-wide one.
export const MIN_STEP = 0.0005; // 1/2048: a shorter step is a rounding error to the encoder
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
export const BRUSH_SIMPLIFY = MIN_STEP;

// How much room a piece needs before the encoder's rounding could fold it. Four
// quanta is twice the worst fold measured over a stress corpus of strokes drawn
// tiny, distant, and doubled back on themselves.
const PIECE_SAFE_HEIGHT = 4 * MIN_STEP;

// How far a join or cap arc may turn between points. At 45 degrees a half-turn
// join costs five points and a cap four, and the corpus scores that level with
// 30 degrees for fewer bytes -- an arc is the roundest thing a brush has and
// also, at these radii, the least visible.
const JOIN_ARC_STEP = Math.PI / 4;

// How far inside the frame a clamped point is held. Each delta the encoder
// writes can fall half a quantum short of where it was asked for, and the
// longest piece here is six of them -- a cap or a widest-turn fan, since
// arcPoints() never spends more than four steps on a half turn -- so a point
// pinned to the very edge can decode just outside it, and both renderers drop a
// point that lands outside rather than pulling it back. Four quanta of margin
// covers the three a six-point piece can lose; the "half off screen" check in
// tools/brush-geometry asserts it over strokes leaving the frame in every
// direction.
const FRAME_MARGIN = 4 * MIN_STEP;

// Extra runs of pieces laid over the stroke, each offset along it by an even
// fraction of a segment, so a polygon that goes missing on the way to the Pi
// leaves a covered gap rather than a notch in the stroke. A staggered run's
// joints fall where the plain run's segments are straight and its segments
// straddle the plain run's joints, so the two cover each other's weak points
// rather than the same one twice.
//
// 0 is the plain run. Each pass adds about as many polygons as the plain run
// has, and convertToNAPLPS() only buys them once the centreline itself fits --
// so this is what a busy drawing gives up, rather than the shape of its strokes.
// It used to be the other way round: every drawing paid for the cover run first,
// and a busy one paid for it by having its centreline thinned until the polygons
// lost their shape.
export const BRUSH_OVERLAP_PASSES = 1;

/**
 * Ramer-Douglas-Peucker, over indices rather than points so that anything held
 * per point -- here the brush radius -- can follow the centreline through it.
 * (index.html has its own copy for SVG import; it returns points, and lives on
 * `window` where a module can't reach it cleanly.)
 * @param {{x: number, y: number}[]} points
 * @param {number} epsilon - Tolerance in frame widths
 * @param {number} first - First index of the span to simplify
 * @param {number} last - Last index of the span
 * @returns {number[]} Indices to keep, in order
 */
function simplifyIndices(points, epsilon, first, last) {
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

/**
 * Distance from a point to a line segment
 * @returns {number}
 */
function pointLineDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);

    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Simplifies a centreline, carrying its radii along
 * @param {{points: {x: number, y: number}[], radii: number[]}} path
 * @param {number} epsilon
 * @returns {{points: {x: number, y: number}[], radii: number[]}}
 */
function simplifyPath(path, epsilon) {
    if (path.points.length < 3) return path;

    const keep = simplifyIndices(path.points, epsilon, 0, path.points.length - 1);
    return {
        points: keep.map(i => path.points[i]),
        radii: keep.map(i => path.radii[i])
    };
}

/**
 * Points along a circular arc, from one angle to another by the shorter way
 * round, at no more than JOIN_ARC_STEP between them. Both ends are included, so
 * an arc meets the straight edges either side of it exactly.
 * @param {{x: number, y: number}} centre
 * @param {number} radius
 * @param {number} from - Angle in radians
 * @param {number} to
 * @returns {{x: number, y: number}[]}
 */
function arcPoints(centre, radius, from, to) {
    let sweep = to - from;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;

    // Never more points than the format can tell apart. An arc point closer to
    // the one before it than the fold test's own margin carries no shape the
    // encoder could keep, and costs four bytes to say so -- which is what turned
    // a fan on a small radius into a dozen sub-pixel slivers.
    const steps = Math.max(1, Math.min(
        Math.ceil(Math.abs(sweep) / JOIN_ARC_STEP),
        Math.floor((Math.abs(sweep) * radius) / PIECE_SAFE_HEIGHT)
    ));
    const points = [];

    for (let i = 0; i <= steps; i++) {
        const angle = from + (sweep * i) / steps;
        points.push({
            x: centre.x + Math.cos(angle) * radius,
            y: centre.y + Math.sin(angle) * radius
        });
    }

    return points;
}

/**
 * A closed circle, for a stroke with no length to lay a trapezoid along.
 * @param {{x: number, y: number}} centre
 * @param {number} radius
 * @returns {{x: number, y: number}[]}
 */
function discPoints(centre, radius) {
    const steps = Math.max(4, Math.ceil((2 * Math.PI) / JOIN_ARC_STEP));
    const points = [];

    for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * 2 * Math.PI;
        points.push({
            x: centre.x + Math.cos(angle) * radius,
            y: centre.y + Math.sin(angle) * radius
        });
    }

    return points;
}

/**
 * The shortest distance from any vertex of a polygon to the line through its two
 * neighbours -- how much room the encoder's rounding has to fold the shape over
 * itself. A healthy quad measures about a brush width here; one pinched to a
 * sliver, or flattened against the frame by clamping, measures nearly nothing.
 * @param {{x: number, y: number}[]} poly
 * @returns {number} In frame widths
 */
function cornerHeight(poly) {
    let min = Infinity;

    for (let i = 0; i < poly.length; i++) {
        const point = poly[i];
        const before = poly[(i + poly.length - 1) % poly.length];
        const after = poly[(i + 1) % poly.length];

        const span = Math.hypot(after.x - before.x, after.y - before.y);
        if (span < 1e-12) return 0; // the neighbours are the same point: no shape left

        const twiceArea = Math.abs((after.x - before.x) * (before.y - point.y) -
                                   (before.x - point.x) * (after.y - before.y));
        min = Math.min(min, twiceArea / span);
    }

    return min;
}

/**
 * Cuts a quad in two along its shorter diagonal, so neither half comes out
 * thinner than it has to be.
 * @param {{x: number, y: number}[]} quad
 * @returns {{x: number, y: number}[][]} Two triangles
 */
function splitQuad(quad) {
    const [a, b, c, d] = quad;
    const acrossAC = Math.hypot(c.x - a.x, c.y - a.y);
    const acrossBD = Math.hypot(d.x - b.x, d.y - b.y);

    return acrossAC <= acrossBD
        ? [[a, b, c], [a, c, d]]
        : [[b, c, d], [b, d, a]];
}

/**
 * Whether any part of a polygon lies inside the 0..1 frame
 * @param {{x: number, y: number}[]} poly
 * @returns {boolean}
 */
function touchesFrame(poly) {
    const xs = poly.map(p => p.x);
    const ys = poly.map(p => p.y);
    return Math.min(...xs) <= 1 && Math.max(...xs) >= 0 &&
           Math.min(...ys) <= 1 && Math.max(...ys) >= 0;
}

/**
 * The brush laid down exactly, as a tiling of convex pieces: one trapezoid along
 * each segment of a centreline, one fan filling the wedge left at each interior
 * vertex, and a round cap at each end.
 *
 * This is a tiling where it used to be a covering. Consecutive quads reached
 * past their shared joint far enough to hide the wedge between them, which
 * fills a corner by painting over it -- close enough at a gentle turn, and
 * visibly blunt at a sharp one. A fan fills the same wedge exactly for about
 * the same bytes, because what it costs is the overlap it replaces.
 *
 * Every piece is convex, so no winding rule has an opinion about one, and every
 * piece is short, so the encoder's running delta cursor is reset long before it
 * can drift. Fans and caps carry their hub first, which is what lets
 * toBrushPolygons() cut one into triangles if the encoder's rounding would
 * leave it fragile.
 *
 * Both the plain run and every staggered overlap run are built by this, so the
 * two are the same shape and differ only in where their joints fall.
 *
 * @param {{x: number, y: number}[]} points
 * @param {number[]} radii
 * @returns {{x: number, y: number}[][]} Closed convex polygons, in drawing order
 */
function piecesAlong(points, radii) {
    const lastPoint = points.length - 1;
    const pieces = [];

    // The encoder silently drops a point outside the frame, and every point
    // after it in that polygon is a delta from the one dropped, so the rest of
    // the shape lands somewhere else entirely. Keep the pieces that touch the
    // frame and clamp them into it; skip the rest.
    const add = (piece) => {
        if (piece.length >= 3 && touchesFrame(piece)) pieces.push(piece.map(clampToFrame));
    };

    // Each segment's direction, and null where two points fall together
    const tangents = [];
    for (let i = 0; i < lastPoint; i++) {
        const dx = points[i + 1].x - points[i].x;
        const dy = points[i + 1].y - points[i].y;
        const length = Math.hypot(dx, dy);
        tangents.push(length < MIN_STEP ? null : { x: dx / length, y: dy / length });
    }

    const radiusAt = (i) => Math.max(radii[i], MIN_RADIUS);

    // One trapezoid along each segment, on that segment's own perpendicular
    for (let i = 0; i < lastPoint; i++) {
        const t = tangents[i];
        if (!t) continue;

        const a = points[i];
        const b = points[i + 1];
        const ra = radiusAt(i);
        const rb = radiusAt(i + 1);

        add([
            { x: a.x - t.y * ra, y: a.y + t.x * ra },
            { x: b.x - t.y * rb, y: b.y + t.x * rb },
            { x: b.x + t.y * rb, y: b.y - t.x * rb },
            { x: a.x + t.y * ra, y: a.y - t.x * ra }
        ]);
    }

    // A fan over the wedge on the outside of each turn -- the side the two
    // segments open away from, which is the only side that leaves a gap
    for (let i = 1; i < lastPoint; i++) {
        const into = tangents[i - 1];
        const outOf = tangents[i];
        if (!into || !outOf) continue;

        const cross = into.x * outOf.y - into.y * outOf.x;
        const turn = Math.atan2(cross, into.x * outOf.x + into.y * outOf.y);
        const radius = radiusAt(i);

        // How far the wedge reaches past the two trapezoid edges that meet here
        // -- the sagitta of the arc across it. Below a quantum the two corners
        // round to the same coordinate, so there is nothing there to fill and a
        // fan would be a polygon's worth of bytes spent on nothing. A brush
        // thinner than the fold test's margin has no room for a corner at all.
        //
        // This is most of what a fine tolerance costs. A centreline simplified
        // near the encoder's own quantum turns by a degree or two at nearly
        // every vertex, and a fan at each of those doubled the polygon count to
        // fill gaps that cannot be represented. Where the turn is sharp enough
        // to leave a visible wedge -- about 30 degrees at a typical brush width
        // -- the fan is still exact, which is the case the old corner reach was
        // getting visibly blunt.
        if (radius < PIECE_SAFE_HEIGHT) continue;
        if (radius * (1 - Math.cos(turn / 2)) < MIN_STEP) continue;

        const side = cross > 0 ? -1 : 1;
        add([points[i], ...arcPoints(points[i], radius,
                                     Math.atan2(side * into.x, -side * into.y),
                                     Math.atan2(side * outOf.x, -side * outOf.y))]);
    }

    // A round cap at each end, so a stroke starts and stops where the hand did
    // rather than on the flat edge of its first and last trapezoid. A tip
    // pinched thinner than the fold test's margin sits inside the rounding of
    // that trapezoid, so there is nothing left there to round off.
    const firstTangent = tangents.find((t) => t);
    const lastTangent = tangents.reduce((found, t) => t || found, null);

    if (firstTangent && radiusAt(0) >= PIECE_SAFE_HEIGHT) {
        const angle = Math.atan2(firstTangent.x, -firstTangent.y);
        add([points[0], ...arcPoints(points[0], radiusAt(0), angle, angle + Math.PI)]);
    }
    if (lastTangent && radiusAt(lastPoint) >= PIECE_SAFE_HEIGHT) {
        const angle = Math.atan2(-lastTangent.x, lastTangent.y);
        add([points[lastPoint], ...arcPoints(points[lastPoint], radiusAt(lastPoint), angle, angle + Math.PI)]);
    }

    return pieces;
}

/**
 * The centreline resampled `t` of the way along each of its segments, with the
 * two ends kept -- the path a staggered overlap run is built on. At t = 0.5 its
 * points sit at the middle of each segment, so its joints land where the plain
 * run is straight and its segments straddle the plain run's joints. Keeping the
 * ends means the tips of the stroke are covered twice as well.
 * @param {{x: number, y: number}[]} points
 * @param {number[]} radii
 * @param {number} t - Where along each segment to sample, 0..1
 * @returns {{points: {x: number, y: number}[], radii: number[]}}
 */
function staggerPath(points, radii, t) {
    const last = points.length - 1;
    const out = { points: [points[0]], radii: [radii[0]] };

    for (let i = 0; i < last; i++) {
        out.points.push({
            x: points[i].x + (points[i + 1].x - points[i].x) * t,
            y: points[i].y + (points[i + 1].y - points[i].y) * t
        });
        out.radii.push(radii[i] + (radii[i + 1] - radii[i]) * t);
    }

    out.points.push(points[last]);
    out.radii.push(radii[last]);
    return out;
}

/**
 * @param {{x: number, y: number}} p
 * @returns {{x: number, y: number}} The point pulled inside the frame, and far
 *     enough inside to still be there once it has been through the encoder
 */
function clampToFrame(p) {
    return {
        x: Math.max(FRAME_MARGIN, Math.min(1 - FRAME_MARGIN, p.x)),
        y: Math.max(FRAME_MARGIN, Math.min(1 - FRAME_MARGIN, p.y))
    };
}

export class Stroke {
    constructor(color = 0xffffff) {
        this.points = [];
        this.color = color;
        this.smoothReps = 10;
        this.splitReps = 2;
        this.thickness = 0.25; // Brush thickness
        this.pressures = [];   // Pressure values per point (0-1)
        this.taperPower = 0.4; // Taper exponent for ends
        this.minThickness = 0.3; // Minimum thickness multiplier
        this.normalOffset = 0; // 3D preview only -- see offsetAlongNormal()
    }

    /**
     * Adds a point to the stroke
     * @param {THREE.Vector3} point - Position to add
     */
    addPoint(point) {
        this.points.push(point.clone());
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
        const indices = THREE.ShapeUtils.triangulateShape(points2D, []);

        // Build geometry with original 3D points
        const vertices = [];
        for (const p of this.points) {
            vertices.push(p.x, p.y, p.z);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setIndex(indices.flat());
        geometry.computeVertexNormals();

        return geometry;
    }

    /**
     * Subdivides the stroke by inserting midpoints between each pair of points
     */
    splitStroke() {
        for (let i = 1; i < this.points.length; i += 2) {
            const x = (this.points[i].x + this.points[i - 1].x) / 2;
            const y = (this.points[i].y + this.points[i - 1].y) / 2;
            const z = (this.points[i].z + this.points[i - 1].z) / 2;
            const p = new THREE.Vector3(x, y, z);
            this.points.splice(i, 0, p);
        }
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
     * Refines the stroke by splitting and smoothing multiple times
     */
    refine() {
        if (this.points.length < 2) return;

        // First do splitReps iterations of split + smooth
        for (let i = 0; i < this.splitReps; i++) {
            this.splitStroke();
            this.smoothStroke();
        }
        // Then do remaining smooth-only iterations
        for (let i = 0; i < this.smoothReps - this.splitReps; i++) {
            this.smoothStroke();
        }
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
     */
    computePressures() {
        this.pressures = [];
        const n = this.points.length;
        if (n === 0) return;

        for (let i = 0; i < n; i++) {
            // Sine-based pressure: peaks in middle, tapers at ends
            const t = i / Math.max(1, n - 1) * Math.PI;
            const pressure = Math.sqrt((1.0 - Math.cos(t)) * 0.5);
            this.pressures.push(pressure);
        }
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
        const taper = Math.pow((lastIndex - i) / Math.max(1, lastIndex), this.taperPower);
        const pressure = this.pressures[i] || 1.0;
        return Math.max(this.minThickness * this.thickness, taper * pressure * this.thickness);
    }

    /**
     * Creates brush stroke geometry using quads perpendicular to stroke direction
     * Based on Yellowtail's compile() method by Golan Levin
     * @returns {THREE.BufferGeometry} The brush geometry
     */
    toBrushGeometry() {
        if (this.points.length < 2) return null;

        // Compute pressures if not already set
        if (this.pressures.length !== this.points.length) {
            this.computePressures();
        }

        const normal = this.computeNormal();
        const vertices = [];
        const indices = [];

        const nPoints = this.points.length;
        const lastIndex = nPoints - 1;

        // Arrays to store left and right edge points
        const leftEdge = [];
        const rightEdge = [];

        for (let i = 0; i < nPoints; i++) {
            const p = this.points[i];
            const radius = this.radiusAt(i);

            // Calculate tangent direction
            let tangent = new THREE.Vector3();
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
            const perp = new THREE.Vector3().crossVectors(tangent, normal);
            if (perp.lengthSq() < 1e-8) {
                perp.set(-tangent.y, tangent.x, 0);
                if (perp.lengthSq() < 1e-8) perp.set(0, 1, 0);
            }
            perp.normalize();

            // Create left and right edge points
            const left = p.clone().addScaledVector(perp, radius);
            const right = p.clone().addScaledVector(perp, -radius);

            leftEdge.push(left);
            rightEdge.push(right);
        }

        // Build vertices array (left edge then right edge)
        for (let i = 0; i < nPoints; i++) {
            vertices.push(leftEdge[i].x, leftEdge[i].y, leftEdge[i].z);
        }
        for (let i = 0; i < nPoints; i++) {
            vertices.push(rightEdge[i].x, rightEdge[i].y, rightEdge[i].z);
        }

        // Build quad indices (two triangles per quad)
        for (let i = 0; i < nPoints - 1; i++) {
            const l0 = i;               // left edge, current
            const l1 = i + 1;           // left edge, next
            const r0 = nPoints + i;     // right edge, current
            const r1 = nPoints + i + 1; // right edge, next

            // Triangle 1: l0, r0, l1
            indices.push(l0, r0, l1);
            // Triangle 2: l1, r0, r1
            indices.push(l1, r0, r1);
        }

        // Create geometry
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        return geometry;
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
     * The stroke as the exact tiling of convex pieces described by
     * piecesAlong(), in the 0..1 space NAPLPS draws in.
     *
     * The centreline is projected first and the pieces are regenerated from the
     * 2D points, so what is laid down is the shape as seen rather than a 3D
     * shape flattened afterwards. A piece built on one segment's own
     * perpendicular is convex, where a single long outline of the whole stroke
     * crosses itself at every tight turn and fills differently on every
     * renderer.
     *
     * `passes` staggered runs follow the plain one, offset half a segment along
     * the stroke, so every part of it is covered by more than one polygon and a
     * polygon lost on the way to the Pi leaves paint behind it. They are the
     * second call on the byte budget, not the first: convertToNAPLPS() fits the
     * centreline before it asks for these. See BRUSH_OVERLAP_PASSES.
     *
     * This is the shape; toBrushPolygons() is what gets encoded.
     *
     * @param {(point: THREE.Vector3) => {x: number, y: number}} project - a point of this stroke to 2D
     * @param {THREE.Vector3} widthAxis - a direction across the view, in this stroke's own space
     * @param {number} [epsilon=BRUSH_SIMPLIFY] - how far simplification may move a point
     * @param {number} [passes=BRUSH_OVERLAP_PASSES] - staggered overlap runs to lay
     *     over the plain one, each covering the joints of the last
     * @returns {{x: number, y: number}[][]} Closed convex polygons, in drawing order
     */
    toBrushShapes(project, widthAxis, epsilon = BRUSH_SIMPLIFY, passes = BRUSH_OVERLAP_PASSES) {
        if (this.points.length < 2) return [];

        const { points, radii } = simplifyPath(this.toScreenPath(project, widthAxis), epsilon);
        const pieces = piecesAlong(points, radii);

        // Each staggered run is laid down after the whole plain run rather than
        // beside the pieces it covers, so a loss that takes a contiguous stretch
        // of the stream still leaves the cover for it further along.
        for (let pass = 1; pass <= passes && points.length >= 2; pass++) {
            const stagger = staggerPath(points, radii, pass / (passes + 1));
            pieces.push(...piecesAlong(stagger.points, stagger.radii));
        }

        // A stroke can land on a single spot -- drawn straight at the camera, or
        // held still. There was paint on it, so leave a dab rather than nothing.
        if (pieces.length === 0 && points.length > 0) {
            const dab = discPoints(points[0], Math.max(...radii, MIN_RADIUS));
            if (touchesFrame(dab)) pieces.push(dab.map(clampToFrame));
        }

        return pieces;
    }

    /**
     * The stroke as the filled polygons that get encoded: the pieces above, and
     * two triangles in place of any trapezoid thin enough that the encoder could
     * fold it over itself.
     *
     * The distinction earns its keep because the two renderers disagree about a
     * folded quad, and only about that. A bowtie fills its crossing region under
     * the nonzero rule a browser canvas uses, and leaves it hollow under the
     * even-odd rule `ofPath` uses on the Pi, so a quad that quantises into one
     * comes out differently in the two places a drawing is meant to look alike.
     * A triangle has no such failure mode -- three points cannot cross -- and it
     * also holds the encoder's running delta cursor to the shortest run the
     * format allows.
     *
     * Splitting everything would cost half again as many bytes; splitting only
     * what cornerHeight() puts at risk costs a couple of percent, and it is that
     * couple of percent that would otherwise account for every disagreement.
     *
     * @param {(point: THREE.Vector3) => {x: number, y: number}} project - a point of this stroke to 2D
     * @param {THREE.Vector3} widthAxis - a direction across the view, in this stroke's own space
     * @param {number} [epsilon=BRUSH_SIMPLIFY] - how far simplification may move a point
     * @param {number} [passes=BRUSH_OVERLAP_PASSES] - staggered overlap runs to lay
     *     over the plain one, each covering the joints of the last
     * @returns {{x: number, y: number}[][]} Closed polygons, none of them foldable, in drawing order
     */
    toBrushPolygons(project, widthAxis, epsilon = BRUSH_SIMPLIFY, passes = BRUSH_OVERLAP_PASSES) {
        const polygons = [];

        for (const piece of this.toBrushShapes(project, widthAxis, epsilon, passes)) {
            // Only a trapezoid can fold. What crosses is its pair of long edges,
            // once rounding has pinched the shape thinner than a couple of
            // quanta, and cornerHeight() measures precisely that room.
            //
            // A fan or a cap is convex around a hub, carries a radius of at
            // least PIECE_SAFE_HEIGHT and keeps its points that far apart along
            // the arc, so rounding can dent one but not turn it inside out.
            // Measuring them with cornerHeight() split nearly every one, because
            // an arc point is *meant* to sit close to the chord through its
            // neighbours -- that is what roundness is, and reading it as
            // fragility cost three polygons in four.
            if (piece.length === 4 && cornerHeight(piece) < PIECE_SAFE_HEIGHT) {
                polygons.push(...splitQuad(piece));
            } else {
                polygons.push(piece);
            }
        }

        return polygons;
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
        this._tempPoints = new Map();     // controllerId -> Vector3[]
        this._rawPoints = new Map();      // controllerId -> Vector3[]

        // Fill meshes for closed strokes (white to match line)
        this._fillMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide
        });
        this._fillMeshes = [];           // Array of fill meshes for completed strokes
        this._tempFillMeshes = new Map(); // controllerId -> temp fill mesh

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
     * @returns {Stroke} The new stroke
     */
    beginStroke(worldPosition, controllerId, color) {
        const stroke = new Stroke(color ?? this.defaultColor);
        this._activeStrokes.set(controllerId, stroke);
        this._tempPoints.set(controllerId, []);
        this._rawPoints.set(controllerId, []);

        // Convert world position to local and buffer it (trimming applied later)
        const localPoint = this.worldToLocal(worldPosition.clone());
        this._rawPoints.get(controllerId).push(localPoint);

        return stroke;
    }

    /**
     * Continues the active stroke with a new point for a specific controller
     * @param {THREE.Vector3} worldPosition - World position to add
     * @param {number|string} controllerId - Controller identifier
     */
    continueStroke(worldPosition, controllerId) {
        const activeStroke = this._activeStrokes.get(controllerId);
        if (!activeStroke) return;

        const rawPoints = this._rawPoints.get(controllerId);
        const tempPoints = this._tempPoints.get(controllerId);

        const localPoint = this.worldToLocal(worldPosition.clone());
        rawPoints.push(localPoint);

        // Add point that is pointsTrimEnd behind current, skipping first pointsTrimStart
        // This trims pointsTrimStart from start and pointsTrimEnd from end (end points stay in buffer)
        const addIndex = rawPoints.length - 1 - pointsTrimEnd;
        if (addIndex >= pointsTrimStart) {
            const pointToAdd = rawPoints[addIndex];
            activeStroke.addPoint(pointToAdd);
            tempPoints.push(pointToAdd);
            this._refreshGeometry();
        }
    }

    /**
     * Ends the current stroke for a specific controller
     * @param {number|string} controllerId - Controller identifier
     */
    endStroke(controllerId) {
        const activeStroke = this._activeStrokes.get(controllerId);

        // Last pointsTrimEnd points remain in _rawPoints buffer and are discarded
        if (activeStroke && activeStroke.points.length > 1) {
            // Refine the stroke (split + smooth) before finalizing
            activeStroke.refine();

            // Offset along normal to prevent z-fighting with other strokes
            activeStroke.offsetAlongNormal(this._strokeCounter * this._zOffsetPerStroke);
            this._strokeCounter++;

            this.strokes.push(activeStroke);
        }

        this._activeStrokes.delete(controllerId);
        this._tempPoints.delete(controllerId);
        this._rawPoints.delete(controllerId);

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
     * Rebuilds the geometry from all strokes plus active temp points from all controllers
     * @private
     */
    _refreshGeometry() {
        // Remove old fill meshes
        for (const mesh of this._fillMeshes) {
            this.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        this._fillMeshes = [];

        // Add all completed strokes as brush geometry
        for (const stroke of this.strokes) {
            // Create brush mesh for completed stroke
            const brushGeo = stroke.toBrushGeometry();
            if (brushGeo) {
                const brushMat = new THREE.MeshBasicMaterial({
                    color: stroke.color,
                    side: THREE.DoubleSide
                });
                const brushMesh = new THREE.Mesh(brushGeo, brushMat);
                brushMesh.frustumCulled = false;
                // The z-offset that keeps strokes from z-fighting lives here
                // rather than in the points -- see Stroke.offsetAlongNormal()
                brushMesh.position.copy(stroke.previewOffset());
                this.add(brushMesh);
                this._fillMeshes.push(brushMesh);
            }
        }

        // Add temp brush geometry from all active strokes
        for (const [controllerId, tempPoints] of this._tempPoints.entries()) {
            // Update temp brush mesh for this controller
            this._updateTempFill(controllerId, tempPoints);
        }

        // Remove temp fills for controllers no longer drawing
        for (const [controllerId, mesh] of this._tempFillMeshes.entries()) {
            if (!this._tempPoints.has(controllerId)) {
                this.remove(mesh);
                mesh.geometry.dispose();
                mesh.material.dispose();
                this._tempFillMeshes.delete(controllerId);
            }
        }
    }

    /**
     * Updates or creates a temp fill mesh for active drawing
     * @private
     */
    _updateTempFill(controllerId, tempPoints) {
        // Remove existing temp fill
        const existing = this._tempFillMeshes.get(controllerId);
        if (existing) {
            this.remove(existing);
            existing.geometry.dispose();
            existing.material.dispose();
            this._tempFillMeshes.delete(controllerId);
        }

        if (tempPoints.length < 2) {
            return;
        }

        // Create a temporary stroke from temp points to generate brush geometry
        const activeStroke = this._activeStrokes.get(controllerId);
        const tempStroke = new Stroke(activeStroke ? activeStroke.color : 0xffffff);
        tempStroke.points = tempPoints.map(p => p.clone());
        tempStroke.computePressures();

        const geometry = tempStroke.toBrushGeometry();
        if (!geometry) return;

        const fillColor = activeStroke ? activeStroke.color : 0xffffff;
        const fillMat = new THREE.MeshBasicMaterial({
            color: fillColor,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, fillMat);
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
        this._tempPoints.clear();
        this._rawPoints.clear();

        // Clear fill meshes
        for (const mesh of this._fillMeshes) {
            this.remove(mesh);
            mesh.geometry.dispose();
        }
        this._fillMeshes = [];

        for (const mesh of this._tempFillMeshes.values()) {
            this.remove(mesh);
            mesh.geometry.dispose();
        }
        this._tempFillMeshes.clear();

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
        // Flicker the entire line mesh
        const startTime = performance.now();
        const flicker = () => {
            const elapsed = performance.now() - startTime;
            if (elapsed < FLICKER_DURATION) {
                this.lineMesh.visible = Math.floor(elapsed / FLICKER_INTERVAL) % 2 === 0;
                requestAnimationFrame(flicker);
            } else {
                this.lineMesh.visible = true;
                this.clear();
                if (onComplete) onComplete();
            }
        };
        flicker();
    }
}
