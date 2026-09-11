// RippleReview: routing, sign-in, the client spaces and the admin's client list.
// The review screen itself (player and notes) lives in review.js.

import { api } from "./api.js";
import { renderReview } from "./review.js";
import { esc, relTime, toast, videoStatus } from "./ui.js";

const view = document.querySelector("[data-view]");
const header = document.querySelector("[data-header]");
let profile = null;
let cleanup = null;

// Routes: #/                      admin: clients · client: their space
//         #/c/<folder>            a client space
//         #/c/<folder>/<fileId>   reviewing one video
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "c" && parts[1]) return { name: parts[2] ? "review" : "space", folder: parts[1], fileId: parts[2] };
  return { name: "home" };
}

async function route() {
  cleanup?.();
  cleanup = null;
  window.scrollTo(0, 0);

  profile = await api.session();
  if (!profile) return renderSignIn();

  header.hidden = false;
  document.querySelector("[data-user-name]").textContent = profile.name || profile.email;
  document.querySelector("[data-nav]").innerHTML = profile.is_admin
    ? `<a href="#/" class="${parseRoute().name === "home" ? "is-active" : ""}">Clients</a>`
    : "";

  const r = parseRoute();
  const ownFolder = profile.is_admin ? r.folder : profile.client_folder;
  if (!profile.is_admin && !ownFolder) return renderMessage("Your space isn't ready yet", "RippleEdit hasn't linked a project folder to this login. Give us a shout and we'll sort it.");
  if (r.name === "review") cleanup = await renderReview(view, { folder: ownFolder, fileId: r.fileId, profile });
  else if (r.name === "space" || !profile.is_admin) await renderSpace(ownFolder);
  else await renderClients();
}

function renderMessage(title, text) {
  view.innerHTML = `
    <section class="page page--narrow">
      <p class="kicker"><span class="live-dot" aria-hidden="true"></span> RippleReview</p>
      <h1 class="page-title">${esc(title)}</h1>
      <p class="page-lede">${esc(text)}</p>
    </section>`;
}

// Sign in -----------------------------------------------------------------

function renderSignIn() {
  header.hidden = true;
  view.innerHTML = `
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

  const form = view.querySelector("[data-signin]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector("[data-status]");
    const button = form.querySelector("button");
    button.disabled = true;
    status.textContent = "Signing in…";
    try {
      await api.signIn(form.email.value.trim(), form.password.value);
      route();
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}

document.querySelector("[data-sign-out]").addEventListener("click", async () => {
  await api.signOut();
  location.hash = "#/";
  route();
});

// A client's space: their projects and videos ----------------------------

async function renderSpace(folder) {
  view.innerHTML = `<section class="page"><div class="boot"><span class="live-dot"></span> Loading projects</div></section>`;
  let library;
  try {
    library = await api.library(folder);
  } catch (error) {
    return renderMessage("Couldn't load this space", error.message);
  }

  const videos = library.projects.flatMap((p) => p.videos);
  const latestIds = videos.map((v) => v.versions.at(-1).id);
  const summary = await api.summary(latestIds).catch(() => ({ comments: [], approvals: [] }));

  const card = (video) => {
    const latest = video.versions.at(-1);
    const status = videoStatus(latest.id, summary);
    return `
      <a class="video-card" href="#/c/${encodeURIComponent(library.client)}/${encodeURIComponent(latest.id)}">
        <div class="video-thumb" data-thumb="${esc(latest.path)}" data-id="${esc(latest.id)}">
          <span class="chip chip--version">v${latest.label}</span>
        </div>
        <div class="video-meta">
          <h3>${esc(video.title)}</h3>
          <p class="video-sub">${video.versions.length > 1 ? `${video.versions.length} versions · ` : ""}Updated ${relTime(latest.modified)}</p>
          <span class="status status--${status.kind}">${esc(status.text)}</span>
        </div>
      </a>`;
  };

  view.innerHTML = `
    <section class="page">
      ${profile.is_admin ? `<a class="back-link" href="#/">← All clients</a>` : ""}
      <p class="kicker"><span class="live-dot" aria-hidden="true"></span> ${profile.is_admin ? "Client space" : "Your space"}</p>
      <h1 class="page-title">${esc(library.client)}</h1>
      <p class="page-lede">${profile.is_admin
        ? `Drop videos into <code>Dropbox/Apps/RippleReview/${esc(library.client)}/&lt;Project&gt;/</code>. Name new cuts “Title v2”, “Title v3” to stack them as versions.`
        : "Every cut we've made for you. Open a video, pause anywhere and leave a note."}</p>
      ${library.projects.length ? library.projects.map((project) => `
        <section class="project">
          <div class="section-label"><span class="section-label-text">${esc(project.name)}</span><span class="section-label-count">${project.videos.length} ${project.videos.length === 1 ? "video" : "videos"}</span></div>
          <div class="video-grid">${project.videos.map(card).join("")}</div>
        </section>`).join("") : `
        <div class="empty">
          <p>Nothing here yet.</p>
          <p class="empty-sub">${profile.is_admin ? "Add a project folder with a video in Dropbox, then refresh." : "We'll let you know when your first cut is ready."}</p>
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

async function renderClients() {
  view.innerHTML = `<section class="page"><div class="boot"><span class="live-dot"></span> Loading clients</div></section>`;
  let data;
  try {
    data = await api.clients();
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
      <p class="kicker"><span class="live-dot" aria-hidden="true"></span> Studio</p>
      <h1 class="page-title">Clients</h1>
      <p class="page-lede">One folder per client in <code>Dropbox/Apps/RippleReview</code>. Each login only ever sees its own folder.</p>

      <div class="clients-layout">
        <div class="client-grid">
          ${data.folders.map((f) => `
            <article class="client-card">
              <a class="client-card-head" href="#/c/${encodeURIComponent(f.folder)}">
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
  const handoff = view.querySelector("[data-handoff]");
  const note = view.querySelector("[data-folder-note]");
  form.folder.addEventListener("input", () => {
    const name = form.folder.value.trim();
    note.textContent = name ? `Uses Dropbox/Apps/RippleReview/${name} (created if missing).` : "Creates the Dropbox folder if it doesn't exist.";
  });
  view.querySelector("[data-generate]").addEventListener("click", () => { form.password.value = generatePassword(); });

  function showHandoff(email, password) {
    handoff.hidden = false;
    handoff.querySelector("[data-handoff-text]").textContent = loginMessage(email, password);
  }

  view.querySelector("[data-copy]").addEventListener("click", async () => {
    await navigator.clipboard.writeText(handoff.querySelector("[data-handoff-text]").textContent);
    toast("Copied");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector("[data-status]");
    const fields = { folder: form.folder.value.trim(), name: form.folder.value.trim(), email: form.email.value.trim(), password: form.password.value };
    status.textContent = "Creating…";
    try {
      await api.createClient(fields);
      await renderClients();
      showHandoffAfterRender(fields.email, fields.password);
      toast(`Login created for ${fields.folder}`);
    } catch (error) {
      status.textContent = error.message;
    }
  });

  view.querySelector(".client-grid").addEventListener("click", async (event) => {
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
        await renderClients();
        toast("Login removed");
      } catch (error) { toast(error.message); }
    }
  });
}

// renderClients rebuilds the page, so the handoff box is found again afterwards.
function showHandoffAfterRender(email, password) {
  const box = view.querySelector("[data-handoff]");
  if (!box) return;
  box.hidden = false;
  box.querySelector("[data-handoff-text]").textContent = loginMessage(email, password);
}

window.addEventListener("hashchange", route);
route();
