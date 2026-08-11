# NAP-XTZ Server Architecture

NAP-XTZ is a collaborative, web-based drawing platform that bridges the 1980s Telidon/NAPLPS vector graphics format with the Tezos blockchain. 

The architecture strictly separates the **backend (blockchain synchronization & broadcasting)** from the **frontend (drawing, rendering, and wallet signing)**.

## High-Level Separation of Concerns

- **Backend (`app.js`)**: Owns all Tezos interactions (except transaction signing). It is responsible for contract addresses, network endpoints, Michelson payload construction, chain reads, and polling for new tokens via the TzKT API. It acts as a headless server that can broadcast new drawings via WebSockets to connected clients without needing a browser open. It also owns the outbound links to other machines — a peer nap-xtz server and a Raspberry Pi — so the frontend never needs to know their addresses.
- **Frontend (`public/`)**: A static web client that renders NAPLPS art using p5.js and provides a 3D hand-tracking live drawing mode using MediaPipe and Three.js. It holds no direct blockchain-reading logic and relies on the backend's `/api/*` and WebSocket messages. For minting, the frontend connects to the user's Tezos wallet (via Beacon SDK) to sign the transaction payloads constructed by the backend.

---

## Backend (`app.js`)

The Node.js backend handles HTTP requests (Express) and real-time communication (Socket.IO + ws). 

### Key Responsibilities

1. **Tezos Chain Watcher**: Polls the smart contract's `token_metadata` bigmap (defaulting to the Shadownet contract) using the TzKT API. Decodes hex payloads into NAPLPS bytes and broadcasts new tokens to all connected clients.
2. **Message Broker**: Manages a unified fanout system across `socket.io` and raw `ws` connections. Drawings travel as JSON messages (`{ type: "naplps", source, naplps, ... }`) whether they are minted on-chain, posted via the REST API, or drawn live.
3. **Transaction Preparation**: Builds the `mint` entrypoint Michelson parameter payload to hand off to the frontend for signing.
4. **Headless Minting (Optional)**: If `TEZOS_SECRET_KEY` is provided in `.env`, the server can sign and submit mint operations directly using `@taquito/taquito`.
5. **Outbound Server Links (Optional)**: Connects as a client to a peer nap-xtz server and to a Raspberry Pi. Both are off unless configured, so the server still runs on its own.

### Outbound Server Links

Where the `ws`/`socket.io` servers above accept connections, these two are connections the backend *opens*. Both reconnect on their own if the far end goes away.

**Peer server** (`PEER_WS_URL`, e.g. `ws://other-host:8090`) — links two installations so they share drawings. Anything this server broadcasts is forwarded to the peer, and anything the peer sends is broadcast to local clients tagged `source: "peer"`.

Every message carries a `mid` (server id + counter) and each server remembers the last 500 it has handled. Without that, two servers each pointed at the other would hand the same drawing back and forth forever, since a message arriving from a peer is indistinguishable from any other client's. The id also means a drawing is delivered once rather than once per path.

**Raspberry Pi** (`RPI_HOST`, e.g. `nfg-rpi-3-4.local`) — a Pi running Pinopticon (openFrameworks / ofxHTTP). Traffic runs both ways:

- *In*: camera and vision frames (`photo`, `photo_saved`, `video`, `blob`, `pixel`, `contour`) are relayed to connected clients as `{ type: "rpi", source: "rpi", event, ... }`. The Pi's own frame type becomes `event`, since `type` names the transport.
- *Out*: NAPLPS drawings, and the two commands the Pi acts on (`take_photo`, `stream_photo`).

`rpi-client.js` holds the connection and the protocol's quirks — notably that sending a websocket PING frame drops the connection, so liveness is TCP-level keepalive instead. `RPI_NAPLPS_FORMAT` selects how a drawing is framed for the Pi: `json` (default), `base64`, or `raw`.

Note that drawings bound for the Pi are checked against `RPI_MAX_BYTES` (default ~1 MB), not the ~30 KB Tezos limit — a drawing sent to the Pi isn't going into a mint operation, and many of the slideshow's `.nap` files are larger than a token can hold.

### HTTP API Endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/config` | Wallet settings for the browser (network, RPC, size limits) |
| `GET /api/health` | Status check, latest token id, connected client counts |
| `GET /api/tezos/latest` | Fetch the latest minted drawing on-chain |
| `GET /api/tezos/token/:id` | Fetch a specific token's NAPLPS bytes |
| `GET /api/tezos/tokens?limit=` | Fetch recent token ids |
| `POST /api/tezos/mint-params` | Generates the unsigned mint operation for a browser wallet to sign |
| `POST /api/tezos/mint` | Headless server-side mint (requires `TEZOS_SECRET_KEY` and Taquito) |
| `POST /api/tezos/minted` | Notification from client that a wallet mint was broadcast; accelerates polling |
| `POST /api/naplps` | Broadcasts a drawing to all connected clients (no chain involved) |
| `GET /api/rpi/status` | Whether a Pi is configured, and whether it is currently connected |
| `POST /api/rpi/naplps` | Sends a drawing to the Pi *only* — no broadcast to other clients |
| `POST /api/rpi/command` | Sends `take_photo` or `stream_photo` to the Pi |

The same three are reachable over the sockets, for clients that already hold a connection: `rpi_naplps` and `rpi_command` on socket.io, or messages of those `type`s (and the bare command strings) on raw `ws`.

---

## Frontend (`public/`)

The frontend is a single-page app (`index.html`) offering several modes of interaction: viewing NAPLPS files, converting SVGs to NAPLPS, and live 3D drawing.

### Core Components

**`index.html`** - Main application entry point containing:
- p5.js canvas for 2D NAPLPS rendering
- Drag-and-drop loading for `.nap` or `.svg` files
- SVG-to-NAPLPS encoding via `NapEncoder`
- Tezos wallet connection and minting UI
- A "Live Drawing" button to launch the 3D drawing mode overlay
- Slideshow mode, which plays a random `.nap` from `./images` on an interval. While it runs, each frame it draws is also sent to the Raspberry Pi via `NapClient.sendToRpi()`, so the Pi shows what the page shows. Loading other content, or entering live drawing, stops the slideshow and the sending with it.

### JavaScript Modules

**`js/telidon/` (Legacy Format Processing)**
- `naplps.js` - NAPLPS format encoder (`NapEncoder`) and decoder. Independent of rendering frameworks.
- `TelidonP5.js` - p5.js renderer (`TelidonDraw`) that consumes the decoded NAPLPS data and draws it to the HTML5 canvas.

**`js/net/` (Network & API)**
- `client.js` - `NapClient` handles the WebSocket connection to the backend and parses incoming `naplps` messages. It never communicates with the Tezos RPC or TzKT directly. `sendToRpi()` and `rpiCommand()` reach the Raspberry Pi the same way: by asking the backend, which is the only side that knows whether a Pi exists or where it lives.

**`js/tezos/` (Web3 & Wallets)**
- `tezos.js` - Beacon SDK integration. Connects to the user's browser wallet (e.g., Temple), receives the unsigned payload from the backend via `POST /api/tezos/mint-params`, and prompts the user to sign and broadcast.

**`js/drawing/` (Live 3D Drawing Mode)**
An ES-module-based 3D environment built on Three.js and MediaPipe:
- `drawing.js` - Main entry point. Sets up the Three.js scene, camera, and MediaPipe hand tracking.
- `tools.js` - `Stroke` and `Frame` classes for managing 3D lines and points.
- `controller.js` - Hand controller wrappers that process raw MediaPipe landmarks, using Kalman filtering for smooth gesture recognition.
- `palette.js` - Interactive color selection wheel.
- `worldscale.js` - Implements two-handed pinch/zoom/rotate gestures to manipulate the 3D drawing canvas.

### How Drawing Mode Integrates

The 3D drawing mode is initialized via `startDrawingMode(container)` and torn down via `stopDrawingMode()`. When active, it takes over the screen to allow hand-tracked drawing via a webcam. When finished or exited, the drawn strokes can be serialized, encoded to NAPLPS, and either broadcast to other clients or minted to the blockchain.
