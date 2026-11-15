import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const children = new Set();
function launch(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
function completed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Process exited with ${code}`)));
  });
}
function cleanup() { for (const child of children) child.kill("SIGTERM"); }
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanup(); process.exit(0); });

try {
  if (process.platform !== "darwin") throw new Error("This desktop preview currently supports macOS. Use npm run harness -- serve on other platforms.");
  const contents = path.join(root, ".harness", "desktop", "YXNHarness.app", "Contents");
  const build = path.join(contents, "MacOS");
  await mkdir(build, { recursive: true });
  await writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>YXNHarness</string>
<key>CFBundleIdentifier</key><string>local.yxn.harness.desktop</string>
<key>CFBundleName</key><string>YXNHarness</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);
  const executable = path.join(build, "YXNHarness");
  console.log("Preparing the local desktop window…");
  await completed(launch("swiftc", ["desktop/main.swift", "-o", executable]));
  const portFile = path.join(root, ".harness", "desktop", "port.json");
  let preferred = 0;
  try { const saved = JSON.parse(await readFile(portFile, "utf8")); if (Number.isInteger(saved.port) && saved.port > 1024 && saved.port < 65536) preferred = saved.port; } catch { /* first launch */ }
  async function reserve(port) {
    const socket = net.createServer();
    await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(port, "127.0.0.1", resolve); });
    return socket;
  }
  let reservation;
  try { reservation = await reserve(preferred); }
  catch (error) { if (error.code !== "EADDRINUSE") throw error; reservation = await reserve(0); }
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await writeFile(portFile, JSON.stringify({port}));
  const url = `http://127.0.0.1:${port}/`;
  const server = launch(process.execPath, ["scripts/harness.mjs", "serve", "--port", String(port)]);
  let serverError;
  server.once("error", error => { serverError = error; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error("The local cockpit could not start.");
    try { ready = (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  if (!ready) throw new Error("The local cockpit did not become ready.");
  console.log("Opening YXNHarness. Closing its window also stops this local server.");
  const window = launch(executable, [`${url}#/workspace`]);
  server.once("exit", () => window.kill("SIGTERM"));
  await completed(window);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
