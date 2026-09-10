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

// The next three are in frame widths -- the 0..1 space toBrushQuads works in,
// where 1 is the whole drawing, so 0.005 is about three pixels of a 640-wide one.
export const BRUSH_SIMPLIFY = 0.002; //0.005; // how far simplification may move a point
const MIN_STEP = 0.0005;      // 1/2048: a shorter step is a rounding error to the encoder
const MIN_RADIUS = 0.0005;    // keeps a quad from collapsing into a line

// How far inside the frame a clamped point is held. Each delta the encoder
// writes can fall a quantum short of where it was asked for, and a quad is four
// of them, so a point pinned to the very edge can decode just outside it -- and
// both renderers drop a point that lands outside rather than pulling it back.
const FRAME_MARGIN = 4 * MIN_STEP;

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
 * How far each quad has to reach past a corner to cover the wedge the next one
 * leaves there: radius * tan(half the turn), which is nothing on a straight run
 * and a whole radius at a right angle. Capped there, so a hairpin gets a blunt
 * corner instead of a spike.
 * @param {{x: number, y: number}[]} points - The simplified centreline
 * @param {number[]} radii
 * @returns {number[]} Reach at each point, ends included (and zero)
 */
function cornerReach(points, radii) {
    const reach = points.map(() => 0);

    for (let i = 1; i < points.length - 1; i++) {
        const inX = points[i].x - points[i - 1].x;
        const inY = points[i].y - points[i - 1].y;
        const outX = points[i + 1].x - points[i].x;
        const outY = points[i + 1].y - points[i].y;
        const inLen = Math.hypot(inX, inY);
        const outLen = Math.hypot(outX, outY);
        if (inLen < MIN_STEP || outLen < MIN_STEP) continue;

        const dot = (inX * outX + inY * outY) / (inLen * outLen);
        const cross = Math.abs(inX * outY - inY * outX) / (inLen * outLen);
        const halfTurn = cross / Math.max(1e-6, 1 + dot); // tan(turn / 2)

        reach[i] = Math.min(1, halfTurn) * Math.max(radii[i], MIN_RADIUS);
    }

    return reach;
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
     * Offsets all points along the stroke's normal by a given amount
     * @param {number} amount - Distance to offset
     */
    offsetAlongNormal(amount) {
        if (this.points.length < 3 || amount === 0) return;

        const normal = this.computeNormal();
        for (const point of this.points) {
            point.addScaledVector(normal, amount);
        }
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
     * The stroke as a run of short filled polygons -- one quad per segment of the
     * simplified centreline -- in the 0..1 space NAPLPS draws in.
     *
     * This is the shape the format wants. A quad built on one segment's own
     * perpendicular is convex, so every renderer fills it alike whichever winding
     * rule it uses, where a single long outline of the whole stroke crosses itself
     * at every tight turn and fills differently on each. Four points is also short
     * enough that the encoder's running delta cursor is reset before its rounding
     * error can accumulate into visible drift. Consecutive quads reach a little
     * way into each other -- see cornerReach() -- so no gap shows at a turn.
     *
     * @param {(point: THREE.Vector3) => {x: number, y: number}} project - a point of this stroke to 2D
     * @param {THREE.Vector3} widthAxis - a direction across the view, in this stroke's own space
     * @param {number} [epsilon=BRUSH_SIMPLIFY] - how far simplification may move a point
     * @returns {{x: number, y: number}[][]} Closed 4-point polygons, in drawing order
     */
    toBrushQuads(project, widthAxis, epsilon = BRUSH_SIMPLIFY) {
        if (this.points.length < 2) return [];

        const { points, radii } = simplifyPath(this.toScreenPath(project, widthAxis), epsilon);
        const lastSegment = points.length - 2;
        const reach = cornerReach(points, radii);
        const quads = [];

        for (let i = 0; i <= lastSegment; i++) {
            const a = points[i];
            const b = points[i + 1];
            const length = Math.hypot(b.x - a.x, b.y - a.y);
            if (length < MIN_STEP) continue;

            const tx = (b.x - a.x) / length;
            const ty = (b.y - a.y) / length;
            const ra = Math.max(radii[i], MIN_RADIUS);
            const rb = Math.max(radii[i + 1], MIN_RADIUS);

            // Reach into the neighbouring segments, but not past the stroke's own ends
            const back = i > 0 ? reach[i] : 0;
            const forward = i < lastSegment ? reach[i + 1] : 0;
            const ax = a.x - tx * back;
            const ay = a.y - ty * back;
            const bx = b.x + tx * forward;
            const by = b.y + ty * forward;

            const quad = [
                { x: ax - ty * ra, y: ay + tx * ra },
                { x: bx - ty * rb, y: by + tx * rb },
                { x: bx + ty * rb, y: by - tx * rb },
                { x: ax + ty * ra, y: ay - tx * ra }
            ];

            // The encoder silently drops a point outside the frame, and every
            // point after it in that polygon is a delta from the one dropped, so
            // the rest of the shape lands somewhere else entirely. Keep the quads
            // that touch the frame and clamp them into it; skip the rest.
            if (touchesFrame(quad)) quads.push(quad.map(clampToFrame));
        }

        // A stroke can land on a single spot -- drawn straight at the camera, or
        // held still. There was paint on it, so leave a dab rather than nothing.
        if (quads.length === 0 && points.length > 0) {
            const r = Math.max(...radii, MIN_RADIUS);
            const c = points[0];
            const dab = [
                { x: c.x - r, y: c.y - r },
                { x: c.x + r, y: c.y - r },
                { x: c.x + r, y: c.y + r },
                { x: c.x - r, y: c.y + r }
            ];
            if (touchesFrame(dab)) quads.push(dab.map(clampToFrame));
        }

        return quads;
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
