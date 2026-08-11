"use strict";

// ─── NapClient ────────────────────────────────────────────────────────────────
// The page's only link to the backend. It knows about HTTP routes and socket
// messages -- never about contracts, TzKT, RPC nodes, or Michelson. Anything
// blockchain-shaped lives in app.js; the drawings arrive here as messages.

const NapClient = (function() {

    let _config = null;
    let _socket = null;
    const _naplpsHandlers = [];

    async function api(path, options) {
        const res = await fetch(path, options);
        let body = null;
        try { body = await res.json(); } catch (e) { /* empty or non-JSON body */ }
        if (!res.ok) throw new Error((body && body.error) || (path + " failed: " + res.status));
        return body;
    }

    // Server-supplied settings (network, rpc, size limit) fetched once.
    async function getConfig() {
        if (!_config) _config = await api("/api/config");
        return _config;
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
        });

        _socket.on("naplps", function(message) {
            if (!message || !message.naplps) return;
            console.log("[nap-client] naplps message from " + (message.source || "?") +
                        ", " + message.naplps.length + " bytes");
            _naplpsHandlers.forEach(function(handler) { handler(message); });
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
        notifyMinted: notifyMinted,
        connect: connect,
        onNaplps: onNaplps,
        publish: publish,
        sendToRpi: sendToRpi,
        rpiCommand: rpiCommand
    };

})();

window.NapClient = NapClient;
