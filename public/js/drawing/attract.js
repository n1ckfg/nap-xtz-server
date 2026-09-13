import * as THREE from 'three';

const ATTRACT_ID = 'attract';
const POINT_INTERVAL = 50;
const STROKE_PAUSE = 500;
const DRAWING_PAUSE = 2000;

export class AttractMode {
    constructor(frame, worldNode, resetCameraFn) {
        this.frame = frame;
        this.worldNode = worldNode;
        this.resetCamera = resetCameraFn;
        this.timeout = 30000;
        this.lastActivityTime = performance.now();
        this.active = false;
        this.loading = false;

        this._strokes = [];
        this._strokeIdx = 0;
        this._pointIdx = 0;
        this._lastFeedTime = 0;
        this._pauseUntil = 0;
        this._drawingDone = false;

        this._fileList = null;
    }

    resetTimer() {
        this.lastActivityTime = performance.now();
    }

    interrupt() {
        if (!this.active) return;
        if (this.frame.hasActiveStroke(ATTRACT_ID)) {
            this.frame.endStroke(ATTRACT_ID);
        }
        this.frame.clear();
        this.active = false;
        this._strokes = [];
        this._strokeIdx = 0;
        this._pointIdx = 0;
        this.resetTimer();
    }

    update() {
        const now = performance.now();

        if (!this.active && !this.loading) {
            if (now - this.lastActivityTime >= this.timeout) {
                this._load();
            }
            return;
        }

        if (!this.active || this.loading) return;
        if (now < this._pauseUntil) return;

        if (this._strokeIdx >= this._strokes.length) {
            if (!this._drawingDone) {
                this._drawingDone = true;
                this._pauseUntil = now + DRAWING_PAUSE;
                return;
            }
            this.frame.clear();
            this._drawingDone = false;
            this.active = false;
            this._load();
            return;
        }

        const stroke = this._strokes[this._strokeIdx];

        if (this._pointIdx === 0) {
            this.frame.beginStroke(stroke.points[0], ATTRACT_ID, stroke.color);
            this._pointIdx = 1;
            this._lastFeedTime = now;
            return;
        }

        if (this._pointIdx < stroke.points.length) {
            if (now - this._lastFeedTime >= POINT_INTERVAL) {
                this.frame.continueStroke(stroke.points[this._pointIdx], ATTRACT_ID);
                this._pointIdx++;
                this._lastFeedTime = now;
            }
            return;
        }

        this.frame.endStroke(ATTRACT_ID);
        this._strokeIdx++;
        this._pointIdx = 0;
        this._pauseUntil = now + STROKE_PAUSE;
    }

    async _load() {
        this.loading = true;
        const activityAtStart = this.lastActivityTime;
        try {
            if (!this._fileList) {
                const resp = await fetch('/images/nap-list.json');
                if (!resp.ok) { this.resetTimer(); return; }
                this._fileList = await resp.json();
            }
            if (!this._fileList.length) { this.resetTimer(); return; }

            const file = this._fileList[Math.floor(Math.random() * this._fileList.length)];
            const resp = await fetch('/images/' + file);
            if (!resp.ok) { this.resetTimer(); return; }
            const text = await resp.text();

            if (this.lastActivityTime !== activityAtStart) return;

            const decoder = new window.NapDecoder([text]);
            this._strokes = this._extract(decoder.cmds);

            if (!this._strokes.length) { this.resetTimer(); return; }

            this.frame.clear();
            this.worldNode.position.set(0, 0, 0);
            this.worldNode.quaternion.identity();
            this.worldNode.scale.set(1, 1, 1);
            if (this.resetCamera) this.resetCamera();

            this._strokeIdx = 0;
            this._pointIdx = 0;
            this._drawingDone = false;
            this.active = true;
        } catch (err) {
            console.warn('[attract] failed to load:', err);
            this.resetTimer();
        } finally {
            this.loading = false;
        }
    }

    _extract(cmds) {
        const vFov = 75 * Math.PI / 180;
        const halfH = Math.tan(vFov / 2) * 5;
        const halfW = halfH * (640 / 480);

        const strokes = [];
        let color = 0xffffff;

        for (const cmd of cmds) {
            const id = cmd.opcode.id;

            if (id === 'SET COLOR' || id === 'SELECT COLOR') {
                const c = cmd.col;
                color = ((c.x & 0xff) << 16) | ((c.y & 0xff) << 8) | (c.z & 0xff);
                continue;
            }

            if (!id.includes('POLY') || !cmd.points || cmd.points.length < 4) continue;

            const pts = cmd.points;
            const half = Math.floor(pts.length / 2);
            const centerline = [];

            for (let i = 0; i < half; i++) {
                const a = pts[i];
                const b = pts[pts.length - 1 - i];
                const cx = (a.x + b.x) / 2;
                const cy = (a.y + b.y) / 2;

                const wx = (cx - 0.5) * 2 * halfW;
                const wy = (cy - 0.5) * 2 * halfH;
                centerline.push(new THREE.Vector3(wx, wy, 0));
            }

            const padded = centerline.length < 12
                ? this._subdivide(centerline, 12)
                : centerline;
            strokes.push({ color, points: padded });
        }

        return strokes;
    }

    _subdivide(points, minCount) {
        if (points.length >= minCount || points.length < 2) return points;
        let pts = points;
        while (pts.length < minCount) {
            const next = [pts[0]];
            for (let i = 1; i < pts.length; i++) {
                next.push(new THREE.Vector3().lerpVectors(pts[i - 1], pts[i], 0.5));
                next.push(pts[i]);
            }
            pts = next;
        }
        return pts;
    }
}
