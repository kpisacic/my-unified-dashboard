"""Tiny read-only Docker container-status service for the wall dashboard.

Reads a small, explicit list of container names from the Docker Engine API
over /var/run/docker.sock (the same API the docker CLI and tools like
Portainer use) and serves back only a name and a traffic-light color per
container - nothing else about the container (env vars, mounts, image, ...)
ever leaves this process. That's the whole point of this being its own tiny
service rather than proxying the Docker socket straight through nginx to
the browser: the browser gets a name and a color, never raw Docker API
access.

Pure standard library, zero dependencies - same pattern as the other
backends in this stack.
"""
from __future__ import annotations

import json
import logging
import os
import socket
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("docker-status")

DOCKER_SOCKET = os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
PORT = int(os.environ.get("PORT", "8080"))
REQUEST_TIMEOUT = float(os.environ.get("DOCKER_TIMEOUT_SECONDS", "3"))
MONITORED_CONTAINERS = [
    name.strip() for name in os.environ.get("MONITORED_CONTAINERS", "").split(",") if name.strip()
]


def _dechunk(data: bytes) -> bytes:
    """Undo HTTP chunked transfer-encoding - dockerd always uses it."""
    out = bytearray()
    while data:
        size_line, _, rest = data.partition(b"\r\n")
        try:
            size = int(size_line.strip(), 16)
        except ValueError:
            break
        if size == 0:
            break
        out += rest[:size]
        data = rest[size + 2:]  # skip the chunk's trailing \r\n
    return bytes(out)


def _docker_api_get(path: str) -> tuple[int, "dict | None"]:
    """GET a path from the Docker Engine API over its Unix socket.

    Speaks raw HTTP/1.1 rather than pulling in a dependency just to talk to
    one local Unix socket for a single GET request.
    """
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(REQUEST_TIMEOUT)
    chunks: list[bytes] = []
    try:
        sock.connect(DOCKER_SOCKET)
        request = f"GET {path} HTTP/1.1\r\nHost: docker\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        sock.sendall(request.encode("ascii"))
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        sock.close()

    raw = b"".join(chunks)
    head, _, body = raw.partition(b"\r\n\r\n")
    status_line = head.split(b"\r\n", 1)[0]
    status_code = int(status_line.split(b" ", 2)[1])

    if b"transfer-encoding: chunked" in head.lower():
        body = _dechunk(body)

    try:
        payload = json.loads(body) if body else None
    except json.JSONDecodeError:
        payload = None
    return status_code, payload


def container_color(name: str) -> dict:
    """Inspect one container and map its state/health to a status color."""
    try:
        status_code, info = _docker_api_get(f"/containers/{name}/json")
    except (OSError, socket.timeout) as err:
        log.warning("Could not reach Docker socket for %r: %s", name, err)
        return {"name": name, "state": None, "health": None, "color": "gray"}

    if status_code == 404 or info is None:
        log.warning("Container %r not found (HTTP %s)", name, status_code)
        return {"name": name, "state": None, "health": None, "color": "gray"}

    state_block = info.get("State") or {}
    state = state_block.get("Status")  # running/exited/restarting/paused/created/dead
    health = (state_block.get("Health") or {}).get("Status")  # starting/healthy/unhealthy

    if state == "running":
        if health == "unhealthy":
            color = "light-green"
        elif health == "starting":
            color = "yellow"
        else:  # "healthy", or no healthcheck configured at all
            color = "green"
    elif state == "restarting":
        color = "yellow"
    elif state in ("exited", "dead", "paused"):
        color = "red"
    else:  # "created" or anything unrecognized
        color = "gray"

    return {"name": name, "state": state, "health": health, "color": color}


class Handler(BaseHTTPRequestHandler):
    server_version = "DockerStatus/1.0"

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib signature
        log.info("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - stdlib signature
        if self.path == "/api/status":
            containers = [container_color(name) for name in MONITORED_CONTAINERS]
            return self._send_json(HTTPStatus.OK, {"containers": containers})
        if self.path == "/api/health":
            return self._send_json(HTTPStatus.OK, {"status": "ok"})
        return self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})


def main() -> None:
    if not MONITORED_CONTAINERS:
        log.warning("MONITORED_CONTAINERS is empty - /api/status will always return an empty list")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log.info("docker-status listening on port %s, watching: %s", PORT, ", ".join(MONITORED_CONTAINERS))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
