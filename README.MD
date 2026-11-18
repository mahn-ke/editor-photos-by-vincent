# editor.photos.by.vincent.mahn.ke

Shows your [Immich](https://photos.by.vincent.mahn.ke) photo timeline at
[editor.photos.by.vincent.mahn.ke](https://editor.photos.by.vincent.mahn.ke): the same
date-grouped, justified grid as Immich's **Photos** page, without the search bar. Tap a
photo to open it full-screen; swipe or use ←/→ to browse, swipe down or press Esc to close.

## How sign-in works

There is no token to set up. The app signs you in through Immich's own OAuth flow, which
uses the Keycloak at sso.by.vincent.mahn.ke:

1. `/auth/login` asks Immich (`POST /api/oauth/authorize`) for the Keycloak sign-in URL,
   with its own `state` and PKCE challenge, and sends the browser there.
2. Keycloak redirects back to `/auth/callback`. The app hands the callback URL, `state`
   and PKCE verifier to Immich (`POST /api/oauth/callback`). Immich exchanges the code
   with its own client secret and returns a normal Immich session for your user.
3. The Immich session token stays on the server, encrypted with a key derived from your
   session cookie, so the database alone holds no usable tokens. The browser only gets an
   opaque, `HttpOnly` cookie. The session shows up in Immich under
   **Account settings → Authorized devices**.

Every API and image request is proxied with that token, because Immich does not allow
cross-origin calls. Only the columns the grid needs are passed on: no location, owner
or people data. **Sign out** ends both the app session and the Immich session; the
Keycloak session stays, so signing in again takes one click.

The timeline shows your own assets with Immich's timeline visibility (no archive, trash
or partner photos), with stacks collapsed. Videos show their preview with a play badge
but don't play.

Keycloak only accepts the callback because `https://editor.photos.by.vincent.mahn.ke/auth/callback`
is listed in the `photos` client's `valid_redirect_urls` in
[mahn-ke/repos](https://github.com/mahn-ke/repos/blob/main/infrastructure/services.tf).

## Editor

Open a photo and press **Edit** (or go to `/edit/<asset id>`). The editor follows Google
Photos' layout:

- **Suggestions**: Enhance, Dynamic, Warm, Cool, plus the suggestions prepared for this photo
- **Crop**: aspect presets, a rotation ruler below the photo (drag = 1°, Shift+drag, Shift+←/→
  or the mouse wheel = 0.1°, double-click the value to type an angle), corner handles that
  refit the frame after you let go, 90° rotate and Reset
- **Tools**: Sky (seven looks), Color focus, Portrait light (only with faces) and Blur
  (tap the photo to choose what stays sharp), from masks computed on the server
- **Adjust**: the same 14 sliders as Google Photos
- **Filters**: our own looks plus the looks learned from your Google Photos edits

**Save** renders the original at full resolution on the server, uploads the result as a new
Immich asset, stacks it on top of the original (so it is the version shown) and appends the
settings to the original's metadata (`editor-photos`). Every save is a new version;
**Versions** lets you show any of them or discard one or all (discarded versions go to
Immich's trash). Leaving with unsaved changes asks "Discard changes?".

## Suggestions and background work

At sign-in the app creates a limited Immich API key (stored encrypted) and, on HTTPS, an
Immich workflow that calls `/hooks/immich/<user>` for every upload; a 15-minute poll covers
everything else (and is the only trigger on localhost). For each new photo the background
job tries your learned looks, Enhance/Dynamic and Straighten, keeps only candidates that a
CLIP-based grader (LAION aesthetic head + "good vs. bad photo" prompts, with guards against
clipping and oversaturation) says improve the photo, and ranks them with a per-user learner
that adapts to what you apply, tweak, dismiss or ignore. The timeline greets you with "Based
on your uploads in the last …, here are some edits". Pixel RAW+JPEG pairs are stacked with
the JPEG shown. The menu can unstack them or stop all background work. See
`docs/learned-edits.md` and `docs/raw.md`.

Models (≈330 MB, all permissively licensed, pinned by sha256) are downloaded into
`MODEL_DIR` on first use.

## Configuration

| Variable | Default |
|---|---|
| `APP_BASE_URL` | `https://editor.photos.by.vincent.mahn.ke` |
| `IMMICH_BASE_URL` | `https://photos.by.vincent.mahn.ke` |
| `DATA_DIR` | `./data` (session database) |
| `PORT` | `3000` |
| `MODEL_DIR` | `$DATA_DIR/models` |
| `APP_SECRET` | key for the stored API keys (default: generated `data/master.key`) |

## Development

From `app/`:

```sh
npm install
npm test           # offline tests against a fake Immich
npm run dev:fake   # app at http://localhost:3000 with 18 months of generated photos
```

The Docker build runs the tests in its `test` stage, so a failing test stops the deploy.

Locally against the real Immich (the SSO client allows `http://localhost:3024/auth/callback`):

```sh
PORT=3024 APP_BASE_URL=http://localhost:3024 node --watch main.js
```

End-to-end tests (Playwright, attached to a dedicated Chrome profile you sign in to once):

```sh
npm run e2e:browser   # starts Chrome; sign in to Google Photos and to the editor there
npm run e2e           # editor round trip + comparison with Google Photos' edits
```
