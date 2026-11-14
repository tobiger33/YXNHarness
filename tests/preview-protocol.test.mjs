import assert from "node:assert/strict";
import test from "node:test";
import {
  PREVIEW_PROTOCOL,
  createPreviewMessage,
  createSessionId,
  normalizeSelectedElements,
  parsePreviewMessage,
  withPreviewSession,
} from "../cockpit/preview-protocol.js";

test("preview protocol builds and parses session-bound envelopes", () => {
  const sessionId = createSessionId();
  assert.ok(sessionId.length >= 8);
  const message = createPreviewMessage(sessionId, "ready", {
    capabilities: { selection: true },
  });
  assert.equal(message.protocol, PREVIEW_PROTOCOL);
  assert.equal(message.version, 1);
  const parsed = parsePreviewMessage(message, { sessionId });
  assert.equal(parsed.type, "ready");
  assert.equal(parsed.payload.capabilities.selection, true);
  assert.equal(parsePreviewMessage(message, { sessionId: "other-session-id-xxxx" }), null);
  assert.equal(parsePreviewMessage({ ...message, protocol: "nope" }), null);
});

test("withPreviewSession injects harness and parent origin params", () => {
  const href = withPreviewSession("http://127.0.0.1:4173/", "session-abc-12345", "http://127.0.0.1:8787");
  const url = new URL(href);
  assert.equal(url.searchParams.get("harness"), "1");
  assert.equal(url.searchParams.get("yxnSession"), "session-abc-12345");
  assert.equal(url.searchParams.get("yxnParentOrigin"), "http://127.0.0.1:8787");
});

test("normalizeSelectedElements keeps multi-select payloads", () => {
  const elements = normalizeSelectedElements({
    elements: [
      { id: "ReviewButton", label: "Review", route: "/search", rect: { x: 1, y: 2, width: 3, height: 4 } },
      { id: "ConfirmButton", route: "/review" },
      { id: "", label: "skip" },
    ],
  });
  assert.equal(elements.length, 2);
  assert.equal(elements[0].id, "ReviewButton");
  assert.equal(elements[0].rect.width, 3);
  assert.equal(elements[1].label, "ConfirmButton");
});
