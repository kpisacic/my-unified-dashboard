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
┌────────────────────────────────────────────────────────────┐
│                    nginx (wall-dashboard)                   │  :8090 → tablet browser
│  serves dashboard/frontend/ + reverse-proxies                │
│  /api/dhmz/*, /api/eko/*, /api/pollen/*, /api/status         │
└───────┬───────────────┬───────────────┬───────────────┬──────┘
        │               │               │               │
 dhmz-weather   eko-karta-zagreb   stampar-pelud   docker-status
   :8000            :8080             :8080            :8080
 (stdlib http)   (stdlib http)    (stdlib http)     (stdlib http,
                                                    reads /var/run/docker.sock)
```

The three data backends are **not** merged into one process/container — see
"Why not merge the backends?" below. Only nginx's port (`8090`) is published to the
host; every backend (including `docker-status`) is reachable only from other
containers on the compose network.

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

The `docker-status` service (see below) needs read access to
`/var/run/docker.sock`, via a supplementary group rather than running as root — find
that group's numeric ID on the host and put it in a `.env` file next to
`docker-compose.yml` (skip this if it happens to already be `987`, the default):

```bash
stat -c '%g' /var/run/docker.sock   # e.g. 987
echo "DOCKER_SOCK_GID=987" > .env   # use whatever number the command above printed
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
container (right) — no Portainer or other monitoring stack needed for this; the
`docker-status` service reads exactly the same Docker Engine API Portainer itself
uses, straight from `/var/run/docker.sock`. It never exposes that socket to the
browser though — the frontend only ever gets back a container name and a color, never
raw inspect data (env vars, mounts, etc.), so anything that can reach the dashboard on
your LAN can't use it to poke at your Docker host.

| Color | Meaning |
|---|---|
| 🟢 green | running, healthy (or no healthcheck defined at all) |
| 🟢 light green | running, but its healthcheck is failing |
| 🟡 yellow | starting / restarting |
| 🔴 red | stopped (exited/dead/paused) |
| ⚪ gray | not found, or the Docker socket couldn't be reached |

Which containers show up is set by `MONITORED_CONTAINERS` (comma-separated container
names) on the `docker-status` service in `docker-compose.yml` — defaults to all 5
services in this stack, including `docker-status` itself.

## Why not merge the backends into one process?

Measured with `docker stats` after a real fetch on each (Sept 2026):

| Container | RSS | Idle CPU |
|---|---|---|
| dhmz-weather (stdlib http.server + lxml + Pillow) | ~31-33 MiB | ~0.02% |
| eko-karta-zagreb (stdlib only) | ~16-21 MiB | ~0.02-0.03% |
| stampar-pelud (stdlib + bs4) | ~19-25 MiB | ~0.02% |
| wall-dashboard (nginx) | ~8 MiB | ~0% |
| docker-status (stdlib only) | ~13 MiB | ~0% |
| **Total** | **~88-100 MiB** | |

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
docker-compose.yml     # 5 services: the 3 data backends (built from sibling repos)
                        # + docker-status + dashboard
docker-status/
  Dockerfile            # python:3.12-alpine, zero pip dependencies
  server.py             # reads /var/run/docker.sock, serves GET /api/status
dashboard/
  Dockerfile            # nginx:alpine
  nginx.conf            # static file serving + /api/* reverse proxy
  frontend/
    index.html          # .page (statusbar + dashboard-grid): panel-dhmz | (panel-eko above panel-pollen)
    style.css            # shared reset, dark theme vars, page-level layout
    statusbar.css / statusbar.js # clock + per-container status dots (see docker-status)
    dhmz.css / dhmz.js   # ported from dhmz-weather-dashboard/frontend, namespaced under .panel-dhmz
    eko.css  / eko.js    # ported from eko-karta-zagreb-standalone/.../static, namespaced under .panel-eko
    pollen.css / pollen.js # ported from stampar-pelud-standalone/.../static, namespaced under .panel-pollen
    icons/               # copy of Stampar's pollen plant icon set
data/
  dhmz/                  # bind-mounted persisted state for the DHMZ backend (gitignored)
```
