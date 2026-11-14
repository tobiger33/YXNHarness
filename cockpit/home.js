const STORAGE_KEY = "yxnharness.repositories.v1";

export function mountHome(root, notify) {
  const home = root.querySelector("#home-page");
  const workspace = root.querySelector(".workspace");
  const list = root.querySelector("#repository-list");
  const search = root.querySelector("#repository-search");
  const heading = root.querySelector("#home-title");
  const dialog = root.querySelector("#add-workspace-dialog");
  const form = dialog.querySelector("form");
  const error = dialog.querySelector(".home-form-error");
  const currentUrl = new URL(location.pathname, location.origin).href;
  let current = null;
  let filter = "all";
  let repositories = [];
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(stored)) repositories = stored.filter(validRecord).slice(0, 50);
  } catch { /* A damaged registry must not prevent opening the workbench. */ }

  function workspaceUrl(value) {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("Use HTTPS or a local workspace address.");
    if (url.username || url.password || url.search) throw new Error("Use a workspace address without credentials or query parameters.");
    url.hash = "";
    return url.href;
  }
  function validRecord(record) {
    try { return typeof record.name === "string" && record.name.length <= 100 && workspaceUrl(record.url) === record.url; }
    catch { return false; }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(repositories)); }
    catch { notify("Workspace list could not be saved in this browser."); }
  }
  function icon(name) {
    const element = document.createElement("i");
    element.dataset.lucide = name;
    element.setAttribute("aria-hidden", "true");
    return element;
  }
  function markOpened(url) {
    const record = repositories.find((entry) => entry.url === url);
    if (record) { record.lastOpened = Date.now(); save(); }
  }
  function openHref(url) {
    const target = new URL(url);
    target.hash = "/workspace";
    return target.href;
  }
  function render() {
    const query = search.value.trim().toLowerCase();
    const visible = repositories.filter((repo) => (filter !== "recent" || repo.lastOpened) && `${repo.name} ${repo.root || ""} ${repo.url}`.toLowerCase().includes(query))
      .sort((a, b) => Number(b.url === currentUrl) - Number(a.url === currentUrl) || (b.lastOpened || 0) - (a.lastOpened || 0));
    list.replaceChildren();
    root.querySelector("#repository-count").textContent = String(repositories.length);
    root.querySelectorAll("[data-home-filter]").forEach((button) => {
      const selected = button.dataset.homeFilter === filter;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    for (const repo of visible) {
      const connected = repo.url === currentUrl && current;
      const card = document.createElement("article");
      card.className = "repository-card";
      const link = document.createElement("a");
      link.className = "repository-open";
      link.href = repo.url === currentUrl ? "#/workspace" : openHref(repo.url);
      link.setAttribute("aria-label", `Open ${repo.name}`);
      link.addEventListener("click", () => markOpened(repo.url));
      const glyph = document.createElement("span");
      glyph.className = "repository-icon";
      glyph.append(icon("folder-git-2"));
      const copy = document.createElement("div");
      copy.className = "repository-copy";
      const name = document.createElement("h2");
      name.textContent = repo.name;
      const path = document.createElement("p");
      path.className = "repository-path";
      path.textContent = repo.root || repo.url;
      const meta = document.createElement("div");
      meta.className = "repository-meta";
      const status = document.createElement("span");
      status.className = "repository-status";
      status.textContent = connected ? "Connected locally" : "Saved workspace";
      meta.append(status);
      if (connected && current.branch) {
        const branch = document.createElement("span");
        branch.append(icon("git-branch"), document.createTextNode(current.branch));
        meta.append(branch);
      }
      if (connected && Number.isFinite(current.changedFiles)) {
        const changes = document.createElement("span");
        changes.textContent = current.changedFiles ? `${current.changedFiles} uncommitted files` : "Working tree clean";
        meta.append(changes);
      }
      copy.append(name, path, meta);
      const arrow = document.createElement("span");
      arrow.className = "repository-arrow";
      arrow.append(icon("arrow-up-right"));
      link.append(glyph, copy, arrow);
      card.append(link);
      if (repo.url !== currentUrl) {
        const remove = document.createElement("button");
        remove.className = "icon-button repository-remove";
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${repo.name} from overview`);
        remove.append(icon("x"));
        remove.onclick = () => { repositories = repositories.filter((entry) => entry.url !== repo.url); save(); render(); };
        card.append(remove);
      }
      list.append(card);
    }
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "home-empty";
      empty.textContent = query ? "No matching repositories." : filter === "recent" ? "Open a repository to find it here next time." : current ? "No repositories yet." : "Loading your connected workspace…";
      list.append(empty);
    }
    const resume = root.querySelector("#resume-workspace");
    resume.hidden = !current;
    if (current) resume.textContent = `Open ${current.name}`;
    globalThis.lucide?.createIcons();
  }
  function route(focus = false) {
    const isHome = location.hash !== "#/workspace";
    home.hidden = !isHome;
    workspace.hidden = isHome;
    root.classList.toggle("is-home", isHome);
    root.querySelector("#workspace-brand").setAttribute("aria-current", isHome ? "page" : "false");
    document.title = isHome ? "Repositories · YXNHarness" : `${current?.name || "Workspace"} · YXNHarness`;
    if (isHome) render();
    else markOpened(currentUrl);
    if (focus) (isHome ? heading : root.querySelector(".tab.active"))?.focus({ preventScroll: true });
  }
  search.addEventListener("input", render);
  root.querySelectorAll("[data-home-filter]").forEach((button) => button.onclick = () => { filter = button.dataset.homeFilter; render(); });
  root.querySelector("#resume-workspace").addEventListener("click", () => markOpened(currentUrl));
  root.querySelector("#add-workspace").onclick = () => { form.reset(); error.hidden = true; dialog.showModal(); };
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const name = form.elements.namedItem("name").value.trim();
      if (!name) throw new Error("Enter a repository name.");
      const url = workspaceUrl(form.elements.namedItem("url").value.trim());
      const existing = repositories.find((repo) => repo.url === url);
      if (existing) throw new Error("This workspace is already in your overview.");
      if (repositories.length >= 50) throw new Error("Remove a saved workspace before adding another.");
      repositories.push({ name, url, lastOpened: null });
      save(); render(); dialog.close();
      notify(`${name} added to your overview.`);
    } catch (reason) { error.textContent = reason.message; error.hidden = false; }
  });
  window.addEventListener("hashchange", () => route(true));
  route();
  return {
    update(workspaceData) {
      current = { ...workspaceData, name: (workspaceData.root || "workspace").split(/[/\\]/).filter(Boolean).pop() || "Workspace" };
      const prior = repositories.find((repo) => repo.url === currentUrl);
      const record = { name: current.name, root: workspaceData.root, url: currentUrl, lastOpened: prior?.lastOpened || (location.hash === "#/workspace" ? Date.now() : null) };
      repositories = [record, ...repositories.filter((repo) => repo.url !== currentUrl)];
      save(); render(); route();
    },
    failed() {
      if (!current && !repositories.length) {
        const message = document.createElement("p");
        message.className = "home-empty";
        message.textContent = "Workspace unavailable. Open the workbench to retry the connection.";
        list.replaceChildren(message);
        root.querySelector("#resume-workspace").hidden = false;
        root.querySelector("#resume-workspace").textContent = "Open workbench";
      }
    },
  };
}
