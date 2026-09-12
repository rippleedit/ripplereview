// The review screen: the player on the left, the notes on the right.
//
// Notes are pinned to a moment (and optionally a spot on the frame). Clicking
// a note jumps the player there; the marks on the scrub bar are the same notes.

import { api } from "./api.js";
import { download, FRAME_RATES, frameOf, snapRate, timecode, toCsv, toResolveEdl, toText } from "./timecode.js";
import { avatar, dialog, esc, href, parseTitle, relTime, spinner, svg, titleTag, toast } from "./ui.js";

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13M16 5.5v13"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5zM16 9.5l5 5M21 9.5l-5 5"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
};

const readFps = (id) => { try { return Number(localStorage.getItem(`rr-fps:${id}`)) || null; } catch { return null; } };
const saveFps = (id, fps) => { try { localStorage.setItem(`rr-fps:${id}`, String(fps)); } catch {} };

export async function renderReview(view, { folder, fileId, profile, getLibrary }) {
  view.innerHTML = `<section class="page">${spinner("Loading video")}</section>`;

  let library;
  try {
    library = await getLibrary(folder);
  } catch (error) {
    view.innerHTML = `<section class="page page--narrow"><h1 class="page-title">Couldn't load this video</h1><p class="page-lede">${esc(error.message)}</p></section>`;
    return null;
  }

  let project, video, version;
  for (const p of library.projects) for (const v of p.videos) for (const ver of v.versions) {
    if (ver.id === fileId) { project = p; video = v; version = ver; }
  }
  if (!version) {
    view.innerHTML = `<section class="page page--narrow"><h1 class="page-title">This video has moved</h1><p class="page-lede">It's no longer in this space. Pick it again from the list.</p></section>`;
    return null;
  }

  const projectHref = href.project(library.client, project.name);
  const name = parseTitle(video.title);
  const latest = video.versions.at(-1);
  const state = {
    comments: [],
    people: new Map(),          // who is in this space, for names and faces
    approval: null,
    fps: readFps(fileId) ?? 25,
    fpsChosen: readFps(fileId) != null,
    filter: "all",
    activeId: null,
    general: false,
    pinMode: false,
    draftPin: null,
    replyingTo: null,
  };

  view.innerHTML = `
    <section class="review">
      <div class="review-bar">
        <span class="title-line">
          ${name.code ? `<span class="tag tag--code">${esc(name.code)}</span>` : ""}
          <h1 class="review-title">${esc(name.title)}</h1>
          ${name.preview ? `<span class="tag tag--preview">Preview</span>` : ""}
        </span>
        ${video.versions.length > 1 ? `
          <nav class="versions" aria-label="Versions">
            ${video.versions.map((v) => `<a href="${href.video(library.client, v.id)}" class="${v.id === fileId ? "is-active" : ""}" ${v.id === fileId ? 'aria-current="page"' : ""}>v${v.label}</a>`).join("")}
          </nav>` : ""}
      </div>

      <div class="review-layout">
        <div class="review-main">
          <div class="player-shell" data-player-shell>
            <div class="player" data-player>
              <video playsinline preload="auto" data-video></video>
              <div class="player-layer" data-layer></div>
              <p class="player-hint" data-pin-hint hidden>Click the frame to mark the spot</p>
              <div class="player-state" data-player-state>${spinner("Loading")}</div>
            </div>
            <div class="controls">
              <button class="round" type="button" data-play aria-label="Play">${ICON.play}</button>
              <span class="tc" data-tc>00:00:00:00</span>
              <div class="scrub" data-scrub role="slider" aria-label="Position" tabindex="0">
                <div class="scrub-track"><i class="scrub-buffer" data-buffer></i><i class="scrub-fill" data-fill></i></div>
                <div class="scrub-marks" data-marks></div>
                <i class="scrub-head" data-head></i>
              </div>
              <span class="tc tc--dim" data-duration>--:--:--:--</span>
              <button class="round round--quiet" type="button" data-mute aria-label="Mute">${ICON.sound}</button>
              <label class="fps" title="Frame rate used for timecode">
                <select data-fps aria-label="Frame rate">${FRAME_RATES.map((r) => `<option value="${r}">${r} fps</option>`).join("")}</select>
              </label>
              <button class="round round--quiet" type="button" data-full aria-label="Full screen">${ICON.full}</button>
            </div>
          </div>

          <div class="review-meta">
            <div>
              <p class="review-where"><a href="${projectHref}">${esc(parseTitle(project.name).title)}</a> · ${esc(version.name)}</p>
              ${latest.id !== fileId ? `<p class="review-older">This is an older cut. <a class="text-link" href="${href.video(library.client, latest.id)}">Watch v${latest.label}, the latest →</a></p>` : ""}
              <p class="review-keys">Space play · ← → one frame · Shift ← → one second</p>
            </div>
            <div class="approval" data-approval></div>
          </div>
        </div>

        <aside class="notes" aria-label="Notes">
          <div class="notes-head">
            <div class="section-label"><span class="section-label-text">Notes</span><span class="section-label-count" data-count></span></div>
            <div class="notes-tools">
              <div class="tabs" role="tablist" data-tabs>
                <button type="button" data-filter="all" class="is-active">All</button>
                <button type="button" data-filter="open">Open</button>
                <button type="button" data-filter="done">Done</button>
              </div>
              <details class="menu" data-menu>
                <summary class="text-button">Export</summary>
                <div class="menu-list">
                  <button type="button" data-export="txt">Text list <small>.txt</small></button>
                  <button type="button" data-export="csv">Spreadsheet <small>.csv</small></button>
                  <button type="button" data-export="edl">Resolve markers <small>.edl</small></button>
                </div>
              </details>
            </div>
          </div>

          <form class="composer" data-composer>
            <div class="composer-top">
              <button type="button" class="tc-chip" data-when title="Click for a general note without timecode"></button>
              <button type="button" class="pin-toggle" data-pin-toggle>${ICON.pin}<span>Mark a spot</span></button>
            </div>
            <textarea name="body" rows="3" placeholder="Pause anywhere and write your note…" data-body></textarea>
            <div class="composer-foot">
              <span class="composer-hint">Enter to send · Shift+Enter new line</span>
              <button class="button button--solid button--compact" type="submit">Send</button>
            </div>
          </form>

          <ol class="note-list" data-notes></ol>
        </aside>
      </div>
    </section>`;

  const $ = (selector) => view.querySelector(selector);
  const videoEl = $("[data-video]");
  const player = $("[data-player]");
  const layer = $("[data-layer]");
  const scrub = $("[data-scrub]");
  const composer = $("[data-composer]");
  const body = $("[data-body]");
  const fpsSelect = $("[data-fps]");
  const playerState = $("[data-player-state]");

  // Player ----------------------------------------------------------------

  let reloadedLink = false;
  async function loadSource(resumeAt = 0) {
    try {
      videoEl.src = await api.link(fileId);
      if (resumeAt) videoEl.addEventListener("loadedmetadata", () => { videoEl.currentTime = resumeAt; }, { once: true });
    } catch (error) {
      playerState.textContent = error.message;
    }
  }

  videoEl.addEventListener("loadedmetadata", () => {
    playerState.hidden = true;
    const ratio = videoEl.videoWidth && videoEl.videoHeight ? videoEl.videoWidth / videoEl.videoHeight : 16 / 9;
    player.style.setProperty("--ratio", ratio);
    $("[data-duration]").textContent = timecode(videoEl.duration, state.fps);
    fitLayer();
    renderMarks();
  });

  videoEl.addEventListener("error", () => {
    // Dropbox links last four hours; a long session gets a fresh one.
    if (!reloadedLink && videoEl.currentTime > 0) {
      reloadedLink = true;
      loadSource(videoEl.currentTime);
      return;
    }
    playerState.hidden = false;
    playerState.textContent = "This file can't play in the browser. Export an H.264 .mp4 review copy.";
  });

  const togglePlay = () => (videoEl.paused ? videoEl.play() : videoEl.pause());

  function stepFrames(n) {
    videoEl.pause();
    const target = frameOf(videoEl.currentTime, state.fps) + n;
    videoEl.currentTime = Math.max(0, Math.min(videoEl.duration || 0, (target + 0.5) / state.fps));
  }

  function seek(seconds) {
    videoEl.currentTime = Math.max(0, Math.min(videoEl.duration || 0, seconds));
  }

  // The drawn picture inside the player box (letterboxing aside), so pins
  // land on the same spot at any size, in full screen too.
  function contentRect() {
    const box = player.getBoundingClientRect();
    const ratio = videoEl.videoWidth / videoEl.videoHeight || 16 / 9;
    let width = box.width, height = box.width / ratio;
    if (height > box.height) { height = box.height; width = height * ratio; }
    return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
  }

  function fitLayer() {
    const r = contentRect();
    Object.assign(layer.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  const resizer = new ResizeObserver(fitLayer);
  resizer.observe(player);

  player.addEventListener("click", (event) => {
    if (!state.pinMode) return togglePlay();
    const r = layer.getBoundingClientRect();
    const x = (event.clientX - r.left) / r.width;
    const y = (event.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    state.draftPin = { x, y };
    setPinMode(false);
    renderWhen();
    renderPins();
    body.focus();
  });

  $("[data-play]").addEventListener("click", togglePlay);
  $("[data-mute]").addEventListener("click", () => { videoEl.muted = !videoEl.muted; });
  videoEl.addEventListener("volumechange", () => {
    $("[data-mute]").innerHTML = videoEl.muted ? ICON.muted : ICON.sound;
  });
  $("[data-full]").addEventListener("click", () => {
    const shell = $("[data-player-shell]");
    if (document.fullscreenElement) document.exitFullscreen();
    else if (shell.requestFullscreen) shell.requestFullscreen();
    else videoEl.webkitEnterFullscreen?.(); // iPhone
  });

  for (const type of ["play", "pause"]) {
    videoEl.addEventListener(type, () => {
      const playing = !videoEl.paused;
      $("[data-play]").innerHTML = playing ? ICON.pause : ICON.play;
      $("[data-play]").setAttribute("aria-label", playing ? "Pause" : "Play");
      view.classList.toggle("is-playing", playing);
      if (playing) tick();
      renderPins();
    });
  }
  videoEl.addEventListener("seeked", () => { renderClock(); renderPins(); });
  videoEl.addEventListener("progress", renderBuffer);

  let frameRequest = 0;
  function tick() {
    renderClock();
    if (!videoEl.paused) frameRequest = requestAnimationFrame(tick);
  }

  function renderClock() {
    const t = videoEl.currentTime;
    $("[data-tc]").textContent = timecode(t, state.fps);
    const pct = videoEl.duration ? (t / videoEl.duration) * 100 : 0;
    $("[data-fill]").style.width = `${pct}%`;
    $("[data-head]").style.left = `${pct}%`;
    scrub.setAttribute("aria-valuetext", timecode(t, state.fps));
    renderWhen();
  }

  function renderBuffer() {
    const b = videoEl.buffered;
    if (!b.length || !videoEl.duration) return;
    $("[data-buffer]").style.width = `${(b.end(b.length - 1) / videoEl.duration) * 100}%`;
  }

  // Scrubbing: press and drag anywhere on the bar.
  function scrubTo(event) {
    const r = scrub.getBoundingClientRect();
    seek(((event.clientX - r.left) / r.width) * (videoEl.duration || 0));
    renderClock();
  }
  scrub.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-mark]")) return;
    scrub.setPointerCapture(event.pointerId);
    videoEl.pause();
    scrubTo(event);
    const move = (e) => scrubTo(e);
    scrub.addEventListener("pointermove", move);
    scrub.addEventListener("pointerup", () => scrub.removeEventListener("pointermove", move), { once: true });
  });

  // Frame rate: remembered per video; measured from playback until chosen.
  fpsSelect.value = String(state.fps);
  fpsSelect.addEventListener("change", () => {
    state.fps = Number(fpsSelect.value);
    state.fpsChosen = true;
    saveFps(fileId, state.fps);
    refreshTimecodes();
  });

  function refreshTimecodes() {
    fpsSelect.value = String(state.fps);
    if (videoEl.duration) $("[data-duration]").textContent = timecode(videoEl.duration, state.fps);
    renderClock();
    renderNotes();
  }

  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype && !state.fpsChosen) {
    let last = null;
    const deltas = [];
    const measure = (_, meta) => {
      if (last && !videoEl.paused && meta.presentedFrames - last.presentedFrames === 1) {
        const delta = meta.mediaTime - last.mediaTime;
        if (delta > 0.005 && delta < 0.1) deltas.push(delta);
      }
      last = meta;
      if (deltas.length < 24) return videoEl.requestVideoFrameCallback(measure);
      deltas.sort((a, b) => a - b);
      if (!state.fpsChosen) {
        state.fps = snapRate(1 / deltas[12]);
        saveFps(fileId, state.fps);
        refreshTimecodes();
      }
    };
    videoEl.requestVideoFrameCallback(measure);
  }

  // Pins and scrub marks ----------------------------------------------------

  function topNotes() {
    return state.comments
      .filter((c) => !c.parent_id)
      .sort((a, b) => (a.time_sec ?? Infinity) - (b.time_sec ?? Infinity) || a.created_at.localeCompare(b.created_at));
  }

  function numbered() {
    return topNotes().map((c, i) => ({ ...c, n: i + 1 }));
  }

  function renderPins() {
    const here = frameOf(videoEl.currentTime, state.fps);
    const pins = videoEl.paused
      ? numbered().filter((c) => c.pin_x != null && c.time_sec != null && frameOf(c.time_sec, state.fps) === here)
      : [];
    layer.innerHTML = pins.map((c) => `
      <span class="pin ${c.id === state.activeId ? "is-active" : ""} ${c.done ? "is-done" : ""}" style="left:${c.pin_x * 100}%;top:${c.pin_y * 100}%">${c.n}</span>`).join("")
      + (state.draftPin ? `<span class="pin pin--draft" style="left:${state.draftPin.x * 100}%;top:${state.draftPin.y * 100}%">+</span>` : "");
  }

  function renderMarks() {
    const duration = videoEl.duration;
    if (!duration) return;
    $("[data-marks]").innerHTML = numbered().filter((c) => c.time_sec != null).map((c) => `
      <button type="button" class="mark ${c.done ? "is-done" : ""} ${c.id === state.activeId ? "is-active" : ""}" data-mark="${c.id}"
        style="left:${Math.min(100, (c.time_sec / duration) * 100)}%" title="#${c.n} ${esc(c.author_name)}: ${esc(c.body.slice(0, 80))}"></button>`).join("");
  }

  $("[data-marks]").addEventListener("click", (event) => {
    const mark = event.target.closest("[data-mark]");
    if (mark) activate(mark.dataset.mark, true);
  });

  function activate(id, scrollIntoView) {
    const note = state.comments.find((c) => c.id === id);
    if (!note) return;
    state.activeId = id;
    if (note.time_sec != null) {
      videoEl.pause();
      seek(note.time_sec);
    }
    renderNotes();
    renderMarks();
    renderPins();
    if (scrollIntoView) view.querySelector(`[data-note="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // Composer -------------------------------------------------------------

  function renderWhen() {
    const chip = $("[data-when]");
    chip.textContent = state.general ? "General note" : `@ ${timecode(videoEl.currentTime, state.fps)}`;
    chip.classList.toggle("is-general", state.general);
    const toggle = $("[data-pin-toggle]");
    toggle.classList.toggle("is-set", !!state.draftPin);
    toggle.classList.toggle("is-armed", state.pinMode);
    toggle.querySelector("span").textContent = state.draftPin ? "Spot marked ✕" : state.pinMode ? "Click the frame" : "Mark a spot";
    toggle.disabled = state.general;
  }

  function setPinMode(on) {
    state.pinMode = on;
    player.classList.toggle("is-pinning", on);
    $("[data-pin-hint]").hidden = !on;
    if (on) videoEl.pause();
    renderWhen();
  }

  $("[data-when]").addEventListener("click", () => {
    state.general = !state.general;
    if (state.general) { state.draftPin = null; setPinMode(false); renderPins(); }
    renderWhen();
  });

  $("[data-pin-toggle]").addEventListener("click", () => {
    if (state.draftPin) { state.draftPin = null; renderPins(); renderWhen(); return; }
    setPinMode(!state.pinMode);
  });

  body.addEventListener("focus", () => videoEl.pause());
  body.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = body.value.trim();
    if (!text) return body.focus();
    const button = composer.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const row = await api.addComment({
        file_id: fileId,
        client_folder: library.client,
        body: text,
        time_sec: state.general ? null : videoEl.currentTime,
        pin_x: state.general ? null : state.draftPin?.x ?? null,
        pin_y: state.general ? null : state.draftPin?.y ?? null,
      });
      state.comments.push(row);
      body.value = "";
      state.draftPin = null;
      state.general = false;
      state.activeId = row.id;
      renderAll();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  // Notes list -------------------------------------------------------------

  $("[data-tabs]").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-filter]");
    if (!tab) return;
    state.filter = tab.dataset.filter;
    view.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("is-active", b === tab));
    renderNotes();
  });

  const authorLabel = (c) => `
    <span class="note-who">
      ${avatar(c.author_name, { studio: c.author_is_admin, src: state.people.get(c.author_id)?.avatar })}
      <span class="note-author ${c.author_is_admin ? "note-author--studio" : ""}">${esc(c.author_name || "Someone")}</span>
    </span>`;
  const mine = (c) => c.author_id === profile.id || profile.is_admin;

  function renderNotes() {
    const all = numbered();
    const open = all.filter((c) => !c.done).length;
    $("[data-count]").textContent = all.length ? `${open} open · ${all.length} total` : "";
    const shown = all.filter((c) => state.filter === "all" || (state.filter === "done" ? c.done : !c.done));

    $("[data-notes]").innerHTML = shown.length ? shown.map((c) => {
      const replies = state.comments.filter((r) => r.parent_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
      return `
        <li class="note ${c.done ? "is-done" : ""} ${c.id === state.activeId ? "is-active" : ""}" data-note="${c.id}">
          <div class="note-head">
            <span class="note-index">${c.n}</span>
            ${c.time_sec != null ? `<span class="note-tc">${timecode(c.time_sec, state.fps)}</span>` : `<span class="note-tc note-tc--general">General</span>`}
            ${c.pin_x != null ? `<span class="note-pin" title="Marked a spot">${ICON.pin}</span>` : ""}
            <label class="note-done" title="Mark done"><input type="checkbox" data-done ${c.done ? "checked" : ""}><span>Done</span></label>
          </div>
          <p class="note-body">${esc(c.body)}</p>
          <p class="note-by">${authorLabel(c)} · ${relTime(c.created_at)}</p>
          ${replies.length ? `<ul class="replies">${replies.map((r) => `
            <li class="reply" data-reply-id="${r.id}">
              <p class="note-body">${esc(r.body)}</p>
              <p class="note-by">${authorLabel(r)} · ${relTime(r.created_at)}${mine(r) ? ` · <button type="button" class="text-button text-button--small" data-delete="${r.id}">Delete</button>` : ""}</p>
            </li>`).join("")}</ul>` : ""}
          <div class="note-actions">
            <button type="button" class="text-button text-button--small" data-reply>Reply</button>
            ${mine(c) ? `<button type="button" class="text-button text-button--small" data-delete="${c.id}">Delete</button>` : ""}
          </div>
          ${state.replyingTo === c.id ? `
            <form class="reply-form" data-reply-form>
              <textarea rows="2" placeholder="Write a reply…" data-reply-body></textarea>
              <div class="reply-form-foot">
                <button type="button" class="text-button text-button--small" data-reply-cancel>Cancel</button>
                <button type="submit" class="button button--solid button--compact">Reply</button>
              </div>
            </form>` : ""}
        </li>`;
    }).join("") : `<li class="notes-empty">${all.length ? "Nothing in this list." : "No notes yet. Pause on a frame and write the first one."}</li>`;

    const replyBox = view.querySelector("[data-reply-body]");
    if (replyBox && document.activeElement?.tagName !== "TEXTAREA") replyBox.focus();
  }

  const list = $("[data-notes]");

  list.addEventListener("click", async (event) => {
    const item = event.target.closest("[data-note]");
    if (!item) return;
    const id = item.dataset.note;

    if (event.target.closest("[data-done]") || event.target.closest(".note-done")) return;

    const del = event.target.closest("[data-delete]");
    if (del) {
      const ok = await dialog({ title: "Delete this note?", confirmLabel: "Delete", danger: true,
        body: `<p>It disappears for everyone, along with its replies.</p>` });
      if (!ok) return;
      try {
        await api.deleteComment(del.dataset.delete);
        state.comments = state.comments.filter((c) => c.id !== del.dataset.delete && c.parent_id !== del.dataset.delete);
        renderAll();
      } catch (error) { toast(error.message); }
      return;
    }
    if (event.target.closest("[data-reply]")) {
      state.replyingTo = id;
      renderNotes();
      return;
    }
    if (event.target.closest("[data-reply-cancel]")) {
      state.replyingTo = null;
      renderNotes();
      return;
    }
    if (event.target.closest("[data-reply-form]")) return;
    activate(id, false);
  });

  list.addEventListener("change", async (event) => {
    const box = event.target.closest("[data-done]");
    if (!box) return;
    const id = box.closest("[data-note]").dataset.note;
    try {
      const row = await api.updateComment(id, { done: box.checked });
      Object.assign(state.comments.find((c) => c.id === id), { done: row.done });
      renderAll();
    } catch (error) {
      box.checked = !box.checked;
      toast(error.message);
    }
  });

  list.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target.closest("[data-reply-form]");
    const text = form.querySelector("[data-reply-body]").value.trim();
    if (!text) return;
    try {
      const row = await api.addComment({ file_id: fileId, client_folder: library.client, body: text, parent_id: state.replyingTo });
      state.comments.push(row);
      state.replyingTo = null;
      renderAll();
    } catch (error) { toast(error.message); }
  });

  list.addEventListener("keydown", (event) => {
    if (event.target.matches("[data-reply-body]") && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      event.target.closest("form").requestSubmit();
    }
  });

  // Export ---------------------------------------------------------------

  $("[data-menu]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-export]");
    if (!button) return;
    const kind = button.dataset.export;
    const clean = parseTitle(version.name.replace(/\.[^.]+$/, ""));
    const name = `${clean.code ? `${clean.code} ` : ""}${clean.title}`.trim();
    if (!state.comments.length) return toast("No notes to export yet");
    if (kind === "txt") download(`${name} notes.txt`, toText(state.comments, state.fps, name));
    if (kind === "csv") download(`${name} notes.csv`, toCsv(state.comments, state.fps), "text/csv");
    if (kind === "edl") download(`${name} markers.edl`, toResolveEdl(state.comments, state.fps, name));
    $("[data-menu]").open = false;
  });

  // Approval -------------------------------------------------------------

  function renderApproval() {
    const box = $("[data-approval]");
    if (state.approval) {
      box.innerHTML = `
        <p class="approved"><span class="approved-mark" aria-hidden="true">✓</span> Approved by ${esc(state.approval.approved_name)} · ${relTime(state.approval.approved_at)}</p>
        <button type="button" class="text-button text-button--small" data-unapprove>Withdraw approval</button>`;
    } else {
      box.innerHTML = `<button type="button" class="button button--solid button--approve" data-approve>${profile.is_admin ? "Mark approved" : "Approve this version"} <span aria-hidden="true">✓</span></button>`;
    }
  }

  $("[data-approval]").addEventListener("click", async (event) => {
    try {
      if (event.target.closest("[data-approve]")) {
        state.approval = await api.approve(fileId, library.client);
        toast("Approved. Thank you!");
      } else if (event.target.closest("[data-unapprove]")) {
        const ok = await dialog({ title: "Withdraw approval?", confirmLabel: "Withdraw", danger: true,
          body: `<p>This version goes back to waiting for review.</p>` });
        if (!ok) return;
        await api.unapprove(fileId);
        state.approval = null;
      } else return;
      renderApproval();
    } catch (error) { toast(error.message); }
  });

  // Keyboard -------------------------------------------------------------

  function onKey(event) {
    if (event.target.closest("input, textarea, select, [contenteditable]") || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === " " || event.key === "k") { event.preventDefault(); togglePlay(); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); event.shiftKey ? seek(videoEl.currentTime - 1) : stepFrames(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); event.shiftKey ? seek(videoEl.currentTime + 1) : stepFrames(1); }
    else if (event.key === "Escape" && state.pinMode) setPinMode(false);
  }
  document.addEventListener("keydown", onKey);

  // Keep notes fresh: both sides can be in here at once.
  async function refresh() {
    if (document.hidden || view.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA") return;
    try {
      const [comments, approval] = await Promise.all([api.comments(fileId), api.approval(fileId)]);
      const changed = JSON.stringify(comments) !== JSON.stringify(state.comments) || JSON.stringify(approval) !== JSON.stringify(state.approval);
      if (!changed) return;
      state.comments = comments;
      state.approval = approval;
      renderAll();
      renderApproval();
    } catch {}
  }
  const poll = setInterval(refresh, 20000);
  window.addEventListener("focus", refresh);

  function renderAll() {
    renderNotes();
    renderMarks();
    renderPins();
    renderWhen();
  }

  // Go -------------------------------------------------------------------

  renderWhen();
  renderApproval();
  loadSource();
  try {
    const [comments, approval, people] = await Promise.all([
      api.comments(fileId),
      api.approval(fileId),
      api.people(library.client).catch(() => []),
    ]);
    state.comments = comments;
    state.approval = approval;
    state.people = new Map(people.map((person) => [person.id, person]));
  } catch (error) {
    toast(error.message);
  }
  renderAll();
  renderApproval();

  return () => {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("focus", refresh);
    clearInterval(poll);
    cancelAnimationFrame(frameRequest);
    resizer.disconnect();
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.load();
  };
}
