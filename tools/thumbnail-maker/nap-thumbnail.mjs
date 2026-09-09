#!/usr/bin/env node
/*
nap-thumbnail — renders NAPLPS .nap files to PNG screenshots.

Each input file is decoded with public/js/telidon/naplps.js (the browser's own
decoder) and drawn the way public/index.html draws it, then written next to the
source with the same basename:

    node tools/thumbnail-maker/nap-thumbnail.mjs public/images
    node tools/thumbnail-maker/nap-thumbnail.mjs -w 320 -o thumbs public/images/*.nap

No dependencies — the rasteriser and PNG writer live alongside this file.
*/
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { renderNap } from "./render.mjs";
import { encodePNG } from "./png.mjs";

const USAGE = `Usage: nap-thumbnail [options] <file-or-directory ...>

Renders each .nap file to a .png of the same basename.

Options:
  -o, --out <dir>    write PNGs to <dir> (default: beside the .nap file)
  -w, --width <px>   output width; height follows the 4:3 screen (default: 640)
  -v, --verbose      pass the decoder's own logging through to stderr
  -h, --help         show this message
`;

function napFilesIn(target) {
  if (fs.statSync(target).isDirectory()) {
    return fs
      .readdirSync(target)
      .filter((name) => name.toLowerCase().endsWith(".nap"))
      .sort()
      .map((name) => path.join(target, name));
  }
  return [target];
}

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        width: { type: "string", short: "w", default: "640" },
        verbose: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }

  const { values, positionals } = args;
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    process.exit(positionals.length === 0 && !values.help ? 2 : 0);
  }

  const width = Number(values.width);
  if (!Number.isFinite(width) || width < 16) {
    console.error(`Invalid --width: ${values.width}`);
    process.exit(2);
  }
  if (values.out) fs.mkdirSync(values.out, { recursive: true });

  const inputs = [];
  for (const target of positionals) {
    try {
      inputs.push(...napFilesIn(target));
    } catch (err) {
      console.error(`${target}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  let done = 0;
  for (const file of inputs) {
    const out = path.join(values.out ?? path.dirname(file), `${path.basename(file, path.extname(file))}.png`);
    try {
      const started = Date.now();
      // The browser reads .nap files as UTF-8 text; decode the same way.
      const { width: w, height, pixels, stats } = renderNap(fs.readFileSync(file, "utf8"), {
        width,
        verbose: values.verbose,
      });
      fs.writeFileSync(out, encodePNG(w, height, pixels));

      const notes = [`Telidon ${stats.version}`, `${stats.commands} cmds`];
      if (stats.text > 0) notes.push(`${stats.text} text cmd(s) not rendered`);
      console.log(`${out}  ${w}x${height}  ${notes.join(", ")}  ${((Date.now() - started) / 1000).toFixed(2)}s`);
      done++;
    } catch (err) {
      console.error(`${file}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  if (inputs.length > 1) console.log(`\n${done}/${inputs.length} rendered`);
}

main();
