// RippleReview proxy maker.
//
// Duplicate an export into RippleDrop, at the top of the ERF_WORK2 drive. This
// reads the job code from the file name (NIL-10), finds that project in the
// RippleReview Dropbox app folder, makes a small H.264 review copy and uploads
// it there as _PREVIEW_…, then uploads the master into the project's hidden
// _MASTERS folder with its specs beside it, so the client can download it once
// they approve that cut. Everything goes from the drive straight to Dropbox:
// nothing large is ever written to this Mac. The duplicate then moves to
// RippleDrop/_uploaded; the original export is never touched.
//
//   node tools/proxy.mjs                 once over whatever is waiting
//   node tools/proxy.mjs --watch         keep watching (what the .command does)
//   node tools/proxy.mjs file.mp4        just this file (left where it is)
//
// The first run connects to Dropbox once (click Allow) and keeps its key in
// ~/.ripplereview/dropbox.json, never in this repository. Needs ffmpeg.

import { exec, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const DROP = process.env.RR_DROP ?? "/Volumes/ERF_WORK2/RippleDrop";
const DRIVE = path.dirname(DROP);
const WORKING = path.join(DROP, "_working");     // review copies being made
const UPLOADED = path.join(DROP, "_uploaded");   // duplicates that are safely in Dropbox
const STUCK = path.join(DROP, "_unsorted");      // no job code, or no project for it

const TOKEN_FILE = process.env.RR_TOKEN_FILE ?? path.join(homedir(), ".ripplereview", "dropbox.json");
const API = process.env.RR_DROPBOX_API ?? "https://api.dropboxapi.com";
const CONTENT = process.env.RR_DROPBOX_CONTENT ?? "https://content.dropboxapi.com";
// Uploads go in pieces this size (Dropbox takes up to 150 MB per piece).
const CHUNK = Number(process.env.RR_CHUNK_MB ?? 64) * 1024 * 1024;

const VIDEO = /\.(mp4|m4v|mov|mkv|avi|mxf|webm)$/i;
const JOB = /^([A-Za-z]{2,4})[-_ ]?(\d{1,3})$/;
// Cut markers look like job codes (SF-01); they are never the job.
const MARKERS = new Set(["sf", "lf", "tr", "reel", "promo", "bts", "teaser", "v"]);

// Target for the review copy: 3 Mbit/s at 1080p, keyframe every second so
// scrubbing lands where you expect. Override per run with RR_BITRATE=4M.
const BITRATE = process.env.RR_BITRATE ?? "3M";
const MAXRATE = process.env.RR_MAXRATE ?? "4.5M";

const say = (...parts) => console.log(...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sizeText = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round((bytes ?? 0) / 1e6))} MB`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n").slice(-3).join("\n")))));
  });
}

// What the master is: its shape and rate for the review copy, and for the
// Download Master button ("4K, 24fps, 50Mbps"). No duration means the file
// can't be read yet, usually because it is still being copied onto the drive.
async function masterSpecs(file) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate:format=duration,size,bit_rate",
      "-of", "json", file,
    ]);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => {
      try {
        const { streams: [video = {}] = [], format = {} } = JSON.parse(out);
        const rate = (text) => { const [num, den] = String(text ?? "").split("/").map(Number); return num && den ? num / den : 0; };
        resolve({
          width: video.width ?? null,
          height: video.height ?? null,
          fps: Math.round((rate(video.avg_frame_rate) || rate(video.r_frame_rate)) * 1000) / 1000 || null,
          bitrate: Number(format.bit_rate) || null,
          size: Number(format.size) || null,
          duration: Math.round(Number(format.duration) * 100) / 100 || null,
          codec: video.codec_name ?? null,
        });
      } catch {
        resolve({});
      }
    });
  });
}

// Dropbox ------------------------------------------------------------------

const base64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The watcher's own Dropbox key, asked for once (same steps as
// setup/dropbox-token.mjs) and kept in the home folder.
async function credentials() {
  try {
    return JSON.parse(await readFile(TOKEN_FILE, "utf8"));
  } catch {}
  if (!process.stdin.isTTY) throw new Error("Not connected to Dropbox yet. Double-click Proxy Watcher once to connect.");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  say("\nFirst time only: connect the watcher to Dropbox.\n");
  const appKey = (await rl.question("1) Paste the App key (dropbox.com/developers/apps → RippleReview → Settings): ")).trim();
  const verifier = base64url(randomBytes(48));
  const url = "https://www.dropbox.com/oauth2/authorize?" + new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    token_access_type: "offline",
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  say("\n2) Dropbox is opening in your browser. Click Continue, then Allow.");
  say(`   (If nothing opens, copy this link into your browser:)\n   ${url}\n`);
  exec(`open "${url}"`);
  const code = (await rl.question("3) Paste the code Dropbox shows you: ")).trim();
  rl.close();

  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: appKey, code_verifier: verifier }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    throw new Error(`Dropbox said no (${data.error_description || data.error || res.status}). Start the watcher again and paste the newest code.`);
  }
  const saved = { app_key: appKey, refresh_token: data.refresh_token };
  await mkdir(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  say("\n   Connected. You won't be asked again.\n");
  return saved;
}

let token = { value: "", expires: 0 };

async function accessToken() {
  if (token.value && Date.now() < token.expires - 60_000) return token.value;
  const { app_key, refresh_token } = await credentials();
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id: app_key }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Dropbox login failed (${data.error_description || res.status}). Delete ${TOKEN_FILE} and start the watcher again to reconnect.`);
  token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return token.value;
}

// Dropbox-API-Arg travels as a header, so anything beyond plain ASCII is escaped.
const headerJson = (value) => JSON.stringify(value).replace(/[^ -~]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

// One Dropbox call: JSON in (`json`), or bytes with the arguments in a header
// (`arg` + `body`). A dropped connection or a busy Dropbox is retried a few times.
async function call(url, { json, arg, body } = {}) {
  for (let attempt = 1; ; attempt++) {
    const headers = { Authorization: `Bearer ${await accessToken()}` };
    if (arg === undefined) headers["Content-Type"] = "application/json";
    else Object.assign(headers, { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": headerJson(arg) });
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: arg === undefined ? JSON.stringify(json ?? null) : body });
    } catch (error) {
      if (attempt >= 4) throw new Error(`Couldn't reach Dropbox (${error.cause?.code ?? error.message}).`);
      await sleep(attempt * 3000);
      continue;
    }
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if (res.status === 401) token.value = "";
    if (![401, 429].includes(res.status) && res.status < 500 || attempt >= 4) throw new Error(`Dropbox: ${text.slice(0, 200)}`);
    await sleep((Number(res.headers.get("retry-after")) || attempt * 3) * 1000);
  }
}

async function folders(dropboxPath) {
  let page = await call(`${API}/2/files/list_folder`, { json: { path: dropboxPath, limit: 2000 } });
  const entries = [...page.entries];
  while (page.has_more) {
    page = await call(`${API}/2/files/list_folder/continue`, { json: { cursor: page.cursor } });
    entries.push(...page.entries);
  }
  return entries.filter((entry) => entry[".tag"] === "folder" && !/^[._]/.test(entry.name));
}

// Every project folder under every client, so a job code can find its home.
async function projects() {
  const found = [];
  for (const client of await folders("")) {
    for (const project of await folders(client.path_lower)) {
      found.push({ client: client.name, project: project.name, path: project.path_display });
    }
  }
  return found;
}

// Straight from the drive to Dropbox, in pieces, so a file of any size works
// and nothing is copied onto this Mac first. A file of the same name is replaced.
async function upload(file, dropboxPath, label) {
  const size = (await stat(file)).size;
  const commit = { path: dropboxPath, mode: "overwrite", mute: true };
  const handle = await open(file, "r");
  const show = (done) => {
    if (process.stdout.isTTY) process.stdout.write(`\r    ↑ ${label}  ${Math.floor((done / size) * 100)}% of ${sizeText(size)}   `);
  };
  const piece = async (offset) => {
    const buffer = Buffer.alloc(Math.min(CHUNK, size - offset));
    await handle.read(buffer, 0, buffer.length, offset);
    return buffer;
  };
  try {
    if (size <= CHUNK) {
      await call(`${CONTENT}/2/files/upload`, { arg: commit, body: await piece(0) });
    } else {
      let offset = 0;
      const first = await piece(0);
      const { session_id } = await call(`${CONTENT}/2/files/upload_session/start`, { arg: { close: false }, body: first });
      offset += first.length;
      show(offset);
      while (size - offset > CHUNK) {
        const chunk = await piece(offset);
        await call(`${CONTENT}/2/files/upload_session/append_v2`, { arg: { cursor: { session_id, offset }, close: false }, body: chunk });
        offset += chunk.length;
        show(offset);
      }
      await call(`${CONTENT}/2/files/upload_session/finish`, { arg: { cursor: { session_id, offset }, commit }, body: await piece(offset) });
    }
    show(size);
    if (process.stdout.isTTY) process.stdout.write("\n");
  } finally {
    await handle.close();
  }
}

// Naming ------------------------------------------------------------------

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
  if (!hits.length) return { reason: `no project folder for ${code} in Dropbox` };
  if (hits.length > 1) return { reason: `${code} matches ${hits.length} folders` };
  return { target: hits[0], code };
}

const previewName = (name) => {
  const stem = name.replace(/\.[^.]+$/, "");
  return `${/^_preview_/i.test(stem) ? stem : `_PREVIEW_${stem}`}.mp4`;
};

// The work ----------------------------------------------------------------

const unreadable = new Set();   // said once per file: "still copying?"

async function makeProxy(file, all, { keep = false } = {}) {
  const name = path.basename(file);
  const specs = await masterSpecs(file);
  if (!specs.duration) {
    if (!unreadable.has(name)) say(`  … ${name}: can't be read yet, waiting for the copy to finish`);
    unreadable.add(name);
    return false;
  }
  unreadable.delete(name);

  const { target, reason } = destinationFor(name, all);
  if (!target) {
    if (keep) throw new Error(reason);
    await mkdir(STUCK, { recursive: true });
    await rename(file, path.join(STUCK, name));
    say(`  ✗ ${name}\n    ${reason} → moved to RippleDrop/_unsorted\n`);
    return false;
  }

  say(`  → ${name}\n    ${target.client} / ${target.project}  (${specs.width}×${specs.height}, ${specs.fps} fps, ${sizeText(specs.size)})`);
  const vertical = (specs.height ?? 0) > (specs.width ?? 0);
  // Cap the long edge at 1080 and keep the shape; -2 keeps dimensions even.
  const scale = vertical ? "scale=-2:'min(1080,ih)'" : "scale='min(1920,iw)':-2";
  const keyframes = String(Math.round(specs.fps ?? 25) || 25);
  const preview = previewName(name);
  const out = path.join(WORKING, preview);
  await mkdir(WORKING, { recursive: true });

  try {
    const started = Date.now();
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", file,
      "-vf", scale,
      "-c:v", "libx264", "-profile:v", "high", "-preset", "medium",
      "-b:v", BITRATE, "-maxrate", MAXRATE, "-bufsize", "12M",
      "-g", keyframes, "-keyint_min", keyframes, "-sc_threshold", "0",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
      "-movflags", "+faststart",
      out,
    ]);
    say(`    ✓ review copy made  ${sizeText((await stat(out)).size)} in ${Math.round((Date.now() - started) / 1000)}s`);
    await upload(out, `${target.path}/${preview}`, "review copy");
    say(`    ✓ review copy in Dropbox`);
  } finally {
    await unlink(out).catch(() => {});
  }

  // The master: into the project's hidden _MASTERS folder, named like its
  // review copy minus _PREVIEW_, with its specs beside it for the button.
  const masterName = name.replace(/^_preview_/i, "");
  const stem = masterName.replace(/\.[^.]+$/, "");
  await call(`${CONTENT}/2/files/upload`, {
    arg: { path: `${target.path}/_MASTERS/${stem}.json`, mode: "overwrite", mute: true },
    body: Buffer.from(`${JSON.stringify({ file: masterName, ...specs }, null, 2)}\n`),
  });
  await upload(file, `${target.path}/_MASTERS/${masterName}`, "master");
  say(`    ✓ master in Dropbox (${target.project}/_MASTERS)`);

  if (!keep) {
    await mkdir(UPLOADED, { recursive: true });
    await rename(file, path.join(UPLOADED, name));
    say(`    ✓ duplicate moved to RippleDrop/_uploaded (safe to delete from there)`);
  }
  say("");
  return true;
}

// A file still being copied onto the drive grows; wait until its size settles.
async function settled(file) {
  const first = (await stat(file)).size;
  await sleep(3000);
  return first > 0 && first === (await stat(file)).size;
}

// A file that failed waits this long before trying again, rather than
// re-uploading gigabytes every few seconds.
const RETRY_AFTER = 10 * 60_000;
const failed = new Map();

async function sweep() {
  const entries = await readdir(DROP, { withFileTypes: true }).catch(() => []);
  // "._" files are macOS's shadow copies on drives formatted for Windows: not videos.
  const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".") && VIDEO.test(entry.name)).map((entry) => path.join(DROP, entry.name));
  let all = null;
  for (const file of files) {
    const name = path.basename(file);
    if (Date.now() - (failed.get(name) ?? 0) < RETRY_AFTER) continue;
    if (!(await settled(file))) continue;                 // still copying
    try {
      all ??= await projects();
      await makeProxy(file, all);
      failed.delete(name);
    } catch (error) {
      if (process.stdout.isTTY) process.stdout.write("\n");
      say(`    ✗ ${name}: ${error.message}\n      Trying again in 10 minutes (or restart the watcher).\n`);
      failed.set(name, Date.now());
    }
  }
  return files.length;
}

const driveThere = async () => (await stat(DRIVE).catch(() => null))?.isDirectory() ?? false;
const args = process.argv.slice(2);

if (args.some((arg) => VIDEO.test(arg))) {
  const all = await projects();
  for (const file of args.filter((arg) => VIDEO.test(arg))) await makeProxy(path.resolve(file), all, { keep: true });
} else if (args.includes("--watch")) {
  await credentials();                                    // connect first, not halfway through a file
  let state = "";
  for (;;) {
    if (await driveThere()) {
      if (state !== "watching") {
        await mkdir(DROP, { recursive: true });
        say(`Watching ${DROP}\nDuplicate an export in here. Review copy and master go straight to Dropbox. Ctrl+C to stop.\n`);
        state = "watching";
      }
      await sweep();
    } else if (state !== "waiting") {
      say(`Waiting for ${path.basename(DRIVE)} to be plugged in…`);
      state = "waiting";
    }
    await sleep(3000);
  }
} else {
  if (!(await driveThere())) {
    say(`${path.basename(DRIVE)} isn't plugged in.`);
    process.exit(1);
  }
  await mkdir(DROP, { recursive: true });
  const count = await sweep();
  if (!count) say(`Nothing waiting in ${DROP}`);
}
