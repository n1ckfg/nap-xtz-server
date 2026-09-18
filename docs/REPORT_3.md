# Performance Improvements for Beelink Windows Machine (MediaPipe Skeleton Tracking)

Based on my analysis of the codebase, here are the key performance improvements for a Beelink Windows machine running MediaPipe skeleton tracking:

## High-Impact Changes

### 1. MediaPipe Model Configuration (biggest win)

In `public/js/drawing/drawing.js:164-171`, the model loads with `delegate: "GPU"`:

```javascript
baseOptions: {
    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
    delegate: "GPU"
},
```

Change to `CPU` on Windows/Beelink — WebGPU support in Chrome on Windows is flaky and often falls back to CPU anyway with overhead. Test both:

```javascript
delegate: navigator.gpu ? "GPU" : "CPU"  // or just "CPU" for stability
```

Also, consider the lite model (faster, less accurate):

```javascript
modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task"
// vs full:
// modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
```

### 2. Reduce MAX_HANDS

In `public/js/drawing/drawing.js:29`:

```javascript
const MAX_HANDS = 1;  // instead of 2
```

Most users only draw with one hand. This cuts MediaPipe work ~50% and safely propagates throughout the entire rendering loop.

### 3. Lower Webcam Resolution

In `public/js/drawing/drawing.js:509`:

```javascript
video: { width: 320, height: 240 }  // instead of 640x480
```

MediaPipe downscales internally anyway. 320x240 is plenty for gesture recognition and halves pixel throughput.

### 4. Throttle MediaPipe to 15-20 FPS

In `public/js/drawing/drawing.js:538-544`, the loop calls `recognizeForVideo` every frame. Add a frame skip:

```javascript
let mpFrameCount = 0;
const MP_SKIP = 2;  // run every 3rd frame → ~20fps at 60fps display

if (gestureRecognizer && video.readyState >= 2) {
    let nowInMs = Date.now();
    if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime; // Mark frame as seen
        if (++mpFrameCount >= MP_SKIP) {
            results = gestureRecognizer.recognizeForVideo(video, nowInMs);
            mpFrameCount = 0;
        }
    }
}
```

### 5. Cap Three.js Pixel Ratio

Already done at line 191:

```javascript
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
```

Good — keep this. On Beelink integrated graphics, even 1.5 may be high; try `1.0`.

### 6. Reduce VHSC Shader Resolution

In `public/js/drawing/drawing.js:197-200`:

```javascript
vhscPass = createVHSCPass(
    Math.round(size.w * Math.min(window.devicePixelRatio, 1.0)),  // was 1.5
    Math.round(size.h * Math.min(window.devicePixelRatio, 1.0))
);
```

The post-process shader runs at render target resolution — this is a major GPU cost.

### 7. Simplify Stroke Geometry

In `public/js/drawing/tools.js`:

- `smoothReps: 10` → `5` (line 52)
- `splitReps: 2` → `1` (line 53)

Fewer subdivisions = fewer vertices = faster render.

### 8. Disable Antialiasing

In `public/js/drawing/drawing.js:188`:

```javascript
renderer = new THREE.WebGLRenderer({ antialias: false });
```

Saves ~30% fragment shader cost on integrated GPUs.

---

## Quick Wins (Config Only)

| Setting | Current | Recommended | Location |
| :--- | :--- | :--- | :--- |
| **MediaPipe delegate** | GPU | CPU | `drawing.js:167` |
| **MAX_HANDS** | 2 | 1 | `drawing.js:29` |
| **Webcam resolution** | 640×480 | 320×240 | `drawing.js:509` |
| **Three.js pixelRatio** | 1.5 | 1.0 | `drawing.js:191` |
| **VHSC render scale** | 1.5× | 1.0× | `drawing.js:198-199` |
| **antialias** | `true` | `false` | `drawing.js:188` |
| **smoothReps** | 10 | 5 | `tools.js:52` |

---

## Verify First

Run with Chrome DevTools Performance tab — record 10s of drawing, check:

- MediaPipe `recognizeForVideo` time per frame (should be <15ms)
- Three.js render time (should be <8ms for 60fps)
- GPU memory (integrated often shares system RAM)

> [!TIP]
> Start with changes #1, #2, #3 — they're pure config and give the biggest return.
