import { createServer } from "node:http";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { loadHostConfig } from "./host-config.mjs";
import { buildRunIndex, writeRunIndex } from "./run-index.mjs";

const DEFAULT_PORT = 8787;
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
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    api: {
      readOnly: true,
      loopbackOnly: true,
      endpoints: [
        "GET /api/v1/health",
        "GET /api/v1/overview",
        "GET /api/v1/host-config",
        "GET /api/v1/runs",
        "GET /api/v1/runs/:runId",
        "GET /api/v1/handoffs",
        "GET /api/v1/handoffs/:handoffId",
        "GET /api/v1/artifacts/*",
      ],
    },
    host,
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

async function resolveArtifactFile(root, requestPath) {
  const artifactsRoot = path.resolve(root, "artifacts");
  const realArtifactsRoot = await realpath(artifactsRoot);
  const decoded = decodeURIComponent(requestPath);
  const absolute = path.resolve(artifactsRoot, `.${decoded}`);
  if (absolute !== artifactsRoot && !absolute.startsWith(`${artifactsRoot}${path.sep}`)) {
    const error = new Error("Forbidden path.");
    error.statusCode = 403;
    throw error;
  }
  const realFile = await realpath(absolute);
  if (realFile !== realArtifactsRoot && !realFile.startsWith(`${realArtifactsRoot}${path.sep}`)) {
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

function createCockpitApi({ root, port = DEFAULT_PORT, host = "127.0.0.1" } = {}) {
  const projectRoot = path.resolve(root);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
        return;
      }

      let url;
      try {
        url = new URL(request.url || "/", `http://${host}`);
      } catch {
        sendText(response, 400, "Bad request");
        return;
      }

      const { pathname, searchParams } = url;

      if (pathname === "/" || pathname === "/api" || pathname === "/api/v1") {
        sendJson(response, 200, {
          name: "yxnharness-cockpit-api",
          version: 1,
          readOnly: true,
          loopbackOnly: true,
          root: projectRoot,
          links: {
            health: "/api/v1/health",
            overview: "/api/v1/overview",
            hostConfig: "/api/v1/host-config",
            runs: "/api/v1/runs",
            handoffs: "/api/v1/handoffs",
            artifacts: "/api/v1/artifacts/",
          },
          note: "Local cockpit read API for UI development. No writes, no remote bind.",
        });
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

      const runMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
      if (runMatch) {
        sendJson(response, 200, await getRun(projectRoot, decodeURIComponent(runMatch[1])));
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
        const body = await readFile(filePath);
        const contentType = ARTIFACT_CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ||
          "application/octet-stream";
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": body.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      sendJson(response, 404, { error: "Not found", path: pathname });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      sendJson(response, statusCode, { error: error.message });
    }
  });

  return {
    server,
    root: projectRoot,
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
  buildOverview,
  createCockpitApi,
  listHandoffs,
};
