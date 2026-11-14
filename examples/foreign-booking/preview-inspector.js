/**
 * Opt-in live preview inspector for Harbor Desk.
 * Enabled only with ?harness=1&yxnSession=<id> (cockpit injects both).
 * Uses app-owned stable IDs — no DOM text scraping.
 */
import { bookingStore } from "./store.js";

const PROTOCOL = "yxn.preview";
const VERSION = 1;
const PARENT = window.parent !== window ? window.parent : null;

function params() {
  return new URLSearchParams(window.location.search);
}

function enabled() {
  return params().get("harness") === "1" && Boolean(sessionId());
}

function sessionId() {
  const value = params().get("yxnSession");
  return value && value.length >= 8 ? value : null;
}

function parentOrigin() {
  const value = params().get("yxnParentOrigin");
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function routeFor(step = bookingStore.getState().step) {
  return `/${step}`;
}

/** App-owned selectable targets. IDs are product contract, not inferred text. */
const TARGETS = [
  { id: "CityField", el: () => document.getElementById("city"), label: "City", steps: ["search"] },
  { id: "NightsField", el: () => document.getElementById("nights"), label: "Nights", steps: ["search"] },
  { id: "ReviewButton", el: () => document.getElementById("to-review"), label: "Review", steps: ["search"] },
  { id: "BackButton", el: () => document.getElementById("back-search"), label: "Back", steps: ["review"] },
  { id: "ConfirmButton", el: () => document.getElementById("to-confirm"), label: "Confirm", steps: ["review"] },
  { id: "NewSearchButton", el: () => document.getElementById("reset"), label: "New search", steps: ["done"] },
];

let mode = "interact";
let selectedIds = new Set();

function post(type, payload = null) {
  const targetOrigin = parentOrigin();
  if (!PARENT || !enabled() || !targetOrigin) return;
  PARENT.postMessage({
    protocol: PROTOCOL,
    version: VERSION,
    sessionId: sessionId(),
    type,
    requestId: null,
    payload,
  }, targetOrigin);
}

function capabilities() {
  return {
    selection: true,
    multiSelect: true,
    routeReporting: true,
    stylePreview: true,
    screenshots: false,
  };
}

const PREVIEW_STYLE_ID = "yxn-proposal-preview";
const PREVIEW_STYLE_MAX = 24_000;

function applyPreviewStyle(css) {
  const text = typeof css === "string" ? css : "";
  if (!text || text.length > PREVIEW_STYLE_MAX) {
    post("error", { message: "Preview style missing or too large." });
    return;
  }
  // Temporary host preview only — never executable content.
  if (/<\/?script/i.test(text)) {
    post("error", { message: "Preview style rejected." });
    return;
  }
  let style = document.getElementById(PREVIEW_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = PREVIEW_STYLE_ID;
    document.head.append(style);
  }
  style.textContent = text;
  post("preview-style-changed", { active: true });
}

function clearPreviewStyle() {
  document.getElementById(PREVIEW_STYLE_ID)?.remove();
  post("preview-style-changed", { active: false });
}

function visibleTargets() {
  const step = bookingStore.getState().step;
  return TARGETS.filter((target) => target.steps.includes(step) && target.el());
}

function describe(target) {
  const node = target.el();
  const rect = node.getBoundingClientRect();
  return {
    id: target.id,
    label: target.label,
    kind: "harness",
    route: routeFor(),
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
  };
}

function paint() {
  for (const target of TARGETS) {
    const node = target.el();
    if (!node) continue;
    node.classList.toggle("yxn-inspector-selected", selectedIds.has(target.id));
    node.classList.toggle("yxn-inspector-selectable", mode === "select" && target.steps.includes(bookingStore.getState().step));
  }
}

function setMode(next) {
  mode = next === "select" ? "select" : "interact";
  if (mode === "interact") {
    selectedIds.clear();
  }
  paint();
  post("mode-changed", { mode });
}

function emitSelection() {
  const elements = visibleTargets()
    .filter((target) => selectedIds.has(target.id))
    .map(describe);
  if (!elements.length) {
    post("selection-cleared", { reason: "empty" });
    return;
  }
  post("element-selected", { elements });
}

function onClick(event) {
  if (mode !== "select") return;
  const target = visibleTargets().find((entry) => entry.el() === event.target || entry.el()?.contains(event.target));
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  if (selectedIds.has(target.id)) selectedIds.delete(target.id);
  else selectedIds.add(target.id);
  paint();
  emitSelection();
}

function onKey(event) {
  if (event.key === "Escape" && mode === "select") {
    setMode("interact");
    post("selection-cleared", { reason: "escape" });
  }
}

function onMessage(event) {
  if (!enabled()) return;
  const expected = parentOrigin();
  if (!expected || event.origin !== expected) return;
  const data = event.data;
  if (!data || data.protocol !== PROTOCOL || data.version !== VERSION) return;
  if (data.sessionId !== sessionId()) return;
  if (data.type === "set-mode") {
    setMode(data.payload?.mode === "select" ? "select" : "interact");
    return;
  }
  if (data.type === "preview-style") {
    applyPreviewStyle(data.payload?.css);
    return;
  }
  if (data.type === "clear-preview-style") {
    clearPreviewStyle();
  }
}

function boot() {
  if (!enabled() || !PARENT || !parentOrigin()) return;
  document.documentElement.classList.add("yxn-inspector");
  window.addEventListener("message", onMessage);
  document.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);
  bookingStore.subscribe(() => {
    // Drop highlights that are no longer on this screen; keep draft identity in the host.
    const visible = new Set(visibleTargets().map((target) => target.id));
    let changed = false;
    for (const id of [...selectedIds]) {
      if (!visible.has(id)) {
        selectedIds.delete(id);
        changed = true;
      }
    }
    paint();
    post("route-changed", { route: routeFor(), step: bookingStore.getState().step });
    if (changed) emitSelection();
  });
  post("ready", {
    app: "harbor-desk",
    route: routeFor(),
    capabilities: capabilities(),
  });
  post("capabilities", capabilities());
  post("route-changed", { route: routeFor(), step: bookingStore.getState().step });
  paint();
}

boot();
