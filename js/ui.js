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

// Links, in one place: the sidebar, the lists and the review screen agree.
export const href = {
  space: (folder) => `#/c/${encodeURIComponent(folder)}`,
  project: (folder, name) => `#/c/${encodeURIComponent(folder)}/p/${encodeURIComponent(name)}`,
  video: (folder, id) => `#/c/${encodeURIComponent(folder)}/v/${encodeURIComponent(id)}`,
};

// A spinning ring. `label` is read out and shown next to it when given.
export function spinner(label = "") {
  return `<span class="loading" role="status">
    <svg class="spin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>
    ${label ? `<span>${esc(label)}</span>` : ""}
  </span>`;
}

// Grey placeholders shaped like the cards that are on their way.
export function skeletons(count) {
  return Array.from({ length: count }, () => `
    <div class="video-card is-skeleton" aria-hidden="true">
      <div class="video-thumb skel"></div>
      <div class="video-meta"><span class="skel skel-line"></span><span class="skel skel-line skel-line--short"></span></div>
    </div>`).join("");
}
