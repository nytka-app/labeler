# Nytka labeler: rules for agents

A static web app (no build step, plain ES modules in `web/`) and a Caddy image that serves it and forwards
`/api/v1/labeling/*` to the Nytka server with its own token. The API contract is `docs/api.md`; the server
implements it (`nytka-app/server`, migration `0052_labeling.sql`), `test/fake-api.mjs` fakes it. The Android
client is `nytka-app/labeler-android`. Design and the taxonomy: `DESIGN.md`.

## Commands

```bash
npm ci
npx playwright install chromium-headless-shell
npx playwright test          # every answer saves, offline, retries, voice confirm, axe; desktop and phone
./test/container.sh          # the image's proxy: token added, cookies dropped, other routes refused (needs Docker)
npm run dev                  # the app on the fake API at http://127.0.0.1:8787/
node test/screenshots.mjs    # README screenshots
```

## Invariants

1. **Real audio, transcripts and labels never enter this repository.** Fixtures are synthetic tones and invented
   lines (`test/fake-api.mjs`).
2. **An answer is saved only after the server's 200.** It waits in the IndexedDB outbox (`web/outbox.js`) with a
   `clientId` until then; delivery is at least once, the server dedupes by `clientId`.
3. **Button handlers capture their value in a closure** (`choice()` in `web/app.js`); never read a value back
   from the element, never inline `onclick`. An earlier labelling page lost every label that way.
4. **Every button is covered by `test/answers.spec.mjs`**, which checks the bodies the fake server received. A new
   value or button gets a line there in the same change.
5. **The browser holds no token.** The proxy adds it (`deploy/Caddyfile`); only `/api/v1/labeling/*` is forwarded.
6. **Clips never reach a disk cache**: blob URLs in memory, `no-store`, the service worker skips `/api/`.
7. **Taxonomy codes are stable**: append values, never rename (`web/taxonomy.js`, `docs/api.md`).
