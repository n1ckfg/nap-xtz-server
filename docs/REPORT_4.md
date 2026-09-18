# Client Aspect Ratio

The aspect ratio of the web client is hardcoded to **4:3 (640x480)** to natively match the legacy NAPLPS format grid. It is enforced across several different files depending on the rendering context:

### 1. Drawing Mode (Three.js)
In `public/js/drawing/drawing.js` (lines 35-37), the aspect ratio is set using a constant for the 3D drawing canvas:
```javascript
// The drawing view renders at 4:3 to match the main p5 canvas (640x480),
// centered and letterboxed within the fullscreen container.
const DRAW_ASPECT = 640 / 480;
```

### 2. Review Mode (p5.js)
In `public/index.html` (lines 70-71), the base canvas size for rendering 2D `.nap` files is set:
```javascript
let sW = 640;
let sH = 480;
```

### 3. CSS (UI Overlays)
In `public/css/main.css`, the UI layout occasionally hardcodes boundaries related to this size (e.g., width boundaries and UI positions set to `640px` to match the canvas).
