// RippleReview proxy maker.
//
// Drop a master export into the drop folder. This reads the job code from the
// file name (NIL-10), finds that project inside the Dropbox app folder, makes
// a small H.264 review copy, names it _PREVIEW_… and puts it there. The master
// never goes into Dropbox: it moves to _masters next to the drop folder.
//
//   node tools/proxy.mjs                 once over whatever is waiting
//   node tools/proxy.mjs --watch         keep watching (what the .command does)
//   node tools/proxy.mjs file.mp4        just this file
//
// Needs ffmpeg (already installed).

import { spawn } from "node:child_process";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();
const DROP = process.env.RR_DROP ?? path.join(HOME, "Desktop", "RippleDrop");
const APP = process.env.RR_APP ?? path.join(HOME, "Dropbox", "Apps", "RippleReview");
const DONE = path.join(DROP, "_masters");
const STUCK = path.join(DROP, "_unsorted");

const VIDEO = /\.(mp4|m4v|mov|mkv|avi|mxf|webm)$/i;
const JOB = /^([A-Za-z]{2,4})[-_ ]?(\d{1,3})$/;
// Cut markers look like job codes (SF-01); they are never the job.
const MARKERS = new Set(["sf", "lf", "tr", "reel", "promo", "bts", "teaser", "v"]);

// Target for the review copy. ~4-5 Mbit/s at 1080p, keyframe every second so
// scrubbing lands where you expect.
const BITRATE = process.env.RR_BITRATE ?? "4.5M";
const MAXRATE = process.env.RR_MAXRATE ?? "6M";

const say = (...parts) => console.log(...parts);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n").slice(-3).join("\n")))));
  });
}

async function probe(file) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ]);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => {
      const [width, height, rate] = out.trim().split("\n");
      const [num, den] = (rate ?? "25/1").split("/").map(Number);
      resolve({ width: Number(width) || 1920, height: Number(height) || 1080, fps: Math.round((num / (den || 1)) || 25) });
    });
  });
}

// Every project folder under every client, so a job code can find its home.
async function projects() {
  const found = [];
  for (const client of await readdir(APP, { withFileTypes: true })) {
    if (!client.isDirectory() || client.name.startsWith(".")) continue;
    const clientPath = path.join(APP, client.name);
    for (const project of await readdir(clientPath, { withFileTypes: true })) {
      if (!project.isDirectory() || project.name.startsWith(".")) continue;
      found.push({ client: client.name, project: project.name, dir: path.join(clientPath, project.name) });
    }
  }
  return found;
}

// The code is a whole piece of the name, not a substring: splitting first
// keeps the file extension and markers like SF-01 out of it.
const codeOf = (name) => {
  const stem = name.replace(/\.[^.]+$/, "");
  for (const part of stem.split(/[_\s]+/).filter(Boolean)) {
    const match = JOB.exec(part);
    if (match && !MARKERS.has(match[1].toLowerCase())) return `${match[1].toUpperCase()}-${Number(match[2])}`;
  }
  return null;
};

function destinationFor(name, all) {
  const code = codeOf(name);
  if (!code) return { reason: "no job code in the file name" };
  const hits = all.filter((entry) => codeOf(entry.project) === code);
  if (!hits.length) return { reason: `no project folder for ${code}` };
  if (hits.length > 1) return { reason: `${code} matches ${hits.length} folders` };
  return { target: hits[0], code };
}

const previewName = (name) => {
  const stem = name.replace(/\.[^.]+$/, "");
  return `${/^_preview_/i.test(stem) ? stem : `_PREVIEW_${stem}`}.mp4`;
};

async function makeProxy(file) {
  const name = path.basename(file);
  const all = await projects();
  const { target, code, reason } = destinationFor(name, all);

  if (!target) {
    await mkdir(STUCK, { recursive: true });
    await rename(file, path.join(STUCK, name));
    say(`  ✗ ${name}\n    ${reason} → moved to _unsorted`);
    return false;
  }

  const { width, height, fps } = await probe(file);
  const vertical = height > width;
  // Cap the long edge at 1080 and keep the shape; -2 keeps dimensions even.
  const scale = vertical ? "scale=-2:'min(1080,ih)'" : "scale='min(1920,iw)':-2";
  const out = path.join(target.dir, previewName(name));

  say(`  → ${name}\n    ${target.client} / ${target.project}  (${width}×${height}, ${fps} fps)`);
  const started = Date.now();
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", file,
    "-vf", scale,
    "-c:v", "libx264", "-profile:v", "high", "-preset", "medium",
    "-b:v", BITRATE, "-maxrate", MAXRATE, "-bufsize", "12M",
    "-g", String(fps), "-keyint_min", String(fps), "-sc_threshold", "0",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
    "-movflags", "+faststart",
    out,
  ]);

  const size = (await stat(out)).size / 1e6;
  await mkdir(DONE, { recursive: true });
  await rename(file, path.join(DONE, name));
  say(`    ✓ ${path.basename(out)}  ${size.toFixed(0)} MB in ${Math.round((Date.now() - started) / 1000)}s`);
  return true;
}

// A file still being copied grows; wait until its size settles.
async function settled(file) {
  const first = (await stat(file)).size;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return first > 0 && first === (await stat(file)).size;
}

async function sweep() {
  const entries = await readdir(DROP, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && VIDEO.test(entry.name)).map((entry) => path.join(DROP, entry.name));
  for (const file of files) {
    if (!(await settled(file))) continue;                 // still copying
    try {
      await makeProxy(file);
    } catch (error) {
      say(`    ✗ ffmpeg failed: ${error.message}`);
    }
  }
  return files.length;
}

const args = process.argv.slice(2);
await mkdir(DROP, { recursive: true });

if (args.some((arg) => VIDEO.test(arg))) {
  for (const file of args.filter((arg) => VIDEO.test(arg))) await makeProxy(path.resolve(file));
} else if (args.includes("--watch")) {
  say(`Watching ${DROP}\nMasters go to _masters, review copies into Dropbox. Ctrl+C to stop.\n`);
  for (;;) {
    await sweep();
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
} else {
  const count = await sweep();
  if (!count) say(`Nothing waiting in ${DROP}`);
}
