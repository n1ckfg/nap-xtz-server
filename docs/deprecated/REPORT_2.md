# Polygons still going missing on the Pi

2026-09-12

> **Inconclusive.** The cause was not found. This note records what was
> eliminated and with what evidence, so the next attempt starts further along
> than this one did. Two earlier notes in this folder each reached a confident
> conclusion and one of them was wrong; the point of writing this one up without
> an answer is to avoid adding a third.

Sections of a drawing arrive on the Raspberry Pi missing. Three facts about the
symptom, from watching it happen rather than from the code:

- **Only live drawings.** The `.nap` files in `public/images` play cleanly.
- **The browser is correct and the Pi is not**, from the same bytes.
- **Chunks go missing inside strokes** — not whole strokes, not a truncated tail.

The middle fact is the strongest constraint: if the same byte stream renders
correctly in one place and not the other, the encoder and the geometry are not at
fault, and the divergence is somewhere in the C++ decode or render path.

## What it is not

Each of these was checked against the real sources — `ofxNaplps` at
`~/Development/openFrameworks/of_v0.12.1_osx_release/addons/ofxNaplps`, which is
what the Pi actually runs — rather than reasoned about.

| Theory | Why not |
| --- | --- |
| Transport truncation | `MAX_NAP_BYTES` and `kMaxFrameBytes` are both 1 MB, on both ends. Live payloads are 5–27 KB. |
| Progressive draw running out of time | `TelidonDrawCmd` is a per-command class with its own `pointsIndex` and `markTime`, so commands reveal *in parallel*. At `progressiveDrawInterval = 66` the reveal is bounded by the longest polygon — ≤6 points, ≈400 ms — not by polygon count. |
| The 30 s dead man's switch | `slideTimeout` fires on *silence*, starting the fallback slideshow. It does not interrupt a drawing that is arriving. |
| Uneven operand bytes | `Naplps.cpp:718` drops a whole command when `data.size() % pointBytes != 0`. Measured across live output: **0** such commands. |
| Points decoding outside the unit square | **0** in live output. See below — this one is worth more than a table row. |
| Command segmentation | `isOpcode` agrees: the JS `binary(new Char(c))` takes a `bit = 16` branch, making `b[b.length-7]` bit 6, which is what the C++ `(c >> 6) & 1` tests. Byte-value sets are identical between working and failing files — 14..127, 72 distinct values, same low bytes (14, 24, 27, 31). |
| `finished` aggregation stopping the repaint early | `TelidonDraw::update()` sets `finished = true` then ANDs across every command. Correct, and identical to the JS. |
| Coordinate bit extraction | Both sides build a 7-character `binary` string and read offsets 1–3 for x, 4–6 for y, with `bitsPerByte = 3` and `bitVals = 2^11 = 2048`. `setPoints` is line-for-line the same arithmetic in both. |
| Colour state | Both capture `col` at parse time and advance a shared render state as each SELECT COLOR is drawn, resetting per frame. Structurally identical. |

## Two results that contradict the earlier notes

**Off-frame points are normal, not the fault.** `naplps_analysis_2.md` blames
points whose decoded position leaves the unit square, which both renderers drop.
But the files that play *cleanly* on the Pi are full of them, and the failing
ones have none:

| file | decoded points outside the frame |
| --- | --- |
| live drawing mode | **0** |
| `output_20260222_181056.nap` | 290 |
| `output_20260222_181107.nap` | 503 |
| `output_20260222_181140.nap` | 815 |

**The geometry did not get more exotic.** Live drawings emit only 3- and
4-point polygons (`3:32  4:294`). The slideshow files that work carry polygons of
2 to 181 points. Whatever the Pi is failing on, it is not a shape it has never
been asked to draw.

## The one real divergence found

`Telidon.cpp:240`, in `TelidonDrawCmd::styleShape()`:

```cpp
//path.setPolyWindingMode(OF_POLY_WINDING_NONZERO);
```

Commented out, so the Pi fills with `ofPath`'s default — **even-odd** — where the
browser's `endShape(CLOSE)` fills **nonzero**. This is exactly the divergence
`ARCHITECTURE.md` says the triangle-splitting in `toBrushPolygons()` guards
against, and the guard on the Pi side is switched off.

It is real and apparently long-unnoticed: `output_20260222_181056.nap` contains
**163 self-crossing polygons**, which fill differently under the two rules. It is
nevertheless *not* the cause of missing chunks, because live drawing-mode output
contains **zero** self-crossing polygons (`crossings 0`, `rule-agree 1.000` across
the harness corpus). Worth uncommenting regardless.

## What changed in the encoder alongside this

Separate work, requested separately, but it touches the same output and one part
of it bears directly on this fault.

The brush now projects the polyline first and regenerates polygons in 2D as
trapezoids plus corner fans and round caps; the per-stroke z-offset that stops
the 3D preview z-fighting no longer moves the encoded artwork (it was displacing
it 3.4 px by the fortieth stroke and 16.7 px by the eightieth); and the byte
budget is spent on the centreline first, buying the overlap run only with what is
left. Against the ideal brush that took the corpus from 0.861 to 0.949, and a
hairpin from 0.643 to 0.963.

Two honest qualifications:

- **The exact corners are worth almost nothing on average.** Fans and caps are
  0.4–4.9% of emitted pieces, because the sagitta guard skips them wherever a
  vertex turns only a degree or two. At equal tolerance the rebuilt geometry
  scores 0.858 where the old blunt corners scored 0.861. The fidelity gain came
  from the tolerance, not the corner shapes.
- **Busy drawings now go without the cover run**, which is the mitigation that
  was helping this fault. A hundred strokes used to be thinned to a tolerance of
  0.016 while still paying for the cover run; they now land at 0.004 without it.
  Over the corpus, a fifth of the stream lost in one burst leaves 0.774 of the
  paint with no cover run and 0.983 with one. **This change probably made the Pi
  symptom worse**, and the fix below addresses that directly.

## Instrumentation added

Every analysis in this note ran against bytes the harness synthesised, which come
back clean on every measure. The real artifact was never captured, and that is
the gap.

- **`RPI_CAPTURE_DIR`** (`app.js`) writes a copy of every drawing on its way to
  the Pi, named by timestamp and source. Off unless set.
- **`brush-geometry inspect <file ...>`** reports what a `.nap` file actually
  contains: opcode counts, points per polygon, operand alignment, off-frame
  points, and self-crossing polygons. Comparing a captured drawing against one
  from `public/images` is the intended use — those are the files known to play
  cleanly, so a column where the two differ is a column worth chasing.

## What to try next

**The Pi's budget is not the chain's.** `RPI_MAX_BYTES` is ~1 MB; the mint limit
is 30 KB. One encoding currently serves the canvas, the Pi and the mint, so the
Pi's copy is squeezed by a limit that does not apply to it. Encoding twice — the
Pi getting the finest tolerance with two cover passes under its own budget, the
mint getting the fitted one — restores and doubles the redundancy at no cost to
mint fidelity. This is the change most likely to help whatever the root cause
turns out to be.

**Two things that need the hardware.** Uncomment `naplps.setVerbose(true)` at
`PiNaplpsPlayer/src/ofApp.cpp:79` and reproduce: the log names every command and
point, and prints `*Error* <opcode> contains no coordinates` for anything
dropped. And set `RPI_CAPTURE_DIR`, so the drawing that actually failed can be
read back with `inspect` instead of reconstructed.

## Loose ends

- **The C++ encoder still truncates.** `Naplps.cpp:1199` writes
  `(int)(fabs(input.x) * maxBitVals)` where `naplps.js:1503` rounds. It only
  matters if `ofxNaplps` is used to *write* files, so it is not this fault — but
  it is the same bug `naplps_analysis_2.md` fixed on the JS side, still open on
  the C++ side.
- **The all-relative cursor branch is untested in both.** `setPoints`'s
  `allPointsRelative && i == 0` path carries `// TODO find something to test this`
  in the C++ and the same gap in the JS. Live drawings use `SET & POLY FILLED`,
  which does not take it, so it is not implicated — but nothing exercises it.
- ~~**Live drawings emit far fewer colour commands than the working files**: 4
  SELECT COLOR for 326 polygons, against one per polygon in every `public/images`
  file checked.~~ **Closed** — `makeNapStroke()` now emits a SELECT COLOR in
  front of every POLY rather than skipping it when the colour hasn't moved, so
  both kinds of input produce the same command stream: the four-stroke harness
  drawing went from 4 SELECT COLOR for 326 polygons to 326 for 326, matching the
  files that play cleanly. The colour state machines already matched on both
  sides, so this was never demonstrated to be the fault — it was the sharpest
  structural difference between the two kinds of file, and it is now not a
  difference at all. It costs five bytes a polygon, which the byte ladder takes
  out of the cover run first: the four-stroke sketch still keeps both (5,452 →
  7,062 bytes), while a hundred strokes settle a rung coarser (0.004 → 0.008).
  It also makes a lost colour command cheap, where losing the one command at the
  head of a stroke used to mis-colour every polygon after it.
