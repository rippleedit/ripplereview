// Demo mode: sample clients and videos, notes kept in this browser only.
// Lets the app be tried (and designed) before Supabase and Dropbox are wired.

const SITE = "https://ripple-edit.com/assets";
const CLIPS = [`${SITE}/main-film.mp4`, `${SITE}/hero-3.mp4`, `${SITE}/background-video-small.mp4`];

const PEOPLE = {
  admin: { id: "u-admin", name: "Razz", email: "studio@ripple-edit.com", client_folder: null, is_admin: true },
  client: { id: "u-client", name: "Nile Waves", email: "client@example.com", client_folder: "Nile Waves", is_admin: false },
};

const day = (n) => new Date(Date.now() - n * 86400000).toISOString();

function file(id, name, label, ago, clip) {
  return { id: `id:demo-${id}`, name, path: `/demo/${id}`, size: 0, modified: day(ago), version: label, label, clip };
}

const LIBRARY = {
  "nile waves": {
    client: "Nile Waves",
    projects: [
      {
        name: "NIL-11_Webinar-Funnel",
        modified: day(0.1),
        videos: [
          { key: "md", title: "_PREVIEW_NIL-11_Webinar-Funnel-Breakdown", modified: day(0.1), versions: [
            file("md1", "_PREVIEW_NIL-11_Webinar-Funnel-Breakdown_v1.mp4", 1, 6, 1),
            file("md2", "_PREVIEW_NIL-11_Webinar-Funnel-Breakdown_v2.mp4", 2, 3, 1),
            file("md3", "_PREVIEW_NIL-11_Webinar-Funnel-Breakdown_v3.mp4", 3, 0.1, 0),
          ] },
          { key: "md-short", title: "_PREVIEW_NIL-11_Webinar-Funnel-Teaser", modified: day(0.4), versions: [
            file("ms1", "_PREVIEW_NIL-11_Webinar-Funnel-Teaser.mp4", 1, 0.4, 2),
          ] },
        ],
      },
      {
        name: "NIL-09_Studio-Session",
        modified: day(9),
        videos: [
          { key: "ss", title: "_PREVIEW_NIL-09_Studio-Session-Recap", modified: day(9), versions: [file("ss1", "_PREVIEW_NIL-09_Studio-Session-Recap_v1.mp4", 1, 9, 1)] },
        ],
      },
    ],
  },
  "kxng beats": {
    client: "Kxng Beats",
    projects: [
      { name: "Beat Video Series", modified: day(2), videos: [
        { key: "ep1", title: "Episode 01", modified: day(2), versions: [file("ep1", "Episode 01.mp4", 1, 2, 2)] },
      ] },
    ],
  },
};

const THUMBS = ["assets/demo/clip-1.jpg", "assets/demo/clip-2.jpg", "assets/demo/clip-3.jpg", "assets/demo/clip-4.jpg"];

const SEED = {
  comments: [
    { id: "c1", file_id: "id:demo-md3", client_folder: "nile waves", parent_id: null, author_id: "u-client", author_name: "Nile Waves", author_is_admin: false, body: "Can we hold on this shot a bit longer? It cuts away right before the drop.", time_sec: 2.4, pin_x: 0.52, pin_y: 0.44, done: false, created_at: day(0.05) },
    { id: "c2", file_id: "id:demo-md3", client_folder: "nile waves", parent_id: "c1", author_id: "u-admin", author_name: "Razz", author_is_admin: true, body: "Yes, I'll let it ride into the drop.", time_sec: null, pin_x: null, pin_y: null, done: false, created_at: day(0.04) },
    { id: "c3", file_id: "id:demo-md3", client_folder: "nile waves", parent_id: null, author_id: "u-client", author_name: "Nile Waves", author_is_admin: false, body: "Logo a little smaller here please.", time_sec: 6.1, pin_x: 0.2, pin_y: 0.18, done: true, created_at: day(0.03) },
    { id: "c4", file_id: "id:demo-md3", client_folder: "nile waves", parent_id: null, author_id: "u-client", author_name: "Nile Waves", author_is_admin: false, body: "Love the colour on this one overall.", time_sec: null, pin_x: null, pin_y: null, done: false, created_at: day(0.02) },
  ],
  approvals: [
    { file_id: "id:demo-ss1", client_folder: "nile waves", approved_by: "u-client", approved_name: "Nile Waves", approved_at: day(8) },
  ],
};

const STORE = "ripplereview-demo";

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? structuredClone(SEED); } catch { return structuredClone(SEED); }
}

export function demoApi() {
  let state = load();
  let me = null;
  try { me = PEOPLE[sessionStorage.getItem(`${STORE}-who`)] ?? null; } catch {}
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} };
  const wait = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 120));
  const allFiles = () => Object.values(LIBRARY).flatMap((l) => l.projects.flatMap((p) => p.videos.flatMap((v) => v.versions)));

  return {
    demo: true,

    session: () => wait(me),
    async signIn(email) {
      const who = /client/i.test(email) ? "client" : "admin";
      me = PEOPLE[who];
      try { sessionStorage.setItem(`${STORE}-who`, who); } catch {}
      return wait(me);
    },
    async signOut() {
      me = null;
      try { sessionStorage.removeItem(`${STORE}-who`); } catch {}
    },

    async library(folder) {
      const key = (me.is_admin ? folder : me.client_folder).toLowerCase();
      if (!LIBRARY[key]) throw new Error("Not found in Dropbox.");
      return wait(structuredClone(LIBRARY[key]));
    },
    link: (fileId) => wait(CLIPS[allFiles().find((f) => f.id === fileId)?.clip ?? 0]),
    thumbs: (paths) => wait(Object.fromEntries(paths.map((p, i) => [p, THUMBS[(p.length + i) % THUMBS.length]]))),

    summary: (ids) => wait({
      comments: state.comments.filter((c) => ids.includes(c.file_id)),
      approvals: state.approvals.filter((a) => ids.includes(a.file_id)),
    }),
    comments: (fileId) => wait(state.comments.filter((c) => c.file_id === fileId)),
    async addComment(comment) {
      const row = {
        pin_x: null, pin_y: null, time_sec: null, parent_id: null, ...comment,
        id: crypto.randomUUID(), client_folder: comment.client_folder.toLowerCase(),
        author_id: me.id, author_name: me.name, author_is_admin: me.is_admin, done: false,
        created_at: new Date().toISOString(),
      };
      state.comments.push(row);
      save();
      return wait(row);
    },
    async updateComment(id, patch) {
      const row = state.comments.find((c) => c.id === id);
      Object.assign(row, patch);
      save();
      return wait(row);
    },
    async deleteComment(id) {
      state.comments = state.comments.filter((c) => c.id !== id && c.parent_id !== id);
      save();
    },
    approval: (fileId) => wait(state.approvals.find((a) => a.file_id === fileId) ?? null),
    async approve(fileId, folder) {
      const row = { file_id: fileId, client_folder: folder.toLowerCase(), approved_by: me.id, approved_name: me.name, approved_at: new Date().toISOString() };
      state.approvals.push(row);
      save();
      return wait(row);
    },
    async unapprove(fileId) {
      state.approvals = state.approvals.filter((a) => a.file_id !== fileId);
      save();
    },

    async setProfile(fields) {
      me = { ...me, ...fields };
      PEOPLE[me.is_admin ? "admin" : "client"] = me;
      return wait(me);
    },

    people: () => wait(Object.values(PEOPLE)),

    clients: () => wait({
      folders: [
        { folder: "Kxng Beats", logins: [] },
        { folder: "Nile Waves", logins: [{ id: "u-client", email: PEOPLE.client.email, name: "Nile Waves", client_folder: "Nile Waves" }] },
      ],
      orphans: [],
    }),
    createClient: () => wait({ ok: true }),
    setPassword: () => wait({ ok: true }),
    removeLogin: () => wait({ ok: true }),
  };
}
