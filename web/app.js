import * as api from "./api.js";
import * as outbox from "./outbox.js";
import {
  ASK, CONTENT, DEVICE_TYPE, FEED, FLAGS, GOAL, LANGUAGE, OVERLAP, SEVERAL, SOURCE, TASK_NAMES, TAXONOMY_VERSION,
  TRANSCRIPT, needsMore,
} from "./taxonomy.js";

const root = document.getElementById("app");
const statusEl = document.getElementById("status");

let session = null; // see startSession
let authProblem = false;
// Tests pass ?undoMs=0 to send at once; the owner gets 4 s to take an answer back.
const UNDO_MS = (() => { const v = Number(new URLSearchParams(location.search).get("undoMs")); return Number.isFinite(v) && v >= 0 && location.search.includes("undoMs") ? v : 4000; })();

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
  endFeed();
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
    el("ul", { class: "tasks" }, [mixedTask(list), ...list].map((t) => el("li", { class: "card task" },
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

function mixedTask(list) {
  const open = list.reduce((n, t) => n + t.open, 0);
  return { task: "mixed", open, labelled: list.reduce((n, t) => n + t.labelled, 0), goal: null };
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

// ---------- the feed (DESIGN.md section 7) ----------

const LABELS = Object.fromEntries([...SOURCE, ...TRANSCRIPT, ...OVERLAP, { value: "not_me", label: "Not me" }].map((o) => [o.value, o.label]));
const audio = new Audio();
audio.preload = "auto";

async function startSession(task) {
  root.replaceChildren(el("p", { class: "muted", text: "Fetching clips…" }));
  let res;
  let before = [];
  try {
    [res, before] = await Promise.all([api.next(task, GOAL), api.tasks().then((t) => t.tasks).catch(() => [])]);
  } catch (e) {
    root.replaceChildren(el("div", { class: "card error" }, el("p", { text: `Could not start: ${e.message}` }), button("Back", showTasks)));
    return;
  }
  if (!res.items.length) {
    root.replaceChildren(el("div", { class: "card" }, el("p", { text: "Nothing waits for this task." }), button("Back", showTasks)));
    return;
  }
  session = {
    task, items: res.items, index: -1, answers: new Map(), clips: new Map(), before, slides: [], last: null,
    listened: { ms: 0, since: null }, ended: false,
  };
  // Every clip before the first card, so a swipe never waits on the network.
  await Promise.all(res.items.map(async (it) => {
    try { session.clips.set(it.id, await api.clip(it.id, 0)); } catch { session.clips.set(it.id, null); }
  }));
  buildFeed();
}

function buildFeed() {
  const feed = el("div", { class: "feed", id: "feed", role: "feed", "aria-label": "Clips" });
  session.slides = session.items.map((item, i) => buildSlide(item, i));
  const end = el("article", { class: "slide end", id: "end-slide", "data-index": String(session.items.length), "aria-label": "Session done" });
  feed.append(...session.slides, end);
  document.body.classList.add("feed-mode");
  root.replaceChildren(feed, el("div", { class: "toast", id: "toast", role: "status", "aria-live": "polite" }));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || !session) continue;
      const i = e.target === end ? session.items.length : session.slides.indexOf(e.target);
      arrive(i);
    }
  }, { root: feed, threshold: 0.6 });
  [...session.slides, end].forEach((s) => io.observe(s));
  session.io = io;
  arrive(0);
}

function endFeed() {
  if (session) {
    session.io?.disconnect();
    for (const u of session.clips.values()) if (u) URL.revokeObjectURL(u);
  }
  stopListening();
  audio.pause();
  audio.removeAttribute("src");
  session = null;
  document.body.classList.remove("feed-mode");
}

function current() { return session?.items[session.index]; }
function slideOf(i) { return session.slides[i]; }

function buildSlide(item, i) {
  const f = FEED[item.task];
  const prev = session.items[i - 1];
  const switched = !prev || prev.task !== item.task;
  const bars = el("div", { class: "wave", "aria-hidden": "true" },
    Array.from({ length: 100 }, (_, k) => el("i", { "data-k": String(k) })));
  drawPeaks(bars, item);

  const line = (l, cls) => el("p", { class: `cap ${cls}${l.isUser ? " me" : ""}`, "data-start": String(l.startMs), "data-end": String(l.endMs) },
    el("span", { class: "who", text: l.isUser ? "Me" : "Other" }), el("span", { text: l.text }));
  const captions = el("div", { class: "captions" },
    (item.contextBefore ?? []).map((l) => line(l, "ctx")),
    item.lines.map((l) => line(l, "own")),
    (item.contextAfter ?? []).map((l) => line(l, "ctx")));

  const card = el("div", { class: "clipcard", "data-testid": "card", tabindex: "0", "aria-label": "Clip. Tap to replay, swipe right for yes, left for no, hold for all answers." },
    bars, el("p", { class: "tap-hint", text: session.clips.get(item.id) ? "Tap to play" : "Audio is gone for this clip. Skip it." }), captions);
  attachGestures(card, item, i);

  const rail = el("div", { class: "rail" },
    railButton("no", f.no.label, () => side(item, "no", "button")),
    railButton("skip", "Skip", () => goTo(i + 1)),
    railButton("more", "More", () => openSheet(item, "more", "sheet")),
    railButton("yes", f.yes.label, () => side(item, "yes", "button"), "primary"));

  return el("article", { class: "slide", "data-index": String(i), "data-item": String(item.id), "data-task": item.task, "aria-label": `Clip ${i + 1} of ${session.items.length}` },
    el("header", { class: "slide-top" },
      el("h1", { class: `task-name${switched ? " switched" : ""}`, text: TASK_NAMES[item.task] }),
      ring(i, session.items.length),
      el("span", { class: "tick", "data-testid": "saved-state" })),
    card,
    el("h2", { class: "question", text: f.question }),
    rail,
    el("div", { class: "sheet", hidden: true, role: "dialog", "aria-label": "All answers" }));
}

function railButton(action, text, onClick, cls = "") {
  const b = el("button", { type: "button", class: `rail-btn ${cls}`, "data-action": action, text });
  b.addEventListener("click", onClick);
  return b;
}

function ring(i, n) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("class", "ring");
  svg.setAttribute("aria-hidden", "true");
  for (const [cls, len] of [["track", c], ["fill", (c * i) / n]]) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "18"); circle.setAttribute("cy", "18"); circle.setAttribute("r", String(r));
    circle.setAttribute("class", cls);
    circle.setAttribute("stroke-dasharray", `${len} ${c}`);
    svg.append(circle);
  }
  return el("span", { class: "progress" }, svg, el("span", { text: `${i + 1} of ${n}` }));
}

function drawPeaks(bars, item) {
  const set = (peaks) => peaks.forEach((p, k) => { if (bars.children[k]) bars.children[k].style.height = `${Math.max(6, Math.round(p * 100))}%`; });
  if (Array.isArray(item.peaks) && item.peaks.length) { set(item.peaks); return; }
  set(Array(100).fill(0.15));
  const url = session.clips.get(item.id);
  if (!url || !window.AudioContext) return;
  // No peaks from the server: decode the clip here.
  fetch(url).then((r) => r.arrayBuffer()).then((buf) => new AudioContext().decodeAudioData(buf)).then((audioBuf) => {
    const data = audioBuf.getChannelData(0);
    const step = Math.floor(data.length / 100) || 1;
    const peaks = Array.from({ length: 100 }, (_, k) => {
      let m = 0;
      for (let j = k * step; j < Math.min(data.length, (k + 1) * step); j++) m = Math.max(m, Math.abs(data[j]));
      return m;
    });
    const top = Math.max(...peaks) || 1;
    set(peaks.map((p) => p / top));
  }).catch(() => {});
}

// ---------- arriving at a clip ----------

function arrive(i) {
  if (!session || i === session.index) return;
  const from = session.index;
  stopListening();
  // Moving forward past a clip with no answer is an explicit skip.
  if (from >= 0 && i > from) {
    const left = session.items[from];
    if (left && !session.answers.has(left.id)) skip(left);
  }
  session.index = i;
  for (const [k, sl] of [...session.slides, document.getElementById("end-slide")].entries()) {
    if (k === i) sl.setAttribute("aria-current", "true"); else sl.removeAttribute("aria-current");
  }
  closeSheets();
  if (i >= session.items.length) { showEnd(); return; }
  play();
}

function play(fromStart = true) {
  const item = current();
  const url = item && session.clips.get(item.id);
  if (!url) { audio.pause(); return; }
  if (audio.src !== url) audio.src = url;
  if (fromStart) audio.currentTime = 0;
  if (document.hidden) return; // never plays in a background tab
  audio.play().catch(() => {});
}

audio.addEventListener("play", () => { if (session) session.listened.since = performance.now(); tickPlayback(); });
audio.addEventListener("pause", stopListening);
audio.addEventListener("ended", stopListening);

function stopListening() {
  const l = session?.listened;
  if (l?.since != null) { l.ms += performance.now() - l.since; l.since = null; }
  const slide = session && slideOf(session.index);
  slide?.classList.toggle("playing", false);
}

function tickPlayback() {
  const slide = session && slideOf(session.index);
  if (!slide) return;
  slide.classList.toggle("playing", !audio.paused);
  const ms = audio.currentTime * 1000;
  const frac = audio.duration ? audio.currentTime / audio.duration : 0;
  const n = Math.round(frac * 100);
  slide.querySelectorAll(".wave i").forEach((b, k) => b.classList.toggle("played", k < n));
  slide.querySelectorAll(".cap.own").forEach((c) => c.classList.toggle("active", ms >= Number(c.dataset.start) && ms < Number(c.dataset.end)));
  if (!audio.paused) requestAnimationFrame(tickPlayback);
}

document.addEventListener("visibilitychange", () => {
  // Hidden: stop, and stay stopped until the owner taps.
  if (document.hidden) audio.pause();
});

// ---------- gestures ----------

const SWIPE_PX = 80;
const HOLD_MS = 500;

function attachGestures(card, item, i) {
  let g = null;
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    g = { x: e.clientX, y: e.clientY, t: performance.now(), mode: null, held: false };
    g.hold = setTimeout(() => { if (g && !g.mode) { g.held = true; openSheet(item, "more", "sheet"); } }, HOLD_MS);
  });
  card.addEventListener("pointermove", (e) => {
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.mode && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { g.mode = "h"; clearTimeout(g.hold); card.setPointerCapture?.(e.pointerId); }
    else if (!g.mode && Math.abs(dy) > 8) { g.mode = "v"; clearTimeout(g.hold); }
    if (g.mode === "h") {
      card.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      card.dataset.lean = dx > SWIPE_PX ? "yes" : dx < -SWIPE_PX ? "no" : "";
    }
  });
  const end = (e) => {
    if (!g) return;
    clearTimeout(g.hold);
    const dx = e.clientX - g.x;
    const mode = g.mode;
    const held = g.held;
    g = null;
    card.style.transform = "";
    card.dataset.lean = "";
    if (held) return;
    if (mode === "h" && dx > SWIPE_PX) side(item, "yes", "swipe");
    else if (mode === "h" && dx < -SWIPE_PX) side(item, "no", "swipe");
    else if (!mode && e.type === "pointerup") { if (session.index === i) play(true); }
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}

/** A yes or a no: saves at once, or opens the one-tap sheet the task defines for that side. */
function side(item, which, how) {
  const s = FEED[item.task][which];
  if (s.value) answer(item, s.value, how);
  else openSheet(item, which, how === "key" ? "key" : "sheet");
}

// ---------- the sheet ----------

function closeSheets() {
  for (const s of document.querySelectorAll(".sheet")) { s.hidden = true; s.replaceChildren(); }
}

function openSheet(item, which, how) {
  const i = session.items.indexOf(item);
  const sheet = slideOf(i).querySelector(".sheet");
  const f = FEED[item.task];
  const field = f.ask;
  const values = which === "more" ? ASK[field].options.map((o) => o.value) : f[which].sheet;
  const d = { several: new Set(), deviceType: null, content: null, flags: new Set(), language: null, correction: item.lines.length === 1 ? item.lines[0].text : "" };
  sheet.draft = d;
  const render = (pending = null) => {
    const opts = values.map((v, k) => {
      const o = { value: v, label: LABELS[v] ?? v, key: String(k + 1) };
      return choice(field, o, pending === v, (val) => pick(val), { big: true });
    });
    const parts = [el("p", { class: "sheet-title", text: which === "more" ? ASK[field].title : f.question }), el("div", { class: "choices big" }, opts)];
    if (pending === "several") {
      parts.push(el("div", { class: "card inset" }, el("p", { text: "Pick up to two" }),
        el("div", { class: "choices" }, SEVERAL.map((v) => choice("several", SOURCE.find((x) => x.value === v), d.several.has(v), (val) => {
          if (d.several.has(val)) d.several.delete(val); else if (d.several.size < 2) d.several.add(val);
          render("several");
        }))),
        sendButton(d.several.size > 0, () => answer(item, [...d.several], "sheet", d))));
    }
    if (pending === "wrong_words") {
      const ta = el("textarea", { id: `correction-${item.id}`, class: "correction", rows: 3, value: d.correction, "aria-label": "Corrected text" });
      ta.addEventListener("input", () => { d.correction = ta.value; });
      parts.push(el("div", { class: "card inset" }, el("label", { for: ta.id, text: "What was said" }), ta,
        sendButton(true, () => answer(item, "wrong_words", "sheet", d))));
    }
    if (which === "more") {
      if (field === "source") parts.push(optionRow("Device type", "deviceType", DEVICE_TYPE, (v) => d.deviceType === v, (v) => { d.deviceType = d.deviceType === v ? null : v; }, () => render(pending)));
      parts.push(optionRow("Sound", "content", CONTENT, (v) => d.content === v, (v) => { d.content = d.content === v ? null : v; }, () => render(pending)));
      parts.push(optionRow("Flags", "flags", FLAGS, (v) => d.flags.has(v), (v) => { d.flags.has(v) ? d.flags.delete(v) : d.flags.add(v); }, () => render(pending)));
      parts.push(optionRow("Language", "language", LANGUAGE, (v) => d.language === v, (v) => { d.language = d.language === v ? null : v; }, () => render(pending)));
    }
    parts.push(button("Close", () => { sheet.hidden = true; }, "ghost"));
    sheet.replaceChildren(...parts);
  };
  const pick = (v) => {
    if (needsMore(field, v)) { render(v); return; }
    answer(item, field === "source" ? [v] : v, how === "key" ? "key" : "sheet", d);
  };
  sheet.pick = (k) => { const v = values[k]; if (v) pick(v); };
  render();
  sheet.hidden = false;
}

function optionRow(title, field, options, isOn, toggle, rerender) {
  return el("div", { class: "opt" }, el("span", { class: "opt-title", text: title }),
    el("div", { class: "choices small" }, options.map((o) => choice(field, o, isOn(o.value), (v) => { toggle(v); rerender(); }))));
}

function sendButton(enabled, onClick) {
  const b = el("button", { type: "button", class: "primary", "data-action": "send", disabled: !enabled, text: "Send (Enter)" });
  b.addEventListener("click", onClick);
  return b;
}

// ---------- answering ----------

function answer(item, value, how, d = null) {
  if (!session) return;
  // A second answer inside the undo window replaces the first before it is sent; after it, the server supersedes.
  const before = session.answers.get(item.id);
  if (before && !before.skipped && before.status === "pending") outbox.cancel(before.clientId).catch(() => {});
  const f = FEED[item.task];
  const i = session.items.indexOf(item);
  stopListening();
  const body = { clientId: crypto.randomUUID(), taxonomyVersion: TAXONOMY_VERSION, linesDiffer: false, skipped: false, answeredWith: how };
  if (f.ask === "source") body.source = Array.isArray(value) ? value : [value];
  else body[f.ask] = value;
  if (d) {
    if (d.deviceType && body.source?.includes("device")) body.deviceType = d.deviceType;
    if (d.content) body.content = d.content;
    if (d.flags.size) body.flags = [...d.flags];
    if (d.language) body.language = d.language;
    if (value === "wrong_words" && item.lines.length === 1 && d.correction.trim() && d.correction !== item.lines[0].text) body.correction = d.correction.trim();
  }
  body.listenedMs = Math.round(session.listened.ms);
  session.listened.ms = 0;
  const shown = body.source ? body.source.map((v) => LABELS[v] ?? v).join(" + ") : LABELS[value] ?? value;
  const guess = item.guess;
  const disagreed = guess ? !(body.source ? body.source.includes(guess.value) : guess.value === value) : null;
  session.answers.set(item.id, { status: "pending", clientId: body.clientId, disagreed });
  session.last = { item, clientId: body.clientId, index: i };
  setTick(i, "Sending…", "pending");
  navigator.vibrate?.(which(item, Array.isArray(value) ? value[0] : value) === "no" ? [8, 40, 8] : 10);
  outbox.enqueue(item.id, body, UNDO_MS).catch(() => {});
  // The model's guess shows only now, so it never steers the ear.
  toast(`${shown}${guess ? ` · model said ${LABELS[guess.value] ?? guess.value}${guess.score != null ? ` (${guess.score.toFixed(2)})` : ""}` : ""}`, true);
  closeSheets();
  goTo(i + 1);
}

function which(item, value) {
  const no = FEED[item.task].no;
  return no.value === value || no.sheet?.includes(value) ? "no" : "yes";
}

function skip(item) {
  const body = { clientId: crypto.randomUUID(), skipped: true };
  session.answers.set(item.id, { status: "pending", clientId: body.clientId, skipped: true });
  setTick(session.items.indexOf(item), "Skipped", "skipped");
  outbox.enqueue(item.id, body).catch(() => {});
}

async function undo() {
  const last = session?.last;
  if (!last) return;
  session.last = null;
  if (await outbox.cancel(last.clientId)) {
    session.answers.delete(last.item.id);
    setTick(last.index, "", "");
    toast("Taken back", false);
    goTo(last.index);
  } else {
    toast("Already sent: swipe back and answer again to change it.", false);
  }
}

function goTo(i) {
  const target = i >= session.items.length ? document.getElementById("end-slide") : slideOf(Math.max(0, i));
  target?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function setTick(i, text, cls) {
  const t = slideOf(i)?.querySelector("[data-testid=saved-state]");
  if (t) { t.textContent = text; t.className = `tick ${cls}`; }
}

let toastTimer = null;
function toast(text, withUndo) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.replaceChildren(el("span", { text }), withUndo && UNDO_MS > 0 ? button("Undo", undo, "ghost undo") : null);
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), Math.max(UNDO_MS, 1500));
}

// ---------- the end ----------

async function showEnd() {
  const s = session;
  audio.pause();
  s.ended = true;
  const endSlide = document.getElementById("end-slide");
  const answered = [...s.answers.values()];
  const done = answered.filter((a) => !a.skipped).length;
  const skipped = answered.filter((a) => a.skipped).length;
  const disagreed = answered.filter((a) => a.disagreed).length;
  const gates = el("ul", { class: "gates" });
  const week = el("div", { class: "week", "aria-label": "Days labelled this week" });
  endSlide.replaceChildren(el("div", { class: "card done" },
    el("h1", { text: "Session done" }),
    el("p", { text: `${done} answered, ${skipped} skipped.` }),
    disagreed ? el("p", { text: `${disagreed} of your answers disagreed with the model: those teach it most.` }) : null,
    gates,
    el("p", { class: "muted", id: "done-pending" }),
    el("p", { class: "muted small", text: "This week" }), week,
    el("div", { class: "row" }, button(`Another ${GOAL}`, () => { const t = s.task; endFeed(); startSession(t); }, "primary"), button("All tasks", showTasks, "ghost"))));
  outbox.pendingCount().then(updatePending);
  try {
    const after = (await api.tasks()).tasks;
    for (const t of after) {
      const b = s.before.find((x) => x.task === t.task);
      if (!t.goal || !b) continue;
      gates.append(el("li", { text: `${TASK_NAMES[t.task]}: ${b.labelled} → ${t.labelled} of ${t.goal}${t.goalLabel ? ` ${t.goalLabel}` : ""}` }));
    }
  } catch { /* the summary works without it */ }
  try {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const labels = (await api.labels(monday.toISOString())).items;
    const days = new Set(labels.map((l) => new Date(l.createdAt).toDateString()));
    week.replaceChildren(...["M", "T", "W", "T", "F", "S", "S"].map((n, k) => {
      const d = new Date(monday); d.setDate(monday.getDate() + k);
      const on = days.has(d.toDateString());
      return el("span", { class: `day${on ? " on" : ""}`, "data-on": on ? "1" : "0", "aria-label": `${d.toDateString()}${on ? ", labelled" : ""}`, text: n });
    }));
  } catch { /* no week strip */ }
}

// ---------- outbox status ----------

function updatePending(count, overdue = count) {
  const p = document.getElementById("done-pending");
  if (p) p.textContent = count ? `${count} answers still sending; they keep trying in the background.` : "Every answer is saved on the server.";
  if (authProblem) setStatus("The server refused the request: check the proxy's token.", "error");
  else if (overdue) setStatus(`${overdue} unsent${navigator.onLine ? "" : " · offline"}`, "warn");
  else setStatus("");
}

outbox.onChange((e) => {
  if (e.type === "auth") { authProblem = true; return; }
  if (e.type === "pending") { if (e.count === 0) authProblem = false; updatePending(e.count, e.overdue); return; }
  if (!session) return;
  for (const [itemId, a] of session.answers) {
    if (a.clientId !== e.clientId) continue;
    a.status = e.type === "saved" ? "saved" : "rejected";
    if (e.type === "rejected") a.error = e.error;
    const i = session.items.findIndex((x) => x.id === itemId);
    if (a.skipped) setTick(i, "Skipped", "skipped");
    else setTick(i, e.type === "saved" ? "Saved ✓" : `Not saved: ${e.error}`, a.status);
  }
});

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  if (!session) return;
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.target.closest(".sheet")?.querySelector("[data-action=send]")?.click(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "u" || e.key === "U") { undo(); return; }
  const item = current();
  if (!item) { if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); goTo(session.items.length - 1); } return; }
  const sheet = slideOf(session.index).querySelector(".sheet");
  if (!sheet.hidden) {
    if (/^[1-9]$/.test(e.key)) { e.preventDefault(); sheet.pick(Number(e.key) - 1); }
    else if (e.key === "Escape") closeSheets();
    else if (e.key === "Enter") sheet.querySelector("[data-action=send]")?.click();
    return;
  }
  const opt = ASK[FEED[item.task].ask].options.find((o) => o.key === e.key);
  if (opt) {
    e.preventDefault();
    if (needsMore(FEED[item.task].ask, opt.value)) { openSheet(item, "more", "key"); sheet.pick(ASK[FEED[item.task].ask].options.indexOf(opt)); }
    else answer(item, FEED[item.task].ask === "source" ? [opt.value] : opt.value, "key");
    return;
  }
  if (e.key === "ArrowRight") { e.preventDefault(); side(item, "yes", "key"); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); side(item, "no", "key"); }
  else if (e.key === "ArrowDown" || e.key === "j" || e.key === "J") { e.preventDefault(); goTo(session.index + 1); }
  else if (e.key === "ArrowUp" || e.key === "k" || e.key === "K") { e.preventDefault(); goTo(session.index - 1); }
  else if (e.key === " ") { e.preventDefault(); play(true); }
  else if (e.key === "m" || e.key === "M") openSheet(item, "more", "sheet");
});

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

outbox.drain();
showTasks();
