/*
Runs public/js/libraries/telidon/naplps.js — the same decoder the browser uses, unmodified
— so the CLI and the web client can never drift apart.
*/
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const NAPLPS_JS = path.resolve(here, "../../public/js/libraries/telidon/naplps.js");

const require = createRequire(import.meta.url);
const NAPLPS = require(NAPLPS_JS);

export function decodeNap(text) {
  if (text.length === 0) throw new Error("file is empty");
  return NAPLPS.decode(text);
}
