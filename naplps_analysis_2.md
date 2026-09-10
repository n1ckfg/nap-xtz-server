# NAPLPS drift in drawing mode

Drawings made in live drawing mode came back wrong: shapes offset from where they
were drawn, worse toward the end of each stroke, and with pieces of the longer
strokes simply missing. Files loaded from disk and drawings converted from SVG
were fine. This is what the investigation found.

## It is not a vertex limit

The first theory was that a NAPLPS `POLY FILLED` instruction is capped at 256
vertices and that the Pi's C++ decoder overran a fixed buffer. That is not what is
happening, on any of its three claims:

- **The Pi's decoder has no fixed buffers.** `ofxNaplps` (`libs/ofxNaplps/src/Naplps.cpp`)
  is a direct port of `naplps.js` and collects points with `std::vector::push_back`.
  There is no `256` anywhere in the addon or in either Pi app.
- **The transport is not truncating.** `PiNaplpsPlayer` and `PiNaplpsDrawer` both
  raise the ofxHTTP websocket buffer to `MAX_NAP_BYTES` (1 MB), which is the
  ceiling `RPI_MAX_BYTES` matches on this end. A five-stroke drawing-mode frame
  encodes to about **1.5 KB**.
- **Long polygons already decode fine.** The `.nap` files in `public/images`, which
  play through the slideshow without trouble, run 15–94 KB and contain polygons of
  up to **239 points**.

The Pi is also not the odd one out. `Naplps.cpp` and `naplps.js` do the same
arithmetic, so a drawing that comes out wrong there comes out wrong the same way in
the browser.

## What was actually wrong

Every point in a `SET & POLY` after the first is a **delta** from the one before
it. `NapEncoder.makeNapVector2` converted each delta to its integer field with
`parseInt(Math.abs(input.x) * this.maxBitVals)` — truncation, which always
shortens the step. The bias runs one way, so the decoder's running sum falls
further behind with every point, and the error grows along the length of the
polygon rather than staying at the quantum.

Encoding a ring and decoding it with this repo's own decoder, at the Pi's 720 px
draw size:

| points in one polygon | drift, before | points the renderer dropped |
| --- | --- | --- |
| 64 | 11 px | 0 |
| 128 | 23 px | 0 |
| 256 | 45 px | 0 |
| 400 | 70 px | 2 |
| 900 | 158 px | 46 |

That last column is why parts of a drawing went missing rather than merely moving.
Both renderers skip any decoded point that falls outside the unit square
(`TelidonP5.js:78`, `Telidon.cpp:66`), so once the accumulated drift carries the
tail of a stroke over the edge of the frame, those points are not drawn at all.

**Why only drawing mode.** Drift needs a long polygon to build up in, and only
drawing mode makes them: `Stroke.toBrushOutline()` (`js/drawing/tools.js:311`)
turns a stroke into a single closed outline of twice its points, and
`convertToNAPLPS()` simplifies that at a tolerance of 0.002
(`js/drawing/drawing.js:1243`), which keeps most of them — a six-second stroke
arrives as a few hundred points in one polygon. The other sources are shaped the
other way around: across the twelve sample files, the median polygon is **3
points** and the 90th percentile is 6. At that length the drift is a pixel and
nobody sees it.

## The fix

`makeNapVector2` now rounds instead of truncating, and clamps the result into the
field (`js/telidon/naplps.js:1499`):

```js
const intX = Math.min(this.maxBitVals - 1, Math.round(Math.abs(input.x) * this.maxBitVals));
const intY = Math.min(this.maxBitVals - 1, Math.round(Math.abs(input.y) * this.maxBitVals));
```

Rounding leaves a random walk where there was a one-way march, so the error grows
with the square root of the point count instead of with the count:

| points | before | after |
| --- | --- | --- |
| 64 | 11 px | 1 px |
| 128 | 23 px | 1 px |
| 256 | 45 px | 2 px |
| 400 | 70 px, 2 dropped | 3 px, none dropped |
| 900 | 158 px, 46 dropped | 11 px, none dropped |

The clamp is not decoration. NAPLPS stores a negative delta in two's complement,
so a *small* negative step encodes as a magnitude just under 1.0 — and rounding
that up to `maxBitVals` overflows the 11-bit field and destroys the drawing
outright (720 px of error at 128 points). Truncation never overflowed, which is
presumably why it was written that way; the clamp is what makes rounding safe.

Nothing about the format changes: the same field is simply filled better. Encoded
size and point counts are byte-for-byte identical before and after, and all 47
`.nap` files in `public/images` decode to identical command and point lists.

## Loose ends

- **The C++ encoder has the same line.** `Naplps.cpp` writes
  `(int)(fabs(input.x) * maxBitVals)`. It only matters if `ofxNaplps` is used to
  *write* files, but it wants the same change.
- **`parseInt` on a float was also a hazard in its own right**: values below 1e-6
  stringify in exponential notation, and `parseInt(1e-7)` is `1`, not `0`.
  `Math.round` has no such edge.
- **Very long polygons still drift a little** — 11 px over 900 points, 57 px over
  2000. If drawing mode ever needs to shed points, raising the RDP tolerance in
  `convertToNAPLPS()` from 0.002 to 0.005–0.01 keeps the shape while holding
  polygons in the low hundreds. The 0.02 used by the SVG importer is too coarse
  for a brush outline: it collapses a 720-point outline to 13 points.
- **Two Pi-side behaviours look like faults but are not.** The player's dead man's
  switch replaces a received drawing with its own `bin/data` files after
  `slide_timeout` (30 s by default), and progressive draw reveals one point per
  command every 66 ms, so a dense drawing takes a few seconds to fill in.

## Where this landed

Both this note and the geometry work that followed it were reverted in `35d18e2`
and restored afterwards, so read the dates rather than the tree if the two
disagree. As it now stands:

- `makeNapVector2` rounds, clamped into the field, as above.
- A zero delta is written positive. Sign was taken from `input.x > 0`, so two
  points sharing an x or a y — which every axis-aligned edge has, and which a
  run of coordinates clamped to the frame edge has — went out negative. A
  negative y delta of zero magnitude decodes as a whole frame of displacement,
  and every point after it in the polygon inherits it, so the tail of the stroke
  left the frame and both renderers dropped it.
- The long outline this note describes is gone. `Stroke.toBrushOutline()` was
  replaced by `toBrushPolygons()`, which lays short filled polygons along the
  stroke instead of one closed outline around it; see ARCHITECTURE.md. Drift is
  bounded by construction there — every polygon is a `SET & POLY`, whose first
  point is absolute, so the running delta cursor resets every three or four
  points — which is why the "very long polygons still drift" loose end above no
  longer has anything to bite on.

`tools/brush-geometry` measures all of it: `compare` scores the geometries
against each other, `--encoder truncate|round` separates what the geometry costs
from what the encoder costs, and `checks` guards the edges.
