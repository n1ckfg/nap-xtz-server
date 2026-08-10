/*
Vendors three.js into public/js/libraries/threejs: the core build plus the
addons index.html needs, resolving their relative imports recursively so nothing
is missed. Run after bumping the "three" dependency:

    npm install three@latest
    node tools/vendor-three.mjs
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules/three");
const dest = path.join(root, "public/js/libraries/threejs");

const entries = [
  "examples/jsm/postprocessing/EffectComposer.js",
  "examples/jsm/postprocessing/RenderPass.js",
  "examples/jsm/postprocessing/ShaderPass.js",
  "examples/jsm/postprocessing/UnrealBloomPass.js",
  "examples/jsm/postprocessing/OutputPass.js",
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;

const seen = new Set();
const queue = [...entries];

while (queue.length > 0) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);

  const code = fs.readFileSync(path.join(src, rel), "utf8");
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue; // bare "three" -> import map
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    queue.push(resolved);
  }
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// Core build. three.module.js imports ./three.core.js relatively.
for (const f of ["three.module.js", "three.core.js", "three.module.min.js", "three.core.min.js"]) {
  fs.copyFileSync(path.join(src, "build", f), path.join(dest, f));
}

// Addons, flattened to addons/<category>/<file> preserving relative layout.
for (const rel of [...seen].sort()) {
  const out = path.join(dest, "addons", rel.replace(/^examples\/jsm\//, ""));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(path.join(src, rel), out);
}

const version = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version;
fs.writeFileSync(
  path.join(dest, "VERSION.txt"),
  `three.js ${version}\n\nCore build (three.module.js + three.core.js) and the addons used by\npublic/index.html, copied from the npm "three" package. Regenerate with:\n\n    npm install three@latest\n    node tools/vendor-three.mjs\n`
);

console.log(`three ${version}`);
console.log([...seen].sort().join("\n"));
