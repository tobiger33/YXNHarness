import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import Ajv from "ajv";
import { DEFAULT_VIEWPORTS } from "./scenario-scaffold.mjs";

const require = createRequire(import.meta.url);
const hostConfigSchema = require("../schema/host-config.schema.json");
const HOST_CONFIG_VALIDATOR = new Ajv({ strict: false, allErrors: true }).compile(hostConfigSchema);
const HOST_CONFIG_FILENAME = "harness.host.json";

function defaultHostConfig({ projectLabel = null } = {}) {
  return {
    version: 1,
    host: {
      ...(projectLabel ? { projectLabel } : {}),
    },
    defaults: {
      viewports: DEFAULT_VIEWPORTS.map((viewport) => ({ ...viewport })),
      scenarioOut: "scenarios/smoke.yaml",
    },
    consent: {
      browserInstallPolicy: "ask-every-time",
      requireExplicitYes: true,
    },
    access: {
      visibility: "private",
      shareLinkGrant: "view",
      mergeAuthority: "host",
    },
    moderation: {
      requireReviewedExpects: true,
      allowForceOverwrite: false,
    },
  };
}

function validateHostConfig(config, label = "harness.host.json") {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  if (!HOST_CONFIG_VALIDATOR(config)) {
    throw new Error(`invalid ${label}: ${JSON.stringify(HOST_CONFIG_VALIDATOR.errors)}`);
  }
  // Share links never grant write/merge; schema already forbids that.
  // Private projects may still declare what a future share link would grant.
  return config;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadHostConfig(root) {
  const filePath = path.join(root, HOST_CONFIG_FILENAME);
  if (!(await pathExists(filePath))) {
    return { exists: false, path: HOST_CONFIG_FILENAME, config: null };
  }
  let raw;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${HOST_CONFIG_FILENAME}: ${error.message}`);
  }
  return {
    exists: true,
    path: HOST_CONFIG_FILENAME,
    config: validateHostConfig(raw),
  };
}

async function initHostConfig(root, { apply = false, force = false, projectLabel = null } = {}) {
  const filePath = path.join(root, HOST_CONFIG_FILENAME);
  const exists = await pathExists(filePath);
  const config = defaultHostConfig({
    projectLabel: projectLabel || path.basename(root),
  });
  validateHostConfig(config);

  const plan = {
    version: 1,
    mode: apply ? "apply" : "dry-run",
    status: apply ? (exists && !force ? "blocked" : "ready") : "ready",
    path: HOST_CONFIG_FILENAME,
    exists,
    force,
    writes: apply && !(exists && !force) ? [HOST_CONFIG_FILENAME] : [],
    config,
    explanation: [
      "Host config is local cockpit policy for this project.",
      "It does not start servers or grant remote access by itself.",
      "visibility defaults to private; shareLinkGrant never includes write or merge.",
      "mergeAuthority stays with the host. browserInstallPolicy still requires the agent to ask before --yes unless you change policy later in the cockpit.",
    ].join(" "),
    warnings: [],
    next: [
      "Review consent/access/moderation values with the host.",
      "npm run harness -- status --json",
      "Use doctor → setup → probe → scaffold → run as usual.",
    ],
  };

  if (exists && !force) {
    plan.warnings.push(`Refusing to overwrite existing ${HOST_CONFIG_FILENAME}. Re-run with --force after host consent.`);
    if (apply) plan.status = "blocked";
  }
  if (!apply) {
    plan.warnings.push("Preview only. Re-run with --init --apply to write harness.host.json.");
  }
  if (apply && plan.status === "ready") {
    await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { flag: force ? "w" : "wx" });
    plan.status = "written";
  }
  return plan;
}

function formatHostConfigPlan(plan) {
  const lines = [
    `Host config: ${plan.status}`,
    `Mode: ${plan.mode}`,
    `File: ${plan.path}`,
    `Files to write: ${plan.writes.length ? plan.writes.join(", ") : "none"}`,
    plan.explanation,
  ];
  if (plan.config) {
    lines.push(`Visibility: ${plan.config.access.visibility}`);
    lines.push(`Share link grant: ${plan.config.access.shareLinkGrant} (never write/merge)`);
    lines.push(`Merge authority: ${plan.config.access.mergeAuthority}`);
    lines.push(`Browser install policy: ${plan.config.consent.browserInstallPolicy}`);
    lines.push(`Require reviewed expects: ${plan.config.moderation.requireReviewedExpects}`);
  }
  for (const warning of plan.warnings) lines.push(`Note: ${warning}`);
  for (const step of plan.next || []) lines.push(`Next: ${step}`);
  return lines.join("\n");
}

function formatHostConfigSummary(loaded) {
  if (!loaded.exists) {
    return [
      "Host config: missing",
      "Create a local cockpit policy file with:",
      "  npm run harness -- host-config --init --dry-run",
      "  npm run harness -- host-config --init --apply",
    ].join("\n");
  }
  const config = loaded.config;
  return [
    `Host config: present (${loaded.path})`,
    `Project label: ${config.host.projectLabel || "(none)"}`,
    `Visibility: ${config.access.visibility}`,
    `Share link grant: ${config.access.shareLinkGrant}`,
    `Merge authority: ${config.access.mergeAuthority}`,
    `Browser install policy: ${config.consent.browserInstallPolicy}`,
    `Default scenario out: ${config.defaults.scenarioOut}`,
    `Default viewports: ${config.defaults.viewports.map((viewport) => viewport.name).join(", ")}`,
  ].join("\n");
}

export {
  HOST_CONFIG_FILENAME,
  defaultHostConfig,
  formatHostConfigPlan,
  formatHostConfigSummary,
  initHostConfig,
  loadHostConfig,
  validateHostConfig,
};
