// The review screen: the player on the left, the notes on the right.
//
// Notes are pinned to a moment (and optionally a spot on the frame). Clicking
// a note jumps the player there; the marks on the scrub bar are the same notes.

import { api } from "./api.js";
import { download, frameOf, snapRate, timecode, toCsv, toResolveEdl, toText } from "./timecode.js";
import { avatar, colourFor, dialog, esc, href, parseTitle, parseVideo, relTime, spinner, svg, toast } from "./ui.js";

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
  const projectName = parseTitle(project.name);
  const cut = parseVideo(video.title, projectName.title);
  const latest = video.versions.at(-1);
  const state = {
    comments: [],
    people: new Map(),          // who is in this space, for names and faces
    approval: null,
    fps: readFps(fileId) ?? 25,
    filter: "all",
    activeId: null,
    general: false,
    pinMode: false,
    draftPin: null,
    draftStrokes: [],           // freehand marks on the frame, 0..1 coordinates
    drawMode: false,
    replyingTo: null,
  };

  view.innerHTML = `
    <section class="review">
      <div class="review-bar">
        <span class="title-line">
          ${cut.code || projectName.code ? `<span class="tag tag--code">${esc(cut.code || projectName.code)}</span>` : ""}
          <h1 class="review-title">${esc(projectName.title)}</h1>
          <span class="tag tag--cut">${esc(cut.label)}</span>
          ${video.versions.length > 1 ? `
            <nav class="versions" aria-label="Versions">
              ${video.versions.map((v) => `<a href="${href.video(library.client, v.id)}" class="${v.id === fileId ? "is-active" : ""}" ${v.id === fileId ? 'aria-current="page"' : ""}>v${v.label}</a>`).join("")}
            </nav>` : ""}
        </span>
        <div class="approval" data-approval></div>
      </div>

      <div class="review-layout">
        <div class="review-main">
          <div class="player-shell" data-player-shell>
            <div class="player" data-player>
              <video playsinline preload="auto" data-video></video>
              <div class="player-layer" data-layer></div>
              <p class="player-hint" data-pin-hint hidden></p>
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
              <button class="round round--quiet" type="button" data-full aria-label="Full screen">${ICON.full}</button>
            </div>
          </div>

          <div class="review-meta">
            ${latest.id !== fileId ? `<p class="review-older">You're watching an older cut. <a class="text-link" href="${href.video(library.client, latest.id)}">Open v${latest.label}, the latest →</a></p>` : ""}
            <p class="review-keys">Space play · ← → one frame · Shift ← → one second</p>
          </div>
        </div>

        <aside class="notes" aria-label="Notes">
          <div class="notes-head">
            <div class="notes-tools">
              <div class="tabs" role="tablist" data-tabs>
                <button type="button" data-filter="all" class="is-active">All <i data-count-all></i></button>
                <button type="button" data-filter="open">Open <i data-count-open></i></button>
                <button type="button" data-filter="done">Done <i data-count-done></i></button>
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
              <button type="button" class="pin-toggle" data-draw-toggle>${svg("draw")}<span>Draw</span></button>
              <button type="button" class="pin-toggle pin-toggle--quiet" data-draw-undo hidden>${svg("undo")}<span>Undo</span></button>
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
  const playerState = $("[data-player-state]");

  // Player ----------------------------------------------------------------

  let reloadedLink = false;
  async function loadSource(resumeAt = 0) {
    player.classList.remove("is-ready");
    playerState.hidden = false;
    try {
      videoEl.src = await api.link(fileId);
      if (resumeAt) videoEl.addEventListener("loadedmetadata", () => { videoEl.currentTime = resumeAt; }, { once: true });
    } catch (error) {
      playerState.textContent = error.message;
    }
  }

  videoEl.addEventListener("loadedmetadata", () => {
    playerState.hidden = true;
    player.classList.add("is-ready");
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

  // Freehand: each press starts a stroke, sampled until the pointer lifts.
  player.addEventListener("pointerdown", (event) => {
    if (!state.drawMode) return;
    event.preventDefault();
    const rect = () => layer.getBoundingClientRect();
    const at = (e) => {
      const r = rect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };
    const stroke = [at(event)];
    state.draftStrokes.push(stroke);
    player.setPointerCapture(event.pointerId);
    const move = (e) => {
      const point = at(e);
      const last = stroke.at(-1);
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.004) return;
      stroke.push(point);
      renderPins();
    };
    const up = () => {
      player.removeEventListener("pointermove", move);
      if (stroke.length < 2) state.draftStrokes.pop();
      renderPins();
      renderWhen();
      body.focus();
    };
    player.addEventListener("pointermove", move);
    player.addEventListener("pointerup", up, { once: true });
    player.addEventListener("pointercancel", up, { once: true });
  });

  player.addEventListener("click", (event) => {
    if (state.drawMode) return;
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

  function refreshTimecodes() {
    if (videoEl.duration) $("[data-duration]").textContent = timecode(videoEl.duration, state.fps);
    renderClock();
    renderNotes();
  }

  // The frame rate is measured from playback, never asked for.
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
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
      state.fps = snapRate(1 / deltas[12]);
      saveFps(fileId, state.fps);
      refreshTimecodes();
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

  // What sits on this frame: the pins and drawings of notes made here, plus
  // whatever is being drawn right now.
  const strokesPath = (strokes) => strokes
    .filter((stroke) => stroke.length > 1)
    .map((stroke) => "M" + stroke.map(([x, y]) => `${(x * 1000).toFixed(1)} ${(y * 1000).toFixed(1)}`).join("L"))
    .join(" ");

  function renderPins() {
    const here = frameOf(videoEl.currentTime, state.fps);
    const onThisFrame = videoEl.paused
      ? numbered().filter((c) => c.time_sec != null && frameOf(c.time_sec, state.fps) === here)
      : [];
    const marks = onThisFrame.filter((c) => c.drawing?.length);

    const svg = marks.length || state.draftStrokes.length ? `
      <svg class="draw-layer" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        ${marks.map((c) => `<path d="${strokesPath(c.drawing)}" stroke="${c.author_is_admin ? "var(--signal)" : colourFor(c.author_name)}" class="${c.done ? "is-done" : ""}"/>`).join("")}
        ${state.draftStrokes.length ? `<path d="${strokesPath(state.draftStrokes)}" stroke="var(--signal)" class="is-draft"/>` : ""}
      </svg>` : "";

    layer.innerHTML = svg
      + onThisFrame.filter((c) => c.pin_x != null).map((c) => `
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

    const pin = $("[data-pin-toggle]");
    pin.classList.toggle("is-set", !!state.draftPin);
    pin.classList.toggle("is-armed", state.pinMode);
    pin.querySelector("span").textContent = state.draftPin ? "Spot marked ✕" : state.pinMode ? "Click the frame" : "Mark a spot";
    pin.disabled = state.general;

    const draw = $("[data-draw-toggle]");
    const drawn = state.draftStrokes.length;
    draw.classList.toggle("is-armed", state.drawMode);
    draw.classList.toggle("is-set", drawn > 0 && !state.drawMode);
    draw.querySelector("span").textContent = state.drawMode ? "Drawing…" : drawn ? `Drawing (${drawn})` : "Draw";
    draw.disabled = state.general;
    $("[data-draw-undo]").hidden = !drawn;

    const hint = $("[data-pin-hint]");
    hint.hidden = !(state.pinMode || state.drawMode);
    hint.textContent = state.pinMode ? "Click the frame to mark the spot" : "Draw on the frame";
  }

  function setPinMode(on) {
    state.pinMode = on;
    if (on) setDrawMode(false);
    player.classList.toggle("is-pinning", on);
    if (on) videoEl.pause();
    renderWhen();
  }

  function setDrawMode(on) {
    state.drawMode = on;
    if (on) state.pinMode = false;
    player.classList.toggle("is-drawing", on);
    player.classList.toggle("is-pinning", state.pinMode);
    if (on) videoEl.pause();
    renderWhen();
  }

  $("[data-when]").addEventListener("click", () => {
    state.general = !state.general;
    if (state.general) { state.draftPin = null; state.draftStrokes = []; setPinMode(false); setDrawMode(false); renderPins(); }
    renderWhen();
  });

  $("[data-pin-toggle]").addEventListener("click", () => {
    if (state.draftPin) { state.draftPin = null; renderPins(); renderWhen(); return; }
    setPinMode(!state.pinMode);
  });

  $("[data-draw-toggle]").addEventListener("click", () => setDrawMode(!state.drawMode));
  $("[data-draw-undo]").addEventListener("click", () => {
    state.draftStrokes.pop();
    renderPins();
    renderWhen();
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
        drawing: state.general || !state.draftStrokes.length ? null
          : state.draftStrokes.map((stroke) => stroke.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))])),
      });
      state.comments.push(row);
      body.value = "";
      state.draftPin = null;
      state.draftStrokes = [];
      setDrawMode(false);
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

  // The studio signs its notes "Razz @ RippleEdit": the person, then the company.
  // The name comes from the author's profile when we can see it, so changing
  // your name updates every note you have ever written. Never show an address.
  const authorLabel = (c) => {
    const person = state.people.get(c.author_id);
    const name = person?.name?.trim() || String(c.author_name || "").split("@")[0] || "Someone";
    return `
    <span class="note-who">
      ${avatar(name, { studio: c.author_is_admin, src: person?.avatar })}
      <span class="note-author ${c.author_is_admin ? "note-author--studio" : ""}">${esc(name)}</span>
      ${c.author_is_admin ? `<span class="note-org">@ RippleEdit</span>` : ""}
    </span>`;
  };
  const mine = (c) => c.author_id === profile.id || profile.is_admin;

  function renderNotes() {
    const all = numbered();
    const open = all.filter((c) => !c.done).length;
    $("[data-count-all]").textContent = all.length || "";
    $("[data-count-open]").textContent = open || "";
    $("[data-count-done]").textContent = all.length - open || "";
    const shown = all.filter((c) => state.filter === "all" || (state.filter === "done" ? c.done : !c.done));

    const reply = (r) => `
      <li class="reply">
        <p class="note-body">${esc(r.body)}</p>
        <p class="note-by">${authorLabel(r)}<span class="note-when">${relTime(r.created_at)}</span>
          ${mine(r) ? `<button type="button" class="icon-button icon-button--tiny" data-delete="${r.id}" title="Delete" aria-label="Delete reply">${svg("trash")}</button>` : ""}</p>
      </li>`;

    $("[data-notes]").innerHTML = shown.length ? shown.map((c) => {
      const replies = state.comments.filter((r) => r.parent_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
      return `
        <li class="note ${c.done ? "is-done" : ""} ${c.id === state.activeId ? "is-active" : ""}" data-note="${c.id}">
          <div class="note-top">
            <span class="note-index">${c.n}</span>
            ${c.time_sec != null ? `<span class="note-tc">${timecode(c.time_sec, state.fps)}</span>` : `<span class="note-tc note-tc--general">General</span>`}
            ${c.pin_x != null ? `<span class="note-mark" title="Points at a spot">${svg("pin")}</span>` : ""}
            ${c.drawing?.length ? `<span class="note-mark" title="Has a drawing">${svg("draw")}</span>` : ""}
            <span class="note-tools">
              <button type="button" class="icon-button icon-button--tiny" data-reply title="Reply" aria-label="Reply">${svg("reply")}</button>
              ${mine(c) ? `<button type="button" class="icon-button icon-button--tiny" data-delete="${c.id}" title="Delete" aria-label="Delete note">${svg("trash")}</button>` : ""}
            </span>
            <button type="button" class="note-check" data-done aria-pressed="${c.done}" title="${c.done ? "Mark as open" : "Mark as done"}" aria-label="${c.done ? "Mark as open" : "Mark as done"}">${svg("check")}</button>
          </div>
          <p class="note-body">${esc(c.body)}</p>
          <p class="note-by">${authorLabel(c)}<span class="note-when">${relTime(c.created_at)}</span></p>
          ${replies.length ? `<ul class="replies">${replies.map(reply).join("")}</ul>` : ""}
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
    const check = event.target.closest("[data-done]");
    if (check) {
      const note = state.comments.find((c) => c.id === id);
      try {
        const row = await api.updateComment(id, { done: !note.done });
        note.done = row.done;
        renderAll();
      } catch (error) { toast(error.message); }
      return;
    }
    if (event.target.closest("[data-reply-form]")) return;
    activate(id, false);
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
    const name = `${cut.code ? `${cut.code} ` : ""}${projectName.title} ${cut.label}`.trim();
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
        <span class="approved" title="Approved ${esc(new Date(state.approval.approved_at).toLocaleString())}">
          <span class="approved-mark" aria-hidden="true">${svg("check")}</span>
          <span><strong>v${version.label} approved</strong><small>${esc(state.approval.approved_name)} · ${relTime(state.approval.approved_at)}</small></span>
        </span>
        <button type="button" class="icon-button" data-unapprove title="Undo approval" aria-label="Undo approval">${svg("undo")}</button>`;
    } else {
      box.innerHTML = `<button type="button" class="button button--solid button--compact" data-approve>${svg("check")} ${profile.is_admin ? `Mark v${version.label} approved` : `Approve v${version.label}`}</button>`;
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
    else if (event.key === "Escape") { if (state.pinMode) setPinMode(false); if (state.drawMode) setDrawMode(false); }
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
