"use strict";

// ─── Configuration ────────────────────────────────────────────────────────────
// After deploying fa2-naplps.mligo to Shadownet, paste the resulting KT1 address here.
const CONTRACT_ADDRESS = "KT1DypSEV87pwiw6swdYqhDKWRBZ7xfqeS3c";

const TZKT_BASE     = "https://api.shadownet.tzkt.io/v1";
const SHADOWNET_RPC = "https://rpc.shadownet.teztnets.com";

// ─── State ────────────────────────────────────────────────────────────────────
let _beaconClient  = null;
let _activeAccount = null;

// ─── Byte helpers ─────────────────────────────────────────────────────────────
// Encode a NAPLPS binary string to lowercase hex for on-chain storage.
function stringToHex(str) {
    let hex = "";
    for (let i = 0; i < str.length; i++) {
        hex += str.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return hex;
}

// Decode hex bytes from on-chain storage back to a NAPLPS binary string.
function hexToString(hex) {
    let str = "";
    for (let i = 0; i < hex.length; i += 2) {
        str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return str;
}

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
    if (isError || parseInt(msg) > 30000) {
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
        // Support multiple possible UMD global names for the Beacon SDK bundle.
        const SDK = window.BeaconDapp || window.beaconDapp || window.beacon;
        if (!SDK || !SDK.DAppClient) {
            console.warn("Beacon SDK not detected — wallet features disabled.");
            setStatus("Wallet SDK unavailable", true);
            return;
        }

        // Beacon SDK v4+: network must be declared at construction time.
        // Shadownet is a custom network; specify RPC URL explicitly.
        _beaconClient = new SDK.DAppClient({
            name: "NAP-XTZ",
            network: { type: "custom", name: "shadownet", rpcUrl: SHADOWNET_RPC },
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

        // Try to load the latest on-chain token and render it.
        //await loadLatestToken();

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
async function mintCurrentNaplps() {
    console.log("[nap-xtz] mintCurrentNaplps called");

    const napRaw = window.pendingNapRaw;
    if (!napRaw) {
        setStatus("Load some NAPLPS graphics first", true);
        console.warn("[nap-xtz] no pendingNapRaw");
        return;
    }

    // Tezos operations have a ~32KB hard limit. If napRaw is too large, it will time out or fail.
    if (napRaw.length > 30000) {
        setStatus(`NAPLPS too large (${(napRaw.length / 1024).toFixed(1)} KB). Max 30 KB. Try a simpler image.`, true);
        console.warn("[nap-xtz] napRaw too large:", napRaw.length);
        return;
    }

    if (CONTRACT_ADDRESS === "KT1PLACEHOLDER") {
        setStatus("Contract not deployed — set CONTRACT_ADDRESS in tezos.js", true);
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
        setStatus("Sending mint transaction...");
        console.log("[nap-xtz] calling mintNaplpsToken, napRaw length:", napRaw.length);
        const result = await mintNaplpsToken(napRaw);
        console.log("[nap-xtz] requestOperation result:", result);
        setStatus("Transaction sent, waiting for confirmation...");
        // Shadownet block time ~15 s; allow two blocks + TzKT indexing lag.
        setTimeout(async () => {
            await loadLatestToken();
        }, 45000);
    } catch (e) {
        console.error("[nap-xtz] mint error:", e);
        setStatus("Mint failed: " + (e.message || e), true);
    }
}

async function mintNaplpsToken(napRaw) {
    const ownerAddress = _activeAccount.address;
    const hexBytes     = stringToHex(napRaw);

    // Michelson JSON for the "mint" entrypoint parameter.
    // LIGO sorts record fields alphabetically, so the compiled type is:
    //   mint (pair (map %metadata string bytes) (address %to_))
    // i.e. metadata first, to_ second.
    const mintValue = {
        prim: "Pair",
        args: [
            [
                {
                    prim: "Elt",
                    args: [
                        { string: "naplps" },
                        { bytes: hexBytes }
                    ]
                }
            ],
            { string: ownerAddress }
        ]
    };

    return await _beaconClient.requestOperation({
        operationDetails: [
            {
                kind: "transaction",
                destination: CONTRACT_ADDRESS,
                amount: "0",
                parameters: {
                    entrypoint: "mint",
                    value: mintValue
                }
            }
        ]
    });
}

// ─── Reading from chain ───────────────────────────────────────────────────────
async function loadLatestToken() {
    if (CONTRACT_ADDRESS === "KT1PLACEHOLDER") return;
    try {
        setStatus("Loading latest token from chain...");
        const result = await readLatestNaplps();
        if (result) {
            const { napRaw, latestId } = result;
            console.log("[nap-xtz] loaded from chain, NAPLPS length:", napRaw.length);
            loadTelidonFromText(napRaw);
            
            // If we have an operation hash, use that as the link.
            // Otherwise, fall back to the token view.
            const link = `https://shadownet.tzkt.io/${CONTRACT_ADDRESS}/operations/`; //${latestId}`;

            setStatus(`<a href="${link}" target="_blank" style="color: inherit; text-decoration: underline;">Latest token</a> loaded from chain`);
        } else {
            console.log("[nap-xtz] no tokens on chain yet");
            setStatus("No tokens on chain yet");
        }
    } catch (e) {
        console.warn("[nap-xtz] loadLatestToken error:", e);
        setStatus("Chain read failed — using local samples");
    }
}

async function readLatestNaplps() {
    // 1. Fetch storage to discover next_token_id.
    const storageResp = await fetch(
        `${TZKT_BASE}/contracts/${CONTRACT_ADDRESS}/storage`
    );
    if (!storageResp.ok) throw new Error("Storage fetch failed: " + storageResp.status);
    const storage = await storageResp.json();
    console.log("[nap-xtz] storage:", storage);

    const nextId = parseInt(storage.next_token_id || "0", 10);
    if (isNaN(nextId) || nextId === 0) return null;

    const latestId = nextId - 1;
    console.log("[nap-xtz] fetching token_metadata key:", latestId);

    // 2. Fetch the token_metadata bigmap entry for the latest token.
    const keyResp = await fetch(
        `${TZKT_BASE}/contracts/${CONTRACT_ADDRESS}/bigmaps/token_metadata/keys/${latestId}`
    );
    if (!keyResp.ok) throw new Error("Bigmap key fetch failed: " + keyResp.status);
    const entry = await keyResp.json();
    console.log("[nap-xtz] bigmap entry:", entry);

    const hexNaplps = entry?.value?.token_info?.naplps;
    if (!hexNaplps) {
        console.warn("[nap-xtz] no 'naplps' key in token_info:", entry?.value?.token_info);
        return null;
    }

    console.log("Token url: " + "https://shadownet.tzkt.io/" + entry.hash + "/" + entry.id);

    return {
        napRaw: hexToString(hexNaplps),
        latestId: latestId
    };
}
