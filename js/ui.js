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

// Icons, drawn in the Lucide style (lucide.dev, ISC licence): a handful of
// paths inlined, rather than a megabyte of library for ten glyphs.
export const icon = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  folder: '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/>',
  settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.1-.1a2 2 0 0 0-2.7.8l-.3.5a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.4a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.3.5a2 2 0 0 0 2.7.8l.1-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.1.1a2 2 0 0 0 2.7-.8l.3-.5a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.4a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.3-.5a2 2 0 0 0-2.7-.8l-.1.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.3-8.3M17 6l3 3M15 8l2 2"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  draw: '<path d="M12 19l7-7a2.8 2.8 0 0 0-4-4l-7 7-1 5z"/><path d="M5 21h14"/>',
  undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>',
  reply: '<path d="M9 17l-5-5 5-5"/><path d="M4 12h9a7 7 0 0 1 7 7v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};

export function svg(name, className = "") {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true">${icon[name]}</svg>`;
}

// People: a colour each, so a client (and a commenter) is recognisable at a
// glance. The studio owns the signal orange; everyone else gets one of these.
const COLOURS = ["#4bb3fd", "#3ecfa6", "#b58cf6", "#f2c14e", "#ef6f9c", "#6ee7b7", "#9ab6ff", "#f59e6b"];

export function colourFor(name = "") {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length];
}

export function initials(name = "") {
  const words = String(name).replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

// size: "sm" in note lists, "md" in the clients list.
export function avatar(name, { studio = false, size = "sm", src = null } = {}) {
  const colour = studio ? "var(--signal)" : colourFor(name);
  const inside = src ? `<img src="${esc(src)}" alt="">` : esc(initials(name));
  return `<span class="avatar avatar--${size} ${src ? "avatar--photo" : ""}" style="--tint:${colour}" aria-hidden="true">${inside}</span>`;
}

// Dialogs: ours, not the browser's. Resolve to true (confirmed) or false.
export function dialog({ title, body = "", confirmLabel = "OK", cancelLabel = "Cancel", danger = false, onOpen }) {
  const el = document.createElement("dialog");
  el.className = "sheet";
  el.innerHTML = `
    <form method="dialog" class="sheet-inner">
      <div class="sheet-head">
        <h2>${esc(title)}</h2>
        <button class="icon-button" value="cancel" aria-label="Close">${svg("close")}</button>
      </div>
      <div class="sheet-body">${body}</div>
      <div class="sheet-foot">
        ${cancelLabel ? `<button class="button button--compact" value="cancel" type="submit">${esc(cancelLabel)}</button>` : ""}
        ${confirmLabel ? `<button class="button button--solid button--compact ${danger ? "button--danger" : ""}" value="confirm" type="submit">${esc(confirmLabel)}</button>` : ""}
      </div>
    </form>`;
  document.body.append(el);
  el.showModal();
  onOpen?.(el);
  return new Promise((resolve) => {
    el.addEventListener("close", () => {
      resolve(el.returnValue === "confirm");
      el.remove();
    }, { once: true });
  });
}

// A read-only value with a copy button, for logins and invites.
export function copyField(label, value, { block = false } = {}) {
  return `
    <div class="copy-field ${block ? "copy-field--block" : ""}">
      <span class="copy-label">${esc(label)}</span>
      <div class="copy-row">
        <${block ? "pre" : "span"} class="copy-value" data-copy-value>${esc(value)}</${block ? "pre" : "span"}>
        <button class="icon-button" type="button" data-copy aria-label="Copy ${esc(label)}" title="Copy">${svg("copy")}</button>
      </div>
    </div>`;
}

// Wire every copy button inside a container.
export function wireCopy(root) {
  root.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const value = button.closest(".copy-row").querySelector("[data-copy-value]").textContent;
      try {
        await navigator.clipboard.writeText(value);
        toast("Copied");
      } catch {
        toast("Couldn't copy — select the text instead");
      }
    });
  });
}

// File names follow the studio's convention:
//   _PREVIEW_NIL-11_Webinar-Funnel-Breakdown_v2
//   ^ prefix  ^ job  ^ title, dashes for spaces  ^ version (handled in the listing)
// Anything that doesn't follow it is left alone, so odd names still read fine.
export function parseTitle(raw = "") {
  const parts = String(raw).split("_").map((part) => part.trim()).filter(Boolean);
  let preview = false;
  let code = null;
  const rest = [];
  for (const part of parts) {
    if (/^preview$/i.test(part) && !preview) { preview = true; continue; }
    const job = !code && /^([A-Za-z]{2,4})[-_ ]?(\d{1,3})$/.exec(part);
    if (job) { code = `${job[1].toUpperCase()}-${job[2]}`; continue; }
    rest.push(part);
  }
  const title = rest.join(" ").replace(/[-–]+/g, " ").replace(/\s+/g, " ").trim();
  return { title: title || String(raw), code, preview, raw: String(raw) };
}

export function titleTag({ code, preview }) {
  return (code ? `<span class="tag tag--code">${esc(code)}</span>` : "")
    + (preview ? `<span class="tag tag--preview">Preview</span>` : "");
}

// Logins are usernames, not addresses. Supabase needs an email-shaped
// identifier, so "Nile Waves" becomes nile-waves@clients.ripple-edit.com
// behind the scenes; nobody ever types or sees the domain part.
export const CLIENT_DOMAIN = "clients.ripple-edit.com";

export function slug(name) {
  return String(name).toLowerCase().normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// What the person typed → what Supabase signs in. A real address still works.
export function loginId(input) {
  const value = String(input).trim();
  return value.includes("@") ? value.toLowerCase() : `${slug(value)}@${CLIENT_DOMAIN}`;
}

// The other way, for showing a login back to the studio.
export function loginName(email) {
  const value = String(email ?? "");
  return value.endsWith(`@${CLIENT_DOMAIN}`) ? value.slice(0, -CLIENT_DOMAIN.length - 1) : value;
}
