"use strict";

let polySimplify = null;
const polySimplifyReady = import("poly-simplify").then(m => {
    polySimplify = m.polySimplify;
});

// ─── NAPLPS byte-level helpers ───────────────────────────────────────────────

function isOpcode(charCode) {
    return (charCode & 0x40) === 0;
}

// Parse a raw NAPLPS string into an array of {opcode, data} command objects.
// opcode is the char code of the opcode byte; data is the raw substring of
// data bytes that follow it.
function parseCommands(raw) {
    const cmds = [];
    let start = -1;

    for (let i = 0; i <= raw.length; i++) {
        if (i === raw.length || isOpcode(raw.charCodeAt(i))) {
            if (start >= 0) {
                cmds.push({
                    opcode: raw.charCodeAt(start),
                    raw: raw.substring(start, i)
                });
            }
            start = i;
        }
    }
    return cmds;
}

function assembleCommands(cmds) {
    return cmds.map(c => c.raw).join("");
}

// ─── Detect domain (pointBytes) from the DOMAIN command ──────────────────────

function detectPointBytes(cmds) {
    for (const cmd of cmds) {
        if (cmd.opcode === 0x21 && cmd.raw.length > 1) {
            const dataByte = cmd.raw.charCodeAt(1);
            const bits = dataByte & 0x3F;
            const pointField = (bits >> 2) & 0x07;
            return pointField + 1;
        }
    }
    return 4;
}

// ─── Duplicate SELECT COLOR removal ──────────────────────────────────────────

function removeDuplicateColors(cmds) {
    let lastColorData = null;
    return cmds.filter(cmd => {
        if (cmd.opcode === 0x3E) {
            const colorData = cmd.raw.substring(1);
            if (colorData === lastColorData) return false;
            lastColorData = colorData;
        }
        return true;
    });
}

// ─── Point decode / encode ───────────────────────────────────────────────────

function decodeRawVector(data, offset, pointBytes) {
    const bitExponent = pointBytes * 3 - 1;
    const maxBitVals = 1 << bitExponent;

    let xBits = "";
    let yBits = "";
    let signX = 1;
    let signY = 1;

    for (let j = 0; j < pointBytes; j++) {
        const d = data.charCodeAt(offset + j) & 0x3F;
        if (j === 0) {
            signX = (d & 0x20) ? -1 : 1;
            xBits += ((d >> 4) & 1);
            xBits += ((d >> 3) & 1);
            signY = (d & 0x04) ? -1 : 1;
            yBits += ((d >> 1) & 1);
            yBits += (d & 1);
        } else {
            xBits += ((d >> 5) & 1);
            xBits += ((d >> 4) & 1);
            xBits += ((d >> 3) & 1);
            yBits += ((d >> 2) & 1);
            yBits += ((d >> 1) & 1);
            yBits += (d & 1);
        }
    }

    const xMag = parseInt(xBits, 2);
    const yMag = parseInt(yBits, 2);

    return {
        x: (xMag / maxBitVals) * signX,
        y: ((maxBitVals - yMag) / maxBitVals) * signY
    };
}

function decodePolyPoints(data, pointBytes, allRelative) {
    const points = [];

    for (let i = 0; i + pointBytes <= data.length; i += pointBytes) {
        const nv = decodeRawVector(data, i, pointBytes);

        if (points.length === 0 && !allRelative) {
            points.push({ x: nv.x, y: nv.y });
        } else {
            const p = points[points.length - 1];
            let x = Math.abs(nv.x) + Math.abs(p.x);
            if (nv.x < 0) x -= 1;
            let y = Math.abs(nv.y) + Math.abs(p.y);
            if (nv.y >= 0) y -= 1;
            points.push({ x, y });
        }
    }
    return points;
}

function encodeVectorBytes(x, y, pointBytes) {
    const bitExponent = pointBytes * 3 - 1;
    const maxBitVals = 1 << bitExponent;

    const sx = (x >= 0 && !Object.is(x, -0)) ? 0 : 1;
    const sy = (y >= 0 && !Object.is(y, -0)) ? 0 : 1;

    const intX = Math.min(maxBitVals - 1, Math.round(Math.abs(x) * maxBitVals));
    const intY = Math.min(maxBitVals - 1, Math.round(Math.abs(y) * maxBitVals));

    const binX = intX.toString(2).padStart(bitExponent, "0");
    const binY = intY.toString(2).padStart(bitExponent, "0");

    let result = "";
    let xi = 0, yi = 0;

    for (let i = 0; i < pointBytes; i++) {
        let b = 0x40;
        if (i === 0) {
            b |= (sx << 5);
            b |= (parseInt(binX[xi++]) << 4);
            b |= (parseInt(binX[xi++]) << 3);
            b |= (sy << 2);
            b |= (parseInt(binY[yi++]) << 1);
            b |= parseInt(binY[yi++]);
        } else {
            b |= (parseInt(binX[xi++]) << 5);
            b |= (parseInt(binX[xi++]) << 4);
            b |= (parseInt(binX[xi++]) << 3);
            b |= (parseInt(binY[yi++]) << 2);
            b |= (parseInt(binY[yi++]) << 1);
            b |= parseInt(binY[yi++]);
        }
        result += String.fromCharCode(b);
    }
    return result;
}

function encodePolyData(screenPoints, pointBytes) {
    const flipped = screenPoints.map(p => ({ x: p.x, y: 1.0 - p.y }));
    let result = "";
    let prev = null;

    for (let i = 0; i < flipped.length; i++) {
        const p = flipped[i];
        if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue;

        let vx, vy;
        if (prev === null) {
            vx = p.x;
            vy = p.y;
        } else {
            vx = Math.abs(p.x) - Math.abs(prev.x);
            if (p.x < prev.x) vx = Math.abs(vx) - 1;

            vy = Math.abs(p.y) - Math.abs(prev.y);
            if (p.y < prev.y) {
                vy = Math.abs(vy) - 1;
                if (vy === 0) vy = -0;
            }
        }

        result += encodeVectorBytes(vx, vy, pointBytes);
        prev = p;
    }
    return result;
}

// ─── Polygon opcodes ─────────────────────────────────────────────────────────

const POLY_OPCODES = new Set([0x34, 0x35, 0x36, 0x37]);
const POLY_ALL_RELATIVE = new Set([0x34, 0x35]);

function isPolyCmd(opcode) {
    return POLY_OPCODES.has(opcode);
}

function removeDegeneratePolygons(cmds, pointBytes) {
    const minDataBytes = pointBytes * 3;
    const removed = new Set();
    for (let i = 0; i < cmds.length; i++) {
        if (isPolyCmd(cmds[i].opcode) && cmds[i].raw.length - 1 < minDataBytes) {
            removed.add(i);
            if (i > 0 && cmds[i - 1].opcode === 0x3E) {
                removed.add(i - 1);
            }
        }
    }
    if (removed.size === 0) return cmds;
    return removeDuplicateColors(cmds.filter((_, i) => !removed.has(i)));
}

// ─── Simplify one set of commands at a given poly-simplify quality ───────────

function simplifyAtQuality(cmds, pointBytes, quality) {
    return cmds.map(cmd => {
        if (!isPolyCmd(cmd.opcode)) return cmd;

        const data = cmd.raw.substring(1);
        if (data.length < pointBytes * 2) return cmd;

        const allRel = POLY_ALL_RELATIVE.has(cmd.opcode);
        const absPoints = decodePolyPoints(data, pointBytes, allRel);
        if (absPoints.length < 3) return cmd;

        let simplified;
        try {
            simplified = polySimplify(absPoints, { quality, RC: false });
        } catch (_) {
            return cmd;
        }
        if (simplified.length < 2) return cmd;

        const newData = encodePolyData(simplified, pointBytes);
        return {
            opcode: cmd.opcode,
            raw: cmd.raw[0] + newData
        };
    });
}

// ─── Strategy C: drop smallest polygons ─────────────────────────────────────

function dropSmallestPolygons(cmds, maxBytes) {
    const polys = [];
    for (let i = 0; i < cmds.length; i++) {
        if (isPolyCmd(cmds[i].opcode)) {
            polys.push({ index: i, size: cmds[i].raw.length });
        }
    }
    polys.sort((a, b) => a.size - b.size);

    let totalSize = cmds.reduce((s, c) => s + c.raw.length, 0);
    const removed = new Set();

    for (const p of polys) {
        if (totalSize <= maxBytes) break;
        removed.add(p.index);
        totalSize -= p.size;
        if (p.index > 0 && cmds[p.index - 1].opcode === 0x3E && !removed.has(p.index - 1)) {
            removed.add(p.index - 1);
            totalSize -= cmds[p.index - 1].raw.length;
        }
    }

    if (removed.size === 0) return cmds;
    return removeDuplicateColors(cmds.filter((_, i) => !removed.has(i)));
}

// ─── Strategy B: domain downgrade ───────────────────────────────────────────

const GEO_OPCODES = new Set([
    0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x2B,
    0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x32, 0x33,
    0x34, 0x35, 0x36, 0x37, 0x38
]);

function reencodeRawPoint(data, offset, oldPB, newPB) {
    const oldBitExp = oldPB * 3 - 1;
    const newBitExp = newPB * 3 - 1;
    let xBits = "", yBits = "";
    let signX, signY;

    for (let j = 0; j < oldPB; j++) {
        const d = data.charCodeAt(offset + j) & 0x3F;
        if (j === 0) {
            signX = (d >> 5) & 1;
            xBits += ((d >> 4) & 1);
            xBits += ((d >> 3) & 1);
            signY = (d >> 2) & 1;
            yBits += ((d >> 1) & 1);
            yBits += (d & 1);
        } else {
            xBits += ((d >> 5) & 1);
            xBits += ((d >> 4) & 1);
            xBits += ((d >> 3) & 1);
            yBits += ((d >> 2) & 1);
            yBits += ((d >> 1) & 1);
            yBits += (d & 1);
        }
    }

    const xMag = parseInt(xBits, 2);
    const yMag = parseInt(yBits, 2);
    const oldMax = (1 << oldBitExp) - 1;
    const newMax = (1 << newBitExp) - 1;
    const newXMag = Math.min(newMax, Math.round(xMag * newMax / oldMax));
    const newYMag = Math.min(newMax, Math.round(yMag * newMax / oldMax));
    const binX = newXMag.toString(2).padStart(newBitExp, "0");
    const binY = newYMag.toString(2).padStart(newBitExp, "0");

    let result = "";
    let xi = 0, yi = 0;
    for (let i = 0; i < newPB; i++) {
        let b = 0x40;
        if (i === 0) {
            b |= (signX << 5);
            b |= (parseInt(binX[xi++]) << 4);
            b |= (parseInt(binX[xi++]) << 3);
            b |= (signY << 2);
            b |= (parseInt(binY[yi++]) << 1);
            b |= parseInt(binY[yi++]);
        } else {
            b |= (parseInt(binX[xi++]) << 5);
            b |= (parseInt(binX[xi++]) << 4);
            b |= (parseInt(binX[xi++]) << 3);
            b |= (parseInt(binY[yi++]) << 2);
            b |= (parseInt(binY[yi++]) << 1);
            b |= parseInt(binY[yi++]);
        }
        result += String.fromCharCode(b);
    }
    return result;
}

function downgradeDomain(cmds, oldPB, newPB) {
    return cmds.map(cmd => {
        if (cmd.opcode === 0x21 && cmd.raw.length > 1) {
            const bits = cmd.raw.charCodeAt(1) & 0x3F;
            const newBits = (bits & ~0x1C) | (((newPB - 1) & 0x07) << 2);
            return {
                opcode: cmd.opcode,
                raw: cmd.raw[0] + String.fromCharCode(0x40 | newBits) + cmd.raw.substring(2)
            };
        }
        if (GEO_OPCODES.has(cmd.opcode)) {
            const data = cmd.raw.substring(1);
            if (data.length < oldPB) return cmd;
            let newData = "";
            for (let i = 0; i + oldPB <= data.length; i += oldPB) {
                newData += reencodeRawPoint(data, i, oldPB, newPB);
            }
            return { opcode: cmd.opcode, raw: cmd.raw[0] + newData };
        }
        return cmd;
    });
}

// ─── Strategy A: maxPoints budget ───────────────────────────────────────────

function applyMaxPointsBudget(cmds, pointBytes, maxBytes) {
    let nonPolyBytes = 0;
    const polyInfos = [];

    for (let i = 0; i < cmds.length; i++) {
        if (isPolyCmd(cmds[i].opcode)) {
            polyInfos.push({ index: i, points: Math.floor((cmds[i].raw.length - 1) / pointBytes) });
        } else {
            nonPolyBytes += cmds[i].raw.length;
        }
    }

    if (polyInfos.length === 0) return cmds;

    const totalPoints = polyInfos.reduce((s, p) => s + p.points, 0);
    const availForPoints = maxBytes - nonPolyBytes - polyInfos.length;
    const maxTotalPoints = Math.floor(availForPoints / pointBytes);

    if (maxTotalPoints >= totalPoints) return cmds;

    const ratio = Math.max(0, maxTotalPoints / totalPoints);

    return cmds.map(cmd => {
        if (!isPolyCmd(cmd.opcode)) return cmd;

        const data = cmd.raw.substring(1);
        const numPoints = Math.floor(data.length / pointBytes);
        const budget = Math.max(2, Math.floor(numPoints * ratio));
        if (budget >= numPoints) return cmd;

        const allRel = POLY_ALL_RELATIVE.has(cmd.opcode);
        const absPoints = decodePolyPoints(data, pointBytes, allRel);
        if (absPoints.length <= budget) return cmd;

        const sampled = [absPoints[0]];
        const step = (absPoints.length - 1) / (budget - 1);
        for (let j = 1; j < budget - 1; j++) {
            sampled.push(absPoints[Math.round(j * step)]);
        }
        sampled.push(absPoints[absPoints.length - 1]);

        const newData = encodePolyData(sampled, pointBytes);
        return { opcode: cmd.opcode, raw: cmd.raw[0] + newData };
    });
}

// ─── Main entry point ────────────────────────────────────────────────────────

async function simplifyNaplps(napRaw, maxBytes) {
    await polySimplifyReady;
    let cmds = parseCommands(napRaw);
    let pointBytes = detectPointBytes(cmds);

    // Step 1: remove duplicate SELECT COLOR commands and degenerate polygons.
    cmds = removeDuplicateColors(cmds);
    cmds = removeDegeneratePolygons(cmds, pointBytes);
    let result = assembleCommands(cmds);
    if (result.length <= maxBytes) {
        return { naplps: result, method: "dedup", quality: null };
    }

    // Step 2: poly-simplify with quality ladder.
    const original = cmds;

    /*
    // Phase A: coarse search, decrement by 0.2 from 0.8.
    let bestQuality = null;
    for (let q = 0.8; q >= 0.2; q -= 0.2) {
        q = Math.round(q * 100) / 100;
        const s = simplifyAtQuality(original, pointBytes, q);
        result = assembleCommands(s);
        if (result.length <= maxBytes) {
            bestQuality = q;
            break;
        }
    }

    if (bestQuality === null) {
        const s = simplifyAtQuality(original, pointBytes, 0.05);
        result = assembleCommands(s);
        if (result.length <= maxBytes) {
            bestQuality = 0.05;
        }
    }

    if (bestQuality !== null) {
        // Phase B: refine upward by 0.05.
        let ceiling = bestQuality;
        for (let q = bestQuality + 0.05; q <= 1.0; q += 0.05) {
            q = Math.round(q * 100) / 100;
            const s = simplifyAtQuality(original, pointBytes, q);
            const r = assembleCommands(s);
            if (r.length > maxBytes) break;
            ceiling = q;
            result = r;
        }

        // Phase C: fine-tune downward by 0.01.
        for (let q = ceiling; q >= 0.01; q -= 0.01) {
            q = Math.round(q * 100) / 100;
            const s = simplifyAtQuality(original, pointBytes, q);
            const r = assembleCommands(s);
            if (r.length <= maxBytes) {
                return { naplps: r, method: "simplify", quality: q };
            }
        }
    }
    */

    // Quality ladder exhausted. Apply aggressive strategies C → B → A.
    let working = simplifyAtQuality(original, pointBytes, 0.8); //0.01);
    result = assembleCommands(working);

    // Strategy C: drop smallest polygons first.
    if (result.length > maxBytes) {
        working = dropSmallestPolygons(working, maxBytes);
        result = assembleCommands(working);
        if (result.length <= maxBytes) {
            return { naplps: result, method: "drop-small", quality: 0.01 };
        }
    }

    // Strategy A: enforce a per-polygon maxPoints budget.
    if (result.length > maxBytes) {
        working = applyMaxPointsBudget(working, pointBytes, maxBytes);
        result = assembleCommands(working);
        if (result.length <= maxBytes) {
            return { naplps: result, method: "maxpoints", quality: 0.01 };
        }
    }

    // Strategy B: domain downgrade (e.g. 4-byte → 3-byte points).
    if (result.length > maxBytes && pointBytes > 1) {
        const newPB = pointBytes - 1;
        working = downgradeDomain(working, pointBytes, newPB);
        pointBytes = newPB;
        result = assembleCommands(working);
    }

    return { naplps: result, method: "domain-downgrade", quality: 0.01 };
}

module.exports = { simplifyNaplps };
