// Hand tracking: getting recognizer results off the webcam without holding up
// the render loop (HandTracker), and turning each result into one steady hand
// per controller (HandInput).

// Local, not jsdelivr: the kiosk has to come up without a network. The files
// are the 0.10.3 runtime and the float16/1 model, vendored alongside the
// tasks-vision bundle index.html loads.
const WASM_PATH = '/js/libraries/mediapipe/wasm';
const MODEL_PATH = '/js/libraries/mediapipe/models/gesture_recognizer.task';

// A recognizer takes a few seconds to load on a Pi; one that hasn't answered
// in this long isn't going to, and the main thread gets a turn instead.
const WORKER_INIT_TIMEOUT = 60000;

// Which recognizer gets the next frame (see HandTracker._pick). Two hands cost
// twice what one does: with numHands at 2 and one hand in view, MediaPipe runs
// palm detection on every frame looking for the second, and that search is
// half the time -- ~380 ms a frame on a Pi against ~180 ms for a single tracked
// hand. So a second recognizer, looking for one hand only, takes the frames
// while a single hand is in view, and the two-hand one looks in once a second
// for another. Not while that hand is drawing, though: a look costs the stroke
// most of a second of samples (the look is slow, and the single-hand
// recognizer, its hand having moved on meanwhile, often misses the next), and
// a second hand is found as soon as the first stops. Nor when the single-hand
// one misses a drawing hand: it finds it again on its next frame by itself,
// sooner than the two-hand one would. The two-hand one takes every frame when
// no hand is in view (palm detection runs either way then, so it costs the same
// and catches two hands arriving together), when two were seen last time, and
// when the hand in view is making a sign that has a two-handed meaning -- a
// fist or a thumb: move, mint, delete all.
const TWO_HAND_PROBE_MS = 1000;
const TWO_HAND_SIGNS = new Set(['Closed_Fist', 'Thumb_Up', 'Thumb_Down']);
const DRAWING_SIGNS = new Set(['Pointing_Up', 'Victory']);

/**
 * Runs the gesture recognizer on the webcam and queues its results.
 *
 * The recognizers live in workers (hands-worker.js), one each, fed one frame at
 * a time between them: a frame goes over as soon as the last result is back,
 * so they run flat out without a queue of stale frames building up, and the
 * page renders at its own pace in the meantime. They get a worker each because
 * loading one blocks its thread for several seconds -- sharing one, the second
 * to load held up tracking for as long. Where a module worker can't be had,
 * the recognizer runs on the main thread as it always did: slower, but drawing
 * mode still works.
 *
 * Results carry the time their camera frame was taken, which is what every
 * filter and timer downstream runs on.
 */
export class HandTracker {
    /**
     * @param {{delegate?: string, numHands?: number}} [options]
     */
    constructor(options = {}) {
        this.delegate = options.delegate || 'CPU';
        this.numHands = options.numHands || 2;
        this.mode = null;          // 'worker' | 'main', once ready
        this.ready = false;
        this.interval = 200;       // ms between results, smoothed
        this.recognizeMs = 0;      // the last result's recognition time
        this.results = 0;          // results delivered, for diagnostics

        this._init = null;
        this._two = null;          // worker looking for up to numHands hands
        this._one = null;          // worker looking for one (see _pick)
        this._recognizer = null;   // main-thread fallback
        this._video = null;
        this._queue = [];
        this._inFlight = false;
        this._frameSeq = 0;
        this._sentSeq = -1;
        this._lastVideoTime = -1;
        this._lastSentT = 0;
        this._lastResultT = 0;
        this._lastTwoAt = -Infinity;
        this._lastHands = [];
        this._errors = 0;
        this.drawing = false;      // a hand is mid-stroke (set by drawing.js)
    }

    /** Whether the single-hand recognizer is up. */
    get dual() {
        return this._one !== null;
    }

    /**
     * Starts the recognizer, once; later calls return the same promise.
     * @returns {Promise<void>}
     */
    init() {
        if (!this._init) {
            this._init = this._spawn(this.numHands).then(worker => {
                this._two = worker;
                this.mode = 'worker';
                this.ready = true;
                console.log('MediaPipe Loaded (worker, ' + this.delegate + ')');
                this._send();
                // An optimisation, so it follows rather than holds anything up,
                // and failing to load is no more than a slower frame rate.
                if (this.numHands > 1) {
                    this._spawn(1).then(one => {
                        if (this._two) this._one = one;
                        else one.terminate();
                    }, err => console.warn('[hands] single-hand recognizer unavailable:', err.message));
                }
            }).catch(err => {
                console.warn('[hands] no worker (' + err.message + '); recognizing on the main thread');
                return this._startMain();
            });
        }
        return this._init;
    }

    /** Starts reading frames from a playing <video>. */
    attach(video) {
        this._video = video;
        this._queue.length = 0;
        this._lastVideoTime = -1;
        this._sentSeq = this._frameSeq;
        if (typeof video.requestVideoFrameCallback === 'function') {
            const onFrame = () => {
                if (this._video !== video) return;
                this._frameSeq++;
                this._send();
                video.requestVideoFrameCallback(onFrame);
            };
            video.requestVideoFrameCallback(onFrame);
            this._rvfc = true;
        } else {
            this._rvfc = false;
        }
    }

    /** Stops reading frames; anything still in flight is dropped. */
    detach() {
        this._video = null;
        this._queue.length = 0;
    }

    /**
     * Call once a frame. Notices new camera frames where the browser can't
     * say so itself, and runs the main-thread fallback.
     */
    pump() {
        const video = this._video;
        if (!video || !this.ready || video.readyState < 2) return;

        if (!this._rvfc && video.currentTime !== this._lastVideoTime) {
            this._lastVideoTime = video.currentTime;
            this._frameSeq++;
        }

        if (this.mode === 'worker') {
            this._send();
        } else if (this.mode === 'main' && this._frameSeq !== this._sentSeq) {
            this._sentSeq = this._frameSeq;
            const t = this._nextTime();
            const t0 = performance.now();
            let result;
            try {
                result = this._recognizer.recognizeForVideo(video, t);
            } catch (err) {
                this._frameError(err);
                return;
            }
            this._deliver(t, performance.now() - t0, this.numHands, packResult(result));
        }
    }

    /**
     * The results that have arrived since the last call, oldest first.
     * @returns {{t: number, hands: object[], numHands: number}[]}
     */
    take() {
        if (!this._queue.length) return EMPTY;
        const out = this._queue;
        this._queue = [];
        return out;
    }

    _nextTime() {
        // MediaPipe refuses a timestamp that doesn't move forward.
        const t = Math.max(performance.now(), this._lastSentT + 1);
        this._lastSentT = t;
        return t;
    }

    _pick(t) {
        if (!this._one || this._lastHands.length > 1) return this._two;
        // Mid-stroke -- by the page's account, or by the sign just seen, which
        // the page won't have acted on yet.
        const sign = this._lastHands.length ? this._lastHands[0].gesture : null;
        if (this.drawing || DRAWING_SIGNS.has(sign)) return this._one;
        if (!sign || TWO_HAND_SIGNS.has(sign)) return this._two;
        return t - this._lastTwoAt >= TWO_HAND_PROBE_MS ? this._two : this._one;
    }

    _send() {
        const video = this._video;
        if (this.mode !== 'worker' || this._inFlight || !video || video.readyState < 2) return;
        if (this._frameSeq === this._sentSeq) return; // nothing new since the last one
        this._inFlight = true;
        this._sentSeq = this._frameSeq;
        const t = this._nextTime();
        const target = this._pick(t);
        createImageBitmap(video).then(bitmap => {
            if (!target.alive || this._video !== video) {
                bitmap.close();
                this._inFlight = false;
                return;
            }
            target.worker.postMessage({ type: 'frame', bitmap, t }, [bitmap]);
        }, err => {
            this._inFlight = false;
            this._frameError(err);
        });
    }

    _onResult(target, msg) {
        this._inFlight = false;
        if (target === this._two) this._lastTwoAt = msg.t;
        this._lastHands = msg.hands;
        this._deliver(msg.t, msg.ms, target.numHands, msg.hands);
        this._send();
    }

    _deliver(t, ms, numHands, hands) {
        this._errors = 0;
        this.results++;
        this.recognizeMs = ms;
        if (this._lastResultT) {
            const gap = t - this._lastResultT;
            if (gap > 0 && gap < 2000) this.interval += (gap - this.interval) * 0.2;
        }
        this._lastResultT = t;
        if (!this._video) return;
        this._queue.push({ t, numHands, hands });
        if (this._queue.length > 8) this._queue.shift(); // nobody is taking them
    }

    _frameError(err) {
        // One bad frame is nothing; a steady stream of them is worth a line in
        // the log, but not one a frame.
        if (this._errors++ % 100 === 0) console.warn('[hands] recognition failed:', err && err.message || err);
    }

    // A worker with a recognizer for up to numHands hands, loaded and warmed
    // up: a recognizer's first frame takes several times as long as the rest,
    // and that should happen here, on a blank frame, rather than to whoever
    // is standing in front of the camera.
    _spawn(numHands) {
        return new Promise((resolve, reject) => {
            let worker;
            try {
                worker = new Worker(new URL('./hands-worker.js', import.meta.url), { type: 'module' });
            } catch (err) {
                reject(err);
                return;
            }
            const target = { worker, numHands, alive: true };
            let settled = false;
            const fail = (message) => {
                clearTimeout(timer);
                target.alive = false;
                worker.terminate();
                if (!settled) {
                    settled = true;
                    reject(new Error(message));
                }
            };
            const timer = setTimeout(() => fail('timed out'), WORKER_INIT_TIMEOUT);

            worker.onmessage = (event) => {
                const msg = event.data;
                if (msg.type === 'loaded') {
                    worker.postMessage({ type: 'init', wasm: WASM_PATH, model: MODEL_PATH, delegate: this.delegate, numHands });
                } else if (msg.type === 'ready') {
                    createImageBitmap(new ImageData(320, 240)).then(bitmap => {
                        worker.postMessage({ type: 'frame', bitmap, t: 1 }, [bitmap]);
                    }, err => fail(err.message));
                } else if (msg.type === 'result' || (msg.type === 'error' && !msg.fatal)) {
                    if (!settled) {
                        // The warm-up frame.
                        settled = true;
                        clearTimeout(timer);
                        resolve(target);
                    } else if (msg.type === 'result') {
                        this._onResult(target, msg);
                    } else {
                        this._inFlight = false;
                        this._frameError(new Error(msg.message));
                        this._send();
                    }
                } else if (msg.type === 'error') {
                    fail(msg.message);
                }
            };
            worker.onerror = (event) => {
                event.preventDefault();
                const message = event.message || 'worker failed';
                if (!settled) {
                    fail(message);
                    return;
                }
                target.alive = false;
                worker.terminate();
                this._inFlight = false;
                if (target === this._one) {
                    // The single-hand recognizer is an optimisation.
                    console.warn('[hands] single-hand worker died (' + message + ')');
                    this._one = null;
                    this._send();
                    return;
                }
                // It was working and has died (out of memory, most likely).
                // Carry on without it rather than without hands.
                console.warn('[hands] worker died (' + message + '); recognizing on the main thread');
                this._two = null;
                if (this._one) {
                    this._one.alive = false;
                    this._one.worker.terminate();
                    this._one = null;
                }
                this.ready = false;
                this.mode = null;
                this._startMain().catch(err => console.error('[hands] no recognizer at all:', err));
            };
        });
    }

    async _startMain() {
        // index.html's module script puts these on window.
        while (!window.GestureRecognizer || !window.FilesetResolver) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const vision = await window.FilesetResolver.forVisionTasks(WASM_PATH);
        this._recognizer = await window.GestureRecognizer.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_PATH, delegate: this.delegate },
            runningMode: 'VIDEO',
            numHands: this.numHands
        });
        this.mode = 'main';
        this.ready = true;
        console.log('MediaPipe Loaded (main thread, ' + this.delegate + ')');
    }
}

const EMPTY = [];

/**
 * A GestureRecognizerResult as plain data: what crosses from the worker, and
 * what the main-thread fallback hands on too. Only what the page reads -- all
 * 21 image-space landmarks (identity and duplicate checks use the palm), the
 * fingertip in metres for the debug label, and the top gesture and handedness
 * with their scores.
 */
export function packResult(result) {
    const hands = [];
    for (let i = 0; i < result.landmarks.length; i++) {
        const lm = result.landmarks[i];
        const flat = new Array(lm.length * 3);
        for (let j = 0; j < lm.length; j++) {
            flat[j * 3] = lm[j].x;
            flat[j * 3 + 1] = lm[j].y;
            flat[j * 3 + 2] = lm[j].z;
        }
        const w = result.worldLandmarks[i] && result.worldLandmarks[i][8];
        const g = result.gestures[i] && result.gestures[i][0];
        const h = result.handednesses[i] && result.handednesses[i][0];
        hands.push({
            landmarks: flat,
            tipWorld: w ? [w.x, w.y, w.z] : null,
            gesture: g ? g.categoryName : 'None',
            gestureScore: g ? g.score : 0,
            handedness: h ? h.categoryName : '',
            handednessScore: h ? h.score : 0
        });
    }
    return hands;
}

// ── Which hand is which ──

// Landmarks: 0 wrist, 5/9/17 the knuckles, 8 the index fingertip.
const PALM = [0, 5, 9, 17];
const TIP = 8;

// An unclaimed controller costs this much to take a hand, in frame widths --
// so a hand stays with the controller that had it unless it has jumped further
// than this, and a new hand goes to a free controller.
const NEW_TRACK_COST = 0.35;
// And a handedness that disagrees with the controller's costs this much more.
const HANDEDNESS_COST = 0.15;
// A controller's hand has gone once this many results running have missed it,
// and at least LOST_MIN_MS has passed. One miss is common and means little:
// the single-hand recognizer, coming back to a hand that has moved on since
// it last looked, can lose it for a frame and find it on the next. Counted in
// results rather than time, since a result can be most of a second coming on
// a Pi and a stroke shouldn't end because the machine is slow.
const LOST_MISSES = 2;
const LOST_MIN_MS = 400;
// A hand that turns up while another is already being tracked has to be seen
// on this many results running before it gets a controller. The recognizer
// now and then finds a second "hand" in the arm or the knuckles of the first
// for a single frame; given a controller at once, that ghost could take the
// real hand's next sample -- and its stroke with it. The first hand in view
// has no one to steal from, and is taken at once: waiting a result for it
// would cost every sign a few hundred milliseconds on a Pi.
const CONFIRM_HITS = 2;
// Two detections whose landmark boxes overlap by more than this share of the
// smaller box are one hand seen twice. Two real hands side by side -- the
// mint sign -- barely overlap at all.
const DUPLICATE_OVERLAP = 0.5;

function shapeOf(hand) {
    const lm = hand.landmarks;
    let x = 0, y = 0;
    for (const i of PALM) {
        x += lm[i * 3];
        y += lm[i * 3 + 1];
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < lm.length; i += 3) {
        minX = Math.min(minX, lm[i]);
        maxX = Math.max(maxX, lm[i]);
        minY = Math.min(minY, lm[i + 1]);
        maxY = Math.max(maxY, lm[i + 1]);
    }
    return { x: x / PALM.length, y: y / PALM.length, minX, minY, maxX, maxY };
}

function overlapShare(a, b) {
    const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
    if (w <= 0 || h <= 0) return 0;
    const area = (s) => Math.max(1e-6, (s.maxX - s.minX) * (s.maxY - s.minY));
    return (w * h) / Math.min(area(a), area(b));
}

/**
 * Assigns each result's hands to controller slots, so a hand keeps its
 * controller -- and its stroke, filters and half-held sign -- from one result
 * to the next.
 *
 * The recognizer's own order means nothing: with two hands up it can list
 * them either way round from frame to frame, and taking hand i for controller
 * i swapped strokes between hands. Hands are matched to where each controller's
 * hand was last seen instead. The recognizer also reports one hand twice now
 * and then; counting it as two turned a single thumbs-down (undo) into a
 * double one (delete everything), so overlapping hands are merged first, and a
 * hand nobody had needs confirming before it counts (CONFIRM_HITS).
 */
export class HandInput {
    constructor(slots = 2) {
        this.slots = [];
        for (let i = 0; i < slots; i++) {
            this.slots.push({ x: 0, y: 0, lastSeen: -Infinity, handedness: '', hits: 0, misses: 0, confirmed: false });
        }
        this.duplicatesDropped = 0;
    }

    /**
     * @param {{t: number, hands: object[]}} result
     * @returns {(?{x: number, y: number, z: number, gesture: string, handedness: string, tipWorld: ?number[]} | 'lost')[]}
     *   One entry per slot: its hand's fingertip and sign; null if this result
     *   has none for it; 'lost' on the result that decides its hand has gone
     */
    assign(result) {
        const t = result.t;
        const hands = this._dedupe(result.hands).slice(0, this.slots.length);
        const shapes = hands.map(shapeOf);

        const cost = (s, h) => {
            const slot = this.slots[s];
            const d = Math.hypot(shapes[h].x - slot.x, shapes[h].y - slot.y);
            // A controller with a hand keeps it; one with only a candidate
            // hand keeps that if nothing established wants it; a free one
            // costs the same wherever the hand is.
            let c = slot.confirmed ? d
                : slot.hits > 0 ? Math.max(d, NEW_TRACK_COST / 2)
                : NEW_TRACK_COST;
            if (slot.handedness && hands[h].handedness && slot.handedness !== hands[h].handedness) {
                c += slot.confirmed ? HANDEDNESS_COST : HANDEDNESS_COST / 3;
            }
            return c;
        };

        // Few enough hands and slots to try every assignment.
        let best = null;
        let bestCost = Infinity;
        const n = this.slots.length;
        const tryAssign = (h, used, order, total) => {
            if (total >= bestCost) return;
            if (h === hands.length) {
                best = order.slice();
                bestCost = total;
                return;
            }
            for (let s = 0; s < n; s++) {
                if (used & (1 << s)) continue;
                order[h] = s;
                tryAssign(h + 1, used | (1 << s), order, total + cost(s, h));
            }
        };
        tryAssign(0, 0, [], 0);

        const out = new Array(n).fill(null);
        const seen = new Array(n).fill(false);
        // Hands that arrive together, with none already tracked, are all first.
        const tracking = this.slots.some(slot => slot.confirmed);
        if (best) {
            for (let h = 0; h < hands.length; h++) {
                const s = best[h];
                const slot = this.slots[s];
                seen[s] = true;
                slot.hits++;
                slot.misses = 0;
                slot.x = shapes[h].x;
                slot.y = shapes[h].y;
                slot.lastSeen = t;
                slot.handedness = hands[h].handedness;
                if (slot.hits >= CONFIRM_HITS || !tracking) slot.confirmed = true;
                if (!slot.confirmed) continue;
                const lm = hands[h].landmarks;
                out[s] = {
                    x: lm[TIP * 3],
                    y: lm[TIP * 3 + 1],
                    z: lm[TIP * 3 + 2],
                    gesture: hands[h].gesture,
                    handedness: hands[h].handedness,
                    tipWorld: hands[h].tipWorld
                };
            }
        }
        // A candidate has to be seen on consecutive results; a confirmed hand
        // may miss one (see LOST_MISSES).
        for (let s = 0; s < n; s++) {
            const slot = this.slots[s];
            if (seen[s]) continue;
            slot.misses++;
            if (!slot.confirmed) {
                slot.hits = 0;
            } else if (slot.misses >= LOST_MISSES && t - slot.lastSeen >= LOST_MIN_MS) {
                slot.confirmed = false;
                slot.hits = 0;
                out[s] = 'lost';
            }
        }
        return out;
    }

    _dedupe(hands) {
        if (hands.length < 2) return hands;
        const shapes = hands.map(shapeOf);
        const keep = hands.map(() => true);
        for (let i = 0; i < hands.length; i++) {
            for (let j = i + 1; j < hands.length; j++) {
                if (!keep[i] || !keep[j]) continue;
                if (overlapShare(shapes[i], shapes[j]) > DUPLICATE_OVERLAP) {
                    const drop = hands[i].handednessScore >= hands[j].handednessScore ? j : i;
                    keep[drop] = false;
                    this.duplicatesDropped++;
                }
            }
        }
        return hands.filter((_, i) => keep[i]);
    }
}
