# Unified wall dashboard

A single wall-mounted-tablet dashboard combining three independent, already-working
standalone apps into one page:

- **Left column**: [DHMZ standalone](../DHMZ%20standalone) — weather forecast + radar
- **Right column, top**: [Eko Karta Zagreb - standalone](../Eko%20Karta%20Zagreb%20-%20standalone) — current air-quality/weather sensor readings
- **Right column, bottom**: [Stampar Pelud - standalone](../Stampar%20Pelud%20-%20standalone) — pollen forecast

This repo does not duplicate any of the three apps' code. It's glue only:
a merged frontend (`dashboard/frontend/`) and an nginx reverse proxy, orchestrated by
one `docker-compose.yml` that builds the three backends straight from their own sibling
repos (must be checked out next to this one, exactly as they are on this machine).

## Architecture

```
┌──────────────────────────────────────────────┐
│                nginx (wall-dashboard)         │  :8090 → tablet browser
│  serves dashboard/frontend/ + reverse-proxies │
│  /api/dhmz/*, /api/eko/*, /api/pollen/*       │
└───────┬───────────────┬───────────────┬───────┘
        │               │               │
 dhmz-weather   eko-karta-zagreb   stampar-pelud
   :8000            :8080             :8080
 (FastAPI)      (stdlib http)      (stdlib http)
```

The three backends are **not** merged into one process/container — see
"Why not merge the backends?" below. Only nginx's port (`8090`) is published to the
host; the backends are reachable only from other containers on the compose network.

## Running it

Requires the three sibling repos to be checked out next to this one:

```
C:\Lang\DHMZ standalone\
C:\Lang\Eko Karta Zagreb - standalone\
C:\Lang\Stampar Pelud - standalone\
C:\Lang\my-unified-dashboard\        <- this repo
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

## Why not merge the backends into one process?

Measured with `docker stats` after a real fetch on each (Sept 2026):

| Container | RSS |
|---|---|
| dhmz-weather (FastAPI + uvicorn + lxml + Pillow) | ~50 MiB |
| eko-karta-zagreb (stdlib only) | ~16-18 MiB |
| stampar-pelud (stdlib + bs4) | ~19-21 MiB |
| wall-dashboard (nginx) | ~8 MiB |
| **Total** | **~92-97 MiB** |

Merging the three backends into one process would only save the duplicated
Python-interpreter baseline (roughly 20-30 MiB) — a small slice of a 1 GB Raspberry Pi
3B+'s budget — at the cost of losing independent operation/failure isolation and mixing
an async FastAPI app with two synchronous stdlib threaded servers in one codebase. Not
worth it; the current ~95 MiB total leaves plenty of headroom.

## Project layout

```
docker-compose.yml     # 4 services: the 3 backends (built from sibling repos) + dashboard
dashboard/
  Dockerfile            # nginx:alpine
  nginx.conf            # static file serving + /api/* reverse proxy
  frontend/
    index.html          # 2-column grid: panel-dhmz | (panel-eko above panel-pollen)
    style.css           # shared reset, dark theme vars, page-level grid
    dhmz.css / dhmz.js   # ported from DHMZ standalone/frontend, namespaced under .panel-dhmz
    eko.css  / eko.js    # ported from Eko Karta .../static, namespaced under .panel-eko
    pollen.css / pollen.js # ported from Stampar .../static, namespaced under .panel-pollen
    icons/               # copy of Stampar's pollen plant icon set
data/
  dhmz/                  # bind-mounted persisted state for the DHMZ backend (gitignored)
```
