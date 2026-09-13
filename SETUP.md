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
2. **Permissions** tab: tick `files.metadata.read`, `files.content.read`, `files.content.write` → **Submit**.
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
- **New video:** export your master as usual, then drop it into `~/Desktop/RippleDrop`
  with the Proxy Watcher running (`tools/Proxy Watcher.command`). It makes the review
  copy, names it `_PREVIEW_…` and files it under the right client and project by its job
  code. The master stays out of Dropbox, in `RippleDrop/_masters`.
  To do it by hand instead: export H.264 .mp4, 1080p, ~4–6 Mbps, keyframe every second,
  AAC 256 kbps, and drop it into `Dropbox/Apps/RippleReview/<Client>/<Project>/`.
- **New version:** same folder, same title plus `v2`, `v3`: `Midnight Drive v2.mp4`.
- **Notes into your edit:** Export → "Resolve markers" → in Resolve: Timelines → Import → Timeline Markers from EDL.
- **Try it without any setup:** open the site with `?demo` at the end of the address.
