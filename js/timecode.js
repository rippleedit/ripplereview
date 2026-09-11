// Timecode and note exports. Non-drop-frame throughout: 23.976 counts in
// 24s, 29.97 in 30s, the way editing software shows it.

export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

const pad = (n, width = 2) => String(n).padStart(width, "0");

export function frameOf(seconds, fps) {
  return Math.floor(seconds * fps + 1e-6);
}

export function timecode(seconds, fps, offsetHours = 0) {
  const base = Math.round(fps);
  let frames = frameOf(Math.max(0, seconds), fps) + offsetHours * 3600 * base;
  const f = frames % base;
  frames = Math.floor(frames / base);
  return `${pad(Math.floor(frames / 3600))}:${pad(Math.floor(frames / 60) % 60)}:${pad(frames % 60)}:${pad(f)}`;
}

// Snap a measured frame rate to the nearest standard one.
export function snapRate(measured) {
  return FRAME_RATES.reduce((best, rate) => (Math.abs(rate - measured) < Math.abs(best - measured) ? rate : best));
}

// Exports -----------------------------------------------------------------

function topLevel(comments) {
  return comments
    .filter((c) => !c.parent_id)
    .sort((a, b) => (a.time_sec ?? -1) - (b.time_sec ?? -1));
}

function repliesTo(comments, id) {
  return comments.filter((c) => c.parent_id === id);
}

export function toText(comments, fps, title) {
  const lines = [`${title}`, `Notes exported from RippleReview (${fps} fps)`, ""];
  for (const c of topLevel(comments)) {
    const when = c.time_sec == null ? "General    " : timecode(c.time_sec, fps);
    lines.push(`${c.done ? "[x]" : "[ ]"} ${when}  ${c.author_name}: ${c.body.replace(/\s*\n\s*/g, " ")}`);
    for (const r of repliesTo(comments, c.id)) lines.push(`                  ↳ ${r.author_name}: ${r.body.replace(/\s*\n\s*/g, " ")}`);
  }
  return lines.join("\n") + "\n";
}

export function toCsv(comments, fps) {
  const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [["Timecode", "Seconds", "Author", "Note", "Done", "Replies"]];
  for (const c of topLevel(comments)) {
    const replies = repliesTo(comments, c.id).map((r) => `${r.author_name}: ${r.body}`).join(" | ");
    rows.push([
      c.time_sec == null ? "" : timecode(c.time_sec, fps),
      c.time_sec == null ? "" : c.time_sec.toFixed(3),
      c.author_name, c.body, c.done ? "yes" : "no", replies,
    ]);
  }
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

// DaVinci Resolve reads this as timeline markers:
// Timelines → Import → Timeline Markers from EDL. Resolve timelines start at 01:00:00:00.
export function toResolveEdl(comments, fps, title) {
  const lines = [`TITLE: ${title}`, "FCM: NON-DROP FRAME", ""];
  let n = 1;
  for (const c of topLevel(comments).filter((c) => c.time_sec != null)) {
    const tcIn = timecode(c.time_sec, fps, 1);
    const tcOut = timecode(c.time_sec + 1 / fps, fps, 1);
    const colour = c.done ? "ResolveColorGreen" : "ResolveColorRed";
    const note = `${c.author_name}: ${c.body}`.replace(/\s*\n\s*/g, " ").replace(/\|/g, "/");
    lines.push(`${pad(n++, 3)}  001      V     C        ${tcIn} ${tcOut} ${tcIn} ${tcOut}  `);
    lines.push(` |C:${colour} |M:${note} |D:1`, "");
  }
  return lines.join("\r\n");
}

export function download(filename, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
