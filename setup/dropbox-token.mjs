// One-time helper: connects RippleReview to your Dropbox.
//
// Run it in a terminal:   node setup/dropbox-token.mjs
// It asks for your Dropbox App key, opens Dropbox so you can click "Allow",
// then prints the refresh token to paste into Supabase. Nothing is saved or
// sent anywhere except to Dropbox itself.

import { createHash, randomBytes } from "node:crypto";
import { exec, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const base64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The Proxy Watcher saved the App key when it connected; offer it (it isn't secret).
let knownKey = "";
try { knownKey = JSON.parse(readFileSync(path.join(homedir(), ".ripplereview", "dropbox.json"), "utf8")).app_key ?? ""; } catch {}

const appKey = (await rl.question(`\n1) Paste your Dropbox App key${knownKey ? ` (or just press Enter for ${knownKey})` : ""}: `)).trim() || knownKey;
if (!appKey) process.exit(1);

const verifier = base64url(randomBytes(48));
const challenge = base64url(createHash("sha256").update(verifier).digest());
const url = "https://www.dropbox.com/oauth2/authorize?" + new URLSearchParams({
  client_id: appKey,
  response_type: "code",
  token_access_type: "offline",
  code_challenge: challenge,
  code_challenge_method: "S256",
});

console.log("\n2) Dropbox is opening in your browser. Click Continue, then Allow.");
console.log(`   (If nothing opens, copy this link into your browser:)\n   ${url}\n`);
exec(`open "${url}"`);

const code = (await rl.question("3) Paste the code Dropbox shows you: ")).trim();
rl.close();

const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
  method: "POST",
  body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: appKey, code_verifier: verifier }),
});
const data = await res.json();

if (!res.ok || !data.refresh_token) {
  console.error("\nThat didn't work:", data.error_description || data.error || res.status);
  console.error("Run the script again and paste the newest code (each code works once).");
  process.exit(1);
}

console.log("\nDone. Add these two secrets in Supabase → Edge Functions → Secrets:\n");
console.log(`   DROPBOX_APP_KEY        ${appKey}`);
console.log(`   DROPBOX_REFRESH_TOKEN  ${data.refresh_token}\n`);
// On a Mac the token also goes onto the clipboard, ready to paste.
if (process.platform === "darwin") {
  const copy = spawn("pbcopy");
  copy.stdin.end(data.refresh_token);
  console.log("The refresh token is on your clipboard.");
}
console.log("Keep the refresh token private: it gives access to the RippleReview app folder.\n");
