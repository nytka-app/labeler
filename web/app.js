import * as api from "./api.js";
import * as outbox from "./outbox.js";
import {
  ASK, CONTENT, DEVICE_TYPE, FLAGS, LANGUAGE, SEVERAL, SOURCE, TASK_NAMES, TAXONOMY_VERSION, needsMore,
} from "./taxonomy.js";

const root = document.getElementById("app");
const statusEl = document.getElementById("status");

let session = null; // { task, ask, items, index, answers: Map<itemId, {status, error}>, clips: Map, context: Map }
let draft = null;
let listened = { ms: 0, since: null };
let authProblem = false;

// ---------- small DOM helpers ----------

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("data-")) n.setAttribute(k, v);
    else if (k.startsWith("aria-") || k === "role" || k === "for" || k === "id" || k === "type") n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

/**
 * A choice button. The value is captured by the closure, never read back from the element:
 * an earlier page lost every label because its handler read a property of the button itself.
 */
function choice(field, option, on, onTap, extra = {}) {
  const b = el("button", {
    type: "button",
    class: `choice${on ? " on" : ""}${extra.guess ? " guess" : ""}${extra.big ? " big" : ""}`,
    "data-field": field,
    "data-value": option.value,
    "aria-pressed": on ? "true" : "false",
  }, option.key && extra.big ? el("kbd", { text: option.key }) : null, el("span", { text: option.label }));
  const value = option.value;
  b.addEventListener("click", () => onTap(value));
  return b;
}

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

// ---------- tasks ----------

async function showTasks() {
  session = null;
  draft = null;
  document.title = "Nytka labeler";
  root.replaceChildren(el("p", { class: "muted", text: "Loading tasks…" }));
  let list;
  try {
    list = (await api.tasks()).tasks;
  } catch (e) {
    root.replaceChildren(el("div", { class: "card error" },
      el("p", { text: "Could not load tasks." }), el("p", { class: "muted", text: e.message }),
      button("Try again", showTasks)));
    return;
  }
  root.replaceChildren(
    el("h1", { text: "What does it sound like?" }),
    el("p", { class: "muted", text: "Short sessions of the clips the models are least sure about. Headphones help." }),
    el("ul", { class: "tasks" }, list.map((t) => el("li", { class: "card task" },
      el("div", {},
        el("h2", { text: TASK_NAMES[t.task] ?? t.task }),
        el("p", { class: "muted", text: taskLine(t) }),
        t.goal ? el("progress", { max: t.goal, value: Math.min(t.labelled, t.goal), "aria-label": `${t.labelled} of ${t.goal}` }) : null),
      el("button", {
        type: "button", class: "primary", "data-task": t.task, disabled: t.open === 0,
      }, t.open === 0 ? "Nothing waits" : "Start")))),
  );
  for (const b of root.querySelectorAll("button[data-task]")) {
    const task = b.dataset.task;
    b.addEventListener("click", () => startSession(task));
  }
  api.voicePending().then((r) => {
    if (!r.items.length || session) return;
    root.append(el("div", { class: "card task" },
      el("div", {}, el("h2", { text: "Confirm my voice" }),
        el("p", { class: "muted", text: `${r.items.length} lines you marked as yours wait before they teach your voiceprint.` })),
      button("Review", showVoiceConfirm, "primary")));
  }).catch(() => {});
}

// ---------- voice confirmation ----------

async function showVoiceConfirm() {
  let items;
  try { items = (await api.voicePending()).items; } catch (e) { setStatus(`Could not load: ${e.message}`, "error"); return; }
  const checked = new Set(items.map((i) => i.labelId));
  const send = el("button", { type: "button", class: "primary", "data-action": "confirm-voice" });
  const label = () => { send.textContent = `Teach my voiceprint (${checked.size})`; send.disabled = checked.size === 0; };
  send.addEventListener("click", async () => {
    send.disabled = true;
    try {
      const r = await api.voiceConfirm([...checked]);
      root.replaceChildren(el("section", { class: "card done" }, el("h1", { text: "Voiceprint updated" }),
        el("p", { id: "voice-learned", text: `${r.learned} lines taught your voiceprint.` }), button("All tasks", showTasks, "primary")));
    } catch (e) { setStatus(`Not confirmed: ${e.message}`, "error"); label(); }
  });
  root.replaceChildren(el("section", { class: "card" },
    el("h1", { text: "Confirm my voice" }),
    el("p", { text: "Lines you marked “Me”. Confirmed lines teach your voiceprint, and that cannot be undone: untick any you are not sure of." }),
    el("ul", { class: "confirm-list" }, items.map((it) => {
      const id = `voice-${it.labelId}`;
      const box = el("input", { type: "checkbox", id, checked: true, "data-label-id": String(it.labelId) });
      const labelId = it.labelId;
      box.addEventListener("change", () => { box.checked ? checked.add(labelId) : checked.delete(labelId); label(); });
      return el("li", {}, box, el("label", { for: id, text: `Line ${it.segmentId} · ${(it.durationMs / 1000).toFixed(1)} s` }));
    })),
    el("div", { class: "row between" }, button("Back", showTasks, "ghost"), send)));
  label();
}

function taskLine(t) {
  const goal = t.goal ? ` · goal ${t.labelled} of ${t.goal}${t.goalLabel ? ` ${t.goalLabel}` : ""}` : "";
  return `${t.open} waiting · ${t.labelled} labelled${goal}`;
}

function button(text, onClick, cls = "") {
  const b = el("button", { type: "button", class: cls, text });
  b.addEventListener("click", onClick);
  return b;
}

// ---------- session ----------

async function startSession(task) {
  root.replaceChildren(el("p", { class: "muted", text: "Fetching clips…" }));
  let res;
  try {
    res = await api.next(task, 30);
  } catch (e) {
    root.replaceChildren(el("div", { class: "card error" }, el("p", { text: `Could not start: ${e.message}` }), button("Back", showTasks)));
    return;
  }
  if (!res.items.length) {
    root.replaceChildren(el("div", { class: "card" }, el("p", { text: "Nothing waits for this task." }), button("Back", showTasks)));
    return;
  }
  session = { task, items: res.items, index: 0, answers: new Map(), clips: new Map(), context: new Map() };
  // Fetch every clip up front so a flaky connection does not stall the session.
  await Promise.all(res.items.map(async (it) => {
    try { session.clips.set(it.id, await api.clip(it.id, 0)); } catch { session.clips.set(it.id, null); }
  }));
  showCard();
}

function current() { return session.items[session.index]; }

function newDraft(item) {
  return {
    primary: null, several: new Set(), deviceType: null, content: null, flags: new Set(),
    language: item.prefill?.language ?? null, languageTouched: false,
    correction: item.lines.length === 1 ? item.lines[0].text : "",
  };
}

function showCard() {
  const item = current();
  if (!item) { showDone(); return; }
  draft = newDraft(item);
  listened = { ms: 0, since: null };
  renderCard(true);
}

function renderCard(autoplay = false) {
  const item = current();
  const ask = ASK[item.ask];
  const saved = session.answers.get(item.id);
  const n = session.index + 1;
  document.title = `${n} of ${session.items.length} · Nytka labeler`;

  const audio = el("audio", { id: "clip", preload: "auto" });
  const url = session.clips.get(item.id);
  if (url) audio.src = url;
  audio.addEventListener("play", () => { listened.since = performance.now(); });
  const stop = () => { if (listened.since != null) { listened.ms += performance.now() - listened.since; listened.since = null; } };
  audio.addEventListener("pause", stop);
  audio.addEventListener("ended", stop);

  const header = el("div", { class: "row between" },
    el("h1", { class: "card-title", text: `${TASK_NAMES[session.task]} · ${n} of ${session.items.length}` }),
    el("span", { class: `tick ${saved?.status ?? ""}`, "data-testid": "saved-state", text: tickText(saved) }));

  const progress = el("progress", { max: session.items.length, value: session.index, "aria-label": "Session progress" });

  const player = el("div", { class: "row player" },
    url ? button("Play", () => { audio.currentTime = 0; audio.play().catch(() => {}); }, "primary")
      : el("span", { class: "error-text", text: "Audio is gone for this clip. Skip it." }),
    url ? button("With context", () => playContext(item)) : null,
    el("span", { class: "muted", text: `${(item.durationMs / 1000).toFixed(1)} s` }));

  const lines = el("div", { class: "lines" }, item.lines.map((l) =>
    el("p", { class: l.isUser ? "line me" : "line" }, el("span", { class: "who", text: l.isUser ? "Me" : "Other" }), el("span", { text: l.text }))));

  const guess = item.guess ? el("p", { class: "muted small", text: `Model: ${item.guess.value}${item.guess.score != null ? ` (${item.guess.score.toFixed(2)})` : ""} · ${item.reason}` }) : null;

  const primary = el("div", { class: "choices big", role: "group", "aria-label": ask.title },
    ask.options.map((o) => choice(ask.field, o, draft.primary === o.value, (v) => tapPrimary(v), { big: true })));

  const more = [];
  if (draft.primary === "several") {
    more.push(el("div", { class: "card inset" }, el("p", { text: "Pick up to two" }),
      el("div", { class: "choices" }, SEVERAL.map((v) => {
        const o = SOURCE.find((s) => s.value === v);
        return choice("several", o, draft.several.has(v), toggleSeveral);
      })),
      sendButton(draft.several.size > 0)));
  }
  if (draft.primary === "wrong_words") {
    const ta = el("textarea", { id: "correction", rows: 3, value: draft.correction, "aria-label": "Corrected text" });
    ta.addEventListener("input", () => { draft.correction = ta.value; });
    more.push(el("div", { class: "card inset" }, el("label", { for: "correction", text: "What was said" }), ta,
      item.lines.length === 1 ? null : el("p", { class: "muted small", text: "Several lines: the correction is not sent; split the item instead." }),
      sendButton(true)));
  }

  const optional = el("details", { class: "optional", open: sessionStorageGet("moreOpen") === "1" },
    el("summary", { text: "More about this clip (optional, set before answering)" }),
    item.ask === "source" ? optionRow("Device type", "deviceType", DEVICE_TYPE, (v) => draft.deviceType === v, (v) => { draft.deviceType = draft.deviceType === v ? null : v; }) : null,
    optionRow("Sound", "content", CONTENT, (v) => draft.content === v, (v) => { draft.content = draft.content === v ? null : v; }),
    optionRow("Flags", "flags", FLAGS, (v) => draft.flags.has(v), (v) => { draft.flags.has(v) ? draft.flags.delete(v) : draft.flags.add(v); }),
    optionRow("Language", "language", LANGUAGE, (v) => draft.language === v, (v) => { draft.language = draft.languageTouched && draft.language === v ? null : v; draft.languageTouched = true; },
      (v) => !draft.languageTouched && draft.language === v));
  optional.addEventListener("toggle", () => sessionStorageSet("moreOpen", optional.open ? "1" : "0"));

  const nav = el("div", { class: "row between" },
    button("Back", back, session.index === 0 ? "ghost hidden" : "ghost"),
    button("Skip", skip, "ghost"),
    button("End session", showDone, "ghost"));

  root.replaceChildren(el("section", { class: "card session", "aria-live": "polite" },
    header, progress, audio, player, lines, guess, el("h2", { text: ask.title }), primary, ...more, optional, nav));

  if (saved?.status === "rejected") root.querySelector(".session").prepend(el("p", { class: "error-text", text: `Not saved: ${saved.error}` }));
  if (autoplay && url) audio.play().catch(() => {});
}

function optionRow(title, field, options, isOn, toggle, isGuess = () => false) {
  return el("div", { class: "opt" }, el("span", { class: "opt-title", text: title }),
    el("div", { class: "choices small" }, options.map((o) =>
      choice(field, o, isOn(o.value), (v) => { toggle(v); renderCard(); }, { guess: isGuess(o.value) }))));
}

function sendButton(enabled) {
  const b = el("button", { type: "button", class: "primary", "data-action": "send", disabled: !enabled, text: "Send (Enter)" });
  b.addEventListener("click", () => commit());
  return b;
}

function tickText(saved) {
  if (!saved) return "";
  return { pending: "Sending…", saved: "Saved ✓", rejected: "Not saved" }[saved.status] ?? "";
}

async function playContext(item) {
  let url = session.context.get(item.id);
  if (!url) {
    try { url = await api.clip(item.id, 4); session.context.set(item.id, url); } catch { setStatus("Context audio is gone.", "warn"); return; }
  }
  const a = document.getElementById("clip");
  a.src = url;
  a.currentTime = 0;
  a.play().catch(() => {});
  a.addEventListener("ended", () => { a.src = session.clips.get(item.id); }, { once: true });
}

function tapPrimary(value) {
  draft.primary = value;
  if (needsMore(current().ask, value)) { renderCard(); return; }
  commit();
}

function toggleSeveral(v) {
  if (draft.several.has(v)) draft.several.delete(v);
  else if (draft.several.size < 2) draft.several.add(v);
  renderCard();
}

function buildBody() {
  const item = current();
  const body = { clientId: crypto.randomUUID(), taxonomyVersion: TAXONOMY_VERSION, linesDiffer: false, skipped: false };
  if (item.ask === "source") {
    body.source = draft.primary === "several" ? [...draft.several] : [draft.primary];
    if (draft.deviceType && body.source.includes("device")) body.deviceType = draft.deviceType;
  } else {
    body[item.ask] = draft.primary;
  }
  if (draft.primary === "wrong_words" && item.lines.length === 1 && draft.correction.trim() && draft.correction !== item.lines[0].text) {
    body.correction = draft.correction.trim();
  }
  if (draft.content) body.content = draft.content;
  if (draft.flags.size) body.flags = [...draft.flags];
  if (draft.languageTouched && draft.language) body.language = draft.language;
  if (listened.since != null) listened.ms += performance.now() - listened.since;
  body.listenedMs = Math.round(listened.ms);
  return body;
}

function commit() {
  if (!draft.primary) return;
  if (draft.primary === "several" && draft.several.size === 0) return;
  const item = current();
  const body = buildBody();
  session.answers.set(item.id, { status: "pending", clientId: body.clientId });
  session.index += 1;
  // Draw the next card before queueing, so a key pressed meanwhile answers the card it sees.
  showCard();
  outbox.enqueue(item.id, body).catch(() => {});
}

function skip() {
  const item = current();
  if (!item) return;
  const body = { clientId: crypto.randomUUID(), skipped: true };
  session.answers.set(item.id, { status: "pending", clientId: body.clientId, skipped: true });
  session.index += 1;
  showCard();
  outbox.enqueue(item.id, body).catch(() => {});
}

function back() {
  if (session.index === 0) return;
  session.index -= 1;
  showCard();
}

function showDone() {
  if (!session) { showTasks(); return; }
  const answered = [...session.answers.values()];
  const s = session;
  for (const u of [...s.clips.values(), ...s.context.values()]) if (u) URL.revokeObjectURL(u);
  const task = s.task;
  session = null;
  document.title = "Done · Nytka labeler";
  root.replaceChildren(el("section", { class: "card done" },
    el("h1", { text: "Session done" }),
    el("p", { text: `${answered.filter((a) => !a.skipped).length} answered, ${answered.filter((a) => a.skipped).length} skipped.` }),
    el("p", { class: "muted", id: "done-pending" }),
    el("div", { class: "row" }, button("Another session", () => startSession(task), "primary"), button("All tasks", showTasks, "ghost"))));
  outbox.pendingCount().then(updatePending);
}

// ---------- outbox status ----------

function updatePending(count) {
  const p = document.getElementById("done-pending");
  if (p) p.textContent = count ? `${count} answers still sending; they keep trying in the background.` : "Every answer is saved on the server.";
  if (authProblem) setStatus("The server refused the request: check the proxy's token.", "error");
  else if (count) setStatus(`${count} unsent${navigator.onLine ? "" : " · offline"}`, "warn");
  else setStatus("");
}

outbox.onChange((e) => {
  if (e.type === "auth") { authProblem = true; return; }
  if (e.type === "pending") { if (e.count === 0) authProblem = false; updatePending(e.count); return; }
  if (!session) return;
  for (const [itemId, a] of session.answers) {
    if (a.clientId !== e.clientId) continue;
    a.status = e.type === "saved" ? "saved" : "rejected";
    if (e.type === "rejected") a.error = e.error;
    if (current()?.id === itemId) {
      const t = document.querySelector("[data-testid=saved-state]");
      if (t) { t.textContent = tickText(a); t.className = `tick ${a.status}`; }
    }
  }
});

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  if (!session || !current()) return;
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const ask = ASK[current().ask];
  const opt = ask.options.find((o) => o.key === e.key);
  if (opt) { e.preventDefault(); tapPrimary(opt.value); return; }
  const audio = document.getElementById("clip");
  if (e.key === " ") { e.preventDefault(); if (audio?.src) { audio.currentTime = 0; audio.play().catch(() => {}); } }
  else if (e.key === "c" || e.key === "C") playContext(current());
  else if (e.key === "Enter") commit();
  else if (e.key === "s" || e.key === "S") skip();
  else if (e.key === "Backspace" || e.key === "ArrowLeft") { e.preventDefault(); back(); }
});

function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } }

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

outbox.drain();
showTasks();
