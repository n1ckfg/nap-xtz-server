# Long-Running Kiosk: Performance & Reliability Review

A read of the whole stack with one question in mind: what happens to this
installation between the moment it is switched on and the moment somebody
next walks past it, a week later. Earlier reports (`REPORT_3.md`,
`REPORT_5.md`) tuned the cost of one frame in drawing mode. This one is about
what accumulates, what never recovers, and what nobody is there to restart.

Findings are ordered by what would actually take the installation down.

---

## 1. Attract mode gets quadratically slower as it draws — the kiosk's default state

**`public/js/drawing/tools.js:528`, `:564`, `:571`**

`Frame._refreshGeometry()` disposes and rebuilds **every completed stroke's
mesh**, and it is called on *every point added* (`continueStroke`) as well as
at every `endStroke`. Adding point *p* of stroke *k* rebuilds *k* geometries
— `toBrushGeometry()` for each, each allocating a `BufferGeometry`, a fresh
`MeshBasicMaterial`, and running `computeVertexNormals()`.

That is O(N²) in stroke count. It only matters if N gets large, so I measured
what attract mode actually feeds it. Decoding all 62 files in
`public/images/` with the project's own `NapDecoder`:

| | polygons (= strokes) |
| --- | --- |
| median file | **601** |
| largest (`skeltn48.nap`) | **1909** |

`AttractMode._extract()` turns each polygon into one stroke, padded to a
minimum of 12 points. So one median drawing costs roughly
`13 × 601² / 2 ≈ 2.3 million` stroke-geometry builds; `skeltn48.nap` costs
about **24 million**.

The per-frame shape is worse than the total suggests. Attract feeds one point
per 25 ms, so early frames are cheap — but by stroke 600, *a single added
point* rebuilds 600 geometries, 600 materials and 600 normal computations
in one frame. The installation runs smooth, degrades steadily over several
minutes, hits a crawl, clears, and starts over. A sawtooth, forever.

This is the kiosk's *resting* state: `public/index.html:845` calls
`enterDrawingMode()` unconditionally at page open, and `AttractMode.timeout`
is 30 s, so with nobody in front of the camera this is what the machine does
all day.

**Fix:** cache the mesh per stroke. A completed stroke's geometry never
changes — only the active stroke's does. Keep `stroke._mesh` and have
`_refreshGeometry()` build only strokes that don't have one, removing meshes
for strokes that have gone. That turns the per-point cost from O(N) into
O(1) and the per-drawing cost from O(N²) into O(N). It is the single highest
-value change in this report.

**Secondary:** the per-stroke `new THREE.MeshBasicMaterial(...)` at
`tools.js:584` is allocated fresh on every rebuild. Even after the caching
fix, materials should be keyed by color and shared.

## 2. Nothing restarts the server if it dies

**`run.command`, `kiosk-mac.command`, `kiosk-rpi.sh`, `kiosk-win.bat`**

Every launcher runs `node app.js` bare. There is no supervisor, no restart
loop, no systemd unit. One unhandled rejection or OOM and the installation is
a dead page until a human notices — and on `kiosk-rpi.sh` / `kiosk-mac.command`
the server is backgrounded with `&`, so the browser stays up in front of a
server that is gone, showing a frozen canvas rather than an obvious failure.

There is also no `process.on("uncaughtException")` or
`process.on("unhandledRejection")` anywhere in the codebase. Since Node 15 an
unhandled rejection terminates the process by default. The async Express
handlers are all individually try/catch'd, which is good hygiene and keeps
the current exposure small — but "small" is not the standard for something
that has to survive a month unattended.

**Fix:** a systemd unit with `Restart=always` on the Pi, `launchd` with
`KeepAlive` on the Mac; failing that, wrap the launchers in
`until node app.js; do sleep 2; done`. Add the two process handlers to log
and exit non-zero so the supervisor sees a clean failure. Add
`WorkingDirectory=` (see §7).

## 3. Dead websocket clients are never reaped

**`app.js:56`**

```js
const ws = new WebSocket.Server({ port: port_ws, pingInterval, pingTimeout }, ...)
```

`pingInterval` and `pingTimeout` are **socket.io** options. The `ws` package
(8.21.3 here) does not accept them — I checked `node_modules/ws/lib/websocket-server.js`;
they are silently ignored. `ws` has no built-in heartbeat: a client that
vanishes without a FIN (kiosk Wi-Fi drop, a Pi power-cycled, a laptop lid
closed) stays in `ws.clients` forever.

Every such zombie is written to on every broadcast, and counted in
`/api/health`. Over a long run the set only grows.

**Fix:** the standard `ws` heartbeat — mark `socket.isAlive = true` on
`pong`, and on an interval terminate any socket still `false` and re-ping the
rest. Note this applies to the *inbound* `ws` server only; `rpi-client.js` is
right to avoid pings outbound, since the Pi's ofxHTTP server drops the
connection on a PING frame.

## 4. Every message goes over the wire twice

**`app.js:377-381`**

```js
io.emit("message", message);
io.emit(type, message);
```

Both emits carry the full payload to every socket.io client. Nothing in
`public/js/` listens for `"message"` — `client.js` subscribes to `naplps`,
`slide` and `error_message` only. So the generic emit is pure waste: 2×
serialization and 2× bytes for every drawing (up to 30 KB) and, more
importantly, for every relayed Pi camera frame.

**Fix:** drop the `"message"` emit, or gate it behind a flag for external
consumers that might want it.

## 5. Pi camera relay has no throttle and no backpressure check

**`app.js:568-570`, `app.js:385-387`**

`video` frames from the Pi are base64'd and broadcast to every client at
whatever rate the Pi produces them, and `ws.clients.forEach(... client.send(encoded))`
never checks `client.bufferedAmount`. A slow or stalled browser makes the
server buffer frames in memory without limit — an unbounded-growth path that
only shows up under exactly the conditions a long run produces.

Combined with §4, a streaming Pi costs 2× this.

**Fix:** skip a client whose `bufferedAmount` exceeds a threshold (drop the
frame — it's video, the next one is along shortly), and consider relaying
`video` only while at least one client has asked for it.

## 6. The whole page depends on three external CDNs at every boot

**`public/index.html:14-15`, `:22`; `public/js/drawing/drawing.js:163`, `:168`;
`public/js/tezos/tezos.js:166`**

| what | from |
| --- | --- |
| Three.js 0.160.0 | `unpkg.com` |
| MediaPipe tasks-vision 0.10.3 | `cdn.jsdelivr.net` |
| MediaPipe WASM runtime | `cdn.jsdelivr.net` |
| gesture_recognizer model | `storage.googleapis.com` |
| Beacon SDK | `unpkg.com` |

`public/js/libraries/threejs/three.module.js` (1.2 MB) and
`public/js/libraries/mediapipe/tasks-vision_0.10.3.js` (881 KB) are already
vendored in the repo — commit b6f0d06 "add local libraries" — but
`index.html` still points at the CDN. `walletbeacon.dapp.min.js` is vendored
too, and `tezos.js` still fetches it from unpkg.

For a gallery installation this is the difference between "the venue's wifi
was flaky this morning" and "the artwork didn't come up." A CDN outage, a
captive portal, or a DNS hiccup at boot and drawing mode never starts.

**Fix:** point the importmap and the MediaPipe import at the vendored copies;
point `BEACON_SDK_URL` at the local file. The WASM runtime and the `.task`
model still need vendoring — both are downloadable and self-hostable, and
the CSP already allows `'self'`.

## 7. `express.static` resolves against the working directory

**`app.js:737`**

```js
app.use(express.static("public"));
```

Relative to `process.cwd()`, not `__dirname`. Everything else in the file is
careful about this (`IMAGES_DIR` uses `__dirname`, so does the `/` route), so
this looks like an oversight rather than a choice. It works today because
the launchers `cd` first — except `kiosk-rpi.sh`, which doesn't — and it will
break the first time the server is started from a systemd unit or a `.desktop`
autostart entry without `WorkingDirectory` set. The failure mode is a blank
page with 404s, which is a confusing thing to debug in a gallery.

**Fix:** `express.static(path.join(__dirname, "public"))`.

## 8. `/redeploy` is broken in two independent ways

**`app.js:742-755`, `redeploy.sh`**

- `process.env.SECRET` is not set in `.env`, so `crypto.createHmac("sha1", undefined)`
  throws on **every** request to the route. Express turns that into a 500; the
  redeploy never runs.
- `redeploy.sh` does `git reset --hard origin/master`, but this repo's default
  branch is `main` (`refs/remotes/origin/HEAD → origin/main`). Even with the
  HMAC fixed, it would fail.
- `cmd.run("chmod +x ./redeploy.sh")` and `cmd.run("./redeploy.sh")` are
  fire-and-forget and race each other; `cmd.run("refresh")` is not a command
  that exists. Nothing restarts the server after a pull, so a successful
  redeploy would leave the old code running anyway.
- The signature comparison is a plain `===` on strings rather than
  `crypto.timingSafeEqual`.

**Fix, and a recommendation:** for a live installation, consider disabling
this route entirely (`if (process.env.SECRET)` around the `app.post`). An
unattended kiosk that pulls and restarts itself mid-exhibition on someone
else's push is a reliability liability, not a feature. If you want it, fix
the branch name, set `SECRET`, chain the shell commands, and have the script
end by signalling the supervisor to restart.

## 9. No WebGL context-loss handling anywhere

**`public/index.html`, `public/js/drawing/drawing.js`**

Nothing in `public/` listens for `webglcontextlost` or `webglcontextrestored`.
The page holds at least three GL contexts — the Three.js renderer, p5's
`vhscGfx`, and MediaPipe's GPU delegate. A Chrome GPU-process restart, a
driver reset, or a display sleep/wake sends every one of them a context-loss
event, and over weeks of uptime that is close to certain on a Pi or a Beelink.

Without a handler the canvas goes permanently black and stays that way until
somebody reloads the page — which, in kiosk mode with no chrome and a hidden
pointer, means somebody with a keyboard.

**Fix:** listen for `webglcontextlost` on the renderer canvas, `preventDefault()`
it, and on `webglcontextrestored` rebuild the VHSC pass and geometry — or, as
the pragmatic kiosk answer, just `location.reload()`. A watchdog in the page
(a heartbeat that reloads if the render loop has not ticked in N seconds)
covers the same class of failure more broadly, including a wedged MediaPipe.

Related: the page has no `window.onerror` handler and `client.js` has no
`disconnect`/`reconnect` logging, so when something does go wrong on site
there is nothing to look at.

## 10. `windowResized` leaks a WebGL context per resize

**`public/index.html:266-274`**

Each resize calls `vhscGfx.remove()` and creates a new WEBGL `p5.Graphics`
plus a new shader. `remove()` frees the element but browsers cap live GL
contexts (~16 in Chrome) and drop the oldest when the cap is hit — which is
one way to reach §9 by yourself. In fullscreen kiosk mode resizes are rare,
so this is latent rather than active; it would bite a machine that changes
display mode or rotates.

**Fix:** `resizeCanvas` the existing graphics buffer instead of rebuilding it.

---

## Smaller items

**`pollChain` can overlap itself.** `app.js:328` — `setInterval(pollChain, 30_000)`
with a 20 s per-request timeout and a catch-up loop of up to 10 reads. A slow
TzKT makes a poll outlast its interval; two concurrent runs both read the same
`lastSeenId` and each broadcasts the same token and calls `rpiCycle.minted()`.
Guard with an `inFlight` flag.

**The slideshow re-reads its file list from disk on every slide.**
`app.js:671-677` — `slideshowFiles()` reads and parses `nap-list.json` on every
local turn, i.e. every other tick, forever. Cache it with a long TTL or an
`fs.watch`.

**`tokenCache` evicts by insertion order, not use.** `app.js:179-180` —
`tokenCache.delete(tokenCache.keys().next().value)` drops the oldest *inserted*
entry, and a cache hit doesn't refresh its position. With `TOKEN_CACHE_MAX = 500`
this is harmless now, but once the contract passes 500 tokens the Pi cycle —
which walks newest→#0 over and over — will evict exactly the entries it is
about to want, and every slide becomes a TzKT round trip. Move the key to the
end on hit.

**`readToken` has no in-flight dedup.** Concurrent requests for the same id
each fire their own TzKT fetch. Cheap to fix by caching the promise.

**The MediaPipe throttle is off, and the comment says otherwise.**
`drawing.js:15` — `MP_SKIP = 1` with `if (++mpFrameCount >= MP_SKIP)` runs the
recognizer on *every* webcam frame; the comment still says "every 2nd webcam
frame (~15fps)". Commit 22dcde8 ("frame skip 1") suggests this was deliberate,
so the code may be right and the comment stale — but as written the knob reads
as if it's doing something it isn't. `MP_SKIP = 2` is the first thing to try if
the installation machine can't hold frame rate.

**`tools/brush-geometry` doesn't run.** It imports `BRUSH_OVERLAP_PASSES` from
`public/js/drawing/tools.js`, which no longer exports it:

```
SyntaxError: The requested module '../../public/js/drawing/tools.js'
does not provide an export named 'BRUSH_OVERLAP_PASSES'
```

ARCHITECTURE.md names this as the tool for diagnosing a drawing that arrives on
the Pi with pieces missing — which is precisely the kind of fault a long run
will surface. Worth repairing before the installation goes up rather than
during it.

**Log volume.** `sendNaplpsToRpi` logs a line per slide (~8,600/day at a 10 s
interval), and `photo`/`photo_saved`/`unknown` frames each log too. Harmless
under journald, worth a thought if output is being redirected to a file on the
Pi's SD card.

**`package.json` has no `engines` field.** The code uses `AbortSignal.timeout`
(Node ≥ 17.3) and global `fetch` (Node ≥ 18). Worth pinning so a machine with
an older Node fails loudly at install rather than at the first chain read.

---

## If you only do three things

1. **Cache the per-stroke mesh in `Frame._refreshGeometry()`** (§1). It is the
   difference between attract mode running indefinitely and attract mode
   grinding the machine down every few minutes.
2. **Put the server under a supervisor** and add the two process handlers (§2).
3. **Point the page at the vendored libraries** (§6), so a network problem
   can't stop the artwork coming up.

§3 (ws heartbeat) and §9 (context loss) are the next two, and both are small.
