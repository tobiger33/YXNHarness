import { bookingStore } from "./store.js";

const els = {
  progress: document.getElementById("progress"),
  search: document.getElementById("search"),
  review: document.getElementById("review"),
  done: document.getElementById("done"),
  city: document.getElementById("city"),
  nights: document.getElementById("nights"),
  toReview: document.getElementById("to-review"),
  backSearch: document.getElementById("back-search"),
  toConfirm: document.getElementById("to-confirm"),
  summary: document.getElementById("summary"),
  receipt: document.getElementById("receipt"),
  reset: document.getElementById("reset"),
};

function render() {
  const state = bookingStore.getState();
  els.search.hidden = state.step !== "search";
  els.review.hidden = state.step !== "review";
  els.done.hidden = state.step !== "done";
  els.city.value = state.city;
  els.nights.value = String(state.nights);
  els.toReview.disabled = !state.canReview;
  els.progress.textContent =
    state.step === "search" ? "Step 1 of 3" :
    state.step === "review" ? "Step 2 of 3" :
    "Step 3 of 3";
  els.summary.textContent = `${state.nights} night${state.nights === 1 ? "" : "s"} in ${state.city}`;
  els.receipt.textContent = `Harbor Desk reserved ${state.nights} night${state.nights === 1 ? "" : "s"} in ${state.city}.`;
}

els.city.addEventListener("input", () => bookingStore.setCity(els.city.value));
els.nights.addEventListener("input", () => bookingStore.setNights(els.nights.value));
els.toReview.addEventListener("click", () => bookingStore.goReview());
els.backSearch.addEventListener("click", () => bookingStore.goSearch());
els.toConfirm.addEventListener("click", () => bookingStore.goConfirm());
els.reset.addEventListener("click", () => bookingStore.reset());

bookingStore.subscribe(render);
render();
