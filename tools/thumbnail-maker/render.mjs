/*
Draws decoded NAPLPS commands to a Canvas — the command switch of
public/js/libraries/telidon/TelidonP5.js, ported off p5.js.

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

export function renderNap(napText, { width = SCREEN_W } = {}) {
  const decoded = decodeNap(napText);
  const commands = decoded.commands || [];

  const height = Math.round((width * SCREEN_H) / SCREEN_W);
  const scale = width / SCREEN_W;
  const canvas = new Canvas(width, height);

  canvas.clear([0, 0, 0]);

  const toRgb = (c) => [
    Math.max(0, Math.min(255, Math.round(c.r * 255))),
    Math.max(0, Math.min(255, Math.round(c.g * 255))),
    Math.max(0, Math.min(255, Math.round(c.b * 255))),
  ];

  // Resolve final palette (like TelidonP5 displayPaletteFor)
  let displayPalette = [];
  for (const cmd of commands) {
    if (cmd.type === "palette") {
      displayPalette = cmd.colors.map((c) => ({ r: c.r, g: c.g, b: c.b }));
    } else if (cmd.type === "setPalette") {
      displayPalette[cmd.index] = { r: cmd.r, g: cmd.g, b: cmd.b };
    }
  }

  let colorMode = 0;
  let fgIndex = 0;
  let direct = { r: 1, g: 1, b: 1 };
  const weight = Math.max(1, 1 * scale);

  const fgRgb = () => {
    const c = colorMode === 0 ? direct : (displayPalette[fgIndex] || { r: 1, g: 1, b: 1 });
    return toRgb(c);
  };

  const stats = { version: decoded.format, commands: commands.length, text: 0 };

  const toDevice = (p) => [p.x * width, height - p.y * width];

  for (const cmd of commands) {
    switch (cmd.type) {
      case "reset":
        if (cmd.screen) canvas.clear(toRgb(cmd));
        break;

      case "setColor":
        if (!cmd.transparent) direct = { r: cmd.r, g: cmd.g, b: cmd.b };
        break;

      case "selectColor":
        if (cmd.mode !== undefined) colorMode = cmd.mode;
        if (cmd.index !== undefined) fgIndex = cmd.index;
        break;

      case "text":
        stats.text++;
        break;

      case "point":
        if (cmd.draw) {
          const [x, y] = toDevice(cmd);
          canvas.stroke([[x, y], [x, y]], weight, fgRgb(), { closed: false });
        }
        break;

      case "line": {
        const a = toDevice({ x: cmd.x1, y: cmd.y1 });
        const b = toDevice({ x: cmd.x2, y: cmd.y2 });
        canvas.stroke([a, b], weight, fgRgb(), { closed: false });
        break;
      }

      case "incLine":
        for (const s of cmd.segments || []) {
          const a = toDevice({ x: s.x1, y: s.y1 });
          const b = toDevice({ x: s.x2, y: s.y2 });
          canvas.stroke([a, b], weight, fgRgb(), { closed: false });
        }
        break;

      case "rect": {
        const x0 = Math.min(cmd.x, cmd.x + cmd.w) * width;
        const x1 = Math.max(cmd.x, cmd.x + cmd.w) * width;
        const y0 = height - Math.max(cmd.y, cmd.y + cmd.h) * width;
        const y1 = height - Math.min(cmd.y, cmd.y + cmd.h) * width;
        const path = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        const col = fgRgb();
        if (cmd.filled) canvas.fill([path], col);
        else canvas.stroke(path, weight, col, { closed: true });
        break;
      }

      case "polygon": {
        if (!cmd.points || cmd.points.length < 2) break;
        const path = cmd.points.map(toDevice);
        const col = fgRgb();
        if (cmd.filled && path.length >= 3) canvas.fill([path], col);
        else canvas.stroke(path, weight, col, { closed: true });
        break;
      }

      case "arc": {
        if (!cmd.points || cmd.points.length < 2) break;
        const pts = cmd.points.map(toDevice);
        const col = fgRgb();
        if (pts.length === 2) {
          const cx = (pts[0][0] + pts[1][0]) / 2;
          const cy = (pts[0][1] + pts[1][1]) / 2;
          const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / 2;
          const path = ellipsePath(cx, cy, r, r);
          if (cmd.filled) canvas.fill([path], col);
          else canvas.stroke(path, weight, col, { closed: true });
        } else {
          if (cmd.filled && pts.length >= 3) canvas.fill([pts], col);
          else canvas.stroke(pts, weight, col, { closed: false });
        }
        break;
      }

      default:
        break;
    }
  }

  return { width, height, pixels: canvas.data, stats };
}
