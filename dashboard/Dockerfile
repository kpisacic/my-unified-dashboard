# Static frontend + reverse proxy for the unified dashboard. nginx:alpine is
# the cheapest way to get both static file serving and a reverse proxy on a
# 1 GB Raspberry Pi (a few MB RSS, no interpreter to boot).
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/ /usr/share/nginx/html/
