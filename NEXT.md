# RippleReview — what's left

Written at the end of the first build day (12 Sep 2026). The app is live at
review.ripple-edit.com and in real use. Nothing here is broken; this is the
list of things we chose not to finish tonight.

## Decisions to make before building

**Team, the one question that unlocks the rest:** when an editor gets their own
login, do they see every client, or only the projects assigned to them? The
answer decides the table shape, so it comes first.

Around it sit three smaller ones:
- Should the client see who edited their video ("Edited by Razz @ RippleEdit")?
- Can an editor approve on the studio's behalf, or only the owner?
- Does an editor get the "with you" queue filtered to their own work?

## Reserved in the menu, not built

Both appear greyed with a "Soon" tag in the studio sidebar, so the shape of the
app is honest about what exists.

**Projects page** — create a project from inside the app: name it by the
convention, create the Dropbox folder, pick the client. Today a project is made
by making a folder in Finder, which works but means switching apps.

**Team page** — studio logins beside client logins in Manage logins: invite an
editor, set what they may do, assign them to clients or projects.

## Mobile — works, not yet polished

Measured on the live site at 375×812 (iPhone size) on 13 Sep 2026:

- **No horizontal overflow** anywhere, and the sidebar correctly slides off
  screen behind the menu button.
- **The review screen stacks properly**: player on top (341×192), notes panel
  full width underneath, composer usable.

What needs doing before telling clients to review on a phone:

- **Touch targets are too small.** Apple's floor is 44px. Ours: the done
  circle is 22px, the All/Open/Done tabs 23px, the scrub bar 24px tall. The
  play button is 40px and just about passes. Everything a thumb hits on the
  review screen should be at least 44px on touch devices.
- **Scrubbing precision.** A 24px-tall bar on a 341px-wide player is a rough
  instrument for frame-accurate notes. Consider a larger hit area on touch,
  and frame-step buttons, since there is no keyboard.
- **Drawing and pinning with a finger** are untested on a real device. The
  code uses pointer events, so it should work, but it has never been tried.
- **The notes panel is 722px tall** below the player, so a client reads the
  video and the notes in two separate scrolls. A collapsed notes sheet that
  slides up over the player would suit a phone better.
- **Full screen on iPhone** falls back to the native player
  (`webkitEnterFullscreen`), which hides our pins and drawings. Worth knowing
  before recommending it.
- **Landscape** is untested.

Verdict: a client *can* review on a phone today, and nothing is broken. But it
was designed at desktop size, and the small controls will frustrate anyone
trying to tick notes off on the train.

## Smaller things we noticed and left

- **Notes don't mark themselves new.** The studio's "Notes in" chip fires when a
  client finishes a review; individual notes written afterwards are marked "Not
  sent" on the client's side but nothing flags them for the studio.
- **No notification when the studio replies.** The client learns about a reply
  by opening the app. An email would close that loop, and the sending domain is
  already verified.
- **Drawings are one colour per person and one stroke width.** No eraser, no
  undo beyond the last stroke while composing.
- **Version compare.** Frame.io lets you put two versions side by side. Ours
  switches between them.
- **Client-side download** is deliberately absent. If you ever want it, it
  should be per-client and probably watermarked.
- **Presence is per browser.** "Last seen" comes from the app being open, so a
  client with the tab left open looks permanently online.
- **The "New" marker is per device.** It uses this browser's memory of your last
  visit, so it resets on a new machine.

## Operational notes

- **Changing `supabase/functions/dropbox/index.ts` means pasting it into the
  Supabase dashboard again.** Nothing in a push deploys it.
- **Database changes** are the numbered files in `supabase/`. Run them in order
  on a fresh project; they're safe to re-run.
- **Client pictures** waiting in `local/` (gitignored): nile-waves, antar, sim.
  Add them with Clients → gear → Add picture.
- **Proxy exports:** H.264 .mp4, 1080p, ~6 Mbps, keyframe every 1 second, AAC
  256 kbps. The keyframe interval is what makes scrubbing feel precise.
- **Naming:** `_PREVIEW_<JOB>_<CUT>_v1.mp4`, e.g. `_PREVIEW_NIL-10_LF_v1.mp4`.
  Markers understood: LF, SF-01, TR, TEASER, REEL, PROMO, BTS; platforms YT,
  IG, TT, FB, LI, X.

## If something goes wrong

- **"Unknown action"** — the deployed function is older than the app. Paste it.
- **A video won't play** — it isn't H.264 .mp4. ProRes and HEVC won't play in a
  browser.
- **A project doesn't appear** — Dropbox hasn't finished syncing, or the folder
  isn't directly inside the client's space. Then hit refresh in the top bar.
- **Client can't sign in** — check the username in Clients; reset the password
  from the key icon and send the invite the dialog writes for you.
