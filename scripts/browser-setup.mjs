import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { chromium } from "playwright";

const CONSENT_PROMPT = [
  "Chromium is required for local harness screenshots and probes.",
  "Ask the project host (or trusted user) for permission to install it once on this machine.",
  "If they agree, re-run with --yes. Example:",
  "  npm run harness -- setup --install-browser --yes",
].join("\n");

function chromiumStatus() {
  try {
    const browserPath = chromium.executablePath();
    const installed = existsSync(browserPath);
    return { installed, path: installed ? browserPath : null };
  } catch (error) {
    return { installed: false, path: null, error: error.message };
  }
}

function installChromium(root) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["playwright", "install", "chromium"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    timeout: 10 * 60 * 1000,
  });
  if (result.error) {
    return {
      ok: false,
      action: "install-failed",
      error: result.error.message,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      action: "install-failed",
      error: `playwright install chromium exited with code ${result.status}`,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }
  const status = chromiumStatus();
  if (!status.installed) {
    return {
      ok: false,
      action: "install-incomplete",
      error: "Install finished but the Chromium binary is still missing.",
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }
  return {
    ok: true,
    action: "installed",
    path: status.path,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

/**
 * Consent-aware Chromium ensure.
 * - already installed → noop
 * - missing + yes → install
 * - missing + !yes → consent-required (no install)
 */
function ensureChromium(root, { yes = false } = {}) {
  const before = chromiumStatus();
  if (before.installed) {
    return {
      ok: true,
      status: "ready",
      action: "noop",
      path: before.path,
      explanation: "Chromium is already installed for local harness runs.",
    };
  }

  if (!yes) {
    return {
      ok: false,
      status: "consent-required",
      action: "needs-consent",
      path: null,
      explanation: CONSENT_PROMPT,
      askUser: "May I install Chromium once for local YXNHarness screenshots and probes on this machine?",
      resumeWith: "npm run harness -- setup --install-browser --yes",
    };
  }

  const installed = installChromium(root);
  if (!installed.ok) {
    return {
      ok: false,
      status: "failed",
      ...installed,
      explanation: "Chromium install failed. See error details; the host can retry or install manually with npx playwright install chromium.",
    };
  }
  return {
    ok: true,
    status: "ready",
    action: "installed",
    path: installed.path,
    explanation: "Chromium was installed after explicit --yes consent. Local probes and scenario runs can use it now.",
    stdout: installed.stdout,
    stderr: installed.stderr,
  };
}

function formatBrowserPlan(plan) {
  const lines = [
    `Browser: ${plan.status}`,
    `Action: ${plan.action}`,
  ];
  if (plan.path) lines.push(`Path: ${plan.path}`);
  if (plan.askUser) lines.push(`Ask user: ${plan.askUser}`);
  if (plan.resumeWith) lines.push(`After consent: ${plan.resumeWith}`);
  if (plan.explanation) {
    for (const line of plan.explanation.split("\n")) lines.push(line);
  }
  if (plan.error) lines.push(`Error: ${plan.error}`);
  return lines.join("\n");
}

export {
  CONSENT_PROMPT,
  chromiumStatus,
  ensureChromium,
  formatBrowserPlan,
  installChromium,
};
