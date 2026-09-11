// TEZOS_MAX_BYTES: the largest drawing, in bytes, the server will mint.
//
// app.js reads it here before anything starts, and hands it to the page through
// GET /api/config; tools/brush-geometry reads it here too, so the tool and the
// mint agree on what fits.
//
// The reading is strict. parseInt alone would take "30,000" as 30 and "30k" as
// 30, and "abc" as NaN -- the worst of them, since no size is greater than NaN,
// so the size check would pass every drawing however big.

// A whole Tezos operation is capped at 32,768 bytes (max_operation_data_length
// in the node's protocol constants); this leaves room for the rest of the mint.
const DEFAULT_MINT_LIMIT = 30000;

// { value, fromDefault } -- or { error } when the setting is there but isn't a
// whole number above zero. Unset, empty or blank means the default.
function readMintLimit(env = process.env) {
  const raw = env.TEZOS_MAX_BYTES;
  const text = raw === undefined ? '' : String(raw).trim();
  if (text === '') return { value: DEFAULT_MINT_LIMIT, fromDefault: true };

  if (!/^\d+$/.test(text) || Number(text) < 1) {
    return {
      error: `TEZOS_MAX_BYTES=${JSON.stringify(raw)} is not a size in bytes: ` +
             `it takes a whole number above zero, like ${DEFAULT_MINT_LIMIT}.`
    };
  }
  return { value: Number(text), fromDefault: false };
}

module.exports = { DEFAULT_MINT_LIMIT, readMintLimit };
