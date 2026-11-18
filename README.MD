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

## Configuration

| Variable | Default |
|---|---|
| `APP_BASE_URL` | `https://editor.photos.by.vincent.mahn.ke` |
| `IMMICH_BASE_URL` | `https://photos.by.vincent.mahn.ke` |
| `DATA_DIR` | `./data` (session database) |
| `PORT` | `3000` |

## Development

From `app/`:

```sh
npm install
npm test           # offline tests against a fake Immich
npm run dev:fake   # app at http://localhost:3000 with 18 months of generated photos
```

The Docker build runs the tests in its `test` stage, so a failing test stops the deploy.
