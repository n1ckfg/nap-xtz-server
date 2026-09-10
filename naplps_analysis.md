# Analysis of NAPLPS Corruption in Drawing Mode

After analyzing the codebase across `drawing.js`, `index.html`, `naplps.js`, and `app.js`, the issue causing drawn NAPLPS images to corrupt when decoded on the Raspberry Pi stems from the number of vertices generated per stroke.

## The Problem

1. **Vertex Limit in NAPLPS**: The Telidon/NAPLPS standard specifies a limit of 256 vertices (or 256 instruction bytes) for a single `POLY FILLED` (opcode 37) or `POLY OUTLINED` instruction. The Raspberry Pi's C++ decoder (`ofxTelidon` / `Pinopticon`) likely relies on a fixed-size buffer for these vertices. 
2. **Aggressive Detail in Drawing Mode**: In `public/js/drawing/drawing.js`, the `rdpSimplify` algorithm (which reduces the number of points in a stroke) is called with an extremely low tolerance parameter:
   ```javascript
   // drawing.js (line 1243)
   points2D = window.rdpSimplify(points2D, 0.002);
   ```
   Because strokes are expanded into thick closed outlines (`toBrushOutline()`) and minimally simplified (`0.002`), a single drawn stroke easily produces hundreds or thousands of vertices. When the `NapEncoder` packs these into a single polygon instruction, it massively overflows the Pi decoder's buffer, causing memory corruption and causing the file to arrive "only partially."
3. **Why SVG and Disk Files Work**: SVG paths are parsed in `public/index.html` using the exact same `NapEncoder`, but with a much higher simplification tolerance:
   ```javascript
   // index.html (line 462)
   points = rdpSimplify(points, 0.02); // default 0.005, higher = more simplification
   ```
   This higher tolerance (`0.02`) aggressively strips out points, safely keeping the vertex count per polygon under the limit, which is why SVG imports and standard files from disk decode flawlessly on the Pi.

## The Solution

To make the drawing mode work perfectly like the other sources, the simplification tolerance in `drawing.js` needs to be increased to match the proven value used by the SVG importer.

**In `public/js/drawing/drawing.js` (line 1243):**
Change the Ramer-Douglas-Peucker simplification tolerance from `0.002` to `0.02`:
```javascript
// Change this:
points2D = window.rdpSimplify(points2D, 0.002);

// To this:
points2D = window.rdpSimplify(points2D, 0.02);
```

*(Alternatively, if maintaining high fidelity in the stroke is critical, the drawing engine would need to be rewritten to explicitly chunk `points2D` into multiple `NapInputWrapper` polygons of <255 vertices each before passing them to the encoder).*
