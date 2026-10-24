# Labeling API, version 1

The contract between the Nytka server (`nytka-app/server`, migration `0052_labeling.sql`) and both clients: this web
app and `nytka-app/labeler-android`. The server owns the implementation; this file is what the clients rely on, and
`web/test/fake-api.ts` implements it for the tests.

Every route is under `/api/v1/labeling` and needs a token of scope `admin` or `labeling`. A `labeling` token
reaches nothing else. `/api/v1/info` lists `labeling` in `features` when the routes exist.

## Values

Axis values are fixed codes; new ones are appended, none is renamed (`taxonomyVersion` 1).

| Field | Values | Import-only |
|---|---|---|
| `source` (array, 1 or 2) | `me`, `not_me`, `live`, `device`, `call`, `none`, `cant_tell` | `in_room`, `not_in_room` |
| `deviceType` | `tv`, `phone`, `laptop`, `car`, `assistant`, `other` | |
| `content` | `speech`, `singing`, `vocal`, `music`, `other_sound`, `silence` | `not_speech` |
| `transcript` | `right`, `small_errors`, `wrong_words`, `made_up`, `cant_hear` | `partly` |
| `flags` (array) | `quiet`, `noisy`, `overlap`, `muffled`, `clipped`, `two_speakers` | |
| `language` | `uk`, `ru`, `en`, `mixed`, `other` | |
| `overlap` | `one`, `two`, `three_plus`, `cant_tell` (how many voices talk at once) | |

Tasks and the field each one asks (`ask`): `device` → `source`, `voice` → `source`, `quiet` → `transcript`,
`transcript` → `transcript` (with `correction`), `overlap` → `overlap`.

## Routes

### `GET /tasks`

`200 { tasks: [{ task, ask, open, labelled, goal, goalLabel, progress }] }`. `open`: items waiting; `goal` may be null;
`progress` counts the labels toward `goal` (for `device`, not-device lines).

### `GET /next?task=device&limit=30`

Leases up to `limit` (1 to 50, default 30) items of one task for 30 minutes and returns them. Calling again while a
lease is open returns the same items not yet answered. `task` is required; `task=mixed` returns items of every task
in runs of 3 to 5 of one task, never more than 4 in a row with the same `speakerKey` and never more than 3 from one
conversation.

```json
{
  "sessionId": "uuid",
  "leasedUntil": "2026-10-24T12:30:00Z",
  "items": [{
    "id": 123,
    "task": "device",
    "ask": "source",
    "reason": "uncertain",
    "conversationId": "uuid",
    "startedAt": "2026-10-20T09:15:02Z",
    "durationMs": 6400,
    "lines": [{ "segmentId": 4567, "text": "…", "isUser": false, "startMs": 0, "endMs": 6400 }],
    "contextBefore": [{ "segmentId": 4566, "text": "…", "isUser": true, "startMs": -2100, "endMs": -300 }],
    "contextAfter": [],
    "guess": { "model": "clap-head-1", "value": "device", "score": 0.71 },
    "prefill": { "language": "uk" },
    "peaks": [0.02, 0.4, "… 100 numbers, 0 to 1"],
    "speakerKey": "vg-17"
  }]
}
```

`reason` is `uncertain`, `random`, `disagree`, `repeat` or `top`. `guess` may be null. `startMs`/`endMs` are relative
to the clip without context. Optional: `contextBefore`/`contextAfter` (up to 2 lines each that overlap the 4-s
context window, negative times before the clip), `peaks` (100 numbers for the waveform, null when the audio was
gone), `speakerKey` (opaque: a voice group id, else the provider label, else null).

### `GET /{id}/clip?context=0`

`audio/ogg` (Opus), the item's span plus `context` seconds either side (0 to 4), at most 20 s. Range requests work.
`404` when the audio is gone. Clients send the token in the `Authorization` header, never in the URL.

### `POST /{id}`

```json
{
  "clientId": "uuid",
  "source": ["device"], "deviceType": "tv",
  "content": "speech", "transcript": "right", "flags": ["noisy"],
  "language": "uk", "personId": null, "correction": null, "overlap": null,
  "linesDiffer": false, "skipped": false, "listenedMs": 5200, "answeredWith": "swipe"
}
```

`answeredWith` (optional): `swipe`, `button`, `sheet` or `key`, stored and returned by `GET /labels`. `skipped: true`
answers `{ labelId: null, superseded: null }`. Limits: `correction` at most 2000 characters, `listenedMs` 0 to 600000. Every axis field is optional; at least one of them or `skipped: true` is required. `correction` is the whole
corrected text of the item's single line (an item with several lines takes no correction). `skipped: true` returns the item to the queue and stores
nothing else. `200 { labelId, superseded }`; the same `clientId` again returns the first answer's `labelId` and
changes nothing. A new answer on an item answered before supersedes the old label (`superseded`: its id). `400`
names the bad field: `{ "field": "source", "error": "unknown value" }`. `404` unknown item. An answer
is accepted after its lease lapses or from another session; there is no `409`.

### `DELETE /labels/{labelId}`

Deletes the label, its kept clip, and clears any mark it set. `204`.

### `GET /labels?since=&task=&limit=`

`{ items: [{ labelId, itemId, task, segmentIds, conversationId, startedAt, durationMs, source, deviceType, content,
transcript, flags, language, personId, correction, overlap, answeredWith, provenance, createdAt }], nextSince }`. No audio.

### `GET /voice/pending` and `POST /voice/confirm`

`me` labels mark the line (`is_user_manual`) but do not feed the voiceprint until confirmed.
`GET /voice/pending` → `{ items: [{ labelId, segmentId, durationMs }] }`; `POST /voice/confirm { labelIds }` →
`{ learned }` feeds those lines to the voiceprint.

### `POST /import`

`{ provenance: "import:device-1", items: [{ segmentIds, source?, content?, transcript?, flags? }] }` →
`{ imported, skipped }`. Imports never write through to marks.

## Write-through

`source` sets the segment's marks: `me` → `is_user_manual` true (no voiceprint until confirmed), `not_me` →
`is_user_manual` false, `live` → speech
`person`, `device` → speech `media` (until a `device` kind exists), `call` → speech `call`. `none` and `cant_tell`
set nothing. Each mark records the label that set it; deleting or superseding the label clears or changes it.
