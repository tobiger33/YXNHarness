/**
 * Language-neutral platform + runner catalog.
 * Only runners with status "ready" may be advertised as attachable.
 */

const RUNNERS = [
  {
    version: 1,
    id: "web-browser",
    displayName: "Web browser (Playwright/Chromium)",
    status: "ready",
    platforms: ["web"],
    languages: ["JavaScript", "TypeScript", "HTML"],
    transport: "in-page",
    controlBinding: "window.__harness (opt-in)",
    docs: ["docs/control-convention.md", "docs/platforms.md", "docs/attach.md"],
    exampleAdapter: "examples/foreign-booking/harness-adapter.js",
    note: "Current shipped runner. Any language that can expose the web binding works today.",
  },
  {
    version: 1,
    id: "macos-swift",
    displayName: "macOS (Swift / AppKit / SwiftUI)",
    status: "planned",
    platforms: ["macos"],
    languages: ["Swift", "Objective-C"],
    transport: "json-rpc-local",
    controlBinding: "HarnessControlling protocol + local JSON bridge",
    docs: ["docs/platforms.md", "examples/swift-control-surface/README.md"],
    exampleAdapter: "examples/swift-control-surface/HarnessControlling.swift",
    note: "Semantic contract is defined; launcher/probe runner not shipped yet.",
  },
  {
    version: 1,
    id: "ios-swift",
    displayName: "iOS (Swift / UIKit / SwiftUI)",
    status: "planned",
    platforms: ["ios", "mobile"],
    languages: ["Swift", "Objective-C"],
    transport: "json-rpc-local",
    controlBinding: "HarnessControlling protocol + local JSON bridge",
    docs: ["docs/platforms.md", "examples/swift-control-surface/README.md"],
    exampleAdapter: "examples/swift-control-surface/HarnessControlling.swift",
    note: "Same Swift control shape as macOS; device/simulator runner planned.",
  },
  {
    version: 1,
    id: "android-kotlin",
    displayName: "Android (Kotlin / Compose)",
    status: "planned",
    platforms: ["android", "mobile"],
    languages: ["Kotlin", "Java"],
    transport: "json-rpc-local",
    controlBinding: "HarnessControlling interface + local JSON bridge",
    docs: ["docs/platforms.md"],
    note: "Planned. Semantic contract is language-neutral JSON.",
  },
  {
    version: 1,
    id: "flutter",
    displayName: "Flutter",
    status: "planned",
    platforms: ["mobile", "desktop", "web"],
    languages: ["Dart"],
    transport: "json-rpc-local",
    controlBinding: "HarnessControlling Dart API + local JSON bridge",
    docs: ["docs/platforms.md"],
    note: "Prefer Flutter web with web-browser runner when a web surface exists.",
  },
  {
    version: 1,
    id: "react-native",
    displayName: "React Native / Expo",
    status: "planned",
    platforms: ["mobile"],
    languages: ["JavaScript", "TypeScript"],
    transport: "json-rpc-local",
    controlBinding: "global harness object or Metro bridge",
    docs: ["docs/platforms.md"],
    note: "Prefer Expo web with web-browser runner when a web surface exists.",
  },
  {
    version: 1,
    id: "electron",
    displayName: "Electron / desktop Chromium shell",
    status: "planned",
    platforms: ["desktop"],
    languages: ["JavaScript", "TypeScript"],
    transport: "in-page",
    controlBinding: "window.__harness inside the Electron renderer",
    docs: ["docs/platforms.md", "docs/control-convention.md"],
    note: "Renderer can often reuse the web binding; app launch adapter is planned.",
  },
  {
    version: 1,
    id: "dotnet",
    displayName: ".NET UI (WPF / MAUI / WinUI)",
    status: "planned",
    platforms: ["desktop", "mobile"],
    languages: [".NET", "C#"],
    transport: "json-rpc-local",
    controlBinding: "IHarnessControlling + local JSON bridge",
    docs: ["docs/platforms.md"],
    note: "Planned. Semantic contract is language-neutral JSON.",
  },
];

const LANGUAGE_RULES = [
  { id: "JavaScript", test: (names) => names.some((n) => /\.(js|mjs|cjs|jsx)$/i.test(n) || n === "package.json") },
  { id: "TypeScript", test: (names) => names.some((n) => /\.(ts|tsx)$/i.test(n) || n === "tsconfig.json") },
  { id: "HTML", test: (names) => names.some((n) => /\.html?$/i.test(n)) },
  { id: "Python", test: (names) => names.some((n) => /\.py$/i.test(n) || n === "pyproject.toml" || n === "requirements.txt") },
  { id: "Swift", test: (names) => names.some((n) => /\.swift$/i.test(n) || /\.xcodeproj$/i.test(n) || /\.xcworkspace$/i.test(n) || n === "Package.swift") },
  { id: "Objective-C", test: (names) => names.some((n) => /\.(m|mm|h)$/i.test(n)) },
  { id: "Dart", test: (names) => names.some((n) => /\.dart$/i.test(n) || n === "pubspec.yaml") },
  { id: "Kotlin", test: (names) => names.some((n) => /\.kts?$/i.test(n)) },
  { id: "Java", test: (names) => names.some((n) => /\.java$/i.test(n) || n === "pom.xml") },
  { id: "Android/Gradle", test: (names) => names.some((n) => /build\.gradle(\.kts)?$/i.test(n) || n === "settings.gradle" || n === "settings.gradle.kts") },
  { id: ".NET", test: (names) => names.some((n) => /\.csproj$/i.test(n) || /\.fsproj$/i.test(n) || /\.sln$/i.test(n)) },
  { id: "C#", test: (names) => names.some((n) => /\.cs$/i.test(n)) },
  { id: "Rust", test: (names) => names.some((n) => /\.rs$/i.test(n) || n === "Cargo.toml") },
  { id: "Go", test: (names) => names.some((n) => /\.go$/i.test(n) || n === "go.mod") },
  { id: "Ruby", test: (names) => names.some((n) => /\.rb$/i.test(n) || n === "Gemfile") },
  { id: "PHP", test: (names) => names.some((n) => /\.php$/i.test(n) || n === "composer.json") },
  { id: "C/C++", test: (names) => names.some((n) => /\.(c|cc|cpp|cxx|hpp)$/i.test(n) || n === "CMakeLists.txt") },
];

function listRunners() {
  return RUNNERS.map((runner) => ({ ...runner }));
}

function getRunner(id) {
  return RUNNERS.find((runner) => runner.id === id) || null;
}

function detectLanguages(fileNames) {
  const names = Array.isArray(fileNames) ? fileNames : [];
  return LANGUAGE_RULES.filter(({ test }) => test(names)).map(({ id }) => id);
}

function detectPlatformHints({
  frameworks = [],
  languages = [],
  entrypoints = [],
  fileNames = [],
  hasNodeStart = false,
} = {}) {
  const names = fileNames.map((name) => String(name));
  const frameworkNames = frameworks.map((item) => item.name || item);
  const hasSwift = languages.includes("Swift") || names.some((n) => /\.(swift|xcodeproj|xcworkspace)$/i.test(n) || n === "Package.swift");
  const hasIos = names.some((n) => /Info\.plist$/i.test(n) || /AppDelegate\.swift$/i.test(n)) &&
    names.some((n) => /iOS|iphoneos|UIKit/i.test(n));
  const hasAndroid = languages.includes("Android/Gradle") ||
    (languages.includes("Kotlin") &&
      names.some((n) => /AndroidManifest\.xml$/i.test(n) || /build\.gradle(\.kts)?$/i.test(n)));
  const hasFlutter = languages.includes("Dart") && names.includes("pubspec.yaml");
  const hasElectron = names.some((n) => /electron/i.test(n)) || frameworkNames.some((n) => /electron/i.test(n));
  const hasRn = frameworkNames.includes("React Native") || frameworkNames.includes("Expo");
  const hasDotnetUi = languages.includes(".NET") || languages.includes("C#");
  const hasWeb = frameworkNames.some((n) => !["React Native", "Expo"].includes(n)) ||
    entrypoints.includes("index.html") ||
    entrypoints.some((e) => /\.(tsx?|jsx?)$/i.test(e)) ||
    (hasNodeStart && !hasRn);

  const platforms = [];
  if (hasWeb) platforms.push("web");
  if (hasRn || hasFlutter || (hasAndroid && !hasWeb)) platforms.push("mobile");
  if (hasIos) platforms.push("ios");
  if (hasSwift && !hasIos) platforms.push("macos");
  if (hasAndroid) platforms.push("android");
  if (hasElectron || hasDotnetUi) platforms.push("desktop");

  let primary = "unknown";
  if (platforms.includes("web") && !hasRn && !hasFlutter) primary = "web";
  else if (platforms.includes("ios")) primary = "ios";
  else if (platforms.includes("macos")) primary = "macos";
  else if (platforms.includes("android")) primary = "android";
  else if (platforms.includes("mobile")) primary = "mobile";
  else if (platforms.includes("desktop")) primary = "desktop";
  else if (languages.length) primary = "non-web-or-undetected";

  return {
    primary,
    platforms: [...new Set(platforms)],
    hints: {
      hasWeb,
      hasSwift,
      hasIos,
      hasAndroid,
      hasFlutter,
      hasElectron,
      hasRn,
      hasDotnetUi,
    },
  };
}

function recommendRunners(platformInfo) {
  const { primary, platforms, hints } = platformInfo;
  const ranked = [];

  const push = (id, reason) => {
    const runner = getRunner(id);
    if (!runner) return;
    if (ranked.some((item) => item.id === id)) return;
    ranked.push({
      id: runner.id,
      displayName: runner.displayName,
      status: runner.status,
      attachable: runner.status === "ready",
      controlBinding: runner.controlBinding,
      reason,
      docs: runner.docs || [],
      exampleAdapter: runner.exampleAdapter || null,
      note: runner.note || null,
    });
  };

  if (hints.hasWeb || primary === "web") {
    push("web-browser", "Detected web surface or Node start command.");
  }
  if (hints.hasElectron) {
    push("electron", "Electron-like desktop shell detected; renderer may reuse window.__harness.");
    push("web-browser", "If a loopback web UI exists, use the shipped browser runner today.");
  }
  if (hints.hasRn) {
    push("react-native", "React Native / Expo detected.");
    push("web-browser", "Prefer Expo/RN web when available — that path works with the shipped runner.");
  }
  if (hints.hasFlutter) {
    push("flutter", "Flutter/Dart project detected.");
    push("web-browser", "Prefer Flutter web when available — that path works with the shipped runner.");
  }
  if (hints.hasIos) push("ios-swift", "iOS/Swift markers detected.");
  if (hints.hasSwift && !hints.hasIos) push("macos-swift", "Swift/Xcode/macOS markers detected.");
  if (hints.hasAndroid) push("android-kotlin", "Android/Kotlin/Gradle markers detected.");
  if (hints.hasDotnetUi) push("dotnet", ".NET UI project markers detected.");

  if (!ranked.length) {
    // Language-agnostic fallback: advertise ready web runner only if web, else planned unknowns stay honest
    if (platforms.includes("web")) push("web-browser", "Web platform inferred.");
  }

  return ranked;
}

function summarizeAttach({ platformInfo, runners, controlSurfaceFound, hasStartCommand }) {
  const recommended = runners[0] || null;
  const ready = runners.filter((runner) => runner.attachable);
  const attachable = Boolean(
    recommended &&
    recommended.attachable &&
    hasStartCommand &&
    (platformInfo.primary === "web" || platformInfo.hints.hasWeb),
  );

  return {
    mode: "existing-project",
    runner: recommended?.id || null,
    runners,
    attachable,
    controlSurfaceRequired: !controlSurfaceFound,
    readyRunnerCount: ready.length,
    plannedOnly: recommended ? recommended.status === "planned" : false,
    forbidden: [
      "MutationObserver UI rewrites",
      "DOM/text scraping for product state",
      "monkeypatching browser APIs for production behavior",
      "string-replacing another project's templates",
      "claiming a planned runner is attachable",
    ],
    docs: [
      "docs/platforms.md",
      "docs/attach.md",
      "docs/attach-existing.md",
      "docs/control-convention.md",
      "docs/project-setup.md",
      ...(recommended?.docs || []),
    ].filter((value, index, all) => all.indexOf(value) === index),
    exampleAdapter: recommended?.exampleAdapter || "examples/foreign-booking/harness-adapter.js",
    note: recommended?.status === "planned"
      ? `Detected ${recommended.displayName}, but that runner is planned — implement the semantic control contract now; do not claim browser attach works for this surface.`
      : "The coding agent performs attach. YXNHarness supplies doctor/setup/probe/run for ready runners only — any language may implement the semantic control contract.",
  };
}

export {
  RUNNERS,
  LANGUAGE_RULES,
  listRunners,
  getRunner,
  detectLanguages,
  detectPlatformHints,
  recommendRunners,
  summarizeAttach,
};
