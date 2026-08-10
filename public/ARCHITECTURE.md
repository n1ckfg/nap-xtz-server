## NAP-XTZ Architecture

The blockchain half and the drawing half are separate. **`app.js`** owns every
piece of Tezos logic — contract address, network endpoints, hex codecs,
Michelson construction, chain reads, new-token polling. The **`public/`** site
draws NAPLPS and signs transactions; it holds no chain knowledge and reaches
the backend only through `/api/*` and socket messages.

That split means the server runs headlessly: it watches the contract and hands
out drawings with no page open.

### Backend (app.js)

**Tezos section** — reads token NAPLPS bytes from the `token_metadata` bigmap
via TzKT, decodes hex to bytes, builds the `mint` entrypoint parameter, and
polls for newly minted tokens. Configured entirely from `.env` (see
`env_backup`); defaults target the Shadownet contract
`KT1DypSEV87pwiw6swdYqhDKWRBZ7xfqeS3c`.

**Messages section** — one fanout across both transports (socket.io and plain
`ws`). Drawings travel as `{ type: "naplps", source, naplps, ... }` regardless
of origin: minted on chain, POSTed to the API, or drawn live in a connected
client. New clients are handed the latest token on connect.

#### HTTP API

| Route | Purpose |
| --- | --- |
| `GET /api/config` | Wallet settings for the browser (network, RPC, size limit) |
| `GET /api/health` | Contract, latest token id, connected client counts |
| `GET /api/tezos/latest` | Latest minted drawing (`?refresh=1` to skip cache) |
| `GET /api/tezos/token/:id` | One token's NAPLPS |
| `GET /api/tezos/tokens?limit=` | Recent token ids |
| `POST /api/tezos/mint-params` | Unsigned mint operation for a wallet to sign |
| `POST /api/tezos/mint` | Headless mint (needs `TEZOS_SECRET_KEY` + Taquito) |
| `POST /api/tezos/minted` | Wallet mint went out; poll sooner |
| `POST /api/naplps` | Broadcast a drawing to all clients, no chain involved |

#### Minting

Signing is the one thing that can't move server side — a wallet key belongs to
the user. So the backend builds and validates the operation, the browser signs
it, and the backend's watcher notices the resulting token and pushes it out as
a message. For a fully headless mint, set `TEZOS_SECRET_KEY` and
`npm install @taquito/taquito @taquito/signer` to enable `POST /api/tezos/mint`.

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

**js/net/client.js** - `NapClient`, the page's only link to the backend. Knows
HTTP routes and socket messages; never contracts, TzKT, RPC, or Michelson.

**js/tezos/tezos.js** - Wallet shim, and nothing more:
- Beacon SDK wallet connection, configured from `GET /api/config`
- Signs the mint operation the backend builds
- Renders drawings pushed by the backend as they arrive

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

