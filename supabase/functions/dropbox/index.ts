// RippleReview server function: the only thing that talks to Dropbox.
//
// It holds the Dropbox key, checks who is asking, and only ever hands a
// client what is inside their own folder. Deployed in Supabase as "dropbox".
//
// Secrets it needs (Supabase → Edge Functions → Secrets):
//   DROPBOX_APP_KEY        the App key from the Dropbox App Console
//   DROPBOX_REFRESH_TOKEN  printed by setup/dropbox-token.mjs
//   RESEND_API_KEY         for the "client finished reviewing" email
//   NOTIFY_TO              where those emails go (default info@ripple-edit.com)
// Optional: NOTIFY_FROM, NOTIFY_REPLY_TO, NOTIFY_APPROVALS_TO, APP_URL.
// Optional, for title & thumbnail ideas from RippleLab:
//   RIPPLELAB_URL          e.g. https://ripplelab.morning-pine-3977.workers.dev
//   RIPPLELAB_KEY          the shared key (RippleLab's REVIEW_API_KEY)
// SUPABASE_URL and the service key are provided by Supabase automatically.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
// Masters can be whatever the studio exports: they're downloaded, not played.
const MASTER = /\.(mp4|m4v|mov|mxf|mkv|avi|webm)$/i;
// A master is named like its review copy without the _PREVIEW_ prefix.
const stemOf = (name: string) => name.replace(/\.[^.]+$/, "").replace(/^_preview_/i, "");

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  // Newer projects expose their secret keys as a JSON map instead.
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
  return keys.default ?? Object.values(keys)[0] ?? "";
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Dropbox -----------------------------------------------------------------

let cachedToken = { value: "", expires: 0 };

async function dropboxToken(): Promise<string> {
  if (cachedToken.value && Date.now() < cachedToken.expires - 60_000) return cachedToken.value;
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: Deno.env.get("DROPBOX_REFRESH_TOKEN") ?? "",
      client_id: Deno.env.get("DROPBOX_APP_KEY") ?? "",
    }),
  });
  if (!res.ok) throw new HttpError(502, "Dropbox login failed. Check the Dropbox secrets.");
  const data = await res.json();
  cachedToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function dropbox(endpoint: string, args: unknown, host = "api") {
  const res = await fetch(`https://${host}.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await dropboxToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    if (text.includes("not_found")) throw new HttpError(404, "Not found in Dropbox.");
    throw new HttpError(502, `Dropbox error: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function listAll(path: string, recursive: boolean) {
  let page = await dropbox("files/list_folder", { path, recursive, limit: 2000 });
  const entries = [...page.entries];
  while (page.has_more) {
    page = await dropbox("files/list_folder/continue", { cursor: page.cursor });
    entries.push(...page.entries);
  }
  return entries;
}

// Access ------------------------------------------------------------------

type Profile = { id: string; name: string; email: string; client_folder: string | null; is_admin: boolean; team_role?: string };

async function whoIsAsking(req: Request): Promise<Profile> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await db.auth.getUser(jwt);
  if (!data?.user) throw new HttpError(401, "Please sign in again.");
  const { data: profile } = await db.from("profiles").select("*").eq("id", data.user.id).single();
  if (!profile) throw new HttpError(403, "This login has no profile.");
  return profile;
}

function cleanFolder(name: unknown): string {
  const folder = String(name ?? "").trim();
  if (!folder || /[\/\\]|^\.+$/.test(folder)) throw new HttpError(400, "Invalid folder name.");
  return folder;
}

// The folder this person may look into. Clients: always their own.
function folderFor(profile: Profile, requested: unknown): string {
  if (profile.is_admin) return cleanFolder(requested);
  if (!profile.client_folder) throw new HttpError(403, "No client space is linked to this login yet.");
  return profile.client_folder;
}

function allowed(profile: Profile, pathLower: string): boolean {
  if (pathLower.includes("..")) return false;
  if (profile.is_admin) return true;
  return !!profile.client_folder && pathLower.startsWith(`/${profile.client_folder.toLowerCase()}/`);
}

function requireAdmin(profile: Profile) {
  if (!profile.is_admin) throw new HttpError(403, "Admins only.");
}

// A team member (e.g. sim-thumbnails) watches and downloads approved cuts only.
// Before database update 8 there is no team_role, so nobody is a member.
const isMember = (profile: Profile) => !profile.is_admin && profile.team_role === "member";

function requireReviewer(profile: Profile) {
  if (isMember(profile)) throw new HttpError(403, "This login can watch and download finished cuts only.");
}

async function approvedIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await db.from("approvals").select("file_id").in("file_id", ids);
  if (error) throw new HttpError(500, error.message);
  return new Set((data ?? []).map((row: { file_id: string }) => row.file_id));
}

// Actions -----------------------------------------------------------------

// "Song v2.mp4" → { base: "Song", version: 2 }. No number means version 1.
function parseName(fileName: string) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const match = /^(.*?)[\s._-]*v(?:ersion)?[\s._-]*(\d{1,3})$/i.exec(stem);
  if (match && match[1].trim()) return { base: match[1].trim(), version: Number(match[2]) };
  return { base: stem.trim(), version: 1 };
}

async function library(profile: Profile, requested: unknown) {
  const folder = folderFor(profile, requested);
  const root = `/${folder}`;
  const entries = await listAll(root, true);
  const projects = new Map<string, any>();

  // Folders sitting directly in the client's space are projects, even before
  // a single cut has been dropped in - otherwise a new job looks missing.
  // A leading underscore means "studio only" (_MASTERS, _WIP): never listed.
  for (const entry of entries) {
    if (entry[".tag"] !== "folder") continue;
    const parts = entry.path_display.split("/").slice(2);
    if (parts.length !== 1 || parts[0].startsWith("_")) continue;
    projects.set(parts[0], { name: parts[0], videos: new Map() });
  }

  // Masters sit in each project's hidden _MASTERS folder. Only whether one
  // exists is listed here; the `master` action hands it out after approval.
  const masters = new Set<string>();
  for (const entry of entries) {
    if (entry[".tag"] !== "file" || !MASTER.test(entry.name)) continue;
    const parts = entry.path_display.split("/").slice(2);
    if (parts.length === 3 && parts[1].toLowerCase() === "_masters") masters.add(`${parts[0]}/${stemOf(entry.name)}`.toLowerCase());
  }

  for (const entry of entries) {
    if (entry[".tag"] !== "file" || !VIDEO.test(entry.name)) continue;
    const parts = entry.path_display.split("/").slice(2); // drop "" and the client folder
    // Anything inside an underscore folder belongs to the studio alone.
    if (parts.slice(0, -1).some((part: string) => part.startsWith("_"))) continue;
    const projectName = parts.length > 1 ? parts[0] : "Unsorted";
    if (!projects.has(projectName)) projects.set(projectName, { name: projectName, videos: new Map() });
    const project = projects.get(projectName);

    const { base, version } = parseName(entry.name);
    const key = `${parts.slice(1, -1).join("/")}/${base}`.toLowerCase();
    if (!project.videos.has(key)) project.videos.set(key, { key, title: base, versions: [] });
    project.videos.get(key).versions.push({
      id: entry.id,
      name: entry.name,
      path: entry.path_lower,
      size: entry.size,
      modified: entry.server_modified,
      version,
      master: masters.has(`${projectName}/${stemOf(entry.name)}`.toLowerCase()),
    });
  }

  // Where review copies exist, only they are shown: a master left beside them
  // is the studio's business, not the client's.
  for (const project of projects.values()) {
    const keys = [...project.videos.keys()];
    const previews = keys.filter((key) => project.videos.get(key).versions.some((v: any) => /^_preview/i.test(v.name)));
    if (previews.length && previews.length < keys.length) {
      for (const key of keys) {
        const video = project.videos.get(key);
        video.versions = video.versions.filter((v: any) => /^_preview/i.test(v.name));
        if (!video.versions.length) project.videos.delete(key);
      }
    }
  }

  const latest = (list: { modified: string }[]) => list.reduce((a, b) => (a > b.modified ? a : b.modified), "");
  const out = [...projects.values()].map((project) => {
    const videos = [...project.videos.values()].map((video) => {
      video.versions.sort((a: any, b: any) => a.version - b.version || a.modified.localeCompare(b.modified));
      // Label by the number in the file name, unless two files claim the same one.
      const numbers = video.versions.map((v: any) => v.version);
      const clash = new Set(numbers).size !== numbers.length;
      video.versions.forEach((v: any, i: number) => (v.label = clash ? i + 1 : v.version));
      video.modified = latest(video.versions);
      return video;
    });
    videos.sort((a, b) => b.modified.localeCompare(a.modified));
    return { name: project.name, modified: latest(videos), videos, empty: videos.length === 0 };
  });
  out.sort((a, b) => b.modified.localeCompare(a.modified));
  if (!isMember(profile)) return { client: folder, projects: out };

  // A team member only ever sees finished work: the approved versions.
  const approved = await approvedIds(out.flatMap((p) => p.videos.flatMap((v: any) => v.versions.map((x: any) => x.id))));
  const finished = out.map((project) => {
    const videos = project.videos
      .map((video: any) => ({ ...video, versions: video.versions.filter((v: any) => approved.has(v.id)) }))
      .filter((video: any) => video.versions.length)
      .map((video: any) => ({ ...video, modified: latest(video.versions) }));
    return { ...project, videos, modified: latest(videos), empty: false };
  }).filter((project) => project.videos.length);
  return { client: folder, projects: finished };
}

async function link(profile: Profile, fileId: unknown) {
  const id = String(fileId ?? "");
  if (!id.startsWith("id:")) throw new HttpError(400, "Invalid file.");
  const meta = await dropbox("files/get_metadata", { path: id });
  if (!allowed(profile, meta.path_lower)) throw new HttpError(403, "Not your file.");
  if (isMember(profile) && !(await approvedIds([id])).has(id)) throw new HttpError(403, "This cut isn't approved yet.");
  const data = await dropbox("files/get_temporary_link", { path: id });
  return { url: data.link };
}

// A small JSON file from Dropbox: the specs the proxy maker saves beside a master.
async function dropboxJson(fileId: string) {
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: { Authorization: `Bearer ${await dropboxToken()}`, "Dropbox-API-Arg": JSON.stringify({ path: fileId }) },
  });
  if (!res.ok) throw new HttpError(502, "Couldn't read the master's specs.");
  return await res.json();
}

// The master that belongs to one review copy: `_MASTERS/X.*` beside `_PREVIEW_X.mp4`.
// `approved`: only once that version is approved (the studio can always have it).
async function findMaster(profile: Profile, fileId: unknown, { approved = true } = {}) {
  const id = String(fileId ?? "");
  if (!id.startsWith("id:")) throw new HttpError(400, "Invalid file.");
  const meta = await dropbox("files/get_metadata", { path: id });
  if (!allowed(profile, meta.path_lower)) throw new HttpError(403, "Not your file.");
  if (approved && !profile.is_admin && !(await approvedIds([id])).has(id)) throw new HttpError(403, "The master unlocks once this cut is approved.");

  const stem = stemOf(meta.name).toLowerCase();
  const dir = `${meta.path_lower.split("/").slice(0, -1).join("/")}/_masters`;
  const entries = await listAll(dir, false).catch(() => []);
  const file = entries.find((e: any) => e[".tag"] === "file" && MASTER.test(e.name) && stemOf(e.name).toLowerCase() === stem);
  if (!file) throw new HttpError(404, "No master for this cut yet.");
  return { id, stem, entries, file };
}

// The full-quality master of one version: its specs for the button and a
// download link (straight from Dropbox, good for four hours).
async function master(profile: Profile, fileId: unknown) {
  const { stem, entries, file } = await findMaster(profile, fileId);
  const sidecar = entries.find((e: any) => e[".tag"] === "file" && e.name.toLowerCase() === `${stem}.json`);
  const specs = sidecar ? await dropboxJson(sidecar.id).catch(() => null) : null;
  const data = await dropbox("files/get_temporary_link", { path: file.id });
  return { name: file.name, size: file.size, specs, url: data.link };
}

// Share links need the Dropbox app's sharing permission, and a refresh token
// made after it was ticked (setup/dropbox-token.mjs).
const noSharing = (error: unknown) => String((error as Error)?.message).includes("missing_scope");

async function linksTo(path: string): Promise<{ url: string }[]> {
  const { links } = await dropbox("sharing/list_shared_links", { path, direct_only: true });
  return links ?? [];
}

// A Dropbox share link to an approved cut's master, to pass on. Anyone with the
// link can open and download it; withdrawing the approval turns it off.
async function shareLink(profile: Profile, fileId: unknown) {
  const { file } = await findMaster(profile, fileId);
  try {
    const link = await dropbox("sharing/create_shared_link_with_settings", { path: file.path_lower });
    return { url: link.url };
  } catch (error) {
    if (noSharing(error)) throw new HttpError(503, "Dropbox links aren't switched on yet: the RippleReview Dropbox app needs its sharing permission.");
    if (!String((error as Error).message).includes("shared_link_already_exists")) throw error;
    const [existing] = await linksTo(file.path_lower);
    if (!existing) throw error;
    return { url: existing.url };
  }
}

// An approval was withdrawn: every share link to that master stops working.
async function revokeShareLink(profile: Profile, fileId: unknown) {
  requireReviewer(profile);
  let found;
  try {
    found = await findMaster(profile, fileId, { approved: false });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return { revoked: 0 };   // no master, no link
    throw error;
  }
  if ((await approvedIds([found.id])).has(found.id)) throw new HttpError(400, "This cut is still approved.");
  let links: { url: string }[] = [];
  try {
    links = await linksTo(found.file.path_lower);
  } catch (error) {
    if (noSharing(error)) return { revoked: 0 };                                    // links were never switched on
    throw error;
  }
  for (const link of links) await dropbox("sharing/revoke_shared_link", { url: link.url }).catch(() => {});
  return { revoked: links.length };
}

async function thumbs(profile: Profile, paths: unknown) {
  const list = (Array.isArray(paths) ? paths : []).map(String).filter((p) => allowed(profile, p.toLowerCase()));
  const out: Record<string, string> = {};
  for (let i = 0; i < list.length; i += 25) {
    const batch = list.slice(i, i + 25);
    const data = await dropbox("files/get_thumbnail_batch", {
      entries: batch.map((path) => ({ path, format: "jpeg", size: "w640h480", mode: "bestfit" })),
    }, "content");
    data.entries.forEach((entry: any, j: number) => {
      if (entry[".tag"] === "success") out[batch[j]] = `data:image/jpeg;base64,${entry.thumbnail}`;
    });
  }
  return { thumbs: out };
}

// Anyone may set their own display name and picture. The picture arrives as a
// small square data URL (the browser shrinks it first), or null to remove it.
async function setProfile(profile: Profile, body: any) {
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = String(body.name ?? "").trim().slice(0, 40);
  if (body.avatar !== undefined) {
    const avatar = body.avatar === null ? null : String(body.avatar);
    if (avatar && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) throw new HttpError(400, "That picture didn't come through.");
    if (avatar && avatar.length > 120_000) throw new HttpError(400, "That picture is too big.");
    patch.avatar = avatar;
  }
  const { data, error } = await db.from("profiles").update(patch).eq("id", profile.id).select().single();
  if (error) throw new HttpError(400, error.message);
  return { profile: data };
}

async function sendMail(subject: string, html: string, to?: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("NOTIFY_FROM") ?? "RippleReview <no-reply@send.ripple-edit.com>",
      to: to ?? Deno.env.get("NOTIFY_TO") ?? "info@ripple-edit.com",
      // Nothing listens on the sending subdomain, so replies go to the studio.
      reply_to: Deno.env.get("NOTIFY_REPLY_TO") ?? Deno.env.get("NOTIFY_TO") ?? "info@ripple-edit.com",
      subject,
      html,
    }),
  });
  if (!res.ok) console.error("resend:", res.status, (await res.text()).slice(0, 200));
  return res.ok;
}

// A client approves a version, or takes that approval back. Nothing to record
// here - the approvals table already holds it - so this only sends the notice.
async function approvalChanged(profile: Profile, body: any) {
  if (profile.is_admin) return { emailed: false };      // the studio's own doing
  requireReviewer(profile);
  const folder = profile.client_folder ?? "";
  if (!folder) throw new HttpError(403, "No client space is linked to this login yet.");

  const fileId = String(body.fileId ?? "");
  const meta = await dropbox("files/get_metadata", { path: fileId });
  if (!allowed(profile, meta.path_lower)) throw new HttpError(403, "Not your file.");

  const who = escapeHtml(profile.name || folder);
  const what = escapeHtml(String(body.title ?? "").trim().slice(0, 120) || meta.name);
  const plain = String(body.title ?? "").trim().slice(0, 120) || meta.name;
  const app = Deno.env.get("APP_URL") ?? "https://review.ripple-edit.com";
  const link = `${app}/#/c/${encodeURIComponent(folder)}/v/${encodeURIComponent(fileId)}`;
  const approved = Boolean(body.approved);

  const emailed = await sendMail(
    approved ? `${profile.name || folder} approved ${plain}` : `${profile.name || folder} withdrew approval for ${plain}`,
    approved
      ? `<p><strong>${who}</strong> approved <strong>${what}</strong>.</p>
         <p>That version is signed off.</p>
         <p><a href="${link}">Open it in RippleReview</a></p>
         <p style="color:#888;font-size:12px">${escapeHtml(meta.name)}</p>`
      : `<p><strong>${who}</strong> took back their approval of <strong>${what}</strong>.</p>
         <p>It's waiting for review again.</p>
         <p><a href="${link}">Open it in RippleReview</a></p>
         <p style="color:#888;font-size:12px">${escapeHtml(meta.name)}</p>`,
    Deno.env.get("NOTIFY_APPROVALS_TO"),
  );
  return { emailed };
}

// A client presses "send my notes". We record it, so the studio sees it in
// the app, and send one email, so they see it without opening the app.
async function notesSubmitted(profile: Profile, body: any) {
  if (profile.is_admin) throw new HttpError(400, "That button is for clients.");
  requireReviewer(profile);
  const folder = profile.client_folder ?? "";
  if (!folder) throw new HttpError(403, "No client space is linked to this login yet.");

  const fileId = String(body.fileId ?? "");
  const meta = await dropbox("files/get_metadata", { path: fileId });
  if (!allowed(profile, meta.path_lower)) throw new HttpError(403, "Not your file.");

  const { count } = await db.from("comments")
    .select("id", { count: "exact", head: true })
    .eq("file_id", fileId).is("parent_id", null).eq("done", false);

  const who = profile.name || folder;
  const { data: row, error } = await db.from("submissions")
    .insert({ file_id: fileId, client_folder: folder.toLowerCase(), by_name: who, note_count: count ?? 0 })
    .select().single();
  if (error) throw new HttpError(400, error.message);

  const app = Deno.env.get("APP_URL") ?? "https://review.ripple-edit.com";
  const link = `${app}/#/c/${encodeURIComponent(folder)}/v/${encodeURIComponent(fileId)}`;
  const notes = count === 1 ? "1 open note" : `${count ?? 0} open notes`;
  // The app sends the readable title ("Webinar Funnel - Long form v3");
  // the file name is only the fallback.
  const plain = String(body.title ?? "").trim().slice(0, 120) || meta.name;
  const what = escapeHtml(plain);

  // A refused email must not lose the submission: it is already recorded.
  const emailed = await sendMail(
    `${who} finished reviewing ${plain}`,
    `<p><strong>${escapeHtml(who)}</strong> has finished reviewing <strong>${what}</strong>.</p>
     <p>${notes} waiting for you.</p>
     <p><a href="${link}">Open it in RippleReview</a></p>
     <p style="color:#888;font-size:12px">${escapeHtml(meta.name)}</p>`,
  );
  return { submission: row, emailed };
}

async function clients(profile: Profile) {
  requireAdmin(profile);
  const [entries, { data: logins }] = await Promise.all([
    listAll("", false),
    db.from("profiles").select("*").order("created_at"),
  ]);
  const folders = entries
    .filter((e: any) => e[".tag"] === "folder")
    .map((e: any) => ({
      folder: e.name,
      logins: (logins ?? []).filter((l) => l.client_folder?.toLowerCase() === e.name.toLowerCase()),
    }))
    .sort((a: any, b: any) => a.folder.localeCompare(b.folder));
  const known = new Set(folders.map((f: any) => f.folder.toLowerCase()));
  const orphans = (logins ?? []).filter((l) => !l.is_admin && !known.has(l.client_folder?.toLowerCase() ?? ""));
  return { folders, orphans };
}

async function createClientLogin(profile: Profile, body: any) {
  requireAdmin(profile);
  const folder = cleanFolder(body.folder);
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim() || folder;
  const role = body.role === "member" ? "member" : "leader";
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "That name can't be turned into a username.");
  if (password.length < 8) throw new HttpError(400, "Use a password with at least 8 characters.");

  try {
    await dropbox("files/create_folder_v2", { path: `/${folder}`, autorename: false });
  } catch (error) {
    if (!(error instanceof HttpError) || !String(error.message).includes("conflict")) throw error;
  }

  const { data, error } = await db.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name },
  });
  if (error) throw new HttpError(400, /already|registered|exists/i.test(error.message)
    ? "A login with that name already exists. Pick a different client name."
    : error.message);
  const patch: Record<string, unknown> = { client_folder: folder, name };
  if (role === "member") patch.team_role = "member";
  const { error: saveError } = await db.from("profiles").update(patch).eq("id", data.user.id);
  if (saveError) {
    // Without database update 8 a "member" would be a full client login: undo it.
    if (role === "member") await db.auth.admin.deleteUser(data.user.id);
    throw new HttpError(400, role === "member" ? "Run database update 8 first, then add the team member again." : saveError.message);
  }
  return { ok: true };
}

// Rename a client, move their Dropbox folder, or change their username.
// Notes follow: they are keyed by Dropbox file id, which survives a move,
// and their folder label is rewritten here so access keeps working.
async function updateClient(profile: Profile, body: any) {
  requireAdmin(profile);
  const userId = String(body.userId ?? "");
  const { data: target } = await db.from("profiles").select("*").eq("id", userId).single();
  if (!target) throw new HttpError(404, "That login is gone.");
  if (target.is_admin) throw new HttpError(400, "That's your own studio login.");

  const oldFolder = target.client_folder ?? "";
  const folder = body.folder === undefined ? oldFolder : cleanFolder(body.folder);
  if (target.team_role === "member" && folder.toLowerCase() !== oldFolder.toLowerCase()) {
    throw new HttpError(400, "A team member's space follows their team leader. Rename it from the leader's login.");
  }

  if (folder.toLowerCase() !== oldFolder.toLowerCase()) {
    if (oldFolder) {
      await dropbox("files/move_v2", { from_path: `/${oldFolder}`, to_path: `/${folder}`, autorename: false });
    } else {
      try {
        await dropbox("files/create_folder_v2", { path: `/${folder}`, autorename: false });
      } catch (error) {
        if (!(error instanceof HttpError) || !String(error.message).includes("conflict")) throw error;
      }
    }
    // The notes and approvals move with them.
    await db.from("comments").update({ client_folder: folder.toLowerCase() }).eq("client_folder", oldFolder.toLowerCase());
    await db.from("approvals").update({ client_folder: folder.toLowerCase() }).eq("client_folder", oldFolder.toLowerCase());
    await db.from("project_status").update({ client_folder: folder.toLowerCase() }).eq("client_folder", oldFolder.toLowerCase());
    await db.from("submissions").update({ client_folder: folder.toLowerCase() }).eq("client_folder", oldFolder.toLowerCase());
    // The rest of their team moves with them.
    if (oldFolder) await db.from("profiles").update({ client_folder: folder }).eq("client_folder", oldFolder).neq("id", userId);
  }

  const patch: Record<string, unknown> = { client_folder: folder };
  if (body.name !== undefined) patch.name = String(body.name ?? "").trim().slice(0, 40);
  if (body.avatar !== undefined) {
    const avatar = body.avatar === null ? null : String(body.avatar);
    if (avatar && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) throw new HttpError(400, "That picture didn't come through.");
    if (avatar && avatar.length > 120_000) throw new HttpError(400, "That picture is too big.");
    patch.avatar = avatar;
  }

  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "That username doesn't work.");
    if (email !== target.email) {
      const { error } = await db.auth.admin.updateUserById(userId, { email, email_confirm: true });
      if (error) throw new HttpError(400, /already|registered|exists/i.test(error.message)
        ? "Another login already uses that username." : error.message);
      patch.email = email;
    }
  }

  const { error } = await db.from("profiles").update(patch).eq("id", userId);
  if (error) throw new HttpError(400, error.message);
  return { ok: true };
}

async function setPassword(profile: Profile, body: any) {
  requireAdmin(profile);
  const password = String(body.password ?? "");
  if (password.length < 8) throw new HttpError(400, "Use a password with at least 8 characters.");
  const { error } = await db.auth.admin.updateUserById(String(body.userId), { password });
  if (error) throw new HttpError(400, error.message);
  return { ok: true };
}

async function removeLogin(profile: Profile, body: any) {
  requireAdmin(profile);
  const userId = String(body.userId ?? "");
  if (userId === profile.id) throw new HttpError(400, "You can't remove your own login.");

  // Optionally wipe what they left behind, before the profile row goes.
  if (body.purge) {
    const { data: target } = await db.from("profiles").select("*").eq("id", userId).single();
    const folder = target?.client_folder?.toLowerCase();
    // A team member leaves no notes; purging would wipe their leader's space.
    if (folder && target?.team_role !== "member") {
      await db.from("comments").delete().eq("client_folder", folder);
      await db.from("approvals").delete().eq("client_folder", folder);
    }
  }

  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) throw new HttpError(400, error.message);
  return { ok: true };
}

// RippleLab ---------------------------------------------------------------

// Title & thumbnail ideas the studio shortlisted in RippleLab, for the
// projects in this person's own space. The job code in each project folder's
// name ("SIM-20 - Don Toliver…") is the link. Only codes from folders this
// person may see are ever asked about, so nobody can fish for another
// client's ideas. If RippleLab is unset or unreachable: no ideas, no error.
const JOB_CODE = /(?:^|[\s_-])([A-Za-z]{2,4})[-_ ]?(\d{1,3})(?=$|[\s_-])/;

async function packaging(profile: Profile, requested: unknown) {
  const base = (Deno.env.get("RIPPLELAB_URL") ?? "").replace(/\/+$/, "");
  const key = Deno.env.get("RIPPLELAB_KEY") ?? "";
  if (!base || !key) return { ideas: {} };
  const folder = folderFor(profile, requested);
  const byCode = new Map<string, string>();
  for (const entry of await listAll(`/${folder}`, false)) {
    if (entry[".tag"] !== "folder" || entry.name.startsWith("_")) continue;
    const match = JOB_CODE.exec(entry.name);
    // "NIL-09" and "NIL-9" are the same job: numbers without leading zeros.
    if (match) byCode.set(`${match[1].toUpperCase()}-${Number(match[2])}`, entry.name);
  }
  if (!byCode.size) return { ideas: {} };
  try {
    const response = await fetch(`${base}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ripplelab-key": key },
      body: JSON.stringify({ codes: [...byCode.keys()] }),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return { ideas: {} };
    const found = await response.json() as Record<string, unknown>;
    // Keyed by project folder name, the way the app knows its projects.
    const ideas: Record<string, unknown> = {};
    for (const [code, value] of Object.entries(found)) if (byCode.has(code)) ideas[byCode.get(code)!] = value;
    return { ideas };
  } catch (error) {
    console.error("RippleLab", error);
    return { ideas: {} };
  }
}

// Entry -------------------------------------------------------------------

Deno.serve(async (req) => {
  // Allow whatever headers the Supabase library sends, now and in later versions.
  const cors = { ...CORS, "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") ?? CORS["Access-Control-Allow-Headers"] };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const reply = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const profile = await whoIsAsking(req);
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "me": return reply(200, { profile });
      case "library": return reply(200, await library(profile, body.folder));
      case "link": return reply(200, await link(profile, body.fileId));
      case "master": return reply(200, await master(profile, body.fileId));
      case "share_link": return reply(200, await shareLink(profile, body.fileId));
      case "revoke_share_link": return reply(200, await revokeShareLink(profile, body.fileId));
      case "thumbs": return reply(200, await thumbs(profile, body.paths));
      case "packaging": return reply(200, await packaging(profile, body.folder));
      case "notes_submitted": return reply(200, await notesSubmitted(profile, body));
      case "approval_changed": return reply(200, await approvalChanged(profile, body));
      case "set_profile":
      case "set_name": return reply(200, await setProfile(profile, body));
      case "clients": return reply(200, await clients(profile));
      case "create_client": return reply(200, await createClientLogin(profile, body));
      case "update_client": return reply(200, await updateClient(profile, body));
      case "set_password": return reply(200, await setPassword(profile, body));
      case "remove_login": return reply(200, await removeLogin(profile, body));
      default: return reply(400, { error: "Unknown action." });
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    console.error(error);
    return reply(status, { error: error instanceof Error ? error.message : "Something went wrong." });
  }
});
