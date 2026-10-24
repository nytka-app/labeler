// Answers wait in IndexedDB until the server answers 200, so a reload or a dropped connection loses none.
// An answer counts as saved only after that 200.

import { answer, ApiError } from "./api.js";

const DB = "nytka-labeler";
const STORE = "outbox";
const RETRY_MS = [1000, 3000, 10000, 30000];

let dbPromise;
const memory = new Map(); // fallback when IndexedDB is unavailable (private windows on some browsers)
const listeners = new Set();
let timer = null;
let draining = false;
let again = false; // an answer arrived while a drain was running
const sending = new Set();

function open() {
  dbPromise ??= new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "clientId" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

async function all() {
  const db = await open();
  if (!db) return [...memory.values()];
  return tx("readonly", (s) => s.getAll());
}

async function put(entry) {
  const db = await open();
  if (!db) { memory.set(entry.clientId, entry); return; }
  await tx("readwrite", (s) => s.put(entry));
}

async function remove(clientId) {
  const db = await open();
  if (!db) { memory.delete(clientId); return; }
  await tx("readwrite", (s) => s.delete(clientId));
}

function emit(event) { for (const fn of listeners) fn(event); }

/** Events: { type: "saved", itemId, clientId, labelId } | { type: "rejected", itemId, clientId, error } | { type: "pending", count } | { type: "auth" } */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** `delayMs` holds the answer back so Undo can take it out before it is sent; it survives a reload. */
export async function enqueue(itemId, body, delayMs = 0) {
  const now = Date.now();
  await put({ clientId: body.clientId, itemId, body, tries: 0, state: "pending", at: now, notBefore: now + delayMs });
  await drain();
}

/** Takes back an answer not yet sent. True when it was still waiting. */
export async function cancel(clientId) {
  const e = (await all()).find((x) => x.clientId === clientId);
  if (!e || e.state !== "pending" || sending.has(clientId)) return false;
  await remove(clientId);
  emit({ type: "pending", count: await pendingCount() });
  return true;
}

/** Answers not yet on the server. `overdueOnly` leaves out those still inside their undo window. */
export async function pendingCount(overdueOnly = false) {
  const now = Date.now();
  return (await all()).filter((e) => e.state === "pending" && (!overdueOnly || (e.notBefore ?? 0) <= now)).length;
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(drain, ms);
}

export async function drain() {
  if (draining) { again = true; return; }
  draining = true;
  let wait = null;
  try {
    again = false;
    const pending = (await all()).filter((e) => e.state === "pending").sort((a, b) => a.at - b.at);
    const now = Date.now();
    const entries = pending.filter((e) => (e.notBefore ?? 0) <= now);
    const later = pending.filter((e) => (e.notBefore ?? 0) > now).map((e) => e.notBefore - now);
    if (later.length) wait = Math.min(...later) + 20;
    for (const e of entries) {
      sending.add(e.clientId);
      try {
        const r = await answer(e.itemId, e.body);
        await remove(e.clientId);
        emit({ type: "saved", itemId: e.itemId, clientId: e.clientId, labelId: r.labelId });
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 400 || status === 404) {
          await put({ ...e, state: "rejected", error: err.message });
          emit({ type: "rejected", itemId: e.itemId, clientId: e.clientId, error: err.message });
        } else if (status === 401 || status === 403) {
          emit({ type: "auth" });
          wait = 30000;
          break;
        } else {
          e.tries += 1;
          await put(e);
          wait = RETRY_MS[Math.min(e.tries - 1, RETRY_MS.length - 1)];
          break; // keep order; retry the same answer first
        }
      } finally {
        sending.delete(e.clientId);
      }
    }
  } finally {
    draining = false;
    emit({ type: "pending", count: await pendingCount(), overdue: await pendingCount(true) });
  }
  if (wait != null) schedule(wait);
  else if (again) await drain();
}

addEventListener("online", () => drain());
