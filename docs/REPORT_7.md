# Drawing Mode on Low-End Hardware: Strokes, Gestures and Responsiveness

The earlier reports tuned what one frame costs (`REPORT_3.md`, `REPORT_5.md`)
and what piles up over a week of kiosk uptime (`REPORT_6.md`). This one asks
a narrower question: what is it like to *draw* on the slowest machine the
installation runs on, and how much of that is the machine rather than the
code?

Every figure here was measured on a **Raspberry Pi 4 Model B** (4 × Cortex-A72,
8 GB, VideoCore VI), in the Chromium the kiosk runs (151), with WebGL on the
Pi's own GPU (ANGLE → GLES → V3D 4.2). *How it was measured* at the end has the
test rigs and their limits. The short version: on the Pi, drawing mode ran at
**two frames a second**. A slow circle kept **a quarter** of what the hand drew,
and a quicker wave almost none of it. It now runs at 20 frames a second in a
headless browser (likely more on a real display), and keeps **94–100%** of both,
at **1–2 px** mean error on a 640 px canvas.

**Status:** everything in §1–§10 is implemented, in `public/js/drawing/` and
one guard in `public/index.html`. `ARCHITECTURE.md` is updated to match.

---

## Headline numbers

End to end, on the Pi. A real hand photo (MediaPipe's own `pointing_up.jpg`
test image) traced a circle (6 s) and then a sine wave (4 s) through
Chromium's fake webcam, each ended with a fist. The page drew them, and the
NAPLPS it produced on exit was scored against the path the fingertip actually
took. There were three runs of each version, alternated; the table gives the
median (range).

| | before | after |
| --- | --- | --- |
| Frame interval, hand in view | **400 ms** (400–533) | **50 ms** (50–50) |
| Frames rendered in the 13 s a hand was in view | 29 | 270 |
| Hand results during a stroke | ~2.2 Hz, ~450 ms old | ~4 Hz, ~270 ms old |
| Freeze when hand tracking starts | **9.3 s** (9.2–9.7) | none (worst frame 0.32 s) |
| Circle: share of the path drawn (within 8 px) | **26%** (18–36) | **100%** (100–100) |
| Circle: mean error of what was drawn | 5.5 px (5.3–9.6) | **1.1 px** (0.7–1.1) |
| Wave: share of the path drawn | **5%** (0–9) | **94%** (93–95) |
| Wave: mean error of what was drawn | 12.5 / 15.5 px (no stroke in one run) | **2.0 px** (2.0–2.5) |
| Page open → camera running | 18.8 s | 11.0 s |
| Page open → hands working | ~28 s (18.8 s + the 9.3 s freeze) | ~11 s |
| Re-entering drawing mode → tracking | 2.6 s | 0.16 s |

"Before" is the committed code as it runs on this Pi, which picks MediaPipe's
GPU delegate (§2). Forced onto the CPU delegate instead, the old code has no
9 s freeze but renders a frame every ~650 ms, and kept 16% (15–23) of the
circle and 0% (0–3) of the wave.

Rendering, on the Pi's GPU at 1440×1080 (the kiosk's 4:3 box on a 1080p
screen), VHSC pass included:

| strokes on screen | draw calls, before → after | frame cost, before → after |
| --- | --- | --- |
| 100 | 100 → 1 | 20.4 → 14.2 ms |
| 601 (median attract file) | 601 → 1 | **27.5 → 14.7 ms** |
| 1909 (largest attract file) | 1909 → 1 | **52.6 → 15.6 ms** |

---

## 1. The recognizer ran in the render loop — the whole mode ran at its speed

**`drawing.js` (old `animateLoop`)**

`recognizeForVideo()` is synchronous, and it was called from the animation
frame. On the Pi, with one hand in view, it takes **381 ms** (CPU delegate,
320×240 input; input size makes no difference, since the models resize).
Nothing is drawn during that time. So drawing mode rendered at the
recognizer's rate: about **2 fps whenever someone used it**, and 3–4 fps with
nobody there (palm detection alone is ~200 ms).

**Fix:** the recognizer now runs in a module worker (`hands-worker.js`),
driven by `HandTracker` (`hands.js`). Frames go over as `ImageBitmap`s, one at
a time: the next frame is sent the moment the last result is back. The
recognizer therefore runs flat out, with no queue of stale frames behind it,
and the page renders at its own pace. MediaPipe loads its wasm glue with
`importScripts()`, which a module worker has but refuses to run. The worker
stands in for it with a synchronous fetch evaluated at global scope. If no
module worker can be had, it falls back to the main thread as before.

With the recognizer in a worker and a page doing nothing else, the Pi held
16.7 ms frames. With it on the main thread, the same page got one frame per
recognition, 381 ms. Where drawing mode's frames are slower than 16.7 ms now,
the cause is its own rendering (see *What these numbers are not*).

## 2. The "GPU" delegate was chosen by the wrong test, and on a Pi it stalls everything

**`drawing.js`: `delegate: navigator.gpu ? "GPU" : "CPU"`**

MediaPipe's GPU delegate is WebGL, not WebGPU, so `navigator.gpu` says nothing
about whether to use it. Worse, Chromium defines `navigator.gpu` on any
localhost or https page, whether or not there is a usable adapter, so on the
Pi the page chose the GPU delegate. There it shares the one weak GPU with the
scene:

| on the Pi | CPU delegate | GPU delegate |
| --- | --- | --- |
| first frame (shader compilation) | 1.2 s | **9.0 s** |
| steady state, one hand in view | 381 ms | 275 ms |

In the page, the 9 s first frame was a **9.3 s freeze** of drawing mode as soon
as the camera started, in every baseline run. Anyone who began drawing in those
seconds got nothing. Once the recognizer moved to a worker, the same
compilation blocked the page's own GL calls instead: a 17 s long task on the
main thread.

**Fix:** always use the CPU delegate. The CPU delegate has a core to itself;
the GPU delegate would compete with every frame the scene draws.

## 3. p5 was animating the review canvas behind the drawing overlay

**`index.html`, `draw()`**

The page opens straight into drawing mode, and at the same moment
`preload()` loads the newest token from the chain. When that token arrives,
p5 starts its reveal animation and its own WebGL VHSC pass at full screen,
behind the opaque overlay, for as long as the reveal takes. The
`liveDrawingActive` guard in `tezos.js` covers drawings pushed later, but not
this first one.

Measured with every other change in place: **117 ms frames with p5 running,
50 ms without**. Hand results slowed from one every 0.25 s to one every
0.6–0.9 s, because p5's main-thread work also delayed the frames sent to the
recognizer.

**Fix:** `draw()` calls `noLoop()` and returns while drawing mode is up.
Leaving drawing mode already calls `loop()`, and the smoke test confirms the
review canvas picks up the new drawing.

## 4. Two hands cost twice what one does, and one hand is the common case

With `numHands: 2` and one hand in view, MediaPipe runs palm detection on
every frame, looking for the second hand. That search is half the cost:

| on the Pi, one hand in view | per frame |
| --- | --- |
| `numHands: 2` | 381 ms |
| `numHands: 1` (hand tracked, no palm detection) | 176 ms |

`numHands` can't simply drop to 1: the two-handed gestures (move, mint,
delete all) need two, as `REPORT_5.md` found. So there are now two
recognizers, **each in its own worker**. Loading one blocks its thread for
6–15 s on a Pi; sharing a worker, the second one to load held up tracking for
that long. `HandTracker._pick()` gives each frame to one of them:

- **the single-hand recognizer** while one hand is in view. Mid-stroke it
  keeps these frames even after a miss, since it finds the hand again on its
  own next frame, sooner than the two-hand one would;
- **the two-hand recognizer** when no hand is in view (palm detection runs
  either way, so it costs the same and catches two hands arriving together),
  when two were seen last time, and when the hand in view makes a sign with
  a two-handed meaning (fist, thumb). It also takes a look for a second hand
  once a second, but never mid-stroke, when the look would cost the stroke
  most of a second of samples.

Each recognizer is warmed up on a blank frame before it is used; the first
frame is several times slower than the rest. Both stay loaded between visits
to drawing mode. The old code created a new recognizer on every entry and
leaked the previous one, which is the 2.6 s → 0.16 s re-entry figure.

**Measured, one hand drawing, recognizer in isolation: 2.6 Hz → 4.8 Hz**, and
each result is ~180 ms old instead of ~380 ms. In the full page, strokes get a
sample about every 250 ms.

What four samples a second still can't do is follow a fast zigzag. The
simulator's fast wave (two full oscillations in 1.5 s) keeps 38–45% of its
path at the Pi's rate against 98% at 30 Hz. That is a sampling limit, not a
logic one.

## 5. A fixed five-frame trim cut most of every stroke off

**`tools.js` (old `pointsTrimStart = 1`, `pointsTrimEnd = 5`)**

Every stroke dropped its first point and its last five, to lose the frames in
which the hand changes sign. Five frames is 80 ms at 60 fps. On the Pi, where
the frame rate *was* the recognizer rate, it was **over two seconds**, and
over three with the CPU delegate. Together with the lag of the old filters
(§6), that is most of what the headline table's "before" column is missing:
the wave, five seconds of pointing, came out as a stub or not at all.

The trim also applied where there is no sign to change. Attract mode's
replays lost six points of every polygon, and each polygon is padded to only
12 points. The mouse lost its last 80 ms.

**Fix:** points carry the time they were measured.
`Frame.endStroke(id, cutTime)` drops the points after the cut, and whoever
ends the stroke says where the cut is. For a hand, the cut is where the sign
that ended the stroke was first seen, less 40 ms. If the hand simply left, the
stroke keeps everything; if the hand was already changing to another sign
when it left, the cut falls where that sign began. The start works the same
way: the controller keeps its recent path, and a stroke begins where its sign
was first seen, not when the debounce (§8) confirmed it. Attract mode and the
mouse pass no cut and keep every point.

- **Attract replays:** 20 files, 12,644 polygons. The share of each source
  polygon's centreline length the replay reproduces went from **60.2% to
  99.5%**, and no dots are lost (§10).
- **Mouse:** strokes end where the button came up.

## 6. Smoothing ran per animation frame, so it depended on the machine

**`controller.js` (old Kalman filters, confidence score)**

The controller was updated once per animation frame, and the last recognizer
result was fed in again on every frame until a new one came. What the filters
and timers did therefore depended on two unrelated rates:

- A per-frame Kalman filter fed the same measurement six times is not the
  filter it was tuned as. On the Pi, where frame rate equalled recognizer
  rate, the **pointer took over 4 seconds** to reach 90% of a quick move, and
  the position strokes were drawn from took 1.5 s.
- The jerk "confidence" score measured acceleration between frames. It read
  each new result as a jolt after several frames of stillness, and could
  force buttons off mid-gesture.

**Fix:** everything is driven by results, on the results' own clock (the time
the camera frame was taken). The fingertip goes through **One Euro filters**:
heavy smoothing at rest, and a cutoff that opens with speed so there is
little lag in motion. There is one for drawing, a steadier one for the
two-handed move, and a very steady one for depth. Strokes are made of the
filtered samples themselves. The visible pointer eases between samples over a
third of the result interval, so it glides rather than jumping, and on a
fast machine that adds almost nothing.

| time for the pointer to reach 90% of a quick move (simulated) | before | after |
| --- | --- | --- |
| Pi (2.3 Hz before, ~4 Hz after) | **4.1 s** | **0.5 s** |
| fast machine (30 Hz) | 150–163 ms | 67 ms |

One trade-off, stated honestly: on a fast machine the *stroke* position
(not the pointer) now settles in 67 ms against 50–57 ms before. The One Euro
filter smooths more at rest than the old per-frame Kalman did at 60 fps, which
is where the jitter figures in the simulator tables come from.

## 7. Depth noise moved strokes across the screen

**`drawing.js` (old `worldX/worldY` on a flat grid, then `worldZ = -z * 5`)**

The fingertip was placed on a flat grid at the target's depth, then moved
toward or away from the camera by the recognizer's depth estimate. Through a
perspective camera, that second move also shifts the point across the screen,
outward or inward in proportion to its distance from the centre. Depth is the
noisiest thing the recognizer reports, so strokes wobbled most at the edges of
the frame. The photo's steady depth (−0.055) put the whole drawing **~6% larger
than the hand's path** (5 / (5 − 0.28)). The grid also assumed the camera was
where it starts, so after an alt-drag orbit or WASD, hands drew somewhere else.

**Fix:** `placeHandPoint()` puts each point on the camera's ray through the
fingertip, at a distance set by depth. The point lands on screen exactly under
the finger, whatever the depth and wherever the camera is, and the 3D depth is
still there when the drawing is turned.

## 8. One misread frame could end a stroke, reset a hold, or delete the drawing

**`controller.js`, `drawing.js`**

Signs were taken raw, frame by frame, and hands were matched to controllers by
the recognizer's list order. Things that happen routinely at a kiosk:

- **A misread frame** (Closed_Fist or Open_Palm for a pointing finger) ended
  the stroke. A misread during a 2-second hold started the hold over; at 30
  results a second, some frame in two seconds is almost always misread.
- **The recognizer's order means nothing.** With two hands up it lists them
  either way round from frame to frame, and `results.landmarks[i]` went to
  controller `i`. Strokes jumped between hands.
- **The recognizer sometimes reports one hand twice.** A single thumbs-down,
  seen twice, is *two* thumbs-down, which means **delete everything**, not
  undo.
- **A hand that left mid-stroke** stayed "held": the line tool was sticky and
  ignored absence. When the hand came back, anywhere, the stroke carried on
  with a straight line from where it had left.

**Fixes:**

- **Debounced signs** (`GestureFilter`): a sign counts once seen on two
  results for at least 60 ms (three results when the hand moves fast). "None"
  (the recognizer being unsure) needs 250 ms before it can end a held sign.
  Because strokes and holds are backdated to the sign's first sighting, the
  wait costs nothing.
- **Hand identity** (`HandInput`): hands are matched to the controller whose
  hand was last seen nearest, with handedness as a tie-breaker. A hand that
  turns up while another is already tracked must be seen twice before it gets
  a controller, so a one-frame ghost in the knuckles can't take the real
  hand's next sample.
- **Duplicates:** detections whose landmark boxes overlap by more than half
  are one hand. Two real hands side by side (the mint sign) barely overlap.
- **Leaving:** a hand is gone after two results running without it (and at
  least 400 ms). That ends its stroke and releases its signs. One missed
  result is common and ends nothing.
- **Tools:** the line tool stays sticky through "None", as before, but now
  ends on any sign the hand deliberately makes instead. Going from one finger
  to two switches to the fill tool, rather than drawing both at once.
- **Holds** are timed on what the camera saw: from the sign's first sighting
  to now, but never more than one result past its latest sighting. A hand that
  drops out of view stops the clock rather than running it on. A one-handed
  hold that fills while another visible hand is making the same sign, not yet
  confirmed, waits up to 1.5 s for it. Two thumbs rarely read as thumbs on the
  same result, and the one-handed action (recentre, undo) was firing the
  moment the first one filled.

Measured in the logic simulator (see *How it was measured*; 40 seeds per
cell, pessimistic noise model; the mild model is described there too):

| scenario | Pi before | Pi after | fast before | fast after |
| --- | --- | --- | --- | --- |
| circle drawn as one stroke | 83% | 95% | 3% | 100% |
| circle: share of path drawn | 7% | 90% | 74% | 99% |
| circle: mean error | 11.1 px | 2.5 px | 8.7 px | 1.2 px |
| filled shape drawn as one stroke | 35% | 95% | 0% | 100% |
| two hands drawing at once, both strokes intact | 23% | 98% | 18% | 98% |
| two hands: mean error | 29.4 px | 1.3 px | 61.3 px | 1.3 px |
| hand leaves and returns: a line bridges the gap | 10% | 0% | 98% | 0% |
| 3 s thumbs-down: undo fires, once | 43% | 90% | 0% | 100% |
| thumbs-down with duplicate detections: **delete-all fires instead** | **15%** | **0%** | 0% | 0% |
| two thumbs up: mint fires | 83% | 98% | 38% | 100% |
| a 1.4 s hold fires anyway | 0% | 0% | 0% | 0% |

"Pi before" is the old code at the rate it actually got on the Pi (2.3 Hz for
render and recognizer alike). "Pi after" is the new code at its measured rate:
4 Hz for one hand, 2.6 Hz for two. The new code at the *old* rate still gets
the circle to 71% coverage and 5.3 px error. Most of the gain is the logic;
the extra samples add the rest.

## 9. Every stroke was its own draw call

**`tools.js`, `Frame._refreshGeometry()`**

`REPORT_6.md` §1 stopped the per-stroke rebuilds. Each stroke still had its
own mesh, though, so N strokes meant N draw calls, and on the Pi each costs
about 15 µs of CPU before the GPU does anything: 9.6 ms of every frame for the
median attract file, 28.6 ms for the largest. Attract mode is the kiosk's
resting state.

**Fix:** `StrokeBatch` keeps every completed stroke in one vertex-coloured
mesh. A stroke is written once, into the space after the last, and only that
range is uploaded; undo pops it; the buffers double when they fill. The frame
cost is now flat, 14–16 ms whatever the stroke count (the table at the top),
and replaying a 601-polygon drawing takes 151 ms of CPU instead of 510 ms.
Vertex colours are stored as the material colour was (linear), and all 12
palette colours render byte-identical to the per-mesh version.

The stroke being drawn still has a mesh of its own, rebuilt at most once a
frame (`Frame.flush()`) rather than once per point. Each rebuild costs
slightly more than before (0.28 against 0.14 ms at 50 points, 1.2 against
1.0 ms at 600) because it now includes the curve fit (§10).

## 10. Strokes were the polygon they were sampled as

**`tools.js`, `Stroke.refine()`, `computePressures()`**

`refine()` split every segment twice and smoothed lightly. That rounds a
stroke sampled 60 times a second. A hand tracked four times a second draws a
circle as a hexagon, and splitting a hexagon gives a hexagon with more points.
The brush's taper also ran by point count, so a slow, densely sampled start
came out long and thin, and a fast finish short and fat.

**Fix:** `refine()` fits a **centripetal Catmull-Rom spline** through the
samples. It passes through every point the hand gave and neither loops nor
overshoots where samples bunch up. The live preview shows the same curve.
Taper and pressure run by **distance along the stroke**. Points closer than
0.01 units merge into one, so a still hand doesn't pile up samples, and a
stroke that never moves further than that is kept as a dot rather than
dropped.

Smoother paths also encode smaller, because the simplifier finds more points
it can drop:

| encoded size (simulated, mild noise) | before | after |
| --- | --- | --- |
| circle, fast machine | 385 bytes | 279 bytes (99% of the path vs 85%) |
| filled shape, fast machine | 305 bytes | 152 bytes |
| two lines, fast machine | 1,323 bytes | 200 bytes |
| circle on the Pi, per full circle drawn | ~700 bytes (8% of it drawn) | 293 bytes (97%) |

So a drawing now gets further before `convertToNAPLPS()` has to coarsen it to
fit the mint limit.

---

## Smaller things fixed along the way

- **Per-frame DOM writes.** The loop set `display` on every overlay and
  `innerText` on both hand labels every frame, even with the labels hidden.
  It now writes only on change, and skips the labels while the chrome is
  hidden. The mouse controller no longer allocates four vectors a frame.
- **The mouse waited for the recognizer.** It was enabled only after
  MediaPipe loaded (5–20 s on a Pi, or never if loading failed). It now draws
  from the start.
- **Leaving during setup.** Exiting drawing mode while the camera was being
  requested left the camera running. That is now guarded, including the
  exit-and-re-enter race. Stopping drawing mode releases the hands and drops
  their half-drawn strokes.
- **Timestamps.** The recognizer was fed `Date.now()`, which can go backwards
  when a Pi without an RTC syncs its clock, and MediaPipe throws on a
  timestamp that doesn't advance. It now gets `performance.now()`, kept
  strictly increasing, and a failed frame is logged and skipped rather than
  thrown into the render loop.
- **Adaptive render scale.** When frames run long, the canvas renders one step
  smaller (down to 0.5 of the 4:3 box) and the browser scales it up. The step
  is kept only if frames actually got faster, with exponential backoff between
  trials, and a step back up happens when there is room. In the headless
  tests, the Pi's frame time with the recognizer running did *not* respond to
  resolution (below), so the trial reverted and the scale stayed at or near 1.
  It is there for a display where the GPU is the bottleneck, and is built so
  it can't settle somewhere that doesn't help.

## Behaviour that changed

Behaviour that has changed, beyond being faster, and that could surprise
someone who knows the installation:

1. **Lowering your hand ends the stroke** (after about two results). It used
   to stay on and draw a straight line to wherever the hand reappeared.
2. **Any deliberate sign ends a line**, not only a fist or an open palm.
   Pointing then making a V switches to the fill tool.
3. **Holds count observed time.** A hand that leaves mid-hold stops the
   clock, and a one-handed hold waits briefly for a second hand showing the
   same sign.
4. **Strokes look smoother and taper by length**, including attract mode's
   replays, which are now also complete (§5).
5. **Mouse strokes keep their last 80 ms**, and the mouse works while hand
   tracking loads.
6. The pointer's colour and the hand labels follow the **confirmed** sign
   rather than each frame's raw reading.

---

## How it was measured

**The Pi.** Raspberry Pi 4 Model B (Rev 1.4, 8 GB), Raspberry Pi OS
(bookworm), Chromium 151.0.7922.108, run headless through Playwright with
`--use-angle=gles-egl --use-gl=angle`. That gives WebGL on the real GPU
("ANGLE (Broadcom, V3D 4.2.14.0, OpenGL ES 3.1)"), not SwiftShader. Viewport
1920×1080. The server ran from the working tree on private ports with the Pi
link, the peer link and chain polling all off. The "before" figures come from
the committed code (`HEAD`, 93eff65), served the same way on a second port and
run alternately with the new code, so heat affected both equally. The SoC
stayed at 58–62 °C and was not throttling at any check.

**End to end.** Chromium's fake camera played a 320×240, 30 fps, 31 s y4m file
built from MediaPipe's public test photos (`pointing_up.jpg`, `fist.jpg`). The
photo was translated so its index fingertip, located once with the recognizer
itself, traced a circle (6 s) and then a sine wave (4 s), each ended by a
100 ms crossfade into a fist. Gaussian sensor noise (σ = 3 levels) was added
to every frame. The first 12 s are empty, so the old code's start-up freeze is
over before the hand appears. A first batch without that lead-in was
discarded: the freeze covered the whole circle, which measured the freeze
rather than the drawing. Each frame carries its number as a barcode along the
bottom edge. The test reads it from the page's own video element to confirm
the page sees the camera in real time (it does, in both versions), and leaves
drawing mode only once the page has shown the last frame. The page ran
untouched. Hand tracking ran for real, the drawing was encoded on "Exit
Drawing", and the NAPLPS was decoded and scored:
- **share of path drawn**: true-path samples within 8 px of a stroke's
  centreline;
- **mean error**: centreline distance from the true path;
- **frame intervals**: from `requestAnimationFrame` while the hand was in
  view.

**The logic simulator.** The old per-frame pipeline (the committed
`controller.js`, `tools.js` and a line-for-line port of the old loop) and the
new per-result one (the new modules, plus the loop's per-result code) were fed
identical synthetic recognizer output, 40 seeds per cell. Everything except
the recognizer is the real code. The noise model:

| | pessimistic | mild |
| --- | --- | --- |
| fingertip jitter (σ, frame widths) | 0.003 | 0.002 |
| outliers (rate / σ) | 2% / 0.03 | 0.5% / 0.02 |
| depth jitter (σ) | 0.02 | 0.01 |
| misread sign, per result | 12% | 3% |
| hand missing from a result | 5% | 1% |
| duplicate of a hand | 4% (15% in the duplicate test) | 1% (15%) |
| handedness flipped | 5% | 2% |
| list order | shuffled | shuffled |

Both pipelines were given the same one-result latency. The old loop presented
a frame a recognition after it began, so its events and pointer were shifted
by one result interval too. Under the mild model, the Pi comparison reads:
circle drawn as one stroke 85% → 98%; share of path drawn 8% → 97%; undo fires
78% → 100%; delete-all fired in place of an undo 25% → 0%; two hands intact
38% → 100%.

**Microbenchmarks.** Recognizer timings were taken on 320×240 frames of the
same photos, 30–50 frames each, after a warm-up frame. Render timings used the
real `Frame` classes (old and new side by side), with strokes built the way
attract mode builds them, and a 1-pixel `readPixels` after each frame to wait
for the GPU.

### What these numbers are not

- **Headless, not the kiosk's screen.** A blank page runs at 60 fps headless
  on the Pi, but the full-screen VHSC canvas runs at 20–30: headless Chromium
  composites the page to an offscreen buffer, which a real display doesn't.
  With the recognizer running, the frame time stayed at 50 ms whatever the
  resolution, which suggests CPU and shared memory bandwidth, not fill rate.
  The frame figures should be read as *relative*. Absolute frame rates on a
  monitor are likely better, but that was not measured here.
- **A photo is not a hand.** The test video moves a rigid picture with no
  motion blur and no finger movement between signs. Real use will misread
  more than this video did, which is why the simulator's pessimistic model
  exists. The simulator's noise model is an assumption, not a measurement;
  the conclusions hold under both models, but the percentages depend on them.
- **Three end-to-end runs per version.** Enough to show the effect clearly,
  not to pin down the spread. At four samples a second, whether a fast peak
  gets a sample is partly luck. In the discarded first batch, one new-code run
  got no sample near the top of a wave peak, and the curve fitted across the
  gap cut the corner (49% of the wave drawn). It is the kind of miss §4
  describes.

## Not done

- **MediaPipe's tracking thresholds.** Lowering `minHandPresenceConfidence`
  and `minTrackingConfidence` to 0.3 on the single-hand recognizer, to cut
  misses, made no difference that three runs could separate from chance, so
  it was left at the defaults.
- **Mouse position vs pointer.** The mouse maps the whole window onto the 4:3
  canvas, so when the pointer is visible, the 3D cursor is not under it on a
  16:9 screen. This affects mouse drawing on any hardware, so it was left
  alone.
- **`tools/brush-geometry` still doesn't run.** It is broken by a
  pre-existing import (`BRUSH_OVERLAP_PASSES`, `REPORT_6.md`). This change
  also removes `Stroke.splitStroke()` and `splitReps`, which `refine()` no
  longer uses; the tool's `draw` command builds strokes through `refine()`,
  so its numbers would change even once it loads.
- **The test rigs are not in the repository.** They are the fake-camera
  end-to-end run, the simulator, and the render benchmarks, and they depend
  on Playwright and a generated 100 MB video. They could go into `tools/` as a
  regression check for drawing mode.

## Files changed

| file | |
| --- | --- |
| `public/js/drawing/hands-worker.js` | new: one recognizer in a module worker |
| `public/js/drawing/hands.js` | new: `HandTracker` (workers, recognizer choice, fallback) and `HandInput` (identity, duplicates, loss) |
| `public/js/drawing/controller.js` | rewritten: per-result, One Euro filters, `GestureFilter`, stroke start and cut times, pointer easing |
| `public/js/drawing/tools.js` | timed points and cuts, Catmull-Rom `refine()`, arc-length taper, dots, `StrokeBatch`, `flush()`, typed-array geometry |
| `public/js/drawing/drawing.js` | worker results into the loop, ray placement, observed-time holds, partner wait, render scale, DOM write guards, setup and exit races |
| `public/js/drawing/mouse.js` | scratch vectors |
| `public/index.html` | p5's loop stops while drawing mode is up |
| `ARCHITECTURE.md` | *Hands, off the main thread*, *Render scale*, *Smooth strokes from sparse samples* |
