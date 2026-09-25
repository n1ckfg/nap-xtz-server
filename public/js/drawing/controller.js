import * as THREE from 'three';

// A hand, as the rest of drawing mode sees it: a position and a set of buttons
// (trigger, grip, A, B, C) worked by hand signs.
//
// Everything here is driven by measurements -- one per recognizer result --
// rather than by the render loop, and every filter and timer runs on the
// measurement's own timestamp. That is what makes it behave the same on a
// machine that recognizes five frames a second as on one that manages thirty.
// It used to update once per animation frame, feeding each result in again
// until the next one came: at the Pi's rates that meant one sample filtered
// half a dozen times, a stroke made of the filter's approach to each point
// rather than of the points, and a jerk score that read every new sample as a
// jolt and locked the buttons.

// One Euro filter settings, in the units they filter: x and y are in frame
// widths (0..1 across the camera image), so `beta` is per frame-width-per-second
// of speed. A hand at rest gets `minCutoff` (heavy smoothing, no jitter); a
// hand moving quickly gets a higher cutoff (little smoothing, little lag).
// The drawing position is the responsive one; the navigation position (the
// two-handed move) is steadier; depth is mostly noise from the recognizer, so
// it is smoothed hardest and never lets speed open it up.
const DRAW_FILTER = { minCutoff: 0.8, beta: 15, dCutoff: 1.0 };
const NAV_FILTER = { minCutoff: 0.6, beta: 3, dCutoff: 1.0 };
const DEPTH_FILTER = { minCutoff: 0.4, beta: 0, dCutoff: 1.0 };

// Gesture debouncing. A sign has to be seen on two consecutive results, and
// for at least DWELL_MS, before it counts -- three results when the hand is
// moving faster than FAST_SPEED, where motion blur makes misreadings likelier.
// "None" is the recognizer saying it isn't sure, so it needs longer to take
// over from a sign that was: a hold or a stroke shouldn't end on a moment's
// doubt.
const DWELL_MS = 60;
const NONE_DWELL_MS = 250;
const FAST_SPEED = 1.5; // frame widths per second

// A fist keeps the grip through this long of "None" -- a two-handed move
// blurs the hands, and letting go mid-move springs the world back.
const GRIP_TIMEOUT = 1000;

// A stroke ends where the sign that ended it was first seen, less this: the
// finger has usually started to curl a little before the recognizer says so.
const CUT_MARGIN_MS = 40;

// How much of the filtered path is kept, so a stroke can start from where the
// sign was first seen rather than where it was finally believed.
const HISTORY_MS = 2000;

/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012) over a vector: speed is
 * the magnitude of the whole vector's derivative, so x and y share a cutoff
 * and a diagonal stroke is smoothed like a horizontal one.
 */
export class OneEuroFilter {
    /**
     * @param {number} minCutoff - Hz at rest (lower = smoother)
     * @param {number} beta - how fast the cutoff rises with speed
     * @param {number} dCutoff - Hz for the speed estimate itself
     */
    constructor(minCutoff = 1.0, beta = 0, dCutoff = 1.0) {
        this.minCutoff = minCutoff;
        this.beta = beta;
        this.dCutoff = dCutoff;
        this.reset();
    }

    reset() {
        this._x = null;
        this._dx = 0;
        this._t = 0;
        this.speed = 0;
    }

    /**
     * @param {number[]} value - The measurement
     * @param {number} t - Its time, in ms
     * @returns {number[]} The filtered value (a new array)
     */
    filter(value, t) {
        if (this._x === null) {
            this._x = value.slice();
            this._t = t;
            this._dx = 0;
            this.speed = 0;
            return this._x.slice();
        }
        const dt = Math.max(1e-3, (t - this._t) / 1000);
        this._t = t;

        let d2 = 0;
        for (let i = 0; i < value.length; i++) {
            const d = (value[i] - this._x[i]) / dt;
            d2 += d * d;
        }
        const aD = smoothing(dt, this.dCutoff);
        this._dx += aD * (Math.sqrt(d2) - this._dx);
        this.speed = this._dx;

        const a = smoothing(dt, this.minCutoff + this.beta * this._dx);
        for (let i = 0; i < value.length; i++) {
            this._x[i] += a * (value[i] - this._x[i]);
        }
        return this._x.slice();
    }
}

function ease(from, to, k) {
    from.x += (to.x - from.x) * k;
    from.y += (to.y - from.y) * k;
    from.z += (to.z - from.z) * k;
}

function smoothing(dt, cutoff) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
}

/**
 * Turns the recognizer's per-frame gesture labels into the sign the hand is
 * actually making (see DWELL_MS above). `since` is when the evidence for the
 * current sign began, which is where strokes are started and cut.
 */
export class GestureFilter {
    constructor() {
        this.reset();
    }

    reset() {
        this.stable = null;
        this.since = 0;
        this._candidate = null;
        this._candidateSince = 0;
        this._count = 0;
    }

    /** The sign seen but not yet believed, if any, and since when. */
    get candidate() {
        return this._candidate;
    }

    get candidateSince() {
        return this._candidateSince;
    }

    /**
     * @param {string} label - This result's gesture
     * @param {number} t - Its time, in ms
     * @param {boolean} [fast] - The hand is moving quickly
     * @returns {boolean} True if the stable sign changed
     */
    update(label, t, fast = false) {
        if (label === this.stable) {
            this._candidate = null;
            this._count = 0;
            return false;
        }
        if (label !== this._candidate) {
            this._candidate = label;
            this._candidateSince = t;
            this._count = 0;
        }
        this._count++;

        const dwell = label === 'None' ? NONE_DWELL_MS : DWELL_MS;
        if (this._count >= (fast ? 3 : 2) && t - this._candidateSince >= dwell) {
            this.stable = label;
            this.since = this._candidateSince;
            this._candidate = null;
            this._count = 0;
            return true;
        }
        return false;
    }
}

// The flat mapping drawing.js replaces with a camera ray: frame x mirrored (the
// webcam faces the user) onto a 10-unit-wide view, depth toward the viewer.
function flatPlacement(x, y, z, target) {
    return target.set((0.5 - x) * 10, (0.5 - y) * 7.5, -z * 5);
}

export class Controller extends THREE.Object3D {
    constructor() {
        super();

        // Buttons. *_Held is the state; *_Down and *_Up are edges, true for the
        // frame in which the state changed (cleared by beginFrame()).
        this.grip_Down = false;
        this.grip_Held = false;
        this.trigger_Down = false;
        this.trigger_Held = false;
        this.trigger_Up = false;
        this.buttonA_Down = false;
        this.buttonA_Held = false;
        this.buttonB_Down = false;
        this.buttonB_Held = false;
        this.buttonC_Down = false;
        this.buttonC_Held = false;
        this.buttonC_Up = false;

        // Where strokes start and stop, in measurement time: set with the
        // matching Down / Up edge (see _updateButtons).
        this.triggerFrom = 0;
        this.triggerCut = 0;
        this.buttonCFrom = 0;
        this.buttonCCut = 0;

        this.present = false;      // a hand is assigned to this controller
        this.lastSeen = -Infinity; // time of its latest measurement
        this.fresh = false;        // a measurement with the hand in it arrived this frame
        this.sampleTime = 0;       // that measurement's time
        this.gesture = new GestureFilter();
        this.rawGesture = 'None';  // what the recognizer said last, for the label
        this.handedness = '';
        this.tipWorld = null;      // fingertip in metres, for the label

        this._drawFilter = new OneEuroFilter(DRAW_FILTER.minCutoff, DRAW_FILTER.beta, DRAW_FILTER.dCutoff);
        this._navFilter = new OneEuroFilter(NAV_FILTER.minCutoff, NAV_FILTER.beta, NAV_FILTER.dCutoff);
        this._depthFilter = new OneEuroFilter(DEPTH_FILTER.minCutoff, DEPTH_FILTER.beta, DEPTH_FILTER.dCutoff);
        this._draw = { x: 0.5, y: 0.5, z: 0 };  // filtered, frame units
        this._nav = { x: 0.5, y: 0.5, z: 0 };
        this._drawShown = { x: 0.5, y: 0.5, z: 0 }; // eased toward those every frame (tick)
        this._navShown = { x: 0.5, y: 0.5, z: 0 };
        this._snap = true;                      // next tick jumps rather than eases
        this._samples = [];                     // [{t, x, y, z}] filtered draw path
        this._lastFist = -Infinity;
        this._pendingSign = null;               // what a vanished hand was changing to
        this._pendingSince = 0;

        // Frame coordinates to world space. drawing.js puts each point on the
        // camera ray through the fingertip; this is the fallback.
        this.placement = flatPlacement;
    }

    /** Clears the edges; call once at the start of every frame. */
    beginFrame() {
        this.grip_Down = false;
        this.trigger_Down = false;
        this.trigger_Up = false;
        this.buttonA_Down = false;
        this.buttonB_Down = false;
        this.buttonC_Down = false;
        this.buttonC_Up = false;
        this.fresh = false;
    }

    /**
     * Takes one recognizer result for this hand.
     * @param {number} t - The result's time (when its camera frame was taken), ms
     * @param {?{x: number, y: number, z: number, gesture: string, handedness?: string, tipWorld?: number[]} | 'lost'} hand
     *   The index fingertip in frame units, and the sign; null when this result
     *   has no hand for this controller; 'lost' when the hand has gone (see
     *   HandInput), which ends whatever it was doing
     * @returns {{triggerDown: boolean, triggerUp: boolean, cDown: boolean, cUp: boolean}}
     *   This measurement's own edges (the frame's are accumulated on the controller)
     */
    measure(t, hand) {
        if (hand === 'lost') {
            if (this.present) this._lose();
        } else if (hand) {
            if (!this.present) {
                this._snap = true;
                this._pendingSign = null;
            }
            this.present = true;
            this.lastSeen = t;
            this.fresh = true;
            this.sampleTime = t;

            const d = this._drawFilter.filter([hand.x, hand.y], t);
            const n = this._navFilter.filter([hand.x, hand.y], t);
            const z = this._depthFilter.filter([hand.z], t)[0];
            this._draw.x = d[0]; this._draw.y = d[1]; this._draw.z = z;
            this._nav.x = n[0]; this._nav.y = n[1]; this._nav.z = z;

            this._samples.push({ t, x: d[0], y: d[1], z });
            while (this._samples.length && this._samples[0].t < t - HISTORY_MS) this._samples.shift();

            this.gesture.update(hand.gesture, t, this._drawFilter.speed > FAST_SPEED);
            this.rawGesture = hand.gesture;
            this.handedness = hand.handedness || '';
            this.tipWorld = hand.tipWorld || null;
        }
        return this._updateButtons(t);
    }

    /** Forgets the hand now, as though it had left the frame. */
    release() {
        if (this.present) this._lose();
        return this._updateButtons(this.lastSeen);
    }

    _lose() {
        this.present = false;
        // What the hand was changing to, if anything, when it went.
        this._pendingSign = this.gesture.candidate;
        this._pendingSince = this.gesture.candidateSince;
        this.gesture.reset();
        this._drawFilter.reset();
        this._navFilter.reset();
        this._depthFilter.reset();
        this._samples.length = 0;
    }

    // Where a stroke drawn with `tool` (the sign that draws it) ends. A stroke
    // ended by a new sign stops where that sign began; one ended by the hand
    // leaving keeps everything that was seen -- unless the hand had started
    // on some other sign before it went (a fist, say, seen once and never
    // confirmed), in which case it stops there.
    _cutFor(tool, g) {
        if (g !== null) return this.gesture.since - CUT_MARGIN_MS;
        const pending = this._pendingSign;
        if (pending && pending !== 'None' && pending !== tool) return this._pendingSince - CUT_MARGIN_MS;
        return this.lastSeen;
    }

    _updateButtons(t) {
        const g = this.present ? this.gesture.stable : null;
        const since = this.gesture.since;

        // Trigger: the line tool. Sticky through "None" -- a pointing finger
        // is often read as nothing in particular mid-stroke -- and ended by
        // any sign the hand deliberately makes instead, or by the hand going.
        let trigger = this.trigger_Held;
        if (g === 'Pointing_Up') {
            if (!trigger) this.triggerFrom = since;
            trigger = true;
        } else if (g !== 'None' && trigger) {
            trigger = false;
            this.triggerCut = this._cutFor('Pointing_Up', g);
        }

        // Grip: a fist, kept through a short spell of "None" (GRIP_TIMEOUT).
        let grip;
        if (g === 'Closed_Fist') {
            grip = true;
            this._lastFist = t;
        } else {
            grip = g === 'None' && this.grip_Held && t - this._lastFist <= GRIP_TIMEOUT;
        }

        const a = g === 'Thumb_Up';
        const b = g === 'Thumb_Down';
        const c = g === 'Victory';
        if (c && !this.buttonC_Held) this.buttonCFrom = since;
        if (!c && this.buttonC_Held) this.buttonCCut = this._cutFor('Victory', g);

        const edges = {
            triggerDown: trigger && !this.trigger_Held,
            triggerUp: !trigger && this.trigger_Held,
            cDown: c && !this.buttonC_Held,
            cUp: !c && this.buttonC_Held
        };

        this.grip_Down = this.grip_Down || (grip && !this.grip_Held);
        this.trigger_Down = this.trigger_Down || edges.triggerDown;
        this.trigger_Up = this.trigger_Up || edges.triggerUp;
        this.buttonA_Down = this.buttonA_Down || (a && !this.buttonA_Held);
        this.buttonB_Down = this.buttonB_Down || (b && !this.buttonB_Held);
        this.buttonC_Down = this.buttonC_Down || edges.cDown;
        this.buttonC_Up = this.buttonC_Up || edges.cUp;

        this.grip_Held = grip;
        this.trigger_Held = trigger;
        this.buttonA_Held = a;
        this.buttonB_Held = b;
        this.buttonC_Held = c;
        return edges;
    }

    /** The stable sign, or null if there isn't one (yet). */
    get sign() {
        return this.present ? this.gesture.stable : null;
    }

    /**
     * Moves the visible pointer, and the position the two-handed move reads,
     * toward the latest filtered positions. Results arrive a few times a
     * second on slow machines; this glides between them rather than jumping,
     * over a fraction of the interval between results -- short enough on a
     * fast machine to add no lag worth the name. Strokes don't go through it:
     * they are made of the samples themselves.
     * @param {number} dtMs - Time since the last frame
     * @param {number} intervalMs - Typical time between results
     */
    tick(dtMs, intervalMs) {
        const tau = Math.max(8, Math.min(50, intervalMs * 0.35));
        const k = this._snap ? 1 : 1 - Math.exp(-dtMs / tau);
        this._snap = false;
        ease(this._drawShown, this._draw, k);
        ease(this._navShown, this._nav, k);
        this.placement(this._drawShown.x, this._drawShown.y, this._drawShown.z, this.position);
    }

    /** Filtered depth, in the recognizer's units (negative = toward the camera). */
    get depth() {
        return this._draw.z;
    }

    /**
     * Gets the drawing position (the responsive filter)
     * @param {THREE.Vector3} target - Vector to store the result
     * @returns {THREE.Vector3} The drawing position in world space
     */
    getDrawPosition(target) {
        if (!target) target = new THREE.Vector3();
        return this.placement(this._draw.x, this._draw.y, this._draw.z, target);
    }

    /**
     * Gets the navigation position (the steadier filter, eased by tick())
     * @param {THREE.Vector3} target - Vector to store the result
     * @returns {THREE.Vector3} The navigation position in world space
     */
    getNavPosition(target) {
        if (!target) target = new THREE.Vector3();
        return this.placement(this._navShown.x, this._navShown.y, this._navShown.z, target);
    }

    /**
     * The filtered drawing path from time t0 on, oldest first.
     * @param {number} t0 - ms
     * @returns {{t: number, x: number, y: number, z: number}[]}
     */
    samplesSince(t0) {
        return this._samples.filter(s => s.t >= t0);
    }

    /**
     * A sample from samplesSince() in world space.
     * @param {{x: number, y: number, z: number}} sample
     * @param {THREE.Vector3} target
     */
    samplePosition(sample, target) {
        return this.placement(sample.x, sample.y, sample.z, target);
    }
}
