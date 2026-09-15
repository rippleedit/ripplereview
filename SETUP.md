# RippleReview setup

Done once. About 15 minutes. Do the steps in order.

## 1. Database (Supabase)

1. Supabase → **SQL Editor** → **New query**. Paste all of `supabase/schema.sql`, click **Run**.
2. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
3. **Authentication → Users → Add user → Create new user**: your own email and a password, tick **Auto Confirm**.
   The first login ever created becomes the admin, so create yours before any client's.

## 2. Dropbox app

1. [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) → **Create app**:
   **Scoped access** → **App folder** → name it `RippleReview`.
   (It must be "App folder". The app then only ever sees `Dropbox/Apps/RippleReview`.)
2. **Permissions** tab: tick `files.metadata.read`, `files.content.read`, `files.content.write`,
   `sharing.read`, `sharing.write` → **Submit**. (The sharing two power "Copy Dropbox Link".)
3. **Settings** tab: copy the **App key**.
4. In a terminal, in this folder, run:

   ```bash
   node setup/dropbox-token.mjs
   ```

   Paste the App key, click **Allow** in Dropbox, and paste the code back. It prints two secrets.

## 3. Server function (Supabase)

1. **Edge Functions → Secrets**: add the two secrets the script printed:
   `DROPBOX_APP_KEY` and `DROPBOX_REFRESH_TOKEN`.
2. **Edge Functions → Deploy a new function → Via Editor**. Name it `dropbox`.
   Replace the sample code with all of `supabase/functions/dropbox/index.ts` → **Deploy**.
3. Open the function's settings and turn **off** "Enforce JWT verification" (the function checks logins itself).

## 4. Connect the website

In Supabase → **Project Settings → API**, copy the **Project URL** and the **publishable** key
(or "anon" key, never the "secret" one) into `js/config.js`.

## 5. Domain

At your domain provider (STRATO), for `review.ripple-edit.com`:
set the subdomain's **CNAME** record to `rippleedit.github.io` (this replaces its A record).

## Daily use

- **New client:** Clients page → "Add a client login" → copy the login message and send it to them.
- **Someone on a client's team** (e.g. `sim-thumbnails`): Clients page → that client's card →
  the person-plus icon. They only see approved cuts, to watch them and download the master.
- **New video:** export your master as usual, then duplicate it into `RippleDrop` at the
  top of the ERF_WORK2 drive, with the Proxy Watcher running (double-click
  `! Start Proxies` at the top of that folder, or `tools/Proxy Watcher.command`).
  It reads the job code, makes the review copy (`_PREVIEW_…`) and uploads it to that project,
  then uploads the master into the project's hidden `_MASTERS` folder so the client can
  download it once they approve. Both go straight from the drive to Dropbox; nothing big
  lands on the Mac. Your duplicate then waits in `RippleDrop/_uploaded` (delete it whenever).
  Anything without a matching job code goes to `RippleDrop/_unsorted`.
- **First start of the watcher:** it asks for the Dropbox App key (dropbox.com/developers/apps
  → RippleReview → Settings) and for one click on Allow. Once only.
  To do it by hand instead: export H.264 .mp4, 1080p, ~4–6 Mbps, keyframe every second,
  AAC 256 kbps, and drop it into `Dropbox/Apps/RippleReview/<Client>/<Project>/`.
- **New version:** same folder, same title plus `v2`, `v3`: `Midnight Drive v2.mp4`.
- **Notes into your edit:** Export → "Resolve markers" → in Resolve: Timelines → Import → Timeline Markers from EDL.
- **Try it without any setup:** open the site with `?demo` at the end of the address.
