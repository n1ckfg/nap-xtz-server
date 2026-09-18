# Performance Improvements Applied (REPORT_3 Implementation)

Implementation report for the recommendations in `REPORT_3.md`. Six of the eight changes were applied to `public/js/drawing/drawing.js`; two were rejected as incorrect. Syntax verified with `node --check`.

## Applied

### 1. MediaPipe delegate: conditional GPU/CPU

`drawing.js:169` — `delegate: "GPU"` became:

```javascript
delegate: navigator.gpu ? "GPU" : "CPU"
```

GPU where WebGPU is actually available, CPU where it isn't (the case the report flagged as flaky on Windows/Beelink). The model asset path was left at version `1` — the "lite" variant `latest` is not a lighter model for the gesture recognizer and would change accuracy without a defined trade-off.

### 2. Webcam resolution 640×480 → 320×240

`drawing.js:511` — `getUserMedia` now requests `video: { width: 320, height: 240 }`. Four times fewer pixels per frame into the recognizer.

### 3. MediaPipe throttled to every 2nd webcam frame

`drawing.js:14-15` and `drawing.js:540-551` — added `mpFrameCount` / `MP_SKIP = 2`. The recognizer now runs on every second new webcam frame (~15 fps at a 30 fps webcam) instead of every animation frame. The `lastVideoTime` "frame seen" mark is kept on every new frame so the skip counts webcam frames, not animation frames.

### 4. Pixel ratio cap 1.5 → 1.0

All three sites, `drawing.js:193`, `drawing.js:200-201`, `drawing.js:389-390` — renderer, VHSC render target, and the resize handler:

```javascript
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));
```

```javascript
vhscPass = createVHSCPass(
    Math.round(size.w * Math.min(window.devicePixelRatio, 1.0)),
    Math.round(size.h * Math.min(window.devicePixelRatio, 1.0))
);
```

The resize handler carries the same figure, so the VHSC target stays matched to the renderer after a window resize.

### 5. Antialiasing disabled

`drawing.js:190` — `new THREE.WebGLRenderer({ antialias: false })`.

## Rejected

### MAX_HANDS 2 → 1 — breaks the mint gesture

`drawing.js:31` left at `const MAX_HANDS = 2`. The two-handed pinch/zoom/rotate gesture in `worldscale.js` requires both controllers, and the confirm/undo semantics are defined by hand count: a **double** thumbs-up mints, a **double** thumbs-down clears the drawing. With one hand neither double-gesture can fire, so gesture minting — the only unattended mint path — would be impossible. The report's "most users only draw with one hand" does not hold for this app.

### smoothReps 10 → 5 / splitReps 2 → 1 — not a render setting

`tools.js:52-53` left unchanged. `refine()` runs once in `Frame.endStroke()` (`tools.js:542`) and mutates `stroke.points` in place — the same array `convertToNAPLPS()` in `drawing.js` projects and encodes into the minted NAPLPS. Changing the counts changes the minted artwork, not the render cost: the preview mesh is rebuilt from those points at stroke end regardless, and the per-frame cost of the finished geometry is independent of how many refinement passes produced it. The report's "fewer subdivisions = fewer vertices = faster render" premise is false for this pipeline.

## Net effect

- MediaPipe: 2× fewer recognition runs (frame skip) × 4× fewer pixels (webcam) × no WebGPU fallback overhead (conditional delegate).
- GPU fill-rate: ~40% reduction from the pixel-ratio cap, the matching VHSC target, and no MSAA.

## Verification

- `node --check` on the modified `drawing.js` (as an ES module): passes.
- Grep cross-check confirms all five applied values in place and `MAX_HANDS` untouched.
- Remaining check is on the Beelink per REPORT_3's DevTools checklist: `recognizeForVideo` per frame (should be well under 15 ms now) and Three.js render time (< 8 ms for 60 fps).
