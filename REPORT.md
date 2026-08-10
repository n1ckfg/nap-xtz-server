# Separating Tezos logic from the site

2026-08-09

All Tezos blockchain logic has moved out of `public/` and into `app.js`. The
backend now runs independently of the site and passes NAPLPS-encoded drawings
around as messages.

## What moved

Everything chain-shaped came out of `public/js/tezos/tezos.js` (315 lines → 217,
now wallet-only) and into a marked **TEZOS** section in `app.js`:

- Contract address and network endpoints (TzKT, RPC, explorer)
- Hex ↔ byte codecs for NAPLPS payloads
- Payload validation against the ~32 KB Tezos operation limit
- Michelson construction for the `mint` entrypoint
- Chain reads from the `token_metadata` bigmap
- A poller that watches the contract for newly minted tokens

Configuration is env-driven (`env_backup` documents the keys); defaults match
the previously hardcoded Shadownet values, so nothing needs to be set to keep
working as before.

## What stayed in the browser, and why

Signing. A wallet key belongs to the user, so Beacon has to stay client side.
The backend builds and validates the operation; the browser only signs it, then
the backend's watcher notices the resulting token and pushes it out as a
message.

For genuinely headless minting there is `POST /api/tezos/mint`, which activates
when you set `TEZOS_SECRET_KEY` and install Taquito:

```
npm install @taquito/taquito @taquito/signer
```

Without it the route returns 501 pointing at the wallet path, so nothing breaks
if it is never configured.

## Drawings as messages

One fanout feeds both transports (socket.io and plain `ws`). Drawings travel as

```js
{ type: "naplps", source, naplps, ... }
```

whatever their origin — minted on chain, POSTed to `/api/naplps`, or drawn live
in a connected client. New clients are handed the latest token on connect.

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /api/config` | Wallet settings for the browser (network, RPC, size limit) |
| `GET /api/health` | Contract, latest token id, connected client counts |
| `GET /api/tezos/latest` | Latest minted drawing (`?refresh=1` to skip cache) |
| `GET /api/tezos/token/:id` | One token's NAPLPS |
| `GET /api/tezos/tokens?limit=` | Recent token ids |
| `POST /api/tezos/mint-params` | Unsigned mint operation for a wallet to sign |
| `POST /api/tezos/mint` | Headless mint (needs `TEZOS_SECRET_KEY` + Taquito) |
| `POST /api/tezos/minted` | Wallet mint went out; poll sooner |
| `POST /api/naplps` | Broadcast a drawing to all clients, no chain involved |

## Files changed

| File | Change |
| --- | --- |
| `app.js` | 124 → 555 lines. Added TEZOS, MESSAGES, and API sections. |
| `public/js/net/client.js` | **New.** `NapClient` — the page's only link to the backend. Knows HTTP routes and socket messages; never contracts, TzKT, RPC, or Michelson. |
| `public/js/tezos/tezos.js` | Reduced to a wallet shim: Beacon connect/disconnect, signing, and rendering pushed drawings. |
| `public/index.html` | Added `/socket.io/socket.io.js` and `js/net/client.js` script tags. |
| `package.json` | Added `ws@^8`, bumped `socket.io` to `^4.8.1`. |
| `env_backup` | Documented the Tezos environment keys. |
| `public/ARCHITECTURE.md` | Documented the split, the backend, and the API. |

After the split, the only chain-related things left anywhere in `public/` are the
wallet buttons, their CSS, and the Beacon SDK script tag.

## Verification

Run against the live Shadownet contract, which the server reads on boot
(`[tezos] latest token on chain: #8`).

- **API surface** — all routes exercised, including 400s on oversize and
  missing-owner payloads, a 501 on unconfigured headless mint, and a clean 404
  for a nonexistent token.
- **Message fanout** — both transports receive the on-connect token push and
  REST broadcasts; a `ws` client's drawing reaches a socket.io client; oversize
  payloads are rejected rather than relayed.
- **Byte fidelity** — the server's hex round-trip is byte-identical to the old
  browser decoder on real token data (27,444 bytes), so there is no risk of
  corrupting drawings.
- **Browser** — headless Chrome loads the page with no errors, pulls token #8
  through the backend, renders it, and picks up a drawing pushed externally via
  `POST /api/naplps`.

### Bugs fixed in passing

- **`ws` was missing from `package.json`** and `socket.io` was pinned to
  `1.2.0` — the server could not start on Node 26 at all.
- **`const debug = process.env.DEBUG || "true"`** is a string, so `!debug` was
  always false and the https/redirect branch was dead code; production has been
  serving plain http. It now parses properly, but falls back to http with a
  warning if the cert files are unreadable, so setting `DEBUG=false` cannot
  strand the deploy.
- **TzKT returns an empty `204`** for a missing bigmap key, which threw a JSON
  parse error instead of yielding a 404.

## Known wart

`index.html` calls `loadLatestToken()` in `preload()` *and* the socket delivers
the same token on connect, so the latest drawing loads twice on page open. It is
harmless — the second render replaces the first — but the `preload()` call can be
dropped if relying on the socket alone is acceptable.
