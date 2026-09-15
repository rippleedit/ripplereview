// The review screen: the player on the left, the notes on the right.
//
// Notes are pinned to a moment (and optionally a spot on the frame). Clicking
// a note jumps the player there; the marks on the scrub bar are the same notes.

import { api } from "./api.js";
import { download, frameOf, snapRate, timecode, toCsv, toResolveEdl, toText } from "./timecode.js";
import { avatar, dialog, emojiImg, esc, fileSize, href, masterLabel, parseTitle, parseVideo, REACTIONS, relTime, spinner, svg, toast } from "./ui.js";

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
  // A team member (e.g. sim-thumbnails) only watches and downloads approved cuts:
  // no notes panel, no approving, no hand-over.
  const member = !profile.is_admin && profile.team_role === "member";
  const state = {
    comments: [],
    people: new Map(),          // who is in this space, for names and faces
    approval: null,
    submission: null,          // the last time the client handed their notes over
    fps: readFps(fileId) ?? 25,
    filter: "all",
    activeId: null,
    general: false,
    pinMode: false,
    draftPin: null,
    draftStrokes: [],           // freehand marks on the frame, 0..1 coordinates
    drawMode: false,
    replyingTo: null,
    editingId: null,            // the note or reply being reworded
    reactions: [],              // { comment_id, user_id, emoji }: one per person per note
    master: null,               // an approved cut's master: { name, size, specs, url, at }
  };

  view.innerHTML = `
    <section class="review ${member ? "review--watch" : ""}">
      <div class="review-bar">
        <span class="title-line">
          ${cut.code || projectName.code ? `<span class="tag tag--code">${esc(cut.code || projectName.code)}</span>` : ""}
          ${cut.vsl
            /* VSL: "Main VSL [VSL] [ROUGH]" - the project is only ever "VSL", so the piece is the title. */
            ? `<h1 class="review-title">${esc(cut.label)}</h1>
               ${cut.rough ? `<span class="tag tag--rough" title="Polished rough cut: no motion graphics, music or sound design yet">Rough-cut</span>` : ""}`
            : `<h1 class="review-title">${esc(projectName.title)}</h1>
               ${/* No cut marker in the name: the label is just the title again, so say nothing. */
                 cut.label.toLowerCase() !== projectName.title.toLowerCase() ? `<span class="tag tag--cut">${esc(cut.label)}</span>` : ""}`}
          <nav class="versions" aria-label="Versions">
            ${video.versions.length > 1
              ? video.versions.map((v) => `<a href="${href.video(library.client, v.id)}" class="${v.id === fileId ? "is-active" : ""}" ${v.id === fileId ? 'aria-current="page"' : ""}>v${v.label}</a>`).join("")
              /* A lone version still says which one it is, just with nothing to switch to. */
              : `<span class="is-active" aria-current="page">v${version.label}</span>`}
          </nav>
        </span>
        <div class="approval" data-approval></div>
        <div class="handover" data-handover></div>
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
  const shell = $("[data-player-shell]");

  // Under about 420px the controls need two rows, whatever the window size.
  new ResizeObserver(([entry]) => shell.classList.toggle("is-narrow", entry.contentRect.width < 420)).observe(shell);

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
    // The whole frame follows the picture's shape, not just the video inside it.
    shell.style.setProperty("--ratio", ratio);
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
        ${/* Every drawing lands in signal orange, whoever drew it: it has to be seen on any picture. */
          marks.map((c) => `<path d="${strokesPath(c.drawing)}" stroke="var(--signal)" class="${c.done ? "is-done" : ""}"/>`).join("")}
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
  // Rewording is the author's alone, the studio included; the database holds to it too.
  const own = (c) => c.author_id === profile.id;
  const personFor = (id) => {
    const person = state.people.get(id);
    const name = person?.name?.trim() || (id === profile.id ? profile.name : "") || "Someone";
    return { name, avatar: person?.avatar ?? (id === profile.id ? profile.avatar : null), studio: person?.is_admin ?? false };
  };

  function renderCounts() {
    const all = numbered();
    const open = all.filter((c) => !c.done).length;
    $("[data-count-all]").textContent = all.length || "";
    $("[data-count-open]").textContent = open || "";
    $("[data-count-done]").textContent = all.length - open || "";
  }

  function renderNotes() {
    const all = numbered();
    renderCounts();
    const shown = all.filter((c) => state.filter === "all" || (state.filter === "done" ? c.done : !c.done));

    // The note being reworded swaps its text for a box holding the same words.
    // What was typed survives a redraw (a poll, a tick elsewhere).
    const draft = view.querySelector("[data-edit-body]")?.value;
    const text = (c) => state.editingId === c.id ? `
      <form class="reply-form" data-edit-form data-id="${c.id}">
        <textarea rows="3" data-edit-body>${esc(draft ?? c.body)}</textarea>
        <div class="reply-form-foot">
          <button type="button" class="text-button text-button--small" data-edit-cancel>Cancel</button>
          <button type="submit" class="button button--solid button--compact">Save</button>
        </div>
      </form>` : `<p class="note-body">${esc(c.body)}</p>`;

    // Reactions sit under the words: each emoji with the faces of who picked it.
    const myReaction = (c) => state.reactions.find((r) => r.comment_id === c.id && r.user_id === profile.id)?.emoji;
    const reactionsOf = (c) => {
      const rows = state.reactions.filter((r) => r.comment_id === c.id);
      const chips = REACTIONS.map((kind) => {
        const people = rows.filter((r) => r.emoji === kind.key).map((r) => personFor(r.user_id));
        if (!people.length) return "";
        const names = people.map((p) => p.name).join(", ");
        return `<button type="button" class="reaction ${myReaction(c) === kind.key ? "is-mine" : ""}" data-react="${kind.key}" data-for="${c.id}" title="${esc(names)}" aria-label="${esc(`${kind.label}: ${names}`)}">
          ${emojiImg(kind)}<span class="reaction-faces">${people.map((p) => avatar(p.name, { studio: p.studio, src: p.avatar, size: "xs" })).join("")}</span>
        </button>`;
      }).join("");
      return chips ? `<div class="reactions">${chips}</div>` : "";
    };
    // The row of emojis that shows while hovering a note.
    const picker = (c) => `
      <span class="react-bar" role="group" aria-label="React">${REACTIONS.map((kind) => `
        <button type="button" class="react-pick ${myReaction(c) === kind.key ? "is-mine" : ""}" data-react="${kind.key}" data-for="${c.id}" title="${kind.label}" aria-label="React with ${kind.label}" aria-pressed="${myReaction(c) === kind.key}">${emojiImg(kind)}</button>`).join("")}
      </span>`;

    const reply = (r) => `
      <li class="reply">
        ${text(r)}
        ${reactionsOf(r)}
        <p class="note-by">${authorLabel(r)}<span class="note-when">${relTime(r.created_at)}</span>
          ${picker(r)}
          ${own(r) ? `<button type="button" class="icon-button icon-button--tiny" data-edit="${r.id}" title="Edit" aria-label="Edit reply">${svg("edit")}</button>` : ""}
          ${mine(r) ? `<button type="button" class="icon-button icon-button--tiny" data-delete="${r.id}" title="Delete" aria-label="Delete reply">${svg("trash")}</button>` : ""}</p>
      </li>`;

    $("[data-notes]").innerHTML = shown.length ? shown.map((c) => {
      const replies = state.comments.filter((r) => r.parent_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
      return `
        <li class="note ${c.done ? "is-done" : ""} ${c.id === state.activeId ? "is-active" : ""}" data-note="${c.id}">
          <div class="note-top">
            <span class="note-index">${c.n}</span>
            ${c.time_sec != null ? `<span class="note-tc">${timecode(c.time_sec, state.fps)}</span>` : `<span class="note-tc note-tc--general">General</span>`}
            ${!profile.is_admin && sentAt() && c.created_at > sentAt() ? `<span class="tag tag--quiet tag--mini" title="Not sent to RippleEdit yet">Not sent</span>` : ""}
            ${c.pin_x != null ? `<span class="note-mark" title="Points at a spot">${svg("pin")}</span>` : ""}
            ${c.drawing?.length ? `<span class="note-mark" title="Has a drawing">${svg("draw")}</span>` : ""}
            <span class="note-tools">
              <button type="button" class="icon-button icon-button--tiny" data-reply title="Reply" aria-label="Reply">${svg("reply")}</button>
              ${own(c) ? `<button type="button" class="icon-button icon-button--tiny" data-edit="${c.id}" title="Edit" aria-label="Edit note">${svg("edit")}</button>` : ""}
              ${mine(c) ? `<button type="button" class="icon-button icon-button--tiny" data-delete="${c.id}" title="Delete" aria-label="Delete note">${svg("trash")}</button>` : ""}
            </span>
            <button type="button" class="note-check" data-done aria-pressed="${c.done}" title="${c.done ? "Mark as open" : "Mark as done"}" aria-label="${c.done ? "Mark as open" : "Mark as done"}">${svg("check")}</button>
          </div>
          ${text(c)}
          ${reactionsOf(c)}
          <p class="note-by">${authorLabel(c)}<span class="note-when">${relTime(c.created_at)}</span>${picker(c)}</p>
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
    const editBox = view.querySelector("[data-edit-body]");
    if (editBox && document.activeElement !== editBox) {
      editBox.focus();
      editBox.setSelectionRange(editBox.value.length, editBox.value.length);
    }
  }

  const list = $("[data-notes]");

  list.addEventListener("click", async (event) => {
    const item = event.target.closest("[data-note]");
    if (!item) return;
    const id = item.dataset.note;

    const react = event.target.closest("[data-react]");
    if (react) return toggleReaction(react.dataset.for, react.dataset.react);

    const edit = event.target.closest("[data-edit]");
    if (edit) {
      state.editingId = edit.dataset.edit;
      state.replyingTo = null;
      renderNotes();
      return;
    }
    if (event.target.closest("[data-edit-cancel]")) {
      state.editingId = null;
      renderNotes();
      return;
    }

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
      state.editingId = null;
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
      const done = !note.done;

      // Change this row in place so the tick, the fade and the flash are seen;
      // re-rendering the list would swap the DOM and show nothing at all.
      item.classList.toggle("is-done", done);
      item.classList.add(done ? "just-done" : "just-open");
      check.setAttribute("aria-pressed", String(done));
      check.title = done ? "Mark as open" : "Mark as done";
      setTimeout(() => item.classList.remove("just-done", "just-open"), 700);

      try {
        const row = await api.updateComment(id, { done });
        note.done = row.done;
        renderCounts();
        renderMarks();
        renderPins();
        // In a filtered list the note has just left the list it was in.
        if ((state.filter === "open" && done) || (state.filter === "done" && !done)) {
          item.classList.add("is-leaving");
          setTimeout(renderNotes, 320);
        }
      } catch (error) {
        item.classList.toggle("is-done", !done);
        check.setAttribute("aria-pressed", String(!done));
        toast(error.message);
      }
      return;
    }
    if (event.target.closest("[data-reply-form], [data-edit-form]")) return;
    activate(id, false);
  });

  // Same emoji again takes it back; another one swaps it. Shown straight away,
  // put back if the database says no.
  async function toggleReaction(commentId, emoji) {
    const before = state.reactions;
    const mineNow = before.find((r) => r.comment_id === commentId && r.user_id === profile.id);
    const next = mineNow?.emoji === emoji ? null : emoji;
    state.reactions = before.filter((r) => r !== mineNow);
    if (next) state.reactions = [...state.reactions, { comment_id: commentId, user_id: profile.id, emoji: next }];
    renderNotes();
    try {
      await api.react(commentId, next);
    } catch (error) {
      state.reactions = before;
      renderNotes();
      toast(error.message);
    }
  }

  async function saveEdit(form) {
    const note = state.comments.find((c) => c.id === form.dataset.id);
    const text = form.querySelector("[data-edit-body]").value.trim();
    if (!note || !text) return;
    if (text === note.body) {
      state.editingId = null;
      return renderNotes();
    }
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const row = await api.updateComment(note.id, { body: text });
      note.body = row.body;
      state.editingId = null;
      renderAll();
      toast("Note updated");
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  }

  list.addEventListener("submit", async (event) => {
    event.preventDefault();
    const editForm = event.target.closest("[data-edit-form]");
    if (editForm) return saveEdit(editForm);
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
    if (!event.target.matches("[data-reply-body], [data-edit-body]")) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      event.target.closest("form").requestSubmit();
    } else if (event.key === "Escape" && event.target.matches("[data-edit-body]")) {
      state.editingId = null;
      renderNotes();
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
        ${member ? "" : `<button type="button" class="icon-button" data-unapprove title="Undo approval" aria-label="Undo approval">${svg("undo")}</button>`}
        ${state.master ? `
          <a class="button button--solid button--compact" data-master href="${esc(state.master.url)}" target="_blank" rel="noopener" download="${esc(state.master.name)}"
            title="${esc([state.master.name, fileSize(state.master.size)].filter(Boolean).join(" · "))}">
            ${svg("download")} Download Master${masterLabel(state.master.specs) ? ` (${esc(masterLabel(state.master.specs))})` : ""}
          </a>` : ""}`;
    } else {
      box.innerHTML = member ? "" : `<button type="button" class="button button--solid button--compact" data-approve>${svg("check")} ${profile.is_admin ? `Mark v${version.label} approved` : `Approve v${version.label}`}</button>`;
    }
  }

  // An approved cut's master, if the proxy maker filed one: fetched with a
  // fresh download link. No master, or a server function older than masters:
  // simply no button.
  async function loadMaster() {
    if (!state.approval) {
      state.master = null;
      return renderApproval();
    }
    try {
      state.master = { ...(await api.master(fileId)), at: Date.now() };
    } catch {
      state.master = null;
    }
    renderApproval();
  }

  // Notes written after the last hand-over haven't reached the studio yet.
  const sentAt = () => state.submission?.created_at ?? null;
  const unsent = () => {
    const since = sentAt();
    return state.comments.filter((c) => !c.parent_id && (!since || c.created_at > since));
  };

  // "I'm done" - the client tells the studio the review is finished, which
  // sends one email and leaves a mark in the app.
  function renderHandover() {
    const box = $("[data-handover]");
    if (!box) return;
    if (member) {
      box.innerHTML = "";
      return;
    }
    const when = state.submission ? relTime(state.submission.created_at) : null;
    if (profile.is_admin) {
      box.innerHTML = when
        ? `<span class="handed" title="${esc(new Date(state.submission.created_at).toLocaleString())}">${svg("send")} Notes sent ${esc(when)}</span>`
        : "";
      return;
    }
    if (!when) {
      box.innerHTML = `<button type="button" class="button button--compact" data-send>${svg("send")} I'm done reviewing</button>`;
      return;
    }
    const waiting = unsent().length;
    box.innerHTML = `
      <span class="handed handed--done">
        ${svg("check")}
        <span><strong>RippleEdit has your notes</strong><small>Sent ${esc(when)}</small></span>
      </span>
      ${waiting
        ? `<button type="button" class="button button--compact" data-send>${svg("send")} Send ${waiting} new ${waiting === 1 ? "note" : "notes"}</button>`
        : `<button type="button" class="button button--compact button--ghost" data-send>${svg("send")} Send again</button>`}`;
  }

  $("[data-handover]").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-send]");
    if (!button) return;
    const waiting = sentAt() ? unsent().length : state.comments.filter((c) => !c.parent_id).length;
    const ok = await dialog({
      title: "Send your notes to RippleEdit?",
      confirmLabel: "Send notes",
      body: `<p>${waiting
        ? `They'll be told you've finished this review, with your ${waiting === 1 ? "note" : `${waiting} notes`}.`
        : "They'll be told you've looked at this version again."}</p>
             <p class="sheet-note">${svg("alert")}<span>You can keep adding notes afterwards and send again.</span></p>`,
    });
    if (!ok) return;
    button.disabled = true;
    try {
      const result = await api.notesSubmitted(fileId, `${projectName.title} — ${cut.label}${cut.rough ? " (rough cut)" : ""} v${version.label}`);
      state.submission = result.submission;
      renderHandover();
      toast("Sent to RippleEdit");
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  });

  // The studio hears about a sign-off without having to watch the app. The
  // approval itself is already saved, so a failed email changes nothing.
  const notifyApproval = (approved) =>
    api.approvalChanged?.(fileId, `${projectName.title} — ${cut.label}${cut.rough ? " (rough cut)" : ""} v${version.label}`, approved).catch(() => {});

  $("[data-approval]").addEventListener("click", async (event) => {
    // Dropbox download links last four hours: an older one is swapped for a fresh one.
    if (event.target.closest("[data-master]")) {
      if (Date.now() - state.master.at > 3.5 * 3600e3) {
        event.preventDefault();
        await loadMaster();
        if (state.master) location.assign(state.master.url);
      }
      return;
    }
    try {
      if (event.target.closest("[data-approve]")) {
        state.approval = await api.approve(fileId, library.client);
        notifyApproval(true);
        loadMaster();
        toast("Approved. Thank you!");
      } else if (event.target.closest("[data-unapprove]")) {
        const ok = await dialog({ title: "Withdraw approval?", confirmLabel: "Withdraw", danger: true,
          body: `<p>This version goes back to waiting for review.</p>` });
        if (!ok) return;
        await api.unapprove(fileId);
        state.approval = null;
        state.master = null;
        notifyApproval(false);
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
      const [comments, approval, reactions] = await Promise.all([api.comments(fileId), api.approval(fileId), api.reactions(fileId).catch(() => state.reactions)]);
      const reactionKey = (rows) => rows.map((r) => `${r.comment_id}:${r.user_id}:${r.emoji}`).sort().join();
      const changed = JSON.stringify(comments) !== JSON.stringify(state.comments) || JSON.stringify(approval) !== JSON.stringify(state.approval)
        || reactionKey(reactions) !== reactionKey(state.reactions);
      if (!changed) return;
      const newlyApproved = approval && !state.approval;
      state.comments = comments;
      state.approval = approval;
      state.reactions = reactions;
      if (!approval) state.master = null;
      renderAll();
      renderApproval();
      if (newlyApproved) loadMaster();
    } catch {}
  }
  const poll = setInterval(refresh, 20000);
  window.addEventListener("focus", refresh);

  function renderAll() {
    renderNotes();
    renderHandover();
    renderMarks();
    renderPins();
    renderWhen();
  }

  // Go -------------------------------------------------------------------

  renderWhen();
  renderApproval();
  renderHandover();
  loadSource();
  try {
    const [comments, approval, people, submissions, reactions] = await Promise.all([
      api.comments(fileId),
      api.approval(fileId),
      api.people(library.client).catch(() => []),
      api.submissions([fileId]).catch(() => []),
      // Before update-7 is run there is no reactions table: notes still load.
      api.reactions(fileId).catch(() => []),
    ]);
    state.reactions = reactions;
    state.comments = comments;
    state.approval = approval;
    state.people = new Map(people.map((person) => [person.id, person]));
    state.submission = submissions[0] ?? null;
  } catch (error) {
    toast(error.message);
  }
  renderAll();
  renderApproval();
  renderHandover();
  loadMaster();

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
