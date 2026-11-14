// Draft images stay in this browser. Uploading them requires an agent/backend adapter.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 6;

export function mountAttachments(root, notify) {
  const tray = root.querySelector("#attachment-tray");
  const picker = root.querySelector("#attachment-picker");
  const dialog = root.querySelector("#attachment-viewer");
  const viewerImage = dialog.querySelector("img");
  const title = dialog.querySelector("h2");
  const details = dialog.querySelector(".attachment-details");
  const items = [];
  const urls = new Set();
  let revision = 0;
  let database;
  let captureBusy = false;
  let ingestion = Promise.resolve();
  let returnFocus;

  const opened = new Promise((resolve) => {
    const request = indexedDB.open("yxnharness.attachments.v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "id" });
    request.onsuccess = () => { database = request.result; resolve(database); };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  async function store(mode, action) {
    const db = await opened;
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", mode);
      const request = action(tx.objectStore("drafts"));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Image storage interrupted"));
    });
  }
  function hydrate(record) {
    const url = URL.createObjectURL(record.blob);
    urls.add(url);
    return { ...record, url };
  }
  function open(item) {
    returnFocus = document.activeElement;
    title.textContent = item.name;
    details.textContent = `${item.width} × ${item.height} · ${Math.max(1, Math.round(item.blob.size / 1024))} KB · Local attachment`;
    viewerImage.src = item.url;
    viewerImage.alt = item.name;
    if (!dialog.open) dialog.showModal();
  }
  function thumbnail(item, removable) {
    const card = document.createElement("div");
    card.className = "attachment-card";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "attachment-preview";
    preview.setAttribute("aria-label", `Open ${item.name}`);
    preview.title = item.name;
    const image = document.createElement("img");
    image.src = item.url;
    image.alt = "";
    const caption = document.createElement("span");
    caption.textContent = item.name;
    preview.append(image, caption);
    preview.onclick = () => open(item);
    card.append(preview);
    if (removable) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${item.name}`);
      remove.onclick = async () => {
        const index = items.findIndex((entry) => entry.id === item.id);
        if (index !== -1) items.splice(index, 1);
        render();
        if (!item.sent) { URL.revokeObjectURL(item.url); urls.delete(item.url); }
        try { await store("readwrite", (s) => s.delete(item.id)); }
        catch { notify("Image removed for this session; browser storage could not be updated."); }
      };
      card.append(remove);
    }
    return card;
  }
  function render() {
    tray.replaceChildren(...items.map((item) => thumbnail(item, true)));
    tray.hidden = items.length === 0;
  }
  const ready = store("readonly", (s) => s.getAll()).then((records) => {
    for (const record of (records || []).slice(0, MAX_IMAGES)) {
      if (record.blob instanceof Blob && IMAGE_TYPES.has(record.blob.type)) items.push(hydrate(record));
    }
    render();
  }).catch(() => notify("Saved image attachments could not be restored."));

  function addFiles(files) {
    const generation = revision;
    ingestion = ingestion.then(() => readFiles([...files], generation));
    return ingestion;
  }
  async function readFiles(files, generation) {
    await ready;
    for (const file of files) {
      if (generation !== revision) return;
      if (!IMAGE_TYPES.has(file.type)) { notify("Choose a PNG, JPEG, WebP or GIF image."); continue; }
      if (file.size > MAX_BYTES) { notify("Choose an image smaller than 12 MB."); continue; }
      if (items.length >= MAX_IMAGES) { notify("You can attach up to 6 images."); break; }
      let bitmap;
      try {
        bitmap = await createImageBitmap(file);
        const record = { id: crypto.randomUUID(), name: file.name || "Screenshot.png", blob: file, width: bitmap.width, height: bitmap.height };
        bitmap.close();
        if (generation !== revision) return;
        const item = hydrate(record);
        items.push(item);
        render();
        try { await store("readwrite", (s) => s.put(record)); }
        catch { notify("Image attached for this session; browser storage is unavailable."); }
      } catch {
        bitmap?.close();
        notify("This image could not be opened. Try another file.");
      }
    }
  }
  picker.addEventListener("change", async () => {
    const files = [...picker.files];
    picker.value = "";
    await addFiles(files);
  });
  root.querySelector("#screenshot").addEventListener("click", () => picker.click());
  root.querySelector("#chat-input").addEventListener("paste", (event) => {
    const images = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && IMAGE_TYPES.has(item.type)).map((item) => item.getAsFile()).filter(Boolean);
    if (images.length) { event.preventDefault(); void addFiles(images); }
  });
  dialog.querySelector(".attachment-close").onclick = () => dialog.close();
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => {
    viewerImage.removeAttribute("src");
    (returnFocus?.isConnected ? returnFocus : root.querySelector("#chat-input")).focus();
  });

  root.querySelector("#capture").addEventListener("click", async () => {
    if (captureBusy) return;
    if (!navigator.mediaDevices?.getDisplayMedia) { picker.click(); return; }
    captureBusy = true;
    const generation = revision;
    let stream;
    let video;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true });
      video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      if (!canvas.width || !canvas.height) throw new Error("No frame");
      canvas.getContext("2d").drawImage(video, 0, 0);
      // Stop screen sharing immediately after the still frame is captured.
      stream.getTracks().forEach((track) => track.stop());
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("No image");
      if (generation !== revision) return;
      await addFiles([new File([blob], `Screenshot-${new Date().toISOString().replaceAll(":", "-")}.png`, { type: "image/png" })]);
    } catch (error) {
      if (error.name !== "NotAllowedError" && error.name !== "AbortError") notify("Capture unavailable. Use Screenshot to choose an image instead.");
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
      captureBusy = false;
    }
  });
  return {
    appendToMessage(message) {
      if (!items.length) return;
      const group = document.createElement("div");
      group.className = "message-attachments";
      group.append(...items.map((item) => { item.sent = true; return thumbnail(item, false); }));
      message.append(group);
    },
    names: () => items.map((item) => item.name),
    async clear() {
      revision += 1;
      await ready;
      items.length = 0;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      render();
      try { await store("readwrite", (s) => s.clear()); }
      catch { notify("Browser image storage could not be cleared."); }
    },
  };
}
