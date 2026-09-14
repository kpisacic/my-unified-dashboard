# Minimal-footprint image: pure Python standard library, no pip dependencies.
FROM python:3.12-alpine

WORKDIR /app
COPY server.py .

# Runs as a normal (non-root) user, given supplementary membership in a
# group matching the host's /var/run/docker.sock GID via docker-compose's
# group_add - enough to read the socket, nothing more.
RUN addgroup -S status && adduser -S status -G status
USER status

ENV PORT=8080 \
    PYTHONUNBUFFERED=1

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["python", "server.py"]
