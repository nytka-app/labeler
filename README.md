# Nytka labeler

> Hear a short clip from your Nytka recordings and tap what kind of audio it is, so Nytka's models learn from your ear.

<p align="center">
  <img src="docs/img/tasks-dark.png" alt="Task list: device audio, my voice, quiet audio, transcript, several voices" width="260">
  <img src="docs/img/card-dark.png" alt="A clip card: play, the line's text, and the answers Me, Live person, Device, Call" width="260">
</p>

## Why

[Nytka](https://github.com/nytka-app/server) is a self-hosted second brain: a pendant records the day, the server
transcribes it and pulls out conversations, people and tasks. Some of what the pendant hears is not a person in the
room: a TV, a laptop, the far side of a call on speaker. Some lines are too quiet to trust, and some voices are
the owner's own but scored as someone else's. My ear tells these apart in a second; the models need labelled
examples to learn the same. Earlier rounds of labelling on throwaway pages already moved real settings, and one
such page lost every label to a button bug. This app makes labelling a habit with a test behind every button.

## What it does

- Short sessions of about 30 clips, picked by the server where its models are least sure, plus a random slice so
  rates stay honest.
- One question per clip, with big buttons and keys 1–7: where the voice comes from (me, a live person, a device,
  a call, no voice), whether the transcript is right, or how many voices talk at once. Optional details below:
  device type, kind of sound, quality flags, language, a corrected transcript.
- Answers wait in the browser until the server confirms them, so a reload or a dropped connection loses nothing.
- Lines marked "me" teach the voiceprint only after a separate confirmation, because that cannot be undone.
- Clips and labels stay on the Nytka server. This repository holds code only; its tests use synthetic tones.

The taxonomy, what each label is for, how the server picks clips, and the privacy rules: [DESIGN.md](DESIGN.md).
The API both clients use: [docs/api.md](docs/api.md). The Android client:
[nytka-app/labeler-android](https://github.com/nytka-app/labeler-android).

## Quick start

Run it against the fake API (synthetic clips, nothing leaves your machine):

```bash
npm ci
npm run dev        # open http://127.0.0.1:8787/
```

Run the image in front of a Nytka server that has the labeling routes:

```bash
docker run -p 8080:8080 \
  -e NYTKA_UPSTREAM=http://nytka:8080 \
  -e NYTKA_LABELING_TOKEN="$(cat token-file)" \
  ghcr.io/nytka-app/labeler:latest
```

Put an SSO proxy in front of it: the container adds the token itself, so whoever reaches it can label.

## How it works

```mermaid
flowchart LR
  B[Browser or phone] -->|SSO| P[SSO proxy]
  P --> C[Labeler container: static app + Caddy]
  C -->|/api/v1/labeling only, adds token| S[Nytka server]
  S --> D[(Postgres: clips, labels)]
```

The page is plain JavaScript with no build step. Caddy serves it and forwards only `/api/v1/labeling/*`, replacing
any token the browser sends with its own and dropping the proxy's cookies. Every other server route answers 404
from the container.

## License

Apache-2.0. See [LICENSE](LICENSE).
