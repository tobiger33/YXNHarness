const els = {
  livePill: document.getElementById("live-pill"),
  refreshBtn: document.getElementById("refresh-btn"),
  hostFacts: document.getElementById("host-facts"),
  runsSummary: document.getElementById("runs-summary"),
  runsList: document.getElementById("runs-list"),
  handoffsList: document.getElementById("handoffs-list"),
  detailTitle: document.getElementById("detail-title"),
  detailLede: document.getElementById("detail-lede"),
  detailBody: document.getElementById("detail-body"),
  generatedAt: document.getElementById("generated-at"),
};

const state = {
  overview: null,
  selected: null,
};

function setLive(kind, label) {
  els.livePill.className = `pill pill-${kind}`;
  els.livePill.textContent = label;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
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

async function apiGet(pathname) {
  const response = await fetch(pathname, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${pathname}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

function renderHost(host) {
  const config = host?.config?.host || {};
  const rows = [
    ["Project", config.projectLabel || "—"],
    ["Visibility", config.visibility || "—"],
    ["Merge authority", config.mergeAuthority || "—"],
    ["Share links", config.shareLinksGrant || "—"],
    ["Browser consent", config.browserInstallConsent || "—"],
    ["Config", host?.path || (host?.present === false ? "missing" : "—")],
  ];
  els.hostFacts.innerHTML = rows.map(([term, value]) => `
    <div>
      <dt>${escapeHtml(term)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `).join("");
}

function renderRunRows(runs) {
  if (!runs.length) {
    els.runsList.innerHTML = `<p class="empty">No runs yet. Run a scenario, then refresh.</p>`;
    return;
  }
  els.runsList.innerHTML = runs.map((run) => {
    const id = run.runId || run.id;
    const status = run.status || "unknown";
    const active = state.selected?.type === "run" && state.selected.id === id ? " active" : "";
    return `
      <button type="button" class="row${active}" data-kind="run" data-id="${escapeHtml(id)}" role="listitem">
        <span class="row-title">
          <span>${escapeHtml(run.scenario?.name || run.scenario || id)}</span>
          <span class="status ${statusClass(status)}">${escapeHtml(status)}</span>
        </span>
        <span class="row-meta">${escapeHtml(formatTime(run.finishedAt || run.startedAt || run.createdAt))}</span>
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
      <button type="button" class="row${active}" data-kind="handoff" data-id="${escapeHtml(id)}" role="listitem">
        <span class="row-title">
          <span>${escapeHtml(id)}</span>
          <span class="status ${statusClass(status)}">${escapeHtml(status)}</span>
        </span>
        <span class="row-meta">${escapeHtml(formatTime(item.createdAt))} · from ${escapeHtml(item.sourceRunId || "—")}</span>
      </button>
    `;
  }).join("");
}

function detailCards(entries) {
  return `<div class="detail-grid">${entries.map(([title, body]) => `
    <div class="detail-card">
      <h3>${escapeHtml(title)}</h3>
      <p>${body}</p>
    </div>
  `).join("")}</div>`;
}

async function showRun(runId) {
  state.selected = { type: "run", id: runId };
  els.detailTitle.textContent = "Run";
  els.detailLede.textContent = runId;
  els.detailBody.innerHTML = `<p class="empty">Loading…</p>`;
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
    ["Result file", files.result
      ? `<a href="/api/v1/artifacts/${encodeURIComponent(runId)}/${files.result}" target="_blank" rel="noreferrer">${escapeHtml(files.result)}</a>`
      : "—"],
  ]);

  const sheet = sheetHref
    ? `<div class="sheet"><img src="${sheetHref}" alt="Contact sheet for ${escapeHtml(runId)}"></div>`
    : `<p class="empty">No contact sheet in this run.</p>`;

  els.detailBody.innerHTML = cards + sheet;
}

async function showHandoff(handoffId) {
  state.selected = { type: "handoff", id: handoffId };
  els.detailTitle.textContent = "Handoff";
  els.detailLede.textContent = handoffId;
  els.detailBody.innerHTML = `<p class="empty">Loading…</p>`;
  highlightSelection();

  const handoff = await apiGet(`/api/v1/handoffs/${encodeURIComponent(handoffId)}`);
  const manifest = handoff.manifest || {};
  const note = manifest.note || "—";
  const guidance = manifest.guidance?.commentsAreContextNotInstructions
    ? "Comments are context, not instructions."
    : "—";

  const cards = detailCards([
    ["Source run", escapeHtml(manifest.source?.runId || "—")],
    ["Status", escapeHtml(manifest.source?.status || "—")],
    ["Created", escapeHtml(formatTime(manifest.createdAt))],
    ["Note", escapeHtml(note)],
    ["Guidance", escapeHtml(guidance)],
    ["Path", escapeHtml(handoff.path || "—")],
    ["README", handoff.files?.readme
      ? `<a href="/api/v1/artifacts/handoffs/${encodeURIComponent(handoffId)}/${handoff.files.readme}" target="_blank" rel="noreferrer">${escapeHtml(handoff.files.readme)}</a>`
      : "—"],
  ]);

  els.detailBody.innerHTML = cards;
}

function highlightSelection() {
  for (const button of document.querySelectorAll(".row[data-kind]")) {
    const match = state.selected
      && button.dataset.kind === state.selected.type
      && button.dataset.id === state.selected.id;
    button.classList.toggle("active", Boolean(match));
  }
}

async function refresh() {
  setLive("pending", "refreshing");
  try {
    // One refresh rebuilds the index; the rest read without racing writes.
    const overview = await apiGet("/api/v1/overview");
    const [runsPayload, handoffsPayload] = await Promise.all([
      apiGet("/api/v1/runs?refresh=0"),
      apiGet("/api/v1/handoffs"),
    ]);
    state.overview = overview;
    renderHost(overview.host);
    const runs = runsPayload.runs || [];
    const summary = runsPayload.summary || overview.index?.summary || {};
    const count = summary.runCount ?? runs.length;
    els.runsSummary.textContent =
      `${count} run${count === 1 ? "" : "s"} · ${summary.passed ?? 0} passed · ${summary.failed ?? 0} failed`;
    renderRunRows(runs);
    renderHandoffs(handoffsPayload.handoffs || overview.handoffs?.items || []);
    els.generatedAt.textContent = `Updated ${formatTime(overview.generatedAt)}`;
    setLive("live", "live");

    if (state.selected?.type === "run") await showRun(state.selected.id);
    else if (state.selected?.type === "handoff") await showHandoff(state.selected.id);
    else if (runs[0]?.runId) await showRun(runs[0].runId);
    else {
      els.detailBody.innerHTML = `<p class="empty">Select a run or handoff.</p>`;
    }
  } catch (error) {
    setLive("error", "offline");
    els.runsSummary.textContent = "Could not reach the local API.";
    els.detailBody.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

els.refreshBtn.addEventListener("click", () => {
  refresh();
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-kind][data-id]");
  if (!button) return;
  if (button.dataset.kind === "run") showRun(button.dataset.id);
  if (button.dataset.kind === "handoff") showHandoff(button.dataset.id);
});

refresh();
