#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import Ajv from "ajv";
import yaml from "js-yaml";
import { chromium } from "playwright";
import {
  formatDoctorReport,
  formatSetupPlan,
  inspectProject,
  setupProject,
} from "./project-doctor.mjs";
import {
  ensureChromium,
  formatBrowserPlan,
} from "./browser-setup.mjs";
import {
  buildScaffoldScenario,
  formatScaffoldPlan,
  writeScaffoldScenario,
} from "./scenario-scaffold.mjs";
import {
  formatHostConfigPlan,
  formatHostConfigSummary,
  initHostConfig,
  loadHostConfig,
} from "./host-config.mjs";
import {
  buildRunIndex,
  formatRunIndex,
  writeRunIndex,
} from "./run-index.mjs";
import {
  createHandoffPackage,
  formatHandoffPlan,
} from "./handoff.mjs";
import {
  compareRuns,
  formatCompareReport,
} from "./compare-runs.mjs";
import {
  formatPromotePlan,
  promoteExpectsFromRun,
} from "./promote.mjs";
import {
  bundleFeedback,
  createFeedback,
  formatFeedbackList,
  formatFeedbackPlan,
  getFeedback,
  listFeedback,
  updateFeedback,
} from "./feedback.mjs";
import {
  acceptAgentProposal,
  agentPanelState,
  createAgentSession,
  getAgentProposal,
  listAgentActivity,
  listAgentProposals,
  rejectAgentProposal,
  submitAgentTurn,
  workspaceEditAdapterDeclaration,
} from "./agent-adapter.mjs";
import {
  formatAttachPlan,
  runAttach,
} from "./attach.mjs";
import {
  formatElementAdoptPlan,
  planElementAdopt,
} from "./element-adopt.mjs";
import {
  DEFAULT_PORT as COCKPIT_DEFAULT_PORT,
  createCockpitApi,
} from "./cockpit-api.mjs";
import {
  collectGit,
  collectWorkspace,
  buildWorkspaceReview,
  formatAdoptPlan,
  formatCheckoutPlan,
  formatCreatePlan,
  formatWorkspace,
  formatWorkspaceReview,
  planWorkspaceAdopt,
  planWorkspaceCheckout,
  planWorkspaceCreate,
  planWorkspaceFetch,
  planWorkspacePush,
  formatFetchPlan,
  formatPushPlan,
} from "./workspace.mjs";
import {
  createShareInvite,
  formatSharePlan,
  listShares,
} from "./share.mjs";
import {
  formatDesignApprovePlan,
  planDesignApprove,
} from "./design-approve.mjs";

const require = createRequire(import.meta.url);
const scenarioSchema = require("../schema/scenario.schema.json");

const INSTALL_BROWSER_MESSAGE = [
  "Chromium is missing for local harness runs.",
  "Ask the project host for permission, then run:",
  "  npm run harness -- setup --install-browser --yes",
].join("\n");
const USAGE = `Usage:
  npm run harness -- doctor [--root path] [--json]
  npm run harness -- setup [--root path] [--dry-run|--apply] [--install-browser] [--yes] [--json]
  npm run harness -- probe [--root path] [--yes] [--json]
  npm run harness -- scaffold [--root path] [--name smoke] [--out scenarios/smoke.yaml] [--dry-run|--apply] [--force] [--yes] [--json]
  npm run harness -- host-config [--root path] [--init] [--dry-run|--apply] [--force] [--json]
  npm run harness -- status [--root path] [--json]
  npm run harness -- workspace [--root path] [--checkout|--create|--review|--adopt|--approve branch|--fetch|--push] [--remote name] [--path file] [--hunks 1,3] [--start branch] [--note text] [--dry-run|--apply] [--force] [--json]
  npm run harness -- share [--root path] [--note text] [--dry-run|--apply] [--force] [--json]
  npm run harness -- handoff [--root path] [--from last-green|last-run|<runId>] [--note text] [--out path] [--dry-run|--apply] [--force] [--json]
  npm run harness -- compare [--root path] [--baseline last-green|last-run|<runId>] [--against last-run|last-green|<runId>] [--json]
  npm run harness -- promote [--root path] [--from last-green|last-run|<runId>] [--out path] [--name name] [--dry-run|--apply] [--force] [--strict] [--json]
  npm run harness -- feedback [--root path] [--list|--create|--id <threadId>|--bundle ids] [--body text] [--route path] [--viewport name] [--element id] [--run-id id] [--resolve|--reopen] [--from last-green] [--note text] [--dry-run|--apply] [--force] [--json]
  npm run harness -- elements --adopt [--root path] [--element id]... [--source-branch name] [--body text] [--route path] [--viewport name] [--with-handoff] [--from last-green] [--note text] [--dry-run|--apply] [--force] [--json]
  npm run harness -- attach [--root path] [--until doctor|setup|browser|probe|scaffold|run|promote] [--name smoke] [--out path] [--scenario path] [--from last-green] [--dry-run|--apply] [--install-browser] [--yes] [--force] [--strict] [--skip-doctor] [--json]
  npm run harness -- serve [--root path] [--port ${COCKPIT_DEFAULT_PORT}] [--json]
  npm run harness -- run <scenario.yaml> [--root path] [--dry-run]
  npm run harness -- --help`;
const JSON_SCHEMA_VALIDATOR = new Ajv({ strict: false, allErrors: true });
const SCENARIO_VALIDATOR = new Ajv({ strict: false, allErrors: true }).compile(scenarioSchema);
const SAFE_INHERITED_ENV = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM",
  "SystemRoot", "WINDIR", "PATHEXT", "ComSpec",
];
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10000;

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h" || action === "help") return { help: true };
  if (!["run", "doctor", "setup", "probe", "scaffold", "host-config", "status", "workspace", "handoff", "compare", "promote", "feedback", "elements", "attach", "share", "serve"].includes(action)) {
    throw new Error(USAGE);
  }

  const options = {
    action,
    dryRun: false,
    apply: false,
    json: false,
    installBrowser: false,
    yes: false,
    force: false,
    init: false,
    name: null,
    out: null,
    from: null,
    note: null,
    port: null,
    checkout: null,
    create: null,
    start: null,
    review: null,
    adopt: null,
    approve: null,
    fetch: false,
    push: false,
    remote: null,
    path: null,
    paths: [],
    hunks: null,
    baseline: null,
    against: null,
    strict: false,
    list: false,
    createFeedback: false,
    body: null,
    route: null,
    viewport: null,
    element: null,
    elements: [],
    elementsAdopt: false,
    sourceBranch: null,
    withHandoff: false,
    runId: null,
    id: null,
    bundle: null,
    resolve: false,
    reopen: false,
    until: null,
    scenarioFile: null,
    skipDoctor: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--install-browser") {
      options.installBrowser = true;
    } else if (argument === "--yes" || argument === "-y") {
      options.yes = true;
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--init") {
      options.init = true;
    } else if (argument === "--checkout") {
      const checkout = rest[index + 1];
      if (!checkout || checkout.startsWith("--")) throw new Error("--checkout requires a local branch name.");
      options.checkout = checkout;
      index += 1;
    } else if (argument === "--create") {
      if (action === "feedback") {
        options.createFeedback = true;
      } else {
        const create = rest[index + 1];
        if (!create || create.startsWith("--")) throw new Error("--create requires a new local branch name.");
        options.create = create;
        index += 1;
      }
    } else if (argument === "--review") {
      const review = rest[index + 1];
      if (!review || review.startsWith("--")) throw new Error("--review requires an existing local branch name.");
      options.review = review;
      index += 1;
    } else if (argument === "--adopt") {
      if (action === "elements") {
        options.elementsAdopt = true;
      } else {
        const adopt = rest[index + 1];
        if (!adopt || adopt.startsWith("--")) throw new Error("--adopt requires an existing local branch name.");
        options.adopt = adopt;
        index += 1;
      }
    } else if (argument === "--approve") {
      const approve = rest[index + 1];
      if (!approve || approve.startsWith("--")) throw new Error("--approve requires an existing local branch name.");
      options.approve = approve;
      index += 1;
    } else if (argument === "--fetch") {
      options.fetch = true;
    } else if (argument === "--push") {
      options.push = true;
    } else if (argument === "--remote") {
      const remote = rest[index + 1];
      if (!remote || remote.startsWith("--")) throw new Error("--remote requires a remote name.");
      options.remote = remote;
      index += 1;
    } else if (argument === "--path") {
      const filePath = rest[index + 1];
      if (!filePath || filePath.startsWith("--")) throw new Error("--path requires a repository-relative file path.");
      options.paths.push(filePath);
      options.path = options.paths[0];
      index += 1;
    } else if (argument === "--hunks") {
      const hunks = rest[index + 1];
      if (!hunks || hunks.startsWith("--")) throw new Error("--hunks requires a comma-separated list of 1-based hunk indices.");
      options.hunks = hunks;
      index += 1;
    } else if (argument === "--start") {
      const start = rest[index + 1];
      if (!start || start.startsWith("--")) throw new Error("--start requires an existing local branch name.");
      options.start = start;
      index += 1;
    } else if (argument === "--name") {
      const name = rest[index + 1];
      if (!name || name.startsWith("--")) throw new Error("--name requires a scenario name.");
      options.name = name;
      index += 1;
    } else if (argument === "--out") {
      const out = rest[index + 1];
      if (!out || out.startsWith("--")) throw new Error("--out requires a file path.");
      options.out = out;
      index += 1;
    } else if (argument === "--from") {
      const from = rest[index + 1];
      if (!from || from.startsWith("--")) throw new Error("--from requires last-green, last-run, or a runId.");
      options.from = from;
      index += 1;
    } else if (argument === "--baseline") {
      const baseline = rest[index + 1];
      if (!baseline || baseline.startsWith("--")) throw new Error("--baseline requires last-green, last-run, or a runId.");
      options.baseline = baseline;
      index += 1;
    } else if (argument === "--against") {
      const against = rest[index + 1];
      if (!against || against.startsWith("--")) throw new Error("--against requires last-run, last-green, or a runId.");
      options.against = against;
      index += 1;
    } else if (argument === "--strict") {
      options.strict = true;
    } else if (argument === "--list") {
      options.list = true;
    } else if (argument === "--body") {
      const body = rest[index + 1];
      if (body === undefined || body.startsWith("--")) throw new Error("--body requires text.");
      options.body = body;
      index += 1;
    } else if (argument === "--route") {
      const route = rest[index + 1];
      if (route === undefined || route.startsWith("--")) throw new Error("--route requires a path.");
      options.route = route;
      index += 1;
    } else if (argument === "--viewport") {
      const viewport = rest[index + 1];
      if (!viewport || viewport.startsWith("--")) throw new Error("--viewport requires a name.");
      options.viewport = viewport;
      index += 1;
    } else if (argument === "--element") {
      const element = rest[index + 1];
      if (!element || element.startsWith("--")) throw new Error("--element requires an id.");
      if (action === "elements") {
        options.elements.push(element);
        options.element = options.elements[0];
      } else {
        options.element = element;
      }
      index += 1;
    } else if (argument === "--source-branch") {
      const sourceBranch = rest[index + 1];
      if (!sourceBranch || sourceBranch.startsWith("--")) throw new Error("--source-branch requires a branch name.");
      options.sourceBranch = sourceBranch;
      index += 1;
    } else if (argument === "--with-handoff") {
      options.withHandoff = true;
    } else if (argument === "--run-id") {
      const runId = rest[index + 1];
      if (!runId || runId.startsWith("--")) throw new Error("--run-id requires a run id.");
      options.runId = runId;
      index += 1;
    } else if (argument === "--id") {
      const id = rest[index + 1];
      if (!id || id.startsWith("--")) throw new Error("--id requires a feedback thread id.");
      options.id = id;
      index += 1;
    } else if (argument === "--bundle") {
      const bundle = rest[index + 1];
      if (!bundle || bundle.startsWith("--")) throw new Error("--bundle requires comma-separated thread ids.");
      options.bundle = bundle;
      index += 1;
    } else if (argument === "--resolve") {
      options.resolve = true;
    } else if (argument === "--reopen") {
      options.reopen = true;
    } else if (argument === "--until") {
      const until = rest[index + 1];
      if (!until || until.startsWith("--")) throw new Error("--until requires doctor|setup|browser|probe|scaffold|run|promote.");
      options.until = until;
      index += 1;
    } else if (argument === "--scenario") {
      const scenarioFile = rest[index + 1];
      if (!scenarioFile || scenarioFile.startsWith("--")) throw new Error("--scenario requires a YAML path.");
      options.scenarioFile = scenarioFile;
      index += 1;
    } else if (argument === "--skip-doctor") {
      options.skipDoctor = true;
    } else if (argument === "--note") {
      const note = rest[index + 1];
      if (note === undefined || note.startsWith("--")) throw new Error("--note requires text.");
      options.note = note;
      index += 1;
    } else if (argument === "--port") {
      const portValue = rest[index + 1];
      if (!portValue || portValue.startsWith("--")) throw new Error("--port requires a number.");
      const port = Number(portValue);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("--port must be an integer from 1 to 65535.");
      }
      options.port = port;
      index += 1;
    } else if (argument === "--root") {
      const root = rest[index + 1];
      if (!root || root.startsWith("--")) throw new Error("--root requires a directory path.");
      options.root = root;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option "${argument}".`);
    } else if (action === "run" && !options.scenario) {
      options.scenario = argument;
    } else if (action !== "run") {
      throw new Error(`${action} does not accept a scenario path.`);
    } else {
      throw new Error(`Unexpected argument "${argument}".`);
    }
  }

  if (options.dryRun && options.apply) throw new Error("--dry-run and --apply cannot be used together.");
  if (action === "run" && !options.scenario) throw new Error("A scenario YAML path is required.");
  if (action !== "run" && options.scenario) throw new Error(`${action} does not accept a scenario path.`);
  if (action === "attach") {
    if (options.note || options.baseline || options.against || options.port !== null ||
        options.init || options.checkout || options.create || options.review || options.adopt ||
        options.path || options.start || options.list || options.createFeedback || options.body ||
        options.route || options.viewport || options.element || options.runId || options.id ||
        options.bundle || options.resolve || options.reopen) {
      throw new Error("attach accepts --root/--json/--until/--name/--out/--scenario/--from/--dry-run/--apply/--install-browser/--yes/--force/--strict/--skip-doctor only.");
    }
  }
  if (action === "run" && (options.apply || options.json || options.installBrowser || options.yes ||
      options.force || options.init || options.name || options.out || options.from || options.note ||
      options.baseline || options.against || options.strict || options.port !== null)) {
    throw new Error("run does not support setup/scaffold/host-config/handoff/serve flags.");
  }
  if (action === "doctor" && (options.apply || options.dryRun || options.installBrowser || options.yes ||
      options.force || options.init || options.name || options.out || options.from || options.note ||
      options.baseline || options.against || options.strict || options.port !== null)) {
    throw new Error("doctor is read-only and does not accept mutating flags.");
  }
  if (action === "probe" && (options.apply || options.dryRun || options.installBrowser || options.force ||
      options.init || options.name || options.out || options.from || options.note ||
      options.baseline || options.against || options.strict || options.port !== null)) {
    throw new Error("probe does not accept mutating/scaffold/handoff/serve flags. Use --yes only for Chromium consent.");
  }
  if (action === "status" && (options.apply || options.dryRun || options.installBrowser || options.yes ||
      options.force || options.init || options.name || options.out || options.from || options.note ||
      options.baseline || options.against || options.strict || options.port !== null)) {
    throw new Error("status only accepts --root and --json.");
  }
  if (action === "workspace" && (options.installBrowser || options.yes || options.init || options.name ||
      options.out || options.from || options.baseline || options.against || options.strict || options.port !== null)) {
    throw new Error("workspace accepts --root/--json/--checkout/--create/--review/--adopt/--approve/--fetch/--push/--remote/--path/--hunks/--start/--note/--dry-run/--apply/--force only.");
  }
  if (action === "workspace" && options.note && !options.adopt && !options.approve) {
    throw new Error("--note is only valid with workspace --adopt/--approve (or handoff / share).");
  }
  const workspaceMutators = [
    options.checkout,
    options.create,
    options.review,
    options.adopt,
    options.approve,
    options.fetch ? "fetch" : null,
    options.push ? "push" : null,
  ].filter(Boolean);
  if (action === "workspace" && workspaceMutators.length > 1) {
    throw new Error("Use only one of --checkout, --create, --review, --adopt, --approve, --fetch, or --push.");
  }
  if (action === "workspace" && (options.apply || options.dryRun || options.force) &&
      !options.checkout && !options.create && !options.adopt && !options.approve && !options.fetch && !options.push) {
    throw new Error("--apply, --dry-run, and --force require --checkout, --create, --adopt, --approve, --fetch, or --push for workspace.");
  }
  if (action === "workspace" && options.start && !options.create) {
    throw new Error("--start is only valid with workspace --create.");
  }
  if (action === "workspace" && options.approve && (options.path || options.hunks || options.paths.length)) {
    throw new Error("Design approve is whole-branch only (no --path / --hunks).");
  }
  if (action === "workspace" && options.path && !options.review && !options.adopt) {
    throw new Error("--path is only valid with workspace --review or --adopt.");
  }
  if (action === "workspace" && options.hunks && !options.adopt) {
    throw new Error("--hunks is only valid with workspace --adopt.");
  }
  if (action === "workspace" && options.hunks && options.paths.length !== 1) {
    throw new Error("--hunks requires exactly one --path.");
  }
  if (action === "workspace" && options.remote && !options.fetch && !options.push) {
    throw new Error("--remote is only valid with workspace --fetch or --push.");
  }
  if (options.hunks && action !== "workspace") {
    throw new Error("--hunks is only valid with workspace --adopt.");
  }
  if (options.fetch && action !== "workspace") {
    throw new Error("--fetch is only valid with workspace.");
  }
  if (options.push && action !== "workspace") {
    throw new Error("--push is only valid with workspace.");
  }
  if (options.remote && action !== "workspace") {
    throw new Error("--remote is only valid with workspace --fetch or --push.");
  }
  if (options.checkout && action !== "workspace") {
    throw new Error("--checkout is only valid with workspace.");
  }
  if (options.create && action !== "workspace") {
    throw new Error("--create is only valid with workspace.");
  }
  if (options.review && action !== "workspace") {
    throw new Error("--review is only valid with workspace.");
  }
  if (options.adopt && action !== "workspace") {
    throw new Error("--adopt is only valid with workspace.");
  }
  if (options.approve && action !== "workspace") {
    throw new Error("--approve is only valid with workspace.");
  }
  if (options.path && action !== "workspace") {
    throw new Error("--path is only valid with workspace.");
  }
  if (options.start && action !== "workspace") {
    throw new Error("--start is only valid with workspace.");
  }
  if (action === "setup" && options.yes && !options.installBrowser) {
    throw new Error("--yes is only valid with setup when also passing --install-browser.");
  }
  if (options.installBrowser && !["setup", "attach"].includes(action)) {
    throw new Error("--install-browser is only valid with setup or attach.");
  }
  if (options.name && !["scaffold", "promote", "attach"].includes(action)) {
    throw new Error("--name is only valid with scaffold, promote, or attach.");
  }
  if (options.out && !["scaffold", "handoff", "promote", "attach"].includes(action)) {
    throw new Error("--out is only valid with scaffold, handoff, promote, or attach.");
  }
  if (options.force && !["scaffold", "host-config", "handoff", "workspace", "promote", "feedback", "elements", "attach", "share"].includes(action)) {
    throw new Error("--force is only valid with scaffold, host-config, handoff, workspace, promote, feedback, elements, attach, or share.");
  }
  if (action === "share" && (options.installBrowser || options.yes || options.init || options.name || options.out ||
      options.from || options.baseline || options.against || options.strict || options.port !== null ||
      options.checkout || options.create || options.review || options.adopt || options.fetch || options.push ||
      options.remote || options.path || options.hunks || options.list || options.createFeedback || options.elementsAdopt)) {
    throw new Error("share accepts --root/--json/--note/--dry-run/--apply/--force only.");
  }
  if (action === "share" && options.apply && options.dryRun) {
    throw new Error("Choose either --dry-run or --apply for share, not both.");
  }
  if (options.init && action !== "host-config") {
    throw new Error("--init is only valid with host-config.");
  }
  if (options.from && !["handoff", "promote", "feedback", "elements", "attach"].includes(action)) {
    throw new Error("--from is only valid with handoff, promote, feedback --bundle, elements, or attach.");
  }
  if (options.until && action !== "attach") {
    throw new Error("--until is only valid with attach.");
  }
  if (options.scenarioFile && action !== "attach") {
    throw new Error("--scenario is only valid with attach.");
  }
  if (options.skipDoctor && action !== "attach") {
    throw new Error("--skip-doctor is only valid with attach.");
  }
  if (options.note && !["handoff", "workspace", "feedback", "elements", "share"].includes(action)) {
    throw new Error("--note is only valid with handoff, workspace --adopt/--approve, feedback --bundle, elements --adopt, or share.");
  }
  if (options.sourceBranch && action !== "elements") {
    throw new Error("--source-branch is only valid with elements --adopt.");
  }
  if (options.withHandoff && action !== "elements") {
    throw new Error("--with-handoff is only valid with elements --adopt.");
  }
  if (options.elementsAdopt && action !== "elements") {
    throw new Error("--adopt without a branch name is only valid with elements.");
  }
  if ((options.list || options.createFeedback || options.runId || options.id || options.bundle ||
      options.resolve || options.reopen) && action !== "feedback") {
    throw new Error("--list/--create/--run-id/--id/--bundle/--resolve/--reopen are only valid with feedback.");
  }
  if ((options.body || options.route || options.viewport || options.element) &&
      !["feedback", "elements"].includes(action)) {
    throw new Error("--body/--route/--viewport/--element are only valid with feedback or elements.");
  }
  if (action === "elements") {
    if (!options.elementsAdopt) {
      throw new Error("elements requires --adopt.");
    }
    if (!options.elements.length) {
      throw new Error("elements --adopt requires at least one --element <id>.");
    }
    if (options.list || options.createFeedback || options.id || options.bundle || options.resolve ||
        options.reopen || options.runId || options.init || options.name || options.out ||
        options.installBrowser || options.yes || options.checkout || options.create ||
        options.review || options.adopt || options.path || options.start || options.baseline ||
        options.against || options.strict || options.port !== null || options.until ||
        options.scenarioFile || options.skipDoctor) {
      throw new Error("elements --adopt accepts --root/--json/--element/--source-branch/--body/--route/--viewport/--with-handoff/--from/--note/--dry-run/--apply/--force only.");
    }
  }
  if ((options.baseline || options.against) && action !== "compare") {
    throw new Error("--baseline and --against are only valid with compare.");
  }
  if (options.strict && !["promote", "attach"].includes(action)) {
    throw new Error("--strict is only valid with promote or attach.");
  }
  if (options.port !== null && action !== "serve") {
    throw new Error("--port is only valid with serve.");
  }
  if (action === "host-config" && (options.installBrowser || options.yes || options.name || options.out ||
      options.from || options.note || options.baseline || options.against || options.strict || options.port !== null)) {
    throw new Error("host-config accepts --init/--dry-run/--apply/--force/--json/--root only.");
  }
  if (action === "host-config" && (options.apply || options.force) && !options.init) {
    throw new Error("--apply and --force require --init for host-config.");
  }
  if (action === "scaffold" && options.installBrowser) {
    throw new Error("scaffold does not accept --install-browser. Use --yes only to consent to a missing Chromium install.");
  }
  if (action === "handoff" && (options.installBrowser || options.yes || options.init || options.name ||
      options.baseline || options.against || options.strict || options.port !== null)) {
    throw new Error("handoff accepts --from/--note/--out/--dry-run/--apply/--force/--json/--root only.");
  }
  if (action === "compare" && (options.apply || options.dryRun || options.installBrowser || options.yes ||
      options.force || options.init || options.name || options.out || options.from || options.note ||
      options.strict || options.port !== null)) {
    throw new Error("compare accepts --root/--json/--baseline/--against only.");
  }
  if (action === "promote" && (options.installBrowser || options.yes || options.init || options.note ||
      options.baseline || options.against || options.port !== null || options.checkout || options.create ||
      options.review || options.adopt || options.path || options.start)) {
    throw new Error("promote accepts --root/--json/--from/--out/--name/--dry-run/--apply/--force/--strict only.");
  }
  if (action === "promote" && options.apply && options.dryRun) {
    throw new Error("--dry-run and --apply cannot be used together.");
  }
  if (action === "feedback") {
    const modes = [options.list, options.createFeedback, Boolean(options.id), Boolean(options.bundle)].filter(Boolean);
    if (modes.length > 1) {
      throw new Error("Use only one of feedback --list, --create, --id, or --bundle.");
    }
    if (modes.length === 0) options.list = true;
    if (options.createFeedback && !options.body) {
      throw new Error("feedback --create requires --body.");
    }
    if (options.resolve && options.reopen) {
      throw new Error("--resolve and --reopen cannot be used together.");
    }
    if ((options.resolve || options.reopen) && !options.id) {
      throw new Error("--resolve/--reopen require --id.");
    }
    if (options.id && !options.body && !options.resolve && !options.reopen && !options.json && !options.apply && !options.dryRun) {
      // allow --id alone as get
    }
    if (options.bundle && (options.createFeedback || options.resolve || options.reopen || options.body)) {
      throw new Error("feedback --bundle does not accept --create/--body/--resolve/--reopen.");
    }
    if (options.installBrowser || options.yes || options.init || options.name || options.out ||
        options.baseline || options.against || options.strict || options.port !== null ||
        options.checkout || options.create || options.review || options.adopt || options.path || options.start) {
      throw new Error("feedback accepts --list/--create/--id/--bundle/--body/--route/--viewport/--element/--run-id/--resolve/--reopen/--from/--note/--dry-run/--apply/--force/--json/--root only.");
    }
  }
  if (action === "serve" && (options.apply || options.dryRun || options.installBrowser || options.yes ||
      options.force || options.init || options.name || options.out || options.from || options.note ||
      options.baseline || options.against || options.strict)) {
    throw new Error("serve accepts --root/--port/--json only. It binds loopback and is read-only.");
  }
  return options;
}

function explainNextSteps(report) {
  const steps = [];
  if (!report.harness.configExists) {
    steps.push({
      id: "config",
      command: "npm run harness -- setup --root <project> --dry-run",
      then: "npm run harness -- setup --root <project> --apply",
      why: "Writes only a missing harness.config.json (start command + local URL). Preview first, then apply.",
    });
  }
  steps.push({
    id: "attach",
    command: "npm run harness -- attach --dry-run",
    then: "npm run harness -- attach --until scaffold --apply --yes",
    why: "One-command path: doctor → setup → probe → scaffold (optional run/promote). Prefer this for agent attach.",
  });
  steps.push({
    id: "browser",
    command: "npm run harness -- setup --install-browser",
    then: "npm run harness -- setup --install-browser --yes",
    why: "Checks Chromium. Ask the host before --yes; the harness installs it only after consent.",
  });
  if (report.harness.controlSurface.status === "no-reference") {
    steps.push({
      id: "control-surface",
      command: null,
      why: "AGENT TASK: Inspect the target app's native store/actions, then implement an opt-in harness control surface in that language (web: window.__harness; Swift: HarnessControlling — docs/platforms.md, docs/control-convention.md). Do not scrape rendered UI, patch the renderer, or invent product behavior. Examples: examples/foreign-booking/harness-adapter.js, examples/swift-control-surface/.",
      agentChecklist: [
        "Find the app's real state/actions (store, hooks, reducers, controllers, ViewModels).",
        "Add an opt-in adapter (web: ?harness=1 / __HARNESS_ENABLED__; Swift: yxnHarnessEnabled).",
        "Expose state(), commands() with payloadSchema, command(), on/off, clock.",
        "Map only real product operations — never MutationObserver / view-tree scraping.",
        "Check agentAttach.runners — only status=ready runners are attachable today.",
        "Ask the host before large product refactors; keep the adapter thin.",
      ],
    });
  }
  steps.push({
    id: "probe",
    command: "npm run harness -- probe --root <project> --json",
    why: "Starts the app, reads live commands() and state(), and prints them.",
  });
  steps.push({
    id: "scaffold",
    command: "npm run harness -- scaffold --root <project> --dry-run",
    then: "npm run harness -- scaffold --root <project> --apply",
    why: "Turns probe commands into a draft scenario YAML. Review payloads/expects before trusting a green run.",
  });
  steps.push({
    id: "run",
    command: "npm run harness -- run scenarios/<name>.yaml --root <project>",
    why: "Produces screenshots, state log, and result.json evidence for the exercised flow.",
  });
  steps.push({
    id: "host-config",
    command: "npm run harness -- host-config --init --dry-run",
    then: "npm run harness -- host-config --init --apply",
    why: "Writes local cockpit policy (visibility, consent, merge authority). No hosting yet — data only.",
  });
  steps.push({
    id: "status",
    command: "npm run harness -- status --json",
    why: "Refreshes artifacts/index.json and summarizes runs, pointers, host config, and workspace.",
  });
  steps.push({
    id: "workspace",
    command: "npm run harness -- workspace --json",
    then: "npm run harness -- workspace --review <branch>",
    why: "Git workspace: create/checkout, review diffs, adopt (merge) into your branch — local only.",
  });
  steps.push({
    id: "handoff",
    command: "npm run harness -- handoff --from last-green --dry-run",
    then: "npm run harness -- handoff --from last-green --apply",
    why: "Bundles one run into a deliberate agent handoff package (context, not executable instructions).",
  });
  steps.push({
    id: "compare",
    command: "npm run harness -- compare --json",
    then: "npm run harness -- compare --baseline last-green --against last-run --json",
    why: "Diffs state + screenshots between a baseline run and a candidate (evidence for visual claims).",
  });
  steps.push({
    id: "promote",
    command: "npm run harness -- promote --from last-green --dry-run",
    then: "npm run harness -- promote --from last-green --apply",
    why: "Copies after-state from a green run into scenario expects — durable checks without hand-writing YAML.",
  });
  steps.push({
    id: "feedback",
    command: "npm run harness -- feedback --create --body \"Tighten the primary CTA spacing\" --route / --apply",
    then: "npm run harness -- feedback --bundle <threadId> --from last-green --apply",
    why: "Local visual feedback threads (branch/commit/route/viewport/element) — bundle into an agent handoff.",
  });
  steps.push({
    id: "elements",
    command: "npm run harness -- elements --adopt --element PrimaryButton --source-branch feature/demo --dry-run",
    then: "npm run harness -- elements --adopt --element PrimaryButton --source-branch feature/demo --apply --with-handoff",
    why: "Visual element adopt: record element-scoped feedback (yours vs source) and optionally bundle a handoff.",
  });
  steps.push({
    id: "serve",
    command: `npm run harness -- serve --port ${COCKPIT_DEFAULT_PORT}`,
    why: "Starts the local cockpit shell + loopback API (review, runs, handoffs, feedback, agent panel).",
  });
  return steps;
}

function assert(condition, message) {
  if (!condition) throw new TypeError(`harness: ${message}`);
}

function validateScenario(scenario, scenarioPath) {
  assert(scenario && typeof scenario === "object" && !Array.isArray(scenario), `${scenarioPath} must contain a YAML object.`);
  assert(SCENARIO_VALIDATOR(scenario), `invalid scenario "${scenarioPath}": ${JSON.stringify(SCENARIO_VALIDATOR.errors)}`);
  assert(typeof scenario.name === "string" && scenario.name.trim(), "scenario needs a non-empty name.");
  assert(Array.isArray(scenario.viewports) && scenario.viewports.length > 0, "scenario needs at least one viewport.");
  assert(scenario.viewports.length <= 16, "scenario may define at most 16 viewports.");
  assert(Array.isArray(scenario.steps) && scenario.steps.length > 0, "scenario needs at least one step.");
  assert(scenario.steps.length <= 100, "scenario may define at most 100 steps.");

  const viewportNames = new Set();
  for (const [index, viewport] of scenario.viewports.entries()) {
    assert(viewport && typeof viewport === "object" && !Array.isArray(viewport), `viewports[${index}] must be an object.`);
    assert(typeof viewport.name === "string" && viewport.name.trim(), `viewports[${index}] needs a name.`);
    assert(!viewportNames.has(viewport.name), `duplicate viewport name "${viewport.name}".`);
    viewportNames.add(viewport.name);
    for (const dimension of ["width", "height"]) {
      assert(Number.isInteger(viewport[dimension]) && viewport[dimension] >= 1 && viewport[dimension] <= 4096,
        `viewport "${viewport.name}" ${dimension} must be an integer from 1 to 4096.`);
    }
  }

  for (const [index, step] of scenario.steps.entries()) {
    assert(step && typeof step === "object" && !Array.isArray(step), `steps[${index}] must be an object.`);
    const hasCommand = typeof step.command === "string" && step.command.trim().length > 0;
    const hasClock = step.clock !== undefined;
    assert(hasCommand !== hasClock, `steps[${index}] must define exactly one of command or clock.`);
    if (hasClock) {
      assert(step.clock && typeof step.clock === "object" && !Array.isArray(step.clock),
        `steps[${index}].clock must be an object.`);
      const operations = Object.keys(step.clock);
      assert(operations.length === 1 && ["advance", "seek"].includes(operations[0]),
        `steps[${index}].clock must contain exactly one of advance or seek.`);
      const time = step.clock[operations[0]];
      assert(Number.isFinite(time) && time >= 0 && time <= 86400000,
        `steps[${index}].clock time must be between 0 and 86400000 milliseconds.`);
      assert(step.payload === undefined, `steps[${index}] clock actions may not have a command payload.`);
    }
    assert(step.payload === undefined || isJsonValue(step.payload), `steps[${index}] payload must be JSON-compatible.`);
    assert(step.expect === undefined || isJsonObject(step.expect), `steps[${index}] expect must be an object.`);
    assert(step.expectClock === undefined ||
      (Number.isFinite(step.expectClock) && step.expectClock >= 0 && step.expectClock <= 86400000),
    `steps[${index}].expectClock must be between 0 and 86400000 milliseconds.`);
    if (step.snapshot !== undefined) {
      assert(typeof step.snapshot === "string" && step.snapshot.trim(), `steps[${index}] snapshot must be a non-empty string.`);
    }
  }
  return scenario;
}

function validateConfig(config) {
  assert(config && typeof config === "object" && !Array.isArray(config), "harness.config.json must contain an object.");
  assert(config.version === 1, "harness.config.json version must be 1.");
  assert(config.app && typeof config.app === "object", "harness.config.json needs an app object.");
  assert(Array.isArray(config.app.start) && config.app.start.length > 0 &&
    config.app.start.every((part) => typeof part === "string" && part.length > 0),
  "app.start must be a non-empty array of command arguments.");
  assert(typeof config.app.url === "string", "app.url must be a URL string.");
  const appUrl = new URL(config.app.url);
  assert(["http:", "https:"].includes(appUrl.protocol), "app.url must use HTTP or HTTPS.");
  assert(["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname),
    "local runner app.url must use localhost or a loopback IP address.");
  assert(Number.isInteger(config.app.startupTimeoutMs ?? 15000) &&
    (config.app.startupTimeoutMs ?? 15000) >= 1000 &&
    (config.app.startupTimeoutMs ?? 15000) <= 120000,
  "app.startupTimeoutMs must be between 1000 and 120000.");
  assert(Number.isInteger(config.app.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS) &&
    (config.app.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS) >= 1000 &&
    (config.app.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS) <= 120000,
  "app.navigationTimeoutMs must be between 1000 and 120000.");
  assert(Number.isInteger(config.app.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS) &&
    (config.app.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS) >= 1000 &&
    (config.app.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS) <= 120000,
  "app.commandTimeoutMs must be between 1000 and 120000.");
  const inheritEnv = config.app.inheritEnv ?? [];
  assert(Array.isArray(inheritEnv) && inheritEnv.every((name) =>
    typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(name)),
  "app.inheritEnv must contain valid variable names and may not override runtime injection variables.");
  assert(new Set(inheritEnv).size === inheritEnv.length, "app.inheritEnv may not contain duplicate names.");
  return {
    ...config,
    app: {
      ...config.app,
      url: appUrl.href,
      startupTimeoutMs: config.app.startupTimeoutMs ?? 15000,
      navigationTimeoutMs: config.app.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
      commandTimeoutMs: config.app.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      inheritEnv,
    },
  };
}

function isJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;

  const active = new Set();
  function visit(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (!item || typeof item !== "object" || active.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) return false;
    active.add(item);
    const values = Array.isArray(item) ? item : Object.values(item);
    const valid = values.every(visit);
    active.delete(item);
    return valid;
  }
  return visit(value);
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}

function matchesExpected(actual, expected, location = "state") {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      return `${location} expected an object, received ${JSON.stringify(actual)}.`;
    }
    for (const [key, value] of Object.entries(expected)) {
      const error = matchesExpected(actual[key], value, `${location}.${key}`);
      if (error) return error;
    }
    return null;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
      return `${location} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`;
    }
    return null;
  }
  if (!Object.is(actual, expected)) {
    return `${location} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`;
  }
  return null;
}

function safeSlug(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.slice(0, 64) || "snapshot";
}

async function loadJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label} "${filePath}": ${error.message}`);
  }
}

async function loadScenario(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`could not read scenario "${filePath}": ${error.message}`);
  }
  let scenario;
  try {
    scenario = yaml.load(contents, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    throw new Error(`invalid scenario YAML "${filePath}": ${error.message}`);
  }
  return validateScenario(scenario, filePath);
}

async function waitForApp(url, timeoutMs, child, logPath, getSpawnError) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw new Error(`could not start app process: ${spawnError.message}; see ${logPath}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`app process exited (${child.exitCode === null ? child.signalCode : `code ${child.exitCode}`}); see ${logPath}`);
    }
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(1000, remainingMs)) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`app did not become ready at ${url} within ${timeoutMs}ms (${lastError}); see ${logPath}`);
}

async function stopChild(child, { graceMs = 3000, forceGraceMs = 2000 } = {}) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
      stdio: "ignore",
      timeout: 5000,
      shell: false,
    });
    if (result.error) throw new Error(`could not stop app process tree: ${result.error.message}`);
    if (result.status !== 0 && child.exitCode === null && child.signalCode === null) {
      throw new Error(`taskkill could not stop app process tree (exit ${result.status}).`);
    }
    return;
  }

  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw new Error(`could not send ${signal} to app process group ${child.pid}: ${error.message}`);
    }
  };
  const groupExists = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") return true;
      throw new Error(`could not inspect app process group ${child.pid}: ${error.message}`);
    }
  };
  const waitForGroupExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (groupExists() && Date.now() < deadline) await delay(50);
    return !groupExists();
  };

  signalGroup("SIGTERM");
  if (await waitForGroupExit(graceMs)) return;
  signalGroup("SIGKILL");
  if (!await waitForGroupExit(forceGraceMs)) {
    throw new Error(`app process group ${child.pid} remained alive after SIGKILL.`);
  }
}

class HarnessTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${timeoutMs}ms.`);
    this.name = "HarnessTimeoutError";
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HarnessTimeoutError(label, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function evaluateWithTimeout(page, callback, argument, timeoutMs, label) {
  return withTimeout(page.evaluate(callback, argument), timeoutMs, label);
}

function serializeHarnessState(state, label) {
  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch (error) {
    throw new Error(`${label} is not JSON-serializable: ${error.message}`);
  }
  if (typeof serialized !== "string") throw new Error(`${label} did not return a JSON value.`);
  return JSON.parse(serialized);
}

function getAppEnvironment(config) {
  const environment = {};
  for (const name of [...SAFE_INHERITED_ENV, ...config.app.inheritEnv]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function installEventCapture(page, timeoutMs) {
  await evaluateWithTimeout(page, () => {
    window.__harnessRunEvents = [];
    for (const eventName of ["statechange", "animationend", "error"]) {
      window.__harness.on(eventName, (event) => {
        let detail;
        try {
          detail = JSON.parse(JSON.stringify(event.detail ?? null));
        } catch (error) {
          detail = { serializationError: error.message };
        }
        window.__harnessRunEvents.push({ event: eventName, detail, at: window.__harness.clock.now() });
      });
    }
  }, undefined, timeoutMs, "harness event subscription");
}

async function getCapturedEvents(page, timeoutMs) {
  return evaluateWithTimeout(page, () => {
    const events = window.__harnessRunEvents || [];
    window.__harnessRunEvents = [];
    return events;
  }, undefined, timeoutMs, "harness event read");
}

async function createContactSheet(browser, capturePaths, runDirectory) {
  const cardData = await Promise.all(capturePaths.map(async (capture) => ({
    label: `${capture.viewport} · ${capture.snapshot}`,
    data: (await readFile(path.join(runDirectory, capture.path))).toString("base64"),
  })));
  const columns = Math.min(2, Math.max(1, cardData.length));
  const width = columns * 560;
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const cards = cardData.map(({ label, data }) => (
    `<article><h2>${escapeHtml(label)}</h2><img src="data:image/png;base64,${data}" alt="${escapeHtml(label)}"></article>`
  )).join("");
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:16px;background:#edf1f7;color:#172033;font:14px/1.4 system-ui,sans-serif}
    main{display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:16px}
    article{min-width:0;padding:12px;border:1px solid #dfe5ee;border-radius:12px;background:white}
    h2{margin:0 0 8px;font-size:14px}img{display:block;width:100%;height:auto;border:1px solid #e6e9ef}
  </style><main>${cards}</main>`);
  await page.locator("img").evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  await page.locator("main").screenshot({ path: path.join(runDirectory, "contact-sheet.png"), fullPage: true });
  await page.close();
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function compareWithLastGreen(root, scenarioName) {
  const pointerPath = path.join(root, "artifacts", "last-green.json");
  try {
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    const resultPath = path.resolve(root, pointer.result);
    const relativeResultPath = path.relative(root, resultPath);
    assert(!relativeResultPath.startsWith(`..${path.sep}`) && relativeResultPath !== "..",
      "last-green result path must stay inside the project root.");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    return {
      runId: pointer.runId,
      scenario: pointer.scenario,
      result: pointer.result,
      sameScenario: pointer.scenario === scenarioName,
      status: result.status,
      durationMs: result.durationMs,
      counts: result.counts,
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`could not read last-green run pointer "${pointerPath}": ${error.message}`);
  }
}

async function writeLastGreen(root, runId, scenarioName, resultPath) {
  const artifactsDirectory = path.join(root, "artifacts");
  const temporaryPath = path.join(artifactsDirectory, `.last-green-${runId}.tmp`);
  const pointerPath = path.join(artifactsDirectory, "last-green.json");
  await writeFile(temporaryPath, `${JSON.stringify({ runId, scenario: scenarioName, result: resultPath }, null, 2)}\n`);
  await rename(temporaryPath, pointerPath);
}

async function writeLastRun(root, runId, scenarioName, resultPath, status) {
  const artifactsDirectory = path.join(root, "artifacts");
  const temporaryPath = path.join(artifactsDirectory, `.last-run-${runId}.tmp`);
  const pointerPath = path.join(artifactsDirectory, "last-run.json");
  await writeFile(temporaryPath, `${JSON.stringify({ runId, scenario: scenarioName, result: resultPath, status }, null, 2)}\n`);
  await rename(temporaryPath, pointerPath);
}

async function executeViewport({ browser, config, scenario, viewport, root, runDirectory, log, captures }) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(config.app.commandTimeoutMs);
  page.setDefaultNavigationTimeout(config.app.navigationTimeoutMs);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console error: ${message.text()}`);
  });

  const viewportResult = {
    name: viewport.name,
    width: viewport.width,
    height: viewport.height,
    status: "passed",
    steps: [],
    errors: [],
  };
  try {
    const appUrl = new URL(config.app.url);
    appUrl.searchParams.set("harness", "1");
    await page.goto(appUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: config.app.navigationTimeoutMs,
    });
    try {
      await page.waitForFunction(() => Boolean(window.__harness), undefined, {
        timeout: config.app.navigationTimeoutMs,
      });
    } catch (error) {
      if (error.name === "TimeoutError") {
        throw new Error(`App did not expose window.__harness within ${config.app.navigationTimeoutMs}ms after ?harness=1.`);
      }
      throw error;
    }
    const contract = await evaluateWithTimeout(page, () => {
      if (!window.__harness) throw new Error("App did not expose window.__harness after ?harness=1.");
      if (window.__harness.version !== 1) throw new Error(`Unsupported control contract version ${window.__harness.version}.`);
      if (typeof window.__harness.state !== "function" ||
          typeof window.__harness.commands !== "function" ||
          typeof window.__harness.command !== "function" ||
          typeof window.__harness.on !== "function" ||
          typeof window.__harness.off !== "function") {
        throw new Error("Harness control API does not satisfy the required methods.");
      }
      const clockMethods = ["pause", "resume", "advance", "seek", "now"];
      if (!window.__harness.clock ||
          clockMethods.some((method) => typeof window.__harness.clock[method] !== "function")) {
        throw new Error("Harness control API has an incomplete clock.");
      }
      const commands = window.__harness.commands();
      if (!Array.isArray(commands)) throw new Error("commands() must return an array.");
      const state = window.__harness.state();
      const encodedState = JSON.stringify(state);
      if (typeof encodedState !== "string") throw new Error("state() must return a JSON value.");
      window.__harness.clock.pause();
      const clock = window.__harness.clock.now();
      if (!Number.isFinite(clock)) throw new Error("clock.now() must return a finite number.");
      return { commands, state: JSON.parse(encodedState), clock };
    }, undefined, config.app.commandTimeoutMs, "harness contract inspection");
    const commandMap = new Map();
    for (const [index, descriptor] of contract.commands.entries()) {
      assert(descriptor && typeof descriptor.name === "string" && descriptor.name.trim(),
        `commands()[${index}] needs a name.`);
      assert(!commandMap.has(descriptor.name), `commands() contains duplicate "${descriptor.name}".`);
      if (descriptor.payloadSchema !== undefined) {
        try {
          commandMap.set(descriptor.name, {
            descriptor,
            validate: JSON_SCHEMA_VALIDATOR.compile(descriptor.payloadSchema),
          });
        } catch (error) {
          throw new Error(`Invalid payload schema for command "${descriptor.name}": ${error.message}`);
        }
      } else {
        commandMap.set(descriptor.name, { descriptor, validate: null });
      }
    }

    await installEventCapture(page, config.app.commandTimeoutMs);
    await log({
      at: new Date().toISOString(),
      viewport: viewport.name,
      phase: "initial",
      state: contract.state,
      clock: contract.clock,
      commands: contract.commands.map(({ name }) => name),
    });

    for (const [stepIndex, step] of scenario.steps.entries()) {
      const stepAction = step.command || `clock.${Object.keys(step.clock)[0]}`;
      const stepResult = { index: stepIndex, name: step.name || stepAction, command: stepAction, status: "passed" };
      let abortViewport = false;
      try {
        const before = serializeHarnessState(await evaluateWithTimeout(page,
          () => window.__harness.state(), undefined, config.app.commandTimeoutMs, "harness state()"),
        "state()");
        let actionResult;
        if (step.clock) {
          const [operation, milliseconds] = Object.entries(step.clock)[0];
          actionResult = await evaluateWithTimeout(page,
            ({ operation: clockOperation, time }) => window.__harness.clock[clockOperation](time),
            { operation, time: milliseconds },
            config.app.commandTimeoutMs,
            `clock.${operation}(${milliseconds})`,
          );
          stepResult.clock = { operation, milliseconds };
          stepResult.clock.result = serializeHarnessState(actionResult, `clock.${operation} result`);
        } else {
          const command = commandMap.get(step.command);
          if (!command) {
            const names = Array.from(commandMap.keys());
            throw new Error(`Unknown command "${step.command}". Available commands: ${names.join(", ") || "(none)"}.`);
          }
          if (command.validate) {
            const payload = step.payload === undefined ? null : step.payload;
            if (!command.validate(payload)) {
              throw new Error(`Invalid payload for "${step.command}": ${JSON.stringify(command.validate.errors)}`);
            }
          } else if (step.payload !== undefined) {
            throw new Error(`Command "${step.command}" does not advertise a payload schema; scenario payload is not allowed.`);
          }

          actionResult = await evaluateWithTimeout(page,
            async ({ name, payload }) => window.__harness.command(name, payload),
            { name: step.command, payload: step.payload },
            config.app.commandTimeoutMs,
            `command "${step.command}"`,
          );
          if (!actionResult || typeof actionResult.ok !== "boolean") {
            throw new Error(`Command "${step.command}" must return an { ok } result.`);
          }
          if (!actionResult.ok) {
            throw new Error(`Command "${step.command}" failed: ${actionResult.error?.code || "error"}: ${actionResult.error?.message || "no message"}`);
          }
        }
        const after = serializeHarnessState(await evaluateWithTimeout(page,
          () => window.__harness.state(), undefined, config.app.commandTimeoutMs, "harness state()"),
        "state()");
        const clockNow = await evaluateWithTimeout(page, () => window.__harness.clock.now(), undefined,
          config.app.commandTimeoutMs, "harness clock read");
        if (!Number.isFinite(clockNow)) throw new Error("clock.now() must return a finite number.");
        stepResult.before = before;
        stepResult.after = after;
        stepResult.clockTime = clockNow;
        if (step.clock) {
          stepResult.clock.now = clockNow;
        } else {
          stepResult.commandResult = serializeHarnessState(actionResult, `result of "${step.command}"`);
        }
        await log({
          at: new Date().toISOString(),
          viewport: viewport.name,
          phase: "command",
          step: stepIndex,
          command: stepAction,
          before,
          after,
          result: step.clock ? stepResult.clock.result : stepResult.commandResult,
          clock: clockNow,
        });

        stepResult.events = await getCapturedEvents(page, config.app.commandTimeoutMs);

        if (step.snapshot) {
          await evaluateWithTimeout(page, async () => {
            await document.fonts.ready;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }, undefined, config.app.commandTimeoutMs, "frame readiness");
          const captureName = `${safeSlug(viewport.name)}-${String(stepIndex + 1).padStart(2, "0")}-${safeSlug(step.snapshot)}.png`;
          const capturePath = path.join(runDirectory, "screenshots", captureName);
          await withTimeout(page.screenshot({
            path: capturePath,
            fullPage: true,
            animations: "disabled",
            caret: "hide",
          }), config.app.commandTimeoutMs, `screenshot "${step.snapshot}"`);
          const relativeCapturePath = path.relative(runDirectory, capturePath);
          captures.push({ viewport: viewport.name, snapshot: step.snapshot, path: relativeCapturePath });
          stepResult.screenshot = relativeCapturePath;
        }
        if (step.expectClock !== undefined && !Object.is(clockNow, step.expectClock)) {
          throw new Error(`Clock expectation failed: expected ${step.expectClock}, received ${clockNow}.`);
        }
        if (step.expect) {
          const mismatch = matchesExpected(after, step.expect);
          if (mismatch) throw new Error(`Expectation failed: ${mismatch}`);
        }
      } catch (error) {
        stepResult.status = "failed";
        stepResult.error = error.message;
        abortViewport = error instanceof HarnessTimeoutError;
        viewportResult.status = "failed";
        viewportResult.errors.push(`step ${stepIndex + 1} "${stepResult.name}": ${error.message}`);
        stepResult.events = abortViewport ? [] :
          await getCapturedEvents(page, config.app.commandTimeoutMs);
      }
      viewportResult.steps.push(stepResult);
      await log({
        at: new Date().toISOString(),
        viewport: viewport.name,
        phase: "step-complete",
        step: stepIndex,
        status: stepResult.status,
        ...(stepResult.error ? { error: stepResult.error } : {}),
        events: stepResult.events,
      });
      if (abortViewport) break;
    }
    if (pageErrors.length) {
      viewportResult.status = "failed";
      viewportResult.errors.push(...pageErrors);
    }
  } catch (error) {
    viewportResult.status = "failed";
    viewportResult.errors.push(error.message);
  } finally {
    await page.close();
  }
  return viewportResult;
}

async function startManagedApp(root, config, appLogPath) {
  await mkdir(path.dirname(appLogPath), { recursive: true });
  const appLog = createWriteStream(appLogPath);
  const command = config.app.start[0];
  const args = config.app.start.slice(1);
  console.log(`Starting app: ${[command, ...args].join(" ")}`);
  let childSpawnError;
  const child = spawn(command, args, {
    cwd: root,
    env: getAppEnvironment(config),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: true,
  });
  child.on("error", (error) => { childSpawnError = error; });
  child.stdout.pipe(appLog, { end: false });
  child.stderr.pipe(appLog, { end: false });
  try {
    await waitForApp(config.app.url, config.app.startupTimeoutMs, child,
      path.relative(root, appLogPath), () => childSpawnError);
  } catch (error) {
    try {
      await stopChild(child);
    } catch {
      // Prefer the original readiness error.
    }
    await new Promise((resolve) => appLog.end(() => resolve()));
    throw error;
  }
  return {
    child,
    async close() {
      const errors = [];
      try {
        await stopChild(child);
      } catch (error) {
        errors.push(error.message);
      }
      try {
        await new Promise((resolve, reject) => {
          appLog.end((error) => error ? reject(error) : resolve());
        });
      } catch (error) {
        errors.push(`could not close app log: ${error.message}`);
      }
      if (errors.length) throw new Error(errors.join("; "));
    },
  };
}

async function readHarnessContract(page, timeoutMs) {
  try {
    await page.waitForFunction(() => Boolean(window.__harness), undefined, { timeout: timeoutMs });
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new Error(`App did not expose window.__harness within ${timeoutMs}ms after ?harness=1.`);
    }
    throw error;
  }
  return evaluateWithTimeout(page, () => {
    if (!window.__harness) throw new Error("App did not expose window.__harness after ?harness=1.");
    if (window.__harness.version !== 1) throw new Error(`Unsupported control contract version ${window.__harness.version}.`);
    if (typeof window.__harness.state !== "function" ||
        typeof window.__harness.commands !== "function" ||
        typeof window.__harness.command !== "function" ||
        typeof window.__harness.on !== "function" ||
        typeof window.__harness.off !== "function") {
      throw new Error("Harness control API does not satisfy the required methods.");
    }
    const clockMethods = ["pause", "resume", "advance", "seek", "now"];
    if (!window.__harness.clock ||
        clockMethods.some((method) => typeof window.__harness.clock[method] !== "function")) {
      throw new Error("Harness control API has an incomplete clock.");
    }
    const commands = window.__harness.commands();
    if (!Array.isArray(commands)) throw new Error("commands() must return an array.");
    const state = window.__harness.state();
    const encodedCommands = JSON.stringify(commands);
    const encodedState = JSON.stringify(state);
    if (typeof encodedCommands !== "string" || typeof encodedState !== "string") {
      throw new Error("commands()/state() must return JSON values.");
    }
    window.__harness.clock.pause();
    const clock = window.__harness.clock.now();
    if (!Number.isFinite(clock)) throw new Error("clock.now() must return a finite number.");
    return {
      version: window.__harness.version,
      commands: JSON.parse(encodedCommands),
      state: JSON.parse(encodedState),
      clock,
    };
  }, undefined, timeoutMs, "harness contract inspection");
}

async function probeApp({ root, config, yes = false }) {
  const browserPlan = ensureChromium(root, { yes });
  if (!browserPlan.ok) {
    return {
      ok: false,
      status: browserPlan.status,
      browser: browserPlan,
      explanation: browserPlan.explanation,
      next: browserPlan.resumeWith ? [browserPlan.resumeWith, "npm run harness -- probe --json"] : [],
    };
  }

  const probeDirectory = path.join(root, "artifacts", "probe");
  await mkdir(probeDirectory, { recursive: true });
  const managed = await startManagedApp(root, config, path.join(probeDirectory, "app.log"));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu", "--force-color-profile=srgb"],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(config.app.commandTimeoutMs);
    page.setDefaultNavigationTimeout(config.app.navigationTimeoutMs);
    const appUrl = new URL(config.app.url);
    appUrl.searchParams.set("harness", "1");
    await page.goto(appUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: config.app.navigationTimeoutMs,
    });
    const harness = await readHarnessContract(page, config.app.navigationTimeoutMs);
    await page.close();
    return {
      ok: true,
      status: "ready",
      app: {
        start: config.app.start,
        url: config.app.url,
      },
      browser: {
        status: browserPlan.status,
        action: browserPlan.action,
        path: browserPlan.path,
      },
      harness,
      explanation: "Live control surface is reachable. Use harness.commands[].name in scenario steps; keep payloads inside each command's payloadSchema.",
      next: [
        "npm run harness -- scaffold --dry-run",
        "npm run harness -- scaffold --apply",
        "Review payloads/expects, then npm run harness -- run scenarios/smoke.yaml",
      ],
    };
  } finally {
    if (browser) await browser.close();
    await managed.close();
  }
}

function formatProbeReport(report) {
  if (!report.ok) {
    const lines = [`Probe: ${report.status}`, report.explanation || ""];
    if (report.browser?.askUser) lines.push(`Ask user: ${report.browser.askUser}`);
    for (const step of report.next || []) lines.push(`Next: ${step}`);
    return lines.filter(Boolean).join("\n");
  }
  const commandNames = (report.harness?.commands || []).map((command) => command.name);
  const lines = [
    "Probe: ready",
    `App start: ${report.app.start.join(" ")}`,
    `URL: ${report.app.url}`,
    `Harness version: ${report.harness.version}`,
    `Clock: ${report.harness.clock}`,
    `Commands (${commandNames.length}): ${commandNames.join(", ") || "(none)"}`,
    `Initial state: ${JSON.stringify(report.harness.state)}`,
    report.explanation,
  ];
  for (const step of report.next || []) lines.push(`Next: ${step}`);
  return lines.join("\n");
}

async function runScenario({ root, scenarioPath, scenario, config }) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const runDirectory = path.join(root, "artifacts", runId);
  await mkdir(path.join(runDirectory, "screenshots"), { recursive: true });
  const previousGreen = await compareWithLastGreen(root, scenario.name);
  const stateLogPath = path.join(runDirectory, "state.jsonl");
  const appLogPath = path.join(runDirectory, "app.log");
  const appLog = createWriteStream(appLogPath);
  const stateLog = createWriteStream(stateLogPath, { flags: "a" });
  const log = (entry) => new Promise((resolve, reject) => {
    stateLog.write(`${JSON.stringify(entry)}\n`, (error) => error ? reject(error) : resolve());
  });
  const captures = [];
  const result = {
    version: 1,
    runId,
    scenario: { name: scenario.name, path: path.relative(root, scenarioPath) },
    startedAt: new Date().toISOString(),
    status: "running",
    git: collectGit(root),
    comparison: { lastGreen: previousGreen },
    viewports: [],
    artifacts: {
      stateLog: "state.jsonl",
      appLog: "app.log",
      screenshots: [],
      contactSheet: null,
    },
  };

  let child;
  let browser;
  let childSpawnError;
  const cleanupErrors = [];
  try {
    const command = config.app.start[0];
    const args = config.app.start.slice(1);
    console.log(`Starting app: ${[command, ...args].join(" ")}`);
    child = spawn(command, args, {
      cwd: root,
      env: getAppEnvironment(config),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: true,
    });
    child.on("error", (error) => { childSpawnError = error; });
    child.stdout.pipe(appLog, { end: false });
    child.stderr.pipe(appLog, { end: false });
    await waitForApp(config.app.url, config.app.startupTimeoutMs, child,
      path.relative(root, appLogPath), () => childSpawnError);

    const browserPlan = ensureChromium(root, { yes: false });
    if (!browserPlan.ok) throw new Error(INSTALL_BROWSER_MESSAGE);
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu", "--force-color-profile=srgb"],
    });
    for (const viewport of scenario.viewports) {
      const viewportResult = await executeViewport({
        browser, config, scenario, viewport, root, runDirectory, log, captures,
      });
      result.viewports.push(viewportResult);
    }

    result.artifacts.screenshots = captures.map((capture) => capture.path);
    if (captures.length) {
      await createContactSheet(browser, captures, runDirectory);
      result.artifacts.contactSheet = "contact-sheet.png";
    }
    result.status = result.viewports.every((viewport) => viewport.status === "passed") ? "passed" : "failed";
  } catch (error) {
    result.status = "failed";
    result.error = error.message;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        cleanupErrors.push(`could not close browser: ${error.message}`);
      }
    }
    if (child) {
      try {
        await stopChild(child);
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }
    for (const [stream, label] of [[appLog, "app log"], [stateLog, "state log"]]) {
      try {
        await new Promise((resolve, reject) => {
          stream.end((error) => error ? reject(error) : resolve());
        });
      } catch (error) {
        cleanupErrors.push(`could not close ${label}: ${error.message}`);
      }
    }
    if (cleanupErrors.length) {
      result.status = "failed";
      result.error = [result.error, ...cleanupErrors].filter(Boolean).join("; ");
    }
  }

  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
  result.counts = {
    viewports: result.viewports.length,
    steps: result.viewports.reduce((total, viewport) => total + viewport.steps.length, 0),
    failures: result.viewports.reduce((total, viewport) => total + viewport.errors.length, 0) +
      (result.error ? 1 : 0),
    screenshots: result.artifacts.screenshots.length,
  };
  await writeFile(path.join(runDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const resultPath = path.relative(root, path.join(runDirectory, "result.json"));
  await writeLastRun(root, runId, scenario.name, resultPath, result.status);
  if (result.status === "passed") {
    await writeLastGreen(root, runId, scenario.name, resultPath);
  }
  try {
    await writeRunIndex(root);
  } catch (error) {
    console.error(`warning: could not refresh artifacts/index.json: ${error.message}`);
  }
  console.log(`Scenario ${scenario.name}: ${result.status} (${result.counts.steps} steps, ${result.counts.failures} failures)`);
  console.log(`Artifacts: ${path.relative(root, runDirectory)}`);
  if (result.artifacts.contactSheet) console.log(`Contact sheet: ${path.relative(root, path.join(runDirectory, result.artifacts.contactSheet))}`);
  if (result.status !== "passed") process.exitCode = 1;
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    console.log("");
    console.log("Consent model: the harness never installs Chromium unless you pass --yes after asking the host.");
    console.log("setup --apply writes only a missing harness.config.json. setup --install-browser plans or installs the browser.");
    console.log("probe starts the configured app and prints live harness commands/state.");
    console.log("scaffold probes the app and drafts a scenario YAML (preview by default; --apply writes; --force overwrites).");
    console.log("host-config stores local cockpit policy (private by default; share links never grant write/merge).");
    console.log("status refreshes artifacts/index.json and summarizes runs, host policy, and Git workspace.");
    console.log("workspace: --create/--checkout/--review/--adopt <branch> (adopt merges theirs into yours; dirty trees need --force).");
    console.log("handoff bundles one run into artifacts/handoffs/<id> for a trusted coding agent (preview with --dry-run).");
    console.log("compare diffs last-green vs last-run (or explicit run ids) — state + screenshot evidence.");
    console.log("promote copies after-state from a green run into scenario expects (--dry-run, then --apply).");
    console.log("feedback creates local visual threads and bundles them into handoffs for your coding agent.");
    console.log("elements --adopt records visual element picks as element-scoped feedback (optional --with-handoff).");
    console.log("attach chains doctor→setup→probe→scaffold→run→promote (--dry-run by default; --until sets the stop phase).");
    console.log(`serve starts the cockpit UI + API on 127.0.0.1:${COCKPIT_DEFAULT_PORT} (open / for the shell).`);
    return null;
  }
  const root = path.resolve(options.root || process.cwd());
  if (options.action === "doctor") {
    const report = await inspectProject(root);
    report.nextSteps = explainNextSteps(report);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
      console.log("");
      console.log("What to do next (host decides; trusted agent may execute):");
      for (const step of report.nextSteps) {
        console.log(`- ${step.id}: ${step.why}`);
        if (step.command) console.log(`    ${step.command}`);
        if (step.then) console.log(`    then: ${step.then}`);
      }
    }
    return report;
  }
  if (options.action === "setup") {
    const plan = {
      version: 1,
      root,
      config: null,
      browser: null,
    };
    // Default `setup` (no flags) previews config. `--install-browser` alone skips config.
    const wantsConfig = options.apply || options.dryRun || !options.installBrowser;
    if (wantsConfig) {
      plan.config = await setupProject(root, { apply: options.apply });
    }
    if (options.installBrowser) {
      plan.browser = ensureChromium(root, { yes: options.yes });
    }

    if (options.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      if (plan.config) console.log(formatSetupPlan(plan.config));
      if (plan.browser) {
        if (plan.config) console.log("");
        console.log(formatBrowserPlan(plan.browser));
      }
    }
    if (plan.config?.status === "blocked" || (plan.browser && !plan.browser.ok)) process.exitCode = 1;
    return plan;
  }
  if (options.action === "probe") {
    const configPath = path.join(root, "harness.config.json");
    const config = validateConfig(await loadJson(configPath, "harness config"));
    const report = await probeApp({ root, config, yes: options.yes });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatProbeReport(report));
    if (!report.ok) process.exitCode = 1;
    return report;
  }
  if (options.action === "scaffold") {
    const configPath = path.join(root, "harness.config.json");
    const config = validateConfig(await loadJson(configPath, "harness config"));
    const probe = await probeApp({ root, config, yes: options.yes });
    if (!probe.ok) {
      console.log(options.json ? JSON.stringify({ ok: false, probe }, null, 2) : formatProbeReport(probe));
      process.exitCode = 1;
      return probe;
    }
    const scenarioName = options.name || "smoke";
    const scenario = buildScaffoldScenario({
      commands: probe.harness.commands,
      initialState: probe.harness.state,
      name: scenarioName,
      projectName: path.basename(root),
    });
    validateScenario(scenario, "scaffold");
    const plan = await writeScaffoldScenario(root, scenario, {
      out: options.out || path.join("scenarios", `${scenarioName}.yaml`),
      apply: options.apply,
      force: options.force,
    });
    plan.ok = plan.status !== "blocked";
    plan.probe = {
      commands: probe.harness.commands.map(({ name }) => name),
      state: probe.harness.state,
    };
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatScaffoldPlan(plan));
    if (!plan.ok) process.exitCode = 1;
    return plan;
  }
  if (options.action === "host-config") {
    if (options.init) {
      const plan = await initHostConfig(root, {
        apply: options.apply,
        force: options.force,
      });
      console.log(options.json ? JSON.stringify(plan, null, 2) : formatHostConfigPlan(plan));
      if (plan.status === "blocked") process.exitCode = 1;
      return plan;
    }
    const loaded = await loadHostConfig(root);
    const report = {
      ok: true,
      ...loaded,
      explanation: loaded.exists
        ? "Local cockpit policy is present. Hosts can change it later in the cockpit UI; agents should treat it as host intent."
        : "No harness.host.json yet. Preview defaults with --init --dry-run, then --init --apply after host review.",
    };
    console.log(options.json ? JSON.stringify(report, null, 2) : formatHostConfigSummary(loaded));
    return report;
  }
  if (options.action === "status") {
    const host = await loadHostConfig(root);
    const index = await writeRunIndex(root);
    const workspace = collectWorkspace(root);
    const report = {
      ok: true,
      root,
      host,
      workspace,
      index,
      explanation: "Status is the local cockpit data surface: host policy, Git workspace, and artifacts/index.json.",
    };
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatHostConfigSummary(host));
      console.log("");
      console.log(formatWorkspace(workspace));
      console.log("");
      console.log(formatRunIndex(index));
    }
    return report;
  }
  if (options.action === "share") {
    const plan = await createShareInvite(root, {
      apply: options.apply,
      force: options.force,
      note: options.note,
    });
    plan.ok = plan.status !== "blocked";
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatSharePlan(plan));
    if (!plan.ok) process.exitCode = 1;
    return plan;
  }
  if (options.action === "workspace") {
    if (options.fetch) {
      const plan = planWorkspaceFetch(root, {
        remote: options.remote,
        apply: options.apply,
      });
      plan.ok = plan.status === "ready" || plan.status === "applied";
      console.log(options.json ? JSON.stringify(plan, null, 2) : formatFetchPlan(plan));
      if (!plan.ok) process.exitCode = 1;
      return plan;
    }
    if (options.push) {
      const plan = planWorkspacePush(root, {
        remote: options.remote,
        force: options.force,
        apply: options.apply,
      });
      plan.ok = plan.status === "ready" || plan.status === "applied" || plan.status === "noop";
      console.log(options.json ? JSON.stringify(plan, null, 2) : formatPushPlan(plan));
      if (!plan.ok) process.exitCode = 1;
      return plan;
    }
    if (options.approve) {
      const plan = await planDesignApprove(root, {
        theirs: options.approve,
        apply: options.apply,
        force: options.force,
        note: options.note,
      });
      console.log(options.json ? JSON.stringify(plan, null, 2) : formatDesignApprovePlan(plan));
      if (!plan.ok) process.exitCode = 1;
      return plan;
    }
    if (options.review) {
      const review = buildWorkspaceReview(root, { theirs: options.review, path: options.path });
      review.ok = review.status === "ready" || review.status === "noop";
      console.log(options.json ? JSON.stringify(review, null, 2) : formatWorkspaceReview(review));
      if (!review.ok) process.exitCode = 1;
      return review;
    }
    if (options.adopt) {
      const plan = planWorkspaceAdopt(root, {
        theirs: options.adopt,
        apply: options.apply,
        force: options.force,
        comment: options.note,
        paths: options.paths.length ? options.paths : null,
        hunks: options.hunks,
      });
      plan.ok = plan.status === "ready" || plan.status === "applied" || plan.status === "noop";
      console.log(options.json ? JSON.stringify(plan, null, 2) : formatAdoptPlan(plan));
      if (!plan.ok) process.exitCode = 1;
      return plan;
    }
    if (options.create) {
      const plan = planWorkspaceCreate(root, {
        branch: options.create,
        from: options.start,
        apply: options.apply,
        force: options.force,
      });
      plan.ok = plan.status === "ready" || plan.status === "applied" || plan.status === "noop";
      console.log(options.json ? JSON.stringify(plan, null, 2) : formatCreatePlan(plan));
      if (!plan.ok) process.exitCode = 1;
      return plan;
    }
    if (options.checkout) {
      const plan = planWorkspaceCheckout(root, {
        branch: options.checkout,
        apply: options.apply,
        force: options.force,
      });
      plan.ok = plan.status === "ready" || plan.status === "applied" || plan.status === "noop";
      console.log(options.json ? JSON.stringify(plan, null, 2) : formatCheckoutPlan(plan));
      if (!plan.ok) process.exitCode = 1;
      return plan;
    }
    const workspace = collectWorkspace(root);
    const report = {
      ok: true,
      ...workspace,
      explanation: workspace.available
        ? "Branch inventory. Review with --review <branch>; adopt with --adopt <branch> --apply after host review."
        : "No Git workspace detected. Branches cannot be listed until the project is a repository.",
    };
    console.log(options.json ? JSON.stringify(report, null, 2) : formatWorkspace(workspace));
    return report;
  }
  if (options.action === "handoff") {
    const plan = await createHandoffPackage(root, {
      from: options.from || "last-green",
      apply: options.apply,
      force: options.force,
      note: options.note,
      out: options.out,
    });
    plan.ok = plan.status !== "blocked";
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatHandoffPlan(plan));
    if (!plan.ok) process.exitCode = 1;
    return plan;
  }
  if (options.action === "compare") {
    const report = await compareRuns(root, {
      baseline: options.baseline || "last-green",
      against: options.against || "last-run",
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatCompareReport(report));
    if (!report.ok) process.exitCode = 1;
    return report;
  }
  if (options.action === "promote") {
    const plan = await promoteExpectsFromRun(root, {
      from: options.from || "last-green",
      out: options.out,
      apply: options.apply,
      force: options.force,
      strict: options.strict,
      name: options.name,
    });
    plan.ok = plan.ok === true || plan.status === "ready" || plan.status === "written";
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatPromotePlan(plan));
    if (!plan.ok) process.exitCode = 1;
    return plan;
  }
  if (options.action === "elements") {
    const plan = await planElementAdopt(root, {
      elements: options.elements,
      body: options.body,
      route: options.route,
      viewport: options.viewport,
      sourceBranch: options.sourceBranch,
      apply: options.apply,
      withHandoff: options.withHandoff,
      from: options.from || "last-green",
      force: options.force,
      note: options.note,
    });
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatElementAdoptPlan(plan));
    if (!plan.ok) process.exitCode = 1;
    return plan;
  }
  if (options.action === "attach") {
    const plan = await runAttach(root, {
      until: options.until,
      apply: options.apply,
      yes: options.yes,
      force: options.force,
      installBrowser: options.installBrowser,
      name: options.name,
      out: options.out,
      scenario: options.scenarioFile,
      from: options.from || "last-green",
      strict: options.strict,
      skipDoctor: options.skipDoctor,
      probeApp,
      runScenario,
      loadJson,
      validateConfig,
      loadScenario,
      validateScenario,
    });
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatAttachPlan(plan));
    if (!plan.ok) process.exitCode = 1;
    return plan;
  }
  if (options.action === "feedback") {
    let plan;
    if (options.bundle) {
      plan = await bundleFeedback(root, {
        threadIds: options.bundle,
        from: options.from || "last-green",
        note: options.note,
        apply: options.apply,
        force: options.force,
      });
    } else if (options.createFeedback) {
      plan = await createFeedback(root, {
        body: options.body,
        apply: options.apply,
        route: options.route,
        viewport: options.viewport,
        element: options.element,
        runId: options.runId,
      });
    } else if (options.id) {
      if (options.body || options.resolve || options.reopen) {
        plan = await updateFeedback(root, {
          threadId: options.id,
          body: options.body,
          status: options.resolve ? "done" : (options.reopen ? "open" : null),
          apply: options.apply,
        });
      } else {
        plan = await getFeedback(root, options.id);
      }
    } else {
      plan = await listFeedback(root);
    }
    plan.ok = plan.ok !== false && plan.status !== "blocked";
    if (options.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else if (options.list || (!options.bundle && !options.createFeedback && !options.id)) {
      console.log(formatFeedbackList(plan));
    } else if (plan.thread && !plan.action) {
      console.log(formatFeedbackPlan({ action: "get", status: plan.status, thread: plan.thread, warnings: [], next: [] }));
      console.log(JSON.stringify(plan.thread, null, 2));
    } else {
      console.log(formatFeedbackPlan(plan));
    }
    if (!plan.ok) process.exitCode = 1;
    return plan;
  }
  if (options.action === "serve") {
    const api = createCockpitApi({
      root,
      port: options.port || COCKPIT_DEFAULT_PORT,
      host: "127.0.0.1",
      attachRunner: (attachOptions) => runAttach(root, {
        ...attachOptions,
        probeApp,
        runScenario,
        loadJson,
        validateConfig,
        loadScenario,
        validateScenario,
      }),
    });
    const listening = await api.listen();
    const info = {
      ok: true,
      ...listening,
      readOnly: false,
      loopbackOnly: true,
      endpoints: {
        ui: listening.url,
        overview: `${listening.url}api/v1/overview`,
        hostConfig: `${listening.url}api/v1/host-config`,
        workspace: `${listening.url}api/v1/workspace`,
        attach: `${listening.url}api/v1/attach`,
        runs: `${listening.url}api/v1/runs`,
        handoffs: `${listening.url}api/v1/handoffs`,
        artifacts: `${listening.url}api/v1/artifacts/`,
      },
      explanation: "Cockpit UI + loopback API. Open / for the shell; GET/POST /api/v1/attach for the one-command loop. Stop with Ctrl+C.",
    };
    if (options.json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log(`Cockpit UI listening at ${listening.url}`);
      console.log(`API overview: ${info.endpoints.overview}`);
      console.log(`Attach: ${info.endpoints.attach}`);
      console.log("Loopback only · local writes enabled · Ctrl+C to stop");
    }
    const shutdown = async () => {
      try {
        await api.close();
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return info;
  }
  const configPath = path.join(root, "harness.config.json");
  const scenarioPath = path.resolve(root, options.scenario);
  const relativeScenario = path.relative(root, scenarioPath);
  assert(relativeScenario && !relativeScenario.startsWith(`..${path.sep}`) && relativeScenario !== "..",
    "scenario must be inside the project root.");
  const config = validateConfig(await loadJson(configPath, "harness config"));
  const scenario = await loadScenario(scenarioPath);

  if (options.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      scenario: scenario.name,
      app: {
        start: config.app.start,
        url: config.app.url,
        startupTimeoutMs: config.app.startupTimeoutMs,
        navigationTimeoutMs: config.app.navigationTimeoutMs,
        commandTimeoutMs: config.app.commandTimeoutMs,
      },
      inheritedEnvironmentNames: [...new Set([...SAFE_INHERITED_ENV, ...config.app.inheritEnv])],
      viewports: scenario.viewports,
      steps: scenario.steps.map((step) => {
        const action = step.command || `clock.${Object.keys(step.clock)[0]}`;
        return {
          name: step.name || action,
          ...(step.command ? { command: step.command } : { clock: step.clock }),
          ...(step.payload === undefined ? {} : { payload: step.payload }),
          ...(step.expect === undefined ? {} : { expect: step.expect }),
          ...(step.expectClock === undefined ? {} : { expectClock: step.expectClock }),
          ...(step.snapshot === undefined ? {} : { snapshot: step.snapshot }),
        };
      }),
    }, null, 2));
    return null;
  }

  return runScenario({ root, scenarioPath, scenario, config });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export {
  buildRunIndex,
  buildScaffoldScenario,
  compareRuns,
  createCockpitApi,
  createHandoffPackage,
  createShareInvite,
  ensureChromium,
  explainNextSteps,
  formatBrowserPlan,
  formatCompareReport,
  formatDoctorReport,
  formatFetchPlan,
  formatHandoffPlan,
  formatHostConfigPlan,
  formatSharePlan,
  formatHostConfigSummary,
  formatProbeReport,
  formatPromotePlan,
  formatAttachPlan,
  formatFeedbackList,
  formatFeedbackPlan,
  formatRunIndex,
  formatScaffoldPlan,
  formatSetupPlan,
  initHostConfig,
  inspectProject,
  isJsonValue,
  loadHostConfig,
  listFeedback,
  matchesExpected,
  parseArgs,
  promoteExpectsFromRun,
  createFeedback,
  updateFeedback,
  bundleFeedback,
  agentPanelState,
  createAgentSession,
  listAgentActivity,
  listAgentProposals,
  acceptAgentProposal,
  rejectAgentProposal,
  getAgentProposal,
  submitAgentTurn,
  workspaceEditAdapterDeclaration,
  runAttach,
  planElementAdopt,
  formatElementAdoptPlan,
  planWorkspaceFetch,
  planWorkspacePush,
  formatPushPlan,
  planDesignApprove,
  formatDesignApprovePlan,
  listShares,
  probeApp,
  runScenario,
  setupProject,
  stopChild,
  validateConfig,
  validateScenario,
  withTimeout,
  writeRunIndex,
  writeScaffoldScenario,
};
