# brush-geometry

Measures what happens to a live-drawing brush stroke on its way through NAPLPS —
how far the decoded shape has moved, whether any polygon crosses itself, what it
costs in bytes — so a change to `Stroke.toBrushQuads()` can be judged by numbers
rather than by squinting at a canvas.

```
node tools/brush-geometry/brush-geometry.mjs compare
node tools/brush-geometry/brush-geometry.mjs compare scribble --encoder truncate
node tools/brush-geometry/brush-geometry.mjs checks
node tools/brush-geometry/brush-geometry.mjs sheets hairpin depth
node tools/brush-geometry/brush-geometry.mjs draw
node tools/brush-geometry/brush-geometry.mjs loss
```

| Command | |
| --- | --- |
| `compare [stroke ...]` | scores every candidate geometry against the ideal brush |
| `checks` | asserts the shipped `toBrushQuads` holds up at the edges; exits non-zero on a failure |
| `sheets [stroke ...]` | writes side-by-side PNGs: ideal, the old outline, what ships now |
| `draw` | draws strokes through a real `Frame` and exports them end to end, budget ladder included |
| `loss [stroke ...]` | how much of a stroke survives when polygons go missing, at each `BRUSH_OVERLAP_PASSES` setting |

| Option | |
| --- | --- |
| `-e, --encoder <mode>` | `file` (default), `round`, or `truncate` |
| `-o, --out <dir>` | where `sheets` and `draw` write (default: `tools/brush-geometry/out`) |
| `-l, --limit <bytes>` | `draw`: the mint limit to fit under (default: 30000) |
| `-t, --tolerance <n>` | `draw`: where the ladder starts; `0` is the brush that keeps every point |
| `-s, --strokes <n>` | `draw`: how many strokes to draw (default: 4) |
| `-h, --help` | usage, including what each column means |

There are no dependencies beyond `three`, which the server already has. PNGs are
written by `tools/thumbnail-maker`.

## What it measures against

Nothing here re-implements the format. `naplps.mjs` runs
`public/js/telidon/naplps.js` — the browser's own encoder *and* decoder — in a
`vm` context, so a candidate is scored against the code that will actually carry
it, and a fix to either reaches this tool for free.

The eight strokes in `strokes.mjs` are synthetic, each picked for something it
does to a brush: a `spiral` long enough for delta error to accumulate in, a
`hairpin` that turns tighter than the brush is wide, a `depth` sweep that travels
toward the camera, an `edgeOn` stroke whose own plane is nearly degenerate, a
dense `scribble` that overlaps itself. They are built through `Stroke.refine()`,
so a hundred sampled points arrive as four hundred, as they do in the app.

Each is scored against **the ideal brush**: the same stroke stamped at full
resolution as one trapezoid per segment plus a disc at every point, filled a
polygon at a time so no winding rule has an opinion about it.

| column | |
| --- | --- |
| `drift px` | furthest a decoded vertex landed from the one that was encoded, in artwork pixels |
| `dropped` | decoded points outside the frame, which `TelidonP5.js` and `Telidon.cpp` both discard |
| `crossings` | times a polygon crosses itself — above zero, what gets filled depends on the renderer |
| `roundtrip` | decoded shape vs the shape that went in |
| `shape` | decoded shape vs the ideal brush; simplification is what costs a candidate here |
| `rule-agree` | the same decoded shape filled nonzero vs even-odd — below 1.0 it looks different in a browser than in openFrameworks |

The three ratios are intersection-over-union of the filled pixels, where 1.0 is
identical coverage.

## The byte budget

`convertToNAPLPS()` will not hand the wallet a drawing too big to mint: it
re-encodes with a coarser brush until the result fits `maxNaplpsBytes`, up to
five doublings of the tolerance. `draw` runs the same ladder and prints each
pass, so `--limit` well below what a drawing needs is how to watch it work:

```
$ node tools/brush-geometry/brush-geometry.mjs draw --limit 800
pass 1  tolerance 0.0020  73 polygons  1279 bytes
pass 2  tolerance 0.0040  49 polygons   871 bytes
pass 3  tolerance 0.0080  35 polygons   633 bytes
```

`--strokes` says how busy the drawing is; at the real 30 KB limit it takes
around a hundred strokes before the first pass overshoots. `--tolerance 0` is
the case worth keeping an eye on: a brush that keeps every point starts the
ladder at zero, and the rungs have to step onto the encoder's quantum to move at
all.

## The encoder switch

Every point in a polygon after the first is a *delta* from the one before it, so
how `makeNapVector2` quantises a delta decides how far a long polygon wanders.
`--encoder` rewrites that one expression while measuring — `truncate` for the
form that always shortens a delta, `round` for the one that doesn't — which
separates what a geometry costs from what the encoder costs. `file`, the
default, leaves `naplps.js` as it stands and says which form that is.

Nothing is written back: the rewrite happens on the source text on its way into
the `vm`.

## Adding a candidate

A function in `candidates.mjs` returning `[{ color, points }]` in the 0..1 space
the format draws in, plus a line in `CANDIDATES` at the foot of that file.
`compare` picks the table up from that list. The candidates already there are
the ones that have been weighed against what ships — one long outline of the
whole stroke (in 3D, as the code used to, and in 2D), the ribbon cut into
overlapping chunks, per-segment quads cornered with a mitre, and the two ends of
the split that `toBrushPolygons()` decides one quad at a time: `every quad split`
and `no quad split`.

## Known gaps

- The strokes are synthetic. Nothing here replays a recording of a real hand.
- `checks` covers the geometry, not the drawing mode around it: MediaPipe, the
  gestures and the wallet are all out of frame.
- The ideal brush has round joins and caps, which quads approximate with flat
  ones, so `shape` tops out below 1.0 for every candidate. It is a number to
  compare candidates by, not one to reach 1.000.

## What `loss` is for

`toBrushQuads()` lays a staggered run of quads over the plain one so that a
polygon lost between here and the Pi leaves paint behind it rather than a notch.
`loss` is that premise measured rather than assumed: it builds each stroke at 0,
1 and 2 overlap passes, throws polygons away, and reports how much of the
intended paint is still on the canvas.

It throws them away two ways, because they punish redundancy differently.
**Random** loss takes each polygon independently, which staggering covers well —
the quad over a gap is a different draw from the one that went. **Burst** loss
takes a contiguous run of the command stream, which is what a parser giving up
partway through looks like, and it is only covered if the two runs are far
enough apart in the stream. That is why the staggered run follows the plain one
whole instead of interleaving with it, and the burst column is what would show
the cost of changing that.

Over the eight strokes, a fifth of the stream lost in one burst:

| passes | polygons | bytes | paint left |
| --- | --- | --- | --- |
| 0 | 305 | 5257 | 0.802 |
| 1 | 618 | 10466 | 0.972 |
| 2 | 932 | 15684 | 0.984 |

The second pass buys much less than the first, for the same price again.
