# The labeler: static files and a Caddy proxy (deploy/Caddyfile). Needs NYTKA_LABELING_TOKEN; NYTKA_UPSTREAM
# defaults to http://nytka:8080.
FROM caddy:2.10-alpine

ARG VERSION=dev
ENV XDG_CONFIG_HOME=/tmp/caddy XDG_DATA_HOME=/tmp/caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY web/ /srv/
RUN sed -i "s/labeler-v1/labeler-${VERSION}/" /srv/sw.js

USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
