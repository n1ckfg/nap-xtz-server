/*
Runs public/js/telidon/naplps.js — the same decoder the browser uses, unmodified
— inside a vm context so the CLI and the web client can never drift apart.

Two details make this work:

  * naplps.js reaches for p5's pow() and int() in NapDataArray, so the sandbox
    supplies them, and it publishes its classes on `window`, so the sandbox has
    one of those too. Nothing else in the decoder touches the browser or p5.
  * The decoder keeps its parser state (colour map, cursor, operand lengths) in
    module-level `naplps_*` variables. Each decode gets a fresh context so one
    file can't inherit the palette or domain of the one before it.
*/
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const NAPLPS_JS = path.resolve(here, "../../public/js/telidon/naplps.js");

const script = new vm.Script(fs.readFileSync(NAPLPS_JS, "utf8"), { filename: NAPLPS_JS });

const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };

// p5's int(): booleans become 1/0, everything else truncates toward zero.
function int(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : 0;
}

export function decodeNap(text, { verbose = false } = {}) {
  const sandbox = { console: verbose ? console : quiet, pow: Math.pow, int, window: {} };
  script.runInContext(vm.createContext(sandbox));
  return new sandbox.window.NapDecoder([text]);
}
