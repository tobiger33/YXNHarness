"use strict";

const state = {
  step: "details",
  name: "",
};

const elements = {
  details: document.querySelector("#details"),
  complete: document.querySelector("#complete"),
  name: document.querySelector("#name"),
  greeting: document.querySelector("#greeting"),
  progress: document.querySelector("#progress"),
  continue: document.querySelector("#continue"),
  back: document.querySelector("#back"),
};

const harnessHandlers = new Map();

function snapshot() {
  return {
    step: state.step,
    values: { name: state.name },
    canNext: state.step === "details" && state.name.trim().length > 0,
    canBack: state.step === "complete",
  };
}

function render() {
  elements.details.hidden = state.step !== "details";
  elements.complete.hidden = state.step !== "complete";
  elements.name.value = state.name;
  elements.progress.textContent = state.step === "details" ? "Step 1 of 2" : "Step 2 of 2";
  elements.greeting.textContent = state.name;
  elements.continue.disabled = !snapshot().canNext;
}

function goNext(reason) {
  if (!snapshot().canNext) {
    return { ok: false, error: { code: "invalid_state", message: "Enter a name before continuing." } };
  }
  state.step = "complete";
  render();
  dispatchStateChange(reason);
  return { step: state.step };
}

function goBack(reason) {
  state.step = "details";
  render();
  dispatchStateChange(reason);
  return { step: state.step };
}

function dispatchStateChange(reason) {
  const detail = { reason, state: snapshot() };
  window.dispatchEvent(new CustomEvent("app:statechange", { detail }));
  for (const handler of harnessHandlers.get("statechange") || []) {
    handler(new CustomEvent("statechange", { detail }));
  }
}

function commands() {
  return [
    {
      name: "setName",
      description: "Set the name used by the completion screen.",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    {
      name: "next",
      description: "Continue to the completion screen.",
      payloadSchema: { type: "null" },
    },
    {
      name: "back",
      description: "Return to the name entry screen.",
      payloadSchema: { type: "null" },
    },
  ];
}

const actions = {
  setName(payload) {
    state.name = payload.value.trim();
    render();
    dispatchStateChange("command:setName");
    return { name: state.name };
  },
  next: () => goNext("command:next"),
  back: () => goBack("command:back"),
};

function exposeHarness() {
  const enabled = window.__HARNESS_ENABLED__ === true ||
    new URLSearchParams(window.location.search).get("harness") === "1";
  if (!enabled) return;

  const animationClock = {
    current: 0,
    paused: true,
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    advance(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new TypeError("advance expects non-negative milliseconds.");
      }
      this.current += milliseconds;
      return { time: this.current };
    },
    seek(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new TypeError("seek expects non-negative milliseconds.");
      }
      this.current = milliseconds;
      return { time: this.current };
    },
    now() { return this.current; },
  };

  const api = {
    version: 1,
    state: snapshot,
    commands,
    async command(name, payload) {
      const available = commands();
      const action = actions[name];
      if (!action) {
        const error = {
          code: "unknown_command",
          message: `Unknown command "${name}".`,
          validCommands: available.map((item) => item.name),
        };
        for (const handler of harnessHandlers.get("error") || []) {
          handler(new CustomEvent("error", { detail: error }));
        }
        return {
          ok: false,
          error,
        };
      }

      const descriptor = available.find((item) => item.name === name);
      if (descriptor.payloadSchema.type === "null" ? payload !== undefined && payload !== null :
        !payload || typeof payload !== "object" || Array.isArray(payload) ||
        typeof payload.value !== "string") {
        return { ok: false, error: { code: "invalid_payload", message: `Invalid payload for "${name}".` } };
      }

      try {
        const value = action(payload || {});
        if (value && value.ok === false) return value;
        return { ok: true, value: value === undefined ? undefined : structuredClone(value) };
      } catch (error) {
        const detail = { code: "command_failed", message: error.message, command: name };
        for (const handler of harnessHandlers.get("error") || []) {
          handler(new CustomEvent("error", { detail }));
        }
        return { ok: false, error: { code: detail.code, message: detail.message } };
      }
    },
    on(event, handler) {
      if (!["statechange", "animationend", "error"].includes(event) || typeof handler !== "function") {
        throw new TypeError("Unsupported harness event or handler.");
      }
      if (!harnessHandlers.has(event)) harnessHandlers.set(event, new Set());
      harnessHandlers.get(event).add(handler);
    },
    off(event, handler) {
      harnessHandlers.get(event)?.delete(handler);
    },
    clock: {
      pause: () => animationClock.pause(),
      resume: () => animationClock.resume(),
      advance: (milliseconds) => animationClock.advance(milliseconds),
      seek: (milliseconds) => animationClock.seek(milliseconds),
      now: () => animationClock.now(),
    },
  };

  Object.defineProperty(window, "__harness", {
    configurable: false,
    enumerable: false,
    value: Object.freeze(api),
    writable: false,
  });
}

elements.name.addEventListener("input", () => {
  state.name = elements.name.value;
  render();
  dispatchStateChange("input");
});
elements.continue.addEventListener("click", () => {
  goNext("click:next");
});
elements.back.addEventListener("click", () => {
  goBack("click:back");
});

render();
exposeHarness();
