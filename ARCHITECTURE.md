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
6. **The Slideshow Cycle**: One cycle of slides — chain tokens alternating with the slideshow's local files (`rpi-cycle.js`; see *The Pi while drawing*) — that keeps the Pis busy while a page is in drawing mode, and is the slideshow a page runs in review mode. Pages only say when they join and leave, and a page running its slideshow gets each slide as the Pis do.

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

`RPI_CAPTURE_DIR` writes a copy of every drawing on its way to the Pi, named by timestamp and source. It is off unless set, and is there for one job: when a drawing arrives on the Pi with pieces missing, the only artifact worth analysing is the byte stream that was actually sent, rather than one a harness synthesised. `tools/brush-geometry` reads those files back — `brush-geometry inspect <file>` reports opcodes, points per polygon, operand alignment, off-frame points and self-crossing polygons, and comparing a captured drawing against one of `public/images` is what separates a fault in what we send from a fault in how the Pi reads it.

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

The same three are reachable over the sockets, for clients that already hold a connection: `rpi_naplps` and `rpi_command` on socket.io, or messages of those `type`s (and the bare command strings) on raw `ws`. socket.io also carries `cycle` (`{ drawing, slideshow, interval }`), the page's part in the slideshow cycle, sent whole whenever it changes — and again on reconnecting, since a restarted server knows nothing of it. A page that disconnects has left. A page running its slideshow gets each slide as a `slide` message (`{ source, naplps }`, plus the token's `id` and `link`, or the local `file`).

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
- Slideshow mode, which the backend runs: it is the same cycle that keeps the Pi busy in drawing mode (see *The Pi while drawing*), so its slides take turns — a chain token, newest first, then a random `.nap` from `./images`, then the next token. `NapClient.setSlideshow()` joins it, and each slide arrives as a `slide` message for `showSlide()` to draw; the backend puts the same slide on the Raspberry Pi at the same moment, so the Pi shows what the page shows without the page sending anything. Starting it hides the chrome, the way entering drawing mode does — a slideshow is there to be watched, not operated — and a mouse move brings the chrome back, review mode's rule as ever. Clicking the link again while it runs puts the chrome away afresh: that second click is the way back to a clean screen once a stray mouse move has raised it. A new mint during the slideshow is the cycle's chain turn, so it goes up as a slide and the slideshow carries on; loading other content, or entering live drawing, stops the slideshow. A chain token it shows moves the arrow keys' place, as one loaded any other way does.

### JavaScript Modules

**`js/telidon/` (Legacy Format Processing)**
- `naplps.js` - NAPLPS format encoder (`NapEncoder`) and decoder. Independent of rendering frameworks.
- `TelidonP5.js` - p5.js renderer (`TelidonDraw`) that consumes the decoded NAPLPS data and draws it to the HTML5 canvas.

**`js/net/` (Network & API)**
- `client.js` - `NapClient` handles the WebSocket connection to the backend and parses incoming `naplps` messages. It never communicates with the Tezos RPC or TzKT directly. `sendToRpi()` and `rpiCommand()` reach the Raspberry Pi the same way: by asking the backend, which is the only side that knows whether a Pi exists or where it lives. `showToken()` fetches a token and has the backend put it on the Pi in the same request, `setDrawingMode()` and `setSlideshow()` tell the backend the page's part in the slideshow cycle, sending it again on every (re)connect, and `onSlide()` hands the slideshow its slides.

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

**From stroke to NAPLPS.** A stroke leaves drawing mode as a run of short filled polygons rather than as one outline of the whole thing. `Stroke.toBrushShapes()` (`js/drawing/tools.js`) projects the centreline into the flat 0–1 space the format draws in, measures the brush width there — across the view, so a stroke drawn toward the camera keeps its weight instead of collapsing to a hairline in its own plane — and regenerates the brush from those 2D points as a tiling of convex pieces: one trapezoid along each segment, one fan filling the wedge at each corner, and a round cap at each end. A piece built on its own segment's perpendicular is convex, where a single long outline crosses itself at each tight turn and floods the loops of a scribble on one renderer but not another. Each point in a polygon is also a delta from the one before it, so ending the polygon after a handful of points resets that running cursor before the encoder's rounding can grow into drift — the error that moved long strokes off where they were drawn.

**One command stream, whatever drew it.** A live drawing and an imported SVG go through the same `NapEncoder`, and they now come out of it the same shape: a `SELECT COLOR` in front of every `SET & POLY FILLED`. They used to differ, because `makeNapStroke()` skipped the colour command whenever the colour had not moved further than 0.1 from the last one. That almost never fired on an SVG, where every path brings its own fill — the files in `public/images` carry one colour command per polygon — and it always fired on a live drawing, where a stroke's eighty brush pieces are all one colour and shared a single one between them. That was the sharpest structural difference between the drawings the Pi renders whole and the ones it renders with pieces missing (`docs/REPORT_2.md`), and it made a lost colour command expensive besides: eighty polygons took their colour from whatever had been selected last, where now each carries its own.

It costs five bytes a polygon, and the ladder below pays for it out of the cover run first and the tolerance second — the four-stroke sketch keeps the finest brush and its cover run, while a hundred strokes settle one rung coarser than they did.

The corners used to be filled by letting consecutive quads reach past the joint they shared, which paints a corner over rather than filling it — close enough at a gentle turn and visibly blunt at a sharp one. A fan fills the same wedge exactly and costs about what the overlap did. It is only drawn where there is something to fill: below a quantum of sagitta the two corners round to the same coordinate, so a centreline simplified near the encoder's own quantum — which turns by a degree or two at nearly every vertex — spends nothing on corners that cannot be represented.

That last clause does most of the work, and it is worth being blunt about what it leaves: measured over the corpus, fans and caps are **about 4% of the pieces at the finest rung** and under 5% at every rung. The brush is trapezoids almost everywhere, and the exact corners only earn their keep at a genuinely sharp turn — which is why rebuilding them scored 0.858 against the ideal where the blunt ones scored 0.861. The fidelity in this section comes from the tolerance, not from the corner geometry; the corners are there so that a hairpin is right, not because they move the average.

**The polyline is what gets projected.** Strokes are kept as the polyline the hand drew, and the 2D pieces are regenerated from its projected points, so nothing is flattened twice. The one thing that used to break that rule was the per-stroke z-offset that keeps the 3D preview from z-fighting: it was added to the points themselves, so it moved the *encoded* drawing too, by a distance that grew with every stroke added — measured over the harness corpus at 3.4px by the fortieth stroke and 16.7px by the eightieth, on an artwork 640 across. `Stroke.offsetAlongNormal()` now only records it and `Frame._refreshGeometry()` puts it on the preview mesh, where a trick for the depth buffer belongs.

**Which trapezoids become triangles.** `toBrushPolygons()` is what actually gets encoded, and it splits a trapezoid in two where the encoder could fold it. A position is written to the nearest 1/2048, so a trapezoid thinner than a couple of those quanta — a stroke's tapered tip, a stroke drawn far from the camera, one flattened against the frame by clamping — can come back with a corner across its own far side. That bowtie is the one shape the two renderers disagree about: the browser's canvas fills its crossing region under the nonzero rule, and `ofPath` on the Pi leaves it hollow under the even-odd rule it defaults to, so the same drawing looks different in the two places it is meant to look alike. A triangle cannot fold. The trapezoids that do fold are thinner than a pixel, so where it happens the difference between the two renderers is correspondingly small — this is insurance against a class of divergence rather than a fix for a visible one. It is cheap insurance: splitting everything would cost half again as many bytes, where `cornerHeight()` measures how much room the rounding has and splits only what is at risk, which over a corpus of deliberately awkward strokes is about a fifth of the polygons.

Only trapezoids are measured that way. What folds is a pair of long edges crossing, and a fan or a cap is convex around a hub, carries a radius of at least the same margin, and keeps its points that far apart along its arc — so rounding can dent one but not turn it inside out. Measuring them with `cornerHeight()` split nearly every one, because an arc point is *meant* to sit close to the chord through its neighbours; reading that roundness as fragility cost three polygons in four.

**The byte budget: fidelity first, insurance second.** `convertToNAPLPS()` in `drawing.js` supplies the projection, since only it knows the camera and the transform the two-handed gesture has left on the drawing. It also owns the size of the result: a drawing over the `maxNaplpsBytes` that `GET /api/config` reports is encoded again with a coarser brush rather than handed to a mint that would refuse it — a stroke survives losing points far better than a drawing survives not being minted. There is no figure in the page to fall back on: until the config has come a drawing isn't fitted at all, and the mint gesture waits for it.

The brush starts as fine as the format can carry — `BRUSH_SIMPLIFY` is the encoder's own quantum, since a point it cannot tell from its neighbour is one simplification may as well drop — and with no cover run at all. The ladder doubles the tolerance, up to eight times, only as far as it must to fit. Whatever room is left over then buys the cover run back, and a drawing that only just fits goes without it. Each pass doubles but never below the quantum, since a brush tuned to keep every point starts at zero and doubling zero would leave the ladder standing still. What still doesn't fit is encoded anyway, since the canvas and the Raspberry Pi will take it.

`BRUSH_SIMPLIFY` (`js/drawing/tools.js`) is the project's only simplification tolerance, and everything that simplifies reads it from there: the ladder above, the defaults on `toBrushShapes()` and `toBrushPolygons()`, `--tolerance` in `tools/brush-geometry`, and the SVG importer in `index.html`. The importer used to carry its own `0.02` in three places, so an imported drawing was thinned forty times more coarsely than a drawn one for no reason anyone had written down — and at 0.02 a traced outline keeps about a twenty-fifth of its points where the quantum keeps a third. `index.html`'s SVG code is a plain script and cannot import from a module, so a one-line module script hands the constant over on `window`; `brushSimplify()` throws rather than carry on without it, since RDP with an undefined tolerance returns the straight line between a path's first and last point and would look like an import fault instead of a load failure. `MIN_STEP` alongside it is not a second knob for the same thing — it is the 4-byte domain's quantum, which the geometry guards are multiples of because they concern what the format can represent rather than how much detail to keep.

That order is the whole of the change, and it is worth more than the geometry is. Measured against the ideal brush over the harness corpus, the shape of the polygons at a given tolerance is worth almost nothing — the exact corners score 0.858 where the old blunt ones scored 0.861 — while the tolerance itself is worth ten to thirty points, and a hairpin comes back at 0.649 of the ideal at 0.002 and 0.963 at the quantum. The cover run buys nothing at all unless a polygon actually goes missing. So when a drawing is too big it is the redundancy that gives way, not the shape of the strokes: a hundred strokes used to be thinned to a tolerance of 0.016 while still paying for the cover run, and now land at 0.008 without it. The console line at the end of a conversion says which tolerance it settled on and whether the cover run made it in, which is how to tell from a real drawing — rather than from the harness — whether the redundancy is still being bought.

**Covered twice, when there is room.** Sections of a stroke were arriving at the Pi missing, with no sign of the drift or the fold that accounted for the earlier faults — so `toBrushShapes()` can lay the stroke down more than once. A staggered run follows the plain one, offset half a segment along the centreline, so its joints fall where the plain run is straight and its pieces straddle the plain run's joints; the two cover each other's weak points rather than the same one twice, and the tips are covered as well because the staggered run keeps the stroke's own ends. `BRUSH_OVERLAP_PASSES` says how many of those runs there are — 1 as it ships, and 0 is the plain run on its own. Each staggered run is emitted after the whole plain one rather than beside the pieces it covers, which matters for the kind of loss that takes a contiguous stretch of the command stream: the cover for a lost polygon is then far away in the stream rather than next to it, and goes missing separately. Ordering is safe to move within a stroke because a stroke is one colour and its fills are opaque, so which of its own polygons paints last is not visible; between strokes the order still stands, since that is what layers them. The measured effect, over the harness corpus: a fifth of the stream lost in one burst leaves 77% of the paint without the overlap and 98% with it.

What changed is when it is bought. The run costs about twice the polygons, and it used to be paid for up front by every drawing, which meant a busy one paid for it in the only currency left — a centreline thinned until the polygons lost their shape. Now the centreline is fitted first and the cover run is what a drawing gives up when it cannot afford both. A small drawing still gets both; the corpus's four-stroke sketch fits at the finest tolerance with the cover run inside 7,100 bytes.

Held gestures are confirmed by expanding or shrinking circles before they fire. Thumbs-down undoes the last stroke, or clears the drawing with both hands; a single thumbs-up recentres the camera and world. **Double thumbs-up mints**: the strokes are encoded and `drawing.js` calls the wallet shim's `mintCurrentNaplps()`, so the signing still happens in `js/tezos/` and the backend still builds the operation. Drawing mode stays up through the mint — leaving it is the "Exit Drawing" button, which the UI toggle reveals. Leaving drops back onto the newest token from the chain rather than the empty canvas drawing mode started with, so review mode opens on something, and the arrow keys start from the latest. That load leaves the Pi alone, as the one on page open does: the watcher has already sent it every mint, this one included.

**The Pi while drawing.** With the overlay up, the page's canvas has nothing on it for the Pi to follow, so the Pi gets a cycle of its own, run by the backend (`rpi-cycle.js`, wired up in `app.js`) — the same cycle the review-mode slideshow shows. The page says so in its `cycle` message, with its `slideshow_interval`, on entering drawing mode — and so as the page opens — and again on leaving, the Pi keeping whichever drawing it was sent last. The cycle used to run in the page, which fetched every drawing only to send it straight back; now the page sends nothing while it draws, and the backend reads the chain (from its token cache) and `public/images` itself. Every interval one drawing goes to the Pis, and the turns alternate: a token from the chain, then one of the slideshow's local files, then the next token, the chain going first. The tokens keep to one order — the newest first, then each one before it down to #0, then round to the newest again, looked up afresh at each wrap. The local file is a random pick from the slideshow's list (`nap-list.json`, or the folder if that won't read), with its line breaks dropped, as the slideshow has always dropped them (the page used to read the files through p5's `loadStrings()`). A mint resets the count to the newest: the watcher sends a new token to the Pi the moment it finds it and then tells the cycle, so the mint counts as the chain's turn — a full interval to itself, then a local file, then the token before it. That goes for anyone's mint, not only one made by this page's gesture, since the Pi is showing it either way. A turn passes whether or not it had anything to send, so a chain that can't be read, or a file that won't load, costs only its own slot, and while nobody is watching — no Pi connected, no page running its slideshow — nothing is read and the turn waits. A read still out when the cycle is stopped or reset is dropped rather than sent — otherwise an old drawing could land on the Pi over the mint that just arrived. Ids with no drawing behind them are passed over within the chain's turn, a few reads at a time. The cycle runs while any page is in drawing mode or running its slideshow, at the interval the latest to join asked for (kept within 2 s – 10 min), and a page that disconnects counts as having left. A slideshow that joins a cycle already under way starts on the slide showing now rather than waiting for the next. `GET /api/rpi/status` reports it under `cycle`.

### UI Visibility

The page runs with every HTML overlay hidden (`.ui-hidden` on `<body>`, set in the markup so nothing flashes before the first paint), so the canvas fills the screen on its own. A single visible/hidden flag in `index.html` governs it, reached by "h" or by moving the mouse, and what those do depends on the mode:

| | "h" | Mouse movement |
| --- | --- | --- |
| **Review mode** | toggles on and off | shows, and it stays until "h" hides it |
| **Drawing mode** | shows for five seconds | shows for five seconds, each move pushing the five seconds back |

The mouse only ever shows the chrome; "h" is the way to put it away. The pointer itself follows the same flag — hidden while the chrome is, back when the chrome returns (`body.ui-hidden` in `main.css`) — so a screen at rest holds the artwork and nothing else. Drawing mode is included in that, where the pointer used to be hidden outright: the five seconds that put "Exit Drawing" on screen now come with a pointer to reach it. The split follows what the screen is for: a viewer who reaches for the mouse in review mode wants the controls to stay, while in drawing mode the artwork *is* the screen, so a stray nudge should not leave the chrome sitting over it. The idle timer belongs to drawing mode — leaving that mode with one pending drops it rather than hiding the chrome five seconds into review mode — and `setUIHidden(true)` — which drawing mode calls on entry, and the slideshow when it starts — clears it too.

