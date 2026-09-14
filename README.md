# Unified wall dashboard

A single wall-mounted-tablet dashboard combining three independent, already-working
standalone apps into one page:

- **Left column**: [dhmz-weather-dashboard](../dhmz-weather-dashboard) — weather forecast + radar
- **Right column, top**: [eko-karta-zagreb-standalone](../eko-karta-zagreb-standalone) — current air-quality/weather sensor readings
- **Right column, bottom**: [stampar-pelud-standalone](../stampar-pelud-standalone) — pollen forecast

This repo does not duplicate any of the three apps' code. It's glue only:
a merged frontend (`dashboard/frontend/`) and an nginx reverse proxy, orchestrated by
one `docker-compose.yml` that builds the three backends straight from their own sibling
repos, checked out next to this one **using their default `git clone` folder names**
(i.e. matching the GitHub repo name — the build contexts in `docker-compose.yml` rely
on that, so a fresh `git clone` of all four repos "just works" without renaming
anything).

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                nginx (wall-dashboard)                  │  :8090 → tablet browser
│  serves dashboard/frontend/ + reverse-proxies          │
│  /api/dhmz/*, /api/eko/*, /api/pollen/*                │
│  /docker-api/containers/<name>/json (Basic Auth,       │
│   exact-match whitelist) → /var/run/docker.sock        │
└───────┬───────────────┬───────────────┬────────────────┘
        │               │               │
 dhmz-weather   eko-karta-zagreb   stampar-pelud
   :8000            :8080             :8080
 (stdlib http)   (stdlib http)    (stdlib http)
```

The three data backends are **not** merged into one process/container — see
"Why not merge the backends?" below. Only nginx's port (`8090`) is published to the
host; the three backends are reachable only from other containers on the compose
network. nginx additionally reads `/var/run/docker.sock` directly (read-only) to power
the status bar - see "Status bar" below for how that's restricted.

## Running it

Clone all four repos as siblings, using their default (repo-name) folder names —
don't rename them, `docker-compose.yml`'s build contexts depend on this:

```bash
git clone https://github.com/kpisacic/dhmz-weather-dashboard.git
git clone https://github.com/kpisacic/eko-karta-zagreb-standalone.git
git clone https://github.com/kpisacic/stampar-pelud-standalone.git
git clone <this-repo-url> my-unified-dashboard
```

```
dhmz-weather-dashboard/
eko-karta-zagreb-standalone/
stampar-pelud-standalone/
my-unified-dashboard/        <- this repo; run the command below from here
```

The dashboard (nginx) container reads `/var/run/docker.sock` to power the status bar
(see below), via a supplementary group rather than running as root — find that group's
numeric ID on the host and put it, plus your own Basic Auth credentials for it, in a
`.env` file next to `docker-compose.yml` (skip the GID line if it already happens to be
`987`, the default):

```bash
stat -c '%g' /var/run/docker.sock   # e.g. 987
cat > .env <<EOF
DOCKER_SOCK_GID=987
DOCKER_STATUS_PASSWORD=pick-something-yourself
EOF
```

```bash
docker compose up -d --build
```

Then open `http://<host>:8090/` (point the wall tablet's browser/kiosk app at this).

## Configuring stations

Each backend's env vars are set in this repo's `docker-compose.yml` (copied from each
app's own `docker-compose.yml` defaults) — edit them there, then
`docker compose up -d --build`. See each standalone app's own README for the full list
of valid values (station names, cache seconds, etc).

The dropdowns in the Eko Karta and Stampar panels still let a viewer switch station
live from the tablet itself (remembered per-browser via `localStorage`) — the env vars
above only set what's shown before that choice is made.

## Status bar

The top of the page shows a live clock (left) and a colored dot per monitored
container (right) — no Portainer or other monitoring stack needed for this; nginx
itself proxies straight to `/var/run/docker.sock` (the same Docker Engine API
Portainer uses), and the frontend's own JS (`statusbar.js`) fetches each container's
status and works out the color.

| Color | Meaning |
|---|---|
| 🟢 green | running, healthy (or no healthcheck defined at all) |
| 🟢 light green | running, but its healthcheck is failing |
| 🟡 yellow | starting / restarting |
| 🔴 red | stopped (exited/dead/paused) |
| ⚪ gray | not found, or the Docker socket couldn't be reached |

Unlike a generic Docker socket proxy, only `GET /docker-api/containers/<name>/json` for
the four container names hardcoded in `nginx.conf`'s exact-match location is reachable
- not the list-all endpoint, not images/volumes/networks, not create/exec/delete.
That's the real protection; Basic Auth on top of it (credentials generated at
container start by `docker-entrypoint.sh` from `DOCKER_STATUS_USER`/
`DOCKER_STATUS_PASSWORD`, and injected into the page's own `runtime-config.js` so the
tablet's browser sends it automatically, no popup) is a speed bump against casual LAN
discovery, not real security - the password ships in a JS file the tablet's browser
can read. Fine for a home LAN; treat it that way.

Which containers show up is a hardcoded list in both `nginx.conf` (the whitelist) and
`statusbar.js` (which URLs it fetches) - add a name in both places to monitor another
container.

An earlier, heavier-but-more-isolated version of this lived in its own `docker-status/`
service (a tiny stdlib Python process that read the socket itself and only ever
returned `{name, color}` to the browser - never raw inspect data). It's kept in this
repo, unreferenced by `docker-compose.yml`, as a documented fallback: swap the
`/docker-api/` bits below for it if you'd rather not have nginx touch the Docker socket
directly.

| | RAM | Isolation |
|---|---|---|
| nginx proxy (current) | +0 MiB measured (same as nginx's baseline) | dashboard container touches the socket |
| `docker-status/` (kept, unused) | +~13 MiB | socket access isolated to its own disposable container; browser never sees raw inspect data |

## Why not merge the backends into one process?

Measured with `docker stats` after a real fetch on each (Sept 2026):

| Container | RSS | Idle CPU |
|---|---|---|
| dhmz-weather (stdlib http.server + lxml + Pillow) | ~31-33 MiB | ~0.02% |
| eko-karta-zagreb (stdlib only) | ~16-21 MiB | ~0.02-0.03% |
| stampar-pelud (stdlib + bs4) | ~19-25 MiB | ~0.02% |
| wall-dashboard (nginx, incl. the status bar's Docker API proxy) | ~8 MiB | ~0% |
| **Total** | **~75-87 MiB** | |

All three backends are now plain stdlib `http.server` apps (no web framework) — see
[dhmz-weather-dashboard](../dhmz-weather-dashboard)'s history: it originally ran on
FastAPI/uvicorn (~50 MiB RSS, plus a constant ~0.3% idle CPU draw from uvicorn's
background tick loop), which turned out to add real memory/CPU weight without the app
ever using any of FastAPI's async/validation/DI features — every handler was already
plain synchronous code. Porting it to the same stdlib pattern as the other two dropped
it to ~31 MiB and near-zero idle CPU, with no functional loss.

Merging the three backends into one process would still only save the duplicated
Python-interpreter baseline (roughly 20-30 MiB) — a small slice of a 1 GB Raspberry Pi
3B+'s budget — at the cost of losing independent operation/failure isolation. With all
three already lightweight stdlib servers, that tradeoff is even less worth it now than
before; not worth it. The current ~75-87 MiB total leaves plenty of headroom.

## Project layout

```
docker-compose.yml     # 4 services: the 3 data backends (built from sibling repos)
                        # + dashboard
docker-status/          # NOT referenced by docker-compose.yml - kept as a documented
                        # fallback, see "Status bar" above
  Dockerfile            # python:3.12-alpine, zero pip dependencies
  server.py             # reads /var/run/docker.sock, serves GET /api/status
dashboard/
  Dockerfile            # nginx:alpine + the openssl CLI (for docker-entrypoint.sh)
  docker-entrypoint.sh  # generates the Basic Auth password file + runtime-config.js
                        # from env vars, and grants nginx's own user access to
                        # /var/run/docker.sock, before starting nginx
  nginx.conf            # static file serving + /api/* and /docker-api/ reverse proxy
  frontend/
    index.html          # .page (statusbar + dashboard-grid): panel-dhmz | (panel-eko above panel-pollen)
    style.css            # shared reset, dark theme vars, page-level layout
    statusbar.css / statusbar.js # clock + per-container status dots (see nginx.conf)
    runtime-config.js    # generated at container start by docker-entrypoint.sh - not in git
    dhmz.css / dhmz.js   # ported from dhmz-weather-dashboard/frontend, namespaced under .panel-dhmz
    eko.css  / eko.js    # ported from eko-karta-zagreb-standalone/.../static, namespaced under .panel-eko
    pollen.css / pollen.js # ported from stampar-pelud-standalone/.../static, namespaced under .panel-pollen
    icons/               # copy of Stampar's pollen plant icon set
data/
  dhmz/                  # bind-mounted persisted state for the DHMZ backend (gitignored)
```
