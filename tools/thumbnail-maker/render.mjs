/*
Draws decoded NAPLPS commands to a Canvas — the command switch of
public/js/telidon/TelidonP5.js, ported off p5.js.

The geometry follows public/index.html: the artwork is a 640-unit square, drawn
into a 640x480 screen shifted up by (sH - sW) so the visible band is the NAPLPS
4:3 window. p5's drawing state is global, and TelidonP5 leans on that — a
noFill() from an outlined shape stays off until the next colour command — so the
same state lives here in `gfx` rather than being reset per command.

Not rendered: Shift-In text. TelidonP5 draws it with a loaded TTF; the count
comes back in `stats.text` so callers can say so.
*/
import { Canvas, arcPath, ellipsePath } from "./raster.mjs";
import { decodeNap } from "./decode.mjs";

const ART = 640; // index.html builds TelidonDraw with (sW, sW)
const SCREEN_W = 640; // index.html: sW
const SCREEN_H = 480; // index.html: sH

export function renderNap(napText, { width = SCREEN_W, verbose = false } = {}) {
  const decoder = decodeNap(napText, { verbose });

  const height = Math.round((width * SCREEN_H) / SCREEN_W);
  const scale = width / SCREEN_W;
  const yShift = SCREEN_H - SCREEN_W; // p5: translate(0, sH - sW)
  const canvas = new Canvas(width, height);

  canvas.clear([0, 0, 0]); // draw(): background(0)
  if (decoder.version === 699) canvas.clear([127, 127, 127]); // TelidonDraw.draw()

  // p5 defaults, plus TelidonDrawCmd's thickness of 1 (in artwork units).
  const gfx = {
    fill: [255, 255, 255],
    stroke: [0, 0, 0],
    weight: 1 * scale,
    ellipseMode: "CENTER", // only arcs read this back; TelidonP5 sets rectMode inline
  };
  const stats = { version: decoder.version, commands: decoder.cmds.length, text: 0 };

  const toDevice = (p) => [p.x * ART * scale, (p.y * ART + yShift) * scale];
  const onScreen = (p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

  function setColor(v) {
    gfx.fill = [v.x, v.y, v.z];
    gfx.stroke = [v.x, v.y, v.z];
  }

  function paint(path) {
    if (gfx.fill && path.length >= 3) canvas.fill([path], gfx.fill);
    if (gfx.stroke && path.length >= 1) canvas.stroke(path, gfx.weight, gfx.stroke, { closed: true });
  }

  // beginShape() ... vertex() ... endShape(CLOSE)
  function drawPoints(points, isFill) {
    if (!isFill) gfx.fill = null;
    paint(points.map(toDevice));
  }

  function drawRect(points, isFill) {
    if (!isFill) gfx.fill = null;
    if (points.length !== 2) {
      drawPoints(points, undefined); // TelidonP5 falls back without the fill flag
      return;
    }
    const [a, b] = points.map(toDevice); // p5: rectMode(CORNER), rect(x1, y1, x2 - x1, y2 - y1)
    paint([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]);
  }

  function drawArc(points, isFill) {
    if (!isFill) gfx.fill = null;
    if (points.length === 2) {
      // p5: ellipse(x1, y1, x2 - x1, x2 - x1) — a circle, negative sizes abs'd.
      gfx.ellipseMode = "CORNER";
      const [a, b] = points.map(toDevice);
      const d = Math.abs(b[0] - a[0]);
      paint(ellipsePath(a[0] + d / 2, a[1] + d / 2, d / 2, d / 2));
      return;
    }
    // p5: arc(x1, y1, x2 - x1, y2 - y1, ...) per pair, in the current ellipseMode.
    for (let i = 0; i < points.length - 1; i++) {
      const a = toDevice(points[i]);
      const b = toDevice(points[i + 1]);
      const w = b[0] - a[0];
      const h = b[1] - a[1];
      const cx = gfx.ellipseMode === "CORNER" ? a[0] + w / 2 : a[0];
      const cy = gfx.ellipseMode === "CORNER" ? a[1] + h / 2 : a[1];
      const start = (i * Math.PI) / points.length;
      const stop = ((i + 1) * Math.PI) / points.length;
      const path = arcPath(cx, cy, w / 2, h / 2, start, stop);
      // Default arc mode: filled as a pie, stroked as an open curve.
      if (gfx.fill && path.length >= 2) canvas.fill([[...path, [cx, cy]]], gfx.fill);
      if (gfx.stroke) canvas.stroke(path, gfx.weight, gfx.stroke, { closed: false });
    }
  }

  for (const cmd of decoder.cmds) {
    // TelidonDrawCmd keeps only the points that land inside the unit square.
    const points = cmd.points.filter(onScreen);

    switch (cmd.opcode.id) {
      case "Shift-In": // text mode
        stats.text++;
        break;

      case "POINT SET ABS":
      case "POINT SET REL":
      case "POINT ABS":
      case "POINT REL":
      case "LINE ABS":
      case "LINE REL":
      case "SET & LINE ABS":
      case "SET & LINE REL":
        drawPoints(points, undefined);
        break;

      case "POLY OUTLINED":
      case "SET & POLY OUTLINED":
        drawPoints(points, false);
        break;
      case "POLY FILLED":
      case "SET & POLY FILLED":
        drawPoints(points, true);
        break;

      case "ARC OUTLINED":
      case "SET & ARC OUTLINED":
        drawArc(cmd.points, false);
        break;
      case "ARC FILLED":
      case "SET & ARC FILLED":
        drawArc(cmd.points, true);
        break;

      case "RECT OUTLINED":
      case "SET & RECT OUTLINED":
        drawRect(cmd.points, false);
        break;
      case "RECT FILLED":
      case "SET & RECT FILLED":
        drawRect(cmd.points, true);
        break;

      case "SET COLOR":
      case "SELECT COLOR":
        setColor(cmd.col);
        break;

      default: // control codes and the opcodes TelidonP5 leaves as TODO
        break;
    }
  }

  return { width, height, pixels: canvas.data, stats };
}
