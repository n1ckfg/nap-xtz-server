"use strict";

// ─── Wallet shim ──────────────────────────────────────────────────────────────
// The one piece of the Tezos flow that can't move to the backend: a wallet key
// belongs to the user, so signing happens here. Everything else -- contract
// address, network endpoints, hex encoding, Michelson, chain reads -- lives in
// app.js and reaches this page through NapClient (js/net/client.js).

// ─── State ────────────────────────────────────────────────────────────────────
let _beaconClient  = null;
let _activeAccount = null;
let _config        = null;   // served by GET /api/config

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(msg, isError) {
    const el = document.getElementById("tezos-status");
    if (!el) return;
    el.innerHTML = msg;
    el.style.color = isError ? "#ff6666" : "#ffcc00";
}

function setSize(msg, isError) {
    const el = document.getElementById("tezos-size");
    if (!el) return;
    const limit = _config ? _config.maxNaplpsBytes : 30000;
    if (isError || parseInt(msg) > limit) {
        el.style.color = "#ff6666";
        el.textContent = "size: " + msg + " ... too large";
    } else {
        el.style.color = "#ccff00";
        el.textContent = "size: " + msg + " ... ready to publish";
    }
}

function updateWalletUI() {
    const btnConnect    = document.getElementById("btn-connect");
    const btnDisconnect = document.getElementById("btn-disconnect");
    const addrEl        = document.getElementById("tezos-address");

    if (_activeAccount) {
        if (btnConnect)    btnConnect.style.display    = "none";
        if (btnDisconnect) btnDisconnect.style.display = "inline-block";
        if (addrEl) {
            const addr = _activeAccount.address;
            addrEl.textContent = addr.slice(0, 6) + "..." + addr.slice(-4);
            addrEl.title = addr;
        }
    } else {
        if (btnConnect)    btnConnect.style.display    = "inline-block";
        if (btnDisconnect) btnDisconnect.style.display = "none";
        if (addrEl) addrEl.textContent = "";
    }
}

// ─── Initialization ───────────────────────────────────────────────────────────
async function initTezos() {
    try {
        _config = await NapClient.getConfig();

        // Drawings pushed by the backend (newly minted tokens, other clients,
        // POSTs to /api/naplps) render as soon as they arrive.
        NapClient.connect();
        NapClient.onNaplps(function(message) {
            loadTelidonFromText(message.naplps);
            if (message.source === "chain") {
                noteTokenShown(message.id, message.link); // a new mint becomes the arrow keys' right-hand end
                setStatus(tokenLink("Token #" + message.id, message.link) + " loaded from chain");
            } else {
                setStatus("Drawing received (" + (message.source || "server") + ")");
            }
        });

        // Support multiple possible UMD global names for the Beacon SDK bundle.
        const SDK = window.BeaconDapp || window.beaconDapp || window.beacon;
        if (!SDK || !SDK.DAppClient) {
            console.warn("Beacon SDK not detected — wallet features disabled.");
            setStatus("Wallet SDK unavailable", true);
            return;
        }

        // Beacon SDK v4+: network must be declared at construction time.
        // Shadownet is a custom network; the RPC URL comes from the server.
        _beaconClient = new SDK.DAppClient({
            name: "NAP-XTZ",
            network: { type: "custom", name: _config.network, rpcUrl: _config.rpcUrl },
            // Disable deprecated P2P matrix relay (papers.tech servers are offline).
            enableMetrics: false,
            featuresConfig: {
                network: {
                    // Skip P2P pairing entirely - use only WalletConnect/extensions.
                    enableP2P: false
                }
            }
        });

        // Beacon SDK v4+ requires an explicit subscriber for ACTIVE_ACCOUNT_SET
        // to avoid "no active subscription" warnings on every account change.
        if (SDK.BeaconEvent && _beaconClient.subscribeToEvent) {
            await _beaconClient.subscribeToEvent(
                SDK.BeaconEvent.ACTIVE_ACCOUNT_SET,
                (account) => {
                    _activeAccount = account || null;
                    updateWalletUI();
                }
            );
        }

        // Restore an existing wallet session on page load.
        const existing = await _beaconClient.getActiveAccount();
        if (existing) {
            _activeAccount = existing;
            updateWalletUI();
        }

    } catch (e) {
        console.error("initTezos:", e);
        setStatus("Tezos init error: " + e.message, true);
    }
}

// ─── Wallet connection ────────────────────────────────────────────────────────
async function connectWallet() {
    if (!_beaconClient) { setStatus("SDK not ready", true); return; }
    try {
        setStatus("Opening wallet...");
        console.log("[nap-xtz] requestPermissions...");
        // Network was set at DAppClient construction — do not pass it here.
        await _beaconClient.requestPermissions();
        _activeAccount = await _beaconClient.getActiveAccount();
        console.log("[nap-xtz] connected:", _activeAccount?.address);
        updateWalletUI();
        setStatus("Wallet connected");

        // Show Mint button if there is pending NAPLPS data.
        if (window.pendingNapRaw) {
            const btn = document.getElementById("btn-mint");
            if (btn) btn.style.display = "inline-block";
        }
    } catch (e) {
        console.error("connectWallet:", e);
        setStatus("Connect failed: " + e.message, true);
    }
}

async function disconnectWallet() {
    if (!_beaconClient) return;
    try {
        await _beaconClient.clearActiveAccount();
        _activeAccount = null;
        updateWalletUI();
        setStatus("Disconnected");
        const btnMint = document.getElementById("btn-mint");
        if (btnMint) btnMint.style.display = "none";
    } catch (e) {
        console.error("disconnectWallet:", e);
    }
}

// ─── Minting ──────────────────────────────────────────────────────────────────
// Two routes to the same contract call. The backend builds the operation and
// validates the payload either way; what differs is who holds the key. Once
// it's out, the backend's watcher picks up the new token and pushes it back as
// a message, so there's nothing to poll for here.
//
// Both routes resolve to { ok, hash } or { ok: false, error }. The status line
// below is invisible in drawing mode, so the gesture caller in js/drawing/ has
// to be able to read the outcome and post it over the drawing itself.
async function mintCurrentNaplps() {
    console.log("[nap-xtz] mintCurrentNaplps called");

    const napRaw = window.pendingNapRaw;
    if (!napRaw) {
        setStatus("Load some NAPLPS graphics first", true);
        console.warn("[nap-xtz] no pendingNapRaw");
        return { ok: false, error: "Nothing to mint" };
    }

    // The config picks the route, so fetch it if a gesture beat initTezos to it.
    if (!_config) {
        try { _config = await NapClient.getConfig(); } catch (e) { /* wallet route */ }
    }

    // When the backend holds a key it signs for itself, and no wallet UI opens.
    // That's the unattended-kiosk case: the mint gesture in js/drawing/ has no
    // way to drive a Temple popup, and nobody is there to approve one.
    if (_config && _config.serverSigning) return serverMint(napRaw);

    // Auto-connect if no wallet is active yet.
    if (!_activeAccount) {
        console.log("[nap-xtz] no active account — triggering connectWallet");
        await connectWallet();
        if (!_activeAccount) {
            console.warn("[nap-xtz] wallet connection cancelled or failed");
            return { ok: false, error: "Wallet not connected" };
        }
    }

    try {
        setStatus("Preparing mint...");
        const params = await NapClient.getMintParams(napRaw, _activeAccount.address);

        setStatus("Sending mint transaction...");
        console.log("[nap-xtz] signing mint, napRaw length:", napRaw.length);
        const result = await _beaconClient.requestOperation({ operationDetails: params.operationDetails });
        console.log("[nap-xtz] requestOperation result:", result);

        setStatus("Transaction sent, waiting for confirmation...");
        NapClient.notifyMinted(result && result.transactionHash);
        return { ok: true, hash: result && result.transactionHash };
    } catch (e) {
        console.error("[nap-xtz] mint error:", e);
        setStatus("Mint failed: " + (e.message || e), true);
        return { ok: false, error: e.message || String(e) };
    }
}

// Server-side signing: the backend signs with the key in its .env and waits for
// a confirmation, so the token is on chain by the time this resolves. A
// connected wallet still gets to own the token; with none, the server's own
// address does.
async function serverMint(napRaw) {
    try {
        setStatus("Minting...");
        console.log("[nap-xtz] server mint, napRaw length:", napRaw.length);
        const result = await NapClient.mint(napRaw, _activeAccount ? _activeAccount.address : null);
        console.log("[nap-xtz] server mint result:", result);

        const base = _config && _config.explorerBase;
        const hash = result && result.hash;
        setStatus(base && hash
            ? '<a href="' + base + "/" + hash + '" target="_blank" style="color: inherit; text-decoration: underline;">' +
              "Minted</a> — waiting for it to appear"
            : "Minted — waiting for it to appear");
        return { ok: true, hash: hash };
    } catch (e) {
        console.error("[nap-xtz] server mint error:", e);
        setStatus("Mint failed: " + (e.message || e), true);
        return { ok: false, error: e.message || String(e) };
    }
}

// ─── Reading from chain ───────────────────────────────────────────────────────
// A request to the backend, which owns the TzKT queries and the byte decoding.
//
// `toRpi` is the "latest" link's doing: clicking it puts the drawing on the Pi
// as well as this canvas, the way slideshow frames go out. The automatic load
// when the page opens leaves the Pi alone -- reloading a browser is not a
// decision to change what the Pi is showing.
//
// Two ids say where the arrow keys are. `_currentTokenId` is the token on the
// canvas and stays null until one has arrived from the chain -- which is what
// keeps the arrows quiet on a page showing only a dropped file. `_latestTokenId`
// is the far end, and moves as the watcher announces new mints. Neither is
// disturbed by a drawing from anywhere else, so a dropped file or a peer's
// drawing leaves the reader where it was on the chain.
let _currentTokenId = null;
let _latestTokenId  = null;
let _tokenLoading   = false;   // one read at a time, so a held arrow key can't queue them

let _tokenLink = null;

function noteTokenShown(id, link) {
    if (typeof id !== "number" || isNaN(id)) return;
    _currentTokenId = id;
    if (_latestTokenId === null || id > _latestTokenId) _latestTokenId = id;
    if (link) _tokenLink = link;
}

// Wraps a status line's subject in the explorer link. Every token points at the
// same page -- the contract's operations -- so the last link seen serves for the
// ends of the chain, where there is no token in hand, and the config's copy
// covers a page that has yet to load one.
function tokenLink(text, link) {
    const href = link || _tokenLink ||
                 (_config ? _config.explorerBase + "/" + _config.contract + "/operations/" : "#");
    return '<a href="' + href + '" target="_blank" style="color: inherit; text-decoration: underline;">' +
           text + "</a>";
}

async function loadLatestToken(toRpi) {
    try {
        setStatus("Loading latest token from chain...");
        const token = await NapClient.getLatest();
        console.log("[nap-xtz] loaded from chain, NAPLPS length:", token.naplps.length);
        loadTelidonFromText(token.naplps);
        if (toRpi) NapClient.sendToRpi(token.naplps, "latest");
        noteTokenShown(token.id, token.link);

        setStatus(tokenLink("Latest token", token.link) + " loaded from chain");
    } catch (e) {
        console.warn("[nap-xtz] loadLatestToken error:", e);
        setStatus("Chain read failed — using local samples");
    }
}

// One token by id, which is how the arrow keys read. It goes to the Pi as well,
// for the same reason the "latest" link does: pressing an arrow is a decision to
// change what is on screen, and the Pi follows the screen.
async function loadToken(id) {
    if (_tokenLoading) return;
    _tokenLoading = true;
    try {
        setStatus("Loading token #" + id + " from chain...");
        const token = await NapClient.getToken(id);
        console.log("[nap-xtz] loaded token #" + id + ", NAPLPS length:", token.naplps.length);
        loadTelidonFromText(token.naplps);
        NapClient.sendToRpi(token.naplps, "browse");
        noteTokenShown(token.id, token.link);

        setStatus(tokenLink("Token #" + token.id, token.link) + " loaded from chain");
    } catch (e) {
        console.warn("[nap-xtz] loadToken " + id + ":", e);
        if (e.status === 404) {
            // An id with no drawing behind it -- minted by some other tool, with
            // no naplps in its metadata. The position moves onto the gap anyway,
            // so the next press carries on past it instead of hitting it again.
            _currentTokenId = id;
            setStatus("Token #" + id + " has nothing to show", true);
        } else {
            // A read that failed: stay put, and the same key tries again.
            setStatus("Token #" + id + " could not be read", true);
        }
    } finally {
        _tokenLoading = false;
    }
}

// A step back or forward along the chain -- the arrow keys in review mode (the
// handler is in index.html, with the rest of the key handling). Before the first
// chain read there is no position to step from, and at either end there is
// nowhere to go, so those presses only say why.
function stepToken(delta) {
    if (_currentTokenId === null || _tokenLoading) return;

    const id = _currentTokenId + delta;
    if (id < 0) {
        setStatus(tokenLink("Token #0") + " is the earliest on chain");
        return;
    }
    if (_latestTokenId !== null && id > _latestTokenId) {
        setStatus(tokenLink("Token #" + _latestTokenId) + " is the newest on chain");
        return;
    }

    loadToken(id);
}
