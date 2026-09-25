// Hand recognition, off the main thread.
//
// MediaPipe's recognizer is synchronous and slow on the machines this runs on:
// a Raspberry Pi 4 takes ~380 ms a frame with a hand in view. Called from the
// render loop, as it used to be, that was 380 ms in which nothing was drawn --
// drawing mode ran at two or three frames a second whenever anyone used it.
// Here it has a core of its own and the page renders at the display's rate,
// taking each result as it comes. HandTracker (hands.js) runs two of these,
// one looking for up to two hands and one for a single hand, and decides which
// gets each frame.
//
// Protocol (all messages are plain objects):
//   out { type: 'loaded' }                            -- listening; send init
//   in  { type: 'init', wasm, model, delegate, numHands }
//   out { type: 'ready' }
//   in  { type: 'frame', bitmap, t }                  -- bitmap is transferred and closed here
//   out { type: 'result', t, ms, hands: [...] }       -- see packResult in hands.js
//   out { type: 'error', message, fatal }

// MediaPipe loads its wasm glue with importScripts(), which a module worker
// has but refuses to run. Stand in for it: fetch synchronously and evaluate at
// global scope, which is where the glue's `var ModuleFactory` has to land.
self.importScripts = (...urls) => {
    for (const url of urls) {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.send();
        if (xhr.status !== 200) throw new Error(`importScripts ${url}: HTTP ${xhr.status}`);
        (0, eval)(xhr.responseText + '\n//# sourceURL=' + url);
    }
};

const { GestureRecognizer, FilesetResolver } =
    await import('../libraries/mediapipe/tasks-vision_0.10.3.js');
const { packResult } = await import('./hands.js');

let recognizer = null;

self.onmessage = async (event) => {
    const msg = event.data;

    if (msg.type === 'init') {
        try {
            const vision = await FilesetResolver.forVisionTasks(msg.wasm);
            recognizer = await GestureRecognizer.createFromOptions(vision, {
                baseOptions: { modelAssetPath: msg.model, delegate: msg.delegate },
                runningMode: 'VIDEO',
                numHands: msg.numHands
            });
            self.postMessage({ type: 'ready' });
        } catch (err) {
            self.postMessage({ type: 'error', message: String((err && err.message) || err), fatal: true });
        }
        return;
    }

    if (msg.type === 'frame') {
        const bitmap = msg.bitmap;
        try {
            const t0 = performance.now();
            const result = recognizer.recognizeForVideo(bitmap, msg.t);
            self.postMessage({ type: 'result', t: msg.t, ms: performance.now() - t0, hands: packResult(result) });
        } catch (err) {
            // One bad frame shouldn't end tracking.
            self.postMessage({ type: 'error', message: String((err && err.message) || err), fatal: false, t: msg.t });
        } finally {
            bitmap.close();
        }
    }
};

self.postMessage({ type: 'loaded' });
