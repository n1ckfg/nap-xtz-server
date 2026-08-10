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
                const link = message.link || (_config.explorerBase + "/" + _config.contract + "/operations/");
                setStatus('<a href="' + link + '" target="_blank" style="color: inherit; text-decoration: underline;">' +
                          'Token #' + message.id + "</a> loaded from chain");
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
// The backend builds the operation and validates the payload; the wallet signs
// it. Once it's out, the backend's watcher picks up the new token and pushes it
// back as a message, so there's nothing to poll for here.
async function mintCurrentNaplps() {
    console.log("[nap-xtz] mintCurrentNaplps called");

    const napRaw = window.pendingNapRaw;
    if (!napRaw) {
        setStatus("Load some NAPLPS graphics first", true);
        console.warn("[nap-xtz] no pendingNapRaw");
        return;
    }

    // Auto-connect if no wallet is active yet.
    if (!_activeAccount) {
        console.log("[nap-xtz] no active account — triggering connectWallet");
        await connectWallet();
        if (!_activeAccount) {
            console.warn("[nap-xtz] wallet connection cancelled or failed");
            return;
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
    } catch (e) {
        console.error("[nap-xtz] mint error:", e);
        setStatus("Mint failed: " + (e.message || e), true);
    }
}

// ─── Reading from chain ───────────────────────────────────────────────────────
// A request to the backend, which owns the TzKT queries and the byte decoding.
async function loadLatestToken() {
    try {
        setStatus("Loading latest token from chain...");
        const token = await NapClient.getLatest();
        console.log("[nap-xtz] loaded from chain, NAPLPS length:", token.naplps.length);
        loadTelidonFromText(token.naplps);

        const link = token.link || "#";
        setStatus('<a href="' + link + '" target="_blank" style="color: inherit; text-decoration: underline;">' +
                  "Latest token</a> loaded from chain");
    } catch (e) {
        console.warn("[nap-xtz] loadLatestToken error:", e);
        setStatus("Chain read failed — using local samples");
    }
}
