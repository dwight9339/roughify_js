/*
  roughify-svg.js
  A CLI utility that converts an input SVG into a hand‑drawn RoughJS PNG or MP4.

  Usage:
    node roughify-svg.js <path/to/file.svg> [options]

  Options:
    --numFrames <n>   Number of frames to render. Default = 1 (single PNG)
    --frameRate <fps> Frame rate for the final MP4 when numFrames > 1. Default = 24
    --exportFrames    If present, keep individual PNG frames in a sibling folder
                      called <svgName>_frames. Otherwise frames are deleted after
                      the MP4 is produced.
*/

import { readFileSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { dirname, extname, basename, join } from "path";
import { createCanvas } from "canvas";
import * as commander from "commander";
import { DOMParser } from "xmldom";
import rough from "roughjs/bundled/rough.cjs.js";
import ffmpeg from "fluent-ffmpeg";

// ─────────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────────

const program = new commander.Command();

program
  .argument("<svgPath>", "Path to an SVG file")
  .option("--numFrames <n>", "Number of frames to render", parseInt)
  .option("--frameRate <fps>", "Frame rate for MP4", parseInt)
  .option("--exportFrames", "Keep the individual PNGs on disk")
  .parse(process.argv);

const opts = program.opts();
const svgPath = program.args[0];

// Defaults
const NUM_FRAMES = opts.numFrames && opts.numFrames > 0 ? opts.numFrames : 1;
const FRAME_RATE = opts.frameRate && opts.frameRate > 0 ? opts.frameRate : 24;
const EXPORT_FRAMES = !!opts.exportFrames;

// ─────────────────────────────────────────────────────────────────────────────
// Read & parse SVG
// ─────────────────────────────────────────────────────────────────────────────

const svgString = readFileSync(svgPath, "utf8");
const dom = new DOMParser().parseFromString(svgString, "image/svg+xml");
const svgRoot = dom.documentElement;

const width = parseFloat(svgRoot.getAttribute("width")) || 800;
const height = parseFloat(svgRoot.getAttribute("height")) || 800;

// Collect drawable nodes
const DRAWABLE = ["path", "rect", "circle", "ellipse", "line", "polygon", "polyline"];
const elements = [];

function collect(node) {
  if (DRAWABLE.includes(node.nodeName)) elements.push(node);
  if (node.hasChildNodes())
    for (let i = 0; i < node.childNodes.length; i++) collect(node.childNodes[i]);
}
collect(svgRoot);

// ─────────────────────────────────────────────────────────────────────────────
// Style helpers (simple subset)
// ─────────────────────────────────────────────────────────────────────────────

let uid = 0;
function ensureId(el) {
  if (!el.getAttribute("id")) el.setAttribute("id", "__el" + uid++);
  return el.getAttribute("id");
}

function idQueryParams(el) {
  const id = el.getAttribute("id") || "";
  const qIndex = id.indexOf("?");
  if (qIndex === -1) return {};
  const query = id.slice(qIndex + 1);
  return Object.fromEntries(query.split("&").map(s => s.split("=").map(decodeURIComponent)));
}

function resolveStyle(el) {
  const style = { stroke: "black", fill: "none", strokeWidth: 1, fillStyle: "solid" };
  let node = el;
  const visited = new Set();
  while (node && !visited.has(node)) {
    visited.add(node);
    if (node.getAttribute) {
      if (node.getAttribute("stroke")) style.stroke = node.getAttribute("stroke");
      if (node.getAttribute("fill")) style.fill = node.getAttribute("fill");
      if (node.getAttribute("stroke-width")) style.strokeWidth = parseFloat(node.getAttribute("stroke-width"));
      Object.assign(style, idQueryParams(node));
    }
    node = node.parentNode;
  }
  return style;
}

const styleMap = new Map();
for (const el of elements) {
  const id = ensureId(el);
  styleMap.set(id, resolveStyle(el));
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawing helpers
// ─────────────────────────────────────────────────────────────────────────────

function parsePoints(attr) {
    const nums = attr.trim()
                     .split(/[\s,]+/)
                     .map(Number)
                     .filter(Number.isFinite);
  
    const pts = [];
    for (let i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    return pts;
}

function drawElement(rc, el) {
  const id = el.getAttribute("id");
  const s = styleMap.get(id);
  const tag = el.nodeName;

  if (tag === "path") {
    rc.path(el.getAttribute("d"), s);
  } else if (tag === "rect") {
    rc.rectangle(parseFloat(el.getAttribute("x")) || 0,
                 parseFloat(el.getAttribute("y")) || 0,
                 parseFloat(el.getAttribute("width")) || 0,
                 parseFloat(el.getAttribute("height")) || 0,
                 s);
  } else if (tag === "circle") {
    rc.circle(parseFloat(el.getAttribute("cx")), parseFloat(el.getAttribute("cy")),
              parseFloat(el.getAttribute("r")) * 2, s);
  } else if (tag === "ellipse") {
    rc.ellipse(parseFloat(el.getAttribute("cx")), parseFloat(el.getAttribute("cy")),
               parseFloat(el.getAttribute("rx")) * 2, parseFloat(el.getAttribute("ry")) * 2, s);
  } else if (tag === "line") {
    rc.line(parseFloat(el.getAttribute("x1")), parseFloat(el.getAttribute("y1")),
            parseFloat(el.getAttribute("x2")), parseFloat(el.getAttribute("y2")), s);
  } else if (tag === "polygon" || tag === "polyline") {
    const pts = parsePoints(el.getAttribute("points"));
    if (tag === "polygon") rc.polygon(pts, s);
    else rc.linearPath(pts, s);
  }
}

function renderFrame(frameIndex) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  const rc = rough.canvas(canvas);

  // Example per‑frame tweak: seed changes gives subtle variation
  elements.forEach(el => drawElement(rc, el));
  return canvas;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main rendering logic
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  const base = basename(svgPath, extname(svgPath));
  if (NUM_FRAMES === 1) {
    const canvas = renderFrame(0);
    const outPath = join(dirname(svgPath), `${base}.png`);
    writeFileSync(outPath, canvas.toBuffer("image/png"));
    console.log(`✓ Wrote ${outPath}`);
    return;
  }

  // Multi‑frame path
  const frameDir = join(dirname(svgPath), `${base}_frames`);
  mkdirSync(frameDir, { recursive: true });

  for (let i = 0; i < NUM_FRAMES; i++) {
    const canvas = renderFrame(i);
    const framePath = join(frameDir, `${base}_${i.toString().padStart(4, "0")}.png`);
    writeFileSync(framePath, canvas.toBuffer("image/png"));
    process.stdout.write(`Rendered frame ${i + 1}/${NUM_FRAMES}\r`);
  }
  console.log("\n✓ Frames ready");

  // Assemble MP4
  const mp4Path = join(dirname(svgPath), `${base}.mp4`);
  await new Promise((res, rej) => {
    ffmpeg()
      .addInput(join(frameDir, `${base}_%04d.png`))
      .inputFPS(FRAME_RATE)
      .outputFPS(FRAME_RATE)
      .videoCodec("libx264")
      .outputOptions("-pix_fmt yuv420p")
      .save(mp4Path)
      .on("end", res)
      .on("error", rej);
  });
  console.log(`✓ Wrote ${mp4Path}`);

  if (!EXPORT_FRAMES) {
    rmSync(frameDir, { recursive: true, force: true });
    console.log("Temporary frame folder deleted");
  } else {
    console.log(`Frames kept in ${frameDir}`);
  }
})();
