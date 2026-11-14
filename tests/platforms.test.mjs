import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import {
  detectLanguages,
  detectPlatformHints,
  getRunner,
  listRunners,
  recommendRunners,
  summarizeAttach,
} from "../scripts/platforms.mjs";

test("runner catalog validates and only web-browser is ready", async () => {
  const schema = JSON.parse(await readFile(path.resolve("schema/runner-adapter.schema.json"), "utf8"));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const runners = listRunners();
  assert.ok(runners.length >= 5);
  for (const runner of runners) {
    assert.equal(validate(runner), true, JSON.stringify(validate.errors));
  }
  assert.equal(getRunner("web-browser").status, "ready");
  assert.equal(getRunner("macos-swift").status, "planned");
  assert.equal(runners.filter((runner) => runner.status === "ready").length, 1);
});

test("language and platform detection covers Swift and web", () => {
  assert.deepEqual(
    detectLanguages(["Package.swift", "App.swift"]).sort(),
    ["Swift"],
  );
  assert.ok(detectLanguages(["package.json", "src/main.ts"]).includes("TypeScript"));

  const swift = detectPlatformHints({
    languages: ["Swift"],
    fileNames: ["Package.swift", "App.swift"],
    entrypoints: ["Package.swift"],
  });
  assert.equal(swift.primary, "macos");
  assert.ok(swift.platforms.includes("macos"));

  const web = detectPlatformHints({
    frameworks: [{ name: "Vite" }],
    languages: ["JavaScript", "TypeScript"],
    entrypoints: ["index.html"],
    hasNodeStart: true,
  });
  assert.equal(web.primary, "web");
});

test("recommendRunners keeps planned Swift honest", () => {
  const platformInfo = detectPlatformHints({
    languages: ["Swift"],
    fileNames: ["Package.swift"],
  });
  const runners = recommendRunners(platformInfo);
  assert.equal(runners[0].id, "macos-swift");
  assert.equal(runners[0].attachable, false);

  const attach = summarizeAttach({
    platformInfo,
    runners,
    controlSurfaceFound: true,
    hasStartCommand: false,
  });
  assert.equal(attach.attachable, false);
  assert.equal(attach.plannedOnly, true);
  assert.match(attach.note, /planned/i);
});
