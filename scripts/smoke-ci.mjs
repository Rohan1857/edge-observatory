import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const { unstable_dev } = require("wrangler");
const wranglerPackage = require.resolve("wrangler/package.json");
const wrangler = resolve(dirname(wranglerPackage), JSON.parse(readFileSync(wranglerPackage, "utf8")).bin.wrangler);
const configPath = join(root, ".smoke.wrangler.jsonc");
const port = Number(process.env.SMOKE_PORT || 8797);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, "valid smoke port required");
assert.ok(!existsSync(configPath), "another smoke run already owns the config");
const state = mkdtempSync(join(tmpdir(), "edge-observatory-smoke-"));
const config = JSON.parse(readFileSync(join(root, "wrangler.free.example.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
config.vars = { ...config.vars, DEV_USER_EMAIL: "local@example.com", BOOTSTRAP_ADMINS: "local@example.com" };
mkdirSync(join(root, ".wrangler"), { recursive: true });
const base = `http://127.0.0.1:${port}`;
let worker;
let ownsConfig = false;

function run(args, env = process.env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", fail);
    child.once("close", (status) => status === 0 ? done() : fail(new Error(`command failed (${status}): ${args[0]}`)));
  });
}

try {
  writeFileSync(configPath, JSON.stringify(config, null, 2), { flag: "wx" });
  ownsConfig = true;
  const local = ["--local", "--config", configPath, "--persist-to", state];
  await run([wrangler, "d1", "migrations", "apply", "edge-observatory", ...local]);
  await run([wrangler, "d1", "execute", "edge-observatory", ...local, "--file", "scripts/local-seed.sql"]);
  worker = await unstable_dev(join(root, config.main), { config: configPath, local: true, ip: "127.0.0.1", port,
    persist: true, persistTo: state, logLevel: "error", experimental: { disableExperimentalWarning: true,
      disableDevRegistry: true, forceLocal: true, watch: false } });
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/me`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Worker is still starting. */ }
    await delay(500);
  }
  assert.ok(ready, "Worker readiness timed out; see .wrangler/smoke-http.log");
  await run(["scripts/smoke.mjs"], { ...process.env, SMOKE_URL: base });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await worker?.stop();
  if (ownsConfig) await rm(configPath, { force: true });
  assert.equal(dirname(resolve(state)), resolve(tmpdir()), "cleanup must stay in the temporary directory");
  assert.ok(basename(state).startsWith("edge-observatory-smoke-"), "cleanup must target this smoke run");
  await rm(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
