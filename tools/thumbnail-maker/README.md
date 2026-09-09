# thumbnail-maker

Renders NAPLPS `.nap` files to PNG screenshots from the command line, so the
`.nap` files in `public/images` (or anything minted on-chain) can be previewed
without opening a browser.

```
node tools/thumbnail-maker/nap-thumbnail.mjs public/images
node tools/thumbnail-maker/nap-thumbnail.mjs -w 320 -o thumbs public/images/*.nap
node tools/thumbnail-maker/nap-thumbnail.mjs drawing.nap        # -> drawing.png
```

Each input becomes a `.png` of the same basename, written beside the `.nap`
unless `--out` names a directory. Existing files are overwritten.

| Option | |
| --- | --- |
| `-o, --out <dir>` | write PNGs to `<dir>` instead of beside the source |
| `-w, --width <px>` | output width; height follows the 4:3 screen (default 640) |
| `-v, --verbose` | let the decoder's own per-point logging through to stderr |
| `-h, --help` | usage |

Directories are read one level deep for `*.nap`; shell globs work too.

## How it renders

`decode.mjs` runs `public/js/telidon/naplps.js` — the decoder the web client
uses, unmodified — in a `vm` context, supplying the two p5 globals it reaches
for (`pow`, `int`) and the `window` it exports its classes onto. Nothing is
duplicated here, so a fix to the decoder reaches this tool for free.

`render.mjs` is a port of the drawing switch in `TelidonP5.js` onto `raster.mjs`,
a small anti-aliased scanline rasteriser, with the framing `public/index.html`
uses: a 640-unit square artwork drawn into a 640x480 screen shifted up by
`sH - sW`, black background (grey for Telidon 699 files), 1px strokes. The state
p5 keeps globally — notably that `noFill()` from an outlined shape stays off
until the next colour command — is kept the same way here, so the output matches
what the page shows.

There are no dependencies: `raster.mjs` fills paths (nonzero winding, four
sub-scanlines per row) and `png.mjs` writes the file with `node:zlib`.

## Known gaps

- **Text is not drawn.** `Shift-In` commands are counted and reported per file;
  drawing them would mean rasterising the Telidon TTF that the browser loads.
- The opcodes `TelidonP5.js` still lists as TODO (`TEXTURE`, `FIELD`, the
  `INCREMENTAL` family, `WAIT`, `BLINK`) are no-ops here as well.
- Arcs follow p5's default mode — filled as a pie, stroked as an open curve.
  They are absent from the current `public/images` corpus, so this path is
  untested against the browser.
