# NAP-XTZ Server Architecture

NAP-XTZ is a collaborative, web-based drawing platform that bridges the 1980s Telidon/NAPLPS vector graphics format with the Tezos blockchain. 

The architecture strictly separates the **backend (blockchain synchronization & broadcasting)** from the **frontend (drawing, rendering, and wallet signing)**.

## High-Level Separation of Concerns

- **Backend (`app.js`)**: Owns all Tezos interactions (except transaction signing). It is responsible for contract addresses, network endpoints, Michelson payload construction, chain reads, and polling for new tokens via the TzKT API. It acts as a headless server that can broadcast new drawings via WebSockets to connected clients without needing a browser open. It also owns the outbound links to other machines — a peer nap-xtz server and any number of Raspberry Pis — so the frontend never needs to know their addresses.
- **Frontend (`public/`)**: A static web client that renders NAPLPS art using p5.js and provides a 3D hand-tracking live drawing mode using MediaPipe and Three.js. It holds no direct blockchain-reading logic and relies on the backend's `/api/*` and WebSocket messages. For minting, the frontend connects to the user's Tezos wallet (via Beacon SDK) to sign the transaction payloads constructed by the backend.

---

## Backend (`app.js`)

The Node.js backend handles HTTP requests (Express) and real-time communication (Socket.IO + ws). 

### Key Responsibilities

1. **Tezos Chain Watcher**: Polls the smart contract's `token_metadata` bigmap (defaulting to the Shadownet contract) using the TzKT API. Decodes hex payloads into NAPLPS bytes, broadcasts new tokens to all connected clients, and sends them on to the Raspberry Pis.
2. **Message Broker**: Manages a unified fanout system across `socket.io` and raw `ws` connections. Drawings travel as JSON messages (`{ type: "naplps", source, naplps, ... }`) whether they are minted on-chain, posted via the REST API, or drawn live.
3. **Transaction Preparation**: Builds the `mint` entrypoint Michelson parameter payload to hand off to the frontend for signing.
4. **Headless Minting (Optional)**: If `TEZOS_SECRET_KEY` is provided in `.env`, the server can sign and submit mint operations directly using `@taquito/taquito`.
5. **Outbound Server Links (Optional)**: Connects as a client to a peer nap-xtz server and to one or more Raspberry Pis. Both are off unless configured, so the server still runs on its own.

### Outbound Server Links

Where the `ws`/`socket.io` servers above accept connections, these two are connections the backend *opens*. Both reconnect on their own if the far end goes away.

**Peer server** (`PEER_WS_URL`, e.g. `ws://other-host:8090`) — links two installations so they share drawings. Anything this server broadcasts is forwarded to the peer, and anything the peer sends is broadcast to local clients tagged `source: "peer"`.

Every message carries a `mid` (server id + counter) and each server remembers the last 500 it has handled. Without that, two servers each pointed at the other would hand the same drawing back and forth forever, since a message arriving from a peer is indistinguishable from any other client's. The id also means a drawing is delivered once rather than once per path.

**Raspberry Pis** (`RPI_HOST`, e.g. `nfg-rpi-3-4.local`) — Pis running PiNaplpsPlayer or PiNaplpsDrawer (openFrameworks / ofxHTTP). Traffic runs both ways:

- *In*: camera and vision frames (`photo`, `photo_saved`, `video`, `blob`, `pixel`, `contour`) are relayed to connected clients as `{ type: "rpi", source: "rpi", host, port, event, ... }`. The Pi's own frame type becomes `event`, since `type` names the transport; `host` and `port` say which Pi sent it, which a frame's own `hostname` cannot — the plain-text frames carry no hostname, and two Pis can share a machine.
- *Out*: NAPLPS drawings, and the two commands the Pi acts on (`take_photo`, `stream_photo`). Newly minted drawings go out this way on their own: the Pi is not a websocket client of ours, so the chain watcher hands each new token to the Pi as well as broadcasting it.

**Naming more than one.** `RPI_HOST` takes a comma-separated list, and each entry may be `host`, `host:port` or `host:port:streamPort`, with `RPI_PORT` and `RPI_STREAM_PORT` filling in whatever an entry omits — so a row of identical Pis needs only their names:

```
RPI_HOST=nfg-rpi-3-4.local, nfg-rpi-3-5.local, 10.0.0.9:7112:7111
```

Each Pi gets its own `RpiClient` and reconnects on its own schedule, so one being switched off neither holds up a send nor disturbs the others: a drawing goes to whichever Pis are up at that moment, and a Pi that was down shows the next one. `sent` in an API reply, and `connected` in a status reply, mean *at least one* Pi — `GET /api/rpi/status` lists them individually under `pis`.

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
| `GET /api/rpi/status` | Which Pis are configured, and which are currently connected |
| `POST /api/rpi/naplps` | Sends a drawing to the Pis *only* — no broadcast to other clients |
| `POST /api/rpi/command` | Sends `take_photo` or `stream_photo` to every Pi |
| `POST /redeploy` | GitHub webhook endpoint to automatically pull latest changes and restart the server |

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
- A "latest" link that loads the newest on-chain drawing. Clicking it also sends that drawing to the Raspberry Pi via `NapClient.sendToRpi()` — a deliberate choice to change what is on screen, so the Pi follows. The same load runs automatically when the page opens, and that one leaves the Pi alone.
- Reading back and forth along the chain, in review mode: the left and right arrow keys, and the `<<` and `>>` links flanking "latest", which are the same step by another route — left for the token minted before the one on screen, right for the one after. Both come alive once a token has arrived from the chain — the load on page open is enough — and stop at the two ends, #0 and the newest mint the backend has announced. Each token they bring up goes to the Pi as well, for the reason the "latest" link does. A drawing from anywhere else — a dropped file, a peer's — leaves the position where it was, so a step carries on along the chain rather than from whatever last landed on the canvas. Drawing mode has neither: the keyboard belongs to the drawing there, and the canvas a step would load onto is behind the overlay.
- Slideshow mode, which plays a random `.nap` from `./images` on an interval. Starting it hides the chrome, the way entering drawing mode does — a slideshow is there to be watched, not operated — and a mouse move brings the chrome back, review mode's rule as ever. Clicking the link again while it runs puts the chrome away afresh: that second click is the way back to a clean screen once a stray mouse move has raised it. While it runs, each frame it draws is also sent to the Raspberry Pi via `NapClient.sendToRpi()`, so the Pi shows what the page shows. Loading other content, or entering live drawing, stops the slideshow and the sending with it.

### JavaScript Modules

**`js/telidon/` (Legacy Format Processing)**
- `naplps.js` - NAPLPS format encoder (`NapEncoder`) and decoder. Independent of rendering frameworks.
- `TelidonP5.js` - p5.js renderer (`TelidonDraw`) that consumes the decoded NAPLPS data and draws it to the HTML5 canvas.

**`js/net/` (Network & API)**
- `client.js` - `NapClient` handles the WebSocket connection to the backend and parses incoming `naplps` messages. It never communicates with the Tezos RPC or TzKT directly. `sendToRpi()` and `rpiCommand()` reach the Raspberry Pi the same way: by asking the backend, which is the only side that knows whether a Pi exists or where it lives.

**`js/tezos/` (Web3 & Wallets)**
- `tezos.js` - Beacon SDK integration. Connects to the user's browser wallet (e.g., Temple), receives the unsigned payload from the backend via `POST /api/tezos/mint-params`, and prompts the user to sign and broadcast. It also keeps the reader's place on the chain — the id on screen and the newest one known — and `stepToken()` moves it; `index.html` owns the key handling, as it does for "h". An id the backend answers 404 for (a mint from some other tool, with no `naplps` in its metadata) would otherwise trap the arrows on the gap, so the position moves onto it anyway and the next press continues past.

There are two routes to a mint, and `GET /api/config`'s `serverSigning` flag picks between them. When the backend holds a key, `mintCurrentNaplps()` posts to `POST /api/tezos/mint` and the server signs — no wallet, no popup, which is the only way the gesture mint works unattended. A connected wallet still owns the token; with none connected, the server's own address does. Without a server key it falls back to the Beacon route, which prompts for every operation — Temple has no blanket pre-approval to switch off.

**`js/drawing/` (Live 3D Drawing Mode)**
An ES-module-based 3D environment built on Three.js and MediaPipe:
- `drawing.js` - Main entry point. Sets up the Three.js scene, camera, and MediaPipe hand tracking.
- `tools.js` - `Stroke` and `Frame` classes for managing 3D lines and points.
- `controller.js` - Hand controller wrappers that process raw MediaPipe landmarks, using Kalman filtering for smooth gesture recognition.
- `mouse.js` - Mouse controller that projects mouse input into 3D space for drawing and palette interaction.
- `palette.js` - Interactive color selection wheel.
- `worldscale.js` - Implements two-handed pinch/zoom/rotate gestures to manipulate the 3D drawing canvas.

### How Drawing Mode Integrates

The 3D drawing mode is initialized via `startDrawingMode(container)` and torn down via `stopDrawingMode()`. When active, it takes over the screen to allow hand-tracked drawing via a webcam. When finished or exited, the drawn strokes can be serialized, encoded to NAPLPS, and either broadcast to other clients or minted to the blockchain.

**From stroke to NAPLPS.** A stroke leaves drawing mode as a run of short filled polygons rather than as one outline of the whole thing. `Stroke.toBrushQuads()` (`js/drawing/tools.js`) projects the centreline into the flat 0–1 space the format draws in, measures the brush width there — across the view, so a stroke drawn toward the camera keeps its weight instead of collapsing to a hairline in its own plane — and emits one quad per segment. Both halves of that matter to the encoder. A quad built on its segment's own perpendicular is convex, so every renderer fills it alike whichever winding rule it uses, where a single long outline crosses itself at each tight turn and floods the loops of a scribble on one renderer but not another. And each point in a polygon is a delta from the one before it, so ending the polygon after four points resets that running cursor before the encoder's rounding error can grow into drift — the error that moved long strokes off where they were drawn. `convertToNAPLPS()` in `drawing.js` supplies the projection, since only it knows the camera and the transform the two-handed gesture has left on the drawing.

Held gestures are confirmed by expanding or shrinking circles before they fire. Thumbs-down undoes the last stroke, or clears the drawing with both hands; a single thumbs-up recentres the camera and world. **Double thumbs-up mints**: the strokes are encoded and `drawing.js` calls the wallet shim's `mintCurrentNaplps()`, so the signing still happens in `js/tezos/` and the backend still builds the operation. Drawing mode stays up through the mint — leaving it is the "Exit Drawing" button, which the UI toggle reveals. Leaving drops back onto the newest token from the chain rather than the empty canvas drawing mode started with, so review mode opens on something, and the arrow keys start from the latest. That load leaves the Pi alone, as the one on page open does: the watcher has already sent it every mint, this one included.

### UI Visibility

The page runs with every HTML overlay hidden (`.ui-hidden` on `<body>`, set in the markup so nothing flashes before the first paint), so the canvas fills the screen on its own. A single visible/hidden flag in `index.html` governs it, reached by "h" or by moving the mouse, and what those do depends on the mode:

| | "h" | Mouse movement |
| --- | --- | --- |
| **Review mode** | toggles on and off | shows, and it stays until "h" hides it |
| **Drawing mode** | shows for five seconds | shows for five seconds, each move pushing the five seconds back |

The mouse only ever shows the chrome; "h" is the way to put it away. The pointer itself follows the same flag — hidden while the chrome is, back when the chrome returns (`body.ui-hidden` in `main.css`) — so a screen at rest holds the artwork and nothing else. Drawing mode is included in that, where the pointer used to be hidden outright: the five seconds that put "Exit Drawing" on screen now come with a pointer to reach it. The split follows what the screen is for: a viewer who reaches for the mouse in review mode wants the controls to stay, while in drawing mode the artwork *is* the screen, so a stray nudge should not leave the chrome sitting over it. The idle timer belongs to drawing mode — leaving that mode with one pending drops it rather than hiding the chrome five seconds into review mode — and `setUIHidden(true)` — which drawing mode calls on entry, and the slideshow when it starts — clears it too.

