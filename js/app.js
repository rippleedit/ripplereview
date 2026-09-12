// RippleReview: the app shell (sidebar, top bar, routing), sign-in,
// the client spaces and the admin's client list.
// The review screen itself (player and notes) lives in review.js.

import { api } from "./api.js";
import { renderReview } from "./review.js";
import { avatar, byJobNumber, dialog, copyField, esc, guessRatio, href, lastSeen, loginId, loginName, markSeen, parseTitle, parseVideo, relTime, skeletons, slug, spinner, svg, toast, videoStatus, wireCopy } from "./ui.js";

const auth = document.querySelector("[data-auth]");
const shell = document.querySelector("[data-shell]");
const sidebar = document.querySelector("[data-sidebar]");
const crumbs = document.querySelector("[data-crumbs]");
const view = document.querySelector("[data-view]");

let profile = null;
let cleanup = null;
let clients = null;                 // admin: the client folders, once fetched
const libraries = new Map();        // folder → { data, at }

// Routes: #/                        admin: clients · client: their space
//         #/c/<folder>              one client's space
//         #/c/<folder>/p/<project>  one project
//         #/c/<folder>/v/<fileId>   reviewing one video
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "c" || !parts[1]) return { name: "home" };
  const folder = parts[1];
  if (parts[2] === "v" && parts[3]) return { name: "review", folder, fileId: parts[3] };
  if (parts[2] === "p" && parts[3]) return { name: "project", folder, project: parts[3] };
  return { name: "space", folder };
}

// One Dropbox listing per client, reused by the sidebar and the pages.
async function getLibrary(folder, fresh = false) {
  const key = folder.toLowerCase();
  const hit = libraries.get(key);
  if (!fresh && hit && Date.now() - hit.at < 60000) return hit.data;
  const data = await api.library(folder);
  libraries.set(key, { data, at: Date.now() });
  return data;
}

async function route() {
  cleanup?.();
  cleanup = null;
  // A dialog left open belongs to the screen we are leaving.
  document.querySelectorAll("dialog.sheet[open]").forEach((el) => el.close());

  profile = await api.session();
  if (!profile) return renderSignIn();

  auth.hidden = true;
  shell.hidden = false;
  closeMenu();

  const r = parseRoute();
  const folder = profile.is_admin ? r.folder : profile.client_folder;
  if (!profile.is_admin && !folder) {
    renderSidebar(r);
    return renderMessage("Your space isn't ready yet", "RippleEdit hasn't linked a project folder to this login. Give us a shout and we'll sort it.");
  }

  renderSidebar(r);
  renderCrumbs(r);
  view.scrollTop = 0;

  if (r.name === "review") {
    cleanup = await renderReview(view, { folder, fileId: r.fileId, profile, getLibrary });
    renderCrumbs(r);
  } else if (r.name === "project" || r.name === "space" || !profile.is_admin) {
    await renderSpace(folder, r.name === "project" ? r.project : null);
  } else {
    await renderClients();
  }
}

function renderMessage(title, text) {
  view.innerHTML = `
    <section class="page page--narrow">
      <h1 class="page-title">${esc(title)}</h1>
      <p class="page-lede">${esc(text)}</p>
    </section>`;
}

// Shell -------------------------------------------------------------------

function openMenu() { shell.classList.add("is-menu-open"); document.querySelector("[data-scrim]").hidden = false; }
function closeMenu() { shell.classList.remove("is-menu-open"); document.querySelector("[data-scrim]").hidden = true; }

document.querySelector("[data-menu-toggle]").addEventListener("click", () =>
  shell.classList.contains("is-menu-open") ? closeMenu() : openMenu());
document.querySelector("[data-scrim]").addEventListener("click", closeMenu);

document.querySelector("[data-refresh]").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.classList.add("is-spinning");
  clients = null;
  libraries.clear();
  await route();
  button.classList.remove("is-spinning");
  toast("Checked Dropbox");
});

async function renderSidebar(r) {
  const folder = profile.is_admin ? r.folder : profile.client_folder;
  const library = folder ? libraries.get(folder.toLowerCase())?.data : null;

  // One row per project: job code, name, how many videos, and a dot when
  // something has changed since this person last looked.
  const projectRows = (client) => {
    if (!library || library.client.toLowerCase() !== client.toLowerCase()) return "";
    const seen = lastSeen(client);
    return [...library.projects].sort(byJobNumber).map((p) => {
      const info = parseTitle(p.name);
      const fresh = seen && p.modified > seen;
      return `
        <a class="side-link side-link--project ${r.name === "project" && r.project === p.name ? "is-active" : ""}" href="${href.project(client, p.name)}">
          ${info.code ? `<span class="tag tag--code tag--mini">${esc(info.code)}</span>` : ""}
          <span class="side-link-name">${esc(info.title)}</span>
          ${fresh ? `<span class="new-dot" title="Updated since you last looked"></span>` : ""}
          <span class="side-link-count">${svg("film")}${p.videos.length}</span>
        </a>`;
    }).join("");
  };

  const body = profile.is_admin
    ? `<p class="side-kicker">Clients</p>
       ${clients ? clients.folders.map((f) => {
          const active = folder?.toLowerCase() === f.folder.toLowerCase();
          return `
            <a class="side-link side-link--client ${active ? "is-active" : ""}" href="${href.space(f.folder)}">
              ${avatar(f.folder, { src: f.logins.find((l) => l.avatar)?.avatar })}
              <span class="side-link-name">${esc(f.folder)}</span>
            </a>
            ${active ? `<div class="side-group side-group--nested">${projectRows(f.folder) || `<p class="side-empty">No projects yet</p>`}</div>` : ""}`;
        }).join("") : `<div class="side-loading">${spinner()}</div>`}`
    : `<p class="side-kicker">${svg("folder")}<span>Projects</span></p>
       <div class="side-group">${projectRows(profile.client_folder) || `<p class="side-empty">Nothing here yet</p>`}</div>`;

  sidebar.innerHTML = `
    <a class="side-brand" href="#/">
      <img class="side-brand-logo" src="assets/logotype.png" width="104" height="24" alt="RippleEdit">
      <span class="side-brand-dot" aria-hidden="true"></span>
      <img class="side-brand-mark" src="assets/ripplereview-mark.png" alt="Review">
    </a>
    <nav class="side-nav">${body}</nav>
    ${profile.is_admin ? `
      <div class="side-tools">
        <a class="side-link side-link--tool ${r.name === "home" ? "is-active" : ""}" href="#/">${svg("users")}<span class="side-link-name">Manage logins</span></a>
      </div>` : ""}
    <button class="side-foot" type="button" data-profile>
      ${avatar(profile.name || profile.email, { studio: profile.is_admin, src: profile.avatar })}
      <span class="side-me">
        <strong>${esc(profile.name || loginName(profile.email))}</strong>
      </span>
      ${svg("settings", "side-foot-icon")}
    </button>`;

  sidebar.querySelector("[data-profile]").addEventListener("click", profileDialog);

  // Fill in what we don't have yet, then draw again.
  if (profile.is_admin && !clients) {
    clients = await api.clients().catch(() => ({ folders: [], orphans: [] }));
    renderSidebar(parseRoute());
  }
}

function renderCrumbs(r) {
  const folder = profile.is_admin ? r.folder : profile.client_folder;
  const library = folder ? libraries.get(folder.toLowerCase())?.data : null;
  const parts = [];

  if (profile.is_admin) parts.push({ label: "Clients", url: "#/" });
  if (folder) parts.push({ label: library?.client ?? folder, url: href.space(folder) });
  if (r.name === "project") parts.push({ label: parseTitle(r.project).title });
  if (r.name === "review") {
    const video = library?.projects.flatMap((p) => p.videos.map((v) => ({ ...v, project: p.name })))
      .find((v) => v.versions.some((x) => x.id === r.fileId));
    if (video) {
      const projectTitle = parseTitle(video.project).title;
      parts.push({ label: projectTitle, url: href.project(folder, video.project) });
      // The last crumb says which cut you're watching: Long form, Short 01.
      parts.push({ label: parseVideo(video.title, projectTitle).label });
    }
  }

  crumbs.innerHTML = parts.map((part, i) => {
    const last = i === parts.length - 1;
    const label = esc(part.label);
    return (part.url && !last ? `<a href="${part.url}">${label}</a>` : `<span aria-current="page">${label}</span>`)
      + (last ? "" : `<i aria-hidden="true">/</i>`);
  }).join("");
}

// Sign in -----------------------------------------------------------------

function renderSignIn() {
  shell.hidden = true;
  auth.hidden = false;
  auth.innerHTML = `
    <div class="signin">
      <div class="signin-inner">
        <div class="signin-brand">
          <img class="signin-logo" src="assets/logotype.png" width="132" height="30" alt="RippleEdit">
          <span class="side-brand-dot" aria-hidden="true"></span>
          <img class="signin-mark" src="assets/ripplereview-mark.png" alt="Review">
        </div>
        <form class="form" data-signin>
          <label><span>Username</span><input type="text" name="email" autocomplete="username" spellcheck="false" autocapitalize="off" required ${api.demo ? 'value="studio@ripple-edit.com"' : ""}></label>
          <label><span>Password</span><input type="password" name="password" autocomplete="current-password" ${api.demo ? "" : "required"}></label>
          <button class="button button--solid button--block" type="submit">Sign in <span aria-hidden="true">→</span></button>
          <p class="form-status" role="status" data-status></p>
        </form>
        <p class="signin-foot">${api.demo
          ? "Demo mode · any email signs in. Use one containing “client” for the client's view."
          : "Lost your login? Message RippleEdit and we'll send you a new one."}</p>
      </div>
    </div>`;

  const form = auth.querySelector("[data-signin]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector("[data-status]");
    const button = form.querySelector("button");
    button.disabled = true;
    status.innerHTML = spinner("Signing in");
    try {
      await api.signIn(loginId(form.email.value), form.password.value);
      route();
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}

// A client's space: their projects and videos ----------------------------

// A project's cuts read in a fixed order: the main film, then the offcuts.
function sortCuts(project) {
  const title = parseTitle(project.name).title;
  return [...project.videos].sort((a, b) => {
    const x = parseVideo(a.title, title), y = parseVideo(b.title, title);
    return x.rank - y.rank || x.number - y.number || b.modified.localeCompare(a.modified);
  });
}

async function renderSpace(folder, only = null) {
  const cached = libraries.get(folder.toLowerCase())?.data;
  view.innerHTML = `
    <section class="page">
      <div class="page-head">
        ${only && parseTitle(only).code ? `<span class="tag tag--code">${esc(parseTitle(only).code)}</span>` : ""}
        <h1 class="page-title">${esc(only ? parseTitle(only).title : (cached?.client ?? folder))}</h1>
        ${cached ? "" : spinner("Loading")}
      </div>
      <div class="video-grid">${skeletons(4)}</div>
    </section>`;

  let library;
  try {
    library = await getLibrary(folder);
  } catch (error) {
    return renderMessage("Couldn't load this space", error.message);
  }
  renderSidebar(parseRoute());
  renderCrumbs(parseRoute());

  const projects = only ? library.projects.filter((p) => p.name === only) : library.projects;
  const videos = projects.flatMap((p) => p.videos);
  const summary = await api.summary(videos.map((v) => v.versions.at(-1).id)).catch(() => ({ comments: [], approvals: [] }));

  const seen = lastSeen(library.client);
  const card = (video, projectTitle, index = 0) => {
    const latest = video.versions.at(-1);
    const status = videoStatus(latest.id, summary);
    const cut = parseVideo(video.title, projectTitle);
    const fresh = seen && latest.modified > seen;
    return `
      <a class="video-card ${fresh ? "is-new" : ""}" style="--ar:${guessRatio(cut)};--i:${index}" href="${href.video(library.client, latest.id)}">
        <div class="video-thumb" data-thumb="${esc(latest.path)}" data-id="${esc(latest.id)}">
          <span class="chip chip--version">v${latest.label}</span>
          ${fresh ? `<span class="chip chip--new">New</span>` : ""}
        </div>
        <div class="video-meta">
          <span class="title-line">
            <h3>${esc(cut.label)}</h3>
          </span>
          ${cut.extra ? `<p class="video-extra">${esc(cut.extra)}</p>` : ""}
          <span class="status status--${status.kind}">${status.icon ? svg(status.icon) : `<i></i>`}${esc(status.text)}</span>
          <p class="video-sub">${video.versions.length > 1 ? `${video.versions.length} versions · ` : ""}${relTime(latest.modified)}</p>
        </div>
      </a>`;
  };

  const ordered = only ? projects : [...projects].sort(byJobNumber);
  const face = profile.is_admin
    ? (clients?.folders.find((f) => f.folder.toLowerCase() === library.client.toLowerCase())?.logins.find((l) => l.avatar)?.avatar)
    : profile.avatar;

  view.innerHTML = `
    <section class="page">
      <div class="page-head">
        ${only
          ? (parseTitle(only).code ? `<span class="tag tag--code">${esc(parseTitle(only).code)}</span>` : "")
          : `<span class="page-face">${avatar(library.client, { size: "md", src: face })}</span>`}
        <h1 class="page-title">${esc(only ? parseTitle(only).title : library.client)}</h1>
        <p class="page-sub">${only
          ? `${videos.length} ${videos.length === 1 ? "video" : "videos"}`
          : `${library.projects.length} ${library.projects.length === 1 ? "project" : "projects"} · ${videos.length} ${videos.length === 1 ? "video" : "videos"}`}</p>
      </div>
      ${ordered.length ? ordered.map((project, index) => {
        const info = parseTitle(project.name);
        const open = only || index === 0;          // the newest job is the one you came for
        return `
        <section class="project ${open ? "is-open" : ""}" data-project="${esc(project.name)}">
          ${only ? "" : `
            <button class="project-head" type="button" data-toggle aria-expanded="${open}">
              <span class="project-chevron" aria-hidden="true">${svg("chevron")}</span>
              ${info.code ? `<span class="tag tag--code">${esc(info.code)}</span>` : ""}
              <span class="project-name">${esc(info.title)}</span>
              <span class="project-count">${svg("film")}${project.videos.length}</span>
            </button>`}
          <div class="project-body"><div class="video-grid">${sortCuts(project).map((video, i) => card(video, info.title, i)).join("")}</div></div>
        </section>`;
      }).join("") : `
        <div class="empty">
          <p>Nothing here yet.</p>
          <p class="empty-sub">${profile.is_admin
            ? `Drop a video into Dropbox/Apps/RippleReview/${esc(library.client)}/&lt;Project&gt;/ and hit refresh.`
            : "We'll let you know when your first cut is ready."}</p>
        </div>`}
    </section>`;

  // One project open at a time.
  view.querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const section = button.closest(".project");
      const wasOpen = section.classList.contains("is-open");
      view.querySelectorAll(".project").forEach((other) => {
        other.classList.remove("is-open");
        other.querySelector("[data-toggle]")?.setAttribute("aria-expanded", "false");
      });
      if (!wasOpen) {
        section.classList.add("is-open");
        button.setAttribute("aria-expanded", "true");
      }
    });
  });

  fillThumbs([...view.querySelectorAll("[data-thumb]")]);
  markSeen(library.client);
}

// Dropbox's own thumbnails first; where it has none, a frame from the video.
async function fillThumbs(slots) {
  if (!slots.length) return;
  const thumbs = await api.thumbs(slots.map((s) => s.dataset.thumb)).catch(() => ({}));
  const missing = [];
  for (const slot of slots) {
    const src = thumbs[slot.dataset.thumb];
    if (src) {
      // Two copies: a blurred one filling the box, the real one whole on top.
      slot.insertAdjacentHTML("afterbegin", `<img class="thumb-shot" src="${src}" alt="" loading="lazy">`);
      const img = slot.querySelector(".thumb-shot");
      img.addEventListener("load", () => {
        // The file's real shape wins over the guess from its name.
        if (img.naturalWidth && img.naturalHeight) slot.closest(".video-card").style.setProperty("--ar", img.naturalWidth / img.naturalHeight);
      }, { once: true });
    }
    else missing.push(slot);
  }
  for (const slot of missing) {
    try {
      const url = await api.link(slot.dataset.id);
      if (!slot.isConnected) return;
      slot.insertAdjacentHTML("afterbegin", `<video class="thumb-shot" src="${esc(url)}#t=1" muted playsinline preload="metadata" aria-hidden="true"></video>`);
      const clip = slot.querySelector("video");
      clip.addEventListener("loadedmetadata", () => {
        if (clip.videoWidth && clip.videoHeight) slot.closest(".video-card").style.setProperty("--ar", clip.videoWidth / clip.videoHeight);
      }, { once: true });
    } catch {}
  }
}

// Me -------------------------------------------------------------------

// Shrink whatever the user picked to a small square, so a picture costs a
// few kilobytes instead of several megabytes.
function squareDataUrl(file, size = 128) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const side = Math.min(image.width, image.height);
      const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
      canvas.getContext("2d").drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(image.src);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    image.onerror = () => reject(new Error("That file isn't an image we can read."));
    image.src = URL.createObjectURL(file);
  });
}

async function profileDialog() {
  let name = profile.name;
  let avatarSrc = profile.avatar ?? null;
  let touchedPicture = false;

  const save = await dialog({
    title: "You",
    confirmLabel: "Save",
    cancelLabel: "Close",
    body: `
      <div class="sheet-person">
        <span data-avatar-slot>${avatar(profile.name || profile.email, { studio: profile.is_admin, size: "md", src: avatarSrc })}</span>
        <div>
          <strong>${esc(profile.name || loginName(profile.email))}</strong>
          <span>${esc(loginName(profile.email))}</span>
        </div>
        <span class="sheet-person-actions">
          <button class="text-button" type="button" data-pick>${avatarSrc ? "Change picture" : "Add picture"}</button>
          <button class="text-button text-button--danger" type="button" data-drop ${avatarSrc ? "" : "hidden"}>Remove</button>
        </span>
      </div>
      <input type="file" accept="image/*" hidden data-file>
      <div class="form">
        <label><span>Name on your notes</span><input name="name" value="${esc(profile.name)}" placeholder="e.g. Razz" maxlength="40" autocomplete="off"></label>
      </div>
      <p class="sheet-note">${svg("alert")}<span>This is what ${profile.is_admin ? "clients see" : "the studio sees"} on your notes. Yours always show in ${profile.is_admin ? "the studio's orange" : "your own colour"}.</span></p>
      <div class="sheet-signout"><button class="text-button" type="button" data-sign-out>Sign out</button></div>`,
    onOpen: (el) => {
      const input = el.querySelector("input[name=name]");
      const file = el.querySelector("[data-file]");
      const slot = el.querySelector("[data-avatar-slot]");
      const drop = el.querySelector("[data-drop]");
      const pick = el.querySelector("[data-pick]");

      input.addEventListener("input", () => { name = input.value.trim(); });
      input.focus();
      pick.addEventListener("click", () => file.click());
      file.addEventListener("change", async () => {
        if (!file.files?.[0]) return;
        try {
          avatarSrc = await squareDataUrl(file.files[0]);
          touchedPicture = true;
          slot.innerHTML = avatar(name || profile.email, { studio: profile.is_admin, size: "md", src: avatarSrc });
          drop.hidden = false;
          pick.textContent = "Change picture";
        } catch (error) { toast(error.message); }
      });
      drop.addEventListener("click", () => {
        avatarSrc = null;
        touchedPicture = true;
        slot.innerHTML = avatar(name || profile.email, { studio: profile.is_admin, size: "md" });
        drop.hidden = true;
        pick.textContent = "Add picture";
      });
      el.querySelector("[data-sign-out]").addEventListener("click", async () => {
        el.close();
        await api.signOut();
        clients = null;
        libraries.clear();
        location.hash = "#/";
        route();
      });
    },
  });

  if (!save) return;
  const fields = {};
  if (name !== profile.name) fields.name = name;
  if (touchedPicture) fields.avatar = avatarSrc;
  if (!Object.keys(fields).length) return;
  try {
    profile = await api.setProfile(fields);
    await renderSidebar(parseRoute());
    toast("Saved");
  } catch (error) { toast(error.message); }
}

// Admin: clients and their logins -----------------------------------------

// A proper random password: 16 characters, at least one of each kind,
// drawn from the browser's cryptographic randomness. Look-alike characters
// (O/0, l/I/1) are left out so nobody mistypes what you send them.
function generatePassword(length = 16) {
  const sets = ["ABCDEFGHJKMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#$%&*?+="];
  const all = sets.join("");
  const pick = (chars) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  const out = sets.map(pick);
  while (out.length < length) out.push(pick(all));
  // Fisher-Yates, so the guaranteed four aren't always at the front.
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

const appUrl = () => `${location.origin}${location.pathname}`;

function inviteText(email, password) {
  return [
    `Your RippleReview login`,
    ``,
    appUrl(),
    `Username: ${loginName(email)}`,
    ...(password ? [`Password: ${password}`] : []),
  ].join("\n");
}

// With a password: the one moment it can be read. Without: the details
// minus the password, which nobody can look up after it is set.
async function inviteDialog(folder, login, password) {
  const email = login.email;
  const reset = await dialog({
    title: `Invite for ${folder}`,
    confirmLabel: password ? "Done" : "Set a new password",
    cancelLabel: password ? "" : "Close",
    body: `
      ${copyField("Message to send", inviteText(email, password), { block: true })}
      ${copyField("Username", loginName(email))}
      ${password ? copyField("Password", password) : ""}
      <p class="sheet-note">${svg("alert")}<span>${password
        ? "Copy it now. Passwords are stored scrambled, so this one can't be shown again — you'd have to set a new one."
        : "Their password can't be shown: it's stored scrambled, which is what keeps it safe. If they've lost it, set a new one and send that."}</span></p>`,
    onOpen: wireCopy,
  });
  if (!password && reset) await resetPasswordDialog(folder, login);
}

async function addClientDialog() {
  let created = null;
  await dialog({
    title: "Add a client",
    confirmLabel: "Create login",
    body: `
      <div class="form">
        <label><span>Client name</span><input name="folder" placeholder="e.g. Nordbeats" autocomplete="off" required></label>
        <label><span>Email</span><input name="email" type="email" autocomplete="off" required></label>
        <label><span>Password</span>
          <span class="input-with-button">
            <input name="password" value="${generatePassword()}" minlength="8" autocomplete="off" required>
            <button class="text-button" type="button" data-generate>New</button>
          </span>
        </label>
      </div>
      <p class="sheet-note" data-note>${svg("folder")}<span>Creates their Dropbox folder if it isn't there yet.</span></p>
      <p class="sheet-note" data-username>${svg("user")}<span>Their username is made from the name.</span></p>`,
    onOpen: (el) => {
      const form = el.querySelector("form");
      const note = el.querySelector("[data-note] span");
      el.querySelector("[data-generate]").addEventListener("click", () => { form.password.value = generatePassword(); });
      const username = el.querySelector("[data-username] span");
      form.folder.addEventListener("input", () => {
        const name = form.folder.value.trim();
        note.textContent = name ? `Uses Dropbox/Apps/RippleReview/${name}, created if it isn't there yet.` : "Creates their Dropbox folder if it isn't there yet.";
        username.textContent = name ? `They sign in as “${slug(name)}”.` : "Their username is made from the name.";
      });
      form.folder.focus();
      // Keep the dialog open while the login is being created.
      form.addEventListener("submit", async (event) => {
        if (el.returnValue === "cancel" || event.submitter?.value !== "confirm") return;
        event.preventDefault();
        const folder = form.folder.value.trim();
        const fields = { folder, name: folder, email: loginId(folder), password: form.password.value };
        if (!fields.folder || fields.password.length < 8) return;
        const button = event.submitter;
        button.disabled = true;
        button.textContent = "Creating…";
        try {
          await api.createClient(fields);
          created = fields;
          el.close();
        } catch (error) {
          toast(error.message);
          button.disabled = false;
          button.textContent = "Create login";
        }
      });
    },
  });
  if (!created) return;
  clients = null;
  await renderClients();
  await renderSidebar(parseRoute());
  await inviteDialog(created.folder, { email: created.email }, created.password);
}

async function editClientDialog(folder, login) {
  let fields = null;
  await dialog({
    title: `Edit ${folder}`,
    confirmLabel: "Save changes",
    body: `
      <div class="sheet-person">
        <span data-avatar-slot>${avatar(folder, { size: "md", src: login.avatar })}</span>
        <div><strong>${esc(folder)}</strong><span>${esc(loginName(login.email))}</span></div>
        <span class="sheet-person-actions">
          <button class="text-button" type="button" data-pick>${login.avatar ? "Change picture" : "Add picture"}</button>
          <button class="text-button text-button--danger" type="button" data-drop ${login.avatar ? "" : "hidden"}>Remove</button>
        </span>
      </div>
      <input type="file" accept="image/*" hidden data-file>
      <div class="form">
        <label><span>Client name</span><input name="folder" value="${esc(folder)}" autocomplete="off" required></label>
        <label><span>Username</span><input name="username" value="${esc(loginName(login.email))}" autocomplete="off" spellcheck="false" required></label>
      </div>
      <p class="sheet-note" data-note>${svg("folder")}<span>Renaming also renames their Dropbox folder. Their videos, notes and approvals move with it.</span></p>`,
    onOpen: (el) => {
      const form = el.querySelector("form");
      const file = el.querySelector("[data-file]");
      const slot = el.querySelector("[data-avatar-slot]");
      const drop = el.querySelector("[data-drop]");
      const pick = el.querySelector("[data-pick]");
      let picture;                                   // undefined = leave it alone

      form.folder.focus();
      pick.addEventListener("click", () => file.click());
      file.addEventListener("change", async () => {
        if (!file.files?.[0]) return;
        try {
          picture = await squareDataUrl(file.files[0]);
          slot.innerHTML = avatar(folder, { size: "md", src: picture });
          drop.hidden = false;
          pick.textContent = "Change picture";
        } catch (error) { toast(error.message); }
      });
      drop.addEventListener("click", () => {
        picture = null;
        slot.innerHTML = avatar(folder, { size: "md" });
        drop.hidden = true;
        pick.textContent = "Add picture";
      });

      form.addEventListener("submit", async (event) => {
        if (event.submitter?.value !== "confirm") return;
        event.preventDefault();
        const next = { userId: login.id, folder: form.folder.value.trim(), name: form.folder.value.trim(), email: loginId(form.username.value) };
        if (picture !== undefined) next.avatar = picture;
        if (!next.folder || !form.username.value.trim()) return;
        const button = event.submitter;
        button.disabled = true;
        button.textContent = "Saving…";
        try {
          await api.updateClient(next);
          fields = next;
          el.close();
        } catch (error) {
          toast(error.message);
          button.disabled = false;
          button.textContent = "Save changes";
        }
      });
    },
  });
  if (!fields) return;
  clients = null;
  libraries.clear();
  await renderClients();
  await renderSidebar(parseRoute());
  toast("Client updated");
}

async function resetPasswordDialog(folder, login) {
  const password = generatePassword();
  const ok = await dialog({
    title: "New password",
    confirmLabel: "Set new password",
    danger: true,
    body: `
      <p>${esc(loginName(login.email))} gets a new password. Their current one stops working straight away.</p>
      ${copyField("New password", password)}`,
    onOpen: wireCopy,
  });
  if (!ok) return;
  try {
    await api.setPassword(login.id, password);
    await inviteDialog(folder, login, password);
  } catch (error) { toast(error.message); }
}

async function removeLoginDialog(login) {
  let purge = false;
  const ok = await dialog({
    title: `Delete ${login.folder}?`,
    confirmLabel: "Delete login",
    danger: true,
    body: `
      <p>The login <strong>${esc(loginName(login.email))}</strong> is deleted for good and can't sign in again.</p>
      <label class="sheet-choice"><input type="checkbox" data-purge><span>Also delete every note and approval in their space</span></label>
      <p class="sheet-note">${svg("folder")}<span>Their Dropbox folder and videos are never touched. Delete those in Finder if you want them gone.</span></p>`,
    onOpen: (el) => {
      el.querySelector("[data-purge]").addEventListener("change", (event) => { purge = event.target.checked; });
    },
  });
  if (!ok) return;
  try {
    await api.removeLogin(login.id, purge);
    clients = null;
    await renderClients();
    await renderSidebar(parseRoute());
    toast("Login removed");
  } catch (error) { toast(error.message); }
}

// Has anything in this client's space changed since the studio last opened it?
function updated(folder) {
  const seen = lastSeen(folder);
  const library = libraries.get(folder.toLowerCase())?.data;
  if (!seen || !library) return false;
  return library.projects.some((p) => p.modified > seen);
}

async function renderClients() {
  view.innerHTML = `<section class="page"><div class="page-head"><h1 class="page-title">Clients</h1>${spinner("Loading")}</div></section>`;
  let data;
  try {
    data = clients ??= await api.clients();
  } catch (error) {
    return renderMessage("Couldn't load clients", error.message);
  }

  const card = (folder, login) => `
    <article class="client-card">
      <a class="client-card-main" href="${href.space(folder)}">
        ${avatar(folder, { size: "md", src: login?.avatar })}
        <span class="client-card-name">
          <strong>${esc(folder)}${updated(folder) ? `<span class="new-dot" title="Updated since you last looked"></span>` : ""}</strong>
          <span class="${login ? "" : "client-card-none"}">${login ? esc(loginName(login.email)) : "No login yet"}</span>
        </span>
      </a>
      <div class="client-card-tools">
        ${login ? `
          <button class="icon-button" type="button" data-edit="${esc(login.id)}" title="Edit client" aria-label="Edit ${esc(folder)}">${svg("settings")}</button>
          <button class="icon-button" type="button" data-invite="${esc(login.id)}" title="Copy invite" aria-label="Copy invite for ${esc(folder)}">${svg("copy")}</button>
          <button class="icon-button" type="button" data-reset="${esc(login.id)}" title="New password" aria-label="New password for ${esc(folder)}">${svg("key")}</button>
          <button class="icon-button" type="button" data-remove="${esc(login.id)}" title="Delete login" aria-label="Delete login for ${esc(folder)}">${svg("trash")}</button>`
        : `<button class="button button--compact" type="button" data-add-for="${esc(folder)}">${svg("plus")} Add login</button>`}
      </div>
    </article>`;

  const cards = data.folders.flatMap((f) => f.logins.length ? f.logins.map((l) => card(f.folder, l)) : [card(f.folder, null)]).join("");

  view.innerHTML = `
    <section class="page">
      <div class="page-head">
        <h1 class="page-title">Clients</h1>
        <p class="page-sub">Each login only ever sees its own folder.</p>
        <div class="page-actions">
          <button class="button button--solid button--compact" type="button" data-add-client>${svg("plus")} Add client</button>
        </div>
      </div>

      ${cards ? `<div class="client-grid">${cards}</div>` : `<div class="empty"><p>No clients yet.</p><p class="empty-sub">Add your first one to create their folder and login.</p></div>`}

      ${data.orphans.length ? `
        <div class="page-head" style="margin-top:2rem"><h2 class="page-title">Logins without a folder</h2><p class="page-sub">The Dropbox folder these point at is gone.</p></div>
        <div class="client-grid">${data.orphans.map((l) => `
          <article class="client-card client-card--warn">
            <div class="client-card-main">
              ${avatar(l.client_folder || l.email, { size: "md" })}
              <span class="client-card-name">
                <strong>${esc(l.client_folder || "—")}</strong>
                <span>${esc(loginName(l.email))}</span>
              </span>
            </div>
            <div class="client-card-tools">
              <button class="icon-button" type="button" data-reset="${esc(l.id)}" title="New password">${svg("key")}</button>
              <button class="icon-button" type="button" data-remove="${esc(l.id)}" title="Delete login">${svg("trash")}</button>
            </div>
          </article>`).join("")}</div>` : ""}
    </section>`;

  const findLogin = (id) => [...data.folders.flatMap((f) => f.logins.map((l) => ({ ...l, folder: f.folder }))), ...data.orphans.map((l) => ({ ...l, folder: l.client_folder }))].find((l) => l.id === id);

  const page = view.querySelector(".page");
  page.querySelector("[data-add-client]").addEventListener("click", addClientDialog);
  page.addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit]");
    const invite = event.target.closest("[data-invite]");
    const reset = event.target.closest("[data-reset]");
    const remove = event.target.closest("[data-remove]");
    const addFor = event.target.closest("[data-add-for]");
    if (edit) {
      const login = findLogin(edit.dataset.edit);
      await editClientDialog(login.folder, login);
    } else if (invite) {
      const login = findLogin(invite.dataset.invite);
      await inviteDialog(login.folder, login, null);
    } else if (reset) {
      const login = findLogin(reset.dataset.reset);
      await resetPasswordDialog(login.folder, login);
    } else if (remove) {
      await removeLoginDialog(findLogin(remove.dataset.remove));
    } else if (addFor) {
      await addClientDialog();
    }
  });
}

window.addEventListener("hashchange", route);
route();
