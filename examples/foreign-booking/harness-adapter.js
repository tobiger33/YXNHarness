/**
 * Thin adapter: maps the existing Harbor Desk store onto window.__harness.
 * Added when attaching YXNHarness to an existing app — does not replace product APIs.
 */
import { bookingStore } from "./store.js";

const handlers = new Map();

function enabled() {
  return window.__HARNESS_ENABLED__ === true ||
    new URLSearchParams(window.location.search).get("harness") === "1";
}

function commands() {
  return [
    {
      name: "setCity",
      description: "Set the destination city.",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    {
      name: "setNights",
      description: "Set the number of nights (1-14).",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "number" } },
      },
    },
    {
      name: "goReview",
      description: "Move from search to review.",
      payloadSchema: { type: "null" },
    },
    {
      name: "goConfirm",
      description: "Confirm the booking.",
      payloadSchema: { type: "null" },
    },
    {
      name: "reset",
      description: "Start a new search.",
      payloadSchema: { type: "null" },
    },
  ];
}

const actions = {
  setCity(payload) {
    bookingStore.setCity(payload.value);
    return { city: bookingStore.getState().city };
  },
  setNights(payload) {
    bookingStore.setNights(payload.value);
    return { nights: bookingStore.getState().nights };
  },
  goReview() {
    const result = bookingStore.goReview();
    if (!result.ok) return { ok: false, error: { code: "invalid_state", message: result.error } };
    return { step: bookingStore.getState().step };
  },
  goConfirm() {
    const result = bookingStore.goConfirm();
    if (!result.ok) return { ok: false, error: { code: "invalid_state", message: result.error } };
    return { step: bookingStore.getState().step };
  },
  reset() {
    bookingStore.reset();
    return { step: bookingStore.getState().step };
  },
};

function exposeHarness() {
  if (!enabled()) return;

  const clock = {
    current: 0,
    paused: true,
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new TypeError("advance expects non-negative ms");
      this.current += ms;
      return { time: this.current };
    },
    seek(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new TypeError("seek expects non-negative ms");
      this.current = ms;
      return { time: this.current };
    },
    now() { return this.current; },
  };

  bookingStore.subscribe(({ reason, state }) => {
    for (const handler of handlers.get("statechange") || []) {
      handler(new CustomEvent("statechange", { detail: { reason, state } }));
    }
  });

  const api = {
    version: 1,
    state: () => bookingStore.getState(),
    commands,
    async command(name, payload) {
      const available = commands();
      const action = actions[name];
      if (!action) {
        return {
          ok: false,
          error: {
            code: "unknown_command",
            message: `Unknown command "${name}".`,
            validCommands: available.map((item) => item.name),
          },
        };
      }
      const descriptor = available.find((item) => item.name === name);
      if (descriptor.payloadSchema.type === "null") {
        if (payload !== undefined && payload !== null) {
          return { ok: false, error: { code: "invalid_payload", message: `Invalid payload for "${name}".` } };
        }
      } else if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, error: { code: "invalid_payload", message: `Invalid payload for "${name}".` } };
      } else if (name === "setCity" && typeof payload.value !== "string") {
        return { ok: false, error: { code: "invalid_payload", message: `Invalid payload for "${name}".` } };
      } else if (name === "setNights" && typeof payload.value !== "number") {
        return { ok: false, error: { code: "invalid_payload", message: `Invalid payload for "${name}".` } };
      }

      try {
        const value = action(payload || {});
        if (value && value.ok === false) return value;
        return { ok: true, value: value === undefined ? undefined : structuredClone(value) };
      } catch (error) {
        return { ok: false, error: { code: "command_failed", message: error.message } };
      }
    },
    on(event, handler) {
      if (!["statechange", "animationend", "error"].includes(event) || typeof handler !== "function") {
        throw new TypeError("Unsupported harness event or handler.");
      }
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    clock: {
      pause: () => clock.pause(),
      resume: () => clock.resume(),
      advance: (ms) => clock.advance(ms),
      seek: (ms) => clock.seek(ms),
      now: () => clock.now(),
    },
  };

  Object.defineProperty(window, "__harness", {
    configurable: false,
    enumerable: false,
    value: Object.freeze(api),
    writable: false,
  });
}

exposeHarness();
