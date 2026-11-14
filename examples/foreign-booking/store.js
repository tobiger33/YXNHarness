/**
 * Product store for Harbor Desk.
 * This is the app's own API — not harness-specific.
 */
const listeners = new Set();

const state = {
  step: "search",
  city: "",
  nights: 2,
};

function snapshot() {
  return {
    step: state.step,
    city: state.city,
    nights: state.nights,
    canReview: state.city.trim().length > 0 && state.nights >= 1,
    canConfirm: state.step === "review",
  };
}

function emit(reason) {
  const detail = { reason, state: snapshot() };
  for (const listener of listeners) listener(detail);
  window.dispatchEvent(new CustomEvent("booking:change", { detail }));
}

export const bookingStore = {
  getState: snapshot,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setCity(value) {
    state.city = String(value ?? "");
    emit("setCity");
  },
  setNights(value) {
    const nights = Number(value);
    state.nights = Number.isFinite(nights) ? Math.max(1, Math.min(14, Math.round(nights))) : 1;
    emit("setNights");
  },
  goReview() {
    if (!snapshot().canReview) {
      return { ok: false, error: "Pick a city and nights first." };
    }
    state.step = "review";
    emit("goReview");
    return { ok: true };
  },
  goConfirm() {
    if (state.step !== "review") {
      return { ok: false, error: "Review the stay before confirming." };
    }
    state.step = "done";
    emit("goConfirm");
    return { ok: true };
  },
  goSearch() {
    state.step = "search";
    emit("goSearch");
    return { ok: true };
  },
  reset() {
    state.step = "search";
    state.city = "";
    state.nights = 2;
    emit("reset");
    return { ok: true };
  },
};

window.HarborDesk = { store: bookingStore };
