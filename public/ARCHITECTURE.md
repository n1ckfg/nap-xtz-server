## NAP-XTZ Architecture

### Core Components

**index.html** - Main application entry point containing:
- p5.js canvas for NAPLPS rendering
- Drag-and-drop file loading
- SVG-to-NAPLPS conversion
- Tezos wallet connection and minting UI
- "Live Drawing" button to launch 3D drawing mode

**drawing.html** - Standalone 3D drawing mode (can also be launched from index.html)

### JavaScript Modules

**js/telidon/**
- `naplps.js` - NAPLPS format encoder/decoder (no p5.js dependency)
- `TelidonP5.js` - p5.js renderer for decoded NAPLPS data
- `build/` - Split build files for modular loading

**js/tezos/tezos.js** - Tezos blockchain integration:
- Beacon SDK wallet connection
- FA2 NFT minting to Shadownet
- Contract address: `KT1DypSEV87pwiw6swdYqhDKWRBZ7xfqeS3c`

**js/drawing/** - 3D hand-tracking drawing mode (ES modules, Three.js):
- `drawing.js` - Main entry, MediaPipe gesture recognition, camera controls
- `tools.js` - Stroke and Frame classes for managing drawn lines
- `controller.js` - Hand controller wrapper with Kalman filtering
- `palette.js` - Color selection wheel
- `worldscale.js` - Two-handed scale/rotate gestures

### CSS

- `css/main.css` - Styles for index.html
- `css/drawing.css` - Styles for standalone drawing.html

## Key Patterns

### Drawing Mode Integration

Drawing mode exports `startDrawingMode(container)` and `stopDrawingMode()` for launching from index.html. The module uses `window._drawingContainer` to reference DOM elements within the active container.

---

### How It Works

1. **NAPLPS Loading**: `NaplpsReader` parses NAPLPS via `NapDecoder`, extracts all points with their associated colors into `allPoints[]`

2. **Target Following**: The `Target` class calls `naplpsReader.getNextPoint()` to traverse NAPLPS points sequentially, converting normalized coords (0-1) to shader space (-sW/2 to sW/2)

3. **Color Storage**: When target clicks a cell, the simulation shader converts the current NAPLPS RGB to hue + sat/val and stores in the B and A channels

4. **Color Propagation**: When cells trigger neighbors (KABOOM state), they inherit the triggering neighbor's color values

5. **Rendering**: The render shader converts stored hue back to RGB via `hsv2rgb()` for colored output

### Usage

- Loads default NAPLPS file on startup (`../images/output_20260222_181752.nap`)
- Drag & drop any .nap file to load
- Press any key to reset grid and pick new propagation pattern

