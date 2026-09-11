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

1. **Tezos Chain Watcher**: Polls the smart contract's `token_metadata` bigmap (defaulting to the Shadownet contract) using the TzKT API. Decodes hex payloads into NAPLPS bytes, broadcasts new tokens to all connected clients, and sends them on to the Raspberry Pis. Tokens it reads are kept in memory, since the contract never rewrites a minted one.
2. **Message Broker**: Manages a unified fanout system across `socket.io` and raw `ws` connections. Drawings travel as JSON messages (`{ type: "naplps", source, naplps, ... }`) whether they are minted on-chain, posted via the REST API, or drawn live.
3. **Transaction Preparation**: Builds the `mint` entrypoint Michelson parameter payload to hand off to the frontend for signing. A drawing over `TEZOS_MAX_BYTES` (30,000 bytes unless `.env` says otherwise) is refused, which leaves headroom under the protocol's 32,768-byte limit on a whole operation (`max_operation_data_length`). `GET /api/config` hands the figure to the page, which keeps none of its own. The setting is read strictly, in `mint-limit.js`, and the server won't start on one that isn't a whole number above zero: `parseInt` alone would take "30,000" as 30, and "abc" as a NaN that no drawing's size exceeds, which switches the check off.
4. **Headless Minting (Optional)**: If `TEZOS_SECRET_KEY` is provided in `.env`, the server can sign and submit mint operations directly using `@taquito/taquito`.
5. **Outbound Server Links (Optional)**: Connects as a client to a peer nap-xtz server and to one or more Raspberry Pis. Both are off unless configured, so the server still runs on its own.
6. **The Pi's Drawing-Mode Cycle**: While a page is in drawing mode, puts a drawing on the Pis every slideshow interval, alternating chain tokens with the slideshow's local files (`rpi-cycle.js`; see *The Pi while drawing*). The page only says when drawing mode starts and stops.

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
| `POST /api/rpi/token` | Returns a token (`id`, or `"latest"`) and puts it on the Pis on the way — what the "latest" link and the arrow keys use |
| `POST /redeploy` | GitHub webhook endpoint to automatically pull latest changes and restart the server |

The same three are reachable over the sockets, for clients that already hold a connection: `rpi_naplps` and `rpi_command` on socket.io, or messages of those `type`s (and the bare command strings) on raw `ws`. socket.io also carries `drawing_mode` (`{ active, interval }`), which a page sends on entering and leaving drawing mode — and again on reconnecting, since a restarted server knows nothing of it. A page that disconnects has left.

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
- A "latest" link that loads the newest on-chain drawing. Clicking it also puts that drawing on the Raspberry Pi — a deliberate choice to change what is on screen, so the Pi follows. It asks for the token through `POST /api/rpi/token` (`NapClient.showToken()`), so the backend sends it to the Pi as it hands it over, rather than the page fetching it and sending it back. The same load runs automatically when the page opens, and that one leaves the Pi alone.
- Reading back and forth along the chain, in review mode: the left and right arrow keys, and the `<<` and `>>` links flanking "latest", which are the same step by another route — left for the token minted before the one on screen, right for the one after. Both come alive once a token has arrived from the chain — the load on page open is enough — and stop at the two ends, #0 and the newest mint the backend has announced. Each token they bring up goes to the Pi as well, for the reason the "latest" link does and by the same route. A drawing from anywhere else — a dropped file, a peer's — leaves the position where it was, so a step carries on along the chain rather than from whatever last landed on the canvas. Drawing mode has neither: the keyboard belongs to the drawing there, and the canvas a step would load onto is behind the overlay.
- Slideshow mode, which plays a random `.nap` from `./images` on an interval. Starting it hides the chrome, the way entering drawing mode does — a slideshow is there to be watched, not operated — and a mouse move brings the chrome back, review mode's rule as ever. Clicking the link again while it runs puts the chrome away afresh: that second click is the way back to a clean screen once a stray mouse move has raised it. While it runs, each frame it draws is also sent to the Raspberry Pi via `NapClient.sendToRpi()`, so the Pi shows what the page shows. Loading other content, or entering live drawing, stops the slideshow and the sending with it.

### JavaScript Modules

**`js/telidon/` (Legacy Format Processing)**
- `naplps.js` - NAPLPS format encoder (`NapEncoder`) and decoder. Independent of rendering frameworks.
- `TelidonP5.js` - p5.js renderer (`TelidonDraw`) that consumes the decoded NAPLPS data and draws it to the HTML5 canvas.

**`js/net/` (Network & API)**
- `client.js` - `NapClient` handles the WebSocket connection to the backend and parses incoming `naplps` messages. It never communicates with the Tezos RPC or TzKT directly. `sendToRpi()` and `rpiCommand()` reach the Raspberry Pi the same way: by asking the backend, which is the only side that knows whether a Pi exists or where it lives. `showToken()` fetches a token and has the backend put it on the Pi in the same request, and `setDrawingMode()` tells the backend when drawing mode starts and stops, sending it again on every (re)connect.

**`js/tezos/` (Web3 & Wallets)**
- `tezos.js` - Beacon SDK integration. Connects to the user's browser wallet (e.g., Temple), receives the unsigned payload from the backend via `POST /api/tezos/mint-params`, and prompts the user to sign and broadcast. It also keeps the reader's place on the chain — the id on screen and the newest one known — and `stepToken()` moves it; `index.html` owns the key handling, as it does for "h". An id the backend answers 404 for (a mint from some other tool, with no `naplps` in its metadata) would otherwise trap the arrows on the gap, so the position moves onto it anyway and the next press continues past. Drawings the backend pushes are drawn as they arrive, except in drawing mode: the canvas is behind the overlay then, and leaving puts the newest token on it anyway, so drawing them would only run p5's reveal and the VHSC pass out of sight. The Beacon SDK is not in `index.html`. At 2.4 MB of script it was the page's heaviest Tezos cost, and a page whose mints the server signs never uses it, so `ensureBeacon()` loads it the first time a wallet is wanted — Connect Wallet, or a mint with no server key — or at page open when the browser has a wallet session stored (`beacon:active-account`), so that session comes back as before.

There are two routes to a mint, and `GET /api/config`'s `serverSigning` flag picks between them. When the backend holds a key, `mintCurrentNaplps()` posts to `POST /api/tezos/mint` and the server signs — no wallet, no popup, which is the only way the gesture mint works unattended. A connected wallet still owns the token; with none connected, the server's own address does. Without a server key it falls back to the Beacon route, loading the SDK if nothing has yet, which prompts for every operation — Temple has no blanket pre-approval to switch off.

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

**From stroke to NAPLPS.** A stroke leaves drawing mode as a run of short filled polygons rather than as one outline of the whole thing. `Stroke.toBrushQuads()` (`js/drawing/tools.js`) projects the centreline into the flat 0–1 space the format draws in, measures the brush width there — across the view, so a stroke drawn toward the camera keeps its weight instead of collapsing to a hairline in its own plane — and lays one quad along each segment. A quad on its own segment's perpendicular is convex, where a single long outline crosses itself at each tight turn and floods the loops of a scribble on one renderer but not another. Each point in a polygon is also a delta from the one before it, so ending the polygon after four resets that running cursor before the encoder's rounding can grow into drift — the error that moved long strokes off where they were drawn.

**Which quads become triangles.** `toBrushPolygons()` is what actually gets encoded, and it splits a quad in two where the encoder could fold it. A position is written to the nearest 1/2048, so a quad thinner than a couple of those quanta — a stroke's tapered tip, a stroke drawn far from the camera, a quad flattened against the frame by clamping — can come back with a corner across its own far side. That bowtie is the one shape the two renderers disagree about: the browser's canvas fills its crossing region under the nonzero rule, and `ofPath` on the Pi leaves it hollow under the even-odd rule it defaults to, so the same drawing looks different in the two places it is meant to look alike. A triangle cannot fold. The quads that do fold are thinner than a pixel, so where it happens the difference between the two renderers is correspondingly small — this is insurance against a class of divergence rather than a fix for a visible one. It is cheap insurance: splitting every quad would cost half again as many bytes, where `cornerHeight()` measures how much room the rounding has and splits only what is at risk, which over a corpus of deliberately awkward strokes is about a quarter of the quads and two percent of the bytes. `convertToNAPLPS()` in `drawing.js` supplies the projection, since only it knows the camera and the transform the two-handed gesture has left on the drawing. It also owns the size of the result: a drawing over the `maxNaplpsBytes` that `GET /api/config` reports is encoded again with a coarser brush, up to five times, rather than handed to a mint that would refuse it — a stroke survives losing points far better than a drawing survives not being minted. There is no figure in the page to fall back on: until the config has come a drawing isn't fitted at all, and the mint gesture waits for it. Each pass doubles the tolerance but never below the encoder's own quantum, since a brush tuned to keep every point starts at zero, and doubling zero would leave the ladder standing still. What still doesn't fit is encoded anyway, since the canvas and the Raspberry Pi will take it.

**Covered twice.** Sections of a stroke were still arriving at the Pi missing, with no sign of the drift or the fold that accounted for the earlier faults — so `toBrushQuads()` now lays the stroke down more than once. A staggered run follows the plain one, offset half a segment along the centreline, so its joints fall where the plain run is straight and its quads straddle the plain run's joints; the two cover each other's weak points rather than the same one twice, and the tips are covered as well because the staggered run keeps the stroke's own ends. `BRUSH_OVERLAP_PASSES` says how many of those runs there are — 1 as it ships, and 0 is the plain run on its own. Each staggered run is emitted after the whole plain one rather than beside the quads it covers, which matters for the kind of loss that takes a contiguous stretch of the command stream: the cover for a lost quad is then far away in the stream rather than next to it, and goes missing separately. Ordering is safe to move within a stroke because a stroke is one colour and its fills are opaque, so which of its own polygons paints last is not visible; between strokes the order still stands, since that is what layers them. The measured effect, over the harness corpus: a fifth of the stream lost in one burst leaves 80% of the paint without the overlap and 97% with it. It is paid for in detail rather than in drawings that won't fit — the run costs about twice the polygons, and the byte ladder below coarsens the brush when that puts a drawing over the mint limit.

Held gestures are confirmed by expanding or shrinking circles before they fire. Thumbs-down undoes the last stroke, or clears the drawing with both hands; a single thumbs-up recentres the camera and world. **Double thumbs-up mints**: the strokes are encoded and `drawing.js` calls the wallet shim's `mintCurrentNaplps()`, so the signing still happens in `js/tezos/` and the backend still builds the operation. Drawing mode stays up through the mint — leaving it is the "Exit Drawing" button, which the UI toggle reveals. Leaving drops back onto the newest token from the chain rather than the empty canvas drawing mode started with, so review mode opens on something, and the arrow keys start from the latest. That load leaves the Pi alone, as the one on page open does: the watcher has already sent it every mint, this one included.

**The Pi while drawing.** With the overlay up, the page's canvas has nothing on it for the Pi to follow, so the Pi gets a cycle of its own, run by the backend (`rpi-cycle.js`, wired up in `app.js`). The page sends `drawing_mode` with its `slideshow_interval` on entering drawing mode — and so as the page opens — and again on leaving, the Pi keeping whichever drawing it was sent last. The cycle used to run in the page, which fetched every drawing only to send it straight back; now the page sends nothing while it draws, and the backend reads the chain (from its token cache) and `public/images` itself. Every interval one drawing goes to the Pis, and the turns alternate: a token from the chain, then one of the slideshow's local files, then the next token, the chain going first. The tokens keep to one order — the newest first, then each one before it down to #0, then round to the newest again, looked up afresh at each wrap. The local file is a random pick from the slideshow's list (`nap-list.json`, or the folder if that won't read), with its line breaks dropped as the page's `loadStrings()` drops them, so a file looks the same on the Pi whichever side sent it. A mint resets the count to the newest: the watcher sends a new token to the Pi the moment it finds it and then tells the cycle, so the mint counts as the chain's turn — a full interval to itself, then a local file, then the token before it. That goes for anyone's mint, not only one made by this page's gesture, since the Pi is showing it either way. A turn passes whether or not it had anything to send, so a chain that can't be read, or a file that won't load, costs only its own slot, and while no Pi is connected nothing is read and the turn waits. A read still out when the cycle is stopped or reset is dropped rather than sent — otherwise an old drawing could land on the Pi over the mint that just arrived. Ids with no drawing behind them are passed over within the chain's turn, a few reads at a time. The cycle runs while any page is in drawing mode, at the interval the latest to enter asked for (kept within 2 s – 10 min), and a page that disconnects counts as having left; `GET /api/rpi/status` reports it under `cycle`.

### UI Visibility

The page runs with every HTML overlay hidden (`.ui-hidden` on `<body>`, set in the markup so nothing flashes before the first paint), so the canvas fills the screen on its own. A single visible/hidden flag in `index.html` governs it, reached by "h" or by moving the mouse, and what those do depends on the mode:

| | "h" | Mouse movement |
| --- | --- | --- |
| **Review mode** | toggles on and off | shows, and it stays until "h" hides it |
| **Drawing mode** | shows for five seconds | shows for five seconds, each move pushing the five seconds back |

The mouse only ever shows the chrome; "h" is the way to put it away. The pointer itself follows the same flag — hidden while the chrome is, back when the chrome returns (`body.ui-hidden` in `main.css`) — so a screen at rest holds the artwork and nothing else. Drawing mode is included in that, where the pointer used to be hidden outright: the five seconds that put "Exit Drawing" on screen now come with a pointer to reach it. The split follows what the screen is for: a viewer who reaches for the mouse in review mode wants the controls to stay, while in drawing mode the artwork *is* the screen, so a stray nudge should not leave the chrome sitting over it. The idle timer belongs to drawing mode — leaving that mode with one pending drops it rather than hiding the chrome five seconds into review mode — and `setUIHidden(true)` — which drawing mode calls on entry, and the slideshow when it starts — clears it too.

