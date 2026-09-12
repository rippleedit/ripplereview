// The data layer. Everything the screens need goes through `api`, which is
// either the real one (Supabase + the Dropbox server function) or the demo.

import { DEMO, SUPABASE_KEY, SUPABASE_URL } from "./config.js";

async function realApi() {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm");
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  async function server(action, args = {}) {
    const { data, error } = await sb.functions.invoke("dropbox", { body: { action, ...args } });
    if (error) {
      let message = error.message;
      try { message = (await error.context.json()).error || message; } catch {}
      throw new Error(message);
    }
    return data;
  }

  function check({ data, error }) {
    if (error) throw new Error(error.message);
    return data;
  }

  let profile = null;

  return {
    demo: false,

    async session() {
      const { data } = await sb.auth.getSession();
      if (!data.session) return null;
      if (!profile) {
        const row = check(await sb.from("profiles").select("id, name, avatar, is_admin, client_folder").eq("id", data.session.user.id).single());
        profile = { ...row, email: data.session.user.email ?? "" };
      }
      return profile;
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message === "Invalid login credentials" ? "Wrong email or password." : error.message);
      profile = null;
      return this.session();
    },
    async signOut() {
      profile = null;
      await sb.auth.signOut();
    },

    library: (folder) => server("library", { folder }),
    link: async (fileId) => (await server("link", { fileId })).url,
    thumbs: async (paths) => (await server("thumbs", { paths })).thumbs,

    async summary(fileIds) {
      if (!fileIds.length) return { comments: [], approvals: [] };
      const [comments, approvals] = await Promise.all([
        sb.from("comments").select("file_id, done, parent_id").in("file_id", fileIds),
        sb.from("approvals").select("*").in("file_id", fileIds),
      ]);
      return { comments: check(comments), approvals: check(approvals) };
    },
    async comments(fileId) {
      return check(await sb.from("comments").select("*").eq("file_id", fileId).order("created_at"));
    },
    async addComment(comment) {
      return check(await sb.from("comments").insert(comment).select().single());
    },
    async updateComment(id, patch) {
      return check(await sb.from("comments").update(patch).eq("id", id).select().single());
    },
    async deleteComment(id) {
      check(await sb.from("comments").delete().eq("id", id));
    },
    async approval(fileId) {
      return check(await sb.from("approvals").select("*").eq("file_id", fileId).maybeSingle());
    },
    async approve(fileId, folder) {
      return check(await sb.from("approvals").insert({ file_id: fileId, client_folder: folder }).select().single());
    },
    async unapprove(fileId) {
      check(await sb.from("approvals").delete().eq("file_id", fileId));
    },

    async setProfile(fields) {
      const row = (await server("set_profile", fields)).profile;
      profile = { ...row, email: profile?.email ?? "" };
      return profile;
    },

    // Everyone sharing a space: used for the faces beside notes.
    async people(folder) {
      return check(await sb.from("profiles").select("id, name, avatar, is_admin, client_folder"));
    },

    clients: () => server("clients"),
    createClient: (fields) => server("create_client", fields),
    setPassword: (userId, password) => server("set_password", { userId, password }),
    removeLogin: (userId) => server("remove_login", { userId }),
  };
}

export const api = DEMO ? (await import("./demo.js")).demoApi() : await realApi();
