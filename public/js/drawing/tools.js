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
        const startTime = performance.now();
        const flicker = () => {
            const elapsed = performance.now() - startTime;
            if (elapsed < FLICKER_DURATION) {
                const vis = Math.floor(elapsed / FLICKER_INTERVAL) % 2 === 0;
                this.lineMesh.visible = vis;
                for (const mesh of this._fillMeshes) mesh.visible = vis;
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
