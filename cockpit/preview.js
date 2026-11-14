const PREVIEW_KEY = "yxnharness.preview.url.v1";

export function mountPreview(root, { selecting, select, interact, notify }) {
  const q = (selector) => root.querySelector(selector);
  const demo = q("#demo-preview");
  const frame = q("#live-preview");
  const surface = q("#app-preview");
  const dialog = q("#connect-preview-dialog");
  const form = dialog.querySelector("form");
  const status = q("#live-preview-status");
  let previewUrl = null;
  let loadingTimer;
  let timeout;
  let loadVersion = 0;

  function validUrl(value) {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && local))) throw new Error("Use an HTTPS or local application URL.");
    if (url.username || url.password) throw new Error("Use a URL without embedded credentials.");
    if (url.origin === location.origin) throw new Error("Use the app's development server address, not this workbench address.");
    return url.href;
  }
  function load(url) {
    previewUrl = url;
    interact();
    demo.hidden = true;
    frame.hidden = false;
    surface.classList.add("live-preview");
    q("#disconnect-preview").hidden = false;
    q("#select-tool").disabled = true;
    q("#select-tool").title = "Live element selection requires an inspector adapter. App navigation remains available.";
    q("#preview-kind").textContent = "Live application";
    q("#preview-external").href = url;
    q("#preview-external").hidden = false;
    q("#route").textContent = url;
    root.dataset.previewRoute = new URL(url).pathname;
    const version = ++loadVersion;
    clearTimeout(loadingTimer); clearTimeout(timeout);
    status.hidden = true;
    status.querySelector("img").hidden = false;
    status.querySelector("span").textContent = "Loading application…";
    status.querySelector("button").hidden = true;
    frame.setAttribute("aria-busy", "true");
    loadingTimer = setTimeout(() => { if (version === loadVersion) status.hidden = false; }, 200);
    timeout = setTimeout(() => {
      if (version !== loadVersion) return;
      clearTimeout(loadingTimer);
      status.querySelector("img").hidden = true;
      status.querySelector("span").textContent = "Still waiting for the app. Retry or open it in a new tab.";
      status.querySelector("button").hidden = false;
      status.hidden = false;
      frame.setAttribute("aria-busy", "false");
    }, 20000);
    frame.src = url;
  }
  frame.addEventListener("load", () => {
    if (!previewUrl) return;
    clearTimeout(loadingTimer); clearTimeout(timeout);
    frame.setAttribute("aria-busy", "false");
    status.hidden = true;
  });
  frame.addEventListener("error", () => {
    clearTimeout(loadingTimer); clearTimeout(timeout);
    status.querySelector("img").hidden = true;
    status.querySelector("span").textContent = "The app could not be loaded. Check its address or open it in a new tab.";
    status.querySelector("button").hidden = false;
    status.hidden = false;
    frame.setAttribute("aria-busy", "false");
  });
  q("#open-preview").onclick = () => {
    form.elements.namedItem("url").value = previewUrl || "";
    q("#preview-connect-error").hidden = true;
    dialog.showModal();
  };
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const url = validUrl(form.elements.namedItem("url").value.trim());
      load(url);
      try { localStorage.setItem(PREVIEW_KEY, url); } catch { /* still usable for this session */ }
      dialog.close();
    } catch (error) {
      q("#preview-connect-error").textContent = error.message;
      q("#preview-connect-error").hidden = false;
    }
  });
  status.querySelector("button").onclick = () => { if (previewUrl) load(previewUrl); };
  q("#refresh").addEventListener("click", () => { if (previewUrl) load(previewUrl); });
  q("#disconnect-preview").onclick = () => {
    previewUrl = null;
    ++loadVersion;
    clearTimeout(loadingTimer); clearTimeout(timeout);
    frame.removeAttribute("src"); frame.hidden = true;
    status.hidden = true;
    demo.hidden = false;
    surface.classList.remove("live-preview");
    q("#select-tool").disabled = false;
    q("#select-tool").removeAttribute("title");
    q("#disconnect-preview").hidden = true;
    q("#preview-external").hidden = true;
    q("#preview-kind").textContent = "Example application";
    const activeStep = [...demo.querySelectorAll("[data-demo-step]")].find((element) => !element.hidden)?.dataset.demoStep || "onboarding";
    q("#route").textContent = `example://puls/${activeStep}`;
    root.dataset.previewRoute = `/${activeStep}`;
    interact();
    try { localStorage.removeItem(PREVIEW_KEY); } catch { /* no persistence */ }
  };

  // The example uses native form validation and explicit navigation, just like a target app.
  function step(name) {
    for (const element of demo.querySelectorAll("[data-demo-step]")) element.hidden = element.dataset.demoStep !== name;
    q("#route").textContent = `example://puls/${name}`;
    root.dataset.previewRoute = `/${name}`;
  }
  // The example owns these stable IDs; never infer target app identity from DOM text.
  let hovered = null;
  function hover(element) {
    hovered?.classList.remove("demo-hover");
    hovered = element;
    hovered?.classList.add("demo-hover");
  }
  function choose(element) {
    for (const selected of demo.querySelectorAll(".demo-selected")) selected.classList.remove("demo-selected");
    element.classList.add("demo-selected");
    select({ id: element.dataset.demoElement, label: element.dataset.demoElement, kind: "harness", route: root.dataset.previewRoute, previewUrl: q("#route").textContent }, element);
  }
  demo.addEventListener("pointerover", (event) => {
    if (selecting()) hover(event.target.closest("[data-demo-element]"));
  });
  demo.addEventListener("pointerleave", () => hover(null));
  demo.addEventListener("click", (event) => {
    if (!selecting()) return;
    const element = event.target.closest("[data-demo-element]");
    if (!element || !demo.contains(element)) return;
    event.preventDefault();
    event.stopPropagation();
    choose(element);
  }, true);
  root.addEventListener("yxn:selection-clear", () => {
    hover(null);
    for (const element of demo.querySelectorAll(".demo-selected")) element.classList.remove("demo-selected");
  });
  const tabIndices = new Map();
  root.addEventListener("yxn:selection-mode", () => {
    hover(null);
    for (const element of demo.querySelectorAll("[data-demo-element]")) {
      if (selecting()) {
        if (!tabIndices.has(element)) tabIndices.set(element, element.getAttribute("tabindex"));
        if (!element.matches("button,input,select,textarea,a[href]")) element.tabIndex = 0;
      } else if (tabIndices.has(element)) {
        const original = tabIndices.get(element);
        if (original === null) element.removeAttribute("tabindex");
        else element.setAttribute("tabindex", original);
      }
    }
  });
  demo.addEventListener("keydown", (event) => {
    if (!selecting() || !["Enter", " "].includes(event.key)) return;
    const element = event.target.closest("[data-demo-element]");
    if (!element) return;
    event.preventDefault(); event.stopPropagation();
    choose(element);
  }, true);
  q("#inspect-target").addEventListener("click", () => { if (!selecting()) step("details"); });
  q("#demo-back").addEventListener("click", () => { if (!selecting()) step("onboarding"); });
  q("#demo-details-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (selecting()) return;
    q("#demo-complete-name").textContent = q("#demo-name").value.trim();
    step("complete");
  });
  q("#demo-edit").addEventListener("click", () => { if (!selecting()) step("details"); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selecting()) interact();
  });
  step("onboarding");
  try {
    const saved = localStorage.getItem(PREVIEW_KEY);
    if (saved) load(validUrl(saved));
  } catch { /* Ignore obsolete preview URLs. */ }
}
