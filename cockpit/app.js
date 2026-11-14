import { mountPreview } from "/cockpit/preview.js";
import { mountHome } from "/cockpit/home.js";
import { mountAttachments } from "/cockpit/attachments.js";

const root = document.getElementById("yxn-workbench");
const q = (s) => root.querySelector(s);
const qa = (s) => [...root.querySelectorAll(s)];

const LAYOUT_KEY = "yxnharness.cockpit.layout.v1";
const UI_KEY = "yxnharness.cockpit.ui.v1";

const state = {
  view: "preview",
  branch: null,
  reviewBranch: null,
  mode: "connected",
  contexts: [],
  picks: [],
  model: "Codex",
  reasoning: "High",
  workspace: null,
  runs: [],
  handoffs: [],
  feedback: [],
  agent: null,
  review: null,
  activity: [],
};

let panels = {
  leftWidth: 175,
  rightWidth: 315,
  leftCollapsed: false,
  rightCollapsed: false,
};

let selecting = false;
let busy = false;
let noticeTimer = null;

try {
  const savedLayout = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
  if (savedLayout && typeof savedLayout === "object") panels = { ...panels, ...savedLayout };
  const savedUi = JSON.parse(localStorage.getItem(UI_KEY) || "null");
  if (savedUi && typeof savedUi === "object") {
    state.view = savedUi.view || state.view;
    state.mode = savedUi.mode || state.mode;
    state.contexts = Array.isArray(savedUi.contexts) ? savedUi.contexts : state.contexts;
    state.model = savedUi.model || state.model;
    state.reasoning = savedUi.reasoning || state.reasoning;
    state.reviewBranch = savedUi.reviewBranch || null;
  }
} catch {
  // ignore corrupt localStorage
}

const workspaceEl = q(".workspace");
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortId(id) {
  const value = String(id || "");
  if (value.length <= 24) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function formatTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function apiGet(pathname) {
  const response = await fetch(pathname, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.blockedReasons?.join("; ") || `${response.status}`);
  return data;
}

async function apiPost(pathname, body) {
  const response = await fetch(pathname, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.blockedReasons?.join("; ") || `${response.status}`);
  return data;
}

function persistLayout() {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(panels));
}

function persistUi() {
  localStorage.setItem(UI_KEY, JSON.stringify({
    view: state.view,
    mode: state.mode,
    contexts: state.contexts,
    model: state.model,
    reasoning: state.reasoning,
    reviewBranch: state.reviewBranch,
  }));
}

function toast(text) {
  const notice = q("#notice");
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 4200);
}

function icons() {
  globalThis.lucide?.createIcons?.({ attrs: { width: 15, height: 15 } });
}

function panelLimits(side) {
  const width = workspaceEl.clientWidth;
  if (side === "left") {
    return {
      min: 150,
      max: Math.max(150, Math.min(320, width - 300 - (window.innerWidth > 850 && !panels.rightCollapsed ? panels.rightWidth + 10 : 5))),
    };
  }
  return {
    min: 260,
    max: Math.max(260, Math.min(480, width - 300 - (!panels.leftCollapsed ? panels.leftWidth + 10 : 5))),
  };
}

function renderPanels() {
  const desktop = window.innerWidth > 850;
  const mobile = window.innerWidth <= 540;
  let left = clamp(Number(panels.leftWidth) || 175, 150, 320);
  let right = clamp(Number(panels.rightWidth) || 315, 260, 480);
  if (!mobile) {
    // A hidden workbench has width 0; use the shell to keep its saved geometry stable.
    const available = (workspaceEl.clientWidth || root.clientWidth) - 300 - (desktop ? 10 : 5);
    if (desktop && !panels.rightCollapsed) left = Math.min(left, Math.max(150, available - right));
    else left = Math.min(left, Math.max(150, available));
    if (desktop) right = Math.min(right, Math.max(260, available - (panels.leftCollapsed ? 0 : left)));
  }
  workspaceEl.style.setProperty("--left-width", `${left}px`);
  root.style.setProperty("--navigation-width", `${left}px`);
  workspaceEl.style.setProperty("--right-width", `${right}px`);
  workspaceEl.classList.toggle("left-collapsed", panels.leftCollapsed);
  workspaceEl.classList.toggle("right-collapsed", panels.rightCollapsed);
  q(".sidebar").hidden = panels.leftCollapsed;
  q(".agent").hidden = panels.rightCollapsed;
  ["left", "right"].forEach((side) => {
    const collapsed = panels[`${side}Collapsed`];
    const name = side === "left" ? "Workspace" : "Agent";
    const splitter = q(`.splitter-${side}`);
    splitter.hidden = collapsed;
    const limits = panelLimits(side);
    const value = Math.round(side === "left" ? left : right);
    splitter.setAttribute("aria-valuenow", value);
    splitter.setAttribute("aria-valuemin", limits.min);
    splitter.setAttribute("aria-valuemax", limits.max);
    splitter.setAttribute("aria-valuetext", `${value} pixels`);
    qa(`[data-toggle-panel="${side}"]`).forEach((button) => {
      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute("aria-label", name + (collapsed ? " einblenden" : " einklappen"));
      button.setAttribute("data-tooltip", name + (collapsed ? " einblenden" : " einklappen"));
    });
  });
}

function togglePanel(side) {
  panels[`${side}Collapsed`] = !panels[`${side}Collapsed`];
  renderPanels();
  persistLayout();
  if (panels[`${side}Collapsed`]) q(`.layout-controls [data-toggle-panel="${side}"]`)?.focus();
}

qa("[data-toggle-panel]").forEach((button) => {
  button.addEventListener("click", () => togglePanel(button.dataset.togglePanel));
});

qa(".panel-splitter").forEach((handle) => {
  const side = handle.dataset.resizePanel;
  const key = `${side}Width`;
  let drag = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const current = Number(handle.getAttribute("aria-valuenow"));
    drag = {
      start: event.clientX,
      width: Number.isFinite(current) ? current : (Number(panels[key]) || (side === "left" ? 175 : 315)),
    };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    root.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const limits = panelLimits(side);
    panels[key] = Math.round(clamp(
      drag.width + (event.clientX - drag.start) * (side === "left" ? 1 : -1),
      limits.min,
      limits.max,
    ));
    renderPanels();
  });
  const finish = () => {
    if (!drag) return;
    drag = null;
    handle.classList.remove("dragging");
    root.classList.remove("resizing");
    persistLayout();
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("lostpointercapture", finish);
  handle.addEventListener("dblclick", (event) => {
    event.preventDefault();
    panels[key] = side === "left" ? 175 : 315;
    renderPanels();
    persistLayout();
  });
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Enter") return togglePanel(side);
    const limits = panelLimits(side);
    const current = Number(handle.getAttribute("aria-valuenow")) || Number(panels[key]) || limits.min;
    // ArrowRight grows the panel under the splitter (left pane / right pane).
    const delta = (event.shiftKey ? 30 : 10) * (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0);
    panels[key] = event.key === "Home"
      ? limits.min
      : event.key === "End"
        ? limits.max
        : clamp(current + delta, limits.min, limits.max);
    renderPanels();
    persistLayout();
  });
});

new ResizeObserver(renderPanels).observe(workspaceEl);
renderPanels();

function pushActivity(text) {
  const stamp = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date());
  state.activity.unshift({ text, stamp });
  state.activity = state.activity.slice(0, 12);
  renderActivity();
}

function renderActivity() {
  q("#activity-count").textContent = String(state.activity.length);
  q("#activity-panel").innerHTML = state.activity.length
    ? state.activity.map((item) => `<div>✓ ${escapeHtml(item.text)} <span>${escapeHtml(item.stamp)}</span></div>`).join("")
    : `<div>No activity yet <span>—</span></div>`;
}

function setView(view, save = true) {
  if (!["preview", "compare", "changes"].includes(view)) return;
  state.view = view;
  qa("[role=tabpanel]").forEach((panel) => {
    panel.hidden = panel.id !== `screen-${view}`;
  });
  q("#extra-screen").hidden = true;
  qa(".tab").forEach((tab) => {
    const on = tab.dataset.view === view;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
  });
  qa("[data-nav]").forEach((item) => item.classList.toggle("active", item.dataset.nav === "workbench"));
  if (view === "changes") loadChanges().catch((error) => toast(error.message));
  if (save) persistUi();
  icons();
}

function renderChips() {
  const chips = q("#context-chips");
  chips.replaceChildren();
  state.contexts.forEach((label) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const icon = document.createElement("i");
    icon.dataset.lucide = label.includes("Screenshot") ? "image" : "crosshair";
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `${label} entfernen`);
    button.innerHTML = '<i data-lucide="x" aria-hidden="true"></i>';
    button.onclick = () => {
      state.contexts = state.contexts.filter((entry) => entry !== label);
      renderChips();
      persistUi();
    };
    chip.append(icon, text, button);
    chips.append(chip);
  });
  icons();
}

function addContext(label) {
  if (!state.contexts.includes(label)) state.contexts.push(label);
  renderChips();
  persistUi();
}

function setMode(mode, save = true) {
  state.mode = mode;
  qa("[data-mode]").forEach((button) => {
    const on = button.dataset.mode === mode;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  });
  const connected = Boolean(state.agent?.connected);
  if (mode === "external") {
    q("#composer-note").textContent = "External · copy a structured task for your coding agent";
    q("#chat-input").placeholder = "Describe a task for your external agent…";
  } else if (connected) {
    q("#composer-note").textContent = "Connected agent ready";
    q("#chat-input").placeholder = "Ask for a change, or describe an idea…";
  } else {
    q("#composer-note").textContent = "No agent adapter connected · messages become local feedback";
    q("#chat-input").placeholder = "Leave visual feedback… Comments are context, not instructions.";
  }
  q("#model").disabled = !connected;
  q("#reasoning").disabled = !connected;
  if (save) persistUi();
}

function renderBranches() {
  const list = q("#branches-list");
  const workspace = state.workspace;
  if (!workspace?.available) {
    list.innerHTML = `<p class="view-note">Not a Git workspace.</p>`;
    q("#branch-count").textContent = "0";
    return;
  }
  const branches = workspace.branches || [];
  q("#branch-count").textContent = String(branches.length);
  list.innerHTML = branches.map((entry) => {
    const selected = state.reviewBranch === entry.name || (!state.reviewBranch && entry.current);
    const meta = entry.current ? "current" : (entry.shortCommit || "");
    return `
      <button class="branch${selected ? " selected" : ""}" data-branch="${escapeHtml(entry.name)}">
        <i data-lucide="git-branch" aria-hidden="true"></i>
        <span>${escapeHtml(entry.name)}</span>
        ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
      </button>
    `;
  }).join("");
  list.querySelectorAll("[data-branch]").forEach((button) => {
    button.addEventListener("click", () => selectBranch(button.dataset.branch));
  });
  icons();
}

function renderRecent() {
  const host = q("#recent-activity");
  const rows = [];
  for (const run of (state.runs || []).slice(0, 2)) {
    rows.push(`
      <div class="recent"><i data-lucide="circle-check" aria-hidden="true"></i>
        <div>${escapeHtml(run.scenario?.name || run.scenario || shortId(run.runId))}
          <small>${escapeHtml(run.status || "—")} · ${escapeHtml(formatTime(run.finishedAt || run.startedAt))}</small>
        </div>
      </div>
    `);
  }
  for (const handoff of (state.handoffs || []).slice(0, 1)) {
    rows.push(`
      <div class="recent"><i data-lucide="package" aria-hidden="true"></i>
        <div>${escapeHtml(shortId(handoff.handoffId))}
          <small>handoff · ${escapeHtml(formatTime(handoff.createdAt))}</small>
        </div>
      </div>
    `);
  }
  host.innerHTML = rows.join("") || `<div class="recent"><i data-lucide="circle" aria-hidden="true"></i><div>No recent runs<small>Run a scenario to populate</small></div></div>`;
  icons();
}

function renderCompareSources() {
  const names = (state.workspace?.branches || []).map((entry) => entry.name);
  const fallback = names.length ? names : ["main"];
  for (const id of ["#source-a", "#source-b"]) {
    const select = q(id);
    const current = select.value;
    select.innerHTML = fallback.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    if (fallback.includes(current)) select.value = current;
    else if (id === "#source-b" && fallback.length > 1) select.selectedIndex = 1;
  }
}

function selectBranch(name) {
  state.reviewBranch = name;
  const current = state.workspace?.branch || "—";
  q("#active-branch").textContent = current;
  q("#chat-branch").textContent = current;
  q("#target-branch").textContent = current;
  q("#route").textContent = `branch://${name}`;
  renderBranches();
  persistUi();
  if (state.view === "changes") loadChanges().catch((error) => toast(error.message));
  else setView("changes");
}

// Local feedback only: no global overlay, and short requests never flash a loader.
const regionLoads = new Map();
function beginRegionLoad(name, label) {
  const previous = regionLoads.get(name);
  if (previous) clearTimeout(previous.timer);
  const status = q(`#${name}-status`);
  const target = q(name === "preview" ? "#puls-body" : "#changes-body");
  const operation = {};
  regionLoads.set(name, operation);
  status.hidden = true;
  status.classList.remove("is-error");
  status.querySelector("img").hidden = false;
  status.querySelector("button").hidden = true;
  target.setAttribute("aria-busy", "true");
  operation.timer = setTimeout(() => {
    status.querySelector("span").textContent = label;
    status.hidden = false;
  }, 200);
  return {
    current: () => regionLoads.get(name) === operation,
    finish(error = null) {
      if (regionLoads.get(name) !== operation) return;
      clearTimeout(operation.timer);
      target.setAttribute("aria-busy", "false");
      status.hidden = !error;
      if (error) {
        status.classList.add("is-error");
        status.querySelector("img").hidden = true;
        status.querySelector("span").textContent = name === "preview"
          ? "Workspace could not be loaded."
          : "Changes could not be loaded.";
        status.querySelector("button").hidden = false;
      }
    },
  };
}
function clearRegionLoad(name) {
  const previous = regionLoads.get(name);
  if (previous) clearTimeout(previous.timer);
  regionLoads.delete(name);
  q(`#${name}-status`).hidden = true;
  q(name === "preview" ? "#puls-body" : "#changes-body").setAttribute("aria-busy", "false");
}
q("#preview-retry").addEventListener("click", () => refresh());
q("#changes-retry").addEventListener("click", () => loadChanges());

async function loadChanges() {
  const body = q("#changes-body");
  const actions = q("#change-actions");
  const theirs = state.reviewBranch;
  const yours = state.workspace?.branch;
  if (!theirs || theirs === yours) {
    clearRegionLoad("changes");
    state.review = null;
    body.innerHTML = `<p class="view-note">Select another local branch to review its changes against <b>${escapeHtml(yours || "your branch")}</b>.</p>`;
    actions.hidden = true;
    q("#changes-count").textContent = "0";
    q("#changes-subtitle").textContent = "3-dot review against your current branch.";
    icons();
    return;
  }
  const operation = beginRegionLoad("changes", `Loading changes · ${theirs}`);
  actions.hidden = true;
  qa("[data-adopt-path]").forEach((button) => { button.disabled = true; });
  state.review = null;
  let failure = null;
  try {
    const review = await apiGet(`/api/v1/workspace/review?ref=${encodeURIComponent(theirs)}`);
    if (!operation.current()) return;
    const summary = review.summary || { filesChanged: 0, additions: 0, deletions: 0 };
    q("#changes-count").textContent = String(summary.filesChanged || 0);
    q("#changes-subtitle").textContent = `${yours} ← ${theirs}`;
    if (!review.files?.length) {
      body.innerHTML = `<p class="view-note">${escapeHtml(review.explanation || "No unique file changes.")}</p>`;
      actions.hidden = true;
      q("#changes-note").textContent = "No unique changes for the selected branch.";
      icons();
      return;
    }
    const filesHtml = [];
    for (const [index, file] of review.files.slice(0, 12).entries()) {
      let patch = "";
      const detailed = await apiGet(
        `/api/v1/workspace/review?ref=${encodeURIComponent(theirs)}&path=${encodeURIComponent(file.path)}`,
      );
      if (!operation.current()) return;
      patch = detailed.patch?.text || "";
      const lines = (patch || "").split("\n").slice(0, 80).map((line) => {
        let cls = "";
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "added";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "removed";
        return `<div class="${cls}"><span></span>${escapeHtml(line || " ")}</div>`;
      }).join("");
      filesHtml.push(`
        <details class="file-diff"${index === 0 ? " open" : ""}>
          <summary><i data-lucide="file-code-2" aria-hidden="true"></i>${escapeHtml(file.path)}
            <span>+${file.additions} −${file.deletions}</span>
            <button type="button" class="ghost file-adopt" data-adopt-path="${escapeHtml(file.path)}">Datei übernehmen</button>
          </summary>
          <div class="code">${lines || "<div><span></span>(no textual patch)</div>"}</div>
        </details>
      `);
    }
    body.innerHTML = `
      <div class="diff-summary">
        <span>${summary.filesChanged} files changed</span>
        <span class="diff-numbers">+${summary.additions} <em>−${summary.deletions}</em></span>
      </div>
      ${filesHtml.join("")}
      <label class="view-note" style="display:block;margin-top:12px">Optional note
        <textarea id="adopt-note" rows="2" placeholder="Optional merge note…" style="display:block;width:100%;margin-top:6px;border:1px solid var(--line);border-radius:6px;padding:8px;background:var(--bg)"></textarea>
      </label>
    `;
    state.review = review;
    actions.hidden = false;
    q("#changes-note").textContent = "Real git review · Design passt = approve+merge · Übernehmen = merge · Datei = one path.";
    const next = q("#approve-next");
    if (next) next.hidden = true;
    qa("[data-adopt-path]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        adoptSelected({ paths: [button.getAttribute("data-adopt-path")] });
      });
    });
    icons();
  } catch (error) {
    failure = error;
    if (operation.current()) {
      actions.hidden = true;
      q("#changes-note").textContent = "Review unavailable. Retry to load the selected branch.";
    }
  } finally {
    operation.finish(failure);
  }
}

function setChangesBusy(busy) {
  for (const id of ["#apply", "#approve-design", "#discard"]) {
    const button = q(id);
    if (button) button.disabled = busy;
  }
  qa("[data-adopt-path]").forEach((button) => { button.disabled = busy; });
}

function showApproveNext(plan) {
  const panel = q("#approve-next");
  const text = q("#approve-next-text");
  if (!panel || !text) return;
  const steps = (plan.next || []).slice(0, 3);
  text.textContent = [
    plan.explanation || "Design approved.",
    ...steps,
  ].filter(Boolean).join(" · ");
  panel.hidden = false;
}

async function adoptSelected({ paths = null } = {}) {
  const theirs = state.reviewBranch;
  if (!theirs || !state.review || q("#changes-body").getAttribute("aria-busy") === "true") return;
  if (q("#apply")?.disabled) return;
  const note = q("#adopt-note")?.value?.trim() || null;
  setChangesBusy(true);
  try {
    const payload = { ref: theirs, apply: false, comment: note };
    if (paths?.length) payload.paths = paths;
    const preview = await apiPost("/api/v1/workspace/adopt", payload);
    if (preview.status === "blocked") throw new Error(preview.blockedReasons?.join("; ") || "Blocked");
    if (preview.status === "noop") {
      toast(preview.explanation || "Already on that branch.");
      return;
    }
    const applied = await apiPost("/api/v1/workspace/adopt", { ...payload, apply: true });
    if (applied.status === "blocked") throw new Error(applied.blockedReasons?.join("; ") || "Adopt failed");
    toast(applied.explanation || (paths?.length ? `Adopted ${paths.join(", ")}.` : `Merged ${theirs}.`));
    pushActivity(paths?.length ? `Adopted file(s) from ${theirs}` : `Adopted ${theirs}`);
    if (!paths?.length) {
      state.reviewBranch = null;
      await refresh();
      setView("preview");
    } else {
      await refresh();
      setView("changes");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    setChangesBusy(false);
  }
}

async function approveDesign() {
  const theirs = state.reviewBranch;
  if (!theirs || !state.review || q("#changes-body").getAttribute("aria-busy") === "true") return;
  if (q("#approve-design")?.disabled) return;
  const note = q("#adopt-note")?.value?.trim() || "Design approved";
  setChangesBusy(true);
  try {
    const preview = await apiPost("/api/v1/workspace/approve", {
      ref: theirs,
      apply: false,
      note,
    });
    if (preview.status === "blocked") {
      throw new Error(preview.blockedReasons?.join("; ") || "Design approve blocked");
    }
    if (preview.status === "noop") {
      toast(preview.explanation || "Nothing to approve.");
      return;
    }
    const applied = await apiPost("/api/v1/workspace/approve", {
      ref: theirs,
      apply: true,
      note,
    });
    if (applied.status === "blocked") {
      throw new Error(applied.blockedReasons?.join("; ") || "Design approve failed");
    }
    toast(applied.explanation || `Design approved · ${theirs}`);
    pushActivity(`Design approved · ${theirs}`);
    showApproveNext(applied);
    state.reviewBranch = null;
    await refresh();
    setView("changes");
  } catch (error) {
    toast(error.message);
  } finally {
    setChangesBusy(false);
  }
}

function renderPicks() {
  qa("[data-element]").forEach((el) => {
    el.setAttribute("aria-pressed", String(state.picks.some((pick) => pick.element === el.dataset.element)));
  });
  q("#selection-count").textContent = `${state.picks.length} element${state.picks.length === 1 ? "" : "s"} selected`;
  q("#use-selection").disabled = !state.picks.length;
}

function renderChatSeed() {
  const feed = q("#chat-feed");
  const branch = state.workspace?.branch || "—";
  feed.innerHTML = `
    <div class="task-context"><i data-lucide="git-branch" aria-hidden="true"></i><span id="chat-branch">${escapeHtml(branch)}</span></div>
    <h2 class="task-title">Feedback &amp; agent</h2>
    <span class="task-subtitle" id="task-subtitle">${escapeHtml(state.agent?.connected ? "Connected" : "Local · no agent adapter connected")}</span>
  `;
  const open = (state.feedback || []).filter((thread) => thread.status === "open").slice(0, 6);
  for (const thread of open) {
    const user = document.createElement("div");
    user.className = "user-message";
    user.textContent = thread.preview || thread.threadId;
    feed.append(user);
    const meta = document.createElement("div");
    meta.className = "agent-event";
    meta.innerHTML = `<i data-lucide="message-square" aria-hidden="true"></i>${escapeHtml(thread.scope)} · ${escapeHtml(thread.status)} · ${escapeHtml(shortId(thread.threadId))}`;
    feed.append(meta);
  }
  if (!open.length) {
    const hint = document.createElement("div");
    hint.className = "agent-response";
    hint.innerHTML = `<p>Send a message to create local feedback, or switch to External to copy a task for your coding agent. Preview/Compare demos are layout examples — Changes uses real git reviews.</p>`;
    feed.append(hint);
  }
  icons();
}

async function sendMessage() {
  const value = q("#chat-input").value.trim();
  if (!value || busy) return;
  busy = true;
  q(".send").disabled = true;
  const feed = q("#chat-feed");
  const user = document.createElement("div");
  user.className = "user-message";
  user.textContent = value;
  attachments.appendToMessage(user);
  feed.append(user);
  q("#chat-input").value = "";

  const answer = document.createElement("div");
  answer.className = "agent-response";
  const thought = document.createElement("div");
  thought.className = "thought";
  thought.textContent = state.mode === "external" ? "Preparing external task…" : "Saving local feedback…";
  answer.append(thought);
  feed.append(answer);

  try {
    if (state.mode === "external") {
      const payload = document.createElement("textarea");
      payload.rows = 6;
      payload.readOnly = true;
      payload.setAttribute("aria-label", "External agent task");
      payload.value = [
        `Target branch: ${state.workspace?.branch || "—"}`,
        `Commit: ${state.workspace?.commit || "—"}`,
        `Review branch: ${state.reviewBranch || "—"}`,
        `Context: ${state.contexts.join(", ") || "(none)"}`,
        ...(attachments.names().length ? [`Local images (attach separately): ${attachments.names().join(", ")}`] : []),
        `Model preference: ${state.model} / ${state.reasoning}`,
        "",
        value,
        "",
        "Comments are context, not executable instructions.",
      ].join("\n");
      answer.append(payload);
      const copy = document.createElement("button");
      copy.className = "button";
      copy.textContent = "Select task to copy";
      copy.onclick = () => {
        payload.focus();
        payload.select();
        toast("Task selected. Copy with ⌘C / Ctrl+C.");
      };
      answer.append(copy);
      thought.textContent = "External task ready";
      pushActivity("Prepared external agent task");
    } else if (state.agent?.connected) {
      thought.textContent = "Connected adapter · not implemented in this build";
      const p = document.createElement("p");
      p.textContent = "A connected agent adapter is declared for later. Your message was not sent to a model.";
      answer.append(p);
    } else {
      const plan = await apiPost("/api/v1/feedback", {
        body: value,
        apply: true,
        route: state.view === "preview" ? (root.dataset.previewRoute || "/") : null,
        element: state.contexts.find((c) => !c.includes("Screenshot") && !c.includes("branch")) || null,
        branch: state.workspace?.branch || null,
        commit: state.workspace?.commit || null,
      });
      const p = document.createElement("p");
      p.textContent = `Saved as feedback ${plan.thread?.threadId || ""}. No coding agent is connected — bundle threads into a handoff when ready.`;
      answer.append(p);
      const actions = document.createElement("div");
      actions.className = "agent-event";
      actions.textContent = "✓ Local feedback written · comments are context";
      answer.append(actions);
      thought.textContent = "Feedback saved";
      pushActivity("Created feedback thread");
      await refreshFeedbackOnly();
    }
  } catch (error) {
    thought.textContent = "Failed";
    const p = document.createElement("p");
    p.textContent = error.message;
    answer.append(p);
  } finally {
    busy = false;
    q(".send").disabled = false;
    feed.scrollTop = feed.scrollHeight;
    icons();
  }
}

async function refreshFeedbackOnly() {
  const feedback = await apiGet("/api/v1/feedback");
  state.feedback = feedback.threads || [];
  q("#feedback-count").textContent = String(feedback.open ?? state.feedback.filter((t) => t.status === "open").length);
}

function showExtra(nav) {
  qa(".screen").forEach((screen) => {
    screen.hidden = true;
  });
  q("#extra-screen").hidden = false;
  qa("[data-nav]").forEach((item) => item.classList.toggle("active", item === nav));
  const kind = nav.dataset.nav;
  if (kind === "feedback") {
    q("#extra-title").textContent = "Feedback";
    q("#extra-subtitle").textContent = "Local visual threads tied to branch/commit/route/element.";
    q("#extra-content").innerHTML = (state.feedback || []).map((thread) => `
      <div class="extra-row">${escapeHtml(thread.preview || thread.threadId)}
        <small>${escapeHtml(thread.status)} · ${escapeHtml(thread.scope)} · ${escapeHtml(thread.branch || "—")} @ ${escapeHtml((thread.commit || "").slice(0, 7) || "—")}</small>
      </div>
    `).join("") || `<div class="extra-row">No feedback yet<small>Use the agent composer to add some</small></div>`;
  } else if (kind === "reviews") {
    q("#extra-title").textContent = "Reviews";
    q("#extra-subtitle").textContent = "Handoff packages ready for your coding agent.";
    q("#extra-content").innerHTML = (state.handoffs || []).map((item) => `
      <div class="extra-row">${escapeHtml(shortId(item.handoffId))}
        <small>${escapeHtml(formatTime(item.createdAt))} · ${escapeHtml(item.path || "")}</small>
      </div>
    `).join("") || `<div class="extra-row">No handoffs yet<small>npm run harness -- handoff --from last-green --apply</small></div>`;
  } else if (kind === "runs") {
    q("#extra-title").textContent = "Runs";
    q("#extra-subtitle").textContent = "Local harness evidence.";
    q("#extra-content").innerHTML = (state.runs || []).map((run) => `
      <div class="extra-row">${escapeHtml(run.scenario?.name || run.scenario || shortId(run.runId))}
        <small>${escapeHtml(run.status || "—")} · ${escapeHtml(formatTime(run.finishedAt || run.startedAt))}</small>
      </div>
    `).join("") || `<div class="extra-row">No runs yet<small>npm run harness -- run scenarios/minimal.yaml</small></div>`;
  }
  icons();
}

let pendingRefreshes = 0;

async function refresh() {
  const operation = beginRegionLoad("preview", "Refreshing workspace…");
  let failure = null;
  pendingRefreshes += 1;
  q("#workspace-brand").setAttribute("aria-busy", "true");
  q("#refresh").disabled = true;
  try {
    const [workspace, runsPayload, handoffsPayload, feedback, agent] = await Promise.all([
      apiGet("/api/v1/workspace"),
      apiGet("/api/v1/runs?refresh=0"),
      apiGet("/api/v1/handoffs"),
      apiGet("/api/v1/feedback"),
      apiGet("/api/v1/agent"),
    ]);
    if (!operation.current()) return false;
    state.workspace = workspace;
    home.update(workspace);
    state.runs = runsPayload.runs || [];
    state.handoffs = handoffsPayload.handoffs || [];
    state.feedback = feedback.threads || [];
    state.agent = agent;
    q("#project-name").textContent = (workspace.root || "workspace").split(/[/\\]/).filter(Boolean).pop() || "workspace";
    q("#active-branch").textContent = workspace.branch || "(detached)";
    q("#chat-branch").textContent = workspace.branch || "—";
    q("#target-branch").textContent = workspace.branch || "—";
    q("#runs-count").textContent = String(state.runs.length);
    q("#feedback-count").textContent = String(feedback.open ?? state.feedback.filter((t) => t.status === "open").length);
    q("#task-subtitle").textContent = agent.connected ? "Connected" : "Local · no agent adapter connected";
    q(".subtle").textContent = agent.connected ? "Connected" : "Local";
    renderBranches();
    renderRecent();
    renderCompareSources();
    renderChatSeed();
    setMode(state.mode, false);
    pushActivity("Workspace refreshed");
    icons();
    return true;
  } catch (error) {
    failure = error;
    home.failed();
    return false;
  } finally {
    operation.finish(failure);
    pendingRefreshes -= 1;
    q("#workspace-brand").setAttribute("aria-busy", String(pendingRefreshes > 0));
    q("#refresh").disabled = pendingRefreshes > 0;
  }
}

// Prototype-preserving interactions
qa("[data-view]").forEach((el) => el.addEventListener("click", () => setView(el.dataset.view)));
qa("[data-mode]").forEach((el) => el.addEventListener("click", () => setMode(el.dataset.mode)));
qa("[data-element]").forEach((el) => {
  el.addEventListener("click", () => {
    const existing = state.picks.findIndex((pick) => pick.element === el.dataset.element);
    if (existing >= 0) state.picks.splice(existing, 1);
    else {
      state.picks.push({
        element: el.dataset.element,
        source: el.dataset.element === "ContinueButton" ? q("#source-a").value : q("#source-b").value,
      });
    }
    renderPicks();
  });
});
q("#use-selection").addEventListener("click", async () => {
  if (!state.picks.length) return;
  const button = q("#use-selection");
  button.disabled = true;
  try {
    const note = q("#chat-input")?.value?.trim() || null;
    const elements = state.picks.map((pick) => ({
      id: pick.element,
      kind: "harness",
      label: pick.element,
      source: { branch: pick.source || null, elementId: pick.element },
    }));
    const preview = await apiPost("/api/v1/elements/adopt", {
      elements,
      body: note,
      route: "/",
      viewport: q("#device")?.value || "desktop",
      sourceBranch: elements[0]?.source?.branch || null,
      apply: false,
      withHandoff: false,
    });
    if (preview.status === "blocked") {
      throw new Error(preview.blockedReasons?.join("; ") || "Element adopt blocked");
    }
    const applied = await apiPost("/api/v1/elements/adopt", {
      elements,
      body: note,
      route: "/",
      viewport: q("#device")?.value || "desktop",
      sourceBranch: elements[0]?.source?.branch || null,
      apply: true,
      withHandoff: false,
    });
    if (applied.status === "blocked") {
      throw new Error(applied.blockedReasons?.join("; ") || "Element adopt failed");
    }
    state.picks.forEach((pick) => addContext(`${pick.element} · ${pick.source}`));
    state.picks = [];
    renderPicks();
    q("#chat-input").value = "";
    toast(applied.explanation || `Adopted ${elements.length} element(s) as feedback.`);
    pushActivity(`Element adopt · ${elements.map((item) => item.id).join(", ")}`);
    await refreshFeedbackOnly();
    renderChatSeed();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = !state.picks.length;
  }
});
function setTool(on) {
  selecting = on;
  root.classList.toggle("is-selecting", on);
  q("#select-tool").setAttribute("aria-pressed", String(on));
  q("#interact-tool").setAttribute("aria-pressed", String(!on));
  q("#select-tool").classList.toggle("active", on);
  q("#interact-tool").classList.toggle("active", !on);
  q("#inspect-target").classList.toggle("inspected", on);
  q("#element-label").hidden = !on;
}
q("#select-tool").addEventListener("click", () => setTool(true));
q("#interact-tool").addEventListener("click", () => setTool(false));
const attachments = mountAttachments(root, toast);
const home = mountHome(root, toast);
mountPreview(root, {
  selecting: () => selecting,
  select: addContext,
  interact: () => setTool(false),
  notify: toast,
});
q("#add-context").addEventListener("click", () => addContext(state.workspace?.branch || "branch"));
q("#device").addEventListener("change", (event) => {
  q("#app-preview").style.maxWidth = event.target.value === "mobile" ? "280px" : "100%";
});
q("#refresh").addEventListener("click", async () => {
  if (await refresh()) toast("Workspace refreshed.");
});
q("#activity-toggle").addEventListener("click", () => {
  const panel = q("#activity-panel");
  panel.hidden = !panel.hidden;
  q("#activity-toggle").setAttribute("aria-expanded", String(!panel.hidden));
});
q("#apply").addEventListener("click", () => adoptSelected());
q("#approve-design")?.addEventListener("click", () => approveDesign());
q("#approve-next-dismiss")?.addEventListener("click", () => {
  const panel = q("#approve-next");
  if (panel) panel.hidden = true;
});
q("#approve-fetch")?.addEventListener("click", async () => {
  const button = q("#approve-fetch");
  if (button) button.disabled = true;
  try {
    const preview = await apiPost("/api/v1/workspace/fetch", { apply: false });
    if (preview.status === "blocked") {
      throw new Error(preview.blockedReasons?.join("; ") || "Fetch blocked");
    }
    const applied = await apiPost("/api/v1/workspace/fetch", { apply: true });
    if (applied.status === "blocked") {
      throw new Error(applied.blockedReasons?.join("; ") || "Fetch failed");
    }
    toast(applied.explanation || "Remotes refreshed.");
    pushActivity("Fetched remotes after design approve");
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
});
q("#discard").addEventListener("click", () => {
  state.reviewBranch = null;
  const next = q("#approve-next");
  if (next) next.hidden = true;
  renderBranches();
  loadChanges();
  toast("Selection cleared.");
});
q("#model").addEventListener("change", (event) => {
  state.model = event.target.value;
  persistUi();
});
q("#reasoning").addEventListener("change", (event) => {
  state.reasoning = event.target.value;
  persistUi();
});
qa("[data-nav]").forEach((item) => {
  item.addEventListener("click", () => {
    if (item.dataset.nav === "workbench") return setView(state.view);
    showExtra(item);
  });
});
q("#back-workbench").addEventListener("click", () => setView(state.view));
q("#share-preview")?.addEventListener("click", async () => {
  const button = q("#share-preview");
  if (button) button.disabled = true;
  try {
    const plan = await apiPost("/api/v1/share", { apply: false, note: "Cockpit share preview" });
    const feed = q("#chat-feed");
    const card = document.createElement("div");
    card.className = "agent-response";
    const title = document.createElement("div");
    title.className = "thought";
    title.textContent = `Share ${plan.status || "preview"} · grant ${plan.access?.grant || "view"}`;
    card.append(title);
    const body = document.createElement("p");
    body.textContent = plan.explanation
      || plan.blockedReasons?.join("; ")
      || "Share invite dry-run complete.";
    card.append(body);
    if (plan.manifest?.designApproval?.hostSaysYesMeans) {
      const next = document.createElement("div");
      next.className = "agent-event";
      next.textContent = plan.manifest.designApproval.hostSaysYesMeans;
      card.append(next);
    }
    feed.append(card);
    feed.scrollTop = feed.scrollHeight;
    pushActivity(`Share preview · ${plan.status || "ready"}`);
    toast(plan.status === "blocked"
      ? (plan.blockedReasons?.[0] || "Share blocked")
      : `Share dry-run: ${plan.access?.grant || "view"} only`);
    icons();
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
});
q("#new-chat").addEventListener("click", () => {
  state.contexts = [];
  void attachments.clear();
  renderChips();
  renderChatSeed();
  persistUi();
  toast("Composer context cleared.");
});
q("#chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    q(".send").click();
  }
});
q(".send").addEventListener("click", () => sendMessage());

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "1") {
    event.preventDefault();
    setView(state.view);
    qa("[data-nav]").forEach((item) => item.classList.toggle("active", item.dataset.nav === "workbench"));
  }
});

q("#model").value = state.model;
q("#reasoning").value = state.reasoning;
renderChips();
renderPicks();
renderActivity();
setView(state.view, false);
setMode(state.mode, false);
refresh();
