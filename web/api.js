// The labeling routes (docs/api.md). Same origin: the proxy in front adds the token, so the browser holds none.

const BASE = "/api/v1/labeling";

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ? `${body.field ?? "request"}: ${body.error}` : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call(path, init) {
  const r = await fetch(BASE + path, { ...init, headers: { Accept: "application/json", ...init?.headers } });
  if (!r.ok) {
    let body = null;
    try { body = await r.json(); } catch { /* not JSON */ }
    throw new ApiError(r.status, body);
  }
  return r.status === 204 ? null : r.json();
}

export const tasks = () => call("/tasks");

export const next = (task, limit = 30) => call(`/next?task=${encodeURIComponent(task)}&limit=${limit}`);

export const answer = (itemId, body) =>
  call(`/${itemId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const voicePending = () => call("/voice/pending");

export const voiceConfirm = (labelIds) =>
  call("/voice/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labelIds }) });

/** A clip as a blob URL. Clips are never written to the browser's caches (the server sends no-store). */
export async function clip(itemId, context = 0) {
  const r = await fetch(`${BASE}/${itemId}/clip?context=${context}`, { cache: "no-store" });
  if (!r.ok) throw new ApiError(r.status, null);
  return URL.createObjectURL(await r.blob());
}
