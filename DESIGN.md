# Nytka labeler: design

Status: approved by the owner 2026-10-24 with the changes under "Decisions". Repos: `nytka-app/labeler` (web) and `nytka-app/labeler-android` (Kotlin).

## Summary

A small web app (PWA, works on phone and desktop) where the owner hears a clip and taps what kind of audio it is.
The server picks the clips its models are least sure about, about 30 per 5-minute session. Labels and kept clips
live in the Nytka server's Postgres; the repo holds code only. The app is served by a tiny Caddy container on the
box behind Pangolin SSO, which forwards only the labelling routes to the server with its own token.

The proposal's four flat axes change in three ways, each argued below:

1. **Source is a tree, not a list.** Old labels say "other" or "person" without saying which kind, so the taxonomy
   needs coarse nodes (`not_me`, `in_room`) that imports may use and the buttons never show. Nothing is lost.
2. **"Transcript wrong" leaves Quality and becomes its own axis**, because it is the axis the quiet gate and the
   ASR work need, and it has four values the quiet check already used.
3. **Every clip asks one question.** The server says which axis it is unsure about; that axis gets the big buttons,
   the others sit below, prefilled with the models' guesses, optional. Four axes on every clip cannot fit 30 clips
   into 5 minutes (10 s per clip, and the clip itself lasts up to 10 s).

## 1. Taxonomy

### Unit

An **item** is one line (segment), or one server stretch (consecutive non-wearer lines, gaps under 4 s, at most
10 s: `Stretches.cs`, the unit of every device label so far). A stretch label is written to each of its lines;
"Lines differ" on the card splits it into per-line answers. A **scene** is a time range of a conversation.

| Axis | Applies to | Select | Asked when |
|---|---|---|---|
| Source | line | one (or "Several" → up to 2) | device and wearer tasks |
| Content | line | one | quiet task |
| Transcript | line | one | quiet and transcript tasks |
| Quality flags | line | any | optional on every card |
| Language | line | one | optional; prefilled from the script |
| Who | line | one Person | optional; only when Source = live |
| Correction | line | text | when Transcript = wrong words |
| Energy | line, wearer only | 1-5 | energy task (emotion gate) |
| Scene | conversation range | one | later mode, not v1 |
| Salience | conversation | one | later mode, not v1 |

### Source (who or what made the voice)

```
voice
├─ in_room            (server `person`)
│   ├─ me
│   └─ live           a person physically near
├─ not_in_room
│   ├─ device         TV, laptop, phone speaker, car, radio, music with vocals (server `media`)
│   │   └─ synthetic  voice assistant, TTS   (sub-chip after Device, optional)
│   └─ call           far side of a call on a loudspeaker (server `call`)
├─ not_me             import-only: "other" from wearer labels
none                  no voice at all
cant_tell
```

Buttons: **Me · Live person · Device · Call · No voice · Can't tell · Several** (7). Device reveals an optional
device-type row (TV, phone, laptop, car, assistant, other). Several reveals the four voice chips for up to two picks
(the old wearer `mixed`: me and someone else in one line).

Synthetic is a sub-type of device, not a peer: it always comes out of a speaker, and for every consumer (detector,
extraction rules) it behaves like device. As a peer it would cost a button for something rare.

### Content (what the sound is)

**Speech · Singing · Vocal sounds** (laughter, crying, sighs, coughs) **· Music · Other sound** (traffic, kitchen,
crowd, rubbing) **· Silence** (6). Import-only node `not_speech` for the quiet set's "can't hear speech".

Music under speech is not a Content value: it is the quality flag "background". One choice per line keeps it one tap.

### Transcript (the text against the audio)

**Right · Small errors · Wrong words · Made up · Can't hear** (5). "Wrong words" opens the correction field
(prefilled with the text, so a fix is an edit, not typing from scratch). "Made up" = text where no such speech
exists (the hallucination case).

### Quality flags (any number, optional)

**Quiet or far · Noisy background · Overlapping voices · Muffled** (pendant under clothes) **· Clipped ·
Two speakers in one line** (6). The last one is a diarization error (the old `mixed`), not overlap; the overlap
detector and the line-splitting work need them apart.

### Language

uk · ru · en · mixed · other; prefilled from the line's script and the ASR language when it has one.

### Scene (later mode)

Conversation · Monologue or thinking aloud · Call or meeting · Group, several talking ("action") · Media
(watching, listening) · Transit or public · Alone, quiet (7). Labelled on a conversation timeline as ranges, not per
clip: a scene lasts minutes, and asking it on every 10-s clip repeats the same answer 20 times. Its only consumer
today is salience and summaries, so it waits until those ask for it.

### Old labels on the new axes

Every old label maps to a node; coarse nodes keep exactly what was known. Imports carry `provenance` so an
evaluation can include or leave them out.

| Set | Count | Old value → new |
|---|---|---|
| Wearer regression set (`research` branch `wearer-regression-set`, `audio/wearer-eval/labels.json`) | 109 lines (106 segments): me 30, other 52, unsure 22, mixed 5 | me → `me`; other → `not_me`; unsure → `cant_tell`; mixed → Source {me, not_me} + flag "two speakers in one line" |
| Device round 1 (`labelset`) | 59: live 24, me 16, device 11, cant 8 | live → `live`, me → `me`, device → `device`, cant → `cant_tell` |
| Device round 2 (`labelset2`) | 60: device 29, me 15, live 10, cant 6 | same |
| Device round 3 (`labelset3`, :18745) | **not labelled yet** (no `labels.jsonl`) | label it in the new app: import its `sample.json` as a queue, not as labels |
| Quiet-text check (`quietset`) | 30: matches 13, made_up 7, no_speech 5, partly 5 | matches → Transcript `right`; partly → `partly`, an import-only node above `small_errors` and `wrong_words` (UNKNOWN which each one was); made_up → `made_up`; no_speech → Transcript `cant_hear` + Content `not_speech` |
| Non-human audio study (server `docs/research/non-human-audio-report.md`) | 140 clips: person 109, media 27, call 0, can't tell 4, "both audible" 0 | person here → `in_room`; media → `device`; call → `call`; can't tell → `cant_tell`; both audible → Several. UNKNOWN whether those labels still exist on the box: the report says they never left it |
| Server marks: `speech_manual`, `is_user_manual`, accepted/rejected `speech` review items | live data | speech person → `in_room`; media → `device`; call → `call`; is_user_manual true → `me`, false → `not_me` |
| Server guesses: `person`, `media`, `call`, `unsure` | not labels | stored as the item's `guess`, never as a label |
| Planned device kind | | none: the device report recommends reusing `media`, so `device` maps onto it |

## 2. What the data is for, ranked

Ranked by the decision a label unlocks, times how short of labels that decision is.

1. **Device detector (CLAP head, research Q1).** Ship gate: 30 device and 100 live-or-me lines with at most one
   live or own-voice line above threshold. Now 39 device, 61 not-device. About 40 more negatives turn it from shadow
   into a shipped exclusion. Source axis.
2. **Wearer voice evaluation and drift.** The same Source taps feed it: every `me` or not-me label grows the 109-line
   regression set. The owner's own voice is also the detector's worst false alarm (12 of 55 non-wearer-verdict lines
   were the owner), so 1 and 2 are one stream of labels. A monthly slice of fresh labels shows drift (a new
   microphone, a cold, a different pendant position).
3. **Regression sets on every model change.** Falls out of 1, 2 and 4 at no extra cost: labels are split by
   conversation into a frozen `eval` part and a `train` part; every model change is scored on `eval` (as
   `score.py` does now). Cheap and catches regressions, so it ranks high.
4. **Quiet-audio gate and hallucinations.** 7 of 30 quiet lines were made up. Content + Transcript axes. Medium:
   quiet audio is only 0.6% of speech time, but made-up text becomes false facts and tasks.
5. **Transcript corrections.** First as a word-error-rate evaluation set per language (the `asr` gold-set helper
   already exists), later as fine-tune data for Parakeet. Fine-tuning needs hours of corrected audio; at a few
   corrected lines a day that is a year away, so treat corrections as evaluation first and do not plan the GPU pilot
   around them.
6. **Overlap ("action") detection.** 4.1% of speech time (Sortformer sample). One flag, so cheap to collect while
   doing 1-4; a dedicated task only if a detector gets built.
7. **Name spellings.** Collected through corrections (a name fixed in a line) and the existing name-spelling spec;
   no task of their own.
8. **Salience for Today.** Different unit (a conversation) and a different question; a later mode once Today ranks
   by salience (`0042_salience.sql`).

My additions:

- **An unbiased random slice in every session (20%).** Active learning picks the hard cases, so its labels say
  nothing about how common device audio is (10% so far, 95% interval 3-30%). The random slice keeps prevalence and
  precision estimates honest.
- **Repeats for self-agreement (5%).** A clip heard again weeks later measures the owner's own consistency, the
  ceiling for any model. If the owner agrees with themself 90% of the time, a model at 92% is overfitting.
- **Energy rating for the emotion gate.** The device report's recommendation: rate 40 own clips for energy, go on
  with arousal only if Spearman ≥ 0.4. A 5-step row on wearer clips, a task of its own.
- **Language per line.** Per-language error rates, and the report's English-vs-Cyrillic arousal difference.
- **Phone context ranges checked against labels.** 275 "media on the loudspeaker" ranges so far; labels say how
  often such a range really means device audio, and so how much the provisional +1.0 prior is worth.

## 3. Active learning

The app asks; the server picks. Each **task** has a candidate source and an uncertainty score:

| Task | Asks | Candidates | Uncertain means |
|---|---|---|---|
| `device` | Source | non-wearer stretches with audio still held | CLAP head score nearest its threshold; YAMNet speech score as fallback until the head is shadowed |
| `wearer` | Source | lines with a voice similarity | `voice_similarity` nearest `voice.userThreshold` (0.34) |
| `quiet` | Transcript (+ Content) | lines under a level, or where the second ASR engine disagrees | lowest level, highest disagreement; needs per-line level (quality metrics, UNKNOWN until that lands) |
| `transcript` | Transcript, correction | lines with low ASR confidence or engine disagreement | lowest confidence |
| `energy` | Energy | wearer lines, spread over days | none: random, 40 to start |

**Mix per session of 30:** 60% uncertain, 20% random, 10% models disagree (device head vs YAMNet guess, a phone
range vs the guess, voice verdict vs provider label), 5% repeats, 5% the head's highest scores (precision check).

**Spread:** at most 3 items per conversation per session, oldest held audio first among equals, so labels reach the
clips before `audio.retentionDays` (14) deletes them.

**Refresh:** a scheduler job fills `labeling_items` per task (cheap: it reads stored scores; nothing is recomputed
for the app). `GET /next` leases 30 items for 30 minutes, so two open tabs never get the same clip, and a lease
that lapses returns them to the queue.

**Progress the owner sees:** "12 of 30" in the session; on the end screen what it moved: "device detector: 72 of
100 not-device lines toward the ship gate".

**Retraining stays outside the server.** The head is refitted on the owner's Mac from exported labels (as today),
and its coefficients go back as a `speech_version` bump. The app only collects.

## 4. Shape: recommendation

**A static PWA in `nytka-app/labeler`, served by a Caddy container on the box at
its own host behind Pangolin SSO, with no ACCEPT bypass.** Caddy serves the files and proxies
only `/api/v1/labeling/*` to `nytka:8080` on `edge`, adding `Authorization: Bearer` from a dedicated named admin
token (box secret, `scripts/secret.sh`).

Why:

- **The browser holds no token.** SSO is the person gate, the named token the service gate, and the proxy's route
  whitelist limits the token to labelling. Revoking it touches nothing else.
- **Same origin**, so no CORS change on the server and no token in a URL (today a query token is refused unless
  it is `read`; clips are fetched with a header, turned into blob URLs).
- **Separate repo, separate release.** The server image stays as it is; the app ships by bumping one tag.
- **Desktop keyboard is the fast path** (1-7 answer, Space replay, C context, Enter next, U undo), the phone the
  convenient one (big buttons, swipe). Android in the existing app would give only the phone, and its release
  cycle is slower.

Rejected: the server serving the app (couples releases, puts UI code in the public server repo and needs static
file hosting it does not have); an Android screen (phone only); a Mac-local page like the earlier ones (audio leaves
the box to the Mac, and the pages died with their sessions).

**Offline: no, but tolerant of a flaky phone link.** At session start the app fetches all 30 clips into memory
(about 80 KB each, 2.4 MB). Labels go to an IndexedDB outbox with a client id and are retried until the server
answers 200; a card shows a tick only after that 200. The service worker caches the app shell only; clips are
`Cache-Control: no-store` and never touch disk in the browser.

Stack: TypeScript, Vite, no framework (one screen, five components), Playwright tests against a fake API serving
synthetic tones.

**Every button saves, by test.** One Playwright test taps every button of every axis and checks the POST body
the fake server received; a second reloads mid-session and checks the outbox drains. Buttons get handlers through
`addEventListener` with values from `data-` attributes, never inline `onclick` (the bug that lost an earlier page's
labels).

## 5. Privacy

- **Bystanders.** Other people's voices are kept only as labelled clips of at most 20 s, and only because the
  owner labelled them. The label app shows no names of strangers; Who links only existing People.
- **The dataset stays on the box.** Labels, corrections and kept clips sit in the server's Postgres, in the backup
  the server already has. The repo, CI and test fixtures hold synthetic tones and invented text only.
- **Export is for the owner's own training runs.** `GET /labels` gives labels without audio; an admin-only export
  with clips streams to the owner's Mac. A rented GPU (the Parakeet pilot) is a third party: an export for it is a
  separate, explicit step that by default holds only the owner's own voice (`me`) and is deleted after the run.
- **Deletion.** Deleting a label deletes its kept clip and clears any mark it set. Forgetting a Person deletes their kept clips and nulls
  `person_id` on labels. Deleting a conversation cascades to its items, labels and clips. A "Delete all labelling
  data" admin route exists and the app has the button, behind a typed confirmation.
- **Retention: a privacy change that needs the owner's explicit OK.** The specs promise audio goes with
  `audio.retentionDays` (14), and kept clips would hold other people's voices longer than that. So it is a setting,
  `labeling.keepClips`, **default off**: off, a clip dies with its audio and only the label, the CLAP embedding
  (512 numbers, not playable) and the scores stay. On, clips are kept `labeling.clipRetentionDays` (proposed 365),
  then reduced to the embedding. README's "What it stores" gains a line either way. Recommendation: turn it on for
  `me` clips only (the owner's own voice, for wearer and ASR work) and keep bystanders' clips off.

## 6. Server work (owned by the server session)

Agreed with "Nytka redesign: server steps 1-7" on 2026-10-24: migration **`0052_labeling.sql`** (0044-0050 are its own, 0051 quality metrics). No clash with its queue. The `quiet` task reads the per-batch `audio_level` (dBFS) that 0047 stores instead of computing its own. The CLAP shadow score column is in nobody's queue yet; whoever adds it coordinates with this app.

**Tables (one migration):**

- `labeling_items`: id, task, conversation_id, segment_ids bigint[], started_at, ended_at, reason
  (`uncertain`, `random`, `disagree`, `repeat`, `top`), guess (model, value, score), leased_until, created_at.
- `labels`: id, item_id null, conversation_id, segment_ids, started_at, ended_at, source text[], content,
  transcript, flags text[], language, person_id null, correction null, energy null, taxonomy_version, provenance
  (`app`, `import:wearer-a`, `import:device-1`, ...), client_id unique, created_at, superseded_by null.
  Append-only: a new answer on the same lines supersedes the old one.
- `label_clips`: label_id, body bytea null (Ogg Opus, only while `labeling.keepClips` allows), embedding real[] null
  (CLAP, 512), created_at.

**Routes** (admin; under `/api/v1/labeling`):

| Route | Effect |
|---|---|
| `GET /tasks` | each task with open items, labels and its goal |
| `GET /next?task=&limit=30` | leases a session of items with lines, guesses, reason and the axis to ask |
| `GET /{id}/clip?context=0..4` | `audio/ogg`, at most 20 s, cut as review clips are (`CardClip.Cut`); 404 when audio is gone |
| `POST /{id}` | stores a label `{clientId, source, content, transcript, flags, language, personId, correction, energy}`; same clientId = no-op; keeps the clip |
| `DELETE /labels/{id}` | deletes a label and its clip |
| `GET /labels?since=&task=` | labels without audio, for scoring and training |
| `POST /import` | old label sets by segment id with provenance |
| `DELETE /all` | everything labelling holds |

**Write-through (the server session agrees in principle):** a Source answer also sets the segment's existing
mark (`me` → `is_user_manual` true, `live` → speech `person`, `device` → `media`, `call` → `call`), so the owner never
fixes the same line twice. Three rules come with it:

- **`labels` is the record of truth, marks are a derived copy.** Each mark records the label that set it; deleting
  or superseding the label clears or changes that mark.
- **A `me` label teaches the voiceprint, and that cannot be undone.** `MarkAsync` folds a fingerprinted line of 2 s or
  more into the running mean, so a wrong "me" tap shifts the voiceprint for good. Write-through for `me` therefore only
  happens on a clear, unflagged answer, never on Several or on an import.
- **Score the model, never the rule, on labelled lines.** Once a label is a mark, the rule's result equals the label,
  so regression sets and quality metrics read the model's own verdict (`voice_is_user`, `speech_guess`) on those
  lines. The quality-metrics session has been told.
- **No `device` kind yet.** It is queued behind the CLAP shadow model, so until then `device` writes through as
  `media`; the label keeps `device`.

## 7. The feed (proposed 2026-10-24, not built)

The owner asked for a Reels/TikTok feel. The labelling screen becomes a vertical feed in both clients: one clip per
full screen, it plays on arrival, swipe up for the next. What changes from the desk's sketch, and why, is marked
**Changed**.

### Gestures

| Gesture | Web (keyboard) | Effect |
|---|---|---|
| Swipe right | → | **Yes** to the clip's question |
| Swipe left | ← | **No**: one-tap sheet of the remaining answers, or a coarse "no" where the taxonomy has one |
| Swipe up | ↓ or J | Skip to the next clip, no answer (an explicit skip, sent as `skipped`) |
| Swipe down | ↑ or K | Back to the previous clip; answering it again supersedes the old label |
| Tap the card | Space | Replay from the start |
| Long-press | 1–7 | The full answer sheet (every value of the axis, plus optional details) |
| Undo toast, 4 s | U | Takes the last answer back before it is sent |

Each task asks one **fixed yes/no question**, so left and right always mean the same thing within a task:

| Task | Question | Right | Left |
|---|---|---|---|
| `voice` | "Is this you?" | `me` | `not_me` (coarse node, already in the taxonomy); sheet optional |
| `device` | "Is it coming from a device?" | `device` | sheet: Me · Live person · Call · No voice · Can't tell |
| `quiet`, `transcript` | "Is the text right?" | `right` | sheet: Small errors · Wrong words (opens the correction) · Made up · Can't hear |
| `overlap` | "Several voices at once?" | sheet: Two · Three or more | `one` |

**Changed: no double-tap for the most likely answer, and the model's guess is hidden until after the answer.** A
one-gesture "accept the model" teaches the model its own guesses; the labels become an echo, and the evaluation of
that model is void. The question is fixed per task, never "Is this {guess}?", for the same reason. After the answer,
the card flashes the model's guess for half a second ("model said: device, 0.71"), which keeps the feedback without
anchoring the ear.

**Changed: a left swipe on `device` opens a sheet instead of saving "not device".** "Me" versus "live person" is the
detector's worst false alarm (the owner's own voice), so a plain "no" would lose the one distinction that matters
most. It costs one extra tap only on a "no".

Every gesture also has a visible button in a slim rail at the bottom (Yes, No, Skip, More), for screen readers,
switch control and anyone who does not swipe. The every-answer tests drive both the gestures and the rail.

### The card

- A large waveform of the clip, filled as it plays. Peaks come from the server (`peaks`: 100 numbers per item, a new
  optional field), so both clients draw the same thing without decoding Opus; the web falls back to decoding the
  blob when the field is missing.
- **Changed: captions per line, not per word.** The items carry line timings (`startMs`, `endMs`) but no word
  timings, so the line being spoken is highlighted and the others fade. Word-level captions wait until the server
  stores word timestamps (UNKNOWN whether the transcription adapter returns them).
- The asked line is bright; context lines are dimmed above and below.
- The question sits at the bottom, above the rail; the task name and "12 of 30" at the top.
- Haptic tick on each answer (Android: `HapticFeedbackType.Confirm`/`Reject`; web: `navigator.vibrate(10)` where
  supported, nothing on iOS).

### Pace

- Every clip of the session is already fetched before the first card (both clients do this today), so swipes never
  wait. The next clip is decoded and its waveform drawn while the current one plays.
- An answer goes to the outbox at once with a send time 4 s ahead; Undo inside that window removes it, after it the
  outbox sends it. A reload inside the window still sends it (the outbox is persistent).

### Session and progress

- Daily goal: 30 clips, about 5 minutes. A progress ring at the top fills per answer.
- **Changed: "days labelled this week" instead of a streak.** A streak that breaks is loss aversion, the core of the
  dark patterns the desk ruled out. A week strip shows the days with a session, and nothing is lost by missing one.
  The reminder stays at most one notification a day, and only when uncertain clips wait.
- At the goal the feed **ends**: an end card, no further clips, no autoplay of a next session. "Another 30" is a
  button.
- **Changed: the end card reports what the server can honestly say.** "Device detector +2% sure" needs a retrain
  that happens on the owner's machine, not per session. The card shows, from `/tasks` before and after: progress
  toward each gate ("device detector: 72 → 81 of 100 not-device lines needed to ship"), how many answers disagreed
  with the model ("9 of 30, the most useful ones"), and answers still sending.

### Feed order

- A new `task=mixed` on `/next`: the server interleaves tasks.
- **Changed: in runs of 3 to 5 clips of one task, not every clip a different question.** Switching the question on
  every swipe slows each answer and raises errors (task switching); a short run keeps the rhythm and still varies.
  The task name animates in at each switch.
- Never the same speaker more than 4 in a row: items carry `speakerKey` (the voice group or provider label, opaque),
  and the server orders by it. Never more than 3 from one conversation (already a rule).

### Sound and privacy

- **Android:** autoplay with sound only when headphones or a Bluetooth headset are connected. On the loudspeaker,
  each clip waits for a tap and the card shows "Tap to play (speaker)": other people's voices should not play out
  loud in public by surprise. A switch in settings turns speaker autoplay on.
- **Web:** browsers already refuse sound before the first tap, so the feed opens on "Start with sound". It pauses
  when the tab is hidden (`visibilitychange`) and does not resume until the owner taps; it never plays in a
  background tab. Browsers do not tell a page whether headphones are connected, so the web cannot apply the
  Android rule.
- Captions show transcript text on screen; nothing else changes about where data lives.

### Contract additions (server session to agree)

- `GET /next?task=mixed`: items of every task, in runs of 3 to 5, speaker rule above.
- Item fields, optional: `peaks` (100 numbers, 0 to 1), `speakerKey` (opaque string).
- `POST /{id}` gains optional `answeredWith` (`swipe`, `button`, `sheet`, `key`): lets the evaluation see whether
  gesture answers are noisier than taps.

### Build

- Web: a full-height pager with CSS scroll-snap (`scroll-snap-stop: always`, one clip per fling), horizontal swipes
  by pointer events (`touch-action: pan-y`), keyboard as above. Tests: Playwright touch swipes and keys per task,
  checking the bodies the fake server receives, plus undo and the end-at-goal rule.
- Android: Compose `VerticalPager` with `beyondViewportPageCount = 3`, horizontal drag via `anchoredDraggable` on the
  card, haptics, the speaker rule through `HeadphoneMonitor`. Tests: swipe gestures through the Compose test API
  (`swipeLeft`, `swipeRight`, `swipeUp`) per task, asserting the exact POST bodies, plus undo.
- Both keep every existing test passing; the rail buttons replace the big answer grid, and the old tests move to them.

## Decisions (the owner, 2026-10-24)

1. **Both clients**, on the same API: the web app as designed, and a native Kotlin app in its own repo.
2. **Keep clips forever.** `labeling.keepClips` stays (default off on a fresh server, on here); no clip retention
   setting. The box keeps all audio 3,650 days now anyway.
3. **Write-through, except the voiceprint.** Labels set the segment marks; a `me` label marks the line but feeds the
   voiceprint only after the owner confirms a batch of `me` labels (`POST /api/v1/labeling/voice/confirm`).
4. **v1 tasks:** `device`, `voice` (was `wearer`), `quiet`, `transcript` and `overlap` (several voices at once).

### Why web and why native

The web app is the fast path at a desk: keyboard shortcuts, a big screen for transcript corrections, nothing to
install, and the browser holds no token because SSO and the proxy do the gating. The Android app is the path
away from a desk: a notification when uncertain clips wait, a queue of clips and answers that works on a train
with no signal, and playback through headphones (the ear tells a loudspeaker from a live voice better through
headphones than through a phone speaker). Both read the same routes, so labels from either are the same rows.
The phone app cannot sit behind SSO, so it carries its own token, of a new scope `labeling` that reaches only
`/api/v1/labeling/*`, stored Keystore-encrypted as the main app stores its token.

## Open decisions (answered above)

1. Approve the shape: PWA at its own host behind SSO, Caddy proxy with its own token
   (recommended), or something else.
2. Keeping clips past audio retention (a privacy change, setting `labeling.keepClips`, default off): on for your own
   voice only, 12 months then embedding (recommended); on for all clips; or off (only labels and embeddings survive).
3. Write-through from labels to the existing marks, with the three rules above: yes (recommended) or labels separate.
4. v1 tasks: `device`, `wearer`, `quiet` (recommended), `transcript` and `energy` next; scene and salience later.
