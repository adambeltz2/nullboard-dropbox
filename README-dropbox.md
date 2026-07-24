# Nullboard + Dropbox sync — setup

This fork adds optional Dropbox sync on top of stock Nullboard. Local
`localStorage` is still where every edit lands first and instantly —
Dropbox is a background sync target, not the primary store. See the
comments at the top of `extras/nb-dropbox.js` for how it works.

## 1. Create a Dropbox app (one-time, ~2 minutes)

1. Go to https://www.dropbox.com/developers/apps → **Create app**.
2. Choose:
   - **Scoped access**
   - **App folder** access type (this scopes the app to its own
     `Apps/<your-app-name>` folder in your Dropbox, not your whole
     account — worth keeping even though it's just for you)
3. Under **Permissions**, enable `files.content.write` and
   `files.content.read` (App folder access usually grants these by
   default — just confirm they're checked).
4. Under **Settings**:
   - Copy the **App key** — you'll paste it into `nullboard.html`.
   - Under **OAuth 2 → Redirect URIs**, add the *exact* URL you'll
     host this on, no trailing slash, e.g.:
     `https://yourname.github.io/nullboard-dropbox/`
     (If you're testing locally first, also add
     `http://localhost:8000/` or whatever you use.)

No client secret is needed — this uses PKCE, which is designed for
static/public clients like a GitHub Pages site.

## 2. Set the app key

In `nullboard.html`, near the bottom, find:

```html
<script>window.NB_DROPBOX_APP_KEY = '';</script>
```

Paste your app key between the quotes.

## 3. Deploy to GitHub Pages

```bash
git add -A
git commit -m "Add Dropbox sync"
git branch -M main
git remote add origin https://github.com/<you>/nullboard-dropbox.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: Deploy from branch →
main / (root)**. Your site will be live at
`https://<you>.github.io/nullboard-dropbox/` within a minute or two —
this must match the redirect URI you registered in step 1 exactly.

## 4. Connect

Open the deployed site → the settings menu (top-right ≡) → **Dropbox
sync: off** → click it → sign in to Dropbox → you're redirected back
and it flips to **on**. From then on, every board save also pushes to
Dropbox in the background, and on load the app checks for anything
newer in Dropbox and pulls it in.

## What this does and doesn't do

- **Does:** push every save to Dropbox in the background; on load,
  pull in any board revision newer than what's local.
- **Doesn't:** merge concurrent edits. If you somehow edit the same
  board on two devices while both are offline, the higher revision
  number wins on next sync — not a smart merge. For normal "I use one
  device at a time and switch occasionally" usage this isn't an
  issue; it would matter if you ever used it on two devices
  simultaneously.
- **Doesn't:** sync automatically in real time / while the tab is
  open elsewhere — the pull only runs once at page load. Reload the
  tab on device B to pick up what you saved on device A.

## Testing locally before deploying

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/nullboard.html`. Make sure you added
that exact URL as a redirect URI in the Dropbox app settings too, or
the OAuth callback will fail with a redirect_uri mismatch.
