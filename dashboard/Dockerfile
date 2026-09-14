# Static frontend + reverse proxy for the unified dashboard. nginx:alpine is
# the cheapest way to get both static file serving and a reverse proxy on a
# 1 GB Raspberry Pi (a few MB RSS, no interpreter to boot).
FROM nginx:alpine

# nginx links OpenSSL statically for TLS but doesn't ship the openssl CLI -
# needed once at container start (see docker-entrypoint.sh) to generate the
# Basic Auth password hash. Not a running process, so no RAM cost - just a
# few MB of disk in the image.
RUN apk add --no-cache openssl

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/ /usr/share/nginx/html/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
