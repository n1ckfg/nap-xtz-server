"use strict";

// ─── NapClient ────────────────────────────────────────────────────────────────
// The page's only link to the backend. It knows about HTTP routes and socket
// messages -- never about contracts, TzKT, RPC nodes, or Michelson. Anything
// blockchain-shaped lives in app.js; the drawings arrive here as messages.

const NapClient = (function() {

    let _configRequest = null;
    let _socket = null;
    // The page's part in the backend's slideshow cycle (rpi-cycle.js), sent whole
    // whenever it changes, and the slideshow's own listeners.
    const _cycle = { drawing: false, slideshow: false, interval: null };
    const _slideHandlers = [];
    const _naplpsHandlers = [];

    async function api(path, options) {
        const res = await fetch(path, options);
        let body = null;
        try { body = await res.json(); } catch (e) { /* empty or non-JSON body */ }
        if (!res.ok) {
            const err = new Error((body && body.error) || (path + " failed: " + res.status));
            err.status = res.status; // lets a caller tell "not there" from "went wrong"
            throw err;
        }
        return body;
    }

    // Server-supplied settings (network, rpc, size limit) fetched once, the one
    // request shared by everything that asks -- the status line and drawing
    // mode both want the size limit from the moment the page opens. A request
    // that fails is forgotten, so the next ask tries again.
    function getConfig() {
        if (!_configRequest) {
            _configRequest = api("/api/config").catch(function(e) {
                _configRequest = null;
                throw e;
            });
        }
        return _configRequest;
    }

    // ── Chain, by proxy ──
    function getLatest() {
        return api("/api/tezos/latest");
    }

    function getToken(id) {
        return api("/api/tezos/token/" + id);
    }

    // Asks the backend to build the mint operation; the wallet only signs it.
    function getMintParams(napRaw, owner) {
        return api("/api/tezos/mint-params", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ naplps: napRaw, owner: owner })
        });
    }

    // Asks the backend to sign and submit the mint itself, with the key in its
    // .env -- no wallet, no popup. Only works when getConfig().serverSigning is
    // true; otherwise the route answers 501 and the wallet has to sign.
    // Resolves once the operation has a confirmation, so it is not quick.
    function mint(napRaw, owner) {
        return api("/api/tezos/mint", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ naplps: napRaw, owner: owner })
        });
    }

    // Tells the backend a wallet-signed mint went out, so it polls sooner.
    function notifyMinted(hash) {
        return api("/api/tezos/minted", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hash: hash })
        }).catch(function(e) { console.warn("[nap-client] notifyMinted:", e.message); });
    }

    // ── Messages ──
    function connect() {
        if (_socket || typeof io === "undefined") return _socket;

        _socket = io();

        _socket.on("connect", function() {
            console.log("[nap-client] connected to server");
            // A restarted server knows nothing of the page's part in the
            // cycle, so say it again.
            _socket.emit("cycle", _cycle);
        });

        _socket.on("naplps", function(message) {
            if (!message || !message.naplps) return;
            console.log("[nap-client] naplps message from " + (message.source || "?") +
                        ", " + message.naplps.length + " bytes");
            _naplpsHandlers.forEach(function(handler) { handler(message); });
        });

        _socket.on("slide", function(slide) {
            if (!slide || !slide.naplps) return;
            _slideHandlers.forEach(function(handler) { handler(slide); });
        });

        _socket.on("error_message", function(message) {
            console.warn("[nap-client] server rejected message:", message && message.error);
        });

        return _socket;
    }

    // Register a callback for incoming drawings, whatever their origin.
    function onNaplps(handler) {
        _naplpsHandlers.push(handler);
    }

    // Share a drawing with every other connected client (no chain involved).
    function publish(napRaw, source) {
        if (!napRaw) return;
        if (_socket) {
            _socket.emit("naplps", { naplps: napRaw, source: source || "client" });
        } else {
            api("/api/naplps", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ naplps: napRaw, source: source || "client" })
            }).catch(function(e) { console.warn("[nap-client] publish:", e.message); });
        }
    }

    // ── Raspberry Pi ──
    // Which Pi, and whether one is even linked, is the backend's business --
    // the page only says what it drew.

    // Send a drawing to the Pi alone, without broadcasting it to other clients.
    function sendToRpi(napRaw, source) {
        if (!napRaw) return;
        if (_socket) {
            _socket.emit("rpi_naplps", { naplps: napRaw, source: source || "client" });
        } else {
            api("/api/rpi/naplps", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ naplps: napRaw, source: source || "client" })
            }).catch(function(e) { console.warn("[nap-client] sendToRpi:", e.message); });
        }
    }

    // A token for the page to draw, which the backend puts on the Pi as it
    // hands it over -- one trip for the drawing, not a round trip. `id` is a
    // token id or "latest".
    function showToken(id, source) {
        return api("/api/rpi/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: id, source: source || "client" })
        });
    }

    // Drawing mode and the review-mode slideshow are both the backend's cycle
    // (rpi-cycle.js): in drawing mode it keeps the Pi busy, and the slideshow
    // gets each slide as well, through onSlide(). Before the socket is up the
    // state waits, and goes out on connecting.
    function setDrawingMode(active, intervalMs) {
        _cycle.drawing = !!active;
        if (intervalMs) _cycle.interval = intervalMs;
        sendCycle();
    }

    function setSlideshow(active, intervalMs) {
        _cycle.slideshow = !!active;
        if (intervalMs) _cycle.interval = intervalMs;
        sendCycle();
    }

    function sendCycle() {
        if (_socket && _socket.connected) _socket.emit("cycle", _cycle);
    }

    // Register a callback for the slideshow's slides: { source, naplps }, plus
    // the token's `id` and `link` or the local `file`.
    function onSlide(handler) {
        _slideHandlers.push(handler);
    }

    // "take_photo" saves a file on the Pi; "stream_photo" sends one back.
    function rpiCommand(command) {
        if (_socket) {
            _socket.emit("rpi_command", { command: command });
        } else {
            api("/api/rpi/command", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ command: command })
            }).catch(function(e) { console.warn("[nap-client] rpiCommand:", e.message); });
        }
    }

    return {
        getConfig: getConfig,
        getLatest: getLatest,
        getToken: getToken,
        getMintParams: getMintParams,
        mint: mint,
        notifyMinted: notifyMinted,
        connect: connect,
        onNaplps: onNaplps,
        publish: publish,
        sendToRpi: sendToRpi,
        showToken: showToken,
        setDrawingMode: setDrawingMode,
        setSlideshow: setSlideshow,
        onSlide: onSlide,
        rpiCommand: rpiCommand
    };

})();

window.NapClient = NapClient;
