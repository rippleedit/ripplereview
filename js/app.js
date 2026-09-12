// RippleReview: the app shell (sidebar, top bar, routing), sign-in,
// the client spaces and the admin's client list.
// The review screen itself (player and notes) lives in review.js.

import { api } from "./api.js";
import { renderReview } from "./review.js";
import { esc, href, relTime, skeletons, spinner, toast, videoStatus } from "./ui.js";

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

  const projectLinks = (client) => (library && library.client.toLowerCase() === client.toLowerCase())
    ? `<ul class="side-sub">${library.projects.map((p) => `
        <li><a class="side-sub-item ${r.name === "project" && r.project === p.name ? "is-active" : ""}" href="${href.project(client, p.name)}">
          ${esc(p.name)}<span>${p.videos.length}</span></a></li>`).join("")}</ul>`
    : "";

  const body = profile.is_admin
    ? `<p class="side-label">Clients</p>
       ${clients ? clients.folders.map((f) => `
          <a class="side-item ${folder?.toLowerCase() === f.folder.toLowerCase() ? "is-active" : ""}" href="${href.space(f.folder)}">${esc(f.folder)}</a>
          ${folder?.toLowerCase() === f.folder.toLowerCase() ? projectLinks(f.folder) : ""}`).join("")
         : `<div class="side-loading">${spinner()}</div>`}
       <a class="side-item side-item--muted ${r.name === "home" ? "is-active" : ""}" href="#/">Manage logins</a>`
    : `<p class="side-label">Projects</p>
       <a class="side-item ${r.name === "space" ? "is-active" : ""}" href="${href.space(profile.client_folder)}">All projects</a>
       ${projectLinks(profile.client_folder)}`;

  sidebar.innerHTML = `
    <a class="side-brand" href="#/">
      <img class="side-brand-logo" src="assets/logotype.png" width="104" height="24" alt="RippleEdit">
      <span class="side-brand-dot" aria-hidden="true"></span>
      <img class="side-brand-mark" src="assets/ripplereview-mark.png" alt="Review">
    </a>
    <nav class="side-nav">${body}</nav>
    <div class="side-foot">
      <span class="side-user">${esc(profile.name || profile.email)}</span>
      <button class="text-button" type="button" data-sign-out>Sign out</button>
    </div>`;

  sidebar.querySelector("[data-sign-out]").addEventListener("click", async () => {
    await api.signOut();
    clients = null;
    libraries.clear();
    location.hash = "#/";
    route();
  });

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
  if (r.name === "project") parts.push({ label: r.project });
  if (r.name === "review") {
    const video = library?.projects.flatMap((p) => p.videos.map((v) => ({ ...v, project: p.name })))
      .find((v) => v.versions.some((x) => x.id === r.fileId));
    if (video) {
      parts.push({ label: video.project, url: href.project(folder, video.project) });
      parts.push({ label: video.title });
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
    <section class="signin">
      <div class="signin-card">
        <img class="signin-logo" src="assets/logotype.png" width="150" height="34" alt="RippleEdit">
        <p class="kicker"><span class="live-dot" aria-hidden="true"></span> Client review</p>
        <h1 class="signin-title">Your edits,<br>ready for notes.</h1>
        <form class="form" data-signin>
          <label><span>Email</span><input type="email" name="email" autocomplete="email" required ${api.demo ? 'value="studio@ripple-edit.com"' : ""}></label>
          <label><span>Password</span><input type="password" name="password" autocomplete="current-password" ${api.demo ? "" : "required"}></label>
          <div class="form-submit-row">
            <button class="button button--solid" type="submit">Sign in <span aria-hidden="true">→</span></button>
            <p class="form-status" role="status" data-status></p>
          </div>
          <p class="form-note">${api.demo
            ? "Demo mode: sign in with any email. Use one containing “client” to see the client's view."
            : "Lost your login? Message RippleEdit and we'll send you a new one."}</p>
        </form>
      </div>
      <div class="signin-media" aria-hidden="true">
        <video src="https://ripple-edit.com/assets/main-film-mobile.mp4" poster="https://ripple-edit.com/assets/main-film-poster.jpg" muted autoplay loop playsinline></video>
      </div>
    </section>`;

  const form = auth.querySelector("[data-signin]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector("[data-status]");
    const button = form.querySelector("button");
    button.disabled = true;
    status.innerHTML = spinner("Signing in");
    try {
      await api.signIn(form.email.value.trim(), form.password.value);
      route();
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}

// A client's space: their projects and videos ----------------------------

async function renderSpace(folder, only = null) {
  const cached = libraries.get(folder.toLowerCase())?.data;
  view.innerHTML = `
    <section class="page">
      <div class="page-head">
        <h1 class="page-title">${esc(only ?? cached?.client ?? folder)}</h1>
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

  const card = (video) => {
    const latest = video.versions.at(-1);
    const status = videoStatus(latest.id, summary);
    return `
      <a class="video-card" href="${href.video(library.client, latest.id)}">
        <div class="video-thumb" data-thumb="${esc(latest.path)}" data-id="${esc(latest.id)}">
          <span class="chip chip--version">v${latest.label}</span>
        </div>
        <div class="video-meta">
          <h3>${esc(video.title)}</h3>
          <p class="video-sub">
            <span class="status status--${status.kind}">${esc(status.text)}</span>
            <span>${video.versions.length > 1 ? `${video.versions.length} versions · ` : ""}${relTime(latest.modified)}</span>
          </p>
        </div>
      </a>`;
  };

  view.innerHTML = `
    <section class="page">
      <div class="page-head">
        <h1 class="page-title">${esc(only ?? library.client)}</h1>
        <p class="page-sub">${only
          ? `${videos.length} ${videos.length === 1 ? "video" : "videos"}`
          : `${library.projects.length} ${library.projects.length === 1 ? "project" : "projects"} · ${videos.length} ${videos.length === 1 ? "video" : "videos"}`}</p>
      </div>
      ${projects.length ? projects.map((project) => `
        <section class="project">
          ${only ? "" : `<div class="section-label"><a class="section-label-text" href="${href.project(library.client, project.name)}">${esc(project.name)}</a><span class="section-label-count">${project.videos.length}</span></div>`}
          <div class="video-grid">${project.videos.map(card).join("")}</div>
        </section>`).join("") : `
        <div class="empty">
          <p>Nothing here yet.</p>
          <p class="empty-sub">${profile.is_admin
            ? `Drop a video into Dropbox/Apps/RippleReview/${esc(library.client)}/&lt;Project&gt;/ and hit refresh.`
            : "We'll let you know when your first cut is ready."}</p>
        </div>`}
    </section>`;

  fillThumbs([...view.querySelectorAll("[data-thumb]")]);
}

// Dropbox's own thumbnails first; where it has none, a frame from the video.
async function fillThumbs(slots) {
  if (!slots.length) return;
  const thumbs = await api.thumbs(slots.map((s) => s.dataset.thumb)).catch(() => ({}));
  const missing = [];
  for (const slot of slots) {
    const src = thumbs[slot.dataset.thumb];
    if (src) slot.insertAdjacentHTML("afterbegin", `<img src="${src}" alt="" loading="lazy">`);
    else missing.push(slot);
  }
  for (const slot of missing) {
    try {
      const url = await api.link(slot.dataset.id);
      if (!slot.isConnected) return;
      slot.insertAdjacentHTML("afterbegin", `<video src="${esc(url)}#t=1" muted playsinline preload="metadata" aria-hidden="true"></video>`);
    } catch {}
  }
}

// Admin: clients and their logins -----------------------------------------

function generatePassword() {
  const words = ["bass", "loop", "kick", "snare", "vinyl", "tape", "reverb", "sample", "bounce", "master", "tempo", "chord"];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  return `${pick()}-${pick()}-${pick()}-${10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90)}`;
}

function loginMessage(email, password) {
  return `Your RippleReview login\n\n${location.origin}${location.pathname}\nEmail: ${email}\nPassword: ${password}`;
}

function showHandoff(email, password) {
  const box = view.querySelector("[data-handoff]");
  if (!box) return;
  box.hidden = false;
  box.querySelector("[data-handoff-text]").textContent = loginMessage(email, password);
}

async function renderClients() {
  view.innerHTML = `<section class="page"><div class="page-head"><h1 class="page-title">Clients</h1>${spinner("Loading")}</div></section>`;
  let data;
  try {
    data = clients ??= await api.clients();
  } catch (error) {
    return renderMessage("Couldn't load clients", error.message);
  }

  const loginRow = (login) => `
    <li class="login-row">
      <span class="login-email">${esc(login.email)}</span>
      <span class="login-actions">
        <button class="text-button" type="button" data-new-password="${esc(login.id)}" data-email="${esc(login.email)}">New password</button>
        <button class="text-button text-button--danger" type="button" data-remove-login="${esc(login.id)}" data-email="${esc(login.email)}">Remove</button>
      </span>
    </li>`;

  view.innerHTML = `
    <section class="page">
      <div class="page-head">
        <h1 class="page-title">Clients</h1>
        <p class="page-sub">One folder per client in Dropbox/Apps/RippleReview. Each login only ever sees its own folder.</p>
      </div>

      <div class="clients-layout">
        <div class="client-grid">
          ${data.folders.map((f) => `
            <article class="client-card">
              <a class="client-card-head" href="${href.space(f.folder)}">
                <h2>${esc(f.folder)}</h2><span aria-hidden="true">→</span>
              </a>
              ${f.logins.length
                ? `<ul class="login-list">${f.logins.map(loginRow).join("")}</ul>`
                : `<p class="client-card-empty">No login yet. Add one on the right, using this exact name.</p>`}
            </article>`).join("") || `<div class="empty"><p>No clients yet.</p><p class="empty-sub">Add your first one on the right.</p></div>`}
          ${data.orphans.length ? `
            <article class="client-card client-card--warn">
              <h2>Logins without a folder</h2>
              <p class="client-card-empty">These logins point at a folder that no longer exists in Dropbox.</p>
              <ul class="login-list">${data.orphans.map(loginRow).join("")}</ul>
            </article>` : ""}
        </div>

        <aside class="panel">
          <div class="section-label"><span class="section-label-text">Add a client login</span></div>
          <form class="form" data-add-client>
            <label><span>Client name</span><input name="folder" required placeholder="e.g. Nordbeats" autocomplete="off"></label>
            <label><span>Email</span><input name="email" type="email" required autocomplete="off"></label>
            <label><span>Password</span>
              <span class="input-with-button">
                <input name="password" required minlength="8" autocomplete="off" value="${generatePassword()}">
                <button class="text-button" type="button" data-generate>New</button>
              </span>
            </label>
            <p class="form-note" data-folder-note>Creates the Dropbox folder if it doesn't exist.</p>
            <div class="form-submit-row">
              <button class="button button--solid" type="submit">Create login <span aria-hidden="true">→</span></button>
              <p class="form-status" role="status" data-status></p>
            </div>
          </form>
          <div class="handoff" data-handoff hidden>
            <p class="handoff-title">Send this to your client</p>
            <pre data-handoff-text></pre>
            <button class="button button--compact" type="button" data-copy>Copy</button>
          </div>
        </aside>
      </div>
    </section>`;

  const form = view.querySelector("[data-add-client]");
  const note = view.querySelector("[data-folder-note]");
  form.folder.addEventListener("input", () => {
    const name = form.folder.value.trim();
    note.textContent = name ? `Uses Dropbox/Apps/RippleReview/${name} (created if missing).` : "Creates the Dropbox folder if it doesn't exist.";
  });
  view.querySelector("[data-generate]").addEventListener("click", () => { form.password.value = generatePassword(); });

  view.querySelector("[data-copy]").addEventListener("click", async () => {
    await navigator.clipboard.writeText(view.querySelector("[data-handoff-text]").textContent);
    toast("Copied");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector("[data-status]");
    const fields = { folder: form.folder.value.trim(), name: form.folder.value.trim(), email: form.email.value.trim(), password: form.password.value };
    status.innerHTML = spinner("Creating");
    try {
      await api.createClient(fields);
      clients = null;
      await renderClients();
      await renderSidebar(parseRoute());
      showHandoff(fields.email, fields.password);
      toast(`Login created for ${fields.folder}`);
    } catch (error) {
      status.textContent = error.message;
    }
  });

  view.querySelector(".client-grid")?.addEventListener("click", async (event) => {
    const reset = event.target.closest("[data-new-password]");
    const remove = event.target.closest("[data-remove-login]");
    if (reset) {
      const password = generatePassword();
      if (!confirm(`Give ${reset.dataset.email} a new password?\n\n${password}\n\nTheir old one stops working.`)) return;
      try {
        await api.setPassword(reset.dataset.newPassword, password);
        showHandoff(reset.dataset.email, password);
        toast("Password changed");
      } catch (error) { toast(error.message); }
    }
    if (remove) {
      if (!confirm(`Remove the login ${remove.dataset.email}?\n\nTheir notes stay. Their videos in Dropbox are not touched.`)) return;
      try {
        await api.removeLogin(remove.dataset.removeLogin);
        clients = null;
        await renderClients();
        await renderSidebar(parseRoute());
        toast("Login removed");
      } catch (error) { toast(error.message); }
    }
  });
}

window.addEventListener("hashchange", route);
route();
