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
  if (parts[0] === "clients") return { name: "logins" };
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
  } else if (r.name === "logins") {
    await renderClients();
  } else {
    await renderHome();
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
      const active = r.name === "project" && r.project === p.name;
      return `
        <a class="side-link side-link--project ${active ? "is-active" : ""}" href="${href.project(client, p.name)}">
          ${info.code ? `<span class="tag tag--mini ${active ? "tag--code" : "tag--quiet"}">${esc(info.code)}</span>` : ""}
          <span class="side-link-name">${esc(info.title)}</span>
          ${fresh ? `<span class="new-dot" title="Updated since you last looked"></span>` : ""}
          <span class="side-link-count">${svg("film")}${p.videos.length}</span>
        </a>`;
    }).join("");
  };

  const body = profile.is_admin
    ? `<a class="side-link ${r.name === "home" ? "is-active" : ""}" href="#/">${svg("home")}<span class="side-link-name">Home</span></a>
       <p class="side-kicker">Clients</p>
       ${clients ? clients.folders.map((f) => {
          const active = folder?.toLowerCase() === f.folder.toLowerCase();
          return `
            <a class="side-link side-link--client ${active ? "is-active" : ""}" href="${href.space(f.folder)}">
              ${avatar(f.folder, { src: f.logins.find((l) => l.avatar)?.avatar })}
              <span class="side-link-name">${esc(f.folder)}</span>
            </a>
            ${active ? `<div class="side-group side-group--nested">${projectRows(f.folder) || `<p class="side-empty">No projects yet</p>`}</div>` : ""}`;
        }).join("") : `<div class="side-loading">${spinner()}</div>`}`
    : `<a class="side-link side-link--client ${r.name === "space" ? "is-active" : ""}" href="${href.space(profile.client_folder)}">
         ${svg("folder")}<span class="side-link-name">All projects</span>
       </a>
       <div class="side-group">${projectRows(profile.client_folder) || `<p class="side-empty">Nothing here yet</p>`}</div>`;

  sidebar.innerHTML = `
    <a class="side-brand" href="#/">
      <img class="side-brand-logo" src="assets/logotype.png" width="104" height="24" alt="RippleEdit">
      <span class="side-brand-dot" aria-hidden="true"></span>
      <img class="side-brand-mark" src="assets/ripplereview-mark.png?v=5" alt="Review">
    </a>
    <nav class="side-nav">${body}</nav>
    ${profile.is_admin ? `
      <div class="side-tools">
        <a class="side-link side-link--tool ${r.name === "logins" ? "is-active" : ""}" href="#/clients">${svg("users")}<span class="side-link-name">Manage logins</span></a>
        <span class="side-link side-link--soon" title="Create and organise projects from here - coming">${svg("layers")}<span class="side-link-name">Projects</span><span class="side-soon">Soon</span></span>
        <span class="side-link side-link--soon" title="Editors with their own logins and assigned projects - coming">${svg("users")}<span class="side-link-name">Team</span><span class="side-soon">Soon</span></span>
      </div>` : ""}
    <button class="side-foot" type="button" data-profile>
      ${avatar(profile.name || profile.email, { studio: profile.is_admin, src: profile.avatar })}
      <span class="side-me">
        <span class="side-me-line">
          <strong>${esc(profile.name || loginName(profile.email))}</strong>
          ${profile.is_admin ? `<span class="tag tag--code tag--mini">Admin</span>` : ""}
        </span>
        ${profile.is_admin ? `<span class="side-org">@ RippleEdit</span>` : ""}
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

  if (profile.is_admin) parts.push({ label: "Home", url: "#/" });
  if (profile.is_admin && r.name === "logins") parts.push({ label: "Manage logins" });
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
          <img class="signin-mark" src="assets/ripplereview-mark.png?v=5" alt="Review">
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

  const all = profile.is_admin ? library.projects : library.projects.filter((p) => !p.empty);
  const projects = only ? all.filter((p) => p.name === only) : all;
  const videos = projects.flatMap((p) => p.videos);
  const latestIds = videos.map((v) => v.versions.at(-1).id);
  const [summary, submissions] = await Promise.all([
    api.summary(latestIds).catch(() => ({ comments: [], approvals: [] })),
    api.submissions(latestIds).catch(() => []),
  ]);
  const handedOver = new Map(submissions.map((row) => [row.file_id, row]));

  const seen = lastSeen(library.client);
  const card = (video, projectTitle, index = 0) => {
    const latest = video.versions.at(-1);
    const status = videoStatus(latest.id, summary);
    const cut = parseVideo(video.title, projectTitle);
    // New to the studio means "the client finished reviewing since you last
    // looked"; new to the client means "a cut arrived since you last looked".
    const handed = handedOver.get(latest.id);
    const fresh = profile.is_admin
      ? Boolean(handed && seen && handed.created_at > seen)
      : Boolean(seen && latest.modified > seen);
    return `
      <a class="video-card ${fresh ? "is-new" : ""}" style="--ar:${guessRatio(cut)};--i:${index}" href="${href.video(library.client, latest.id)}">
        <div class="video-thumb" data-thumb="${esc(latest.path)}" data-id="${esc(latest.id)}">
          <span class="thumb-left">
            <span class="chip chip--version">v${latest.label}</span>
            <span class="status status--${status.kind}" title="${esc(status.text)}">${status.icon ? svg(status.icon) : `<i></i>`}${esc(status.short)}</span>
            ${fresh ? `<span class="chip chip--new">${profile.is_admin ? "Notes in" : "New"}</span>` : ""}
          </span>
        </div>
        <div class="video-meta">
          <span class="title-line">
            <h3>${esc(cut.label)}</h3>
            ${cut.vsl ? `<span class="tag tag--vsl tag--mini">VSL</span>` : ""}
            ${cut.rough ? `<span class="tag tag--rough tag--mini" title="Polished rough cut: no motion graphics, music or sound design yet">Rough</span>` : ""}
          </span>
          ${cut.extra ? `<p class="video-extra">${esc(cut.extra)}</p>` : ""}
          <p class="video-sub">${video.versions.length > 1 ? `${video.versions.length} versions · ` : ""}${relTime(latest.modified)}</p>
        </div>
      </a>`;
  };

  const statuses = profile.is_admin || true ? await api.statuses(library.client).catch(() => []) : [];
  const finishedSet = new Set(statuses.filter((row) => row.finished).map((row) => row.project));
  // Finished work sinks to the bottom; live jobs stay on top, newest first.
  const ordered = only
    ? projects
    : [...projects].sort((a, b) => (finishedSet.has(a.name) - finishedSet.has(b.name)) || byJobNumber(a, b));
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
        const finished = finishedSet.has(project.name);
        const open = only || (index === 0 && !finished);   // the live job you came for
        return `
        <section class="project ${open ? "is-open" : ""} ${finished ? "is-finished" : ""}" data-project="${esc(project.name)}">
          ${only ? "" : `
            <div class="project-head-row">
              <button class="project-head" type="button" data-toggle aria-expanded="${open}">
                <span class="project-chevron" aria-hidden="true">${svg("chevron")}</span>
                ${info.code ? `<span class="tag ${finished ? "tag--quiet" : "tag--code"}">${esc(info.code)}</span>` : ""}
                <span class="project-name">${esc(info.title)}</span>
                ${finished ? `<span class="tag tag--quiet tag--mini">Finished</span>` : ""}
                <span class="project-count">${svg("film")}${project.videos.length}</span>
              </button>
              ${profile.is_admin ? `
                <button class="icon-button project-finish" type="button" data-finish="${esc(project.name)}" data-finished="${finished}"
                  title="${finished ? "Reopen this project" : "Mark this project finished"}" aria-label="${finished ? "Reopen this project" : "Mark this project finished"}">
                  ${svg(finished ? "undo" : "check")}
                </button>` : ""}
            </div>`}
          <div class="project-body"><div class="video-grid">${project.videos.length
            ? sortCuts(project).map((video, i) => card(video, info.title, i)).join("")
            : `<p class="feed-empty">No videos in this project yet. Drop one into Dropbox/Apps/RippleReview/${esc(library.client)}/${esc(project.name)}/ and hit refresh.</p>`}</div></div>
        </section>`;
      }).join("") : `
        <div class="empty">
          <p>Nothing here yet.</p>
          <p class="empty-sub">${profile.is_admin
            ? `Drop a video into Dropbox/Apps/RippleReview/${esc(library.client)}/&lt;Project&gt;/ and hit refresh.`
            : "We'll let you know when your first cut is ready."}</p>
        </div>`}
    </section>`;

  view.querySelectorAll("[data-finish]").forEach((button) => {
    button.addEventListener("click", async () => {
      const project = button.dataset.finish;
      const finished = button.dataset.finished !== "true";
      button.disabled = true;
      try {
        await api.setFinished(library.client, project, finished);
        await renderSpace(folder, only);
        toast(finished ? "Marked finished" : "Reopened");
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
  });

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
        // Home's blocks are a fixed height, so only the library's cards reshape.
        const card = slot.closest(".video-card");
        if (card && img.naturalWidth && img.naturalHeight) card.style.setProperty("--ar", img.naturalWidth / img.naturalHeight);
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
        const card = slot.closest(".video-card");
        if (card && clip.videoWidth && clip.videoHeight) card.style.setProperty("--ar", clip.videoWidth / clip.videoHeight);
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
    title: "Your profile",
    confirmLabel: "Save",
    cancelLabel: "Close",
    body: `
      <div class="profile-top">
        <span data-avatar-slot>${avatar(profile.name || profile.email, { studio: profile.is_admin, size: "lg", src: avatarSrc })}</span>
        <div class="profile-id">
          <strong>${esc(profile.name || loginName(profile.email))}</strong>
          <span>${esc(loginName(profile.email))}</span>
          <span class="profile-pic-actions">
            <button class="button button--compact" type="button" data-pick>${svg("image")}<span data-pick-label>${avatarSrc ? "Change picture" : "Add picture"}</span></button>
            <button class="icon-button" type="button" data-drop title="Remove picture" aria-label="Remove picture" ${avatarSrc ? "" : "hidden"}>${svg("trash")}</button>
          </span>
        </div>
      </div>
      <input type="file" accept="image/*" hidden data-file>

      <div class="form">
        <label>
          <span>Display name</span>
          <input name="name" value="${esc(profile.name)}" placeholder="e.g. Razz" maxlength="40" autocomplete="off">
        </label>
        <p class="field-hint">Shown on every note you write${profile.is_admin ? ", followed by @ RippleEdit" : ""}.</p>
      </div>

      <div class="sheet-divider"></div>
      <button class="button button--compact button--wide" type="button" data-sign-out>${svg("logout")}<span>Sign out</span></button>`,
    onOpen: (el) => {
      const input = el.querySelector("input[name=name]");
      const file = el.querySelector("[data-file]");
      const slot = el.querySelector("[data-avatar-slot]");
      const drop = el.querySelector("[data-drop]");
      const label = el.querySelector("[data-pick-label]");
      const draw = () => { slot.innerHTML = avatar(name || profile.email, { studio: profile.is_admin, size: "lg", src: avatarSrc }); };

      input.addEventListener("input", () => { name = input.value.trim(); });
      input.focus();

      el.querySelector("[data-pick]").addEventListener("click", () => file.click());
      file.addEventListener("change", async () => {
        if (!file.files?.[0]) return;
        try {
          avatarSrc = await squareDataUrl(file.files[0]);
          touchedPicture = true;
          draw();
          drop.hidden = false;
          label.textContent = "Change picture";
        } catch (error) { toast(error.message); }
      });
      drop.addEventListener("click", () => {
        avatarSrc = null;
        touchedPicture = true;
        draw();
        drop.hidden = true;
        label.textContent = "Add picture";
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

// Home: the studio's one-look view -----------------------------------------

// Everything on this page comes from listings we already fetch, so it costs
// one Dropbox call per client and nothing else.
async function gatherHome() {
  const list = clients ??= await api.clients();
  const spaces = await Promise.all(list.folders.map(async (entry) => {
    const library = await getLibrary(entry.folder).catch(() => null);
    return { ...entry, library };
  }));

  const cuts = [];
  for (const space of spaces) {
    for (const project of space.library?.projects ?? []) {
      for (const video of project.videos) {
        const latest = video.versions.at(-1);
        cuts.push({ client: space.library.client, folder: space.folder, project, video, latest });
      }
    }
  }

  const ids = cuts.map((cut) => cut.latest.id);
  const [summary, submissions, statuses] = await Promise.all([
    api.summary(ids).catch(() => ({ comments: [], approvals: [] })),
    api.submissions(ids).catch(() => []),
    Promise.all(spaces.map((space) => api.statuses(space.folder).catch(() => []))).then((all) => all.flat()),
  ]);

  const handed = new Map();
  for (const row of submissions) if (!handed.has(row.file_id)) handed.set(row.file_id, row);
  const finished = new Set(statuses.filter((row) => row.finished).map((row) => `${row.client_folder}/${row.project}`));

  for (const cut of cuts) {
    cut.status = videoStatus(cut.latest.id, summary);
    cut.handed = handed.get(cut.latest.id) ?? null;
    cut.finished = finished.has(`${cut.folder.toLowerCase()}/${cut.project.name}`);
    cut.title = parseVideo(cut.video.title, parseTitle(cut.project.name).title);
  }

  // A project is the unit of work, so the overview counts in projects.
  const jobs = new Map();
  for (const cut of cuts) {
    const key = `${cut.folder}/${cut.project.name}`;
    if (!jobs.has(key)) {
      const info = parseTitle(cut.project.name);
      jobs.set(key, {
        key, folder: cut.folder, client: cut.client, name: cut.project.name,
        code: info.code, title: info.title, finished: cut.finished,
        cuts: [], openNotes: 0, approved: 0, handedAt: null, modified: cut.project.modified,
      });
    }
    const job = jobs.get(key);
    job.cuts.push(cut);
    job.openNotes += summary.comments.filter((c) => c.file_id === cut.latest.id && !c.parent_id && !c.done).length;
    if (cut.status.kind === "approved") job.approved += 1;
    if (cut.handed && (!job.handedAt || cut.handed.created_at > job.handedAt)) job.handedAt = cut.handed.created_at;
  }
  for (const job of jobs.values()) {
    job.cuts.sort((a, b) => a.title.rank - b.title.rank || a.title.number - b.title.number);
    job.cover = job.cuts[0];
    job.waiting = job.openNotes > 0 || Boolean(job.handedAt);
  }

  return { spaces, cuts, jobs: [...jobs.values()], summary, finished };
}

async function renderHome() {
  view.innerHTML = `<section class="page"><div class="page-head"><h1 class="page-title">Home</h1>${spinner("Gathering everything")}</div></section>`;
  let data;
  try {
    data = await gatherHome();
  } catch (error) {
    return renderMessage("Couldn't load your overview", error.message);
  }

  const live = data.jobs.filter((job) => !job.finished);
  const yours = live.filter((job) => job.waiting)
    .sort((a, b) => (b.handedAt ?? "").localeCompare(a.handedAt ?? "") || b.modified.localeCompare(a.modified));
  const theirs = live.filter((job) => !job.waiting && job.approved < job.cuts.length)
    .sort((a, b) => a.modified.localeCompare(b.modified));

  const openNotes = data.summary.comments.filter((c) => !c.parent_id && !c.done).length;
  const approved = data.cuts.filter((cut) => cut.status.kind === "approved").length;
  const faceOf = (folder) => data.spaces.find((s) => s.folder === folder)?.logins.find((l) => l.avatar)?.avatar;

  const stat = (value, label, lead = false) => `
    <div class="stat ${lead && value ? "is-lead" : ""}">
      <strong>${value}</strong>
      <span>${label}</span>
    </div>`;

  const job = (item, line) => `
    <a class="job-card" href="${href.project(item.client, item.name)}">
      <span class="job-cover" data-thumb="${esc(item.cover.latest.path)}" data-id="${esc(item.cover.latest.id)}">
        ${item.handedAt ? `<span class="chip chip--new">Notes in</span>` : ""}
      </span>
      <span class="job-body">
        <span class="job-title">
          ${item.code ? `<span class="tag tag--code tag--mini">${esc(item.code)}</span>` : ""}
          <strong>${esc(item.title)}</strong>
        </span>
        <span class="job-client">${avatar(item.client, { src: faceOf(item.folder) })}${esc(item.client)}</span>
        <span class="job-foot">
          <span>${svg("film")}${item.cuts.length}</span>
          ${item.openNotes ? `<span class="job-notes">${svg("message")}${item.openNotes}</span>` : ""}
          ${item.approved ? `<span class="job-ok">${svg("check")}${item.approved}</span>` : ""}
          <span class="feed-when">${line(item)}</span>
        </span>
      </span>
    </a>`;

  view.innerHTML = `
    <section class="page">
      <div class="page-head">
        <h1 class="page-title">Home</h1>
        <p class="page-sub">Everything in review, in one look.</p>
      </div>

      <div class="stats">
        ${stat(yours.length, "With you", true)}
        ${stat(theirs.length, "With clients")}
        ${stat(live.length, "Live projects")}
        ${stat(openNotes, "Open notes")}
        ${stat(approved, "Approved cuts")}
      </div>

      <section class="home-block">
        <div class="home-head"><h2>With you</h2><span class="home-count">${yours.length}</span><p>Clients have sent these back.</p></div>
        ${yours.length
          ? `<div class="job-grid">${yours.map((item) => job(item, (j) => j.handedAt ? `Notes in ${esc(relTime(j.handedAt))}` : `Updated ${esc(relTime(j.modified))}`)).join("")}</div>`
          : `<p class="feed-empty">Nothing waiting on you. Enjoy it.</p>`}
      </section>

      <section class="home-block">
        <div class="home-head"><h2>With clients</h2><span class="home-count">${theirs.length}</span><p>Out for review, longest wait first.</p></div>
        ${theirs.length
          ? `<div class="job-grid">${theirs.map((item) => job(item, (j) => `${svg("clock")} sent ${esc(relTime(j.modified))}`)).join("")}</div>`
          : `<p class="feed-empty">Nothing out for review right now.</p>`}
      </section>

      <section class="home-block">
        <div class="home-head"><h2>Clients</h2><span class="home-count">${data.spaces.length}</span><p>Everyone you work with.</p></div>
        <div class="client-grid">
          ${data.spaces.map((space) => {
            const mine = live.filter((item) => item.folder === space.folder);
            const login = space.logins[0];
            const latest = mine.map((item) => item.modified).sort().at(-1);
            const waiting = mine.filter((item) => item.waiting).length;
            return `
              <a class="client-card" href="${href.space(space.folder)}">
                <span class="client-card-main">
                  ${avatar(space.folder, { size: "md", src: login?.avatar })}
                  <span class="client-card-name">
                    <strong>${esc(space.folder)}${updated(space.folder) ? `<span class="new-dot"></span>` : ""}</strong>
                    ${login ? presenceLine(login) : `<span class="client-card-login client-card-none">No login yet</span>`}
                  </span>
                  ${waiting ? `<span class="tag tag--code tag--mini" title="${waiting} waiting on you">${waiting}</span>` : ""}
                </span>
                <span class="client-card-stats">
                  <span>${svg("folder")}${mine.length} live</span>
                  <span>${svg("film")}${mine.reduce((sum, item) => sum + item.cuts.length, 0)}</span>
                  ${latest ? `<span class="feed-when">${esc(relTime(latest))}</span>` : ""}
                </span>
              </a>`;
          }).join("")}
        </div>
      </section>
    </section>`;

  fillThumbs([...view.querySelectorAll("[data-thumb]")]);
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
      <div class="profile-top">
        <span data-avatar-slot>${avatar(folder, { size: "lg", src: login.avatar })}</span>
        <div class="profile-id">
          <strong>${esc(folder)}</strong>
          <span>${esc(loginName(login.email))}</span>
          <span class="profile-pic-actions">
            <button class="button button--compact" type="button" data-pick>${svg("image")}<span data-pick-label>${login.avatar ? "Change picture" : "Add picture"}</span></button>
            <button class="icon-button" type="button" data-drop title="Remove picture" aria-label="Remove picture" ${login.avatar ? "" : "hidden"}>${svg("trash")}</button>
          </span>
        </div>
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
          slot.innerHTML = avatar(folder, { size: "lg", src: picture });
          drop.hidden = false;
          el.querySelector("[data-pick-label]").textContent = "Change picture";
        } catch (error) { toast(error.message); }
      });
      drop.addEventListener("click", () => {
        picture = null;
        slot.innerHTML = avatar(folder, { size: "lg" });
        drop.hidden = true;
        el.querySelector("[data-pick-label]").textContent = "Add picture";
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

// Online now, or when they were last here. Studio-side only: nothing about
// this is shown to the client about themselves or anyone else.
function presenceLine(login) {
  if (!login.last_seen) return `<span class="presence presence--never">Never signed in</span>`;
  const minutes = (Date.now() - new Date(login.last_seen).getTime()) / 60000;
  return minutes < 3
    ? `<span class="presence presence--on"><i></i>Online now</span>`
    : `<span class="presence">Last seen ${esc(relTime(login.last_seen))}</span>`;
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
      <button class="client-card-main" type="button" ${login ? `data-edit="${esc(login.id)}"` : `data-add-for="${esc(folder)}"`}>
        ${avatar(folder, { size: "md", src: login?.avatar })}
        <span class="client-card-name">
          <strong>${esc(folder)}${updated(folder) ? `<span class="new-dot" title="Updated since you last looked"></span>` : ""}</strong>
          <span class="client-card-login ${login ? "" : "client-card-none"}">${login ? esc(loginName(login.email)) : "No login yet"}</span>
          ${login ? presenceLine(login) : ""}
        </span>
      </button>
      <div class="client-card-tools">
        ${login ? `
          <a class="icon-button" href="${href.space(folder)}" title="Open their space" aria-label="Open ${esc(folder)}'s space">${svg("folder")}</a>
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

// Presence: the app touches its own timestamp while it is open. Only the
// studio ever sees these; nothing is shown on the client's side.
function keepPresence() {
  const beat = () => { if (!document.hidden && profile) api.touch().catch(() => {}); };
  beat();
  setInterval(beat, 60000);
  document.addEventListener("visibilitychange", beat);
}

window.addEventListener("hashchange", route);
route().then(keepPresence);
