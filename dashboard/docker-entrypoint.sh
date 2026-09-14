#!/bin/sh
# Generates the Basic Auth credentials nginx (and the dashboard's own JS)
# use for the /docker-api/ endpoints, from env vars - so no password ends
# up committed to the repo. Runs once at container start, before nginx.
set -e

: "${DOCKER_STATUS_USER:=dashboard}"
: "${DOCKER_STATUS_PASSWORD:=changeme}"
: "${DOCKER_SOCK_GID:=987}"

# nginx implements apr1-MD5 itself (not relying on the container's libc),
# so this is portable regardless of the base image's crypt() support.
HTPASSWD_HASH=$(openssl passwd -apr1 "$DOCKER_STATUS_PASSWORD")
echo "${DOCKER_STATUS_USER}:${HTPASSWD_HASH}" > /etc/nginx/.htpasswd

# Same credentials, base64'd, for the frontend JS to send itself - this is
# a home-LAN speed bump, not real security, so shipping it in a JS file
# the tablet's browser can read is an accepted tradeoff (see README).
AUTH_B64=$(printf '%s:%s' "$DOCKER_STATUS_USER" "$DOCKER_STATUS_PASSWORD" | openssl base64 -A)
cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.DOCKER_STATUS_AUTH = "Basic ${AUTH_B64}";
EOF

# nginx's master process starts as root (so docker-compose's group_add
# would only ever reach it), but the *workers* - which are what actually
# handle the /docker-api/ proxy_pass to the Docker socket - drop to the
# unprivileged "nginx" user via nginx's own `user nginx;` directive, and
# that drop resets supplementary groups to just nginx's own (confirmed by
# inspecting /proc/<worker-pid>/status - group_add alone does nothing
# here). So: add "nginx" to a real /etc/group entry for the socket's GID
# before nginx starts, and its own privilege-drop picks it up correctly.
EXISTING_GROUP=$(getent group "$DOCKER_SOCK_GID" | cut -d: -f1 || true)
if [ -z "$EXISTING_GROUP" ]; then
    addgroup -g "$DOCKER_SOCK_GID" dockersock
    EXISTING_GROUP=dockersock
fi
addgroup nginx "$EXISTING_GROUP"

exec nginx -g "daemon off;"
