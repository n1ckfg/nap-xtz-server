"use strict";

const express = require("express");
const app = express();

const cmd = require("node-cmd");
const crypto = require("crypto");
const bodyParser = require("body-parser");

const fs = require("fs");
const dotenv = require("dotenv").config();

// DEBUG arrives from the environment as a string, so "false" is still truthy.
// Only an explicit "false" turns on the https/redirect production path.
const debug = String(process.env.DEBUG || "true").toLowerCase() !== "false";

let options;
let secure = !debug;
if (secure) {
    try {
        options = {
            key: fs.readFileSync(process.env.KEY_PATH),
            cert: fs.readFileSync(process.env.CERT_PATH)
        };
    } catch (e) {
        console.warn("\nTLS key/cert unavailable (" + e.message + ") -- falling back to http.");
        secure = false;
    }
}

const https = require("https").createServer(options, app);

// default -- pingInterval: 1000 * 25, pingTimeout: 1000 * 60
// low latency -- pingInterval: 1000 * 5, pingTimeout: 1000 * 10
let io, http;
const ping_interval = 1000 * 5;
const ping_timeout = 1000 * 10;
const port_http = process.env.PORT_HTTP || 8080;
const port_https = process.env.PORT_HTTPS || 443;
const port_ws = process.env.PORT_WS || 4321;

const WebSocket = require("ws");
const ws = new WebSocket.Server({ port: port_ws, pingInterval: ping_interval, pingTimeout: ping_timeout }, function() {
    console.log("\nNode.js listening on websocket port " + port_ws);
});

if (secure) {
    http = require("http");

    http.createServer(function(req, res) {
        res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
        res.end();
    }).listen(port_http);

    io = require("socket.io")(https, {
        pingInterval: ping_interval,
        pingTimeout: ping_timeout
    });
} else {
    http = require("http").Server(app);

    io = require("socket.io")(http, {
        pingInterval: ping_interval,
        pingTimeout: ping_timeout
    });
}

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
// TEZOS
//
// All blockchain logic lives here, not in public/. The browser never talks to
// TzKT, the RPC, or the contract directly -- it only signs, because a wallet
// key can't leave the user's machine. Everything else (chain reads, hex
// codecs, Michelson construction, new-token polling) runs server side, so the
// backend works headlessly with no page open.
// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

const TEZOS = {
    // After deploying fa2-naplps.mligo, set TEZOS_CONTRACT in .env.
    contract:     process.env.TEZOS_CONTRACT  || "KT1DypSEV87pwiw6swdYqhDKWRBZ7xfqeS3c",
    tzktBase:     process.env.TZKT_BASE       || "https://api.shadownet.tzkt.io/v1",
    rpcUrl:       process.env.TEZOS_RPC       || "https://rpc.shadownet.teztnets.com",
    networkName:  process.env.TEZOS_NETWORK   || "shadownet",
    explorerBase: process.env.TEZOS_EXPLORER  || "https://shadownet.tzkt.io",
    // Tezos operations have a ~32 KB hard limit; leave headroom for the envelope.
    maxNaplpsBytes: parseInt(process.env.TEZOS_MAX_BYTES || "30000", 10),
    pollInterval:   parseInt(process.env.TEZOS_POLL_SECONDS || "30", 10) * 1000,
    requestTimeout: parseInt(process.env.TEZOS_TIMEOUT_SECONDS || "20", 10) * 1000,
    // Catch-up cap, so a long outage doesn't fire off hundreds of reads at once.
    maxCatchUp:     parseInt(process.env.TEZOS_MAX_CATCHUP || "10", 10)
};

// ─── Byte helpers ─────────────────────────────────────────────────────────────
// NAPLPS is a byte stream carried in a JS string, so latin1 maps 1 char : 1 byte.
function stringToHex(str) {
    return Buffer.from(str, "latin1").toString("hex");
}

function hexToString(hex) {
    return Buffer.from(hex.replace(/^0x/, ""), "hex").toString("latin1");
}

// ─── Validation ───────────────────────────────────────────────────────────────
// Returns an error string, or null when the payload is fit to mint/broadcast.
function checkNaplps(napRaw) {
    if (typeof napRaw !== "string" || napRaw.length === 0) return "NAPLPS payload missing or empty";
    if (napRaw.length > TEZOS.maxNaplpsBytes) {
        return "NAPLPS too large (" + (napRaw.length / 1024).toFixed(1) + " KB). Max " +
               (TEZOS.maxNaplpsBytes / 1024).toFixed(1) + " KB.";
    }
    return null;
}

// ─── Chain reads (TzKT) ───────────────────────────────────────────────────────
// Returns null for "no such thing" -- TzKT answers a missing bigmap key with an
// empty 204, so an absent token is not an error to throw over.
async function tzktFetch(path) {
    const res = await fetch(TEZOS.tzktBase + path, {
        headers: { "accept": "application/json" },
        signal: AbortSignal.timeout(TEZOS.requestTimeout)
    });
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) throw new Error("TzKT " + res.status + " for " + path);

    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

async function readNextTokenId() {
    const storage = await tzktFetch("/contracts/" + TEZOS.contract + "/storage");
    const nextId = parseInt((storage && storage.next_token_id) || "0", 10);
    return isNaN(nextId) ? 0 : nextId;
}

// Reads one token's NAPLPS bytes out of the token_metadata bigmap.
async function readToken(id) {
    const entry = await tzktFetch(
        "/contracts/" + TEZOS.contract + "/bigmaps/token_metadata/keys/" + id
    );

    if (!entry) return null;

    const hexNaplps = entry.value && entry.value.token_info && entry.value.token_info.naplps;
    if (!hexNaplps) {
        console.warn("[tezos] token " + id + " has no 'naplps' key in token_info");
        return null;
    }

    return {
        id: id,
        naplps: hexToString(hexNaplps),
        link: TEZOS.explorerBase + "/" + TEZOS.contract + "/operations/"
    };
}

async function readLatestToken() {
    const nextId = await readNextTokenId();
    if (nextId === 0) return null;
    return await readToken(nextId - 1);
}

// ─── Minting ──────────────────────────────────────────────────────────────────
// Michelson JSON for the "mint" entrypoint parameter.
// LIGO sorts record fields alphabetically, so the compiled type is:
//   mint (pair (map %metadata string bytes) (address %to_))
// i.e. metadata first, to_ second.
function buildMintOperation(napRaw, ownerAddress) {
    const mintValue = {
        prim: "Pair",
        args: [
            [
                {
                    prim: "Elt",
                    args: [
                        { string: "naplps" },
                        { bytes: stringToHex(napRaw) }
                    ]
                }
            ],
            { string: ownerAddress }
        ]
    };

    return [
        {
            kind: "transaction",
            destination: TEZOS.contract,
            amount: "0",
            parameters: {
                entrypoint: "mint",
                value: mintValue
            }
        }
    ];
}

// Optional headless minting. Only active when TEZOS_SECRET_KEY is set *and*
// Taquito is installed (npm install @taquito/taquito @taquito/signer);
// otherwise the browser wallet signs the operation built above.
let _toolkit;
async function getToolkit() {
    if (_toolkit !== undefined) return _toolkit;
    _toolkit = null;

    if (!process.env.TEZOS_SECRET_KEY) return _toolkit;

    try {
        const { TezosToolkit } = require("@taquito/taquito");
        const { InMemorySigner } = require("@taquito/signer");
        const toolkit = new TezosToolkit(TEZOS.rpcUrl);
        toolkit.setProvider({ signer: await InMemorySigner.fromSecretKey(process.env.TEZOS_SECRET_KEY) });
        _toolkit = toolkit;
        console.log("[tezos] server-side signer enabled");
    } catch (e) {
        console.warn("[tezos] server-side signing unavailable: " + e.message);
    }

    return _toolkit;
}

async function serverMint(napRaw, ownerAddress) {
    const toolkit = await getToolkit();
    if (!toolkit) throw new Error("Server-side signing is not configured");

    const { MichelsonMap } = require("@taquito/taquito");
    const owner = ownerAddress || await toolkit.signer.publicKeyHash();

    const metadata = new MichelsonMap();
    metadata.set("naplps", stringToHex(napRaw));

    const contract = await toolkit.contract.at(TEZOS.contract);
    const op = await contract.methodsObject.mint({ metadata: metadata, to_: owner }).send();
    await op.confirmation(1);

    return { hash: op.hash, owner: owner };
}

// ─── New-token watcher ────────────────────────────────────────────────────────
// Polls the contract and pushes anything new out as a message, so clients get
// fresh drawings without asking, and the backend keeps working with none open.
let latestToken = null;   // last token read, served to clients on connect
let lastSeenId = -1;
let pollTimer = null;

async function pollChain() {
    try {
        const nextId = await readNextTokenId();
        if (nextId === 0) return;

        const latestId = nextId - 1;

        // First poll: prime the cache without replaying history as "new".
        if (lastSeenId < 0) {
            lastSeenId = latestId;
            latestToken = await readToken(latestId);
            if (latestToken) console.log("[tezos] latest token on chain: #" + latestToken.id);
            return;
        }

        if (latestId <= lastSeenId) return;

        const from = Math.max(lastSeenId + 1, latestId - TEZOS.maxCatchUp + 1);
        for (let id = from; id <= latestId; id++) {
            const token = await readToken(id);
            if (!token) continue;
            latestToken = token;
            console.log("[tezos] new token #" + id + " (" + token.naplps.length + " bytes)");
            broadcast("naplps", { source: "chain", id: token.id, link: token.link, naplps: token.naplps });
        }
        lastSeenId = latestId;
    } catch (e) {
        console.warn("[tezos] poll failed: " + e.message);
    }
}

function startWatcher() {
    if (pollTimer !== null) return;
    pollChain();
    pollTimer = setInterval(pollChain, TEZOS.pollInterval);
    console.log("\n[tezos] watching " + TEZOS.contract + " on " + TEZOS.networkName +
                " every " + (TEZOS.pollInterval / 1000) + "s");
}

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
// MESSAGES
//
// One fanout for both transports. NAPLPS drawings travel as messages of the
// shape { type: "naplps", source, naplps, ... } whatever their origin: minted
// on chain, posted to the REST API, or drawn live in a connected client.
// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

// Every message carries an id. Servers linked in both directions -- or in a
// ring -- would otherwise hand the same drawing back and forth forever, since a
// message arriving from a peer looks like any other client's.
const SERVER_ID = crypto.randomUUID().slice(0, 8);
const MAX_SEEN = 500;
let messageCounter = 0;
const seenOrder = [];              // ids, oldest first
const seenIds = new Set();

function nextMessageId() {
    return SERVER_ID + "-" + (++messageCounter);
}

// Records the id and reports whether it had already been through here.
function alreadySeen(mid) {
    if (!mid) return false;
    if (seenIds.has(mid)) return true;

    seenIds.add(mid);
    seenOrder.push(mid);
    if (seenOrder.length > MAX_SEEN) seenIds.delete(seenOrder.shift());
    return false;
}

function broadcast(type, payload, exceptSocket) {
    const message = Object.assign({ type: type, at: Date.now() }, payload);

    // A relayed message keeps the id it arrived with, so it stays recognisable
    // wherever it travels next.
    if (!message.mid) message.mid = nextMessageId();
    alreadySeen(message.mid);

    const encoded = JSON.stringify(message);

    // socket.io: a generic "message" event plus a per-type one for convenience.
    if (exceptSocket && exceptSocket.broadcast) {
        exceptSocket.broadcast.emit("message", message);
        exceptSocket.broadcast.emit(type, message);
    } else {
        io.emit("message", message);
        io.emit(type, message);
    }

    // plain ws
    ws.clients.forEach(function(client) {
        if (client !== exceptSocket && client.readyState === WebSocket.OPEN) client.send(encoded);
    });

    // a peer server, if one is linked (see OTHER SERVERS)
    forwardToPeer(message);

    return message;
}

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
// OTHER SERVERS
//
// Two outbound links, both optional and both off unless configured, so the
// server still runs on its own:
//
//   1. A peer nap-xtz server, so two installations share their drawings.
//   2. A Raspberry Pi running Pinopticon (openFrameworks), which sends camera
//      data in and takes NAPLPS drawings out.
//
// Both are connections we open; the inbound side is still the ws/socket.io
// servers above. See rpi-client.js for the Pinopticon protocol's quirks.
// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

const { RpiClient } = require("./rpi-client");

const PEER = {
    // e.g. ws://other-host:8090 -- blank leaves the peer link switched off.
    url:        process.env.PEER_WS_URL || "",
    retryDelay: parseInt(process.env.PEER_RETRY_SECONDS || "2", 10) * 1000
};

const RPI = {
    // e.g. nfg-rpi-3-4.local -- blank leaves the Pi link switched off.
    host:       process.env.RPI_HOST || "",
    port:       parseInt(process.env.RPI_PORT || "7112", 10),
    streamPort: parseInt(process.env.RPI_STREAM_PORT || "7111", 10),
    // How a drawing is framed for the Pi: json | base64 | raw (see rpiNaplpsFrame).
    naplpsFormat: String(process.env.RPI_NAPLPS_FORMAT || "json").toLowerCase(),
    // A drawing sent to the Pi is not going into a Tezos operation, so the
    // ~32 KB mint ceiling doesn't apply -- plenty of the .nap files the
    // slideshow plays are larger than that. This is only a sanity bound.
    maxBytes: parseInt(process.env.RPI_MAX_BYTES || "1000000", 10)
};

// Same shape as checkNaplps, against the Pi's limit rather than the chain's.
function checkNaplpsForRpi(napRaw) {
    if (typeof napRaw !== "string" || napRaw.length === 0) return "NAPLPS payload missing or empty";
    if (napRaw.length > RPI.maxBytes) {
        return "NAPLPS too large for the RPi link (" + (napRaw.length / 1024).toFixed(1) + " KB). Max " +
               (RPI.maxBytes / 1024).toFixed(1) + " KB.";
    }
    return null;
}

// ─── Peer server ──────────────────────────────────────────────────────────────
let peerSocket = null;

function connectToPeer() {
    if (!PEER.url) return;

    const peer = new WebSocket(PEER.url);

    // ws always emits 'close' after 'error', so both handlers fire on a failed
    // attempt. Without this guard each failure would schedule two retries, and
    // the retry rate would double every cycle.
    let retryScheduled = false;
    function retry(reason) {
        if (retryScheduled) return;
        retryScheduled = true;
        peerSocket = null;
        console.log("[peer] " + reason + ", retrying in " + (PEER.retryDelay / 1000) + "s...");
        setTimeout(connectToPeer, PEER.retryDelay);
    }

    peer.on("open", function() {
        peerSocket = peer;
        console.log("[peer] connected to " + PEER.url);
        // Hand the peer whatever is current, the same as a browser gets.
        if (latestToken) {
            peer.send(JSON.stringify({
                type: "naplps", at: Date.now(), source: "chain", mid: nextMessageId(),
                id: latestToken.id, link: latestToken.link, naplps: latestToken.naplps
            }));
        }
    });

    peer.on("message", function(data) {
        let payload;
        try {
            payload = JSON.parse(data.toString());
        } catch (e) {
            console.log("[peer] " + data.toString().slice(0, 120));
            return;
        }
        if (payload.type !== "naplps") return;
        if (alreadySeen(payload.mid)) return;   // already been round this way
        if (checkNaplps(payload.naplps)) return;

        // Tagging it "peer" is what keeps broadcast() from sending it back.
        broadcast("naplps", {
            source: "peer", mid: payload.mid,
            id: payload.id, link: payload.link, naplps: payload.naplps
        });
    });

    peer.on("error", function() { retry("connection failed"); });
    peer.on("close", function() { retry("disconnected"); });
}

// Drawings we originate go to the peer as well; ones that arrived *from* the
// peer don't, since it already has them.
function forwardToPeer(message) {
    if (!peerSocket || peerSocket.readyState !== WebSocket.OPEN) return;
    if (message.type !== "naplps" || message.source === "peer") return;
    peerSocket.send(JSON.stringify(message));
}

// ─── Raspberry Pi ─────────────────────────────────────────────────────────────
const rpi = RPI.host
    ? new RpiClient({ host: RPI.host, port: RPI.port, streamPort: RPI.streamPort })
    : null;

// Camera data reaches the browser the same way drawings do -- as a message.
// The Pi's own frame type becomes 'event', since 'type' names the transport.
function relayFromRpi(event, payload) {
    broadcast("rpi", Object.assign({ source: "rpi", event: event }, payload));
}

function startRpi() {
    if (!rpi) return;

    rpi.on("open",         function()      { console.log("[rpi] connected to " + rpi.url); });
    rpi.on("close",        function(code)  { console.log("[rpi] disconnected (" + code + ")"); });
    rpi.on("error",        function(err)   { console.log("[rpi] error: " + err.message); });
    rpi.on("reconnecting", function(delay) { console.log("[rpi] retrying in " + delay + "ms..."); });

    rpi.on("photo_saved", function(msg) {
        const url = rpi.photoUrl(msg.filename);
        console.log("[rpi] saved photo: " + url);
        relayFromRpi("photo_saved", { hostname: msg.hostname, url: url });
    });

    rpi.on("photo", function(msg) {
        console.log("[rpi] photo: " + msg.jpeg.length + " bytes from " + msg.hostname);
        relayFromRpi("photo", { hostname: msg.hostname, jpeg: msg.jpeg.toString("base64") });
    });

    rpi.on("video", function(msg) {
        relayFromRpi("video", { hostname: msg.hostname, jpeg: msg.jpeg.toString("base64") });
    });

    // Vision data passes through as it comes, minus the Pi's own 'type' field.
    ["blob", "pixel", "contour"].forEach(function(event) {
        rpi.on(event, function(msg) {
            const payload = Object.assign({}, msg);
            delete payload.type;
            relayFromRpi(event, payload);
        });
    });

    rpi.on("unknown", function(msg) {
        console.log("[rpi] unrecognized frame: " + msg.raw.slice(0, 120));
    });

    console.log("\n[rpi] linking to " + rpi.url);
    rpi.connect();
}

// One drawing, framed for the Pi. Pinopticon only acts on the text it knows
// ("take_photo"/"stream_photo") and logs anything else, so an unfamiliar frame
// is safe to send whichever shape it takes.
function rpiNaplpsFrame(napRaw, source) {
    // raw: the NAPLPS stream alone, for a receiver that wants no envelope.
    if (RPI.naplpsFormat === "raw") return napRaw;

    const useBase64 = RPI.naplpsFormat === "base64";

    return JSON.stringify({
        type: "naplps",
        source: source || "server",
        bytes: napRaw.length,
        // NAPLPS is a 7-bit-safe format, so its bytes survive a JSON string
        // intact. base64 is there for payloads that use the high half anyway,
        // and matches how the Pi sends its own binary (photo/video/points).
        encoding: useBase64 ? "base64" : "text",
        naplps: useBase64 ? Buffer.from(napRaw, "latin1").toString("base64") : napRaw
    });
}

function sendNaplpsToRpi(napRaw, source) {
    if (!rpi) return false;

    const sent = rpi.send(rpiNaplpsFrame(napRaw, source));
    if (sent) {
        console.log("[rpi] sent NAPLPS (" + napRaw.length + " bytes, " + (source || "server") + ")");
    } else {
        console.log("[rpi] offline, dropped NAPLPS (" + napRaw.length + " bytes)");
    }
    return sent;
}

// Commands ofApp::onWebSocketFrameReceivedEvent() acts on.
const RPI_COMMANDS = ["take_photo", "stream_photo"];

function sendCommandToRpi(command) {
    if (!rpi || RPI_COMMANDS.indexOf(command) < 0) return false;

    const sent = rpi.send(command);
    if (!sent) console.log("[rpi] offline, dropped \"" + command + "\"");
    return sent;
}

// ~ ~ ~ ~

app.use(express.static("public"));

// https://opensourcelibs.com/lib/glitchub
app.use(bodyParser.json({ limit: "1mb" }));

const onWebhook = (req, res) => {
  let hmac = crypto.createHmac("sha1", process.env.SECRET);
  let sig  = `sha1=${hmac.update(JSON.stringify(req.body)).digest("hex")}`;

  if (req.headers["x-github-event"] === "push" && sig === req.headers["x-hub-signature"]) {
    cmd.run("chmod +x ./redeploy.sh");
    cmd.run("./redeploy.sh");
    cmd.run("refresh");
  }

  return res.sendStatus(200);
}

app.post("/redeploy", onWebhook);

app.get("/", function(req, res) {
    res.sendFile(__dirname + "/public/index.html");
});

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
// API
// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

// Everything the browser needs to open a wallet -- and nothing it needs to
// read the chain, which is the backend's job.
app.get("/api/config", async function(req, res) {
    res.json({
        contract: TEZOS.contract,
        network: TEZOS.networkName,
        rpcUrl: TEZOS.rpcUrl,
        explorerBase: TEZOS.explorerBase,
        maxNaplpsBytes: TEZOS.maxNaplpsBytes,
        serverSigning: (await getToolkit()) !== null,
        wsPort: port_ws,
        // So the page knows whether sending a drawing onward is worth the trip.
        rpiEnabled: rpi !== null
    });
});

app.get("/api/health", function(req, res) {
    res.json({
        ok: true,
        contract: TEZOS.contract,
        network: TEZOS.networkName,
        latestTokenId: latestToken ? latestToken.id : null,
        socketClients: io.engine ? io.engine.clientsCount : 0,
        wsClients: ws.clients.size,
        peer: {
            url: PEER.url || null,
            connected: peerSocket !== null && peerSocket.readyState === WebSocket.OPEN
        },
        rpi: {
            url: rpi ? rpi.url : null,
            connected: rpi !== null && rpi.connected
        }
    });
});

// Latest minted drawing. Served from cache unless ?refresh=1.
app.get("/api/tezos/latest", async function(req, res) {
    try {
        if (!latestToken || req.query.refresh) {
            const token = await readLatestToken();
            if (token) latestToken = token;
        }
        if (!latestToken) return res.status(404).json({ error: "No tokens on chain yet" });
        res.json(latestToken);
    } catch (e) {
        console.warn("[tezos] /api/tezos/latest: " + e.message);
        res.status(502).json({ error: e.message });
    }
});

app.get("/api/tezos/token/:id", async function(req, res) {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 0) return res.status(400).json({ error: "Bad token id" });

    try {
        const token = await readToken(id);
        if (!token) return res.status(404).json({ error: "Token " + id + " not found" });
        res.json(token);
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

app.get("/api/tezos/tokens", async function(req, res) {
    try {
        const nextId = await readNextTokenId();
        const limit = Math.min(parseInt(req.query.limit || "20", 10) || 20, 100);
        const ids = [];
        for (let id = nextId - 1; id >= 0 && ids.length < limit; id--) ids.push(id);
        res.json({ count: nextId, ids: ids });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// Build an unsigned mint operation for a browser wallet to sign.
app.post("/api/tezos/mint-params", function(req, res) {
    const napRaw = req.body && req.body.naplps;
    const owner  = req.body && req.body.owner;

    const problem = checkNaplps(napRaw);
    if (problem) return res.status(400).json({ error: problem });
    if (!owner) return res.status(400).json({ error: "Owner address missing" });

    res.json({
        operationDetails: buildMintOperation(napRaw, owner),
        bytes: napRaw.length
    });
});

// Headless mint, when the server holds a key (see getToolkit).
app.post("/api/tezos/mint", async function(req, res) {
    const napRaw = req.body && req.body.naplps;

    const problem = checkNaplps(napRaw);
    if (problem) return res.status(400).json({ error: problem });

    if (!(await getToolkit())) {
        return res.status(501).json({
            error: "Server-side signing is not configured. Set TEZOS_SECRET_KEY and install " +
                   "@taquito/taquito + @taquito/signer, or sign in the browser via /api/tezos/mint-params."
        });
    }

    try {
        const result = await serverMint(napRaw, req.body.owner);
        pollChain(); // announce the new token without waiting for the next tick
        res.json(result);
    } catch (e) {
        console.error("[tezos] server mint failed: " + e.message);
        res.status(502).json({ error: e.message });
    }
});

// A wallet-signed mint landed; look for it rather than waiting a full interval.
app.post("/api/tezos/minted", function(req, res) {
    const hash = req.body && req.body.hash;
    console.log("[tezos] mint submitted by wallet: " + (hash || "(no hash)"));
    // Shadownet block time is ~15 s, plus TzKT indexing lag.
    setTimeout(pollChain, 20000);
    setTimeout(pollChain, 45000);
    res.json({ ok: true });
});

// Push a drawing to every connected client without touching the chain.
app.post("/api/naplps", function(req, res) {
    const napRaw = req.body && req.body.naplps;

    const problem = checkNaplps(napRaw);
    if (problem) return res.status(400).json({ error: problem });

    const message = broadcast("naplps", {
        source: (req.body && req.body.source) || "api",
        naplps: napRaw
    });

    res.json({ ok: true, at: message.at, bytes: napRaw.length });
});

// ─── Raspberry Pi ─────────────────────────────────────────────────────────────

app.get("/api/rpi/status", function(req, res) {
    res.json({
        enabled: rpi !== null,
        connected: rpi !== null && rpi.connected,
        url: rpi ? rpi.url : null,
        naplpsFormat: RPI.naplpsFormat
    });
});

// Send one drawing to the Pi -- and only to the Pi. This is the slideshow's
// route: those frames are already on the client's canvas, so broadcasting them
// to every other client would be a round trip to nowhere.
app.post("/api/rpi/naplps", function(req, res) {
    const napRaw = req.body && req.body.naplps;

    const problem = checkNaplpsForRpi(napRaw);
    if (problem) return res.status(400).json({ error: problem });
    if (!rpi) return res.status(501).json({ error: "No RPi configured. Set RPI_HOST in .env." });

    const sent = sendNaplpsToRpi(napRaw, (req.body && req.body.source) || "api");
    res.json({ ok: true, sent: sent, bytes: napRaw.length });
});

app.post("/api/rpi/command", function(req, res) {
    const command = req.body && req.body.command;

    if (RPI_COMMANDS.indexOf(command) < 0) {
        return res.status(400).json({ error: "Unknown command. Try: " + RPI_COMMANDS.join(", ") });
    }
    if (!rpi) return res.status(501).json({ error: "No RPi configured. Set RPI_HOST in .env." });

    res.json({ ok: true, sent: sendCommandToRpi(command) });
});

// ~ ~ ~ ~

if (secure) {
    https.listen(port_https, function() {
        console.log("\nNode.js listening on https port " + port_https);
    });
} else {
    http.listen(port_http, function() {
        console.log("\nNode.js listening on http port " + port_http);
    });
}

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

io.on("connection", function(socket) {
    console.log("A socket.io user connected.");
    //~
    socket.on("disconnect", function(event) {
        console.log("A socket.io user disconnected.");
    });
    //~
    // Hand the newcomer whatever is current so it has something to draw.
    if (latestToken) {
        socket.emit("naplps", {
            type: "naplps",
            at: Date.now(),
            source: "chain",
            id: latestToken.id,
            link: latestToken.link,
            naplps: latestToken.naplps
        });
    }
    //~
    // A client drawing live (or replaying a file) shares it with everyone else.
    socket.on("naplps", function(data) {
        const payload = typeof data === "string" ? { naplps: data } : (data || {});
        const problem = checkNaplps(payload.naplps);
        if (problem) {
            socket.emit("error_message", { type: "error_message", error: problem });
            return;
        }
        broadcast("naplps", { source: payload.source || "client", naplps: payload.naplps }, socket);
    });
    //~
    // A drawing meant for the Pi alone -- what slideshow mode sends.
    socket.on("rpi_naplps", function(data) {
        const payload = typeof data === "string" ? { naplps: data } : (data || {});
        const problem = checkNaplpsForRpi(payload.naplps);
        if (problem) {
            socket.emit("error_message", { type: "error_message", error: problem });
            return;
        }
        sendNaplpsToRpi(payload.naplps, payload.source || "client");
    });
    //~
    // Let clients drive the Pi's camera.
    socket.on("rpi_command", function(data) {
        sendCommandToRpi(typeof data === "string" ? data : (data && data.command));
    });
});

ws.on("connection", function(socket) {
    console.log("A ws user connected.");
    //~
    socket.onclose = function(event) {
        console.log("A ws user disconnected.");
    };
    //~
    if (latestToken) {
        socket.send(JSON.stringify({
            type: "naplps",
            at: Date.now(),
            source: "chain",
            id: latestToken.id,
            link: latestToken.link,
            naplps: latestToken.naplps
        }));
    }
    //~
    socket.onmessage = function(event) {
        const text = String(event.data);

        // Bare camera commands, as the Pinopticon clients send them.
        if (RPI_COMMANDS.indexOf(text) >= 0) {
            sendCommandToRpi(text);
            return;
        }

        let payload;
        try {
            payload = JSON.parse(text);
        } catch (e) {
            payload = { naplps: text };
        }

        if (payload.type === "rpi_command") {
            sendCommandToRpi(payload.command);
            return;
        }

        // A peer server reaches us here too, so drop anything that has already
        // been through this server (see alreadySeen).
        if (alreadySeen(payload.mid)) return;

        const forRpiOnly = payload.type === "rpi_naplps";
        if (payload.type && payload.type !== "naplps" && !forRpiOnly) return;

        // The Pi and the chain hold drawings to different size limits.
        const problem = forRpiOnly ? checkNaplpsForRpi(payload.naplps) : checkNaplps(payload.naplps);
        if (problem) {
            socket.send(JSON.stringify({ type: "error_message", error: problem }));
            return;
        }

        if (forRpiOnly) {
            sendNaplpsToRpi(payload.naplps, payload.source || "client");
            return;
        }
        broadcast("naplps", {
            source: payload.source || "client", mid: payload.mid, naplps: payload.naplps
        }, socket);
    };
});

// ~ ~ ~ ~

startWatcher();
connectToPeer();
startRpi();
