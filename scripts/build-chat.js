#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureDependencies } = require("./lib/build-chat-deps");

function installDependencies(root, env = process.env, run = spawnSync) {
  // npm run supplies its CLI path. Direct Windows invocation uses the CLI
  // beside Node; never route .cmd through a shell (spaces and metacharacters).
  const cli = env.npm_execpath || (process.platform === "win32"
    ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : null);
  if (cli && !fs.existsSync(cli)) throw new Error("npm CLI missing; run this build via npm run build:chat");
  const result = run(cli ? process.execPath : "npm", [...(cli ? [cli] : []), "install", "--prefer-offline"], {
    cwd: root, stdio: "inherit", shell: false, windowsHide: true, env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Chat UI npm install failed (${result.status ?? result.signal})`);
}
function buildChat(root = path.join(__dirname, "..", "chat-ui", "ui"), env = process.env, run = spawnSync) {
  const started = performance.now();
  const { reused } = ensureDependencies(root, () => installDependencies(root, env, run), env);
  console.log(`[build:chat] dependencies ${reused ? "reused" : "installed"} (${Math.round(performance.now() - started)}ms)`);
  // Never cache Vite output: source edits always rebuild, using the local tool.
  const result = run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"], {
    cwd: root, stdio: "inherit", shell: false, windowsHide: true, env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
if (require.main === module) {
  try { process.exitCode = buildChat(); }
  catch (error) { console.error(`[build:chat] ${error.message}`); process.exitCode = 1; }
}
module.exports = { installDependencies, buildChat };
