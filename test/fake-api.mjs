// A fake of the labeling API (docs/api.md) that serves web/ too, for development and the tests.
// Clips are synthetic tones and lines are invented text: real audio never enters this repository.
//
//   node test/fake-api.mjs [port]      then open http://127.0.0.1:<port>/
//
// Test hooks: GET /__fake/posts (every POST body received), POST /__fake/reset, POST /__fake/fail {status, times}.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

const VALUES = {
  source: ["me", "not_me", "live", "device", "call", "none", "cant_tell"],
  answeredWith: ["swipe", "button", "sheet", "key"],
  deviceType: ["tv", "phone", "laptop", "car", "assistant", "other"],
  content: ["speech", "singing", "vocal", "music", "other_sound", "silence"],
  transcript: ["right", "small_errors", "wrong_words", "made_up", "cant_hear"],
  flags: ["quiet", "noisy", "overlap", "muffled", "clipped", "two_speakers"],
  language: ["uk", "ru", "en", "mixed", "other"],
  overlap: ["one", "two", "three_plus", "cant_tell"],
};
const AXES = ["source", "content", "transcript", "flags", "language", "overlap", "deviceType", "correction", "personId"];
const TASKS = { device: "source", voice: "source", quiet: "transcript", transcript: "transcript", overlap: "overlap" };
const PER_TASK = 8;

let state;
function reset() {
  let id = 100;
  const items = [];
  for (const [task, ask] of Object.entries(TASKS)) {
    for (let i = 0; i < PER_TASK; i++) {
      const lines = task === "overlap" && i % 2 ? 2 : 1;
      items.push({
        id: id++, task, ask, reason: ["uncertain", "random", "disagree", "repeat"][i % 4],
        conversationId: "00000000-0000-4000-8000-00000000000" + (i % 3), startedAt: new Date(Date.UTC(2026, 9, 20, 9, i)).toISOString(),
        durationMs: 1500,
        lines: Array.from({ length: lines }, (_, k) => ({
          segmentId: id * 10 + k, text: `Synthetic ${task} line ${i + 1}${k ? " (second voice)" : ""}`, isUser: task === "voice" && k === 0 && i % 2 === 0,
          startMs: k * 700, endMs: k * 700 + 700,
        })),
        contextBefore: i % 2 ? [{ segmentId: id * 10 + 8, text: `Synthetic earlier line ${i + 1}`, isUser: true, startMs: -2400, endMs: -400 }] : [],
        contextAfter: i % 3 ? [{ segmentId: id * 10 + 9, text: `Synthetic later line ${i + 1}`, isUser: false, startMs: 1700, endMs: 3200 }] : [],
        peaks: i % 4 === 3 ? null : Array.from({ length: 100 }, (_, k) => Math.round(Math.abs(Math.sin((k + i) / 7)) * 100) / 100),
        speakerKey: `vg-${i % 3}`,
        guess: i % 3 === 2 ? null : { model: "fake-1", value: ask === "source" ? "device" : ask === "transcript" ? "right" : "two", score: 0.4 + i / 20 },
        prefill: { language: i % 2 ? "en" : "uk" },
      });
    }
  }
  state = { items, labels: new Map(), byClient: new Map(), posts: [], fail: { status: 0, times: 0 }, nextLabel: 1 };
}
reset();

function tone(freq, ms = 1500, rate = 8000) {
  const n = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000 * Math.min(1, i / 400, (n - i) / 400)), 44 + i * 2);
  return buf;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function validate(item, b) {
  if (typeof b.clientId !== "string" || !/^[0-9a-f-]{36}$/.test(b.clientId)) return { field: "clientId", error: "required uuid" };
  if (b.skipped === true) return null;
  if (!AXES.some((a) => b[a] != null)) return { field: "body", error: "no answer" };
  if (b.source != null) {
    if (!Array.isArray(b.source) || b.source.length < 1 || b.source.length > 2) return { field: "source", error: "1 or 2 values" };
    if (b.source.some((v) => !VALUES.source.includes(v))) return { field: "source", error: "unknown value" };
  }
  if (b.flags != null && (!Array.isArray(b.flags) || b.flags.some((v) => !VALUES.flags.includes(v)))) return { field: "flags", error: "unknown value" };
  for (const f of ["deviceType", "content", "transcript", "language", "overlap", "answeredWith"]) {
    if (b[f] != null && !VALUES[f].includes(b[f])) return { field: f, error: "unknown value" };
  }
  if (b.correction != null && (typeof b.correction !== "string" || item.lines.length !== 1)) return { field: "correction", error: "single line only" };
  return null;
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/__fake/posts") return json(res, 200, state.posts);
    if (p === "/__fake/reset" && req.method === "POST") { reset(); return json(res, 200, {}); }
    if (p === "/__fake/fail" && req.method === "POST") { state.fail = await body(req); return json(res, 200, {}); }

    if (p.startsWith("/api/v1/labeling")) {
      const rest = p.slice("/api/v1/labeling".length);
      if (rest === "/tasks" && req.method === "GET") {
        return json(res, 200, { tasks: Object.entries(TASKS).map(([task, ask]) => ({
          task, ask, open: state.items.filter((i) => i.task === task && !answered(i)).length,
          labelled: [...state.labels.values()].filter((l) => l.task === task).length,
          goal: task === "device" ? 100 : null, goalLabel: task === "device" ? "not-device lines" : null,
        })) });
      }
      if (rest === "/next" && req.method === "GET") {
        const task = url.searchParams.get("task");
        if (!TASKS[task] && task !== "mixed") return json(res, 400, { field: "task", error: "unknown task" });
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 30)));
        let items;
        if (task === "mixed") {
          // Runs of 4 of one task, rotating through the tasks.
          const open = Object.keys(TASKS).map((t) => state.items.filter((i) => i.task === t && !answered(i)));
          items = [];
          for (let round = 0; items.length < limit && open.some((q) => q.length); round++) {
            for (const q of open) items.push(...q.splice(0, 4));
          }
          items = items.slice(0, limit);
        } else {
          items = state.items.filter((i) => i.task === task && !answered(i)).slice(0, limit);
        }
        return json(res, 200, { sessionId: "11111111-1111-4111-8111-111111111111", leasedUntil: new Date(Date.now() + 1800e3).toISOString(), items });
      }
      if (rest === "/voice/pending" && req.method === "GET") {
        const items = [...state.labels.values()]
          .filter((l) => !l.supersededBy && !l.confirmed && l.source?.length === 1 && l.source[0] === "me")
          .map((l) => ({ labelId: l.labelId, segmentId: state.items.find((i) => i.id === l.itemId).lines[0].segmentId, durationMs: 1500 }));
        return json(res, 200, { items });
      }
      if (rest === "/voice/confirm" && req.method === "POST") {
        const b = await body(req);
        state.posts.push({ confirm: b });
        if (!Array.isArray(b.labelIds) || b.labelIds.some((id) => !state.labels.has(id))) return json(res, 400, { field: "labelIds", error: "unknown label" });
        for (const id of b.labelIds) state.labels.get(id).confirmed = true;
        return json(res, 200, { learned: b.labelIds.length });
      }
      if (rest === "/labels" && req.method === "GET") {
        const since = url.searchParams.get("since") ?? "";
        const items = [...state.labels.values()].filter((l) => l.createdAt >= since)
          .map((l) => ({ labelId: l.labelId, itemId: l.itemId, task: l.task, source: l.source ?? null, createdAt: l.createdAt, answeredWith: l.answeredWith ?? null }));
        return json(res, 200, { items, nextSince: null });
      }
      if (rest === "/__seed-days" && req.method === "POST") {
        // Test hook: labels on earlier days, for the week strip.
        const b = await body(req);
        for (const d of b.days) state.labels.set(state.nextLabel, { labelId: state.nextLabel++, itemId: -1, task: "voice", createdAt: `${d}T10:00:00Z` });
        return json(res, 200, {});
      }
      let m = rest.match(/^\/(\d+)\/clip$/);
      if (m && req.method === "GET") {
        const item = state.items.find((i) => i.id === Number(m[1]));
        if (!item) return json(res, 404, { error: "unknown item" });
        const ctx = Math.min(4, Math.max(0, Number(url.searchParams.get("context") ?? 0)));
        res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
        return res.end(tone(300 + (item.id % 10) * 40, 1500 + ctx * 1000));
      }
      m = rest.match(/^\/(\d+)$/);
      if (m && req.method === "POST") {
        const b = await body(req);
        state.posts.push({ itemId: Number(m[1]), body: b, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
        if (state.fail.times > 0) { state.fail.times -= 1; return json(res, state.fail.status, { error: "injected" }); }
        const item = state.items.find((i) => i.id === Number(m[1]));
        if (!item) return json(res, 404, { error: "unknown item" });
        const bad = validate(item, b);
        if (bad) return json(res, 400, bad);
        if (state.byClient.has(b.clientId)) return json(res, 200, { labelId: state.byClient.get(b.clientId), superseded: null });
        if (b.skipped) { state.byClient.set(b.clientId, null); return json(res, 200, { labelId: null, superseded: null }); }
        const prev = [...state.labels.values()].find((l) => l.itemId === item.id && !l.supersededBy);
        const labelId = state.nextLabel++;
        state.labels.set(labelId, { labelId, itemId: item.id, task: item.task, createdAt: new Date().toISOString(), ...b });
        if (prev) prev.supersededBy = labelId;
        state.byClient.set(b.clientId, labelId);
        return json(res, 200, { labelId, superseded: prev?.labelId ?? null });
      }
      return json(res, 404, { error: "no route" });
    }

    const file = normalize(join(WEB, p === "/" ? "index.html" : p));
    if (!file.startsWith(WEB)) return json(res, 403, {});
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch (e) {
    if (e.code === "ENOENT") return json(res, 404, {});
    json(res, 500, { error: String(e) });
  }
});

function answered(item) { return [...state.labels.values()].some((l) => l.itemId === item.id); }

const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
// FAKE_HOST=0.0.0.0 lets a container reach it on Linux (test/container.sh).
const host = process.env.FAKE_HOST ?? "127.0.0.1";
server.listen(port, host, () => console.log(`fake labeling API on http://${host}:${port}/`));
