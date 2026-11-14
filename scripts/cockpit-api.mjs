import { createServer } from "node:http";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostConfig } from "./host-config.mjs";
import { buildRunIndex, writeRunIndex } from "./run-index.mjs";
import {
  buildWorkspaceReview,
  collectWorkspace,
  planWorkspaceAdopt,
  planWorkspaceFetch,
  planWorkspacePush,
} from "./workspace.mjs";
import { compareRuns } from "./compare-runs.mjs";
import { promoteExpectsFromRun } from "./promote.mjs";
import { planElementAdopt } from "./element-adopt.mjs";
import { PHASES as ATTACH_PHASES } from "./attach.mjs";
import { createShareInvite, listShares } from "./share.mjs";
import { planDesignApprove } from "./design-approve.mjs";
import {
  bundleFeedback,
  createFeedback,
  getFeedback,
  listFeedback,
  updateFeedback,
} from "./feedback.mjs";
import {
  createAttachment,
  deleteAttachment,
  getAttachment,
  listAttachments,
} from "./attachments.mjs";
import {
  acceptAgentProposal,
  agentPanelState,
  createAgentSession,
  getAgentProposal,
  listAgentActivity,
  listAgentProposals,
  listAgentSessions,
  rejectAgentProposal,
  submitAgentTurn,
} from "./agent-adapter.mjs";

const DEFAULT_PORT = 8787;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_UI_ROOT = path.join(PACKAGE_ROOT, "cockpit");

const UI_CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
]);

const ARTIFACT_CONTENT_TYPES = new Map([
  [".json", "application/json; charset=utf-8"],
  [".jsonl", "application/x-ndjson; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".txt", "text/plain; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
]);

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function relativePosix(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function sendJson(response, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendText(response, statusCode, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(text);
}

async function listHandoffs(root) {
  const handoffsRoot = path.join(root, "artifacts", "handoffs");
  if (!(await pathExists(handoffsRoot))) return [];
  const entries = await readdir(handoffsRoot, { withFileTypes: true });
  const handoffs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = path.join(handoffsRoot, entry.name);
    const manifestPath = path.join(directory, "manifest.json");
    let manifest = null;
    if (await pathExists(manifestPath)) {
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (error) {
        manifest = { error: error.message };
      }
    }
    handoffs.push({
      handoffId: manifest?.handoffId || entry.name,
      path: relativePosix(root, directory),
      createdAt: manifest?.createdAt || null,
      sourceRunId: manifest?.source?.runId || null,
      status: manifest?.source?.status || null,
      note: manifest?.note || null,
      hasManifest: Boolean(manifest) && !manifest.error,
    });
  }
  handoffs.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || "") || 0;
    const rightTime = Date.parse(right.createdAt || "") || 0;
    return rightTime - leftTime;
  });
  return handoffs;
}

async function readLastHandoff(root) {
  const pointerPath = path.join(root, "artifacts", "last-handoff.json");
  if (!(await pathExists(pointerPath))) return null;
  try {
    return JSON.parse(await readFile(pointerPath, "utf8"));
  } catch (error) {
    return { error: error.message };
  }
}

async function buildOverview(root, { refresh = true } = {}) {
  const host = await loadHostConfig(root);
  const index = refresh ? await writeRunIndex(root) : await buildRunIndex(root);
  const handoffs = await listHandoffs(root);
  const lastHandoff = await readLastHandoff(root);
  const workspace = collectWorkspace(root);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    api: {
      readOnly: false,
      loopbackOnly: true,
      localWrites: [
        "POST /api/v1/workspace/adopt",
        "POST /api/v1/workspace/approve",
        "POST /api/v1/workspace/push",
        "POST /api/v1/workspace/fetch",
        "POST /api/v1/feedback",
        "PATCH /api/v1/feedback/:id",
        "POST /api/v1/feedback/bundle",
        "POST /api/v1/elements/adopt",
        "POST /api/v1/attach",
        "POST /api/v1/share",
        "POST /api/v1/attachments",
        "DELETE /api/v1/attachments/:id",
        "POST /api/v1/agent/sessions",
        "POST /api/v1/agent/turns",
        "POST /api/v1/agent/proposals/:id/accept",
        "POST /api/v1/agent/proposals/:id/reject",
      ],
      endpoints: [
        "GET /api/v1/health",
        "GET /api/v1/overview",
        "GET /api/v1/host-config",
        "GET /api/v1/workspace",
        "GET /api/v1/workspace/review",
        "POST /api/v1/workspace/adopt",
        "POST /api/v1/workspace/approve",
        "POST /api/v1/workspace/push",
        "POST /api/v1/workspace/fetch",
        "GET /api/v1/runs",
        "GET /api/v1/runs/:runId",
        "GET /api/v1/compare",
        "GET /api/v1/promote",
        "GET /api/v1/feedback",
        "GET /api/v1/feedback/:id",
        "POST /api/v1/feedback",
        "PATCH /api/v1/feedback/:id",
        "POST /api/v1/feedback/bundle",
        "POST /api/v1/elements/adopt",
        "GET /api/v1/attach",
        "POST /api/v1/attach",
        "GET /api/v1/share",
        "POST /api/v1/share",
        "GET /api/v1/attachments",
        "POST /api/v1/attachments",
        "GET /api/v1/attachments/:id/content",
        "DELETE /api/v1/attachments/:id",
        "GET /api/v1/agent",
        "GET /api/v1/agent/activity",
        "GET /api/v1/agent/sessions",
        "POST /api/v1/agent/sessions",
        "POST /api/v1/agent/turns",
        "GET /api/v1/agent/proposals",
        "GET /api/v1/agent/proposals/:id",
        "POST /api/v1/agent/proposals/:id/accept",
        "POST /api/v1/agent/proposals/:id/reject",
        "GET /api/v1/handoffs",
        "GET /api/v1/handoffs/:handoffId",
        "GET /api/v1/artifacts/*",
      ],
    },
    host,
    workspace: {
      available: workspace.available,
      branch: workspace.branch,
      shortCommit: workspace.shortCommit,
      dirty: workspace.dirty,
      branchCount: workspace.branches.length,
      note: workspace.note,
    },
    index: {
      summary: index.summary,
      pointers: index.pointers,
      indexPath: index.indexPath || "artifacts/index.json",
      generatedAt: index.generatedAt,
    },
    handoffs: {
      count: handoffs.length,
      last: lastHandoff,
      items: handoffs.slice(0, 20),
    },
  };
}

function safeId(value, label) {
  if (!value || typeof value !== "string" || value.includes("..") || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

async function getRun(root, runId) {
  const id = safeId(runId, "runId");
  if (id === "handoffs" || id === "probe") throw new Error("Not a scenario run.");
  const runDirectory = path.join(root, "artifacts", id);
  if (!(await pathExists(runDirectory))) {
    const error = new Error(`Run "${id}" not found.`);
    error.statusCode = 404;
    throw error;
  }
  const resultPath = path.join(runDirectory, "result.json");
  let result = null;
  if (await pathExists(resultPath)) {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  }
  return {
    version: 1,
    runId: id,
    path: relativePosix(root, runDirectory),
    result,
    files: {
      result: await pathExists(resultPath) ? "result.json" : null,
      stateLog: await pathExists(path.join(runDirectory, "state.jsonl")) ? "state.jsonl" : null,
      appLog: await pathExists(path.join(runDirectory, "app.log")) ? "app.log" : null,
      contactSheet: await pathExists(path.join(runDirectory, "contact-sheet.png")) ? "contact-sheet.png" : null,
    },
  };
}

async function getHandoff(root, handoffId) {
  const id = safeId(handoffId, "handoffId");
  const directory = path.join(root, "artifacts", "handoffs", id);
  if (!(await pathExists(directory))) {
    const error = new Error(`Handoff "${id}" not found.`);
    error.statusCode = 404;
    throw error;
  }
  const manifestPath = path.join(directory, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    const error = new Error(`Handoff "${id}" is missing manifest.json.`);
    error.statusCode = 404;
    throw error;
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return {
    version: 1,
    handoffId: manifest.handoffId || id,
    path: relativePosix(root, directory),
    manifest,
    files: {
      manifest: "manifest.json",
      readme: await pathExists(path.join(directory, "AGENT_README.md")) ? "AGENT_README.md" : null,
      hostConfigSnapshot: await pathExists(path.join(directory, "host-config.snapshot.json"))
        ? "host-config.snapshot.json"
        : null,
    },
  };
}

async function resolveContainedFile(root, requestPath) {
  const containedRoot = path.resolve(root);
  const realContainedRoot = await realpath(containedRoot);
  const decoded = decodeURIComponent(requestPath);
  const absolute = path.resolve(containedRoot, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (absolute !== containedRoot && !absolute.startsWith(`${containedRoot}${path.sep}`)) {
    const error = new Error("Forbidden path.");
    error.statusCode = 403;
    throw error;
  }
  const realFile = await realpath(absolute);
  if (realFile !== realContainedRoot && !realFile.startsWith(`${realContainedRoot}${path.sep}`)) {
    const error = new Error("Forbidden path.");
    error.statusCode = 403;
    throw error;
  }
  if (!(await stat(realFile)).isFile()) {
    const error = new Error("Not a file.");
    error.statusCode = 404;
    throw error;
  }
  return realFile;
}

async function resolveArtifactFile(root, requestPath) {
  return resolveContainedFile(path.resolve(root, "artifacts"), requestPath);
}

async function resolveUiFile(uiRoot, requestPath) {
  const relative = requestPath === "/" || requestPath === ""
    ? "/index.html"
    : requestPath.replace(/^\/cockpit(?=\/|$)/, "") || "/index.html";
  return resolveContainedFile(uiRoot, relative);
}

async function sendFile(response, method, filePath, contentTypes) {
  const body = await readFile(filePath);
  const contentType = contentTypes.get(path.extname(filePath).toLowerCase()) ||
    "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : body);
}

function apiIndexPayload(projectRoot) {
  return {
    name: "yxnharness-cockpit-api",
    version: 1,
    readOnly: false,
    loopbackOnly: true,
    localWrites: [
      "POST /api/v1/workspace/adopt",
      "POST /api/v1/workspace/approve",
      "POST /api/v1/workspace/push",
      "POST /api/v1/workspace/fetch",
      "POST /api/v1/feedback",
      "PATCH /api/v1/feedback/:id",
      "POST /api/v1/feedback/bundle",
      "POST /api/v1/elements/adopt",
      "POST /api/v1/attach",
      "POST /api/v1/share",
      "POST /api/v1/attachments",
      "DELETE /api/v1/attachments/:id",
      "POST /api/v1/agent/sessions",
      "POST /api/v1/agent/turns",
    ],
    root: projectRoot,
    links: {
      ui: "/",
      health: "/api/v1/health",
      overview: "/api/v1/overview",
      hostConfig: "/api/v1/host-config",
      workspace: "/api/v1/workspace",
      review: "/api/v1/workspace/review?ref=",
      adopt: "/api/v1/workspace/adopt",
      approve: "/api/v1/workspace/approve",
      push: "/api/v1/workspace/push",
      fetch: "/api/v1/workspace/fetch",
      runs: "/api/v1/runs",
      compare: "/api/v1/compare?baseline=last-green&against=last-run",
      promote: "/api/v1/promote?from=last-green",
      feedback: "/api/v1/feedback",
      elementsAdopt: "/api/v1/elements/adopt",
      attach: "/api/v1/attach",
      share: "/api/v1/share",
      attachments: "/api/v1/attachments",
      agent: "/api/v1/agent",
      agentActivity: "/api/v1/agent/activity",
      agentSessions: "/api/v1/agent/sessions",
      agentTurns: "/api/v1/agent/turns",
      agentProposals: "/api/v1/agent/proposals",
      handoffs: "/api/v1/handoffs",
      artifacts: "/api/v1/artifacts/",
    },
    note: "Local cockpit UI + API (loopback). Writes: adopt, design-approve, push, fetch, feedback, element adopt, attach, share invite, attachments, optional agent turns/proposals. No remote agent required.",
  };
}

function parseBooleanFlag(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseAttachOptions(input = {}, { allowApply = false } = {}) {
  const apply = allowApply ? parseBooleanFlag(input.apply, false) : false;
  return {
    until: input.until != null && String(input.until).trim() ? String(input.until).trim() : null,
    apply,
    yes: parseBooleanFlag(input.yes, false),
    force: parseBooleanFlag(input.force, false),
    installBrowser: parseBooleanFlag(input.installBrowser ?? input.install_browser, false),
    name: input.name != null && String(input.name).trim() ? String(input.name).trim() : null,
    out: input.out != null && String(input.out).trim() ? String(input.out).trim() : null,
    scenario: input.scenario != null && String(input.scenario).trim()
      ? String(input.scenario).trim()
      : (input.scenarioFile != null && String(input.scenarioFile).trim() ? String(input.scenarioFile).trim() : null),
    from: input.from != null && String(input.from).trim() ? String(input.from).trim() : "last-green",
    strict: parseBooleanFlag(input.strict, false),
    skipDoctor: parseBooleanFlag(input.skipDoctor ?? input.skip_doctor, false),
  };
}

async function executeAttach(attachRunner, options) {
  if (typeof attachRunner !== "function") {
    const error = new Error(
      "Attach runner is not configured. Start the cockpit with `npm run harness -- serve` (not a bare createCockpitApi without attachRunner).",
    );
    error.statusCode = 503;
    throw error;
  }
  return attachRunner(options);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Invalid JSON body.");
    error.statusCode = 400;
    throw error;
  }
}

async function readBinaryBody(request, { maxBytes = 12 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`Body exceeds ${maxBytes} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createCockpitApi({
  root,
  port = DEFAULT_PORT,
  host = "127.0.0.1",
  uiRoot = DEFAULT_UI_ROOT,
  attachRunner = null,
} = {}) {
  const projectRoot = path.resolve(root);
  const staticRoot = path.resolve(uiRoot);
  const server = createServer(async (request, response) => {
    try {
      let url;
      try {
        url = new URL(request.url || "/", `http://${host}`);
      } catch {
        sendText(response, 400, "Bad request");
        return;
      }

      const { pathname, searchParams } = url;
      const method = request.method || "GET";

      if (pathname === "/api/v1/workspace/adopt" && method === "POST") {
        const body = await readJsonBody(request);
        const paths = Array.isArray(body.paths)
          ? body.paths
          : body.path
            ? [body.path]
            : null;
        const plan = planWorkspaceAdopt(projectRoot, {
          theirs: body.ref || body.theirs || body.branch,
          apply: body.apply === true,
          force: body.force === true,
          comment: body.comment ?? body.note ?? null,
          paths,
          hunks: body.hunks ?? null,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      if (pathname === "/api/v1/workspace/fetch" && method === "POST") {
        const body = await readJsonBody(request);
        const plan = planWorkspaceFetch(projectRoot, {
          remote: body.remote ?? null,
          prune: body.prune !== false,
          apply: body.apply === true,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      if (pathname === "/api/v1/workspace/push" && method === "POST") {
        const body = await readJsonBody(request);
        const plan = planWorkspacePush(projectRoot, {
          remote: body.remote ?? null,
          force: body.force === true,
          apply: body.apply === true,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      if (pathname === "/api/v1/workspace/approve" && method === "POST") {
        const body = await readJsonBody(request);
        const plan = await planDesignApprove(projectRoot, {
          theirs: body.ref || body.theirs || body.branch,
          apply: body.apply === true,
          force: body.force === true,
          note: body.note ?? body.comment ?? null,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      if (pathname === "/api/v1/share" && method === "POST") {
        const body = await readJsonBody(request);
        const plan = await createShareInvite(projectRoot, {
          apply: body.apply === true,
          force: body.force === true,
          note: body.note ?? body.comment ?? null,
          shareId: body.shareId ?? body.id ?? null,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      if (pathname === "/api/v1/feedback" && method === "POST") {
        const body = await readJsonBody(request);
        const plan = await createFeedback(projectRoot, {
          body: body.body ?? body.text ?? body.message,
          apply: body.apply !== false,
          route: body.route ?? null,
          viewport: body.viewport ?? null,
          branch: body.branch ?? null,
          commit: body.commit ?? null,
          runId: body.runId ?? null,
          screenshot: body.screenshot ?? null,
          appState: body.appState ?? null,
          element: body.element ?? null,
          source: body.source ?? null,
          attachmentIds: body.attachmentIds || body.attachments || null,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      if (pathname === "/api/v1/attachments" && method === "POST") {
        const declaredType = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        const filename = request.headers["x-attachment-filename"] || request.headers["x-filename"] || null;
        const buffer = await readBinaryBody(request);
        const plan = await createAttachment(projectRoot, {
          buffer,
          filename,
          declaredType: declaredType || null,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 201, plan);
        return;
      }

      const attachmentDeleteMatch = pathname.match(/^\/api\/v1\/attachments\/([^/]+)$/);
      if (attachmentDeleteMatch && method === "DELETE") {
        const force = searchParams.get("force") === "1" || searchParams.get("force") === "true";
        const plan = await deleteAttachment(projectRoot, decodeURIComponent(attachmentDeleteMatch[1]), { force });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      if (pathname === "/api/v1/elements/adopt" && method === "POST") {
        const body = await readJsonBody(request);
        const plan = await planElementAdopt(projectRoot, {
          elements: body.elements || body.elementIds || [],
          body: body.body ?? body.text ?? body.message ?? null,
          route: body.route ?? null,
          viewport: body.viewport ?? null,
          sourceBranch: body.sourceBranch ?? body.source?.branch ?? null,
          sourceCommit: body.sourceCommit ?? body.source?.commit ?? null,
          apply: body.apply === true,
          withHandoff: body.withHandoff === true || body.bundle === true,
          from: body.from || "last-green",
          force: body.force === true,
          note: body.note ?? body.comment ?? null,
          attachmentIds: body.attachmentIds || body.attachments || null,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      if (pathname === "/api/v1/attach" && method === "GET") {
        const options = parseAttachOptions({
          until: searchParams.get("until"),
          yes: searchParams.get("yes"),
          force: searchParams.get("force"),
          installBrowser: searchParams.get("installBrowser") ?? searchParams.get("install_browser"),
          name: searchParams.get("name"),
          out: searchParams.get("out"),
          scenario: searchParams.get("scenario"),
          from: searchParams.get("from"),
          strict: searchParams.get("strict"),
          skipDoctor: searchParams.get("skipDoctor") ?? searchParams.get("skip_doctor"),
          apply: false,
        }, { allowApply: false });
        const plan = await executeAttach(attachRunner, options);
        sendJson(response, plan.status === "blocked" || plan.ok === false ? 409 : 200, {
          ...plan,
          phasesAvailable: ATTACH_PHASES,
          http: { method: "GET", apply: false, note: "GET is always dry-run. POST with apply:true to write." },
        });
        return;
      }

      if (pathname === "/api/v1/attach" && method === "POST") {
        const body = await readJsonBody(request);
        const options = parseAttachOptions(body, { allowApply: true });
        const plan = await executeAttach(attachRunner, options);
        sendJson(response, plan.status === "blocked" || plan.ok === false ? 409 : 200, {
          ...plan,
          phasesAvailable: ATTACH_PHASES,
        });
        return;
      }

      if (pathname === "/api/v1/feedback/bundle" && method === "POST") {
        const body = await readJsonBody(request);
        const plan = await bundleFeedback(projectRoot, {
          threadIds: body.threadIds || body.ids || [],
          from: body.from || "last-green",
          note: body.note ?? null,
          apply: body.apply !== false,
          force: body.force === true,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      if (pathname === "/api/v1/agent/sessions" && method === "POST") {
        const body = await readJsonBody(request);
        const plan = await createAgentSession(projectRoot, { note: body.note ?? null });
        sendJson(response, plan.status === "blocked" ? 409 : 201, plan);
        return;
      }

      if (pathname === "/api/v1/agent/turns" && method === "POST") {
        const body = await readJsonBody(request);
        const plan = await submitAgentTurn(projectRoot, {
          body: body.body ?? body.text ?? body.message,
          sessionId: body.sessionId ?? null,
          model: body.model ?? null,
          reasoning: body.reasoning ?? null,
          attachmentIds: body.attachmentIds || body.attachments || [],
          route: body.route ?? null,
          viewport: body.viewport ?? null,
          branch: body.branch ?? null,
          commit: body.commit ?? null,
          element: body.element ?? null,
          source: body.source ?? null,
          appState: body.appState ?? null,
          createThread: body.createThread !== false,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      const proposalAcceptMatch = pathname.match(/^\/api\/v1\/agent\/proposals\/([^/]+)\/accept$/);
      if (proposalAcceptMatch && method === "POST") {
        const body = await readJsonBody(request);
        try {
          const plan = await acceptAgentProposal(projectRoot, decodeURIComponent(proposalAcceptMatch[1]), {
            force: body.force === true,
          });
          sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        } catch (error) {
          if (error.statusCode === 400 || error.statusCode === 404) {
            sendJson(response, error.statusCode, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }

      const proposalRejectMatch = pathname.match(/^\/api\/v1\/agent\/proposals\/([^/]+)\/reject$/);
      if (proposalRejectMatch && method === "POST") {
        const body = await readJsonBody(request);
        try {
          const plan = await rejectAgentProposal(projectRoot, decodeURIComponent(proposalRejectMatch[1]), {
            reason: body.reason ?? null,
          });
          sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        } catch (error) {
          if (error.statusCode === 400 || error.statusCode === 404) {
            sendJson(response, error.statusCode, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }

      const feedbackWriteMatch = pathname.match(/^\/api\/v1\/feedback\/([^/]+)$/);
      if (feedbackWriteMatch && method === "PATCH") {
        const body = await readJsonBody(request);
        const plan = await updateFeedback(projectRoot, {
          threadId: decodeURIComponent(feedbackWriteMatch[1]),
          body: body.body ?? body.text ?? null,
          status: body.status ?? null,
          apply: body.apply !== false,
        });
        sendJson(response, plan.status === "blocked" ? 409 : 200, plan);
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD, POST, PATCH, DELETE" }).end("Method not allowed");
        return;
      }

      if (pathname === "/api" || pathname === "/api/v1") {
        sendJson(response, 200, apiIndexPayload(projectRoot));
        return;
      }

      if (pathname === "/" || pathname === "/index.html" || pathname.startsWith("/cockpit/")) {
        try {
          const filePath = await resolveUiFile(staticRoot, pathname === "/index.html" ? "/" : pathname);
          await sendFile(response, method, filePath, UI_CONTENT_TYPES);
        } catch (error) {
          if (error.statusCode === 403 || error.statusCode === 404 || error.code === "ENOENT") {
            sendText(response, error.statusCode === 403 ? 403 : 404, "Not found");
            return;
          }
          throw error;
        }
        return;
      }

      if (pathname === "/api/v1/health") {
        sendJson(response, 200, {
          ok: true,
          service: "yxnharness-cockpit-api",
          version: 1,
          root: projectRoot,
          generatedAt: new Date().toISOString(),
        });
        return;
      }

      if (pathname === "/api/v1/overview") {
        const refresh = searchParams.get("refresh") !== "0";
        sendJson(response, 200, await buildOverview(projectRoot, { refresh }));
        return;
      }

      if (pathname === "/api/v1/host-config") {
        sendJson(response, 200, await loadHostConfig(projectRoot));
        return;
      }

      if (pathname === "/api/v1/workspace") {
        sendJson(response, 200, collectWorkspace(projectRoot));
        return;
      }

      if (pathname === "/api/v1/share") {
        sendJson(response, 200, await listShares(projectRoot));
        return;
      }

      if (pathname === "/api/v1/attachments") {
        sendJson(response, 200, await listAttachments(projectRoot));
        return;
      }

      const attachmentContentMatch = pathname.match(/^\/api\/v1\/attachments\/([^/]+)\/content$/);
      if (attachmentContentMatch) {
        try {
          const { meta, body } = await getAttachment(projectRoot, decodeURIComponent(attachmentContentMatch[1]));
          response.writeHead(200, {
            "Content-Type": meta.mimeType || "application/octet-stream",
            "Content-Length": body.length,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": `inline; filename="${String(meta.filename || "attachment").replace(/"/g, "")}"`,
          });
          response.end(method === "HEAD" ? undefined : body);
        } catch (error) {
          sendJson(response, error.statusCode || 500, { error: error.message });
        }
        return;
      }

      if (pathname === "/api/v1/workspace/review") {
        const ref = searchParams.get("ref") || searchParams.get("theirs") || "";
        const filePath = searchParams.get("path") || null;
        const review = buildWorkspaceReview(projectRoot, { theirs: ref, path: filePath });
        sendJson(response, review.status === "blocked" ? 400 : 200, review);
        return;
      }

      if (pathname === "/api/v1/runs") {
        const refresh = searchParams.get("refresh") !== "0";
        const index = refresh ? await writeRunIndex(projectRoot) : await buildRunIndex(projectRoot);
        sendJson(response, 200, {
          version: 1,
          summary: index.summary,
          pointers: index.pointers,
          runs: index.runs,
        });
        return;
      }

      if (pathname === "/api/v1/compare") {
        const report = await compareRuns(projectRoot, {
          baseline: searchParams.get("baseline") || "last-green",
          against: searchParams.get("against") || "last-run",
        });
        sendJson(response, report.status === "blocked" ? 400 : 200, report);
        return;
      }

      if (pathname === "/api/v1/promote") {
        // Read-only preview — writing expects stays on the CLI (`promote --apply`).
        const plan = await promoteExpectsFromRun(projectRoot, {
          from: searchParams.get("from") || "last-green",
          out: searchParams.get("out") || null,
          apply: false,
          force: false,
          strict: searchParams.get("strict") === "1",
          name: searchParams.get("name") || null,
        });
        sendJson(response, plan.status === "blocked" ? 400 : 200, plan);
        return;
      }

      const runMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
      if (runMatch) {
        sendJson(response, 200, await getRun(projectRoot, decodeURIComponent(runMatch[1])));
        return;
      }

      if (pathname === "/api/v1/feedback") {
        const status = searchParams.get("status") || null;
        sendJson(response, 200, await listFeedback(projectRoot, { status }));
        return;
      }

      const feedbackMatch = pathname.match(/^\/api\/v1\/feedback\/([^/]+)$/);
      if (feedbackMatch) {
        try {
          sendJson(response, 200, await getFeedback(projectRoot, decodeURIComponent(feedbackMatch[1])));
        } catch (error) {
          if (error.code === "NOT_FOUND") {
            sendJson(response, 404, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }

      if (pathname === "/api/v1/agent") {
        sendJson(response, 200, await agentPanelState(projectRoot));
        return;
      }

      if (pathname === "/api/v1/agent/activity") {
        const limit = Number.parseInt(searchParams.get("limit") || "40", 10);
        sendJson(response, 200, await listAgentActivity(projectRoot, {
          limit: Number.isFinite(limit) ? limit : 40,
        }));
        return;
      }

      if (pathname === "/api/v1/agent/sessions") {
        sendJson(response, 200, await listAgentSessions(projectRoot));
        return;
      }

      if (pathname === "/api/v1/agent/proposals") {
        const status = searchParams.get("status") || null;
        sendJson(response, 200, await listAgentProposals(projectRoot, { status }));
        return;
      }

      const proposalMatch = pathname.match(/^\/api\/v1\/agent\/proposals\/([^/]+)$/);
      if (proposalMatch) {
        try {
          const proposal = await getAgentProposal(projectRoot, decodeURIComponent(proposalMatch[1]));
          sendJson(response, 200, { version: 1, proposal });
        } catch (error) {
          if (error.statusCode === 400 || error.statusCode === 404) {
            sendJson(response, error.statusCode, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }

      if (pathname === "/api/v1/handoffs") {
        sendJson(response, 200, {
          version: 1,
          last: await readLastHandoff(projectRoot),
          handoffs: await listHandoffs(projectRoot),
        });
        return;
      }

      const handoffMatch = pathname.match(/^\/api\/v1\/handoffs\/([^/]+)$/);
      if (handoffMatch) {
        sendJson(response, 200, await getHandoff(projectRoot, decodeURIComponent(handoffMatch[1])));
        return;
      }

      if (pathname.startsWith("/api/v1/artifacts/")) {
        const artifactPath = pathname.slice("/api/v1/artifacts".length);
        if (!artifactPath || artifactPath === "/") {
          sendJson(response, 400, { error: "Provide a path under /api/v1/artifacts/..." });
          return;
        }
        const filePath = await resolveArtifactFile(projectRoot, artifactPath);
        await sendFile(response, request.method, filePath, ARTIFACT_CONTENT_TYPES);
        return;
      }

      sendJson(response, 404, { error: "Not found", path: pathname });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : (error.statusCode || 500);
      sendJson(response, statusCode, { error: error.message });
    }
  });

  return {
    server,
    root: projectRoot,
    uiRoot: staticRoot,
    port,
    host,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      return {
        url: `http://${host}:${address.port}/`,
        port: address.port,
        host,
        root: projectRoot,
      };
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

export {
  DEFAULT_PORT,
  DEFAULT_UI_ROOT,
  buildOverview,
  createCockpitApi,
  listHandoffs,
};
