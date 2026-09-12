// RippleReview: the app shell (sidebar, top bar, routing), sign-in,
// the client spaces and the admin's client list.
// The review screen itself (player and notes) lives in review.js.

import { api } from "./api.js";
import { renderReview } from "./review.js";
import { avatar, dialog, copyField, esc, href, parseTitle, relTime, skeletons, spinner, svg, titleTag, toast, videoStatus, wireCopy } from "./ui.js";

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

  const projectLinks = (client) => (library && library.client.toLowerCase() === client.toLowerCase())
    ? `<ul class="side-sub">${library.projects.map((p) => `
        <li><a class="side-sub-item ${r.name === "project" && r.project === p.name ? "is-active" : ""}" href="${href.project(client, p.name)}">
          ${esc(parseTitle(p.name).title)}<span>${p.videos.length}</span></a></li>`).join("")}</ul>`
    : "";

  const body = profile.is_admin
    ? `<p class="side-label">Clients</p>
       ${clients ? clients.folders.map((f) => `
          <a class="side-item ${folder?.toLowerCase() === f.folder.toLowerCase() ? "is-active" : ""}" href="${href.space(f.folder)}">
            ${avatar(f.folder)}<span>${esc(f.folder)}</span>
          </a>
          ${folder?.toLowerCase() === f.folder.toLowerCase() ? projectLinks(f.folder) : ""}`).join("")
         : `<div class="side-loading">${spinner()}</div>`}`
    : `<p class="side-label">Projects</p>
       <a class="side-item ${r.name === "space" ? "is-active" : ""}" href="${href.space(profile.client_folder)}">${svg("folder")}<span>All projects</span></a>
       ${projectLinks(profile.client_folder)}`;

  sidebar.innerHTML = `
    <a class="side-brand" href="#/">
      <img class="side-brand-logo" src="assets/logotype.png" width="104" height="24" alt="RippleEdit">
      <span class="side-brand-dot" aria-hidden="true"></span>
      <img class="side-brand-mark" src="assets/ripplereview-mark.png" alt="Review">
    </a>
    <nav class="side-nav">${body}</nav>
    ${profile.is_admin ? `
      <div class="side-tools">
        <a class="side-item side-item--tool ${r.name === "home" ? "is-active" : ""}" href="#/">${svg("users")}<span>Manage logins</span></a>
      </div>` : ""}
    <button class="side-foot" type="button" data-profile>
      ${avatar(profile.name || profile.email, { studio: profile.is_admin })}
      <span class="side-me">
        <strong>${esc(profile.name || profile.email)}</strong>
        <small>${profile.is_admin ? "Studio" : "Client"}</small>
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
      parts.push({ label: parseTitle(video.project).title, url: href.project(folder, video.project) });
      parts.push({ label: parseTitle(video.title).title });
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

  const card = (video) => {
    const latest = video.versions.at(-1);
    const status = videoStatus(latest.id, summary);
    const name = parseTitle(video.title);
    return `
      <a class="video-card" href="${href.video(library.client, latest.id)}">
        <div class="video-thumb" data-thumb="${esc(latest.path)}" data-id="${esc(latest.id)}">
          <span class="chip chip--version">v${latest.label}</span>
        </div>
        <div class="video-meta">
          <span class="title-line">${name.code ? `<span class="tag tag--code">${esc(name.code)}</span>` : ""}<h3>${esc(name.title)}</h3></span>
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
        <h1 class="page-title">${esc(only ? parseTitle(only).title : library.client)}</h1>
        <p class="page-sub">${only
          ? `${videos.length} ${videos.length === 1 ? "video" : "videos"}`
          : `${library.projects.length} ${library.projects.length === 1 ? "project" : "projects"} · ${videos.length} ${videos.length === 1 ? "video" : "videos"}`}</p>
      </div>
      ${projects.length ? projects.map((project) => `
        <section class="project">
          ${only ? "" : `<div class="section-label"><a class="section-label-text" href="${href.project(library.client, project.name)}">${esc(parseTitle(project.name).title)}</a><span class="section-label-count">${project.videos.length}</span></div>`}
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

// Me -------------------------------------------------------------------

async function profileDialog() {
  let name = profile.name;
  const save = await dialog({
    title: "You",
    confirmLabel: "Save name",
    cancelLabel: "Close",
    body: `
      <div class="sheet-person">
        ${avatar(profile.name || profile.email, { studio: profile.is_admin, size: "md" })}
        <div><strong>${esc(profile.name || profile.email)}</strong><span>${esc(profile.email)}</span></div>
      </div>
      <div class="form">
        <label><span>Name on your notes</span><input name="name" value="${esc(profile.name)}" placeholder="e.g. Razz" maxlength="40" autocomplete="off"></label>
      </div>
      <p class="sheet-note">${svg("alert")}<span>This is what ${profile.is_admin ? "clients" : "the studio"} sees next to your notes. Yours always show in ${profile.is_admin ? "the studio's orange" : "your own colour"}.</span></p>
      <div class="sheet-signout"><button class="text-button" type="button" data-sign-out>Sign out</button></div>`,
    onOpen: (el) => {
      const input = el.querySelector("input[name=name]");
      input.addEventListener("input", () => { name = input.value.trim(); });
      input.focus();
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
  if (!save || name === profile.name) return;
  try {
    profile = await api.setName(name);
    await renderSidebar(parseRoute());
    toast("Name saved");
  } catch (error) { toast(error.message); }
}

// Admin: clients and their logins -----------------------------------------

function generatePassword() {
  const words = ["bass", "loop", "kick", "snare", "vinyl", "tape", "reverb", "sample", "bounce", "master", "tempo", "chord"];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  return `${pick()}-${pick()}-${pick()}-${10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90)}`;
}

const appUrl = () => `${location.origin}${location.pathname}`;

function inviteText(email, password) {
  return [
    `Your RippleReview login`,
    ``,
    appUrl(),
    `Email: ${email}`,
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
      ${copyField("Email", email)}
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
      <p class="sheet-note" data-note>${svg("folder")}<span>Creates their Dropbox folder if it isn't there yet.</span></p>`,
    onOpen: (el) => {
      const form = el.querySelector("form");
      const note = el.querySelector("[data-note] span");
      el.querySelector("[data-generate]").addEventListener("click", () => { form.password.value = generatePassword(); });
      form.folder.addEventListener("input", () => {
        const name = form.folder.value.trim();
        note.textContent = name ? `Uses Dropbox/Apps/RippleReview/${name}, created if it isn't there yet.` : "Creates their Dropbox folder if it isn't there yet.";
      });
      form.folder.focus();
      // Keep the dialog open while the login is being created.
      form.addEventListener("submit", async (event) => {
        if (el.returnValue === "cancel" || event.submitter?.value !== "confirm") return;
        event.preventDefault();
        const fields = { folder: form.folder.value.trim(), name: form.folder.value.trim(), email: form.email.value.trim(), password: form.password.value };
        if (!fields.folder || !fields.email || fields.password.length < 8) return;
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

async function resetPasswordDialog(folder, login) {
  const password = generatePassword();
  const ok = await dialog({
    title: "New password",
    confirmLabel: "Set new password",
    danger: true,
    body: `
      <p>${esc(login.email)} gets a new password. Their current one stops working straight away.</p>
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
  const ok = await dialog({
    title: "Remove this login?",
    confirmLabel: "Remove login",
    danger: true,
    body: `
      <p><strong>${esc(login.email)}</strong> won't be able to sign in any more.</p>
      <p class="sheet-note">${svg("alert")}<span>Their notes stay, and nothing in your Dropbox is touched.</span></p>`,
  });
  if (!ok) return;
  try {
    await api.removeLogin(login.id);
    clients = null;
    await renderClients();
    await renderSidebar(parseRoute());
    toast("Login removed");
  } catch (error) { toast(error.message); }
}

async function renderClients() {
  view.innerHTML = `<section class="page"><div class="page-head"><h1 class="page-title">Clients</h1>${spinner("Loading")}</div></section>`;
  let data;
  try {
    data = clients ??= await api.clients();
  } catch (error) {
    return renderMessage("Couldn't load clients", error.message);
  }

  const row = (folder, login) => `
    <div class="row" data-folder="${esc(folder)}">
      ${avatar(folder, { size: "md" })}
      <a class="row-name" href="${href.space(folder)}">
        <strong>${esc(folder)}</strong>
        <span>Apps/RippleReview/${esc(folder)}</span>
      </a>
      <span class="row-detail ${login ? "" : "row-detail--none"}">${login ? esc(login.email) : "No login yet"}</span>
      <span class="row-actions">
        ${login ? `
          <button class="icon-button" type="button" data-invite="${esc(login.id)}" title="Copy invite" aria-label="Copy invite for ${esc(folder)}">${svg("copy")}</button>
          <button class="icon-button" type="button" data-reset="${esc(login.id)}" title="New password" aria-label="New password for ${esc(folder)}">${svg("key")}</button>
          <button class="icon-button" type="button" data-remove="${esc(login.id)}" title="Remove login" aria-label="Remove login for ${esc(folder)}">${svg("trash")}</button>`
        : `<button class="button button--compact" type="button" data-add-for="${esc(folder)}">Add login</button>`}
      </span>
    </div>`;

  const rows = data.folders.flatMap((f) => f.logins.length ? f.logins.map((l) => row(f.folder, l)) : [row(f.folder, null)]).join("");

  view.innerHTML = `
    <section class="page">
      <div class="page-head">
        <h1 class="page-title">Clients</h1>
        <p class="page-sub">Each login only ever sees its own folder.</p>
        <div class="page-actions">
          <button class="button button--solid button--compact" type="button" data-add-client>${svg("plus")} Add client</button>
        </div>
      </div>

      ${rows ? `<div class="rows">${rows}</div>` : `<div class="empty"><p>No clients yet.</p><p class="empty-sub">Add your first one to create their folder and login.</p></div>`}

      ${data.orphans.length ? `
        <div class="page-head" style="margin-top:2rem"><h2 class="page-title">Logins without a folder</h2><p class="page-sub">The Dropbox folder these point at is gone.</p></div>
        <div class="rows">${data.orphans.map((l) => `
          <div class="row">
            ${avatar(l.client_folder || l.email, { size: "md" })}
            <span class="row-name"><strong>${esc(l.client_folder || "—")}</strong></span>
            <span class="row-detail">${esc(l.email)}</span>
            <span class="row-actions">
              <button class="icon-button" type="button" data-reset="${esc(l.id)}" title="New password">${svg("key")}</button>
              <button class="icon-button" type="button" data-remove="${esc(l.id)}" title="Remove login">${svg("trash")}</button>
            </span>
          </div>`).join("")}</div>` : ""}
    </section>`;

  const findLogin = (id) => [...data.folders.flatMap((f) => f.logins.map((l) => ({ ...l, folder: f.folder }))), ...data.orphans.map((l) => ({ ...l, folder: l.client_folder }))].find((l) => l.id === id);

  const page = view.querySelector(".page");
  page.querySelector("[data-add-client]").addEventListener("click", addClientDialog);
  page.addEventListener("click", async (event) => {
    const invite = event.target.closest("[data-invite]");
    const reset = event.target.closest("[data-reset]");
    const remove = event.target.closest("[data-remove]");
    const addFor = event.target.closest("[data-add-for]");
    if (invite) {
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
