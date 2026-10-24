#!/usr/bin/env bash
# Builds the image and checks the proxy against the fake API: the token is added (and a client's own replaced),
# cookies are dropped, routes outside /api/v1/labeling are refused. Synthetic token only.
set -euo pipefail
cd "$(dirname "$0")/.."
port=8789
FAKE_HOST=0.0.0.0 node test/fake-api.mjs "$port" >/dev/null 2>&1 & fake=$!
trap 'kill $fake; docker rm -f labeler-check >/dev/null 2>&1 || true' EXIT
docker build -q -t labeler-check . >/dev/null
docker run -d --name labeler-check -p 127.0.0.1:18091:8080 --add-host host.docker.internal:host-gateway \
  -e NYTKA_UPSTREAM="http://host.docker.internal:$port" -e NYTKA_LABELING_TOKEN=synthetic-check-token labeler-check >/dev/null
for _ in $(seq 1 50); do curl -fs http://127.0.0.1:18091/healthz >/dev/null && break; sleep 0.2; done

check() { [ "$2" = "$3" ] && echo "ok   $1" || { echo "FAIL $1: got $2, want $3"; exit 1; }; }
check "index" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18091/)" 200
check "tasks through the proxy" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18091/api/v1/labeling/tasks)" 200
check "other routes refused" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18091/api/v1/conversations)" 404
client_auth='Authorization: Bearer client-supplied' # gitleaks:allow (synthetic, must be replaced by the proxy)
curl -fs -X POST -H 'Content-Type: application/json' -H "$client_auth" -H 'Cookie: sso=x' \
  -d '{"clientId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","source":["me"]}' http://127.0.0.1:18091/api/v1/labeling/100 >/dev/null
seen=$(curl -fs "http://127.0.0.1:$port/__fake/posts")
check "token replaced" "$(node -e 'const p=JSON.parse(process.argv[1])[0];console.log(p.authorization)' "$seen")" "Bearer synthetic-check-token"
check "cookie dropped" "$(node -e 'const p=JSON.parse(process.argv[1])[0];console.log(p.cookie)' "$seen")" null
check "runs as non-root" "$(docker exec labeler-check id -u)" 65534
