// RippleReview server function: the only thing that talks to Dropbox.
//
// It holds the Dropbox key, checks who is asking, and only ever hands a
// client what is inside their own folder. Deployed in Supabase as "dropbox".
//
// Secrets it needs (Supabase → Edge Functions → Secrets):
//   DROPBOX_APP_KEY        the App key from the Dropbox App Console
//   DROPBOX_REFRESH_TOKEN  printed by setup/dropbox-token.mjs
// SUPABASE_URL and the service key are provided by Supabase automatically.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VIDEO = /\.(mp4|m4v|mov|webm)$/i;

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

type Profile = { id: string; name: string; email: string; client_folder: string | null; is_admin: boolean };

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

  for (const entry of entries) {
    if (entry[".tag"] !== "file" || !VIDEO.test(entry.name)) continue;
    const parts = entry.path_display.split("/").slice(2); // drop "" and the client folder
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
    });
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
    return { name: project.name, modified: latest(videos), videos };
  });
  out.sort((a, b) => b.modified.localeCompare(a.modified));
  return { client: folder, projects: out };
}

async function link(profile: Profile, fileId: unknown) {
  const id = String(fileId ?? "");
  if (!id.startsWith("id:")) throw new HttpError(400, "Invalid file.");
  const meta = await dropbox("files/get_metadata", { path: id });
  if (!allowed(profile, meta.path_lower)) throw new HttpError(403, "Not your file.");
  const data = await dropbox("files/get_temporary_link", { path: id });
  return { url: data.link };
}

async function thumbs(profile: Profile, paths: unknown) {
  const list = (Array.isArray(paths) ? paths : []).map(String).filter((p) => allowed(profile, p.toLowerCase()));
  const out: Record<string, string> = {};
  for (let i = 0; i < list.length; i += 25) {
    const batch = list.slice(i, i + 25);
    const data = await dropbox("files/get_thumbnail_batch", {
      entries: batch.map((path) => ({ path, format: "jpeg", size: "w640h480", mode: "fitone_bestfit" })),
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

async function clients(profile: Profile) {
  requireAdmin(profile);
  const [entries, { data: logins }] = await Promise.all([
    listAll("", false),
    db.from("profiles").select("id, email, name, avatar, client_folder, is_admin, created_at").order("created_at"),
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
  await db.from("profiles").update({ client_folder: folder, name }).eq("id", data.user.id);
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
  }

  const patch: Record<string, unknown> = { client_folder: folder };
  if (body.name !== undefined) patch.name = String(body.name ?? "").trim().slice(0, 40);

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
    const { data: target } = await db.from("profiles").select("client_folder").eq("id", userId).single();
    const folder = target?.client_folder?.toLowerCase();
    if (folder) {
      await db.from("comments").delete().eq("client_folder", folder);
      await db.from("approvals").delete().eq("client_folder", folder);
    }
  }

  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) throw new HttpError(400, error.message);
  return { ok: true };
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
      case "thumbs": return reply(200, await thumbs(profile, body.paths));
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
