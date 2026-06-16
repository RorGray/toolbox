# Toolbox

A lightweight, Docker-ready hub that links to your self-hosted tools — each
running as its own Docker instance on a subdomain (e.g. the hub at
`tools.example.com`, with `pdf.tools.example.com`, `img.tools.example.com`,
and so on). Slim dark UI, entries editable from the browser, designed to live
behind an Authentik forward-auth proxy.

## What it does

- **Card grid grouped by category**, with live status dots and per-tool tags.
- **Edit from the browser** — add, edit and delete entries; no redeploy needed.
- **Icons that survive the proxy** — best-effort favicon auto-fetch, with paste-URL
  and file-upload fallbacks. All icons are cached on the volume and served from
  Toolbox's own origin (a remote favicon URL would just hit the Authentik login
  page and break).
- **Health checks every 60s** — a tool counts as *reachable* if it answers at
  all, including a 302 redirect to the Authentik login. Only connection/DNS
  failures and timeouts mark it unreachable.
- **Authentik-aware access control** — everyone past the proxy can view; only
  members of an admin group can edit.

## Quick start

```bash
docker compose up -d --build
```

The app listens on port `3000` inside the container and persists everything to
the `toolbox-data` volume (`/data/tools.json` plus `/data/icons`). It does **not**
publish a host port — route to it through your reverse proxy / Authentik outpost.

To run it bare for local poking (no auth):

```bash
npm install
REQUIRE_AUTH_HEADER=false ADMIN_GROUP="" DATA_FILE=./data/tools.json ICON_DIR=./icons npm start
# open http://localhost:3000
```

## Putting it behind Authentik

This app uses Authentik's **proxy provider (forward auth)** — not OIDC. There is
no login flow, client secret, or callback to configure in the app. Authentik
authenticates the request at the edge and injects identity headers; Toolbox
reads them and trusts them, because nothing else can reach the container.

1. In Authentik, create a **Proxy Provider** in *forward auth (single
   application)* mode and bind it to an Application for `tools.example.com`.
2. Add that provider to your **outpost** (the embedded one is fine), and wire
   your reverse proxy so requests to `tools.example.com` pass through the
   outpost's `/outpost.goauthentik.io/auth/...` endpoint. The
   `docker-compose.yml` includes commented Traefik labels showing the shape of
   this; nginx/Caddy work equally well.
3. Create a group for editors — default name `toolbox-admins` — and add yourself.

Authentik forwards these headers, which Toolbox reads:

| Header                  | Used for                          |
| ----------------------- | --------------------------------- |
| `X-authentik-username`  | identifying the signed-in user    |
| `X-authentik-groups`    | deciding who may edit (admin gate) |

> Make sure the group claim is actually sent. In the Proxy Provider's settings,
> the `X-authentik-groups` header is included by default; if you've customised
> the header mapping, keep groups in the forwarded set or editing will be denied
> for everyone.

### Defense in depth

`REQUIRE_AUTH_HEADER=true` (the default) makes Toolbox reject any request that
arrives **without** the username header — i.e. a direct hit to the container on
the Docker network that skipped the proxy. Keep it on unless you front the app
some other authenticated way.

## Configuration

All via environment variables (see `docker-compose.yml`):

| Variable              | Default                  | Meaning                                                        |
| --------------------- | ------------------------ | -------------------------------------------------------------- |
| `PORT`                | `3000`                   | Listen port.                                                   |
| `DATA_FILE`           | `/data/tools.json`       | Entry store (human-readable JSON, hand-editable).              |
| `ICON_DIR`            | `/data/icons`            | Cached icon files.                                             |
| `ADMIN_GROUP`         | `toolbox-admins`         | Group allowed to edit. Empty = any authenticated user.         |
| `REQUIRE_AUTH_HEADER` | `true`                   | Reject requests missing the Authentik user header.            |
| `AUTH_HEADER_USER`    | `x-authentik-username`   | Override if you renamed the header.                            |
| `AUTH_HEADER_GROUPS`  | `x-authentik-groups`     | Override if you renamed the header.                            |
| `HEALTH_INTERVAL_MS`  | `60000`                  | Background ping interval.                                      |
| `HEALTH_TIMEOUT_MS`   | `5000`                   | Per-check timeout.                                             |
| `MAX_ICON_BYTES`      | `524288`                 | Max cached icon size.                                          |

## Editing entries by hand

`tools.json` is plain JSON and safe to edit while the app runs — changes are
picked up on the next read. The web UI writes atomically and serialises writes,
so the two won't corrupt each other. An entry looks like:

```json
{
  "id": "a1b2c3d4e5f6a7b8",
  "name": "PDF Editor",
  "url": "https://pdf.tools.example.com",
  "description": "Merge, split and sign PDFs.",
  "category": "Documents",
  "tags": ["pdf", "sign"],
  "iconFile": "a1b2c3d4e5f6a7b8.png",
  "health": { "status": "up", "httpStatus": 302, "checkedAt": "..." }
}
```

## A note on auto-fetched icons

Because your tools also sit behind Authentik, a server-side favicon fetch will
usually receive the **login page** rather than an icon — Toolbox detects that
(it checks for an actual image, rejecting HTML) and silently falls back. So
expect to paste an image URL or upload a file for most tools; auto-fetch is a
bonus for anything reachable without auth. Until an icon is set, the card shows
a colored monogram.

## Architecture

- **Backend:** Node 20 + Express, ~5 small modules, one runtime dependency.
- **Store:** a single JSON file on a mounted volume; atomic writes behind an
  in-process lock.
- **Frontend:** vanilla ES modules and CSS, no build step, no external fonts
  (so it works on an air-gapped network).
- **Image:** `node:20-alpine`, runs as the non-root `node` user, with a
  container `HEALTHCHECK` on the unauthenticated `/healthz` endpoint.
```
toolbox/
├── server.js            Express app + routes
├── lib/
│   ├── config.js        env-driven config
│   ├── auth.js          Authentik header parsing + admin gate
│   ├── store.js         JSON store, atomic writes, write lock
│   ├── icons.js         favicon fetch / upload / caching + sniffing
│   └── health.js        background pinger
├── public/              UI (index.html, app.js, styles.css)
├── data/tools.json      seed entries (replace with your own)
├── Dockerfile
└── docker-compose.yml
```
