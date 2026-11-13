import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

const DEFAULT_VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

function safeSlug(value) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.slice(0, 48) || "step";
}

function exampleFromSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 4) return null;
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.includes("null") && types.length === 1) return null;
  if (types.includes("string")) return "example";
  if (types.includes("number") || types.includes("integer")) return 0;
  if (types.includes("boolean")) return false;
  if (types.includes("array")) {
    const item = exampleFromSchema(schema.items || {}, depth + 1);
    return item === undefined ? [] : [item];
  }
  if (types.includes("object") || schema.properties) {
    const required = Array.isArray(schema.required) ? schema.required : Object.keys(schema.properties || {});
    const object = {};
    for (const key of required.slice(0, 12)) {
      object[key] = exampleFromSchema(schema.properties?.[key] || { type: "string" }, depth + 1);
    }
    return object;
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    return exampleFromSchema(schema.anyOf[0], depth + 1);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    return exampleFromSchema(schema.oneOf[0], depth + 1);
  }
  return null;
}

function payloadForCommand(command) {
  if (!command || command.payloadSchema === undefined) {
    return { mode: "none", payload: undefined, note: "No payloadSchema advertised; omit payload in the scenario." };
  }
  if (command.payloadSchema === null || command.payloadSchema?.type === "null") {
    return { mode: "null", payload: null, note: null };
  }
  return {
    mode: "example",
    payload: exampleFromSchema(command.payloadSchema),
    note: "Example payload from payloadSchema — replace with a real value before trusting the run.",
  };
}

function buildScaffoldScenario({
  commands,
  initialState = null,
  name = "smoke",
  projectName = null,
} = {}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error("scaffold needs at least one command from probe (commands() was empty).");
  }
  const limited = commands.slice(0, 20);
  const steps = limited.map((command, index) => {
    if (!command || typeof command.name !== "string" || !command.name.trim()) {
      throw new Error(`commands()[${index}] needs a name.`);
    }
    const payloadInfo = payloadForCommand(command);
    const step = {
      name: command.description?.trim() || command.name,
      command: command.name,
      snapshot: `${String(index + 1).padStart(2, "0")}-${safeSlug(command.name)}`,
    };
    if (payloadInfo.mode === "null" || payloadInfo.mode === "example") {
      step.payload = payloadInfo.payload;
    }
    return step;
  });

  const descriptionParts = [
    `Draft scenario generated from a live probe${projectName ? ` of ${projectName}` : ""}.`,
    "Review example payloads, add expect blocks for states you care about, then dry-run and run.",
    "Do not treat this draft as proof until a run passes with reviewed expectations.",
  ];
  if (initialState && typeof initialState === "object") {
    descriptionParts.push(`Initial state at probe time: ${JSON.stringify(initialState)}`);
  }

  return {
    version: 1,
    name,
    description: descriptionParts.join(" "),
    viewports: DEFAULT_VIEWPORTS.map((viewport) => ({ ...viewport })),
    steps,
  };
}

function scenarioToYaml(scenario) {
  return `${yaml.dump(scenario, {
    lineWidth: 100,
    noRefs: true,
    sortingKeys: false,
  }).trim()}\n`;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeScaffoldScenario(root, scenario, {
  out = path.join("scenarios", `${safeSlug(scenario.name)}.yaml`),
  apply = false,
  force = false,
} = {}) {
  const relativeOut = out;
  const absoluteOut = path.resolve(root, relativeOut);
  const relative = path.relative(root, absoluteOut);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === "..") {
    throw new Error("scaffold output path must stay inside the project root.");
  }

  const yamlText = scenarioToYaml(scenario);
  const exists = await pathExists(absoluteOut);
  const plan = {
    version: 1,
    mode: apply ? "apply" : "dry-run",
    status: apply ? (exists && !force ? "blocked" : "ready") : "ready",
    out: relative.replaceAll("\\", "/"),
    exists,
    force,
    writes: apply && !(exists && !force) ? [relative.replaceAll("\\", "/")] : [],
    yaml: yamlText,
    warnings: [],
    next: [
      `Review payloads in ${relative.replaceAll("\\", "/")}.`,
      "Add expect blocks for the states that matter.",
      `npm run harness -- run ${relative.replaceAll("\\", "/")} --dry-run`,
      `npm run harness -- run ${relative.replaceAll("\\", "/")}`,
    ],
  };

  if (exists && !force) {
    plan.warnings.push(`Refusing to overwrite existing ${plan.out}. Re-run with --force after host consent, or choose --out.`);
    if (apply) plan.status = "blocked";
  }
  if (!apply) {
    plan.warnings.push("Preview only. Re-run with --apply to write the scenario file.");
  }
  if (apply && plan.status === "ready") {
    await mkdir(path.dirname(absoluteOut), { recursive: true });
    await writeFile(absoluteOut, yamlText, { flag: force ? "w" : "wx" });
    plan.status = "written";
  }
  return plan;
}

function formatScaffoldPlan(plan) {
  const lines = [
    `Scaffold: ${plan.status}`,
    `Mode: ${plan.mode}`,
    `Output: ${plan.out}`,
    `Files to write: ${plan.writes.length ? plan.writes.join(", ") : "none"}`,
  ];
  for (const warning of plan.warnings) lines.push(`Note: ${warning}`);
  if (plan.mode === "dry-run" || plan.status === "written") {
    lines.push("YAML preview:");
    lines.push(plan.yaml.trimEnd());
  }
  for (const step of plan.next || []) lines.push(`Next: ${step}`);
  return lines.join("\n");
}

export {
  DEFAULT_VIEWPORTS,
  buildScaffoldScenario,
  exampleFromSchema,
  formatScaffoldPlan,
  payloadForCommand,
  scenarioToYaml,
  writeScaffoldScenario,
};
