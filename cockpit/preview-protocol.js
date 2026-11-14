/** Shared helpers for the yxn.preview inspector postMessage contract (v1). */

export const PREVIEW_PROTOCOL = "yxn.preview";
export const PREVIEW_PROTOCOL_VERSION = 1;
export const PREVIEW_MESSAGE_TYPES = Object.freeze([
  "ready",
  "capabilities",
  "set-mode",
  "mode-changed",
  "route-changed",
  "element-selected",
  "selection-cleared",
  "error",
]);

const MAX_JSON_CHARS = 32_000;

export function createSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `yxn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createPreviewMessage(sessionId, type, payload = null, requestId = null) {
  if (!sessionId || typeof sessionId !== "string") throw new TypeError("sessionId required");
  if (!PREVIEW_MESSAGE_TYPES.includes(type)) throw new TypeError(`Unsupported type "${type}"`);
  return {
    protocol: PREVIEW_PROTOCOL,
    version: PREVIEW_PROTOCOL_VERSION,
    sessionId,
    type,
    requestId: requestId || null,
    payload: payload == null ? null : payload,
  };
}

export function parsePreviewMessage(data, { sessionId = null } = {}) {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.protocol !== PREVIEW_PROTOCOL || data.version !== PREVIEW_PROTOCOL_VERSION) return null;
  if (typeof data.sessionId !== "string" || data.sessionId.length < 8 || data.sessionId.length > 80) {
    return null;
  }
  if (sessionId && data.sessionId !== sessionId) return null;
  if (!PREVIEW_MESSAGE_TYPES.includes(data.type)) return null;
  let encoded;
  try {
    encoded = JSON.stringify(data);
  } catch {
    return null;
  }
  if (encoded.length > MAX_JSON_CHARS) return null;
  return {
    protocol: PREVIEW_PROTOCOL,
    version: PREVIEW_PROTOCOL_VERSION,
    sessionId: data.sessionId,
    type: data.type,
    requestId: typeof data.requestId === "string" ? data.requestId : null,
    payload: data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
      ? data.payload
      : null,
  };
}

export function withPreviewSession(url, sessionId, parentOrigin = null) {
  const target = new URL(url);
  target.searchParams.set("harness", "1");
  target.searchParams.set("yxnSession", sessionId);
  if (parentOrigin) target.searchParams.set("yxnParentOrigin", parentOrigin);
  return target.href;
}

export function normalizeSelectedElements(payload) {
  if (!payload || typeof payload !== "object") return [];
  const raw = Array.isArray(payload.elements)
    ? payload.elements
    : payload.element
      ? [payload.element]
      : [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || id.length > 120) continue;
    const rect = entry.rect && typeof entry.rect === "object"
      ? {
          x: Number(entry.rect.x) || 0,
          y: Number(entry.rect.y) || 0,
          width: Number(entry.rect.width) || 0,
          height: Number(entry.rect.height) || 0,
        }
      : null;
    out.push({
      id,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id,
      kind: typeof entry.kind === "string" ? entry.kind : "harness",
      route: typeof entry.route === "string" && entry.route.trim() ? entry.route.trim() : "/",
      rect,
    });
  }
  return out;
}
