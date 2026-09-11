// Small shared helpers for the screens.

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relTime(iso) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps = [[60, "second"], [3600, "minute"], [86400, "hour"], [604800, "day"], [2629800, "week"], [31557600, "month"], [Infinity, "year"]];
  let unit = 1;
  for (const [limit, name] of steps) {
    if (Math.abs(seconds) < limit) {
      if (name === "second") return "just now";
      return rtf.format(Math.round(seconds / unit), name);
    }
    unit = limit;
  }
  return "";
}

let toastTimer;
export function toast(message) {
  const el = document.querySelector("[data-toast]");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// One status line per video, from its latest version's notes and approval.
export function videoStatus(fileId, { comments, approvals }) {
  if (approvals.some((a) => a.file_id === fileId)) return { kind: "approved", text: "Approved" };
  const open = comments.filter((c) => c.file_id === fileId && !c.parent_id && !c.done).length;
  if (open) return { kind: "notes", text: `${open} open ${open === 1 ? "note" : "notes"}` };
  const any = comments.some((c) => c.file_id === fileId && !c.parent_id);
  return any ? { kind: "done", text: "All notes done" } : { kind: "new", text: "Ready for review" };
}
