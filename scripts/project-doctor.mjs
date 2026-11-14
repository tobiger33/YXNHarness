import { spawnSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  detectLanguages,
  detectPlatformHints,
  recommendRunners,
  summarizeAttach,
} from "./platforms.mjs";

const IGNORED_DIRECTORIES = new Set([
  ".git", ".harness", ".next", ".nuxt", ".svelte-kit", ".turbo",
  "__tests__", "artifacts", "build", "coverage", "dist", "node_modules",
  "scripts", "test", "tests", "vendor",
]);
const SOURCE_EXTENSIONS = new Set([
  ".astro", ".cjs", ".cs", ".css", ".dart", ".go", ".html", ".java", ".js",
  ".jsx", ".kt", ".kts", ".m", ".mjs", ".mm", ".py", ".rs", ".svelte",
  ".swift", ".ts", ".tsx", ".vue",
]);
const CONTROL_SURFACE_PATTERNS = [
  /window\s*\.\s*__harness\b/,
  /__HARNESS_ENABLED__/,
  /exposeHarness\s*\(/,
  /protocol\s+HarnessControlling\b/,
  /interface\s+HarnessControlling\b/,
  /struct\s+HarnessBridge\b/,
  /class\s+HarnessBridge\b/,
  /yxnHarnessEnabled\b/,
  /HarnessControlSurface\b/,
];
const FRAMEWORKS = [
  { packageName: "next", name: "Next.js", port: 3000 },
  { packageName: "vite", name: "Vite", port: 5173 },
  { packageName: "react-scripts", name: "Create React App", port: 3000 },
  { packageName: "@angular/cli", name: "Angular", port: 4200 },
  { packageName: "astro", name: "Astro", port: 4321 },
  { packageName: "@sveltejs/kit", name: "SvelteKit", port: 5173 },
  { packageName: "nuxt", name: "Nuxt", port: 3000 },
  { packageName: "@remix-run/dev", name: "Remix", port: 3000 },
  { packageName: "react-native", name: "React Native", port: 8081 },
  { packageName: "expo", name: "Expo", port: 8081 },
  { packageName: "vue", name: "Vue", port: 5173 },
  { packageName: "svelte", name: "Svelte", port: 5173 },
  { packageName: "react", name: "React", port: 5173 },
];
const PACKAGE_MANAGERS = [
  { lock: "pnpm-lock.yaml", name: "pnpm" },
  { lock: "yarn.lock", name: "yarn" },
  { lock: "bun.lockb", name: "bun" },
  { lock: "bun.lock", name: "bun" },
  { lock: "package-lock.json", name: "npm" },
];

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function detectPackageManager(root, packageJson) {
  const declared = typeof packageJson?.packageManager === "string"
    ? packageJson.packageManager.split("@")[0]
    : null;
  if (["npm", "pnpm", "yarn", "bun"].includes(declared)) {
    return { name: declared, source: "package.json#packageManager", conflicts: [] };
  }
  const found = PACKAGE_MANAGERS.filter(({ lock }) => root.lockfiles.has(lock)).map(({ name }) => name);
  const unique = [...new Set(found)];
  const preferred = unique[0] || (packageJson ? "npm" : null);
  return {
    name: preferred,
    source: unique.length ? "lockfile" : packageJson ? "Node.js default" : "not detected",
    conflicts: unique.length > 1 ? unique.slice(1) : [],
  };
}

async function findSourceEvidence(rootPath) {
  const matches = [];
  let scannedFiles = 0;
  let examinedFiles = 0;
  let scannedBytes = 0;
  let skippedFiles = 0;
  const maxFiles = 5000;
  const maxBytes = 12 * 1024 * 1024;
  const pending = [rootPath];

  while (pending.length && examinedFiles < maxFiles && scannedBytes < maxBytes) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) {
          pending.push(path.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (examinedFiles >= maxFiles || scannedBytes >= maxBytes) break;

      const filePath = path.join(directory, entry.name);
      examinedFiles += 1;
      let contents;
      try {
        const info = await stat(filePath);
        if (info.size > 1024 * 1024 || scannedBytes + info.size > maxBytes) {
          skippedFiles += 1;
          continue;
        }
        contents = await readFile(filePath);
      } catch {
        continue;
      }
      scannedFiles += 1;
      scannedBytes += contents.byteLength;

      const source = contents.toString("utf8");
      if (CONTROL_SURFACE_PATTERNS.some((pattern) => pattern.test(source))) {
        matches.push(path.relative(rootPath, filePath).replace(/[\u0000-\u001f\u007f]/g, "?"));
        if (matches.length >= 20) return { matches, scannedFiles, scannedBytes, truncated: true };
      }
    }
  }

  return {
    matches,
    scannedFiles,
    examinedFiles,
    scannedBytes,
    truncated: pending.length > 0 || examinedFiles >= maxFiles || scannedBytes >= maxBytes || skippedFiles > 0,
  };
}

function detectCommands(packageJson, packageManager) {
  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" &&
    !Array.isArray(packageJson.scripts) ? packageJson.scripts : {};
  const hasScript = (name) => typeof scripts[name] === "string" && scripts[name].trim().length > 0;
  const startScript = ["dev", "start", "serve", "start:dev"].find(hasScript) || null;
  const testScript = ["test", "test:unit", "check"].find(hasScript) || null;
  const buildScript = ["build", "compile"].find(hasScript) || null;
  if (!startScript || !packageManager) {
    return { startScript, testScript, buildScript, start: null };
  }
  const commands = {
    npm: ["npm", "run", startScript],
    pnpm: ["pnpm", "run", startScript],
    yarn: ["yarn", "run", startScript],
    bun: ["bun", "run", startScript],
  };
  return { startScript, testScript, buildScript, start: commands[packageManager] };
}

function detectEntrypoints(rootPath) {
  const candidates = [
    "index.html",
    "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
    "src/index.tsx", "src/index.ts", "src/index.jsx", "src/index.js",
    "src/App.tsx", "src/App.jsx", "app/page.tsx", "app/page.jsx",
    "pages/_app.tsx", "pages/_app.jsx", "public/index.html",
    "Package.swift", "App.swift", "ContentView.swift",
    "android/app/src/main/AndroidManifest.xml",
    "pubspec.yaml",
  ];
  return Promise.all(candidates.map(async (candidate) => {
    try {
      return (await stat(path.join(rootPath, candidate))).isFile() ? candidate : null;
    } catch {
      return null;
    }
  })).then((found) => found.filter(Boolean));
}

function frameworkCandidates(packageJson) {
  const dependencies = {
    ...(packageJson?.dependencies && typeof packageJson.dependencies === "object" ? packageJson.dependencies : {}),
    ...(packageJson?.devDependencies && typeof packageJson.devDependencies === "object" ? packageJson.devDependencies : {}),
    ...(packageJson?.peerDependencies && typeof packageJson.peerDependencies === "object" ? packageJson.peerDependencies : {}),
  };
  return FRAMEWORKS.filter(({ packageName }) => dependencies[packageName])
    .map(({ name, port }) => ({ name, port }));
}

function terminalSafe(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

function isValidHarnessConfig(config, start) {
  if (config?.version !== 1 || !start || typeof config.app?.url !== "string") return false;
  let appUrl;
  try {
    appUrl = new URL(config.app.url);
  } catch {
    return false;
  }
  const timeout = config.app.startupTimeoutMs ?? 15000;
  const navigationTimeout = config.app.navigationTimeoutMs ?? 30000;
  const commandTimeout = config.app.commandTimeoutMs ?? 10000;
  const inheritEnv = config.app.inheritEnv ?? [];
  return ["http:", "https:"].includes(appUrl.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname) &&
    Number.isInteger(timeout) && timeout >= 1000 && timeout <= 120000 &&
    Number.isInteger(navigationTimeout) && navigationTimeout >= 1000 && navigationTimeout <= 120000 &&
    Number.isInteger(commandTimeout) && commandTimeout >= 1000 && commandTimeout <= 120000 &&
    Array.isArray(inheritEnv) &&
    inheritEnv.every((name) => typeof name === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(name)) &&
    new Set(inheritEnv).size === inheritEnv.length;
}

export async function inspectProject(rootPath) {
  const root = path.resolve(rootPath);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot inspect project root "${root}": ${error.message}`);
  }
  const rootFiles = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const rootEntries = entries.map((entry) => entry.name);
  const packagePath = path.join(root, "package.json");
  const configPath = path.join(root, "harness.config.json");
  let packageJson = null;
  let packageJsonError = null;
  let existingConfig = null;
  let configError = null;
  if (rootFiles.has("package.json")) {
    try {
      packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    } catch (error) {
      packageJsonError = error.message;
    }
  }
  if (rootFiles.has("harness.config.json")) {
    try {
      existingConfig = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      configError = error.message;
    }
  }

  const lockfiles = new Set(PACKAGE_MANAGERS.filter(({ lock }) => rootFiles.has(lock)).map(({ lock }) => lock));
  const manager = detectPackageManager({ lockfiles }, packageJson);
  const frameworks = frameworkCandidates(packageJson);
  const command = detectCommands(packageJson, manager.name);
  const configuredStart = Array.isArray(existingConfig?.app?.start) &&
    existingConfig.app.start.length > 0 &&
    existingConfig.app.start.every((part) => typeof part === "string" && part.length > 0)
    ? existingConfig.app.start
    : null;
  const configValid = isValidHarnessConfig(existingConfig, configuredStart);
  const gitRoot = runGit(root, ["rev-parse", "--show-toplevel"]);
  const branch = gitRoot ? runGit(root, ["branch", "--show-current"]) : null;
  const gitStatus = gitRoot ? runGit(root, ["status", "--porcelain=v1"]) : null;
  const sourceEvidence = await findSourceEvidence(root);
  const entrypoints = await detectEntrypoints(root);
  const languageMarkers = detectLanguages(rootEntries);
  const configExists = rootFiles.has("harness.config.json");
  const platformInfo = detectPlatformHints({
    frameworks,
    languages: languageMarkers,
    entrypoints,
    fileNames: rootEntries,
    hasNodeStart: Boolean(command.start || configuredStart),
  });
  const runners = recommendRunners(platformInfo);
  const agentAttach = summarizeAttach({
    platformInfo,
    runners,
    controlSurfaceFound: sourceEvidence.matches.length > 0,
    hasStartCommand: Boolean(configuredStart || command.start),
  });

  const warnings = [];
  if (packageJsonError) warnings.push(`package.json could not be parsed: ${packageJsonError}`);
  if (manager.conflicts.length) {
    warnings.push(`Multiple package-manager lockfiles detected (${[manager.name, ...manager.conflicts].join(", ")}); using ${manager.name}.`);
  }
  if (!packageJson && !languageMarkers.length) warnings.push("No supported project manifest was detected.");
  if (configError) warnings.push(`harness.config.json could not be parsed: ${configError}`);
  if (rootFiles.has("harness.config.json") && !configValid && !configError) {
    warnings.push("harness.config.json is missing a valid version, loopback URL, or app.start argument array.");
  }
  if (!command.start && !configuredStart) {
    warnings.push(platformInfo.primary === "web"
      ? "No supported Node.js development script was detected; app startup needs a project-specific command."
      : "No start command was inferred for this platform; native/desktop launchers need an explicit harness config once their runner ships.");
  }
  const isMobile = frameworks.some(({ name }) => name === "React Native" || name === "Expo");
  if (isMobile) warnings.push("The browser runner does not yet support native/mobile app launchers; no automatic app config was suggested.");
  if (agentAttach.plannedOnly) {
    warnings.push(`Recommended runner "${agentAttach.runner}" is planned — implement the semantic control contract in the app language, but do not claim browser attach for this surface yet.`);
  }
  if (sourceEvidence.truncated) warnings.push("Control-surface source scan reached its safety limit; results may be incomplete.");
  if (sourceEvidence.matches.length === 0) {
    warnings.push("No explicit harness control surface was found in the scanned source (web: window.__harness; Swift: HarnessControlling / HarnessBridge).");
  }
  if (!gitRoot) warnings.push("This directory is not inside a Git repository.");

  const selectedFramework = frameworks.find(({ name }) => name !== "React Native" && name !== "Expo") || null;
  const setupConfig = command.start && !isMobile && platformInfo.hints.hasWeb ? {
    version: 1,
    app: {
      start: command.start,
      url: `http://127.0.0.1:${selectedFramework?.port || 4173}/`,
      startupTimeoutMs: 20000,
    },
  } : null;
  if (setupConfig && !selectedFramework) warnings.push("No web framework was identified; the suggested port 4173 is a placeholder and must be checked by the agent against the real start command.");
  if (setupConfig && selectedFramework) warnings.push(`The suggested URL uses ${selectedFramework.name}'s default port; verify it against the project's dev-server configuration.`);

  return {
    version: 1,
    root,
    project: {
      name: packageJson?.name || path.basename(root),
      packageManager: manager,
      frameworks,
      platform: platformInfo.primary,
      platforms: platformInfo.platforms,
      languageMarkers,
      entrypoints,
      commands: {
        start: configuredStart || command.start,
        configuredStart: Boolean(configuredStart),
        startScript: command.startScript,
        testScript: command.testScript,
        buildScript: command.buildScript,
      },
      git: {
        available: Boolean(gitRoot),
        root: gitRoot,
        branch,
        dirty: gitStatus === null ? null : gitStatus.length > 0,
        changedFiles: gitStatus === null ? null : gitStatus.split("\n").filter(Boolean).length,
      },
    },
    harness: {
      configExists,
      configValid,
      configuredUrl: typeof existingConfig?.app?.url === "string" ? existingConfig.app.url : null,
      controlSurface: {
        status: sourceEvidence.matches.length ? "reference-found" : "no-reference",
        files: sourceEvidence.matches,
        scannedFiles: sourceEvidence.scannedFiles,
        truncated: sourceEvidence.truncated,
      },
      suggestedConfig: rootFiles.has("harness.config.json") ? null : setupConfig,
    },
    agentAttach,
    warnings,
  };
}

export async function setupProject(rootPath, { apply = false } = {}) {
  const diagnosis = await inspectProject(rootPath);
  const configPath = path.join(diagnosis.root, "harness.config.json");
  const configExists = diagnosis.harness.configExists;
  const plan = {
    version: 1,
    mode: apply ? "apply" : "dry-run",
    root: diagnosis.root,
    status: configExists
      ? diagnosis.harness.configValid ? "already-configured" : "blocked"
      : diagnosis.harness.suggestedConfig ? "ready" : "blocked",
    writes: [],
    config: configExists ? null : diagnosis.harness.suggestedConfig,
    requiredAgentWork: diagnosis.harness.controlSurface.status === "reference-found"
      ? ["Review the detected source references and verify the full documented control contract (docs/platforms.md)."]
      : [
        "Add an opt-in harness control surface in the app's language using its own actions and state (web: window.__harness; Swift: HarnessControlling).",
        "Expose serializable state(), discoverable commands(), structured command results, events, and clock methods.",
        "Add a scenario that exercises the real user flow; do not infer app state from rendered UI trees.",
      ],
    warnings: [...diagnosis.warnings],
  };

  if (!configExists && plan.status === "ready") {
    plan.writes = ["harness.config.json"];
  }
  if (apply && plan.status === "ready") {
    try {
      await writeFile(configPath, `${JSON.stringify(plan.config, null, 2)}\n`, { flag: "wx" });
      plan.status = "configured";
      plan.writes = ["harness.config.json"];
    } catch (error) {
      if (error.code === "EEXIST") {
        plan.status = "already-configured";
        plan.writes = [];
        plan.config = null;
        plan.warnings.push("harness.config.json appeared before setup could write it; existing file was preserved.");
      } else {
        throw new Error(`could not write harness config "${configPath}": ${error.message}`);
      }
    }
  }

  if (plan.status === "blocked") {
    plan.warnings.push(configExists
      ? "The existing harness.config.json is invalid and was preserved; review or repair it manually."
      : "No start command could be inferred. Add a supported Node.js dev script or define a project-specific harness config.");
  }
  if (plan.status === "already-configured") {
    plan.warnings.push("Existing harness.config.json was preserved; setup never overwrites project configuration.");
  }
  if (!apply && plan.status === "ready") {
    plan.warnings.push("Preview only. Re-run with --apply to write harness.config.json.");
  }
  return plan;
}

export function formatDoctorReport(report) {
  const packageManager = report.project.packageManager.name;
  const lines = [
    `Project: ${report.project.name}`,
    `Root: ${report.root}`,
    `Platform: ${report.project.platform}${report.project.platforms?.length ? ` (${report.project.platforms.join(", ")})` : ""}`,
    `Languages: ${report.project.languageMarkers.join(", ") || "not detected"}`,
    `Runner: ${report.agentAttach?.runner || "none"}${report.agentAttach?.attachable ? " · attachable" : report.agentAttach?.plannedOnly ? " · planned" : ""}`,
    `Frameworks: ${report.project.frameworks.map(({ name }) => name).join(", ") || "not detected"}`,
    `Package manager: ${report.project.packageManager.name || "not detected"}`,
    `Git: ${report.project.git.available ? `${report.project.git.branch || "(detached)"}${report.project.git.dirty ? ` · ${report.project.git.changedFiles} changed files` : " · clean"}` : "not detected"}`,
    `App start: ${report.project.commands.start ? report.project.commands.start.join(" ") : "not detected"}`,
    `Test script: ${report.project.commands.testScript ? `${packageManager} run ${report.project.commands.testScript}` : "not detected"}`,
    `Build script: ${report.project.commands.buildScript ? `${packageManager} run ${report.project.commands.buildScript}` : "not detected"}`,
    `Harness config: ${report.harness.configExists ? (report.harness.configValid ? "present and valid" : "present; needs review") : "missing"}`,
    `Control surface references: ${report.harness.controlSurface.status}${report.harness.controlSurface.files.length ? ` (${report.harness.controlSurface.files.join(", ")})` : ""}`,
  ];
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return lines.map(terminalSafe).join("\n");
}

export function formatSetupPlan(plan) {
  const lines = [
    `Setup: ${plan.status}`,
    `Root: ${plan.root}`,
    `Mode: ${plan.mode}`,
    `Files to write: ${plan.writes.length ? plan.writes.join(", ") : "none"}`,
  ];
  if (plan.config) {
    lines.push(`App start: ${plan.config.app.start.join(" ")}`);
    lines.push(`Local URL: ${plan.config.app.url}`);
  }
  for (const item of plan.requiredAgentWork) lines.push(`Agent integration required: ${item}`);
  for (const warning of plan.warnings) lines.push(`Note: ${warning}`);
  return lines.map(terminalSafe).join("\n");
}
