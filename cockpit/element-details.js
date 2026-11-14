// Serializable, inert previews of registered example components; no executable HTML.
const tags = new Set(["div", "span", "b", "strong", "small", "p", "h1", "h2", "h3", "label", "input", "button", "fieldset", "legend", "form", "br"]);
const classes = new Set(["goal", "puls-continue", "puls-safe", "step", "step-track", "demo-form"]);
export function snapshotElement(element, depth = 0) {
  if (depth > 7) return null;
  if (element.nodeType === Node.TEXT_NODE) return { text: element.textContent.slice(0, 1500) };
  const tag = element.tagName?.toLowerCase();
  if (!tags.has(tag)) return null;
  return { tag, classes: [...element.classList].filter((name) => classes.has(name)), type: ["text", "email", "number", "radio", "checkbox"].includes(element.type) ? element.type : null, checked: Boolean(element.checked), placeholder: element.placeholder || "", children: [...element.childNodes].slice(0, 40).map((child) => snapshotElement(child, depth + 1)).filter(Boolean) };
}
function renderSnapshot(snapshot, depth = 0) {
  if (!snapshot || depth > 7) return document.createTextNode("");
  if (typeof snapshot.text === "string") return document.createTextNode(snapshot.text.slice(0, 1500));
  if (!tags.has(snapshot.tag)) return document.createTextNode("");
  const node = document.createElement(snapshot.tag === "form" ? "div" : snapshot.tag);
  node.className = (Array.isArray(snapshot.classes) ? snapshot.classes : []).filter((name) => classes.has(name)).join(" ");
  if (snapshot.tag === "input") {
    node.type = ["text", "email", "number", "radio", "checkbox"].includes(snapshot.type) ? snapshot.type : "text";
    node.placeholder = String(snapshot.placeholder || "").slice(0, 200);
    node.checked = Boolean(snapshot.checked);
    node.disabled = true;
  }
  if (snapshot.tag === "button") { node.type = "button"; node.disabled = true; }
  for (const child of (Array.isArray(snapshot.children) ? snapshot.children : []).slice(0, 40)) node.append(renderSnapshot(child, depth + 1));
  return node;
}
export function mountElementDetails(root, { save, notify, lookupPreview }) {
  const dialog = root.querySelector("#element-detail-dialog");
  const title = dialog.querySelector("h2");
  const meta = dialog.querySelector(".element-detail-meta");
  const preview = dialog.querySelector(".element-detail-preview");
  const comment = dialog.querySelector("textarea");
  const list = dialog.querySelector(".element-detail-list");
  const history = dialog.querySelector(".element-detail-history");
  const error = dialog.querySelector("[role=alert]");
  const saveButton = dialog.querySelector("[type=submit]");
  let model, index = 0, focusBack, afterSave;
  function render() {
    const element = model.elements[index];
    title.textContent = element.label || element.id;
    meta.textContent = `${element.route || "Unknown page"} · ${element.source?.branch || model.source?.branch || "Current branch"} · ${(element.source?.commit || model.source?.commit || "").slice(0, 7) || "Revision unavailable"}`;
    preview.replaceChildren();
    if (element.preview) preview.append(renderSnapshot(element.preview));
    else { const p = document.createElement("p"); p.textContent = "No visual snapshot stored for this element."; preview.append(p); }
    comment.value = element.comment || "";
    list.replaceChildren();
    model.elements.forEach((entry, entryIndex) => {
      const button = document.createElement("button"); button.type = "button";
      button.textContent = entry.label || entry.id; button.setAttribute("aria-pressed", String(entryIndex === index));
      button.onclick = () => { if (comment.value !== (element.comment || "")) { error.textContent = "Save or cancel your changes before switching elements."; error.hidden = false; return; } index = entryIndex; error.hidden = true; render(); };
      list.append(button);
    });
    list.hidden = model.elements.length < 2;
    history.replaceChildren();
    const revisions = element.commentHistory || [];
    for (const revision of [...revisions].reverse()) {
      const row = document.createElement("div"), time = document.createElement("small"), text = document.createElement("p");
      time.textContent = new Date(revision.at).toLocaleString(); text.textContent = revision.body;
      row.append(time, text); history.append(row);
    }
    dialog.querySelector("details").hidden = !revisions.length;
    saveButton.textContent = model.threadId ? "Neue Fassung speichern" : "Kommentar speichern";
    dialog.querySelector(".element-detail-note").textContent = model.threadId ? "A new revision is added to the saved feedback. Earlier messages remain available; no agent is rerun." : "Desired change for this element. Saving updates your draft; sending submits the current comments.";
  }
  dialog.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    if (comment.value.trim() === (model.elements[index].comment || "")) { dialog.close(); return; }
    saveButton.disabled = true; error.hidden = true;
    try { await save(model, index, comment.value.trim()); afterSave?.(model, index); dialog.close(); }
    catch (reason) { error.textContent = reason.message; error.hidden = false; }
    finally { saveButton.disabled = false; }
  };
  for (const button of dialog.querySelectorAll("[data-close]")) button.onclick = () => dialog.close();
  dialog.addEventListener("close", () => { (focusBack?.isConnected ? focusBack : root.querySelector("#chat-input")).focus(); });
  return {
    open(value, selectedIndex = 0, onSaved = null) {
      afterSave = onSaved;
      focusBack = document.activeElement;
      model = structuredClone(value); index = Math.min(selectedIndex, model.elements.length - 1);
      error.hidden = true; render();
      if (!dialog.open) dialog.showModal();
    },
    async openThread(threadId) {
      try {
        const response = await fetch(`/api/v1/feedback/${encodeURIComponent(threadId)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Feedback could not be opened.");
        const thread = data.thread || data;
        const identity = thread.identity || {};
        const element = identity.element || { id: threadId, label: "Comment" };
        this.open({ threadId, source: identity.source, elements: [{ ...element, label: element.label || element.id, route: identity.route, preview: lookupPreview?.(element.id, identity.route, identity.source?.commit || identity.commit), source: identity.source || { branch: identity.branch, commit: identity.commit }, comment: thread.messages?.at(-1)?.body || "", commentHistory: (thread.messages || []).map((message) => ({ body: message.body, at: message.createdAt })) }] });
      } catch (reason) { notify(reason.message); }
    },
  };
}
