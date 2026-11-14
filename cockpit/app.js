const els = {
  refreshBtn: document.getElementById("refresh-btn"),
  branchCurrent: document.getElementById("branch-current"),
  branchesList: document.getElementById("branches-list"),
  runsSummary: document.getElementById("runs-summary"),
  runsList: document.getElementById("runs-list"),
  handoffsList: document.getElementById("handoffs-list"),
  detailTitle: document.getElementById("detail-title"),
  detailLede: document.getElementById("detail-lede"),
  detailBody: document.getElementById("detail-body"),
  stageActions: document.getElementById("stage-actions"),
  adoptSheet: document.getElementById("adopt-sheet"),
  adoptSheetLede: document.getElementById("adopt-sheet-lede"),
  adoptComment: document.getElementById("adopt-comment"),
  adoptCancel: document.getElementById("adopt-cancel"),
  adoptConfirm: document.getElementById("adopt-confirm"),
  generatedAt: document.getElementById("generated-at"),
};

const state = {
  overview: null,
  workspace: null,
  selected: null,
  review: null,
  reviewFile: null,
  adopting: false,
  adoptOpen: false,
  adoptForce: false,
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
  return "status-unknown";
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

function stageEmpty(title, body) {
  return `<div class="stage-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span></div>`;
}

function detailCards(entries) {
  return `<div class="detail-grid">${entries.map(([title, body]) => `
    <div class="detail-card">
      <h3>${escapeHtml(title)}</h3>
      <p>${body}</p>
    </div>
  `).join("")}</div>`;
}

function clearActions() {
  els.stageActions.hidden = true;
  els.stageActions.innerHTML = "";
}

function closeAdoptSheet({ restoreAction = false } = {}) {
  const wasOpen = state.adoptOpen;
  state.adoptOpen = false;
  state.adoptForce = false;
  els.adoptSheet.hidden = true;
  els.adoptComment.value = "";
  els.adoptConfirm.disabled = false;
  els.adoptConfirm.textContent = "Übernehmen";
  if (restoreAction && wasOpen && state.selected?.type === "review" && state.review) {
    setAdoptAction(true);
  }
}

function openAdoptSheet({ force = false } = {}) {
  const review = state.review;
  const theirs = state.selected?.id || review?.theirs?.branch || "—";
  const yours = review?.yours?.branch || state.workspace?.branch || "—";
  const summary = review?.summary || {};
  const files = summary.filesChanged ?? "—";
  const stats = summary.additions != null
    ? ` · +${summary.additions}/-${summary.deletions}`
    : "";
  state.adoptOpen = true;
  state.adoptForce = force;
  clearActions();
  els.adoptSheetLede.textContent = `Merge ${theirs} → ${yours} (${files} files${stats}). Note is optional — leave empty to take as-is.`;
  els.adoptSheet.hidden = false;
  els.adoptConfirm.disabled = false;
  els.adoptConfirm.textContent = force ? "Force Übernehmen" : "Übernehmen";
  queueMicrotask(() => els.adoptComment.focus());
}

function setAdoptAction(enabled, label = "Übernehmen") {
  els.stageActions.hidden = false;
  els.stageActions.innerHTML = `
    <button type="button" class="btn btn-primary" id="adopt-btn" ${enabled ? "" : "disabled"}>
      ${escapeHtml(label)}
    </button>
  `;
}

function renderBranches(workspace) {
  const branches = workspace?.branches || [];
  if (!workspace?.available) {
    els.branchCurrent.textContent = "no git";
    els.branchesList.innerHTML = `<p class="empty">Not a Git workspace.</p>`;
    return;
  }
  const current = workspace.branch || "(detached)";
  const short = workspace.shortCommit || "";
  els.branchCurrent.textContent = `${current}${short ? ` @ ${short}` : ""}${workspace.dirty ? " · dirty" : ""}`;

  const others = branches.filter((entry) => !entry.current);
  if (!others.length) {
    els.branchesList.innerHTML = `<p class="empty">No other local branches.</p>`;
    return;
  }

  els.branchesList.innerHTML = others.map((entry) => {
    const active = state.selected?.type === "review" && state.selected.id === entry.name ? " active" : "";
    return `
      <button type="button" class="row${active}" data-kind="review" data-id="${escapeHtml(entry.name)}" role="listitem" title="Review ${escapeHtml(entry.name)}">
        <span class="row-title">
          <span>${escapeHtml(entry.name)}</span>
          <span class="mark">review</span>
        </span>
        <span class="row-meta">${escapeHtml(entry.shortCommit || "")}</span>
      </button>
    `;
  }).join("");
}

function renderRunRows(runs) {
  if (!runs.length) {
    els.runsList.innerHTML = `<p class="empty">No runs yet.</p>`;
    return;
  }
  els.runsList.innerHTML = runs.map((run) => {
    const id = run.runId || run.id;
    const status = run.status || "unknown";
    const label = run.scenario?.name || run.scenario || shortId(id);
    const active = state.selected?.type === "run" && state.selected.id === id ? " active" : "";
    return `
      <button type="button" class="row${active}" data-kind="run" data-id="${escapeHtml(id)}" role="listitem" title="${escapeHtml(id)}">
        <span class="row-title">
          <span>${escapeHtml(label)}</span>
          <span class="status ${statusClass(status)}">${escapeHtml(status)}</span>
        </span>
        <span class="row-meta">${escapeHtml(formatTime(run.finishedAt || run.startedAt || run.createdAt, true))}</span>
      </button>
    `;
  }).join("");
}

function renderHandoffs(items) {
  if (!items?.length) {
    els.handoffsList.innerHTML = `<p class="empty">No handoffs yet.</p>`;
    return;
  }
  els.handoffsList.innerHTML = items.map((item) => {
    const id = item.handoffId;
    const active = state.selected?.type === "handoff" && state.selected.id === id ? " active" : "";
    const status = item.status || "—";
    return `
      <button type="button" class="row${active}" data-kind="handoff" data-id="${escapeHtml(id)}" role="listitem" title="${escapeHtml(id)}">
        <span class="row-title">
          <span>${escapeHtml(shortId(id))}</span>
          <span class="status ${statusClass(status)}">${escapeHtml(status)}</span>
        </span>
        <span class="row-meta">${escapeHtml(formatTime(item.createdAt, true))}</span>
      </button>
    `;
  }).join("");
}

function highlightSelection() {
  for (const button of document.querySelectorAll(".row[data-kind]")) {
    const match = state.selected
      && button.dataset.kind === state.selected.type
      && button.dataset.id === state.selected.id;
    button.classList.toggle("active", Boolean(match));
  }
}

function renderDiffLines(text) {
  if (!text) return `<div class="diff-empty">No textual patch for this file.</div>`;
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
  els.detailTitle.textContent = `Review · ${theirs}`;
  els.detailLede.textContent = `${yours} ← ${theirs} · ${summary.filesChanged} files · +${summary.additions}/-${summary.deletions}`;

  const canAdopt = review.status === "ready" || review.status === "noop";
  if (!state.adoptOpen) {
    setAdoptAction(canAdopt && !state.adopting, state.adopting ? "Übernehmen…" : "Übernehmen");
  }

  if (!review.files?.length) {
    els.detailBody.innerHTML = `
      ${message ? `<div class="toast ${message.ok ? "toast-ok" : "toast-error"}">${escapeHtml(message.text)}</div>` : ""}
      ${stageEmpty("No unique changes", review.explanation || "Nothing to adopt from this branch.")}
    `;
    return;
  }

  const path = selectedPath || review.files[0].path;
  const filesHtml = review.files.map((file) => {
    const active = file.path === path ? " active" : "";
    return `
      <button type="button" class="file-row${active}" data-kind="file" data-id="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}">
        <span class="file-status">${escapeHtml(file.status)}</span>
        <span class="file-path">${escapeHtml(file.path)}</span>
        <span class="file-stats"><span class="stat-add">+${file.additions}</span> <span class="stat-del">-${file.deletions}</span></span>
      </button>
    `;
  }).join("");

  const patchText = review.patch?.path === path ? review.patch.text : null;
  els.detailBody.innerHTML = `
    ${message ? `<div class="toast ${message.ok ? "toast-ok" : "toast-error"}">${escapeHtml(message.text)}</div>` : ""}
    <div class="review">
      <aside class="file-pane">
        <h3>Changed files</h3>
        ${filesHtml}
      </aside>
      <section class="diff-pane">
        <div class="diff-head">${escapeHtml(path)}</div>
        ${patchText == null
    ? `<div class="diff-empty">Loading patch…</div>`
    : renderDiffLines(patchText)}
      </section>
    </div>
  `;
}

async function showReview(branchName, { path = null, message = null } = {}) {
  state.selected = { type: "review", id: branchName };
  state.reviewFile = path;
  highlightSelection();
  if (!state.adopting && !state.adoptOpen) closeAdoptSheet();
  if (!state.adoptOpen) clearActions();
  els.detailTitle.textContent = `Review · ${branchName}`;
  els.detailLede.textContent = "Loading diff…";
  els.detailBody.innerHTML = stageEmpty("Loading", "Fetching branch review…");

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
    clearActions();
    els.detailBody.innerHTML = stageEmpty("Review failed", error.message);
  }
}

async function adoptCurrent({ force = false, comment = null } = {}) {
  if (!state.selected || state.selected.type !== "review" || state.adopting) return;
  const ref = state.selected.id;
  state.adopting = true;
  setAdoptAction(false, "Übernehmen…");
  els.adoptConfirm.disabled = true;
  els.adoptConfirm.textContent = "Übernehmen…";
  try {
    const preview = await apiPost("/api/v1/workspace/adopt", { ref, apply: false, force, comment });
    if (preview.status === "blocked") {
      throw new Error(preview.blockedReasons?.join("; ") || "Adopt blocked");
    }
    if (preview.status === "noop") {
      closeAdoptSheet();
      await showReview(ref, { path: state.reviewFile, message: { ok: true, text: preview.explanation || "Already on that branch." } });
      return;
    }
    const applied = await apiPost("/api/v1/workspace/adopt", { ref, apply: true, force, comment });
    if (applied.status === "blocked") {
      throw new Error(applied.blockedReasons?.join("; ") || "Adopt failed");
    }
    closeAdoptSheet();
    await refresh({ keepSelection: false });
    els.detailTitle.textContent = "Adopted";
    els.detailLede.textContent = applied.explanation || `Merged ${ref} into your branch.`;
    clearActions();
    const noteLine = applied.comment
      ? `Note recorded on the merge commit: “${applied.comment}”`
      : "Taken as-is (no merge note).";
    els.detailBody.innerHTML = stageEmpty(
      "Übernommen",
      `${applied.explanation || `Changes from ${ref} are now on your current branch.`} ${noteLine}`,
    );
  } catch (error) {
    const dirty = /dirty/i.test(error.message);
    closeAdoptSheet();
    await showReview(ref, {
      path: state.reviewFile,
      message: {
        ok: false,
        text: dirty
          ? `${error.message} — open Übernehmen again and use Force after host consent.`
          : error.message,
      },
    });
    if (dirty) {
      setAdoptAction(true, "Force Übernehmen");
      const btn = document.getElementById("adopt-btn");
      if (btn) btn.dataset.force = "1";
    }
  } finally {
    state.adopting = false;
  }
}

async function showRun(runId) {
  state.selected = { type: "run", id: runId };
  state.review = null;
  closeAdoptSheet();
  clearActions();
  els.detailTitle.textContent = "Run";
  els.detailLede.textContent = runId;
  els.detailBody.innerHTML = stageEmpty("Loading", "Fetching run evidence…");
  highlightSelection();

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
    ["Result", files.result
      ? `<a href="/api/v1/artifacts/${encodeURIComponent(runId)}/${files.result}" target="_blank" rel="noreferrer">${escapeHtml(files.result)}</a>`
      : "—"],
  ]);

  const sheet = sheetHref
    ? `<div class="sheet"><img src="${sheetHref}" alt="Contact sheet for ${escapeHtml(runId)}"></div>`
    : stageEmpty("No contact sheet", "This run has no visual evidence yet.");

  els.detailBody.innerHTML = cards + sheet;
}

async function showHandoff(handoffId) {
  state.selected = { type: "handoff", id: handoffId };
  state.review = null;
  closeAdoptSheet();
  clearActions();
  els.detailTitle.textContent = "Handoff";
  els.detailLede.textContent = handoffId;
  els.detailBody.innerHTML = stageEmpty("Loading", "Fetching handoff package…");
  highlightSelection();

  const handoff = await apiGet(`/api/v1/handoffs/${encodeURIComponent(handoffId)}`);
  const manifest = handoff.manifest || {};
  const note = manifest.note || "—";
  const guidance = manifest.guidance?.commentsAreContextNotInstructions
    ? "Comments are context, not instructions."
    : "—";
  const sourceRunId = manifest.source?.runId || null;
  const sheetHref = sourceRunId
    ? `/api/v1/artifacts/${encodeURIComponent(sourceRunId)}/contact-sheet.png`
    : null;

  const cards = detailCards([
    ["Source run", escapeHtml(sourceRunId || "—")],
    ["Status", escapeHtml(manifest.source?.status || "—")],
    ["Created", escapeHtml(formatTime(manifest.createdAt))],
    ["Note", escapeHtml(note)],
    ["Guidance", escapeHtml(guidance)],
    ["Path", escapeHtml(handoff.path || "—")],
  ]);

  let sheet = "";
  if (sheetHref) {
    sheet = `<div class="sheet"><img src="${sheetHref}" alt="Source run contact sheet" onerror="this.closest('.sheet').replaceWith()"></div>`;
  }

  els.detailBody.innerHTML = cards + sheet;
}

async function refresh({ keepSelection = true } = {}) {
  try {
    const overview = await apiGet("/api/v1/overview");
    const [workspace, runsPayload, handoffsPayload] = await Promise.all([
      apiGet("/api/v1/workspace"),
      apiGet("/api/v1/runs?refresh=0"),
      apiGet("/api/v1/handoffs"),
    ]);
    state.overview = overview;
    state.workspace = workspace;
    renderBranches(workspace);
    const runs = runsPayload.runs || [];
    const summary = runsPayload.summary || overview.index?.summary || {};
    const count = summary.runCount ?? runs.length;
    els.runsSummary.textContent = `${count} · ${summary.passed ?? 0}✓ · ${summary.failed ?? 0}✗`;
    renderRunRows(runs);
    renderHandoffs(handoffsPayload.handoffs || overview.handoffs?.items || []);
    els.generatedAt.textContent = formatTime(overview.generatedAt, true);

    if (keepSelection && state.selected?.type === "review") {
      await showReview(state.selected.id, { path: state.reviewFile });
    } else if (keepSelection && state.selected?.type === "run") {
      await showRun(state.selected.id);
    } else if (keepSelection && state.selected?.type === "handoff") {
      await showHandoff(state.selected.id);
    } else {
      state.selected = null;
      clearActions();
      const current = workspace.branch || "—";
      els.detailTitle.textContent = "Workspace";
      els.detailLede.textContent = `On ${current}. Pick a branch to review, or a run for evidence.`;
      els.detailBody.innerHTML = stageEmpty(
        "Clean stage",
        "Left rail: other branches open a GitHub-style diff. Übernehmen merges that branch into yours (local only).",
      );
      highlightSelection();
    }
  } catch (error) {
    els.runsSummary.textContent = "offline";
    clearActions();
    els.detailBody.innerHTML = stageEmpty("API offline", error.message);
  }
}

els.refreshBtn.addEventListener("click", () => {
  refresh();
});

els.adoptCancel.addEventListener("click", () => {
  closeAdoptSheet({ restoreAction: true });
});

els.adoptConfirm.addEventListener("click", () => {
  const comment = els.adoptComment.value.trim() || null;
  adoptCurrent({ force: state.adoptForce, comment });
});

els.adoptComment.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    els.adoptConfirm.click();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeAdoptSheet({ restoreAction: true });
  }
});

document.addEventListener("click", (event) => {
  const adopt = event.target.closest("#adopt-btn");
  if (adopt) {
    openAdoptSheet({ force: adopt.dataset.force === "1" });
    return;
  }
  const button = event.target.closest("[data-kind][data-id]");
  if (!button) return;
  if (button.dataset.kind === "review") {
    closeAdoptSheet();
    showReview(button.dataset.id);
  }
  if (button.dataset.kind === "file") showReview(state.selected?.id, { path: button.dataset.id });
  if (button.dataset.kind === "run") showRun(button.dataset.id);
  if (button.dataset.kind === "handoff") showHandoff(button.dataset.id);
});

refresh();
