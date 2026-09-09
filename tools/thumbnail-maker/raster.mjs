/*
A small anti-aliased software rasteriser — just enough of a 2D canvas to stand
in for the browser's while rendering NAPLPS off-screen.

Paths are filled with the nonzero winding rule (what canvas does): four
sub-scanlines per pixel row give vertical coverage, and spans are accumulated
with fractional endpoints for horizontal coverage. Strokes become filled quads
plus round joins/caps, all filled as one nonzero path so overlapping segments
composite once instead of twice — which is what a canvas stroke looks like.
*/

const SUBSAMPLES = 4;

export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 3);
    this._cov = new Float32Array(width);
  }

  clear([r, g, b]) {
    for (let i = 0; i < this.data.length; i += 3) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
    }
  }

  // paths: array of subpaths, each an array of [x, y] in device pixels.
  fill(paths, color) {
    const edges = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const path of paths) {
      if (path.length < 3) continue;
      for (let i = 0; i < path.length; i++) {
        const [ax, ay] = path[i];
        const [bx, by] = path[(i + 1) % path.length];
        if (ax < minX) minX = ax;
        if (ax > maxX) maxX = ax;
        if (ay < minY) minY = ay;
        if (ay > maxY) maxY = ay;
        if (ay === by || !Number.isFinite(ax + ay + bx + by)) continue;
        edges.push({
          x0: ax,
          y0: ay,
          slope: (bx - ax) / (by - ay),
          ymin: Math.min(ay, by),
          ymax: Math.max(ay, by),
          dir: by > ay ? 1 : -1,
        });
      }
    }
    if (edges.length === 0) return;

    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(this.height - 1, Math.ceil(maxY));
    const xStart = Math.max(0, Math.floor(minX));
    const xEnd = Math.min(this.width - 1, Math.ceil(maxX));
    if (yStart > yEnd || xStart > xEnd) return;

    edges.sort((a, b) => a.ymin - b.ymin);

    const cov = this._cov;
    const crossings = [];
    let pending = 0;
    let active = [];

    for (let y = yStart; y <= yEnd; y++) {
      while (pending < edges.length && edges[pending].ymin < y + 1) active.push(edges[pending++]);
      active = active.filter((e) => e.ymax > y);
      if (active.length === 0) {
        if (pending >= edges.length) break;
        continue;
      }

      cov.fill(0, xStart, xEnd + 1);
      for (let s = 0; s < SUBSAMPLES; s++) {
        const yc = y + (s + 0.5) / SUBSAMPLES;
        crossings.length = 0;
        for (const e of active) {
          if (yc < e.ymin || yc >= e.ymax) continue;
          crossings.push({ x: e.x0 + (yc - e.y0) * e.slope, dir: e.dir });
        }
        if (crossings.length < 2) continue;
        crossings.sort((a, b) => a.x - b.x);

        let winding = 0;
        let spanStart = 0;
        for (const c of crossings) {
          const before = winding;
          winding += c.dir;
          if (before === 0 && winding !== 0) spanStart = c.x;
          else if (before !== 0 && winding === 0) this._addSpan(spanStart, c.x, 1 / SUBSAMPLES, xStart, xEnd);
        }
      }
      this._blendRow(y, xStart, xEnd, color);
    }
  }

  _addSpan(xa, xb, amount, xStart, xEnd) {
    const a = Math.max(xa, xStart);
    const b = Math.min(xb, xEnd + 1);
    if (b <= a) return;

    const cov = this._cov;
    const first = Math.floor(a);
    const last = Math.floor(b);
    if (first === last) {
      cov[first] += (b - a) * amount;
      return;
    }
    cov[first] += (first + 1 - a) * amount;
    for (let x = first + 1; x < last; x++) cov[x] += amount;
    if (last <= xEnd) cov[last] += (b - last) * amount;
  }

  _blendRow(y, xStart, xEnd, [r, g, b]) {
    const { data, _cov: cov } = this;
    let i = (y * this.width + xStart) * 3;
    for (let x = xStart; x <= xEnd; x++, i += 3) {
      let c = cov[x];
      if (c <= 0.002) continue;
      if (c > 1) c = 1;
      data[i] += (r - data[i]) * c;
      data[i + 1] += (g - data[i + 1]) * c;
      data[i + 2] += (b - data[i + 2]) * c;
    }
  }

  // p5 defaults: round caps, and joins close enough to round at these widths.
  stroke(points, width, color, { closed = false } = {}) {
    const radius = Math.max(width, 0.01) / 2;
    const pts = [];
    for (const p of points) {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
    if (closed && pts.length > 1) {
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) pts.pop();
    }
    if (pts.length === 0) return;

    const polys = [];
    if (pts.length === 1) {
      polys.push(circlePath(pts[0][0], pts[0][1], radius));
    } else {
      const segments = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segments; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        const nx = (-dy / len) * radius;
        const ny = (dx / len) * radius;
        polys.push([
          [a[0] + nx, a[1] + ny],
          [b[0] + nx, b[1] + ny],
          [b[0] - nx, b[1] - ny],
          [a[0] - nx, a[1] - ny],
        ]);
      }
      // A disc at every vertex serves as both the join and the end cap.
      for (const p of pts) polys.push(circlePath(p[0], p[1], radius));
    }

    this.fill(polys.map(counterClockwise), color);
  }
}

function counterClockwise(poly) {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  return area < 0 ? [...poly].reverse() : poly;
}

function segmentsFor(radius) {
  return Math.max(8, Math.min(256, Math.ceil(radius * 2)));
}

export function circlePath(cx, cy, r) {
  return ellipsePath(cx, cy, r, r);
}

export function ellipsePath(cx, cy, rx, ry) {
  const n = segmentsFor(Math.max(Math.abs(rx), Math.abs(ry)));
  const path = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    path.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return path;
}

// Angles run clockwise on screen, as in canvas/p5 (y points down).
export function arcPath(cx, cy, rx, ry, start, stop) {
  const n = Math.max(2, Math.ceil((segmentsFor(Math.max(Math.abs(rx), Math.abs(ry))) * Math.abs(stop - start)) / (Math.PI * 2)));
  const path = [];
  for (let i = 0; i <= n; i++) {
    const a = start + ((stop - start) * i) / n;
    path.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return path;
}
