const els = {
  refreshBtn: document.getElementById("refresh-btn"),
  branchCurrent: document.getElementById("branch-current"),
  branchesList: document.getElementById("branches-list"),
  reviewContext: document.getElementById("review-context"),
  reviewHeading: document.getElementById("review-heading"),
  reviewMeta: document.getElementById("review-meta"),
  reviewSummaryText: document.getElementById("review-summary-text"),
  reviewStats: document.getElementById("review-stats"),
  filesCount: document.getElementById("files-count"),
  filesList: document.getElementById("files-list"),
  composer: document.getElementById("composer"),
  adoptComment: document.getElementById("adopt-comment"),
  adoptCancel: document.getElementById("adopt-cancel"),
  adoptConfirm: document.getElementById("adopt-confirm"),
  diffTitle: document.getElementById("diff-title"),
  diffBody: document.getElementById("diff-body"),
  runsSummary: document.getElementById("runs-summary"),
  runsList: document.getElementById("runs-list"),
  runDetail: document.getElementById("run-detail"),
  handoffsList: document.getElementById("handoffs-list"),
  handoffDetail: document.getElementById("handoff-detail"),
  viewReview: document.getElementById("view-review"),
  viewRuns: document.getElementById("view-runs"),
  viewHandoffs: document.getElementById("view-handoffs"),
  agentStatus: document.getElementById("agent-status"),
  contextChips: document.getElementById("context-chips"),
  feedbackCount: document.getElementById("feedback-count"),
  feedbackList: document.getElementById("feedback-list"),
  threadDetail: document.getElementById("thread-detail"),
  threadTitle: document.getElementById("thread-title"),
  threadMessages: document.getElementById("thread-messages"),
  threadDone: document.getElementById("thread-done"),
  threadSelect: document.getElementById("thread-select"),
  agentActivity: document.getElementById("agent-activity"),
  selectedChips: document.getElementById("selected-chips"),
  feedbackBody: document.getElementById("feedback-body"),
  feedbackSend: document.getElementById("feedback-send"),
  bundleBtn: document.getElementById("bundle-btn"),
};

const state = {
  mode: "review",
  workspace: null,
  review: null,
  reviewFile: null,
  selectedBranch: null,
  selectedRun: null,
  selectedHandoff: null,
  adopting: false,
  feedback: [],
  selectedThreadId: null,
  selectedThread: null,
  bundleIds: new Set(),
  agent: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(iso, compact = false) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  if (compact) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusClass(status) {
  if (status === "passed") return "status-passed";
  if (status === "failed") return "status-failed";
  return "";
}

function shortId(id) {
  const value = String(id || "");
  if (value.length <= 28) return value;
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

async function apiGet(pathname) {
  const response = await fetch(pathname, { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.blockedReasons?.join("; ") || data.error || `${response.status} ${pathname}`;
    const error = new Error(message);
    error.payload = data;
    throw error;
  }
  return data;
}

async function apiPost(pathname, body) {
  const response = await fetch(pathname, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.blockedReasons?.join("; ") || data.error || `${response.status} ${pathname}`;
    const error = new Error(message);
    error.payload = data;
    throw error;
  }
  return data;
}

async function apiPatch(pathname, body) {
  const response = await fetch(pathname, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.blockedReasons?.join("; ") || data.error || `${response.status} ${pathname}`;
    const error = new Error(message);
    error.payload = data;
    throw error;
  }
  return data;
}

function emptyState(title, copy) {
  return `
    <div class="empty-state">
      <p class="empty-title">${escapeHtml(title)}</p>
      <p class="empty-copy">${escapeHtml(copy)}</p>
    </div>
  `;
}

function setMode(mode) {
  state.mode = mode;
  for (const tab of document.querySelectorAll(".mode-tab")) {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  }
  els.viewReview.hidden = mode !== "review";
  els.viewRuns.hidden = mode !== "runs";
  els.viewHandoffs.hidden = mode !== "handoffs";
  renderContextChips();
}

function chip(label, value) {
  if (value == null || value === "") return "";
  return `<span class="chip"><strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}</span>`;
}

function renderContextChips() {
  const workspace = state.workspace || {};
  const chips = [
    chip("branch", workspace.branch),
    chip("commit", workspace.shortCommit || (workspace.commit || "").slice(0, 7)),
  ];
  if (state.mode === "review" && state.selectedBranch) {
    chips.push(chip("review", state.selectedBranch));
  }
  if (state.mode === "runs" && state.selectedRun) {
    chips.push(chip("run", shortId(state.selectedRun)));
  }
  if (state.mode === "handoffs" && state.selectedHandoff) {
    chips.push(chip("handoff", shortId(state.selectedHandoff)));
  }
  if (state.selectedThread?.identity?.route) {
    chips.push(chip("route", state.selectedThread.identity.route));
  }
  if (state.selectedThread?.identity?.element?.id) {
    chips.push(chip("element", state.selectedThread.identity.element.id));
  }
  els.contextChips.innerHTML = chips.filter(Boolean).join("") || `<span class="chip">local solo</span>`;
}

function renderSelectedChips() {
  const ids = [...state.bundleIds];
  if (!ids.length) {
    els.selectedChips.hidden = true;
    els.selectedChips.innerHTML = "";
    els.bundleBtn.disabled = true;
    return;
  }
  els.selectedChips.hidden = false;
  els.selectedChips.innerHTML = ids.map((id) => (
    `<span class="chip chip-selected">${escapeHtml(shortId(id))}</span>`
  )).join("");
  els.bundleBtn.disabled = false;
  els.bundleBtn.textContent = `Bundle ${ids.length}`;
}

function renderAgentPanel() {
  const agent = state.agent || {};
  els.agentStatus.textContent = agent.connected
    ? (agent.adapter?.displayName || "Connected")
    : "Local · not connected";
  if (!agent.connected) {
    els.agentActivity.innerHTML = `<p class="activity-empty">${escapeHtml(agent.message || "No coding agent connected. Bundle feedback into a handoff for your agent.")}</p>`;
  } else if (!(agent.activity || []).length) {
    els.agentActivity.innerHTML = `<p class="activity-empty">Connected — waiting for agent events.</p>`;
  } else {
    els.agentActivity.innerHTML = (agent.activity || []).map((item) => (
      `<p>${escapeHtml(item)}</p>`
    )).join("");
  }
}

function renderFeedbackList() {
  const threads = state.feedback || [];
  const open = threads.filter((thread) => thread.status === "open").length;
  els.feedbackCount.textContent = threads.length ? `${open} open · ${threads.length}` : "none";
  if (!threads.length) {
    els.feedbackList.innerHTML = `<p class="empty-inline">No feedback yet. Add a note below.</p>`;
    return;
  }
  els.feedbackList.innerHTML = threads.map((thread) => {
    const active = state.selectedThreadId === thread.threadId ? " active" : "";
    const selected = state.bundleIds.has(thread.threadId) ? " selected-for-bundle" : "";
    const commit = (thread.commit || "").slice(0, 7) || "—";
    return `
      <button type="button" class="thread-item${active}${selected}" data-kind="thread" data-id="${escapeHtml(thread.threadId)}" role="listitem">
        <div class="thread-top">
          <span class="thread-scope">${escapeHtml(thread.scope || "general")}</span>
          <span class="thread-status ${escapeHtml(thread.status || "")}">${escapeHtml(thread.status || "")}</span>
        </div>
        <p class="thread-preview">${escapeHtml(thread.preview || "")}</p>
        <p class="thread-meta">${escapeHtml(thread.branch || "—")} @ ${escapeHtml(commit)}${thread.route ? ` · ${escapeHtml(thread.route)}` : ""}</p>
      </button>
    `;
  }).join("");
}

function paintThread(thread) {
  if (!thread) {
    els.threadDetail.hidden = true;
    return;
  }
  els.threadDetail.hidden = false;
  els.threadTitle.textContent = shortId(thread.threadId);
  els.threadDone.textContent = thread.status === "done" ? "Reopen" : "Done";
  els.threadSelect.textContent = state.bundleIds.has(thread.threadId) ? "Deselect" : "Select";
  els.threadMessages.innerHTML = (thread.messages || []).map((message) => `
    <article class="msg">
      <p class="msg-role">${escapeHtml(message.role)} · ${escapeHtml(formatTime(message.createdAt, true))}</p>
      <p class="msg-body">${escapeHtml(message.body)}</p>
    </article>
  `).join("");
  renderContextChips();
}

async function showThread(threadId) {
  state.selectedThreadId = threadId;
  renderFeedbackList();
  try {
    const payload = await apiGet(`/api/v1/feedback/${encodeURIComponent(threadId)}`);
    state.selectedThread = payload.thread;
    paintThread(payload.thread);
  } catch (error) {
    els.threadDetail.hidden = false;
    els.threadMessages.innerHTML = `<p class="empty-inline">${escapeHtml(error.message)}</p>`;
  }
}

function toggleBundle(threadId) {
  if (state.bundleIds.has(threadId)) state.bundleIds.delete(threadId);
  else state.bundleIds.add(threadId);
  renderSelectedChips();
  renderFeedbackList();
  if (state.selectedThread?.threadId === threadId) paintThread(state.selectedThread);
}

async function createFeedbackFromComposer() {
  const body = els.feedbackBody.value.trim();
  if (!body || els.feedbackSend.disabled) return;
  els.feedbackSend.disabled = true;
  els.feedbackSend.textContent = "Saving…";
  try {
    const payload = {
      body,
      apply: true,
      route: null,
      runId: state.mode === "runs" ? state.selectedRun : null,
    };
    const plan = await apiPost("/api/v1/feedback", payload);
    if (plan.status === "blocked") throw new Error(plan.blockedReasons?.join("; ") || "Create blocked");
    els.feedbackBody.value = "";
    await refreshFeedback();
    if (plan.thread?.threadId) await showThread(plan.thread.threadId);
  } catch (error) {
    els.agentActivity.innerHTML = `<p class="activity-empty">${escapeHtml(error.message)}</p>`;
  } finally {
    els.feedbackSend.disabled = false;
    els.feedbackSend.textContent = "Add feedback";
  }
}

async function markThreadDone() {
  const thread = state.selectedThread;
  if (!thread) return;
  const nextStatus = thread.status === "done" ? "open" : "done";
  await apiPatch(`/api/v1/feedback/${encodeURIComponent(thread.threadId)}`, {
    status: nextStatus,
    apply: true,
  });
  await refreshFeedback();
  await showThread(thread.threadId);
}

async function bundleSelected() {
  const ids = [...state.bundleIds];
  if (!ids.length) return;
  els.bundleBtn.disabled = true;
  els.bundleBtn.textContent = "Bundling…";
  try {
    const plan = await apiPost("/api/v1/feedback/bundle", {
      threadIds: ids,
      from: "last-green",
      apply: true,
    });
    if (plan.status === "blocked") throw new Error(plan.blockedReasons?.join("; ") || "Bundle blocked");
    state.bundleIds.clear();
    renderSelectedChips();
    await refresh({ keepSelection: true });
    setMode("handoffs");
    if (plan.handoff?.manifest?.handoffId) {
      await showHandoff(plan.handoff.manifest.handoffId);
    }
    els.agentActivity.innerHTML = `<p class="activity-empty">Bundled into ${escapeHtml(plan.handoffOut || "handoff")}. Give that package to your coding agent.</p>`;
  } catch (error) {
    els.agentActivity.innerHTML = `<p class="activity-empty">${escapeHtml(error.message)}</p>`;
  } finally {
    renderSelectedChips();
  }
}

async function refreshFeedback() {
  const [feedback, agent] = await Promise.all([
    apiGet("/api/v1/feedback"),
    apiGet("/api/v1/agent"),
  ]);
  state.feedback = feedback.threads || [];
  state.agent = agent;
  renderAgentPanel();
  renderFeedbackList();
  renderContextChips();
  renderSelectedChips();
  if (state.selectedThreadId) {
    const stillThere = state.feedback.some((thread) => thread.threadId === state.selectedThreadId);
    if (stillThere) await showThread(state.selectedThreadId);
    else {
      state.selectedThreadId = null;
      state.selectedThread = null;
      els.threadDetail.hidden = true;
    }
  }
}

function renderBranches(workspace) {
  if (!workspace?.available) {
    els.branchCurrent.textContent = "no git";
    els.branchesList.innerHTML = `<p class="empty-inline">Not a Git workspace.</p>`;
    renderContextChips();
    return;
  }
  const current = workspace.branch || "(detached)";
  const short = workspace.shortCommit || "";
  els.branchCurrent.textContent = `on ${current}${short ? ` @ ${short}` : ""}${workspace.dirty ? " · dirty" : ""}`;
  renderContextChips();

  const others = (workspace.branches || []).filter((entry) => !entry.current);
  if (!others.length) {
    els.branchesList.innerHTML = `<p class="empty-inline">No other local branches.</p>`;
    return;
  }

  els.branchesList.innerHTML = others.map((entry) => {
    const active = state.selectedBranch === entry.name ? " active" : "";
    return `
      <button type="button" class="branch-item${active}" data-kind="branch" data-id="${escapeHtml(entry.name)}" role="listitem">
        <span class="branch-name">${escapeHtml(entry.name)}</span>
        <span class="branch-meta">${escapeHtml(entry.shortCommit || "")}</span>
      </button>
    `;
  }).join("");
}

function renderDiffLines(text) {
  if (!text) {
    return `<div class="empty-state"><p class="empty-copy">No textual patch for this file.</p></div>`;
  }
  const lines = text.split("\n");
  return `<pre class="diff-code" aria-label="Unified diff">${lines.map((line) => {
    let kind = "";
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      kind = "meta";
    } else if (line.startsWith("@@")) {
      kind = "hunk";
    } else if (line.startsWith("+")) {
      kind = "add";
    } else if (line.startsWith("-")) {
      kind = "del";
    }
    return `<span class="diff-line ${kind}">${escapeHtml(line) || " "}</span>`;
  }).join("")}</pre>`;
}

function paintReview(review, selectedPath, message = null) {
  const yours = review.yours?.branch || "—";
  const theirs = review.theirs?.branch || "—";
  const summary = review.summary || { filesChanged: 0, additions: 0, deletions: 0 };

  els.reviewContext.hidden = false;
  els.composer.hidden = false;
  els.reviewHeading.textContent = theirs;
  els.reviewMeta.textContent = `${yours} ← ${theirs}`;
  els.reviewSummaryText.textContent = review.explanation || "Review changes on their branch since the merge-base.";
  els.reviewStats.innerHTML = `<span class="stat-add">+${summary.additions}</span> <span class="stat-del">-${summary.deletions}</span>`;
  els.filesCount.textContent = String(summary.filesChanged ?? 0);

  if (!review.files?.length) {
    els.filesList.innerHTML = `<p class="empty-inline">No unique file changes.</p>`;
    els.diffTitle.textContent = "";
    els.diffBody.innerHTML = `
      ${message ? `<div class="toast ${message.ok ? "toast-ok" : "toast-error"}">${escapeHtml(message.text)}</div>` : ""}
      ${emptyState("Nothing to adopt", review.explanation || "That branch has no unique changes.")}
    `;
    els.adoptConfirm.disabled = review.status === "blocked";
    return;
  }

  const path = selectedPath || review.files[0].path;
  els.filesList.innerHTML = review.files.map((file) => {
    const active = file.path === path ? " active" : "";
    return `
      <button type="button" class="file-item${active}" data-kind="file" data-id="${escapeHtml(file.path)}" role="listitem" title="${escapeHtml(file.path)}">
        <span class="file-path">${escapeHtml(file.path)}</span>
        <span class="file-stats"><span class="stat-add">+${file.additions}</span> <span class="stat-del">-${file.deletions}</span></span>
      </button>
    `;
  }).join("");

  els.diffTitle.textContent = path;
  const patchText = review.patch?.path === path ? review.patch.text : null;
  els.diffBody.innerHTML = `
    ${message ? `<div class="toast ${message.ok ? "toast-ok" : "toast-error"}">${escapeHtml(message.text)}</div>` : ""}
    <div class="diff-frame">
      <div class="diff-frame-head">${escapeHtml(path)}</div>
      ${patchText == null
    ? `<div class="empty-state"><p class="empty-copy">Loading patch…</p></div>`
    : renderDiffLines(patchText)}
    </div>
  `;
  els.adoptConfirm.disabled = state.adopting || review.status === "blocked";
  els.adoptConfirm.textContent = state.adopting ? "Übernehmen…" : "Übernehmen";
}

async function showReview(branchName, { path = null, message = null } = {}) {
  setMode("review");
  state.selectedBranch = branchName;
  state.reviewFile = path;
  renderBranches(state.workspace);
  els.diffBody.innerHTML = emptyState("Loading", "Fetching branch review…");
  els.reviewContext.hidden = false;
  els.composer.hidden = false;
  els.reviewHeading.textContent = branchName;
  els.reviewMeta.textContent = "Loading…";
  els.reviewSummaryText.textContent = "";
  els.reviewStats.textContent = "";
  els.filesList.innerHTML = "";

  try {
    const list = await apiGet(`/api/v1/workspace/review?ref=${encodeURIComponent(branchName)}`);
    state.review = list;
    const filePath = path || list.files?.[0]?.path || null;
    state.reviewFile = filePath;
    if (filePath) {
      const withPatch = await apiGet(
        `/api/v1/workspace/review?ref=${encodeURIComponent(branchName)}&path=${encodeURIComponent(filePath)}`,
      );
      state.review = withPatch;
      paintReview(withPatch, filePath, message);
    } else {
      paintReview(list, null, message);
    }
  } catch (error) {
    els.diffBody.innerHTML = emptyState("Review failed", error.message);
  }
}

async function adoptCurrent({ force = false } = {}) {
  if (!state.selectedBranch || state.adopting) return;
  const ref = state.selectedBranch;
  const comment = els.adoptComment.value.trim() || null;
  state.adopting = true;
  els.adoptConfirm.disabled = true;
  els.adoptConfirm.textContent = "Übernehmen…";
  try {
    const preview = await apiPost("/api/v1/workspace/adopt", { ref, apply: false, force, comment });
    if (preview.status === "blocked") {
      throw new Error(preview.blockedReasons?.join("; ") || "Adopt blocked");
    }
    if (preview.status === "noop") {
      await showReview(ref, { path: state.reviewFile, message: { ok: true, text: preview.explanation || "Already on that branch." } });
      return;
    }
    const applied = await apiPost("/api/v1/workspace/adopt", { ref, apply: true, force, comment });
    if (applied.status === "blocked") {
      throw new Error(applied.blockedReasons?.join("; ") || "Adopt failed");
    }
    els.adoptComment.value = "";
    await refresh({ keepSelection: false });
    els.reviewContext.hidden = true;
    els.composer.hidden = true;
    els.diffTitle.textContent = "";
    const noteLine = applied.comment
      ? `Note on merge commit: “${applied.comment}”`
      : "Taken as-is.";
    els.diffBody.innerHTML = emptyState(
      "Übernommen",
      `${applied.explanation || `Merged ${ref} into your branch.`} ${noteLine}`,
    );
  } catch (error) {
    const dirty = /dirty/i.test(error.message);
    await showReview(ref, {
      path: state.reviewFile,
      message: {
        ok: false,
        text: dirty
          ? `${error.message} Use Force after host consent.`
          : error.message,
      },
    });
    if (dirty) {
      els.adoptConfirm.dataset.force = "1";
      els.adoptConfirm.textContent = "Force Übernehmen";
      els.adoptCancel.hidden = false;
    }
  } finally {
    state.adopting = false;
    if (!els.adoptConfirm.dataset.force) {
      els.adoptConfirm.disabled = false;
      els.adoptConfirm.textContent = "Übernehmen";
    } else {
      els.adoptConfirm.disabled = false;
    }
  }
}

function detailCards(entries) {
  return `<div class="detail-grid">${entries.map(([title, body]) => `
    <div class="detail-card">
      <h3>${escapeHtml(title)}</h3>
      <p>${body}</p>
    </div>
  `).join("")}</div>`;
}

function renderRunRows(runs) {
  if (!runs.length) {
    els.runsList.innerHTML = `<p class="empty-inline">No runs yet.</p>`;
    return;
  }
  els.runsList.innerHTML = runs.map((run) => {
    const id = run.runId || run.id;
    const status = run.status || "unknown";
    const label = run.scenario?.name || run.scenario || shortId(id);
    const active = state.selectedRun === id ? " active" : "";
    return `
      <button type="button" class="stack-item${active}" data-kind="run" data-id="${escapeHtml(id)}" role="listitem">
        <span class="stack-title">${escapeHtml(label)} <span class="${statusClass(status)}">${escapeHtml(status)}</span></span>
        <span class="stack-meta">${escapeHtml(formatTime(run.finishedAt || run.startedAt || run.createdAt, true))}</span>
      </button>
    `;
  }).join("");
}

function renderHandoffs(items) {
  if (!items?.length) {
    els.handoffsList.innerHTML = `<p class="empty-inline">No handoffs yet.</p>`;
    return;
  }
  els.handoffsList.innerHTML = items.map((item) => {
    const id = item.handoffId;
    const active = state.selectedHandoff === id ? " active" : "";
    return `
      <button type="button" class="stack-item${active}" data-kind="handoff" data-id="${escapeHtml(id)}" role="listitem">
        <span class="stack-title">${escapeHtml(shortId(id))}</span>
        <span class="stack-meta">${escapeHtml(formatTime(item.createdAt, true))}</span>
      </button>
    `;
  }).join("");
}

async function showRun(runId) {
  setMode("runs");
  state.selectedRun = runId;
  renderRunRows((state._runs || []));
  els.runDetail.innerHTML = emptyState("Loading", "Fetching run evidence…");
  const run = await apiGet(`/api/v1/runs/${encodeURIComponent(runId)}`);
  const result = run.result || {};
  const files = run.files || {};
  const sheetHref = files.contactSheet
    ? `/api/v1/artifacts/${encodeURIComponent(runId)}/${files.contactSheet}`
    : null;
  const cards = detailCards([
    ["Status", escapeHtml(result.status || "—")],
    ["Scenario", escapeHtml(result.scenario?.name || result.scenario?.path || "—")],
    ["Duration", escapeHtml(result.durationMs != null ? `${result.durationMs} ms` : "—")],
    ["Finished", escapeHtml(formatTime(result.finishedAt))],
    ["Path", escapeHtml(run.path || "—")],
  ]);
  const sheet = sheetHref
    ? `<div class="sheet"><img src="${sheetHref}" alt="Contact sheet for ${escapeHtml(runId)}"></div>`
    : emptyState("No contact sheet", "This run has no visual evidence yet.");
  els.runDetail.innerHTML = cards + sheet;
}

async function showHandoff(handoffId) {
  setMode("handoffs");
  state.selectedHandoff = handoffId;
  renderHandoffs(state._handoffs || []);
  els.handoffDetail.innerHTML = emptyState("Loading", "Fetching handoff package…");
  const handoff = await apiGet(`/api/v1/handoffs/${encodeURIComponent(handoffId)}`);
  const manifest = handoff.manifest || {};
  const sourceRunId = manifest.source?.runId || null;
  const sheetHref = sourceRunId
    ? `/api/v1/artifacts/${encodeURIComponent(sourceRunId)}/contact-sheet.png`
    : null;
  const feedbackIds = manifest.feedback?.threadIds || [];
  const cards = detailCards([
    ["Source run", escapeHtml(sourceRunId || "—")],
    ["Status", escapeHtml(manifest.source?.status || "—")],
    ["Created", escapeHtml(formatTime(manifest.createdAt))],
    ["Note", escapeHtml(manifest.note || "—")],
    ["Feedback", escapeHtml(feedbackIds.length ? feedbackIds.join(", ") : "—")],
    ["Path", escapeHtml(handoff.path || "—")],
  ]);
  let sheet = "";
  if (sheetHref) {
    sheet = `<div class="sheet"><img src="${sheetHref}" alt="Source run contact sheet" onerror="this.closest('.sheet').replaceWith()"></div>`;
  }
  els.handoffDetail.innerHTML = cards + sheet;
}

async function refresh({ keepSelection = true } = {}) {
  try {
    const [workspace, runsPayload, handoffsPayload] = await Promise.all([
      apiGet("/api/v1/workspace"),
      apiGet("/api/v1/runs?refresh=0"),
      apiGet("/api/v1/handoffs"),
    ]);
    state.workspace = workspace;
    state._runs = runsPayload.runs || [];
    state._handoffs = handoffsPayload.handoffs || [];
    renderBranches(workspace);
    const summary = runsPayload.summary || {};
    const count = summary.runCount ?? state._runs.length;
    els.runsSummary.textContent = `${count} · ${summary.passed ?? 0}✓ · ${summary.failed ?? 0}✗`;
    renderRunRows(state._runs);
    renderHandoffs(state._handoffs);
    await refreshFeedback();

    if (keepSelection && state.mode === "review" && state.selectedBranch) {
      await showReview(state.selectedBranch, { path: state.reviewFile });
    } else if (keepSelection && state.mode === "runs" && state.selectedRun) {
      await showRun(state.selectedRun);
    } else if (keepSelection && state.mode === "handoffs" && state.selectedHandoff) {
      await showHandoff(state.selectedHandoff);
    } else if (state.mode === "review" && !state.selectedBranch) {
      els.reviewContext.hidden = true;
      els.composer.hidden = true;
      els.diffTitle.textContent = "";
      els.diffBody.innerHTML = emptyState(
        "Pick a branch",
        "Select another local branch to review its changes against yours — then adopt with an optional note.",
      );
    }
  } catch (error) {
    els.diffBody.innerHTML = emptyState("API offline", error.message);
  }
}

document.querySelectorAll(".mode-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    setMode(tab.dataset.mode);
    if (tab.dataset.mode === "runs" && state.selectedRun) showRun(state.selectedRun);
    if (tab.dataset.mode === "handoffs" && state.selectedHandoff) showHandoff(state.selectedHandoff);
  });
});

els.refreshBtn.addEventListener("click", () => refresh());

els.adoptCancel.addEventListener("click", () => {
  delete els.adoptConfirm.dataset.force;
  els.adoptCancel.hidden = true;
  els.adoptConfirm.textContent = "Übernehmen";
});

els.adoptConfirm.addEventListener("click", () => {
  adoptCurrent({ force: els.adoptConfirm.dataset.force === "1" });
});

els.adoptComment.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    els.adoptConfirm.click();
  }
});

els.feedbackSend.addEventListener("click", () => createFeedbackFromComposer());
els.feedbackBody.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    createFeedbackFromComposer();
  }
});
els.threadDone.addEventListener("click", () => markThreadDone());
els.threadSelect.addEventListener("click", () => {
  if (state.selectedThreadId) toggleBundle(state.selectedThreadId);
});
els.bundleBtn.addEventListener("click", () => bundleSelected());

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-kind][data-id]");
  if (!button) return;
  if (button.dataset.kind === "branch") showReview(button.dataset.id);
  if (button.dataset.kind === "file") showReview(state.selectedBranch, { path: button.dataset.id });
  if (button.dataset.kind === "run") showRun(button.dataset.id);
  if (button.dataset.kind === "handoff") showHandoff(button.dataset.id);
  if (button.dataset.kind === "thread") showThread(button.dataset.id);
});

refresh();
